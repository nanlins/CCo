/**
 * Error Recovery 工具 —— 错误不是结束，而是重试的开始（s11 模式）。
 * 这里提供纯函数；agent.ts 的循环里按三种路径使用：
 *   max_tokens 截断 → 升级 token / 续写
 *   prompt_too_long → reactive compact（有次数上限，防无限压缩循环）
 *   429/529 → 指数退避 + 抖动 + 备用模型（fallback 真正传给下一次 complete）
 */
import type { LlmClient } from '../llm/client.js';
import { reactiveCompact } from './compact.js';
import type { Message } from '../types.js';

export function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || status === 529 || status === 408 || status === 502 || status === 503;
}

export function isPromptTooLong(err: unknown): boolean {
  const e = err as { error?: { type?: string }; message?: string };
  return (
    e?.error?.type === 'prompt_too_long' || (typeof e?.message === 'string' && e.message.includes('prompt_too_long'))
  );
}

/** 致命配额错误（402 / 余额不足 / payment required）：立即停止整棵任务树，不得重试。 */
export function isFatalQuotaError(err: unknown): boolean {
  const e = err as { status?: number; error?: { type?: string; message?: string }; message?: string };
  if (e?.status === 429) return false; // 429 是限流（瞬时可重试），非致命配额
  if (e?.status === 402) return true; // Payment Required
  const text = `${e?.message ?? ''} ${e?.error?.message ?? ''} ${e?.error?.type ?? ''}`.toLowerCase();
  /* arrear 覆盖 arrears/arrearage（dashscope 欠费 type:'Arrearage'）；
     overdue / good standing 覆盖 dashscope "overdue-payment / account is in good standing" 文案 */
  return /(insufficient[\s_-]?balance|insufficient[\s_-]?fund|balance[\s_-]?insufficient|arrear|overdue|good[\s_-]?standing|payment[\s_-]?required|account[\s_-]?credit|quota[\s_-]?exceeded|超出配额|余额不足|欠费)/.test(
    text,
  );
}

/** 限流错误（429）：瞬时可重试，重试耗尽后只停止当前请求（不停止整棵任务树）。 */
export function isRateLimitError(err: unknown): boolean {
  return (err as { status?: number }).status === 429;
}

/** 兼容旧名：配额/余额类错误 = 致命配额错误（429 不再归入此类）。 */
export function isQuotaError(err: unknown): boolean {
  return isFatalQuotaError(err);
}

/** 从错误对象提取 Retry-After 毫秒（HTTP 头或 provider 设置的字段）。 */
export function retryAfterMs(err: unknown): number | undefined {
  const e = err as {
    retryAfterMs?: number;
    retryAfterSeconds?: number;
    headers?: Record<string, string | undefined>;
  };
  if (typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0) return e.retryAfterMs;
  if (typeof e.retryAfterSeconds === 'number' && e.retryAfterSeconds > 0) return e.retryAfterSeconds * 1000;
  const raw = e.headers?.['retry-after'];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return undefined;
}

/** 把原始 API 错误转成用户可理解的提示（不直接暴露 API 响应原文）。 */
export function humanizeLlmError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (isFatalQuotaError(err)) {
    return '账户余额不足/欠费（402），请充值或更换 API key 后重试';
  }
  if (e?.status === 429) {
    return '触发限流（429），已按指数退避重试仍失败；本次请求已停止，请稍后再试或降低并发';
  }
  if (e?.status === 401) {
    return 'API key 无效或未授权（401），请用 /apikey 检查或更换 key';
  }
  if (e?.status === 404) {
    return '端点不存在（404）：请检查 /baseurl 与 /protocol 是否匹配（openai 端点需支持 /chat/completions，anthropic 端点需 /protocol anthropic）';
  }
  if (e?.status === 403) {
    return '请求被拒绝（403）：检查 key 权限、账户状态或网络出口';
  }
  if (e?.status && e.status >= 500) {
    return `模型服务端错误（${e.status}），可能是上游故障，稍后重试`;
  }
  return `模型调用失败（${e?.status ?? '网络/未知'}）：${e?.message ?? ''}`.trim();
}

/** 指数退避 + 抖动（真实 CC 的公式简化版）。 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** prompt_too_long 连续压缩超过上限时抛出的结构化错误。 */
export class PromptTooLongError extends Error {
  readonly kind = 'prompt_too_long_exhausted';
  constructor(
    public readonly compacts: number,
    message?: string,
  ) {
    super(
      message ??
        `prompt_too_long: 已连续压缩 ${compacts} 次仍超出上下文上限。请 /clear 清空会话、/compact 手动压缩，或减少单次任务的文件读取量。`,
    );
  }
}

export interface RecoveryHandlers {
  /** prompt_too_long 时调用：压缩后返回新 messages。 */
  onPromptTooLong: () => Promise<Message[]>;
  onModelSwitch: (model: string) => void;
}

export interface RecoveryOptions {
  llm: LlmClient;
  fallbackModel?: string;
  maxConsecutiveOverloads?: number;
  /** prompt_too_long 连续压缩上限（默认 3 次，超过抛 PromptTooLongError，防无限循环）。 */
  maxPromptTooLongCompacts?: number;
  /** 重试总次数上限（默认 6）。 */
  maxAttempts?: number;
  /** 测试注入：覆盖退避延迟（毫秒）。 */
  retryDelayMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * 通用"带重试的 LLM 调用"：只处理临时故障（429/529/408/502/503）。
 * max_tokens 与 prompt_too_long 由 agent 循环处理（需要改 messages）。
 *
 * fn 接收当前应使用的模型覆盖值（fallback 切换后传入 fallbackModel），
 * 调用方必须把它传给 LLM.complete，保证 fallback 真正生效。
 */
export async function callWithRetry<T>(
  fn: (modelOverride?: string) => Promise<T>,
  opts: RecoveryOptions,
  handlers?: RecoveryHandlers,
): Promise<T> {
  let consecutive = 0;
  let currentModel: string | undefined;
  let compactCount = 0;
  const maxConsecutive = opts.maxConsecutiveOverloads ?? 2;
  const maxCompacts = opts.maxPromptTooLongCompacts ?? 3;
  const maxAttempts = opts.maxAttempts ?? 6;

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn(currentModel);
      consecutive = 0;
      return result;
    } catch (err) {
      if (isPromptTooLong(err) && handlers) {
        compactCount += 1;
        if (compactCount > maxCompacts) {
          opts.log?.('error', `[recovery] prompt_too_long 连续压缩 ${maxCompacts} 次仍失败，放弃`);
          throw new PromptTooLongError(maxCompacts);
        }
        opts.log?.('warn', `[recovery] prompt_too_long → reactive compact (${compactCount}/${maxCompacts})`);
        void (await handlers.onPromptTooLong());
        consecutive = 0;
        continue;
      }
      if (!isRetryableError(err)) throw err;
      consecutive += 1;
      if (opts.fallbackModel && currentModel === undefined && consecutive >= maxConsecutive) {
        currentModel = opts.fallbackModel;
        handlers?.onModelSwitch(currentModel);
        opts.log?.('warn', `[recovery] switching to fallback model ${currentModel}`);
        consecutive = 0;
        continue; // 立即用 fallback 模型重试（不退避）
      }
      if (attempt >= maxAttempts) throw err;
      /* 429 退避：指数退避 + 抖动，且不低于 Retry-After（若 provider 提供） */
      const baseDelay = opts.retryDelayMs ?? backoffDelay(attempt);
      const ra = retryAfterMs(err);
      const delay = ra !== undefined ? Math.max(baseDelay, ra) : baseDelay;
      opts.log?.('warn', `[recovery] retryable error (${(err as Error).message}) — retry in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/** prompt_too_long 应急压缩的便捷包装（供 agent 使用）。 */
export async function emergencyCompact(messages: Message[], llm: LlmClient, maxTokens: number): Promise<Message[]> {
  const result = await reactiveCompact(messages, llm, { maxTokens });
  return result.messages;
}
