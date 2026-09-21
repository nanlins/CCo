/**
 * 受控 nanoclaw 源码研究验收：真实 DeepSeek v4 flash + 研究任务硬预算，必须产出 Q1-Q4 结构化答案。
 *
 * 用法（密钥只通过环境变量传入，绝不写入 .env / 不提交）：
 *   $env:OPENAI_API_KEY='sk-...'; node --import tsx tests/acceptance/nanoclaw-review.ts
 *
 * 通过标准（对齐原任务判定标准）：
 *   1. 最终报告出现 Q1/Q2/Q3/Q4 四个答案且非空、引用源码文件作证据；
 *   2. 证据文件覆盖 architecture.md / index.ts / router.ts / session-manager.ts
 *      / delivery.ts / container-runner.ts / poll-loop.ts / providers/claude.ts；
 *   3. 运行约束：read_file >= 6、bash <= 3、write_file == 0、工具调用 <= 30、
 *      输入 token <= 120000、未触发 budgetHit；
 *   4. 无「未阅读源码正文 / 无法得出结论」占位结论；
 *   5. Q4 覆盖 9 个能力方向中至少 7 个。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NANOCLAW =
  process.env.NANOCLAW_PATH ??
  'D:/gitcode/识++练/比特-项目/综合实战 手搓 OpenClaw/nanoclaw';

if (!process.env.OPENAI_API_KEY) {
  console.error('SKIP: 需要环境变量 OPENAI_API_KEY（DeepSeek v4 flash 端点密钥，只通过环境变量传入）');
  process.exit(2);
}

if (!fs.existsSync(NANOCLAW)) {
  console.error(`SKIP: nanoclaw 项目不存在: ${NANOCLAW}`);
  process.exit(2);
}

/* 受控配置：研究任务硬预算 + DeepSeek v4 flash（可被 shell 环境变量覆盖） */
Object.assign(process.env, {
  LLM_PROTOCOL: process.env.LLM_PROTOCOL ?? 'openai',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
  MODEL_ID: process.env.MODEL_ID ?? 'deepseek-v4-flash',
  MOCK: '0',
  PERMISSION_MODE: process.env.PERMISSION_MODE ?? 'auto',
  RESEARCH_MODE: '1',
  READ_FILE_LIMIT: process.env.READ_FILE_LIMIT ?? '18',
  BASH_LIMIT: process.env.BASH_LIMIT ?? '3',
  WRITE_FILE_LIMIT: process.env.WRITE_FILE_LIMIT ?? '0',
  MAX_TOOL_CALLS_PER_RUN: process.env.MAX_TOOL_CALLS_PER_RUN ?? '30',
  MAX_RUN_INPUT_TOKENS: process.env.MAX_RUN_INPUT_TOKENS ?? '120000',
  MAX_LLM_CALLS_PER_RUN: process.env.MAX_LLM_CALLS_PER_RUN ?? '15',
  HARNESS_CWD: NANOCLAW,
});

const { createHarness } = await import('../../src/main.js');

const PROMPT = [
  '这是对 nanoclaw 项目（一个宿主编排器 + 容器执行器的 AI Agent 网关）的源码研究任务。',
  '请只读地阅读源码并回答以下四个问题，每个答案必须引用 nanoclaw 源码文件与行号作为证据（file:line）。',
  '',
  'Q1：这个项目搭建的原理是什么？必须回答“为什么这样设计”，至少包含：宿主编排器 + 容器执行器双层进程、消息驱动持久化、双 SQLite 作为唯一跨进程 IO、outbox/ack 机制、单写者原则、调度复用消息表。',
  '',
  'Q2：它的架构是什么？必须给出分层结构和模块职责，至少包含：platform/channel adapter、router 与 session mapping、宿主导编排、容器内 agent-runner、provider 适配层、SQLite 存储层，并说明每层对应源码文件。',
  '',
  'Q3：它的底层运行逻辑是什么？必须完整描述一条消息从进入到最终输出的链路：平台事件 → channel adapter → 路由 → messages_in → wakeContainer → 容器轮询 → processing_ack → 宿主同步状态 → 容器执行 → outbound.db 输出 → 宿主投递，同时覆盖 heartbeat/stale 检测、重试与恢复、<message to="..."> 输出协议、定时调度。',
  '',
  'Q4：如果要开发这样一个项目，应该掌握和具备哪些知识与技能？必须是一份可执行的能力清单，至少覆盖：消息队列与可靠投递、Docker/进程沙箱、SQLite 与持久化、Agent loop 与工具协议、LLM API/流式/function calling/token 预算、Prompt 注入与权限安全、TypeScript/Node 工程化、可观测性与故障恢复、CLI/channel 产品体验。',
  '',
  '运行约束：只读研究，禁止写文件、禁止用 bash 探测目录；目录探索用 list_files/glob，源码阅读用 read_file（承重文件：docs/architecture.md、src/index.ts、src/router.ts、src/session-manager.ts、src/delivery.ts、src/container-runner.ts、container/agent-runner/src/poll-loop.ts、src/providers/claude.ts）。',
  '最终报告用「## Q1」到「## Q4」四个小节，逐问给出答案，每个答案必须引用证据文件（file:line）；不得出现“未阅读源码正文”“无法得出结论”等占位结论。',
].join('\n');

const harness = createHarness();
console.error(`[acceptance] model=${harness.config.model} protocol=${harness.config.llmProtocol}`);
console.error(`[acceptance] researchMode=${harness.config.researchMode} workdir=${NANOCLAW}`);

const toolUses: { name: string; path?: string }[] = [];
harness.agent.setOnEvent((e) => {
  if (e.type === 'tool_use') {
    const args = e.args as Record<string, unknown>;
    const p = (args.path ?? args.file_path ?? args.filePath) as string | undefined;
    toolUses.push({ name: e.name, path: p });
    console.error(`  [tool] ${e.name} ${p ?? ''}`);
  } else if (e.type === 'system') {
    console.error(`  [sys] ${e.message}`);
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

const outFile = path.join(HERE, 'nanoclaw-review-last-output.txt');
fs.writeFileSync(outFile, finalText, 'utf8');
const stats = harness.agent.getRunStats();
const status = harness.agent.getRunStatus();

/* ---- 判定 ---- */
const errors: string[] = [];
const report = (ok: boolean, msg: string): void => {
  console.error(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) errors.push(msg);
};

/* 运行约束 */
const readCount = toolUses.filter((t) => t.name === 'read_file').length;
const bashCount = toolUses.filter((t) => t.name === 'bash' || t.name === 'bg_run').length;
const writeCount = toolUses.filter((t) => ['write_file', 'edit_file', 'delete_file'].includes(t.name)).length;
report(readCount >= 6, `read_file ${readCount} 次（要求 >= 6）`);
report(bashCount <= 3, `bash ${bashCount} 次（要求 <= 3）`);
report(writeCount === 0, `write_file ${writeCount} 次（要求 == 0）`);
report(stats.toolCalls <= 30, `总工具调用 ${stats.toolCalls} 次（要求 <= 30）`);
report(stats.inputTokens <= 120_000, `输入 token ${stats.inputTokens}（要求 <= 120000）`);
report(status === 'completed' && !failed, `未触发 budgetHit（status=${status}）`);

/* Q1-Q4 四问齐全且非空 */
for (const q of ['## Q1', '## Q2', '## Q3', '## Q4']) {
  const idx = finalText.indexOf(q);
  report(idx >= 0, `${q} 出现`);
  if (idx >= 0) {
    const body = finalText.slice(idx + q.length, idx + q.length + 400).trim();
    report(body.length >= 40, `${q} 答案非空（${body.length} 字符）`);
  }
}

/* 证据文件覆盖 */
const REQUIRED = [
  'architecture.md',
  'index.ts',
  'router.ts',
  'session-manager.ts',
  'delivery.ts',
  'container-runner.ts',
  'poll-loop.ts',
  'claude.ts',
];
const readPaths = toolUses.filter((t) => t.name === 'read_file').map((t) => t.path ?? '');
for (const file of REQUIRED) {
  const inRead = readPaths.some((p) => p.includes(file));
  const inText = finalText.includes(file);
  report(inRead || inText, `证据覆盖 ${file}（read=${inRead}, text=${inText}）`);
}

/* 无占位结论 */
for (const ph of ['未阅读源码正文', '无法得出结论', '无法确定']) {
  report(!finalText.includes(ph), `无占位结论「${ph}」`);
}

/* Q4 覆盖至少 7/9 能力方向 */
const DIRECTIONS: [string, RegExp][] = [
  ['消息队列与可靠投递', /消息队列|可靠投递|outbox|ack/i],
  ['Docker/进程沙箱', /docker|沙箱|容器/i],
  ['SQLite 与持久化', /sqlite|持久化/i],
  ['Agent loop 与工具协议', /agent\s*loop|工具协议|tool\s*calling|工具调用/i],
  ['LLM API/流式/function calling/token 预算', /llm|流式|function\s*calling|token|预算/i],
  ['Prompt 注入与权限安全', /prompt\s*注入|权限|安全/i],
  ['TypeScript/Node 工程化', /typescript|node|工程化/i],
  ['可观测性与故障恢复', /可观测|日志|监控|故障恢复|恢复/i],
  ['CLI/channel 产品体验', /cli|channel|产品体验/i],
];
const q4Idx = finalText.lastIndexOf('## Q4');
const q4Text = q4Idx >= 0 ? finalText.slice(q4Idx) : '';
const covered = DIRECTIONS.filter(([, rx]) => rx.test(q4Text)).map(([n]) => n);
report(covered.length >= 7, `Q4 覆盖 ${covered.length}/9 能力方向${covered.length < 9 ? `（缺：${DIRECTIONS.filter(([, r]) => !r.test(q4Text)).map(([n]) => n).join('、')}）` : ''}`);

console.error('\n===== 验收结果 =====');
console.error(
  `耗时 ${elapsed}s · LLM 调用 ${stats.llmCalls} · 工具调用 ${stats.toolCalls} · 输入 ${stats.inputTokens} · 输出 ${stats.outputTokens} token · status=${status}`,
);
console.error(`最终输出 ${finalText.length} 字符，已写入 ${outFile}`);

if (errors.length > 0) {
  console.error(`\n❌ 未通过（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('--- 最终输出（尾部 1200 字符）---');
  console.error(finalText.slice(-1200));
  harness.close();
  process.exit(1);
}
console.error('✅ 全部通过');
harness.close();
process.exit(0);
