/**
 * 目标裁判（独立完成判定层）。
 *
 * 职责（对照 learn-claude-code s17_goal_loop）：不依赖模型"声称完成"——
 * 用**结构化 verifier 实际检查**文件系统与工具结果（fileExists/fileContains/commandExit0），
 * 而非对模型文本做子串匹配。
 *
 * 承重不变量：
 *   - 纯函数、可注入 fs 上下文；无 LLM 依赖，可用作 Stop hook 的完成判定层；
 *   - verifier 任一未通过 → 判定未完成并列出未通过项，防止模型空口说"做完了"；
 *   - 旧文本判据 verifyHeuristic 保留但仅作提示，不参与 complete 判定。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GoalVerifier, TodoItem } from '../types.js';

/** 结构化验证器：实际检查文件系统 / 工具结果（类型定义见 types.ts）。 */
export type Verifier = GoalVerifier;

export interface VerifierContext {
  workdir: string;
  /** 本轮工具执行的命令 → 退出码（来自工具结果）。 */
  commandResults?: Array<{ command: string; exitCode: number }>;
}

export interface VerifierOutcome {
  verifier: Verifier;
  ok: boolean;
  detail: string;
}

export interface GoalJudgeInput {
  goal: string;
  todos: TodoItem[];
  /** 结构化验证器（推荐）：实际检查文件系统/工具结果。 */
  verifiers?: Verifier[];
  /** 验证器上下文（workdir + 命令结果）。 */
  ctx?: VerifierContext;
  /** 兼容旧文本判据（仅提示，不构成真实验证）。 */
  evidence?: string;
}

export interface GoalJudgment {
  complete: boolean;
  reason: string;
  /** 未通过/待验证项（供回灌模型自纠）。 */
  unverified: string[];
}

/** 运行结构化验证器，返回每项结果。 */
export function runVerifiers(verifiers: Verifier[], ctx: VerifierContext): VerifierOutcome[] {
  return verifiers.map((v) => {
    try {
      if (v.kind === 'fileExists') {
        const p = path.resolve(ctx.workdir, v.path);
        const ok = fs.existsSync(p);
        return { verifier: v, ok, detail: ok ? `文件存在: ${v.path}` : `文件不存在: ${v.path}` };
      }
      if (v.kind === 'fileContains') {
        const p = path.resolve(ctx.workdir, v.path);
        if (!fs.existsSync(p)) return { verifier: v, ok: false, detail: `文件不存在: ${v.path}` };
        const content = fs.readFileSync(p, 'utf-8');
        const ok = content.includes(v.text);
        return { verifier: v, ok, detail: ok ? `含 "${v.text}": ${v.path}` : `不含 "${v.text}": ${v.path}` };
      }
      /* commandExit0：取最近一次匹配结果（本轮重试成功后应以最后一次退出码为准） */
      const results = ctx.commandResults ?? [];
      let hit: { command: string; exitCode: number } | undefined;
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].command.includes(v.command)) {
          hit = results[i];
          break;
        }
      }
      if (!hit) return { verifier: v, ok: false, detail: `无可执行记录: ${v.command}` };
      const ok = hit.exitCode === 0;
      return {
        verifier: v,
        ok,
        detail: ok ? `退出码 0: ${v.command}` : `退出码 ${hit.exitCode}: ${v.command}`,
      };
    } catch (e) {
      return { verifier: v, ok: false, detail: `verifier 异常: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
}

/**
 * 旧文本判据（仅提示用）：检查 verify 文本是否出现在 evidence 中。
 * 明确不构成真实验证——请改用 verifiers。
 */
export function verifyHeuristic(todos: TodoItem[], evidence: string): string[] {
  const unverified: string[] = [];
  for (const t of todos) {
    const verify = (t.activeForm ?? '').trim();
    if (!verify) continue;
    if (evidence.includes(verify)) continue;
    unverified.push(verify);
  }
  return unverified;
}

export function evaluateGoal(input: GoalJudgeInput): GoalJudgment {
  const { goal, todos, verifiers, ctx } = input;
  const text = String(goal ?? '').trim();

  if (!text && todos.length === 0 && (!verifiers || verifiers.length === 0)) {
    return { complete: true, reason: '无目标也无待办', unverified: [] };
  }

  /* 1) 结构层：还有未完成的 Todo → 一定未完成 */
  const open = todos.filter((t) => t.status !== 'completed');
  if (open.length > 0) {
    return {
      complete: false,
      reason: `尚有 ${open.length} 项待办未完成：${open
        .slice(0, 5)
        .map((t) => t.content)
        .join('；')}`,
      unverified: [],
    };
  }

  /* 2) 真实验证层：结构化 verifier 实际检查文件系统 / 工具结果 */
  if (verifiers && verifiers.length > 0) {
    if (!ctx) {
      return {
        complete: false,
        reason: '存在验证器但缺少验证上下文（workdir）',
        unverified: verifiers.map((v) => JSON.stringify(v)),
      };
    }
    const outcomes = runVerifiers(verifiers, ctx);
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length > 0) {
      return {
        complete: false,
        reason: `${failed.length} 项验证未通过：${failed.map((f) => f.detail).join('；')}`,
        unverified: failed.map((f) => f.detail),
      };
    }
    return {
      complete: true,
      reason: text ? `目标 "${text}" 的验证器全部通过` : '验证器全部通过',
      unverified: [],
    };
  }

  /* 3) 无 verifier：无法独立验证，结构上待办已清空 */
  return {
    complete: true,
    reason: text ? `目标 "${text}" 的待办已清空（未提供验证器）` : '待办已清空（未提供验证器）',
    unverified: [],
  };
}

// 修改记录：
//   2026-10-03 新增：结构化 verifier（fileExists/fileContains/commandExit0）实际检查文件系统/工具结果；
//              旧文本子串判据降级为 verifyHeuristic（仅提示，不参与 complete 判定）
//   2026-10-04 P1-2：commandExit0 改为取最近一次匹配结果（重试成功后以末次退出码为准）
