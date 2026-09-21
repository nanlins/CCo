/**
 * 受控实测：小锤给大任务时，是"先规划再执行"还是"直接上手"。
 *
 * 用法：
 *   node --import tsx tests/acceptance/plan-execute.ts
 * 会读取 .env / 环境变量的模型配置（真实 LLM），在临时工作区执行一个多步骤大任务，
 * 打印完整轨迹（规划步骤 + 工具调用顺序），并判定"是否先规划再执行"。
 *
 * 配置（可覆盖）：
 *   AUTO_PLAN=1        强制规划（默认启发式：长输入+多步骤标记才规划）
 *   NANOCLAW 无；工作区为临时目录
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 临时工作区：大任务产出文件不污染项目 */
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plan-'));

Object.assign(process.env, {
  MOCK: process.env.MOCK ?? '0',
  PERMISSION_MODE: process.env.PERMISSION_MODE ?? 'auto',
  HARNESS_CWD: workdir,
  /* 默认启发式规划；设 AUTO_PLAN=1 可强制 */
  ...(process.env.AUTO_PLAN === undefined ? {} : { AUTO_PLAN: process.env.AUTO_PLAN }),
});

const { createHarness } = await import('../../src/main.js');

const BIG_TASK = [
  '请从零搭建一个最小 Node 工具库，按顺序完成以下全部步骤：',
  '1. 创建 package.json（name=mini-lib, type=commonjs）；',
  '2. 创建 lib/math.js，导出 add(a,b) 和 sub(a,b)；',
  '3. 创建 test/math.test.js，用断言验证 add(1,2)===3 且 sub(5,3)===2，通过则打印 ALL_TESTS_PASSED；',
  '4. 运行 node test/math.test.js，确认输出 ALL_TESTS_PASSED；',
  '5. 写一份 SUMMARY.md，逐条说明每个文件的作用与验证结果。',
].join('\n');

const harness = createHarness();
console.error(
  `[plan-execute] model=${harness.config.model} protocol=${harness.config.llmProtocol} autoPlan=${harness.config.autoPlan ?? 'heuristic'} workdir=${workdir}`,
);

if (harness.config.mock) {
  console.error('SKIP: 当前为 MOCK 模式（无模型 key），无法实测真实"先规划再执行"行为');
  harness.close();
  fs.rmSync(workdir, { recursive: true, force: true });
  process.exit(2);
}

/* 轨迹采集：按时间顺序记录 plan / tool_use */
type Trace = { kind: 'plan' | 'tool'; label: string };
const trace: Trace[] = [];
harness.agent.setOnEvent((e) => {
  if (e.type === 'plan') {
    for (const s of e.steps) trace.push({ kind: 'plan', label: `[${s.status}] ${s.content}` });
  } else if (e.type === 'tool_use') {
    const args = e.args as Record<string, unknown>;
    const brief = JSON.stringify(args).slice(0, 80);
    trace.push({ kind: 'tool', label: `${e.name} ${brief}` });
  }
});

const startedAt = Date.now();
let finalText = '';
try {
  finalText = await harness.agent.run(BIG_TASK);
} catch (err) {
  console.error(`[plan-execute] run 异常: ${err instanceof Error ? err.message : String(err)}`);
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const stats = harness.agent.getRunStats();

/* 判定：第一个动作工具是否出现在规划之后 */
const ACTION_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'bg_run', 'delete_file']);
const firstPlanIdx = trace.findIndex((t) => t.kind === 'plan');
const firstActionIdx = trace.findIndex((t) => t.kind === 'tool' && ACTION_TOOLS.has(t.label.split(' ')[0]));

console.error('\n===== 完整轨迹（按时间顺序） =====');
if (trace.length === 0) console.error('（无轨迹事件）');
for (const t of trace) console.error(`  ${t.kind === 'plan' ? '🧭 计划' : '🔧 工具'}  ${t.label}`);

console.error('\n===== 实测判定 =====');
console.error(`耗时 ${elapsed}s · LLM 调用 ${stats.llmCalls} · 工具调用 ${stats.toolCalls}`);
const verdict = (() => {
  if (firstPlanIdx === -1) return '❌ 未规划：直接上手就做（未触发规划阶段）';
  if (firstActionIdx === -1) return '⚠️  有规划但无动作工具（任务可能只产出文本）';
  if (firstPlanIdx < firstActionIdx) return '✅ 先规划再执行：先产出计划，再按计划动手';
  return '❌ 先动手后规划：动作工具出现在计划之前';
})();
console.error(verdict);

const outFile = path.join(HERE, 'plan-execute-last-output.txt');
fs.writeFileSync(
  outFile,
  `verdict: ${verdict}\n\n=== 轨迹 ===\n${trace.map((t) => `${t.kind === 'plan' ? '[计划]' : '[工具]'} ${t.label}`).join('\n')}\n\n=== 最终输出 ===\n${finalText}\n`,
  'utf8',
);
console.error(`输出已写入 ${outFile}`);

harness.close();
fs.rmSync(workdir, { recursive: true, force: true });
process.exit(firstPlanIdx !== -1 && firstActionIdx !== -1 && firstPlanIdx < firstActionIdx ? 0 : 1);
