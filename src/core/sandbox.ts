/**
 * 命令沙箱 —— 比教学版更早、更重投入的第一件事。
 *
 * 三层防御：
 * 1. deny patterns（纵深防御，即使权限层被绕过也拦截）；
 * 2. cwd 约束（命令在指定工作目录内执行，worktree 场景自动跟随）；
 * 3. 可选 SANDBOX_CMD 包装（把命令送进 docker / WSL 等容器执行）。
 *
 * 统一超时 + 输出上限，防止一条命令打满上下文（s08 budget 层的工具侧兜底）。
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
    const blocked = Sandbox.blockedByDenyList(command);
    if (blocked) return `Error: ${blocked}`;

    const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
    const finalCommand = this.opts.sandboxCmd ? `${this.opts.sandboxCmd} ${command}` : command;
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', finalCommand]
        : ['-lc', finalCommand];

    const child = spawn(shell, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      /* POSIX 独立进程组：超时可整组杀掉；Windows 靠 taskkill /t 杀树 */
      detached: process.platform !== 'win32',
    });

    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
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

    const truncated = out.length >= max;
    const trimmed = out.trim();
    if (!trimmed) return '（无输出）';
    return (truncated ? trimmed.slice(0, max) + '\n...[output truncated]' : trimmed);
  }
}