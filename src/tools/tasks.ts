/**
 * Task System —— 大目标拆成小任务，排好序，持久化（s12 模式）。
 * 每个任务一个 JSON 文件（.tasks/<id>.json），blockedBy 依赖图，
 * claim/complete 状态机，跨会话可恢复 —— 多 agent 协作的基础。
 * 工具通过闭包注入 TaskSystem 实例（装配层在 main.ts 创建）。
 *
 * 并发安全：claim/complete 用 proper-lockfile 文件锁，防止 TOCTOU 竞态。
 */
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { ToolDef } from '../types.js';

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner: string | null;
  blockedBy: string[];
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
}

export class TaskSystem {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private highwatermarkFile(): string {
    return path.join(this.dir, '.highwatermark');
  }

  /** 顺序 ID + 高水位标（CC 语义）：即使任务被删除，ID 也不会被重用。 */
  private nextId(): string {
    let hw = 0;
    if (fs.existsSync(this.highwatermarkFile())) {
      try {
        hw = Number(fs.readFileSync(this.highwatermarkFile(), 'utf8').trim()) || 0;
      } catch {
        hw = 0;
      }
    }
    hw += 1;
    fs.writeFileSync(this.highwatermarkFile(), String(hw), 'utf8');
    return `task_${String(hw).padStart(8, '0')}`;
  }

  create(subject: string, description = '', blockedBy: string[] = []): TaskRecord {
    const task: TaskRecord = {
      id: this.nextId(),
      subject,
      description,
      status: 'pending',
      owner: null,
      blockedBy,
      worktree: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(this.file(task.id), JSON.stringify(task), 'utf8');
    return task;
  }

  get(id: string): TaskRecord | null {
    if (!fs.existsSync(this.file(id))) return null;
    return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as TaskRecord;
  }

  list(): TaskRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as TaskRecord)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  update(id: string, patch: Partial<TaskRecord>): TaskRecord | null {
    const task = this.get(id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: Date.now() });
    fs.writeFileSync(this.file(id), JSON.stringify(task, null, 2), 'utf8');
    return task;
  }

  canStart(id: string): boolean {
    const task = this.get(id);
    if (!task || task.status !== 'pending') return false;
    for (const depId of task.blockedBy) {
      const dep = this.get(depId);
      if (!dep || dep.status !== 'completed') return false;
    }
    return true;
  }

  async claim(id: string, owner: string): Promise<string> {
    const filePath = this.file(id);
    if (!fs.existsSync(filePath)) return `Error: unknown task ${id}`;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } });
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TaskRecord;
      if (task.status === 'completed') return `Task ${id} already completed`;
      if (task.owner && task.owner !== owner) return `Task ${id} already claimed by ${task.owner}`;
      if (!this.canStart(id)) {
        const blocked = task.blockedBy.filter((d) => {
          const dep = this.get(d);
          return !dep || dep.status !== 'completed';
        });
        return `Task ${id} blocked by: ${blocked.join(', ')}`;
      }
      task.status = 'in_progress';
      task.owner = owner;
      task.updatedAt = Date.now();
      fs.writeFileSync(filePath, JSON.stringify(task), 'utf8');
      return `Claimed ${id}`;
    } catch (err) {
      return `Error claiming task: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (release) await release();
    }
  }

  async complete(id: string): Promise<string> {
    const filePath = this.file(id);
    if (!fs.existsSync(filePath)) return `Error: unknown task ${id}`;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } });
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TaskRecord;
      if (task.status !== 'in_progress') return `Task ${id} is not in_progress`;
      task.status = 'completed';
      task.updatedAt = Date.now();
      fs.writeFileSync(filePath, JSON.stringify(task), 'utf8');
      const unlocked = this.list().filter((t) => t.blockedBy.includes(id) && t.status === 'pending');
      const note = unlocked.length ? ` Unlocked: ${unlocked.map((t) => t.id).join(', ')}` : '';
      return `Completed ${id}${note}`;
    } catch (err) {
      return `Error completing task: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (release) await release();
    }
  }

  toJSON(id: string): string {
    const task = this.get(id);
    return task ? JSON.stringify(task, null, 2) : `Error: unknown task ${id}`;
  }
}

/* ---------- 工具（闭包注入 system） ---------- */

export function taskTools(system: TaskSystem, defaultOwner: string): ToolDef[] {
  return [
    {
      schema: {
        name: 'task_create',
        description: '创建一个任务。返回其 id。用 blockedBy 声明依赖。',
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            description: { type: 'string', default: '' },
            blockedBy: { type: 'array', items: { type: 'string' }, default: [] },
          },
          required: ['subject'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        const t = system.create(
          String(args.subject ?? ''),
          String(args.description ?? ''),
          Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : [],
        );
        return `Created ${t.id}: ${t.subject}`;
      },
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'task_get',
        description: '以 JSON 形式查看任务记录。',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      executor: (args: Record<string, unknown>): string => system.toJSON(String(args.id ?? '')),
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'task_list',
        description: '列出所有任务（JSON 数组）。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: (): string => {
        const list = system.list();
        return list.length ? JSON.stringify(list, null, 2) : '（无任务）';
      },
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'task_update',
        description: '更新任务字段（subject/description/status/owner/worktree）。认领请用 task_claim。',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            owner: { type: 'string' },
            worktree: { type: 'string' },
          },
          required: ['id'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        const patch: Record<string, unknown> = {};
        for (const k of ['subject', 'description', 'status', 'owner', 'worktree'] as const) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        const t = system.update(String(args.id ?? ''), patch);
        return t ? `Updated ${t.id}` : `Error: unknown task ${args.id}`;
      },
    },
    {
      schema: {
        name: 'task_claim',
        description: '认领一个 pending 任务（分配 owner，状态 → in_progress）。尊重 blockedBy 依赖。',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      executor: async (args: Record<string, unknown>): Promise<string> =>
        system.claim(String(args.id ?? ''), defaultOwner),
    },
    {
      schema: {
        name: 'task_complete',
        description: '把已认领的任务标记为完成；解锁下游依赖。',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      executor: async (args: Record<string, unknown>): Promise<string> => system.complete(String(args.id ?? '')),
    },
  ];
}
