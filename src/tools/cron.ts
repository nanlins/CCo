/**
 * Cron Scheduler —— 按时间表生产工作（s14 模式）。
 * 五段式 cron 表达式 + 1s tick 调度循环 + 触发队列。
 * DOM/DOW 同时约束时取 OR（教学版同款语义）。
 * durable 作业持久化到 .cron/jobs.json（跨会话），触发器由 agent inject 消费。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../types.js';

export interface CronJob {
  id: string;
  expr: string;
  prompt: string;
  lastRun: number | null;
  lastRunMinute: string | null;
  createdAt: number;
}

interface Field {
  any: boolean;
  values: Set<number>;
}

export function parseField(spec: string, max: number): Field {
  if (spec === '*' || spec === '') return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('/')) {
      const [base, stepStr] = p.split('/');
      const step = parseInt(stepStr, 10) || 1;
      const start = base === '*' ? 0 : parseInt(base, 10) || 0;
      for (let v = start; v <= max; v += step) values.add(v);
    } else if (p.includes('-')) {
      const [a, b] = p.split('-').map((s) => parseInt(s, 10));
      for (let v = a; v <= b; v++) values.add(v);
    } else {
      const v = parseInt(p, 10);
      if (!Number.isFinite(v)) continue;
      if (v < 0 || v > max) throw new Error(`field value ${v} out of range 0-${max}`);
      values.add(v);
    }
  }
  return { any: false, values };
}

export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    const fMin = parseField(parts[0], 59);
    const fHour = parseField(parts[1], 23);
    const fDom = parseField(parts[2], 31);
    const fMon = parseField(parts[3], 12);
    const fDow = parseField(parts[4], 6);
    if (!fieldOk(fMin, date.getMinutes())) return false;
    if (!fieldOk(fHour, date.getHours())) return false;
    if (!fieldOk(fMon, date.getMonth() + 1)) return false;
    const domOk = fDom.any || fDom.values.has(date.getDate());
    const dowOk = fDow.any || fDow.values.has(date.getDay());
    if (fDom.any && fDow.any) return true;
    if (!fDom.any && !fDow.any) return domOk || dowOk;
    return fDom.any ? dowOk : domOk;
  } catch {
    return false;
  }
}

function fieldOk(f: Field, v: number): boolean {
  return f.any || f.values.has(v);
}

export function isValidCronExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    parseField(parts[0], 59);
    parseField(parts[1], 23);
    parseField(parts[2], 31);
    parseField(parts[3], 12);
    parseField(parts[4], 6);
    return true;
  } catch {
    return false;
  }
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private triggers: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private durableFile: string;

  constructor(private opts: { workdir: string; onTrigger?: (job: CronJob) => void; checkIntervalMs?: number }) {
    this.durableFile = path.join(opts.workdir, '.cron', 'jobs.json');
    this.load();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(new Date()), this.opts.checkIntervalMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  add(expr: string, prompt: string): CronJob {
    if (!isValidCronExpr(expr)) throw new Error(`Invalid cron expression: '${expr}'`);
    const job: CronJob = {
      id: `cron_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      expr,
      prompt,
      lastRun: null,
      lastRunMinute: null,
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  remove(id: string): boolean {
    const ok = this.jobs.delete(id);
    if (ok) this.save();
    return ok;
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  /** 手动触发一轮检查（测试用）；返回命中的 job id。 */
  tick(now: Date): string[] {
    const due: string[] = [];
    const minuteMarker = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    for (const job of this.jobs.values()) {
      if (cronMatches(job.expr, now) && job.lastRunMinute !== minuteMarker) {
        job.lastRun = now.getTime();
        job.lastRunMinute = minuteMarker;
        this.triggers.push(job.prompt);
        due.push(job.id);
        this.opts.onTrigger?.(job);
      }
    }
    if (due.length) this.save();
    return due;
  }

  drainTriggers(): string[] {
    const t = this.triggers;
    this.triggers = [];
    return t;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.durableFile), { recursive: true });
    fs.writeFileSync(this.durableFile, JSON.stringify(this.list(), null, 2), 'utf8');
  }

  private load(): void {
    if (!fs.existsSync(this.durableFile)) return;
    try {
      const jobs = JSON.parse(fs.readFileSync(this.durableFile, 'utf8')) as CronJob[];
      for (const j of jobs) this.jobs.set(j.id, j);
    } catch {
      // 损坏则忽略，从空开始
    }
  }
}

export function cronTools(scheduler: CronScheduler): ToolDef[] {
  return [
    {
      schema: {
        name: 'cron_add',
        description: '用五段式 cron 表达式（分 时 日 月 周）调度周期性提示触发。',
        input_schema: {
          type: 'object',
          properties: {
            expr: { type: 'string', description: '例如 */5 * * * *（每 5 分钟）' },
            prompt: { type: 'string', description: '触发时注入的消息' },
          },
          required: ['expr', 'prompt'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        try {
          const job = scheduler.add(String(args.expr ?? ''), String(args.prompt ?? ''));
          return `Scheduled ${job.id}: ${job.expr} — ${job.prompt}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      schema: {
        name: 'cron_list',
        description: '列出已调度的 cron 任务。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: (): string => {
        const jobs = scheduler.list();
        return jobs.length
          ? jobs.map((j) => `${j.id}: ${j.expr} — ${j.prompt} (lastRun=${j.lastRun ?? 'never'})`).join('\n')
          : '（无 cron 任务）';
      },
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'cron_remove',
        description: '按 id 移除一个 cron 任务。',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        const ok = scheduler.remove(String(args.id ?? ''));
        return ok ? `Removed ${args.id}` : `Error: unknown cron job ${args.id}`;
      },
    },
  ];
}
