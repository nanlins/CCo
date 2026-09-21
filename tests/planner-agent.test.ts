/**
 * 规划阶段 agent 集成测试 —— 大任务先规划再执行，规划结果进 session.todos。
 * 全程 MockLlm 离线运行：脚本第一轮返回 plan_steps 结构化计划，后续轮执行工具。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

test('autoPlan=true：run 前先规划，步骤进 session.todos，发出 plan 事件', async () => {
  const script: ScriptedTurn[] = [
    {
      blocks: [
        {
          type: 'tool_use',
          name: 'plan_steps',
          input: {
            steps: [
              { title: '创建 a.txt', verify: 'a.txt 存在' },
              { title: '读取验证', verify: '读到内容' },
            ],
          },
        },
      ],
    },
    { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'a.txt', content: 'hello' } }] },
    { blocks: [{ type: 'text', text: '完成' }] },
  ];
  const h = makeHarness({ script, configOverrides: { autoPlan: true } });
  try {
    const planEvents: { steps: string[]; reason: string }[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'plan') planEvents.push({ steps: e.steps.map((s) => s.content), reason: e.reason });
    });

    await h.agent.run('这是一个多步骤的完整任务，需要先创建文件，然后再读取文件验证内容，最后汇总说明执行结果');

    assert.equal(h.session.todos.length, 2, '规划步骤应写入 session.todos');
    assert.equal(h.session.todos[0].status, 'in_progress');
    assert.equal(h.session.todos[0].content, '创建 a.txt');
    assert.equal(planEvents.length, 1, '应发出 plan 事件');
    assert.deepEqual(planEvents[0].steps, ['创建 a.txt', '读取验证']);
  } finally {
    h.cleanup();
  }
});

test('autoPlan=false：不规划，直接执行', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'b.txt', content: 'x' } }] },
    { blocks: [{ type: 'text', text: 'done' }] },
  ];
  const h = makeHarness({ script, configOverrides: { autoPlan: false } });
  try {
    let planCount = 0;
    h.agent.setOnEvent((e) => {
      if (e.type === 'plan') planCount += 1;
    });
    await h.agent.run('一个很长很长很长的多步骤任务'.padEnd(300, '，还有更多'));
    assert.equal(planCount, 0, 'autoPlan=false 不应规划');
    assert.equal(h.session.todos.length, 0, '不应有规划产生的 todos');
  } finally {
    h.cleanup();
  }
});

test('规划失败：结构化输出为空 → 优雅降级，任务照常执行', async () => {
  /* 第一轮规划阶段返回纯文本（无 plan_steps），structured 为空 */
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'text', text: '（模型没有给出计划）' }] },
    { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'c.txt', content: 'x' } }] },
    { blocks: [{ type: 'text', text: 'done' }] },
  ];
  const h = makeHarness({ script, configOverrides: { autoPlan: true } });
  try {
    const sysEvents: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') sysEvents.push(e.message);
    });
    await h.agent.run('这是一个多步骤的完整任务，需要先创建文件，然后再读取文件验证内容，最后汇总说明执行结果');
    assert.equal(h.session.todos.length, 0, '规划失败不应有 todos');
    assert.ok(
      sysEvents.some((m) => m.includes('规划结果为空') || m.includes('规划失败')),
      `应有降级提示: ${sysEvents.join('|')}`,
    );
  } finally {
    h.cleanup();
  }
});
