/**
 * 可观测性 —— 比教学版更早、更重投入的第三件事。
 *
 * 1. Transcript：每个会话一个 .transcripts/<sessionId>.jsonl，记录全部事件
 *    （用户输入 / LLM 调用摘要 / 工具调用 / 工具结果 / 权限决策 / 错误）；
 * 2. AuditLog：.audit/events.jsonl 追加式审计流（权限 + worktree 等敏感操作），
 *    用于多 agent 场景的追责与回放。
 * 3. Snapshot：会话断点恢复 —— 完整消息快照存 .transcripts/<id>.messages.json，
 *    重启后 /resume 载入继续。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Message, TodoItem } from '../types.js';

/** 会话完整快照（v2）：messages + todos + readFileState + session id，供 /resume 全量恢复。 */
export interface SessionSnapshot {
  version: 2;
  sessionId: string;
  savedAt: string;
  messages: Message[];
  todos?: TodoItem[];
  /** readFileState 已读文件路径（恢复后重读按磁盘 mtime/size 校验）。 */
  readPaths?: string[];
  /** 预算耗尽/配额中断时保存的最终/部分报告。 */
  finalReport?: string;
  /** run() 终止状态：completed / budget_exhausted / quota_exhausted / rate_limited / cancelled / error。 */
  status?: string;
  /** 跨压缩的会话摘要（供 /retry 基于摘要续跑，避免重放全部消息再次收费）。 */
  sessionMemory?: string;
}

export class Transcript {
  private file: string;
  private lines: Array<Record<string, unknown>> = [];

  constructor(
    private dir: string,
    private sessionId: string,
  ) {
    this.file = path.join(dir, `${sessionId}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
  }

  /** 快照目录（/resume 恢复时用于重建 Transcript）。 */
  getDir(): string {
    return this.dir;
  }

  log(event: string, data?: Record<string, unknown>): void {
    const line = { ts: new Date().toISOString(), session: this.sessionId, event, ...data };
    this.lines.push(line);
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8');
  }

  /** 供 REPL /compact 等命令查看最近事件。 */
  recent(n = 20): Array<Record<string, unknown>> {
    return this.lines.slice(-n);
  }

  /* ---------- 断点恢复快照 ---------- */

  private snapshotFile(): string {
    return path.join(this.dir, `${this.sessionId}.messages.json`);
  }

  /** 保存完整消息快照（覆盖式，供会话恢复）。 */
  saveSnapshot(messages: Message[]): void {
    fs.writeFileSync(this.snapshotFile(), JSON.stringify(messages, null, 2), 'utf8');
  }

  /** 保存完整会话快照（messages + todos + readPaths，v2 格式）。 */
  saveSessionSnapshot(snap: SessionSnapshot): void {
    fs.writeFileSync(this.snapshotFile(), JSON.stringify(snap, null, 2), 'utf8');
  }

  /** 读取快照；兼容旧格式（纯 messages 数组）；不存在返回 null。 */
  loadSessionSnapshot(): SessionSnapshot | null {
    const f = this.snapshotFile();
    if (!fs.existsSync(f)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as SessionSnapshot | Message[];
      if (Array.isArray(parsed)) {
        /* 旧格式：仅 messages */
        return { version: 2, sessionId: this.sessionId, savedAt: '', messages: parsed };
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 读取快照；不存在返回 null（兼容旧调用）。 */
  loadSnapshot(): Message[] | null {
    return this.loadSessionSnapshot()?.messages ?? null;
  }
}

/** 列出可恢复的会话（存在 .messages.json 快照的会话）。 */
export function listResumableSessions(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.messages.json'))
    .map((f) => f.replace(/\.messages\.json$/, ''));
}

export class AuditLog {
  private file: string;

  constructor(private dir: string) {
    this.file = path.join(dir, 'events.jsonl');
    fs.mkdirSync(dir, { recursive: true });
  }

  event(type: string, data?: Record<string, unknown>): void {
    const line = { ts: new Date().toISOString(), type, ...data };
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8');
  }
}
