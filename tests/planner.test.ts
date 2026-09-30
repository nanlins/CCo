/**
 * planner.ts 单元测试 —— 大任务"先规划再执行"的判定与结构化计划解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPlan, parsePlan, buildPlanPrompt, PLAN_SCHEMA, PLAN_MAX_STEPS_DEFAULT } from '../src/core/planner.js';

test('shouldPlan：autoPlan=false 显式关闭 → 不规划', () => {
  const r = shouldPlan('这是一个非常长的多步骤任务，然后……并且……最后……', false, 160);
  assert.equal(r.plan, false);
});

test('shouldPlan：autoPlan=true 强制规划（输入够长）', () => {
  const input = '创建一个完整的项目并运行其全部测试用例，同时编写说明文档'.padEnd(60, '，并补充');
  const r = shouldPlan(input, true, 160);
  assert.equal(r.plan, true);
});

test('shouldPlan：autoPlan=true 但输入过短 → 不规划', () => {
  const r = shouldPlan('hi', true, 160);
  assert.equal(r.plan, false);
});

test('shouldPlan：启发式——多步骤标记 + 长输入 → 规划', () => {
  const input = '首先创建 a 文件，然后创建 b 文件，最后运行测试。'.padEnd(200, '补充说明');
  const r = shouldPlan(input, undefined, 160);
  assert.equal(r.plan, true);
  assert.ok(r.reason.includes('多步骤') || r.reason.includes('分句'), `reason 应说明原因: ${r.reason}`);
});

test('shouldPlan：启发式——短输入不规划', () => {
  const r = shouldPlan('读取 a.txt', undefined, 160);
  assert.equal(r.plan, false);
});

test('parsePlan：把结构化计划转成 TodoItem（首步 in_progress）', () => {
  const todos = parsePlan(
    {
      steps: [
        { title: '创建文件', verify: '文件存在' },
        { title: '运行', verify: '输出 OK' },
      ],
    },
    8,
  );
  assert.equal(todos.length, 2);
  assert.equal(todos[0].status, 'in_progress');
  assert.equal(todos[0].content, '创建文件');
  assert.equal(todos[0].activeForm, '文件存在');
  assert.equal(todos[1].status, 'pending');
});

test('parsePlan：空/非法结构 → 空数组（优雅降级）', () => {
  assert.deepEqual(parsePlan(undefined, 8), []);
  assert.deepEqual(parsePlan({ steps: 'not-array' }, 8), []);
  assert.deepEqual(parsePlan({ steps: [{ title: '  ' }] }, 8), []);
});

test('parsePlan：超过 maxSteps 截断', () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({ title: `step ${i}` }));
  const todos = parsePlan({ steps }, 8);
  assert.equal(todos.length, 8);
});

test('buildPlanPrompt：含关键约束', () => {
  const p = buildPlanPrompt();
  assert.ok(p.includes('执行顺序'), '应强调顺序');
  assert.ok(p.includes('完成判据'), '应要求完成判据');
});

test('PLAN_SCHEMA：结构完整且步骤上限合理', () => {
  assert.equal(PLAN_SCHEMA.type, 'object');
  assert.equal(PLAN_MAX_STEPS_DEFAULT, 8);
});
