/**
 * Background Tasks —— 慢操作放后台（s13 模式）。
 * bg_run 启动异步命令立即返回占位；bg_check 查状态/输出；
 * 完成通知由 agent 的 inject() 在每轮 LLM 调用前合入（drainNotifications）。
 *
 * 安全：bg_run 与 bash 同一条权限管线（permission.ts 的 SHELL_TOOLS），
 * 且 BackgroundSystem.start 内部再查一次 Sandbox deny list（纵深防御，
 * 任何调用路径都不得绕过）；超时与输出上限默认值与 Sandbox 一致。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Sandbox, pickShellArgs } from '../core/sandbox.js';
import { classifyShellCommand } from '../core/commandClassifier.js';
import type { Message, ToolContext, ToolDef } from '../types.js';

export interface BackgroundJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'timed_out';
  startedAt: number;
  finishedAt?: number;
  output: string;
}

export class BackgroundSystem {
  private jobs = new Map<string, BackgroundJob>();
  private delivered = new Set<string>();
  private seq = 0;

  constructor(private opts: { cwd: string; timeoutMs?: number; maxOutputChars?: number }) {}

  /**
   * 启动后台命令。与 bash 相同：先过 Sandbox deny list（纵深防御，后台不是后门）。
   * 命中 deny list 时抛错，由调用方转成 Error 结果。
   * onResult（可选）：任务结束时回调退出码，供 commandExit0 verifier 采集。
   */
  start(command: string, onResult?: (r: { command: string; exitCode: number }) => void): string {
    const blocked = Sandbox.blockedByDenyList(command);
    if (blocked) throw new Error(blocked);
    const id = `bg_${Date.now()}_${this.seq++}`;
    const job: BackgroundJob = { id, status: 'running', startedAt: Date.now(), output: '' };
    this.jobs.set(id, job);
    void this.run(id, command, onResult);
    return id;
  }

  private async run(
    id: string,
    command: string,
    onResult?: (r: { command: string; exitCode: number }) => void,
  ): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    /* 与 bash/Sandbox 相同的 shell 选择（cmd.exe vs PowerShell 自动识别） */
    const { shell, args, verbatim } = pickShellArgs(command);
    const child = spawn(shell, args, { cwd: this.opts.cwd, windowsHide: true, windowsVerbatimArguments: verbatim });
    /* 与 bash/Sandbox 相同的默认超时与输出上限（后台不放宽边界）。 */
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let out = '';
    const max = this.opts.maxOutputChars ?? 50_000;
    const collect = (chunk: Buffer) => {
      if (out.length < max) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    /* 停滞看门狗（CC 的 LocalShellTask 看门狗语义）：
       45s 无输出增长 → 检测交互式提示（y/n 等）→ 终止，防后台任务卡在无人响应的对话框。 */
    const STALL_MS = 45_000;
    let lastLen = 0;
    const watchdog = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) return; // 已结束
      if (out.length === lastLen) {
        if (/[?？]\s*$/m.test(out) || /(y\/n|y\/N|\[y\/N\]|press any key)/i.test(out.slice(-200))) {
          job.status = 'timed_out';
          job.finishedAt = Date.now();
          job.output = (out + '\n...[看门狗] 检测到交互式提示且无输出增长，已终止]').slice(0, max);
          child.kill('SIGKILL');
        }
      } else {
        lastLen = out.length;
      }
    }, STALL_MS);

    const [code] = (await once(child, 'close')) as [number | null];
    clearTimeout(timer);
    clearInterval(watchdog);
    job.output = out;
    job.finishedAt = Date.now();
    job.status = child.killed ? 'timed_out' : code === 0 ? 'completed' : 'failed';
    onResult?.({ command, exitCode: code ?? -1 });
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  /** 未投递且已结束的 → 通知消息（agent inject 每轮调用）。 */
  drainNotifications(): Message[] {
    const out: Message[] = [];
    for (const job of this.jobs.values()) {
      if (this.delivered.has(job.id) || job.status === 'running') continue;
      this.delivered.add(job.id);
      out.push({
        role: 'user',
        content: `[background task ${job.id} ${job.status}]\n${job.output.slice(0, 2000)}`,
      });
    }
    return out;
  }
}

export function backgroundTools(bg: BackgroundSystem): ToolDef[] {
  return [
    {
      schema: {
        name: 'bg_run',
        description: '在后台运行一条慢命令。立即返回任务 id；用 bg_check 轮询。',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      executor: (args: Record<string, unknown>, ctx: ToolContext): string => {
        const command = String(args.command ?? '');
        /* 纵深防御：即使权限层被绕过，后台路径也不得越过 Sandbox deny list。 */
        const blocked = Sandbox.blockedByDenyList(command);
        if (blocked) return `Error: ${blocked}`;
        /* 纵深防御：完整命令分类（重定向逃逸等）与 bash 同一套逻辑。 */
        const cls = classifyShellCommand(command, ctx.workdir);
        if (cls.verdict === 'deny') return `Error: ${cls.reason}`;
        try {
          const id = bg.start(command);
          return `Started ${id} (running in background). Poll with bg_check.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      schema: {
        name: 'bg_check',
        description: '查看后台任务的状态和输出。',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        const job = bg.get(String(args.id ?? ''));
        if (!job) return `Error: unknown background task ${args.id}`;
        return `${job.id}: ${job.status}\n${job.output.slice(0, 3000)}`;
      },
      concurrencySafe: true,
    },
  ];
}
