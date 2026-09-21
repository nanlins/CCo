/**
 * Subagent —— 大任务拆小，每个拿到的都是干净上下文（s06 模式）。
 *
 * 两种模式（对齐真实 CC）：
 *   Normal：独立 messages[]，全新上下文（默认）
 *   Fork：复用父会话历史作为前缀，API 端 prompt cache 命中（省钱）
 *
 * 成本控制（真实任务教训：6 个子 Agent 产生 80 次工具调用 / 56 次 LLM 调用 / ~194 万 token）：
 *   1. 每个 subagent 独立预算：maxTurns / maxToolCallsPerRun / maxLlmCallsPerRun /
 *      maxRunOutputTokens / 超时（均可经 SUBAGENT_MAX_* 环境变量配置）；
 *   2. 父任务全局聚合预算：单任务 subagent 数量上限（默认 3）+ 工具调用总量 +
 *      输出 token 总量（SUBAGENT_TOTAL_*），超限拒绝再派生；
 *   3. subagent 达到预算时走 agent 的最终报告模式，返回结构化部分结论（不为空）；
 *   4. subagent 输出统一压缩（截断到 4000 字符，只保留摘要与 file:line 证据）。
 */
import path from 'node:path';
import type { Session, ToolContext, ToolDef } from '../types.js';
import { countChars } from '../types.js';
import { Agent, type RunStatus } from '../core/agent.js';
import { HookRegistry } from '../core/hooks.js';
import { ToolRegistry } from '../core/registry.js';
import { Transcript } from '../core/transcript.js';
import { MemoryStore } from '../core/memory.js';
import { bashTool } from './shell.js';
import { fsTools } from './fs.js';
import { normalizeBudgetLimit } from '../config.js';

const depths = new WeakMap<Session, number>();
const MAX_DEPTH = 3;

/** 父任务级 subagent 聚合账本（按父 session 隔离）。 */
interface SubagentLedger {
  count: number;
  toolCalls: number;
  llmCalls: number;
  outputTokens: number;
  /** 因预算/配额耗尽的 subagent 数量（未完成项）。 */
  exhaustedCount: number;
  /** 是否已派发过一次续跑（额度耗尽后最多允许一次）。 */
  retried: boolean;
}
const ledgers = new WeakMap<Session, SubagentLedger>();

/** fork 模式允许复用的父上下文大小上限（超过则强制 fresh context）。 */
const FORK_MAX_CONTEXT_CHARS = 20_000;

/** subagent 输出压缩上限（只返回摘要与 file:line 证据）。 */
const SUBAGENT_OUTPUT_MAX_CHARS = 4000;

/** subagent 返回的统一 envelope。 */
export interface SubagentEnvelope {
  status: RunStatus;
  report: string;
  usage: { llmCalls: number; toolCalls: number; inputTokens: number; outputTokens: number };
  abortedReason: string | null;
  checkpointId: string;
}

function getLedger(session: Session): SubagentLedger {
  let ledger = ledgers.get(session);
  if (!ledger) {
    ledger = { count: 0, toolCalls: 0, llmCalls: 0, outputTokens: 0, exhaustedCount: 0, retried: false };
    ledgers.set(session, ledger);
  }
  return ledger;
}

/** 构造 envelope（report 未截断前先压缩，避免超大输出）。 */
function envelope(
  status: RunStatus,
  report: string,
  checkpointId: string,
  usage: { llmCalls: number; toolCalls: number; inputTokens: number; outputTokens: number },
  abortedReason: string | null,
): SubagentEnvelope {
  return { status, report, usage, abortedReason, checkpointId };
}

/** 默认子代理系统提示（稳定前缀）。 */
const SUBAGENT_SYSTEM =
  'You are a subagent of a coding agent. Do the task, then reply with ONLY a structured report:\n' +
  '## Findings\n- <finding> (evidence: <file:line or command>)\n' +
  '## Result\n<concise answer / changes made / remaining risks>\n' +
  'Every claim must carry evidence. Do not ask questions; make reasonable assumptions. ' +
  'You have a strict cost budget; if it runs out, immediately output what you have as the structured report.';

export function spawnSubagentTool(): ToolDef {
  return {
    schema: {
      name: 'spawn_subagent',
      description:
        '派生一个上下文隔离的子 Agent，返回统一 envelope（status/report/usage/abortedReason/checkpointId）。' +
        '子 Agent 有独立成本预算（turn/LLM 调用/输入输出 token/wall-clock 超时），单任务最多派生有限几个；' +
        '额度耗尽时 status=budget_exhausted/quota_exhausted，可（父仍有 reserve 且确认时）用 confirm_retry=true 续跑一次。' +
        'fork 仅复制稳定 system 前缀与摘要，不复制完整历史；默认 fork=false。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '交给子 Agent 的任务' },
          agent_type: {
            type: 'string',
            enum: ['Explore', 'Code'],
            description: 'Explore = 只读工具；Code = 完整文件工具',
            default: 'Explore',
          },
          fork: {
            type: 'boolean',
            description: 'fork=true 仅复制稳定 system 前缀与摘要（默认 false；上下文较小才允许）',
            default: false,
          },
          confirm_retry: {
            type: 'boolean',
            description: '上一次子 Agent 额度耗尽后，确认续跑一次（仅当父仍有 reserve 且用户确认）',
            default: false,
          },
        },
        required: ['prompt'],
      },
    },
    /* 工具级超时（wall-clock 兜底）；内部另有可配置的 subagentTimeoutMs */
    timeoutMs: 600_000,
    executor: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const prompt = String(args.prompt ?? '');
      if (!prompt.trim()) return 'Error: prompt required';
      const agentType = String(args.agent_type ?? 'Explore') === 'Code' ? 'Code' : 'Explore';
      const fork = args.fork === true;
      const confirmRetry = args.confirm_retry === true;

      const depth = depths.get(ctx.session) ?? 0;
      if (depth >= MAX_DEPTH) {
        return JSON.stringify(
          envelope('error', `subagent recursion depth limit (${MAX_DEPTH})`, '', zeroUsage(), null),
        );
      }

      /* ---- 父任务全局 subagent 预算（数量 + 聚合成本；父保留自己的 reserve） ---- */
      const ledger = getLedger(ctx.session);
      const maxCount = normalizeBudgetLimit(ctx.config.maxSubagentsPerTask, 3);
      const totalToolCallCap = normalizeBudgetLimit(ctx.config.subagentTotalToolCalls, 40);
      const totalTokenCap = normalizeBudgetLimit(ctx.config.subagentTotalOutputTokens, 400_000);

      if (ledger.retried) {
        return JSON.stringify(
          envelope('error', '续跑次数已用尽：额度耗尽后只允许续跑一次，请父任务自行收尾并总结', '', zeroUsage(), null),
        );
      }
      if (ledger.exhaustedCount > 0 && !confirmRetry) {
        return JSON.stringify(
          envelope(
            'error',
            `已有 ${ledger.exhaustedCount} 个子 Agent 额度耗尽；如需续跑必须显式 confirm_retry=true（且父仍有 reserve）`,
            '',
            zeroUsage(),
            null,
          ),
        );
      }
      if (ledger.count >= maxCount) {
        return JSON.stringify(
          envelope(
            'error',
            `subagent 数量预算耗尽（已派生 ${ledger.count}，上限 ${maxCount}），请父任务自行收尾`,
            '',
            zeroUsage(),
            null,
          ),
        );
      }
      if (ledger.toolCalls >= totalToolCallCap || ledger.outputTokens >= totalTokenCap) {
        return JSON.stringify(
          envelope(
            'error',
            `subagent 聚合成本预算耗尽（${ledger.toolCalls} 工具调用 / ${ledger.outputTokens} 输出 token），请父任务自行总结`,
            '',
            zeroUsage(),
            null,
          ),
        );
      }

      const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      /* ---- fork 门控：仅显式 fork 且父上下文较小才复用，且只复制稳定前缀 + 摘要 ---- */
      const parentSummary = ctx.session.sessionMemory ?? '';
      const parentChars = countChars(ctx.session.messages);
      const forkAllowed = fork && parentChars <= FORK_MAX_CONTEXT_CHARS;
      const subSession: Session = {
        id,
        cwd: ctx.session.cwd,
        baseSystem: forkAllowed ? ctx.session.baseSystem : SUBAGENT_SYSTEM,
        /* 关键：不再复制完整 parent.messages；fork 只注入摘要 */
        messages: forkAllowed && parentSummary ? [{ role: 'user', content: `[父会话摘要]\n${parentSummary}` }] : [],
        todos: [],
        startTime: Date.now(),
      };

      const registry = new ToolRegistry();
      if (agentType === 'Explore') {
        for (const t of fsTools()) {
          if (['read_file', 'glob', 'grep', 'list_files'].includes(t.schema.name)) registry.register(t);
        }
      } else {
        registry.registerAll(fsTools());
      }
      registry.register(bashTool());

      /* ---- subagent 独立预算（归一化：0=不限制、负数=禁用、缺省=fallback） ---- */
      const subAgent = new Agent({
        config: ctx.config,
        llm: ctx.llm,
        registry,
        hooks: new HookRegistry(),
        permission: ctx.permission,
        session: subSession,
        transcript: new Transcript(path.join(ctx.session.cwd, '.transcripts'), id),
        memory: new MemoryStore(path.join(ctx.session.cwd, '.memory')),
        ask: ctx.ask,
        log: ctx.log,
        autoMemory: false,
        maxTurns: ctx.config.subagentMaxTurns ?? 12,
        maxToolCallsPerRun: ctx.config.subagentMaxToolCalls ?? 15,
        maxLlmCallsPerRun: ctx.config.subagentMaxLlmCalls ?? 12,
        maxRunOutputTokens: ctx.config.subagentMaxOutputTokens ?? 100_000,
        maxRunInputTokens: ctx.config.subagentMaxInputTokens ?? 200_000,
        maxRunTotalTokens: ctx.config.subagentMaxTotalTokens ?? 250_000,
        workdirOverride: ctx.workdir,
      });

      depths.set(subSession, depth + 1);
      const finalPrompt = forkAllowed
        ? `[Fork 子任务] ${prompt}\n基于上方父会话摘要继续，只输出本任务的结果摘要。`
        : prompt;

      /* wall-clock 超时（SUBAGENT_TIMEOUT_MS，默认 300s） */
      const wallClockMs = ctx.config.subagentTimeoutMs ?? 300_000;
      let summary: string;
      let abortedReason: string | null = null;
      let timer: NodeJS.Timeout | undefined;
      try {
        summary = await Promise.race([
          subAgent.run(finalPrompt),
          new Promise<string>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`subagent wall-clock timeout after ${wallClockMs}ms`)),
              wallClockMs,
            );
          }),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('wall-clock timeout')) abortedReason = msg;
        summary = `## Findings\n- (subagent 异常中断: ${msg})\n## Result\n部分结论缺失，请父任务自行补查。`;
      } finally {
        if (timer) clearTimeout(timer);
      }

      const stats = subAgent.getRunStats();
      const status = subAgent.getRunStatus();

      /* ---- 聚合成本记账 ---- */
      ledger.count += 1;
      ledger.toolCalls += stats.toolCalls;
      ledger.llmCalls += stats.llmCalls;
      ledger.outputTokens += stats.outputTokens;
      if (confirmRetry) ledger.retried = true; // 本次即唯一一次续跑
      if (status === 'budget_exhausted' || status === 'quota_exhausted') {
        ledger.exhaustedCount += 1;
      }

      /* ---- 输出统一压缩：只保留摘要与证据，禁止空结果 ---- */
      if (!summary.trim()) {
        summary =
          '## Findings\n- (subagent 未产生文本结论，可能因预算耗尽)\n## Result\n无可用结果；请父任务基于其他证据判断。';
      }
      if (summary.length > SUBAGENT_OUTPUT_MAX_CHARS) {
        summary = summary.slice(0, SUBAGENT_OUTPUT_MAX_CHARS) + '\n...[subagent 输出过长已截断，仅保留摘要与证据]';
      }

      return JSON.stringify(
        envelope(
          status === 'completed' ? 'completed' : status,
          summary,
          id,
          {
            llmCalls: stats.llmCalls,
            toolCalls: stats.toolCalls,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
          },
          abortedReason,
        ),
      );
    },
  };
}

function zeroUsage(): { llmCalls: number; toolCalls: number; inputTokens: number; outputTokens: number } {
  return { llmCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
}
