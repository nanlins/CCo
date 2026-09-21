/**
 * Mock LLM —— 离线运行与测试用。
 * 按剧本逐轮返回 text / tool_use 块，可指定 stopReason 与延迟。
 */
import type { LlmCallParams, LlmClient, LlmResult } from './client.js';
import type { AssistantBlock } from '../types.js';

export type ScriptedBlock =
  { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };

export interface ScriptedTurn {
  blocks: ScriptedBlock[];
  stopReason?: string | null;
  /** 可选用量（测试 token 预算用）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface MockOptions {
  script?: ScriptedTurn[];
  fallbackText?: string;
  delayMs?: number;
}

export class MockLlm implements LlmClient {
  private turn = 0;
  readonly calls: LlmCallParams[] = [];

  constructor(private opts: MockOptions = {}) {}

  async complete(params: LlmCallParams): Promise<LlmResult> {
    this.calls.push(params);
    if (params.abortSignal?.aborted) throw new Error('aborted');
    if (this.opts.delayMs) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs));
      if (params.abortSignal?.aborted) throw new Error('aborted');
    }
    const scripted = this.opts.script?.[this.turn];
    this.turn += 1;

    const blocks: ScriptedBlock[] = scripted?.blocks ?? [
      {
        type: 'text',
        text:
          this.opts.fallbackText ??
          '(当前为 MOCK 离线模式：本对话走演示剧本，不调用真实模型。若已配置 .env 的 ANTHROPIC_API_KEY，请先运行 `Remove-Item Env:MOCK` 清除离线模式后重启。)',
      },
    ];
    const content: AssistantBlock[] = blocks.map((b, i) =>
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : {
            type: 'tool_use',
            id: `mock_tool_${this.turn}_${i}`,
            name: b.name,
            input: b.input,
          },
    );
    const hasToolUse = content.some((b) => b.type === 'tool_use');
    // Simulate streaming the same way the real SDK does, so MOCK demos exercise onEvent.
    for (const b of content) {
      if (b.type === 'text') params.onEvent?.({ type: 'text', text: b.text });
    }

    /* 结构化输出模式：剧本里 tool_use 名与 structured.name 匹配时，直接提取为 structured。 */
    let structured: Record<string, unknown> | undefined;
    if (params.structured) {
      const hit = content.find((b) => b.type === 'tool_use' && b.name === params.structured!.name);
      if (hit?.type === 'tool_use') {
        structured = hit.input as Record<string, unknown>;
      }
    }

    return {
      content,
      stopReason: scripted?.stopReason !== undefined ? scripted.stopReason : hasToolUse ? 'tool_use' : 'end_turn',
      model: 'mock',
      structured,
      usage: scripted?.usage,
    };
  }

  /** 当前剧本长度（测试断言用）。 */
  get turnsConsumed(): number {
    return this.turn;
  }
}
