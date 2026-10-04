/**
 * 命令沙箱 —— 比教学版更早、更重投入的第一件事。
 *
 * 三层防御：
 * 1. deny patterns（纵深防御，即使权限层被绕过也拦截）；
 * 2. cwd 约束（命令在指定工作目录内执行，worktree 场景自动跟随）；
 * 3. 可选 SANDBOX_CMD 包装（把命令送进 docker / WSL 等容器执行）。
 *
 * 统一超时 + 输出上限，防止一条命令打满上下文（s08 budget 层的工具侧兜底）。
 *
 * Windows shell 选择：cmd.exe 与 PowerShell 语法不兼容（Get-Content 等 cmdlet 在 cmd 下
 * 必然失败，导致 agent 反复重试）。pickShellArgs 按命令内容自动选择：
 * 出现 Verb-Noun cmdlet → powershell.exe，否则 cmd.exe。
 *
 * 结构化错误：非零退出码返回 "Error: ..." + 输出尾部 + 针对性 Hint，
 * 让模型一次修正（路径引号/shell 差异），而不是反复猜命令。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface SandboxOptions {
  cwd: string;
  sandboxCmd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

const DENY_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/+/i,
  /\bsudo\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /format\s+[a-z]:/i,
  /del\s+\/s\s+\/?[a-z]:\\/i,
  /rd\s+\/s\s+\/?[a-z]:\\/i,
  /rm\s+-rf\s+[a-z]:\\/i,
];

/** PowerShell Verb-Noun cmdlet 识别（首字母大写的动词-名词）。 */
const PS_CMDLET_RX =
  /\b(Get|Set|New|Remove|Select|Test|Invoke|Out|Add|Write|Copy|Move|Start|Stop|Import|Export|Update|ConvertTo|ConvertFrom|Measure|Compare|Sort|Where|ForEach|Join|Split|Resolve|Clear|Read|Send|Wait|Compress|Expand|Format|Register|Rename|Reset|Restore|Save|Sync|Unblock|Unlock|Disable|Enable|Enter|Exit|Mount|Open|Optimize|Pop|Push|Redo|Repair|Revoke|Search|Show|Skip|Step|Suspend|Switch|Undo|Uninstall|Unregister)-[A-Za-z]+\b/;

/** PowerShell 变量/作用域语法（$env:、$var、@()）。 */
const PS_SYNTAX_RX = /\$(env:|[A-Za-z_{])|@\(/;

/**
 * 按命令内容选择 shell（纯函数，供 Sandbox / BackgroundSystem 共用与单测）。
 * Windows：出现 PowerShell cmdlet 或 PS 语法 → powershell.exe；否则 cmd.exe。
 *
 * cmd.exe 引号安全：`cmd /s /c` 会剥掉命令串首尾引号，而 Node 默认会给含空格参数
 * 加 `\"` 转义（cmd 不认这种转义，`git commit -m "msg"` 会因此损坏）。故这里手动
 * 给命令包一层引号并置 verbatim=true（spawn 时 windowsVerbatimArguments），
 * 让命令原样送达 cmd，内层引号完整保留。
 */
export function pickShellArgs(command: string): { shell: string; args: string[]; verbatim?: boolean } {
  if (process.platform === 'win32') {
    if (PS_CMDLET_RX.test(command) || PS_SYNTAX_RX.test(command)) {
      return {
        shell: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', command],
      };
    }
    return {
      shell: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      verbatim: true,
    };
  }
  return { shell: '/bin/sh', args: ['-lc', command] };
}

/** 针对常见失败模式给出结构化修正提示（让模型一次改对）。 */
export function shellErrorHints(command: string, output: string): string[] {
  const hints: string[] = [];
  const out = output.toLowerCase();
  if (process.platform === 'win32') {
    if (out.includes('is not recognized as an internal or external command')) {
      hints.push(
        '命令在 cmd.exe 下无法识别：PowerShell cmdlet（Get-*/Set-* 等）会自动改用 powershell.exe 执行；' +
          '若为自写脚本，请给出相对工作区的正确路径（如 node script.js）。',
      );
    }
    if (out.includes('cannot find') || out.includes('no such file') || out.includes('找不到')) {
      hints.push('文件/命令未找到：先 list_files 或 glob 确认路径；Windows 路径含空格时必须加双引号。');
    }
    if (/([A-Za-z]:\\|\.\.?[\\/])\S*\s+\S*\S*\\/.test(command) && !/"[^"]*\\/.test(command)) {
      hints.push('Windows 路径含空格/反斜杠时建议整体加双引号，例如 node "my dir\\script.js"。');
    }
  } else {
    if (out.includes('command not found') || out.includes('no such file')) {
      hints.push('命令或文件未找到：先确认路径与可执行文件存在（可用 which/ls）。');
    }
  }
  if (out.includes('permission denied')) {
    hints.push('权限不足：不要尝试 sudo/提权（会被 deny list 拦截），改用工作区内可写路径。');
  }
  return hints;
}

/** 结构化失败输出：Error 前缀 + 退出码 + 输出尾部 + Hint（模型可一次修正）。 */
export function formatShellError(command: string, exitCode: number | null, output: string): string {
  const tail = output.trim().slice(-2000);
  const hints = shellErrorHints(command, output);
  const lines = [`Error: command failed (exit code ${exitCode ?? 'unknown'})`, `Command: ${command.slice(0, 300)}`];
  if (tail) lines.push(`Output (tail):\n${tail}`);
  if (hints.length > 0) lines.push(`Hint: ${hints.join(' ')}`);
  lines.push('Do NOT retry the identical command; fix the issue above or try a different approach.');
  return lines.join('\n');
}

export class Sandbox {
  constructor(private opts: SandboxOptions) {}

  /** 纯字符串检查，供权限层做闸门 1（不执行）。 */
  static blockedByDenyList(command: string): string | null {
    for (const re of DENY_PATTERNS) {
      if (re.test(command)) return `Blocked: dangerous pattern ${re}`;
    }
    return null;
  }

  async run(command: string): Promise<string> {
    return (await this.runWithExit(command)).output;
  }

  /**
   * 同 run，但额外返回退出码（供 commandExit0 verifier 采集）。
   * 被 deny list 拦截 / 超时 → exitCode=null（不等于成功）。
   */
  async runWithExit(command: string): Promise<{ output: string; exitCode: number | null }> {
    const blocked = Sandbox.blockedByDenyList(command);
    if (blocked) return { output: `Error: ${blocked}`, exitCode: null };

    const finalCommand = this.opts.sandboxCmd ? `${this.opts.sandboxCmd} ${command}` : command;
    const { shell, args, verbatim } = pickShellArgs(finalCommand);

    const child = spawn(shell, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      /* cmd.exe + 已手动包裹引号：禁用 Node 的 `\"` 转义（cmd 不认），命令原样送达 */
      windowsVerbatimArguments: verbatim,
      /* POSIX 独立进程组：超时可整组杀掉；Windows 靠 taskkill /t 杀树 */
      detached: process.platform !== 'win32',
    });

    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        /* kill 只杀 cmd.exe 本身，孙进程（node/python 等）会孤儿化 → taskkill 杀整棵树 */
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } catch {
          child.kill();
        }
      } else {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, timeoutMs);

    let out = '';
    const max = this.opts.maxOutputChars ?? 50_000;
    const collect = (chunk: Buffer) => {
      if (out.length < max) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const [code] = (await once(child, 'close')) as [number | null];
    clearTimeout(timer);

    if (timedOut) {
      return {
        output: `Error: command timed out after ${timeoutMs}ms\nCommand: ${command.slice(0, 300)}\nHint: 拆分为更小的步骤，或使用 run_in_background=true 放后台执行。`,
        exitCode: null,
      };
    }

    const truncated = out.length >= max;
    const trimmed = out.trim();
    /* 非零退出码 → 结构化错误（让模型一次修正，而不是反复重试同一条命令） */
    if (code !== 0) {
      return { output: formatShellError(command, code, trimmed), exitCode: code ?? null };
    }
    if (!trimmed) return { output: '（无输出）', exitCode: code ?? 0 };
    return {
      output: truncated ? trimmed.slice(0, max) + '\n...[output truncated]' : trimmed,
      exitCode: code ?? 0,
    };
  }
}
