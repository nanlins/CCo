import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, formatReport, type EvalContext, type EvalScenario } from './eval/scenarios.js';

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    workdir: '.',
    logs: [],
    messagesCount: 0,
    usage: { inputTokens: 100, outputTokens: 50, calls: 3 },
    durationMs: 10_000,
    finalText: '',
    ...overrides,
  };
}

test('buildReport: 全部通过时计算完成率与工具准确率', () => {
  const scenarios: EvalScenario[] = [
    { id: 'a', name: 'a', prompt: 'x', requiresTool: ['read_file'], check: async () => null },
    { id: 'b', name: 'b', prompt: 'y', check: async () => null },
  ];
  const results = [
    { scenario: scenarios[0], ok: true, reason: null },
    { scenario: scenarios[1], ok: true, reason: null },
  ];
  const ctx = makeCtx({
    logs: [{ tool: 'read_file', args: {}, output: '' }],
  });
  const r = buildReport(scenarios, results, ctx);
  assert.equal(r.total, 2);
  assert.equal(r.passed, 2);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(r.toolAccuracy, { correct: 1, total: 1 });
  assert.equal(r.totalInputTokens, 100);
});

test('buildReport: 部分失败时记录失败原因，工具缺失扣准确率', () => {
  const scenarios: EvalScenario[] = [
    { id: 'a', name: 'a', prompt: 'x', requiresTool: ['write_file'], check: async () => null },
    { id: 'b', name: 'b', prompt: 'y', check: async () => 'file missing' },
  ];
  const results = [
    { scenario: scenarios[0], ok: true, reason: null },
    { scenario: scenarios[1], ok: false, reason: 'file missing' },
  ];
  const ctx = makeCtx({ logs: [] });
  const r = buildReport(scenarios, results, ctx);
  assert.equal(r.passed, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, 'b');
  assert.equal(r.failed[0].reason, 'file missing');
  assert.deepEqual(r.toolAccuracy, { correct: 0, total: 1 });
});

test('formatReport: 输出包含所有指标字段', () => {
  const scenarios: EvalScenario[] = [
    { id: 'a', name: 'a', prompt: 'x', check: async () => null },
    { id: 'b', name: 'b', prompt: 'y', check: async () => 'boom' },
  ];
  const results = [
    { scenario: scenarios[0], ok: true, reason: null },
    { scenario: scenarios[1], ok: false, reason: 'boom' },
  ];
  const report = formatReport(buildReport(scenarios, results, makeCtx()));
  assert.ok(report.includes('任务完成率: 50%'));
  assert.ok(report.includes('工具调用准确率'));
  assert.ok(report.includes('总耗时'));
  assert.ok(report.includes('Token 用量'));
  assert.ok(report.includes('[b] boom'));
});

test('内置场景：check 逻辑可在无 LLM 环境下独立验证', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-evalcheck-'));
  const { DEFAULT_SCENARIOS } = await import('./eval/scenarios.js');
  const ctx = makeCtx({ workdir });

  // sc-01: 文件不存在 → 失败原因
  const r1 = await DEFAULT_SCENARIOS[0].check(workdir, ctx);
  assert.ok(r1?.includes('不存在'));

  // sc-01: 写入正确内容 → 通过
  fs.writeFileSync(path.join(workdir, 'report.txt'), 'Eval scenario one');
  const r2 = await DEFAULT_SCENARIOS[0].check(workdir, ctx);
  assert.equal(r2, null);

  fs.rmSync(workdir, { recursive: true, force: true });
});

test('sc-06 多文档分析：check 逻辑离线验证（glob 命中 / 完整阅读 / 结论覆盖）', async () => {
  const { DEFAULT_SCENARIOS } = await import('./eval/scenarios.js');
  const sc = DEFAULT_SCENARIOS.find((s) => s.id === 'sc-06');
  assert.ok(sc, 'sc-06 场景应存在');

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-evalcheck-'));
  sc!.setup?.(workdir);

  const readAll = ['alpha', 'beta', 'gamma'].map((n) => ({
    tool: 'read_file',
    args: { path: `docs/${n}.md` },
    output: 'x',
  }));

  // 全部读到 + 结论覆盖三个代号 → 通过
  const ok = await sc!.check(
    workdir,
    makeCtx({ workdir, logs: readAll, finalText: 'ALPHA-KEY-001 / BETA-KEY-002 / GAMMA-KEY-003' }),
  );
  assert.equal(ok, null);

  // 漏读 gamma → 失败
  const missRead = await sc!.check(
    workdir,
    makeCtx({ workdir, logs: readAll.slice(0, 2), finalText: 'ALPHA-KEY-001 BETA-KEY-002 GAMMA-KEY-003' }),
  );
  assert.ok(missRead?.includes('gamma'));

  // 结论缺位于文档结尾的 GAMMA 代号 → 失败（只读开头的回归）
  const missKey = await sc!.check(
    workdir,
    makeCtx({ workdir, logs: readAll, finalText: 'ALPHA-KEY-001 BETA-KEY-002' }),
  );
  assert.ok(missKey?.includes('GAMMA-KEY-003'));

  // glob '**' 未命中任何文件 → 失败（零层目录回归）
  const globFail = await sc!.check(
    workdir,
    makeCtx({
      workdir,
      logs: [...readAll, { tool: 'glob', args: { pattern: 'docs/**/*.md' }, output: '（无匹配）' }],
      finalText: 'ALPHA-KEY-001 BETA-KEY-002 GAMMA-KEY-003',
    }),
  );
  assert.ok(globFail?.includes('零层目录'));

  fs.rmSync(workdir, { recursive: true, force: true });
});
