/**
 * Bash 命令安全分析器 —— AST 级解析（比字符串匹配更可靠）。
 *
 * 功能：
 *   1. 解析命令结构（管道/重定向/子shell/变量展开）
 *   2. 识别危险模式（rm -rf / format / dd 等）
 *   3. 检测命令注入（; && || | 等分隔符后的隐藏命令）
 *   4. 提取命令意图（读/写/删除/网络/进程）
 *
 * 教学简化：不实现完整 shell 语法树，用正则+启发式分析关键结构。
 */

export type CommandIntent = 'read' | 'write' | 'delete' | 'network' | 'process' | 'unknown';
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface CommandAnalysis {
  /** 原始命令。 */
  command: string;
  /** 命令意图。 */
  intent: CommandIntent;
  /** 风险等级。 */
  risk: RiskLevel;
  /** 风险原因。 */
  reasons: string[];
  /** 提取的二进制/命令名。 */
  binaries: string[];
  /** 是否包含管道。 */
  hasPipe: boolean;
  /** 是否包含重定向。 */
  hasRedirect: boolean;
  /** 是否包含子shell。 */
  hasSubshell: boolean;
  /** 是否包含命令链接（; && ||）。 */
  hasChaining: boolean;
}

/* 危险命令模式 */
const CRITICAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/+\s*$/, reason: '删除根目录' },
  { pattern: /\brm\s+-rf\s+\/\s*$/, reason: '强制删除根目录' },
  { pattern: /\bmkfs\b/, reason: '格式化文件系统' },
  { pattern: /\bdd\s+if=.*of=\/dev\/[sh]d/, reason: '直接写入磁盘设备' },
  { pattern: /\bformat\s+[a-z]:/i, reason: '格式化磁盘' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, reason: '关机/重启' },
  { pattern: /\b>\s*\/dev\/[sh]d/, reason: '覆盖磁盘设备' },
];

const HIGH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
  { pattern: /\brm\s+-[a-zA-Z]*f/, reason: '强制删除' },
  { pattern: /\bgit\s+push\s+(-f|--force)/, reason: '强制推送' },
  { pattern: /\bgit\s+reset\s+--hard/, reason: '硬重置（丢失未提交更改）' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: '强制清理未跟踪文件' },
  { pattern: /\bchmod\s+777/, reason: '开放所有权限' },
  { pattern: /\bchown\s+root/, reason: '更改为root所有者' },
  { pattern: /\bsudo\b/, reason: '提权执行' },
  { pattern: /\bkill\s+-9/, reason: '强制杀进程' },
  { pattern: /\btaskkill\s+\/f/i, reason: '强制杀进程(Windows)' },
];

const MEDIUM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s/, reason: '删除文件' },
  { pattern: /\bmv\s/, reason: '移动/重命名文件' },
  { pattern: /\bgit\s+push\b/, reason: '推送代码' },
  { pattern: /\bgit\s+commit\b/, reason: '提交代码' },
  { pattern: /\bnpm\s+publish\b/, reason: '发布npm包' },
  { pattern: /\bpip\s+install\b/, reason: '安装Python包' },
  { pattern: /\bnpm\s+install\b/, reason: '安装npm包' },
  { pattern: /\bcurl\s.*\|\s*(ba)?sh/, reason: '下载并执行脚本' },
  { pattern: /\bwget\s.*\|\s*(ba)?sh/, reason: '下载并执行脚本' },
];

/* 只读命令 */
const READ_COMMANDS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'more',
  'less',
  'head',
  'tail',
  'grep',
  'findstr',
  'find',
  'pwd',
  'echo',
  'whoami',
  'date',
  'uname',
  'hostname',
  'env',
  'set',
  'git',
  'node',
  'python',
  'pip',
  'npm',
  'rg',
  'ag',
  'fd',
]);

/* 网络命令 */
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'ping', 'nc', 'netcat', 'ssh', 'scp', 'rsync', 'ftp', 'telnet']);

export function analyzeCommand(command: string): CommandAnalysis {
  const reasons: string[] = [];
  let risk: RiskLevel = 'safe';
  let intent: CommandIntent = 'unknown';

  /* 提取二进制名 */
  const binaries = extractBinaries(command);

  /* 结构分析 */
  const hasPipe = command.includes('|') && !command.includes('||');
  const hasRedirect = /[<>]/.test(command) && !/[<>]=/.test(command);
  const hasSubshell = /\$\(|`/.test(command);
  const hasChaining = /;|&&|\|\|/.test(command);

  /* 危险模式检测 */
  for (const { pattern, reason } of CRITICAL_PATTERNS) {
    if (pattern.test(command)) {
      risk = 'critical';
      reasons.push(reason);
    }
  }

  if (risk !== 'critical') {
    for (const { pattern, reason } of HIGH_PATTERNS) {
      if (pattern.test(command)) {
        risk = 'high';
        reasons.push(reason);
      }
    }
  }

  if (risk === 'safe') {
    for (const { pattern, reason } of MEDIUM_PATTERNS) {
      if (pattern.test(command)) {
        risk = 'medium';
        reasons.push(reason);
      }
    }
  }

  /* 命令注入检测 */
  if (hasChaining) {
    const parts = command.split(/;|&&|\|\|/);
    if (parts.length > 1) {
      reasons.push('命令链接（可能隐藏恶意命令）');
      if (risk === 'safe') risk = 'low';
    }
  }

  /* 意图判断 */
  if (binaries.some((b) => NETWORK_COMMANDS.has(b))) {
    intent = 'network';
  } else if (binaries.some((b) => ['rm', 'del', 'rmdir', 'rd'].includes(b))) {
    intent = 'delete';
  } else if (binaries.some((b) => ['kill', 'taskkill', 'pkill'].includes(b))) {
    intent = 'process';
  } else if (hasRedirect || binaries.some((b) => ['echo', 'cat', 'tee'].includes(b) && command.includes('>'))) {
    intent = 'write';
  } else if (binaries.every((b) => READ_COMMANDS.has(b))) {
    intent = 'read';
  }

  /* 只读命令降级 */
  if (intent === 'read' && risk === 'safe' && !hasChaining && !hasSubshell) {
    risk = 'safe';
  }

  return {
    command,
    intent,
    risk,
    reasons,
    binaries,
    hasPipe,
    hasRedirect,
    hasSubshell,
    hasChaining,
  };
}

/** 提取命令中的二进制名。 */
function extractBinaries(command: string): string[] {
  const binaries: string[] = [];
  /* 分割管道和链接 */
  const parts = command.split(/[|;]|&&|\|\|/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    /* 提取第一个词（命令名） */
    const match = trimmed.match(/^(\S+)/);
    if (match) {
      const cmd = match[1];
      /* 跳过环境变量赋值和路径 */
      if (!cmd.includes('=') && !cmd.startsWith('/') && !cmd.startsWith('./')) {
        binaries.push(cmd);
      }
    }
  }
  return binaries;
}

/** 判断命令是否安全（可自动执行）。 */
export function isCommandSafe(command: string): boolean {
  const analysis = analyzeCommand(command);
  return analysis.risk === 'safe' || analysis.risk === 'low';
}

/** 获取命令的风险描述。 */
export function getRiskDescription(command: string): string {
  const analysis = analyzeCommand(command);
  if (analysis.reasons.length === 0) return '安全';
  return analysis.reasons.join('；');
}
