/**
 * Reflexion —— 让模型对输出自检、反思、修正（PDF Prompt 章节）。
 *
 * 提供 self_review 工具：模型在完成任务后主动调用，对已完成的工作做
 * 正确性/完整性/安全隐患自评，返回改进建议，模型据此修正。
 */
import type { ToolContext, ToolDef } from '../types.js';
import type { LlmClient } from '../llm/client.js';

export interface ReviewTarget {
  kind: 'file' | 'text';
  path?: string;
  text?: string;
}

/** 对目标做自评（LLM Reflexion）：返回结构化评审结果。 */
export async function selfReview(target: ReviewTarget, llm: LlmClient, maxTokens = 1500): Promise<string> {
  const content =
    target.kind === 'file'
      ? `[文件: ${target.path}]\n${target.text?.slice(0, 4000) ?? '(内容见文件)'}`
      : (target.text?.slice(0, 4000) ?? '(空)');

  const result = await llm.complete({
    system:
      'You are a code reviewer (Reflexion). Critique the submitted work for: ' +
      'correctness, completeness, security risks, edge cases, style. ' +
      'Be specific and actionable. If no issues, say so explicitly.',
    messages: [{ role: 'user', content: `Review this:\n\n${content}` }],
    tools: [],
    maxTokens,
  });
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export function selfReviewTool(): ToolDef {
  return {
    schema: {
      name: 'self_review',
      description: '对已完成的工作做自检反思（Reflexion）：检查正确性/完整性/安全风险/边界情况。发现问题后应主动修正。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要审查的文件路径（与 text 二选一）' },
          text: { type: 'string', description: '要审查的文本内容（与 path 二选一）' },
        },
      },
    },
    executor: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const text = typeof args.text === 'string' ? args.text : undefined;
      if (!path && !text) return 'Error: 需要提供 path 或 text';
      try {
        return await selfReview({ kind: 'file', path, text }, ctx.llm);
      } catch (err) {
        return `自检失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    concurrencySafe: true,
  };
}
