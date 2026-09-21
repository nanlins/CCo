/**
 * P0 回归：预算耗尽必须生成最终报告（不得返回未完成的探索文本）。
 *   - 工具调用预算耗尽 → 注入不可忽略的 system-reminder，只允许一次小 token 文本报告；
 *   - 输出 token 预算耗尽 → 同样进入最终报告模式；
 *   - LLM 调用次数上限 → 同样；
 *   - 最终报告模式下模型仍调用工具 → 直接拦截并返回错误结果（最多重试 2 次后强制结束）；
 *   - messages / todos / readFileState / 报告写入 checkpoint。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

const FOUR_SECTIONS = ['已完成检查', '未完成检查', '当前证据', '风险项'];

function countExecutions(workdir: string): number {
  const f = path.join(workdir, 'count.txt');
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
}

test('工具预算耗尽：强制生成最终报告，工具调用被限制在预算内', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    {
      blocks: [
        { type: 'text', text: '## 已完成检查\n- 检查A\n## 未完成检查\n- 无\n## 当前证据\n- 证据1\n## 风险项\n- 无' },
      ],
    },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxToolCallsPerRun: 2 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const finalText = await h.agent.run('do the job');

    /* 1. 最终输出是结构化报告，不是未完成句子 */
    for (const s of FOUR_SECTIONS) assert.ok(finalText.includes(s), `最终报告应含「${s}」`);
    /* 2. 工具实际执行次数不超过预算（第 3 次调用发生在预算耗尽后，被最终报告模式拦截） */
    assert.ok(countExecutions(h.workdir) <= 2, `工具执行应 ≤ 预算 2，实际 ${countExecutions(h.workdir)}`);
    /* 3. system-reminder 已注入且包含四部分要求 */
    const reminders = h.session.messages.filter(
      (m) =>
        typeof m.content === 'string' && m.content.includes('<system-reminder>') && m.content.includes('预算已耗尽'),
    );
    assert.ok(reminders.length >= 1, '应注入预算耗尽的 system-reminder');
    const reminderText = String(reminders[0].content);
    for (const s of FOUR_SECTIONS) assert.ok(reminderText.includes(s), `reminder 应要求「${s}」小节`);
    /* 4. checkpoint 含报告 + messages + readFileState */
    const snapFile = path.join(h.workdir, '.transcripts', 'test.messages.json');
    assert.ok(fs.existsSync(snapFile), 'checkpoint 应存在');
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    assert.ok(Array.isArray(snap.messages) && snap.messages.length > 0);
    assert.equal(typeof snap.finalReport, 'string');
    assert.ok(snap.finalReport.includes('已完成检查'));
  } finally {
    h.cleanup();
  }
});

test('输出 token 预算耗尽：进入最终报告模式', async () => {
  const script: ScriptedTurn[] = [
    {
      blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }],
      usage: { outputTokens: 500 },
    },
    { blocks: [{ type: 'text', text: '## 已完成检查\nx\n## 未完成检查\ny\n## 当前证据\nz\n## 风险项\nw' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxRunOutputTokens: 300 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    const finalText = await h.agent.run('go');
    assert.ok(
      events.some((m) => m.includes('输出 token 达到预算')),
      `应有 token 预算事件: ${events.join('|')}`,
    );
    assert.ok(finalText.includes('## 已完成检查'), '应输出最终报告');
    assert.equal(countExecutions(h.workdir), 1);
  } finally {
    h.cleanup();
  }
});

test('LLM 调用次数上限：进入最终报告模式', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxLlmCallsPerRun: 2 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    const finalText = await h.agent.run('go');
    assert.ok(
      events.some((m) => m.includes('LLM 调用达到上限')),
      `应有 LLM 上限事件: ${events.join('|')}`,
    );
    assert.ok(finalText.includes('## 已完成检查'));
  } finally {
    h.cleanup();
  }
});

test('最终报告模式下仍调用工具：直接拦截返回错误，重试超限强制结束（不无限循环）', async () => {
  /* 模型"不听话"：预算耗尽后仍然一直调用工具 */
  const script: ScriptedTurn[] = Array.from({ length: 8 }, () => ({
    blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }],
  }));
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxToolCallsPerRun: 1 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    const start = Date.now();
    await h.agent.run('go');
    assert.ok(Date.now() - start < 10_000, '不得无限循环');
    /* 只执行了预算内的 1 次，其余全部被拦截 */
    assert.equal(countExecutions(h.workdir), 1);
    assert.ok(
      events.some((m) => m.includes('intercepted')),
      '应有工具拦截事件',
    );
    assert.ok(
      events.some((m) => m.includes('forcing stop')),
      '重试超限应强制结束',
    );
    /* 被拦截的工具调用收到错误结果 */
    const blocked = h.session.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result' && b.content.includes('tool calls are blocked'));
    assert.ok(blocked.length >= 1, '拦截应返回错误结果给模型');
  } finally {
    h.cleanup();
  }
});

test('严格逐次计数：单轮并行批次不越界（并发安全工具也严格限于预算内）', async () => {
  /* 一轮内并行发出 5 个只读工具（并发安全 → 同一批次并行执行），预算 2 */
  const script: ScriptedTurn[] = [
    {
      blocks: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((p) => ({
        type: 'tool_use',
        name: 'read_file',
        input: { path: p },
      })),
    },
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxToolCallsPerRun: 2 } });
  try {
    for (const p of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      fs.writeFileSync(path.join(h.workdir, p), `content of ${p}`, 'utf8');
    }
    const finalText = await h.agent.run('read all');
    assert.ok(finalText.includes('## 已完成检查'));

    /* 严格逐次计数：工具调用总数恰为预算 2，不越界 */
    assert.equal(h.agent.getRunStats().toolCalls, 2, '工具调用总数必须恰为预算 2（不越界）');
    /* 实际执行了 2 个读取（有真实内容），其余 3 个收到预算耗尽错误 */
    const results = h.session.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    const okResults = results.filter((b) => b.content.includes('content of '));
    const blockedResults = results.filter((b) => b.content.includes('tool-call budget exhausted'));
    assert.equal(okResults.length, 2, `应恰好执行 2 个读取，实际 ${okResults.length}`);
    assert.equal(blockedResults.length, 3, `应拦截 3 个越界调用，实际 ${blockedResults.length}`);
  } finally {
    h.cleanup();
  }
});
