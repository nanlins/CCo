/**
 * Agent Teams —— 一个搞不定，组队来（s15-s17 模式）。
 * MessageBus = 文件收件箱 .team/agents/<name>/inbox.jsonl（append-only, drain-on-read）。
 * 协议：request_id 配对（shutdown 握手 / plan 审批门）。
 * 自治：Teammate 空闲轮询 → 扫描任务看板 → 自动认领（WORK/IDLE/SHUTDOWN 状态机）。
 *
 * 并发安全：drain 用 proper-lockfile 文件锁，防止多线程同时消费丢消息。
 */
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { Agent } from '../core/agent.js';
import type { TaskSystem } from './tasks.js';
import type { ToolDef } from '../types.js';

export type TeamMessageType =
  | 'message'
  | 'broadcast'
  | 'shutdown_request'
  | 'shutdown_response'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'permission_request'
  | 'permission_response';

export interface TeamMessage {
  id: string;
  type: TeamMessageType;
  from: string;
  to: string;
  requestId?: string;
  text?: string;
  ts: number;
}

export class MessageBus {
  private root: string;

  constructor(workdir: string) {
    this.root = path.join(workdir, '.team', 'agents');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private inboxOf(agent: string): string {
    return path.join(this.root, agent, 'inbox.jsonl');
  }

  ensureAgent(name: string): void {
    fs.mkdirSync(path.dirname(this.inboxOf(name)), { recursive: true });
  }

  agents(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter((d) => fs.statSync(path.join(this.root, d)).isDirectory());
  }

  send(msg: Omit<TeamMessage, 'id' | 'ts'>): void {
    const full: TeamMessage = {
      ...msg,
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
    };
    if (msg.to === '*') {
      for (const agent of this.agents()) this.append(this.inboxOf(agent), full);
    } else {
      this.ensureAgent(msg.to);
      this.append(this.inboxOf(msg.to), full);
    }
  }

  private append(file: string, msg: TeamMessage): void {
    fs.appendFileSync(file, JSON.stringify(msg) + '\n', 'utf8');
  }

  /** drain-on-read：读完即清空（文件锁保证原子性）。 */
  async drain(agent: string): Promise<TeamMessage[]> {
    const file = this.inboxOf(agent);
    if (!fs.existsSync(file)) return [];
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(file, { retries: { retries: 5, minTimeout: 5, maxTimeout: 50 } });
      const raw = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, '', 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TeamMessage);
    } catch {
      return [];
    } finally {
      if (release) await release();
    }
  }
}

/* ---------- 工具（闭包注入 bus + 身份） ---------- */

export function teamTools(bus: MessageBus, selfName: string): ToolDef[] {
  return [
    {
      schema: {
        name: 'send_message',
        description: '给一个队友发消息（或 * 广播）。',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: '队友名，或 * 表示广播' },
            text: { type: 'string' },
          },
          required: ['to', 'text'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        bus.send({ type: 'message', from: selfName, to: String(args.to ?? ''), text: String(args.text ?? '') });
        return `Sent message to ${args.to}`;
      },
    },
    {
      schema: {
        name: 'broadcast',
        description: '向所有队友广播一条消息。',
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        bus.send({ type: 'broadcast', from: selfName, to: '*', text: String(args.text ?? '') });
        return `Broadcast sent`;
      },
    },
    {
      schema: {
        name: 'rd_inbox',
        description: '清空你的收件箱并返回所有待处理消息。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: async (): Promise<string> => {
        const msgs = await bus.drain(selfName);
        if (msgs.length === 0) return '(inbox empty)';
        return msgs
          .map((m) => `[${m.type}] from ${m.from}${m.requestId ? ` (req ${m.requestId})` : ''}: ${m.text ?? ''}`)
          .join('\n');
      },
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'send_plan_request',
        description: '向队友请求计划审批（request_id 配对的请求-响应协议）。',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            plan: { type: 'string' },
          },
          required: ['to', 'plan'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        bus.send({
          type: 'plan_approval_request',
          from: selfName,
          to: String(args.to ?? ''),
          requestId,
          text: String(args.plan ?? ''),
        });
        return `Plan request sent (${requestId}). Await response via rd_inbox.`;
      },
    },
    {
      schema: {
        name: 'respond_plan',
        description: '回复一个计划审批请求。',
        input_schema: {
          type: 'object',
          properties: {
            request_id: { type: 'string' },
            to: { type: 'string' },
            decision: { type: 'string', enum: ['approved', 'rejected'] },
          },
          required: ['request_id', 'to', 'decision'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        bus.send({
          type: 'plan_approval_response',
          from: selfName,
          to: String(args.to ?? ''),
          requestId: String(args.request_id ?? ''),
          text: String(args.decision ?? ''),
        });
        return `Responded ${args.decision} to ${args.to} (${args.request_id})`;
      },
    },
    {
      schema: {
        name: 'teammate_status',
        description: '列出已知的队友。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: (): string => {
        const agents = bus.agents();
        return agents.length ? agents.join(', ') : '（无队友）';
      },
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'respond_permission',
        description: '回复队友的权限审批请求（allow/deny）。队友的权限冒泡请求会带 request_id 出现在你的收件箱。',
        input_schema: {
          type: 'object',
          properties: {
            request_id: { type: 'string' },
            to: { type: 'string' },
            decision: { type: 'string', enum: ['allow', 'deny'] },
          },
          required: ['request_id', 'to', 'decision'],
        },
      },
      executor: (args: Record<string, unknown>): string => {
        bus.send({
          type: 'permission_response',
          from: selfName,
          to: String(args.to ?? ''),
          requestId: String(args.request_id ?? ''),
          text: String(args.decision ?? 'deny'),
        });
        return `已回复 ${args.decision} 给 ${args.to} (${args.request_id})`;
      },
    },
  ];
}

/* ---------- 自治队友（s17） ---------- */

export interface TeammateOptions {
  name: string;
  bus: MessageBus;
  agent: Agent;
  tasks?: TaskSystem;
  pollIntervalMs?: number;
  maxRounds?: number;
}

export class Teammate {
  status: 'WORK' | 'IDLE' | 'SHUTDOWN' = 'IDLE';
  private running = true;

  constructor(private opts: TeammateOptions) {
    this.opts.bus.ensureAgent(opts.name);
  }

  stop(): void {
    this.running = false;
  }

  /** 权限冒泡：把审批请求发给 Lead，轮询等待 permission_response（超时 60s 默认拒绝）。 */
  async bubbleAsk(question: string, timeoutMs = 60_000): Promise<boolean> {
    const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.opts.bus.send({
      type: 'permission_request',
      from: this.opts.name,
      to: 'lead',
      requestId,
      text: question,
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msgs = await this.opts.bus.drain(this.opts.name);
      const resp = msgs.find((m) => m.type === 'permission_response' && m.requestId === requestId);
      if (resp) return resp.text === 'allow';
      await sleep(1000);
    }
    return false;
  }

  /** WORK → IDLE → SHUTDOWN 循环。 */
  async start(): Promise<void> {
    const bus = this.opts.bus;
    const maxRounds = this.opts.maxRounds ?? 10;
    let rounds = 0;

    while (this.running && rounds < maxRounds) {
      rounds += 1;

      /* 1. 收件箱优先（shutdown 握手最优先） */
      const msgs = await bus.drain(this.opts.name);
      for (const m of msgs) {
        if (m.type === 'shutdown_request') {
          bus.send({
            type: 'shutdown_response',
            from: this.opts.name,
            to: m.from,
            requestId: m.requestId,
            text: 'clean shutdown ack',
          });
          this.status = 'SHUTDOWN';
          this.running = false;
          break;
        }
        if (m.type === 'plan_approval_request') {
          bus.send({
            type: 'plan_approval_response',
            from: this.opts.name,
            to: m.from,
            requestId: m.requestId,
            text: 'approved',
          });
          continue;
        }
        if (m.type === 'message' && m.text) {
          this.status = 'WORK';
          await this.opts.agent.run(`Message from ${m.from}: ${m.text}`);
        }
      }
      if (!this.running) break;

      /* 2. 扫描任务看板 → 自动认领（s17） */
      if (this.opts.tasks) {
        const tasks = this.opts.tasks;
        const claimable = tasks
          .list()
          .find((t) => t.status === 'pending' && t.blockedBy.every((d) => tasks.get(d)?.status === 'completed'));
        if (claimable) {
          const claim = await tasks.claim(claimable.id, this.opts.name);
          if (claim.startsWith('Claimed')) {
            this.status = 'WORK';
            await this.opts.agent.run(`Task ${claimable.id}: ${claimable.subject}\n${claimable.description}`);
            await tasks.complete(claimable.id);
            continue;
          }
        }
      }

      /* 3. 空闲轮询 */
      this.status = 'IDLE';
      await sleep(this.opts.pollIntervalMs ?? 500);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
