/**
 * Worktree Isolation —— 各干各的，互不干扰（s18 模式）。
 * create / remove / keep / list + 名称校验 + 任务绑定 + 审计事件。
 * bash/read/write 的 cwd 由调用方（队友/任务）切换到对应 worktree 目录。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TaskSystem } from './tasks.js';
import type { ToolDef } from '../types.js';

const execFileP = promisify(execFile);

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, timeout: 30_000 });
    return { ok: true, out: String(stdout).trim(), err: String(stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? (err as Error).message) };
  }
}

export class WorktreeManager {
  constructor(
    private workdir: string,
    private audit?: (event: string, data?: Record<string, unknown>) => void,
  ) {}

  private dir(): string {
    return path.join(this.workdir, '.worktrees');
  }

  validateName(name: string): boolean {
    return /^[A-Za-z0-9._-]{1,64}$/.test(name);
  }

  async create(name: string, taskId?: string, tasks?: TaskSystem): Promise<string> {
    if (!this.validateName(name)) return `Error: invalid worktree name '${name}'`;
    const target = path.join(this.dir(), name);
    if (fs.existsSync(target)) return `Error: worktree '${name}' already exists`;
    const res = await runGit(this.workdir, ['worktree', 'add', target, '-b', `wt/${name}`, 'HEAD']);
    if (!res.ok) return `Error: git worktree add failed: ${res.err}`;
    this.audit?.('worktree_create', { name, taskId });
    if (taskId && tasks) {
      const task = tasks.get(taskId);
      if (task) {
        tasks.update(taskId, { worktree: name });
        return `Worktree '${name}' created at ${target} and bound to ${taskId}`;
      }
    }
    return `Worktree '${name}' created at ${target}`;
  }

  async remove(name: string): Promise<string> {
    if (!this.validateName(name)) return `Error: invalid worktree name '${name}'`;
    const target = path.join(this.dir(), name);
    if (!fs.existsSync(target)) return `Error: worktree '${name}' not found`;
    const status = await runGit(target, ['status', '--porcelain']);
    if (status.ok && status.out.trim()) {
      return `Error: worktree '${name}' has uncommitted changes — use keep_worktree instead`;
    }
    const res = await runGit(this.workdir, ['worktree', 'remove', '--force', target]);
    if (!res.ok) return `Error: git worktree remove failed: ${res.err}`;
    this.audit?.('worktree_remove', { name });
    return `Removed worktree '${name}'`;
  }

  list(): string[] {
    if (!fs.existsSync(this.dir())) return [];
    return fs.readdirSync(this.dir()).filter((d) => fs.statSync(path.join(this.dir(), d)).isDirectory());
  }
}

export function worktreeTools(mgr: WorktreeManager, tasks?: TaskSystem): ToolDef[] {
  return [
    {
      schema: {
        name: 'create_worktree',
        description: '创建带独立分支的隔离 git worktree（可选绑定到任务）。',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
            task_id: { type: 'string' },
          },
          required: ['name'],
        },
      },
      executor: async (args: Record<string, unknown>): Promise<string> =>
        mgr.create(String(args.name ?? ''), args.task_id ? String(args.task_id) : undefined, tasks),
    },
    {
      schema: {
        name: 'remove_worktree',
        description: '移除一个 worktree（有未提交改动时拒绝）。',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      executor: async (args: Record<string, unknown>): Promise<string> => mgr.remove(String(args.name ?? '')),
    },
    {
      schema: {
        name: 'worktree_list',
        description: '列出现有的 worktree。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: (): string => {
        const list = mgr.list();
        return list.length ? list.join('\n') : '（无 worktree）';
      },
      concurrencySafe: true,
    },
  ];
}
