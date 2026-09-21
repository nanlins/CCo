/**
 * Plan-and-Execute 规划器 —— 大任务"先规划再执行"。
 *
 * 职责：
 *   - shouldPlan：判断任务是否需要先规划（配置强制 / 多步骤启发式）；
 *   - buildPlanPrompt + PLAN_SCHEMA：用结构化输出强制模型产出步骤清单；
 *   - parsePlan：把结构化计划转成 TodoItem（沿用 TodoWrite 的清单语义）。
 *
 * 承重不变量：
 *   - 规划阶段是一个独立的小 token LLM 调用，不进入主循环，不产生工具副作用；
 *   - 规划失败必须优雅降级（返回空清单，主循环照常跑），绝不阻断任务。
 */
import type { TodoItem } from '../types.js';

/** 结构化输出的内部工具名（plan_steps，不进工具注册表）。 */
export const PLAN_STEPS_TOOL = 'plan_steps';

/** 步骤数上限（防止规划爆炸）。 */
export const PLAN_MAX_STEPS_DEFAULT = 8;

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      maxItems: PLAN_MAX_STEPS_DEFAULT,
      description: '按执行顺序排列的步骤清单（每步一个具体动作）',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '本步骤要做什么（一句话动作，如"创建 xxx 文件"）' },
          verify: { type: 'string', description: '如何验证本步骤已完成（可观察的完成判据）' },
        },
        required: ['title'],
      },
    },
  },
  required: ['steps'],
};

/** 判定是否需要先规划：返回 {plan, reason}，reason 用于可观测（emit 给用户看为什么规划/不规划）。 */
export function shouldPlan(
  input: string,
  autoPlan: boolean | undefined,
  thresholdChars: number,
): { plan: boolean; reason: string } {
  const text = input.trim();
  if (autoPlan === false) return { plan: false, reason: 'autoPlan=off（未强制规划）' };
  if (autoPlan === true) {
    if (text.length < 40) return { plan: false, reason: '任务过短，无需规划' };
    return { plan: true, reason: 'autoPlan=on（强制规划）' };
  }
  /* 启发式：未显式配置时，长输入 + 多步骤标记 → 规划 */
  if (text.length < thresholdChars) return { plan: false, reason: `输入 ${text.length} 字符，低于阈值 ${thresholdChars}` };
  const multiStep = /(然后|接着|再|并且|并|同时|首先|其次|最后|依次|分别|以及|步骤|第一步|第二步|\d+[.、)])/.test(text);
  if (multiStep) return { plan: true, reason: '检测到多步骤标记' };
  const clauses = text.split(/[。；;\n]/).filter((s) => s.trim().length > 0).length;
  if (clauses >= 3) return { plan: true, reason: `检测到 ${clauses} 个分句（多目标）` };
  return { plan: false, reason: '单步任务，无需规划' };
}

/** 规划阶段的 system prompt。 */
export function buildPlanPrompt(): string {
  return [
    '你是一个任务规划器。把用户目标拆解成**按执行顺序排列**的步骤清单。',
    '规则：',
    '- 每个步骤是一个具体动作（读/写/运行/验证某个对象），不是抽象描述；',
    '- 步骤覆盖完整目标，但不要超过 8 步，能合并就合并；',
    '- 每个步骤给出完成判据 verify（可观察、可验证）；',
    '- 你只输出步骤清单，不执行任何动作、不调用任何工具。',
  ].join('\n');
}

/** 把结构化输出转成 TodoItem（首步 in_progress，其余 pending）。返回空数组表示规划失败。 */
export function parsePlan(structured: Record<string, unknown> | undefined, maxSteps: number): TodoItem[] {
  const raw = structured?.steps;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const todos: TodoItem[] = [];
  for (let i = 0; i < raw.length && todos.length < maxSteps; i++) {
    const item = raw[i] as Record<string, unknown> | undefined;
    const title = String(item?.title ?? '').trim();
    if (!title) continue;
    const verify = String(item?.verify ?? '').trim();
    todos.push({
      content: title,
      status: todos.length === 0 ? 'in_progress' : 'pending',
      activeForm: verify || title,
    });
  }
  return todos;
}
