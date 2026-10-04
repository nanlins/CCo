/**
 * 工作流运行时 + 目标裁判 回归测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runWorkflow } from '../src/core/workflowRuntime.js';
import { evaluateGoal, verifyHeuristic } from '../src/core/goalJudge.js';

test('runWorkflow: 顺序执行，依赖步骤在前', async () => {
  const order: string[] = [];
  const r = await runWorkflow(
    [
      { id: 'a', title: 'A', run: async () => void order.push('a') },
      { id: 'b', title: 'B', dependsOn: ['a'], run: async () => void order.push('b') },
      { id: 'c', title: 'C', dependsOn: ['a'], run: async () => void order.push('c') },
    ],
    {},
    { parallel: true },
  );
  assert.equal(r.ok, true);
  assert.equal(order[0], 'a');
  assert.ok(order.includes('b') && order.includes('c'));
});

test('runWorkflow: 单步失败不中断，收集失败', async () => {
  const r = await runWorkflow(
    [
      { id: 'a', title: 'A', run: async () => void 0 },
      { id: 'b', title: 'B', run: async () => Promise.reject(new Error('boom')) },
      { id: 'c', title: 'C', run: async () => void 0 },
    ],
    {},
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.completed.sort(), ['a', 'c']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, 'b');
});

test('runWorkflow: journal 持久化 + 可恢复（跳过已完成步骤）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wf-'));
  const journal = path.join(dir, 'journal.json');
  const runs: string[] = [];
  const stepA = { id: 'a', title: 'A', run: async () => void runs.push('a') };
  const stepB = { id: 'b', title: 'B', run: async () => void runs.push('b') };
  await runWorkflow([stepA, stepB], {}, { journalPath: journal });
  assert.deepEqual(runs.sort(), ['a', 'b']);

  runs.length = 0;
  const r2 = await runWorkflow([stepA, stepB], {}, { journalPath: journal });
  assert.deepEqual(runs, [], '已完成的步骤不应重复执行');
  assert.equal(r2.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runWorkflow: 多步一步失败 → 修复后 resume 只重跑失败步', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wf2-'));
  const journal = path.join(dir, 'journal.json');
  const ran: string[] = [];
  const step = (id: string, fail: boolean) => ({
    id,
    title: id,
    run: async () => {
      ran.push(id);
      if (fail) throw new Error('boom');
    },
  });
  const r1 = await runWorkflow([step('a', false), step('b', true), step('c', false)], {}, { journalPath: journal });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.completed.sort(), ['a', 'c']);
  assert.deepEqual(
    r1.failed.map((f) => f.id),
    ['b'],
  );

  ran.length = 0;
  const r2 = await runWorkflow([step('a', false), step('b', false), step('c', false)], {}, { journalPath: journal });
  assert.equal(r2.ok, true);
  assert.deepEqual(ran, ['b'], '仅重跑失败的 b，a/c 从 journal 跳过');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateGoal: 未完成待办 → 未完成', () => {
  const j = evaluateGoal({
    goal: '写一个函数',
    todos: [
      { content: '写函数', status: 'in_progress', activeForm: '' },
      { content: '写测试', status: 'pending', activeForm: '' },
    ],
  });
  assert.equal(j.complete, false);
  assert.match(j.reason, /待办未完成/);
});

test('evaluateGoal: 判据未证实 → 未完成并列出待验证项', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gj-'));
  /* 负向：模型声称完成，但 verifier 检查的文件不存在 → complete=false */
  const j = evaluateGoal({
    goal: '写一个函数',
    todos: [{ content: '写函数', status: 'completed', activeForm: '函数可运行' }],
    verifiers: [{ kind: 'fileExists', path: 'solution.js' }],
    ctx: { workdir: dir },
  });
  assert.equal(j.complete, false);
  assert.equal(j.unverified.length, 1);
  assert.match(j.reason, /验证未通过/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateGoal: verifier 命中 → 完成', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gj-'));
  fs.writeFileSync(path.join(dir, 'solution.js'), 'function add(a, b) { return a + b; }\n');
  const j = evaluateGoal({
    goal: '写一个函数',
    todos: [{ content: '写函数', status: 'completed', activeForm: '' }],
    verifiers: [
      { kind: 'fileExists', path: 'solution.js' },
      { kind: 'fileContains', path: 'solution.js', text: 'function add' },
    ],
    ctx: { workdir: dir },
  });
  assert.equal(j.complete, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateGoal: commandExit0 非零退出 → 未完成', () => {
  const j = evaluateGoal({
    goal: '跑测试',
    todos: [{ content: '跑测试', status: 'completed', activeForm: '' }],
    verifiers: [{ kind: 'commandExit0', command: 'npm test' }],
    ctx: { workdir: process.cwd(), commandResults: [{ command: 'npm test', exitCode: 1 }] },
  });
  assert.equal(j.complete, false);
  assert.match(j.unverified[0], /退出码 1/);
});

test('verifyHeuristic: 文本判据仅提示（不参与 complete）', () => {
  const unverified = verifyHeuristic([{ content: 'x', status: 'completed', activeForm: '文件已生成' }], '我写完了');
  assert.deepEqual(unverified, ['文件已生成']);
});
