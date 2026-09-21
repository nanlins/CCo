/**
 * Agent 评估运行器 —— 依次运行评估场景，采集指标并输出报告。
 *
 * 用法：
 *   npm run eval                 # 真实 LLM（读取 .env）
 *   npm run eval -- --mock       # MOCK 模式（演示框架，不评估真实能力）
 *
 * 每个场景：
 *   setup（可选）→ agent.run(prompt) → check(workdir)
 * 指标：任务完成率 / 工具调用准确率 / 总耗时 / token 用量。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { AnthropicLlm } from '../../src/llm/client.js';
import { MockLlm } from '../../src/llm/mock.js';
import { Agent } from '../../src/core/agent.js';
import { HookRegistry } from '../../src/core/hooks.js';
import { PermissionGate } from '../../src/core/permission.js';
import { ToolRegistry } from '../../src/core/registry.js';
import { Transcript } from '../../src/core/transcript.js';
import { MemoryStore } from '../../src/core/memory.js';
import { standardTools } from '../../src/tools/index.js';
import { TaskSystem } from '../../src/tools/tasks.js';
import { BackgroundSystem } from '../../src/tools/background.js';
import { CronScheduler } from '../../src/tools/cron.js';
import { MessageBus } from '../../src/tools/teams.js';
import { WorktreeManager } from '../../src/tools/worktree.js';
import { McpPool } from '../../src/tools/mcp.js';
import { lastText, type Session } from '../../src/types.js';
import { DEFAULT_SCENARIOS, buildReport, formatReport, type EvalContext, type EvalScenario } from './scenarios.js';

interface EvalLog {
  tool: string;
  args: Record<string, unknown>;
  output: string;
}

async function runScenario(
  scenario: EvalScenario,
  opts: { mock: boolean },
): Promise<{ ok: boolean; reason: string | null; ctx: EvalContext }> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-eval-'));
  const config = loadConfig({
    workspaceDir: workdir,
    mock: opts.mock,
    permissionMode: 'auto',
  });

  const llm = opts.mock ? new MockLlm({ script: [] }) : new AnthropicLlm(config);
  const session: Session = {
    id: `eval_${scenario.id}`,
    cwd: workdir,
    baseSystem:
      'You are a coding agent. Use tools to solve tasks efficiently. ' +
      "Act, don't explain unless asked. Plan with TodoWrite for multi-step work. " +
      'Never claim a task completed until you verified it.',
    messages: [],
    todos: [],
    startTime: Date.now(),
  };

  const permission = new PermissionGate({ mode: 'auto', ask: async () => false });
  const registry = new ToolRegistry();
  const tasks = new TaskSystem(path.join(workdir, '.tasks'));
  const background = new BackgroundSystem({ cwd: workdir });
  const cron = new CronScheduler({ workdir });
  const bus = new MessageBus(workdir);
  const worktrees = new WorktreeManager(workdir);
  const mcp = new McpPool(workdir);
  registry.registerAll(
    standardTools({ skills: undefined, tasks, background, cron, bus, worktrees, mcp, ownerName: 'lead' }),
  );

  const logs: EvalLog[] = [];
  const agent = new Agent({
    config,
    llm,
    registry,
    hooks: new HookRegistry(),
    permission,
    session,
    transcript: new Transcript(path.join(workdir, '.transcripts'), session.id),
    memory: new MemoryStore(path.join(workdir, '.memory')),
    ask: async () => false,
    log: () => {},
    autoMemory: false,
    maxTurns: 40,
  });
  agent.setOnEvent((e) => {
    if (e.type === 'tool_use') logs.push({ tool: e.name, args: e.args, output: '' });
    if (e.type === 'tool_result') {
      const last = logs[logs.length - 1];
      if (last && last.tool) last.output = e.output;
    }
    /* 规划事件作为轨迹标记（__plan__），用于"先规划再执行"断言 */
    if (e.type === 'plan') {
      logs.push({ tool: '__plan__', args: { steps: e.steps.map((s) => s.content) }, output: e.reason });
    }
  });

  scenario.setup?.(workdir);

  const start = Date.now();
  try {
    await agent.run(scenario.prompt);
  } catch (err) {
    return {
      ok: false,
      reason: `运行异常: ${err instanceof Error ? err.message : String(err)}`,
      ctx: makeCtx(workdir, logs, session, agent, 0),
    };
  }
  const durationMs = Date.now() - start;

  let reason: string | null;
  try {
    reason = await scenario.check(workdir, makeCtx(workdir, logs, session, agent, durationMs));
  } catch (err) {
    reason = `检查器异常: ${err instanceof Error ? err.message : String(err)}`;
  }

  fs.rmSync(workdir, { recursive: true, force: true });
  return { ok: reason === null, reason, ctx: makeCtx(workdir, logs, session, agent, durationMs) };
}

function makeCtx(workdir: string, logs: EvalLog[], session: Session, agent: Agent, durationMs: number): EvalContext {
  const usage = agent.usage.summary();
  return {
    workdir,
    logs,
    messagesCount: session.messages.length,
    usage: { inputTokens: usage.totalInput, outputTokens: usage.totalOutput, calls: usage.calls },
    durationMs,
    finalText: lastText(session.messages),
  };
}

export async function runEval(opts: { mock: boolean; scenarios?: EvalScenario[] }): Promise<string> {
  const scenarios = opts.scenarios ?? DEFAULT_SCENARIOS;
  const results = [];
  const allLogs: EvalLog[] = [];
  const startAll = Date.now();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCalls = 0;

  for (const s of scenarios) {
    process.stderr.write(`[eval] 运行场景 ${s.id} (${s.name}) ...\n`);
    const r = await runScenario(s, opts);
    results.push({ scenario: s, ok: r.ok, reason: r.reason });
    allLogs.push(...r.ctx.logs);
    totalInput += r.ctx.usage.inputTokens;
    totalOutput += r.ctx.usage.outputTokens;
    totalCalls += r.ctx.usage.calls;
    process.stderr.write(`[eval] ${s.id} => ${r.ok ? 'PASS' : `FAIL: ${r.reason}`}\n`);
  }

  const ctx: EvalContext = {
    workdir: '.',
    logs: allLogs,
    messagesCount: 0,
    usage: { inputTokens: totalInput, outputTokens: totalOutput, calls: totalCalls },
    durationMs: Date.now() - startAll,
  };
  const report = buildReport(scenarios, results, ctx);
  return formatReport(report);
}

/* ---------- CLI 入口 ---------- */

const isMain = process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('eval.ts');
if (isMain) {
  const mock = process.argv.includes('--mock');
  runEval({ mock })
    .then((report) => {
      console.log(report);
      const failed = (report.match(/失败: \d+/) ?? ['失败: 0'])[0];
      const n = Number(failed.replace(/\D/g, ''));
      process.exitCode = n > 0 ? 1 : 0;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
