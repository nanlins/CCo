/**
 * Ctrl+C 取消机制回归：agent.requestCancel() 后循环在安全点
 * （下一轮 LLM 调用前 / 工具批次后）退出，不继续消耗 LLM 调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

test('requestCancel: 循环在下一轮 LLM 调用前安全退出', async () => {
  const script: ScriptedTurn[] = [];
  for (let i = 0; i < 6; i++) {
    script.push({
      blocks: [{ type: 'tool_use', name: 'write_file', input: { path: `f${i}.txt`, content: 'x' } }],
    });
  }
  script.push({ blocks: [{ type: 'text', text: 'all done' }] });
  /* 每轮 LLM 调用加延迟，确保取消有机会落在安全点 */
  const h = makeHarness({ script, permissionMode: 'auto' });
  try {
    const runPromise = h.agent.run('write many files');
    setTimeout(() => h.agent.requestCancel(), 5);
    await runPromise;
    assert.ok(h.llm.turnsConsumed < 7, `取消后不应跑完全部 7 轮（实际 ${h.llm.turnsConsumed}）`);
  } finally {
    h.cleanup();
  }
});

test('requestCancel: run 开始时重置标志，不影响下一轮任务', async () => {
  const h = makeHarness({ permissionMode: 'auto' });
  try {
    h.agent.requestCancel(); // 预先置位
    const out = await h.agent.run('hello');
    assert.ok(typeof out === 'string');
    assert.equal(h.llm.turnsConsumed, 1, '预置的取消标志应被新一轮 run 清除');
  } finally {
    h.cleanup();
  }
});

test('requestCancel: 中止正在进行的 LLM 调用（abortSignal 传入 complete）', async () => {
  /* 带延迟的 mock：取消发生在 LLM 调用进行中，而不是两轮之间 */
  const h = makeHarness({
    permissionMode: 'auto',
    script: [{ blocks: [{ type: 'text', text: 'first' }] }, { blocks: [{ type: 'text', text: 'second' }] }],
  });
  try {
    (h.llm as unknown as { opts: { delayMs?: number } }).opts.delayMs = 300;
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    const runPromise = h.agent.run('go');
    /* 50ms 时取消：此刻第一次 LLM 调用仍在进行中 */
    setTimeout(() => h.agent.requestCancel(), 50);
    const start = Date.now();
    await runPromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `取消后应尽快退出（实际 ${elapsed}ms）`);
    assert.ok(
      events.some((m) => m.includes('cancelled')),
      `应有取消事件，实际: ${events.join(' | ')}`,
    );
    /* 第二次 LLM 调用不应发生（流被中止而不是等下一轮） */
    assert.ok(h.llm.turnsConsumed <= 1, `应中止在第一次调用，实际调用 ${h.llm.turnsConsumed} 次`);
  } finally {
    h.cleanup();
  }
});
