/**
 * P1 回归：子 Agent 成本控制 + 统一 envelope。
 *   - 每个 subagent 独立预算（工具调用上限），超限返回 status=budget_exhausted 的部分结论（不为空）；
 *   - 父任务全局 subagent 数量/聚合成本预算：超限返回 status=error 拒绝再派生；
 *   - envelope 含 status/report/usage/abortedReason/checkpointId，父可区分完成与额度耗尽；
 *   - 额度耗尽后仅允许 confirm_retry=true 续跑一次；
 *   - fork 不复制完整 parent.messages，仅复制摘要。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import type { ScriptedTurn } from '../src/llm/mock.js';
import type { SubagentEnvelope } from '../src/tools/subagent.js';

function countExecutions(workdir: string): number {
  const f = path.join(workdir, 'count.txt');
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
}

/** 父会话 messages 里 spawn_subagent 的 envelope（按顺序，解析 JSON）。 */
function spawnEnvelopes(h: ReturnType<typeof makeHarness>): SubagentEnvelope[] {
  const out: SubagentEnvelope[] = [];
  const toolUseIds = new Set<string>();
  for (const m of h.session.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === 'spawn_subagent') toolUseIds.add(b.id);
      if (b.type === 'tool_result' && toolUseIds.has(b.tool_use_id)) {
        out.push(JSON.parse(b.content) as SubagentEnvelope);
      }
    }
  }
  return out;
}

test('subagent 内部预算：工具调用超限 → status=budget_exhausted + 部分结论（非空）', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: '探索任务' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: '## Findings\n- 部分发现 (evidence: a.ts:1)\n## Result\n部分结论' }] },
    { blocks: [{ type: 'text', text: 'parent done' }] },
  ];
  const h = makeHarness({
    script,
    permissionMode: 'bypass',
    configOverrides: { subagentMaxToolCalls: 1, subagentMaxTurns: 6 },
  });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const finalText = await h.agent.run('go');
    assert.equal(finalText, 'parent done');

    const envs = spawnEnvelopes(h);
    assert.equal(envs.length, 1);
    /* envelope 结构 + status 区分额度耗尽 */
    assert.equal(envs[0].status, 'budget_exhausted', `应标记 budget_exhausted，实际 ${envs[0].status}`);
    assert.ok(envs[0].report.includes('部分结论'), `report 应含部分结论: ${envs[0].report.slice(0, 200)}`);
    assert.ok(envs[0].checkpointId.startsWith('sub_'), '应有 checkpointId');
    assert.equal(typeof envs[0].usage.toolCalls, 'number');
    assert.equal(countExecutions(h.workdir), 1, '内部预算应生效（bash 只执行 1 次）');
  } finally {
    h.cleanup();
  }
});

test('父任务全局 subagent 数量预算：超限 → status=error 拒绝', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 't1' } }] },
    { blocks: [{ type: 'text', text: 'sub-1' }] },
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 't2' } }] },
    { blocks: [{ type: 'text', text: 'sub-2' }] },
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 't3' } }] },
    { blocks: [{ type: 'text', text: 'parent done' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxSubagentsPerTask: 2 } });
  try {
    const finalText = await h.agent.run('go');
    assert.equal(finalText, 'parent done');
    const envs = spawnEnvelopes(h);
    assert.equal(envs.length, 3);
    assert.equal(envs[0].status, 'completed');
    assert.ok(envs[0].report.includes('sub-1'));
    assert.equal(envs[1].status, 'completed');
    assert.ok(envs[1].report.includes('sub-2'));
    /* 第 3 个被数量预算拒绝 */
    assert.equal(envs[2].status, 'error');
    assert.ok(envs[2].report.includes('数量预算耗尽'));
  } finally {
    h.cleanup();
  }
});

test('父任务全局聚合成本预算：工具调用总量超限 → status=error', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 't1' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: 'sub-1' }] },
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 't2' } }] },
    { blocks: [{ type: 'text', text: 'parent done' }] },
  ];
  const h = makeHarness({
    script,
    permissionMode: 'bypass',
    configOverrides: { subagentTotalToolCalls: 1, subagentMaxToolCalls: 5 },
  });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const finalText = await h.agent.run('go');
    assert.equal(finalText, 'parent done');
    const envs = spawnEnvelopes(h);
    assert.equal(envs.length, 2);
    assert.equal(envs[0].status, 'completed');
    assert.equal(envs[1].status, 'error');
    assert.ok(envs[1].report.includes('聚合成本预算耗尽'));
  } finally {
    h.cleanup();
  }
});

test('额度耗尽后：confirm_retry 续跑一次，第二次续跑被拒绝', async () => {
  /* 第 1 个 subagent 预算耗尽（budget_exhausted）；随后 confirm_retry=true 续跑一次（completed）；再续跑被拒绝 */
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 't1' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: 'sub-1 部分' }] },
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'retry', confirm_retry: true } }] },
    { blocks: [{ type: 'text', text: 'retry 完成' }] },
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'retry2', confirm_retry: true } }] },
    { blocks: [{ type: 'text', text: 'parent done' }] },
  ];
  const h = makeHarness({
    script,
    permissionMode: 'bypass',
    configOverrides: { subagentMaxToolCalls: 1, subagentMaxTurns: 6 },
  });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const finalText = await h.agent.run('go');
    assert.equal(finalText, 'parent done');
    const envs = spawnEnvelopes(h);
    assert.equal(envs.length, 3);
    assert.equal(envs[0].status, 'budget_exhausted', '第 1 个应预算耗尽');
    assert.equal(envs[1].status, 'completed', 'confirm_retry 续跑应成功');
    assert.equal(envs[2].status, 'error', '第二次续跑应被拒绝');
    assert.ok(envs[2].report.includes('续跑次数已用尽'));
  } finally {
    h.cleanup();
  }
});

test('fork 模式不复制完整 parent.messages（只注入摘要）', async () => {
  /* 父会话先产生一些消息（含一条长摘要），再 fork=true 派生子代理 */
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'fork task', fork: true } }] },
    { blocks: [{ type: 'text', text: 'forked result' }] },
    { blocks: [{ type: 'text', text: 'parent done' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass' });
  try {
    /* 给父会话注入 sessionMemory，模拟"摘要"而非完整历史 */
    h.session.sessionMemory = '父会话摘要内容';
    /* 制造一些父消息，但保持 fork 门控阈值内 */
    const finalText = await h.agent.run('go');
    assert.equal(finalText, 'parent done');
    const envs = spawnEnvelopes(h);
    assert.equal(envs.length, 1);
    assert.equal(envs[0].status, 'completed');
    assert.ok(envs[0].report.includes('forked result'));
  } finally {
    h.cleanup();
  }
});

test('fork 在父上下文过大时退化为 fresh（不复制消息）', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'fork task', fork: true } }] },
    { blocks: [{ type: 'text', text: 'fresh result' }] },
    { blocks: [{ type: 'text', text: 'parent done' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass' });
  try {
    h.session.sessionMemory = '摘要';
    /* 塞入超长父消息，使 fork 门控失效（>20K 字符） */
    h.session.messages.push({ role: 'user', content: 'x'.repeat(21_000) });
    const finalText = await h.agent.run('go');
    assert.equal(finalText, 'parent done');
    const envs = spawnEnvelopes(h);
    assert.equal(envs.length, 1);
    assert.equal(envs[0].status, 'completed');
  } finally {
    h.cleanup();
  }
});
