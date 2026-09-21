/**
 * 受控 openclaw 审查验收：真实 LLM + 工具预算 12 → 必须输出结构化最终报告。
 *
 * 用法（密钥只通过环境变量传入，绝不写入 .env / 不提交）：
 *   $env:OPENAI_API_KEY='sk-...'; node --import tsx tests/acceptance/openclaw-review.ts
 *
 * 通过标准：最终输出包含「已完成检查 / 未完成检查 / 当前证据 / 风险项」四部分，
 * 且不是未完成的句子（以完整结构收尾）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '..', 'fixtures', 'openclaw-review');

if (!process.env.OPENAI_API_KEY) {
  console.error('SKIP: 需要环境变量 OPENAI_API_KEY（密钥只通过环境变量传入）');
  process.exit(2);
}

/* 受控配置：全部通过 process.env（不写 .env）；已存在的值优先，便于调节预算复测 */
Object.assign(process.env, {
  LLM_PROTOCOL: process.env.LLM_PROTOCOL ?? 'openai',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
  MODEL_ID: process.env.MODEL_ID ?? 'deepseek-v4-flash',
  MOCK: '0',
  PERMISSION_MODE: process.env.PERMISSION_MODE ?? 'auto',
  MAX_TOOL_CALLS_PER_RUN: process.env.MAX_TOOL_CALLS_PER_RUN ?? '12',
  MAX_LLM_CALLS_PER_RUN: process.env.MAX_LLM_CALLS_PER_RUN ?? '16',
  HARNESS_CWD: FIXTURE,
});

const { createHarness } = await import('../../src/main.js');

const PROMPT = [
  '审查这个项目（openclaw-sample）的代码质量与安全问题，重点看 server.js、db.js、auth.js。',
  '用工具读取文件、收集证据（file:line）。合理控制工具调用次数。',
  '完成或工具预算耗尽时，必须输出最终结构化报告，包含且仅包含以下四个小节：',
  '## 已完成检查',
  '## 未完成检查',
  '## 当前证据',
  '## 风险项',
  '证据必须带 file:line；不要输出四个小节之外的探索过程文字。',
].join('\n');

const harness = createHarness();
console.error(`[acceptance] model=${harness.config.model} protocol=${harness.config.llmProtocol} workdir=${FIXTURE}`);

const events: string[] = [];
harness.agent.setOnEvent((e) => {
  if (e.type === 'system') {
    events.push(e.message);
    console.error(`  [sys] ${e.message}`);
  } else if (e.type === 'tool_use') {
    console.error(`  [tool] ${e.name} ${JSON.stringify(e.args).slice(0, 100)}`);
  }
});

const startedAt = Date.now();
let finalText = '';
let failed = false;
try {
  finalText = await harness.agent.run(PROMPT);
} catch (err) {
  failed = true;
  console.error(`[acceptance] run 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

/* 落盘备查 */
const outFile = path.join(HERE, 'openclaw-review-last-output.txt');
fs.writeFileSync(outFile, finalText, 'utf8');

const SECTIONS = ['## 已完成检查', '## 未完成检查', '## 当前证据', '## 风险项'];
const missing = SECTIONS.filter((s) => !finalText.includes(s));
const stats = harness.agent.getRunStats();

console.error('\n===== 验收结果 =====');
console.error(
  `耗时 ${elapsed}s · LLM 调用 ${stats.llmCalls} · 工具调用 ${stats.toolCalls} · 输出 token ${stats.outputTokens}`,
);
console.error(`最终输出 ${finalText.length} 字符，已写入 ${outFile}`);
if (failed) {
  console.error('❌ run 异常退出');
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`❌ 最终输出缺少小节: ${missing.join(', ')}`);
  console.error('--- 最终输出（尾部 800 字符）---');
  console.error(finalText.slice(-800));
  process.exit(1);
}
/* 不得是未完成句子：最后一个小节之后应有实质内容（≥30 字符） */
const lastIdx = Math.max(...SECTIONS.map((s) => finalText.lastIndexOf(s)));
const tail = finalText.slice(lastIdx).trim();
if (tail.length < 40) {
  console.error('❌ 最终报告在未完成处截断');
  process.exit(1);
}
console.error('✅ 最终输出为结构化报告（四部分齐全，非未完成句子）');
harness.close();
process.exit(0);
