/**
 * LLM 客户端 —— 封装 Anthropic SDK。
 *
 * 重点投入（提示词缓存友好）：
 * 1. system 使用带 cache_control 的 TextBlock，前缀稳定，命中 prompt cache；
 * 2. tools 同样挂 cache_control，工具 schema 顺序稳定（注册表顺序）；
 * 3. 内部消息模型（types.ts）与 SDK 类型在边界转换，核心层不依赖 SDK。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config.js';
import type {
  AssistantBlock,
  ContentBlock,
  Message,
  ToolSchema,
} from '../types.js';

export interface StructuredOutput {
  /** 内部工具名（如 extract_memories），用于强制模型输出 JSON。 */
  name: string;
  /** 工具描述。 */
  description: string;
  /** JSON Schema：input_schema，即期望的结构化输出形状。 */
  schema: Record<string, unknown>;
}

export interface LlmCallParams {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
  model?: string;
  onEvent?: (event: { type: 'text'; text: string }) => void;
  /** 结构化输出：设置后通过 tool_choice 强制模型返回 JSON（兼容性好）。 */
  structured?: StructuredOutput;
}

export interface LlmResult {
  content: AssistantBlock[];
  stopReason: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  model: string;
  /** 结构化输出模式下，从强制工具调用中提取的 JSON 数据。 */
  structured?: Record<string, unknown>;
}

export interface LlmClient {
  complete(params: LlmCallParams): Promise<LlmResult>;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  private currentApiKey: string;

  constructor(private cfg: AppConfig) {
    this.currentApiKey = cfg.apiKey || 'not-set';
    this.client = new Anthropic({
      apiKey: this.currentApiKey,
      baseURL: cfg.baseUrl,
      maxRetries: 3,
      timeout: 120_000,
    });
  }

  /** 若 cfg.apiKey 运行中被修改（/apikey 命令），重建 client。 */
  private ensureClient(): void {
    const newKey = this.cfg.apiKey || 'not-set';
    if (newKey !== this.currentApiKey) {
      this.currentApiKey = newKey;
      this.client = new Anthropic({
        apiKey: newKey,
        baseURL: this.cfg.baseUrl,
        maxRetries: 3,
        timeout: 120_000,
      });
    }
  }

  async complete(params: LlmCallParams): Promise<LlmResult> {
    this.ensureClient();
    const isStructured = params.structured !== undefined;
    const tools = isStructured
      ? [
          {
            name: params.structured!.name,
            description: params.structured!.description,
            input_schema: params.structured!.schema,
          },
        ]
      : params.tools.map((t) => ({
          ...t,
          cache_control: { type: 'ephemeral' },
        }));

    const stream = this.client.messages.stream({
      model: params.model ?? this.cfg.model,
      max_tokens: params.maxTokens,
      system: [
        { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } },
      ],
      messages: toSdkMessages(params.messages),
      tools: tools as Anthropic.Tool[],
      ...(isStructured
        ? { tool_choice: { type: 'tool' as const, name: params.structured!.name } }
        : {}),
      ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
      ...(this.cfg.topP !== undefined ? { top_p: this.cfg.topP } : {}),
      ...(this.cfg.stopSequences ? { stop_sequences: this.cfg.stopSequences } : {}),
    });

    stream.on('text', (text: string) => {
      params.onEvent?.({ type: 'text', text });
    });

    const final = await stream.finalMessage();

    const blocks = normalizeBlocks(final.content);
    let structured: Record<string, unknown> | undefined;
    if (isStructured) {
      const toolUse = blocks.find((b) => b.type === 'tool_use');
      if (toolUse?.type === 'tool_use') structured = toolUse.input as Record<string, unknown>;
    }

    return {
      content: blocks,
      stopReason: final.stop_reason,
      usage:
        final.usage == null
          ? undefined
          : {
              inputTokens: final.usage.input_tokens,
              outputTokens: final.usage.output_tokens,
              /* 供应商有 prompt cache 时（如 DeepSeek），input_tokens 只报增量，
                 真实上下文规模 = input + cache_read，必须单独记录否则用量严重失真。 */
              cacheReadTokens: final.usage.cache_read_input_tokens ?? undefined,
            },
      model: final.model,
      structured,
    };
  }
}

/* ---------- SDK 边界转换 ---------- */

function toSdkMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    const blocks = m.content.map((b: ContentBlock) => {
      if (b.type === 'text') return { type: 'text', text: b.text } as const;
      if (b.type === 'tool_use') {
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input } as const;
      }
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content } as const;
    });
    return { role: m.role, content: blocks as unknown as Anthropic.ContentBlockParam[] };
  });
}

function normalizeBlocks(
  blocks: Anthropic.ContentBlock[],
): AssistantBlock[] {
  const out: AssistantBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> });
    }
    // thinking / redacted_thinking 等块暂不保留（教学版同样忽略）
  }
  return out;
}