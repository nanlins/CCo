/**
 * 完整命令权限分类器 —— 禁止"只看第一个 token"判定整条命令安全。
 *
 * 设计：
 *   1. 引号感知分段：`;` `&&` `||` `|` `&` 换行 都是命令边界（cmd.exe 与 PowerShell 通用），
 *      引号内的分隔符不作为边界；
 *   2. 每一段独立分类：任何一段非只读 → 整条命令需要审批；任何一段危险 → 拒绝；
 *   3. 重定向目标静态解析：`>` `>>` 目标不在工作区内 → 直接 deny；
 *      含 `$VAR` / `%VAR%` / `~` 的目标无法静态验证 → 需要审批；
 *   4. 敏感文件（.env / 私钥 / 凭据）：读命令读取 → deny；其它引用 → 需要审批；
 *   5. 命令替换（$(...)、反引号）与子 shell 无法静态验证 → 需要审批。
 *
 * bash 与 bg_run 共用本分类器（permission.ts 的 SHELL_TOOLS 管线）。
 */
import path from 'node:path';
import { isInside } from './permission.js';

export type ShellVerdict = 'safe' | 'ask' | 'deny';

export interface ShellClassification {
  verdict: ShellVerdict;
  reason: string;
}

/* ---------- 只读命令白名单（按"命令名 + 子命令约束"判定） ---------- */

/** git 只读子命令。 */
const GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'help',
  '--version',
  'version',
  'shortlog',
  'describe',
  'blame',
]);

/** POSIX/通用只读命令（无副作用）。 */
const POSIX_READ_COMMANDS = new Set([
  'ls',
  'dir',
  'pwd',
  'whoami',
  'echo',
  'cat',
  'type',
  'more',
  'head',
  'tail',
  'grep',
  'rg',
  'findstr',
  'hostname',
  'date',
  'uname',
  'ver',
  'cd',
  'which',
  'where',
  'tree',
  'stat',
  'file',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
]);

/** find 的危险选项（可删除/执行）。 */
const FIND_DANGEROUS_RX = /(^|\s)(-delete|-exec|-execdir|-ok|-okdir)\b/;

/** PowerShell 只读 cmdlet。 */
const PS_READ_CMDLETS = new Set([
  'Get-ChildItem',
  'Get-Content',
  'Get-Item',
  'Get-Location',
  'Get-Command',
  'Get-Date',
  'Get-Process',
  'Get-Service',
  'Get-Volume',
  'Get-Clipboard',
  'Select-String',
  'Test-Path',
  'Measure-Object',
  'Compare-Object',
  'Format-List',
  'Format-Table',
  'Format-Wide',
  'Out-String',
  'Set-Location',
  'Write-Output',
]);

/** 版本/帮助形式的参数：node -v、npm --version 等可视为只读。 */
const VERSION_ARG_RX = /^(-v|--version|version|--help|-h)$/;

/** 敏感文件：读取即泄密风险（.env / 私钥 / 凭据）。排除 .env.example 等模板。 */
const SENSITIVE_FILE_RX =
  /(^|[/\\])(\.env(\.(?!example$|sample$|template$).+)?|\.npmrc|\.netrc|\.htpasswd|id_rsa|id_ed25519|id_ecdsa|credentials(\.json)?|secrets?(\.[a-z]+)?|authorized_keys|known_hosts|token(\.json)?|\.aws[/\\]credentials|\.kube[/\\]config|.+\.pem|.+\.key|.+\.p12|.+\.pfx)$/i;

/** 命令替换 / 子 shell：无法静态验证。 */
const COMMAND_SUBSTITUTION_RX = /\$\(|`/;
const SUBSHELL_RX = /(^|[;&|]\s*|\s)\(/;

/**
 * 引号感知分段：按 ; && || | & 换行 切分，引号内的分隔符忽略。
 * 兼容 cmd.exe（& && || |）与 PowerShell（; | &&）。
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && command[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&') {
      /* `>&1` / `2>&1` 中的 & 属于重定向语法，不是命令分隔符 */
      const prev = current[current.length - 1];
      if (prev === '>') {
        current += ch;
        continue;
      }
      segments.push(current);
      current = '';
      if (command[i + 1] === '&') i++; // &&
      continue;
    }
    if (ch === '|') {
      segments.push(current);
      current = '';
      if (command[i + 1] === '|') i++; // ||
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** 去掉引号内容（保留引号占位），便于在"引号外"找重定向操作符。 */
function maskQuoted(text: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      out += ' ';
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ' ';
      if (ch === '"' && text[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 空设备目标：写入它们无副作用，不按危险写入处理。 */
const NULL_TARGETS = new Set(['/dev/null', 'nul', 'nul:', '/dev/zero', '$null']);

/**
 * 提取写重定向目标（> 与 >>；不含 <）。返回引号外的原始 token。
 * 豁免：stderr 重定向（2>、2>>）与空设备目标（/dev/null、NUL）——无写入副作用，
 * 不按危险写入处理（修复真实审查任务中 `rg … 2>/dev/null` 被反复询问的问题）。
 */
export function extractRedirectTargets(segment: string): string[] {
  const masked = maskQuoted(segment);
  const targets: string[] = [];
  const rx = /(?:(\d+)\s*)?(>>|>)\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(masked)) !== null) {
    const fd = m[1];
    const target = m[3];
    /* fd ≥ 2（stderr 等）不是数据写入 */
    if (fd !== undefined && Number(fd) >= 2) continue;
    /* fd 复制（>&1、2>&1 的目标 &N）不是文件写入 */
    if (/^&\d+$/.test(target)) continue;
    if (NULL_TARGETS.has(target.toLowerCase())) continue;
    targets.push(target);
  }
  return targets;
}

/** 提取输入重定向目标（<）。 */
export function extractInputRedirectTargets(segment: string): string[] {
  const masked = maskQuoted(segment);
  const targets: string[] = [];
  const rx = /(?:\d*\s*)?(<)\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(masked)) !== null) {
    targets.push(m[2]);
  }
  return targets;
}

/** 提取段内所有"词"（去引号），用于敏感文件扫描。 */
function segmentWords(segment: string): string[] {
  const unquoted = segment.replace(/"([^"]*)"|'([^']*)'/g, (_all, dq: string, sq: string) => dq ?? sq ?? '');
  return unquoted.split(/\s+/).filter(Boolean);
}

/** 提取段首命令名（跳过 VAR=value 前缀与路径包装）。 */
export function headCommandName(segment: string): string {
  const words = segmentWords(segment);
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // ENV=x 前缀
    /* 去掉路径，保留可执行名：/usr/bin/git → git；C:\x\node.exe → node.exe */
    const base = w.replace(/^.*[/\\]/, '').toLowerCase();
    return base.replace(/\.exe$/, '');
  }
  return '';
}

/** 提取完整命令中每一段的段首命令名（供批量授权按"同类命令"匹配）。 */
export function segmentBinaries(command: string): string[] {
  return splitShellSegments(command)
    .map((seg) => headCommandName(seg))
    .filter(Boolean);
}

/** 目标是否可静态验证在工作区内。含变量/波浪号的目标不可静态验证。 */
function classifyRedirectTarget(target: string, workdir: string): ShellVerdict {
  const cleaned = target.replace(/^["']|["']$/g, '');
  if (cleaned.includes('$') || cleaned.includes('%') || cleaned.startsWith('~')) {
    return 'ask'; // 运行时展开，无法静态验证
  }
  /* 特殊设备（POSIX） */
  if (cleaned === '/dev/null') return 'safe';
  const resolved = path.resolve(workdir, cleaned);
  return isInside(workdir, resolved) ? 'safe' : 'deny';
}

/** 判断单个段是否"只读安全"。 */
function isReadOnlySegment(segment: string): boolean {
  const words = segmentWords(segment);
  if (words.length === 0) return true;
  const head = headCommandName(segment);

  /* 版本/帮助探测 */
  if (words.length === 2 && VERSION_ARG_RX.test(words[1]) && /^[a-z0-9._-]+$/i.test(head)) {
    return true;
  }

  if (head === 'git') {
    const sub = words[1]?.toLowerCase() ?? '';
    if (!GIT_READ_SUBCOMMANDS.has(sub)) return false;
    /* git 只读子命令不得带写语义选项 */
    if (words.some((w) => w === '--global' || w === '--system')) return false;
    return true;
  }

  if (head === 'find') {
    return !FIND_DANGEROUS_RX.test(segment);
  }

  if (POSIX_READ_COMMANDS.has(head)) {
    /* echo 本身只读（重定向已单独分析）；sort/uniq/cut/tr/diff/wc 只读 */
    return true;
  }

  /* PowerShell 只读 cmdlet（原始大小写匹配，Verb-Noun） */
  const rawHead = words.find((w) => /^[A-Z][a-zA-Z]+-[A-Za-z]+$/.test(w));
  if (rawHead && PS_READ_CMDLETS.has(rawHead)) {
    return true;
  }

  return false;
}

/**
 * 对完整命令做权限分类。
 * @param command 完整命令行（可能含管道/链接/重定向）
 * @param workdir 当前工作区（重定向目标与敏感路径的判定基准）
 */
export function classifyShellCommand(command: string, workdir: string): ShellClassification {
  const trimmed = command.trim();
  if (!trimmed) return { verdict: 'ask', reason: 'empty command' };

  /* 命令替换 / 子 shell：无法静态验证 → 审批 */
  if (COMMAND_SUBSTITUTION_RX.test(trimmed)) {
    return { verdict: 'ask', reason: '命令替换 $(...)/反引号 无法静态验证' };
  }

  const segments = splitShellSegments(trimmed);
  if (segments.length === 0) return { verdict: 'ask', reason: 'empty command' };

  let needsAsk = false;
  let askReason = '';

  for (const segment of segments) {
    if (SUBSHELL_RX.test(segment)) {
      needsAsk = true;
      askReason = askReason || '子 shell 无法静态验证';
    }

    /* 写重定向目标检查（最严格的 deny 路径） */
    for (const target of extractRedirectTargets(segment)) {
      const v = classifyRedirectTarget(target, workdir);
      if (v === 'deny') {
        return { verdict: 'deny', reason: `重定向目标越出工作区: ${target}` };
      }
      /* 段内有写重定向 → 该段不再是只读 */
      needsAsk = true;
      askReason =
        askReason ||
        (v === 'ask' ? `重定向目标含变量/波浪号，无法静态验证: ${target}` : '命令包含写重定向（文件写入）');
    }

    /* 输入重定向引用敏感文件 → 内容会进入命令 stdin（可能回显/外传） */
    for (const target of extractInputRedirectTargets(segment)) {
      const cleaned = target.replace(/^["']|["']$/g, '');
      if (SENSITIVE_FILE_RX.test(cleaned)) {
        return { verdict: 'deny', reason: `输入重定向引用敏感文件: ${cleaned}` };
      }
    }

    /* 敏感文件引用检查 */
    const words = segmentWords(segment);
    const sensitiveHit = words.find((w) => SENSITIVE_FILE_RX.test(w.replace(/^["']|["']$/g, '')));
    if (sensitiveHit) {
      const head = headCommandName(segment);
      const readHeads = new Set([
        'cat',
        'type',
        'more',
        'head',
        'tail',
        'less',
        'grep',
        'findstr',
        'rg',
        'sort',
        'wc',
        'diff',
      ]);
      const cleaned = sensitiveHit.replace(/^["']|["']$/g, '');
      if (readHeads.has(head)) {
        return { verdict: 'deny', reason: `禁止读取敏感文件: ${cleaned}` };
      }
      const rawHead = words.find((w) => /^[A-Z][a-zA-Z]+-[A-Za-z]+$/.test(w));
      if (rawHead && (rawHead === 'Get-Content' || rawHead === 'Select-String')) {
        return { verdict: 'deny', reason: `禁止读取敏感文件: ${cleaned}` };
      }
      needsAsk = true;
      askReason = askReason || `命令引用敏感文件: ${cleaned}`;
    }

    /* 只读白名单判定 */
    if (!isReadOnlySegment(segment)) {
      needsAsk = true;
      askReason = askReason || `非只读命令段: ${segment.slice(0, 80)}`;
    }
  }

  if (needsAsk) return { verdict: 'ask', reason: askReason || '非只读命令' };
  return { verdict: 'safe', reason: '全部分段为只读白名单命令' };
}
