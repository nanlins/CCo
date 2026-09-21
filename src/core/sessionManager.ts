/**
 * 会话管理器 —— 多会话 list/switch/create/delete。
 *
 * 功能：
 *   1. 列出所有会话（从 .transcripts/ 扫描）
 *   2. 切换会话（加载历史消息）
 *   3. 创建新会话
 *   4. 删除会话
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../types.js';

export interface SessionInfo {
  id: string;
  createdAt: number;
  messageCount: number;
  lastMessage?: string;
}

export class SessionManager {
  private transcriptsDir: string;

  constructor(workspaceDir: string) {
    this.transcriptsDir = path.join(workspaceDir, '.transcripts');
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
  }

  /** 读取快照文件中的 messages（兼容 v2 快照对象与旧版纯数组）。 */
  private readMessages(file: string): Message[] | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { messages?: Message[] } | Message[];
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) return parsed.messages;
      return null;
    } catch {
      return null;
    }
  }

  /** 列出所有会话。 */
  list(): SessionInfo[] {
    if (!fs.existsSync(this.transcriptsDir)) return [];
    const sessions: SessionInfo[] = [];
    for (const file of fs.readdirSync(this.transcriptsDir)) {
      if (!file.endsWith('.messages.json')) continue;
      const sessionId = file.replace('.messages.json', '');
      const messages = this.readMessages(path.join(this.transcriptsDir, file));
      if (!messages) continue; // 损坏文件跳过
      const lastMsg = messages.length > 0 ? this.extractText(messages[messages.length - 1]) : undefined;
      sessions.push({
        id: sessionId,
        createdAt: fs.statSync(path.join(this.transcriptsDir, file)).mtimeMs,
        messageCount: messages.length,
        lastMessage: lastMsg?.slice(0, 100),
      });
    }
    return sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 加载会话消息。 */
  load(sessionId: string): Message[] | null {
    const file = path.join(this.transcriptsDir, `${sessionId}.messages.json`);
    if (!fs.existsSync(file)) return null;
    return this.readMessages(file);
  }

  /** 保存会话消息。 */
  save(sessionId: string, messages: Message[]): void {
    const file = path.join(this.transcriptsDir, `${sessionId}.messages.json`);
    fs.writeFileSync(file, JSON.stringify(messages, null, 2), 'utf8');
  }

  /** 删除会话。 */
  delete(sessionId: string): boolean {
    const file = path.join(this.transcriptsDir, `${sessionId}.messages.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  /** 创建新会话 ID。 */
  create(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private extractText(msg: Message): string | undefined {
    if (typeof msg.content === 'string') return msg.content;
    for (const block of msg.content) {
      if (block.type === 'text') return block.text;
    }
    return undefined;
  }
}
