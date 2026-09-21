/**
 * OpenAI 兼容 LLM 客户端 —— Chat Completions 协议（流式）。
 *
 * 与 AnthropicLlm 对等的第二种协议实现（LLM_PROTOCOL=openai 启用）：
 *   - 内部消息模型（types.ts）↔ OpenAI messages 在边界转换，核心层不感知协议差异；
 *   - tool_use/tool_result ↔ tool_calls/role:tool 双向映射；
 *   - stopReason 归一化为 Anthropic 语义（end_turn/max_tokens/tool_use），agent 循环零改动；
 *   - 错误对齐 recovery.ts 契约：.status（429/5xx 重试）与 error.type='prompt_too_long'（应急压缩）。
 */
import type { AppConfig } from '../config.js';
import type { LlmCallParams, LlmClient, LlmResult } from './client.js';
import type { AssistantBlock, Message, ToolSchema } from '../types.js';

/* ---------- 错误类型（对齐 recovery.ts 的 isRetryableError / isPromptTooLong） ---------- */

export class LlmHttpError extends Error {
  status: number;
  error: { type?: string; message?: string };

  constructor(status: number, message: string, type?: string) {
    super(message);
    this.status = status;
    this.error = { type, message };
  }
}

const CONTEXT_OVERFLOW_RX =
  /(maximum context length|context_length_exceeded|prompt is too long|range of input length|too many tokens|exceeds? (the )?(model's )?(maximum|context))/i;

export function classifyHttpError(status: number, body: string, retryAfterMs?: number): LlmHttpError {
  let message = body;
  let apiType: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } };
    if (parsed?.error?.message) message = parsed.error.message;
    apiType = parsed?.error?.type ?? parsed?.error?.code;
  } catch {
    // 非 JSON 响应体，直接用原文
  }
  /* 空响应体（常见于 404/网关错误）时补上状态码，避免错误消息为空只剩裸 "Error" */
  if (!message.trim()) message = `HTTP ${status} (empty response body)`;
  const type = CONTEXT_OVERFLOW_RX.test(message) ? 'prompt_too_long' : apiType;
  const err = new LlmHttpError(status, message, type);
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    (err as LlmHttpError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
  }
  return err;
}

/* ---------- 消息/工具转换（纯函数，可单测） ---------- */

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function toOpenAiMessages(system: string, messages: Message[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const uses = m.content.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      );
      if (uses.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: uses.map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: text });
      }
      continue;
    }
    /* user 消息：tool_result → role:'tool'（必须紧跟 assistant 的 tool_calls），其余文本归 user */
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      } else if (b.type === 'text') {
        texts.push(b.text);
      }
    }
    if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function toOpenAiTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** OpenAI finish_reason → Anthropic 语义（agent 循环按 max_tokens/tool_use 分支处理）。 */
export function mapFinishReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

/* ---------- SSE 流式累积（纯逻辑，可单测） ---------- */

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export class StreamAccumulator {
  text = '';
  toolCalls = new Map<number, ToolCallAcc>();
  finishReason: string | null = null;
  usage?: StreamChunkUsage;

  /** 喂入一个已解析的 chunk JSON 对象；返回本次新增的文本增量。 */
  feed(chunk: Record<string, unknown>): string {
    const choices = chunk.choices as
      Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> | undefined;
    const choice = choices?.[0];
    let deltaText = '';
    if (choice?.delta) {
      const delta = choice.delta as { content?: string; tool_calls?: Array<Record<string, unknown>> };
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        this.text += delta.content;
        deltaText = delta.content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const acc = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof tc.id === 'string') acc.id = tc.id;
          const fn = tc.function as { name?: string; arguments?: string } | undefined;
          /* 名称首次赋值：某些 provider 会在后续 chunk 重复下发 name，若用 += 会导致名称重复 */
          if (fn?.name && !acc.name) acc.name = fn.name;
          if (fn?.arguments) acc.arguments += fn.arguments;
          this.toolCalls.set(index, acc);
        }
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    if (chunk.usage) this.usage = chunk.usage as StreamChunkUsage;
    return deltaText;
  }

  /** 组装为内部 AssistantBlock[]（text 在前，tool_use 在后，对齐 Anthropic 形状）。 */
  blocks(): AssistantBlock[] {
    const out: AssistantBlock[] = [];
    if (this.text) out.push({ type: 'text', text: this.text });
    for (const [, acc] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown>;
      try {
        input = acc.arguments.trim() ? (JSON.parse(acc.arguments) as Record<string, unknown>) : {};
      } catch {
        input = { _raw_arguments: acc.arguments };
      }
      out.push({
        type: 'tool_use',
        id: acc.id || `oai_call_${Math.random().toString(36).slice(2, 10)}`,
        name: acc.name,
        input,
      });
    }
    return out;
  }
}

/** 从 SSE 字节流切出 data: 载荷；处理跨 chunk 的半行。 */
export async function* sseLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  let buffer = '';
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

/* ---------- 客户端 ---------- */

const REQUEST_TIMEOUT_MS = 120_000;
const NETWORK_RETRIES = 2;

export class OpenAiLlm implements LlmClient {
  constructor(private cfg: AppConfig) {}

  async complete(params: LlmCallParams): Promise<LlmResult> {
    const model = params.model ?? this.cfg.model;
    const isStructured = params.structured !== undefined;

    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.maxTokens,
      messages: toOpenAiMessages(params.system, params.messages),
    };
    if (isStructured) {
      body.tools = [
        {
          type: 'function',
          function: {
            name: params.structured!.name,
            description: params.structured!.description,
            parameters: params.structured!.schema,
          },
        },
      ];
      body.tool_choice = { type: 'function', function: { name: params.structured!.name } };
    } else if (params.tools.length > 0) {
      body.tools = toOpenAiTools(params.tools);
      body.tool_choice = 'auto';
    }
    if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;
    if (this.cfg.topP !== undefined) body.top_p = this.cfg.topP;
    if (this.cfg.stopSequences) body.stop = this.cfg.stopSequences;

    const acc = await this.streamRequest(body, params.onEvent, params.abortSignal);
    const blocks = acc.blocks();

    let structured: Record<string, unknown> | undefined;
    if (isStructured) {
      const use = blocks.find((b) => b.type === 'tool_use');
      if (use?.type === 'tool_use') structured = use.input as Record<string, unknown>;
    }

    return {
      content: blocks,
      stopReason: mapFinishReason(acc.finishReason),
      usage: acc.usage
        ? {
            inputTokens: acc.usage.prompt_tokens,
            outputTokens: acc.usage.completion_tokens,
            cacheReadTokens: acc.usage.prompt_tokens_details?.cached_tokens ?? undefined,
          }
        : undefined,
      model,
      structured,
    };
  }

  private async streamRequest(
    body: Record<string, unknown>,
    onEvent?: (e: { type: 'text'; text: string }) => void,
    abortSignal?: AbortSignal,
  ): Promise<StreamAccumulator> {
    const url = `${this.cfg.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
      /* 外部取消（Ctrl+C）优先：已中止则直接抛出，不再发起请求 */
      if (abortSignal?.aborted) throw new Error('aborted');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const onExternalAbort = (): void => controller.abort();
      abortSignal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.cfg.openaiApiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          /* 解析 Retry-After（秒），传给 classifyHttpError 以便退避策略使用 */
          const raHeader = resp.headers.get('retry-after');
          const raSeconds = raHeader ? Number(raHeader) : NaN;
          const raMs = Number.isFinite(raSeconds) && raSeconds > 0 ? raSeconds * 1000 : undefined;
          throw classifyHttpError(resp.status, text, raMs);
        }
        if (!resp.body) throw new LlmHttpError(502, 'empty response body');

        const acc = new StreamAccumulator();
        for await (const data of sseLines(resp.body as AsyncIterable<Uint8Array>)) {
          if (!data || data === '[DONE]') continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const delta = acc.feed(chunk);
          if (delta) onEvent?.({ type: 'text', text: delta });
        }
        return acc;
      } catch (err) {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onExternalAbort);
        lastErr = err;
        /* 用户取消（Ctrl+C）：直接抛出，不做网络重试（保留原始错误链） */
        if (abortSignal?.aborted) throw new Error('aborted', { cause: err });
        /* HTTP 错误（带 status）直接抛给 callWithRetry；仅纯网络故障做本地重试 */
        if (err instanceof LlmHttpError) throw err;
        if (attempt >= NETWORK_RETRIES) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onExternalAbort);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
