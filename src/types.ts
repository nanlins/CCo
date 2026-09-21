/**
 * 共享类型定义 —— 手搓 Claude Code 的内部消息模型与工具契约。
 * 内部统一使用 NormalizedBlock，在 LLM 客户端边界做 SDK 转换。
 */
import type { z } from 'zod';
import type { AppConfig } from './config.js';
import type { LlmClient } from './llm/client.js';
import type { ToolRegistry } from './core/registry.js';
import type { PermissionGate } from './core/permission.js';
import type { ReadFileState } from './core/readFileState.js';

export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
export type AssistantBlock = TextBlock | ToolUseBlock;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface Session {
  id: string;
  cwd: string;
  baseSystem: string;
  messages: Message[];
  todos: TodoItem[];
  startTime: number;
  /** 跨压缩的会话摘要（SessionMemoryCompact 用）。 */
  sessionMemory?: string;
  /** 研究任务的必答问题清单（交付检查表）。 */
  checklist?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;

export interface ToolDef {
  schema: ToolSchema;
  executor: ToolExecutor;
  concurrencySafe?: boolean;
  validator?: z.ZodType<Record<string, unknown>>;
  /** 单次执行超时（毫秒），默认 60s。 */
  timeoutMs?: number;
  /** 单次结果大小上限（字符）。read_file 设为 Infinity，防止"读→落盘→再读"死循环。 */
  maxResultSizeChars?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 权限模式：
 *   ask    —— 非明确 safe 的操作一律询问用户；
 *   auto   —— 仅"明确 safe 分类"（只读白名单命令 / 工作区内写入 / classifier=safe）自动放行，
 *             未知或危险命令仍转人工审批（不再自动放行）；
 *   deny   —— 拒绝一切需要审批的操作（只读工具除外）；
 *   bypass —— 危险语义：跳过一切人工审批（等价旧版 auto 的放行行为）。
 *             仅在完全可信的隔离环境使用，风险自负。
 */
export type PermissionMode = 'ask' | 'auto' | 'deny' | 'bypass';

/** 工具执行上下文：workdir 跟随 worktree 切换，ask 是审批回调。 */
export interface ToolContext {
  workdir: string;
  session: Session;
  ask: (question: string) => Promise<boolean>;
  log: (level: LogLevel, message: string) => void;
  registry: ToolRegistry;
  llm: LlmClient;
  config: AppConfig;
  permission: PermissionGate;
  readFileState?: ReadFileState;
}

/* ---------- 消息工具函数 ---------- */

export function messageText(message: Message): string {
  return typeof message.content === 'string' ? message.content : '';
}

export function messageBlocks(message: Message): ContentBlock[] {
  return typeof message.content === 'string' ? [] : message.content;
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use';
}

export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === 'tool_result';
}

export function lastText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content.trim()) return m.content;
      for (const b of messageBlocks(m)) {
        if (b.type === 'text' && b.text.trim()) return b.text;
      }
    }
  }
  return '';
}

/** 粗略字符数（教学版用字符近似 token）。 */
export function countChars(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === 'text') total += b.text.length;
        else if (b.type === 'tool_use') total += JSON.stringify(b.input).length + b.name.length;
        else total += b.content.length;
      }
    }
  }
  return total;
}
