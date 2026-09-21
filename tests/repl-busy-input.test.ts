/**
 * P2 回归：运行期间输入与终端状态。
 *   - busy 状态下输入 '>' → 显示进度反馈，不静默丢弃；
 *   - busy 状态下输入普通文字 → 加入待处理队列并提示"输入已排队"，任务结束后依次处理；
 *   - 运行中状态事件（turn）正常发出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { makeHarness, setTerminalSize } from './helpers.js';
import { startRepl } from '../src/repl.js';

test('busy 状态输入 > 与排队文字：有明确反馈且排队输入被处理', async () => {
  /* 第一个回合带延迟，保证 busy 期间有机会输入 */
  const h = makeHarness({
    permissionMode: 'bypass',
    script: [
      { blocks: [{ type: 'text', text: '第一个任务完成' }] },
      { blocks: [{ type: 'text', text: '排队任务完成' }] },
    ],
  });
  (h.llm as unknown as { opts: { delayMs?: number } }).opts.delayMs = 500;
  const input = new PassThrough();
  const output = new PassThrough();
  setTerminalSize(output);
  let buf = '';
  output.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  try {
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=bypass | workdir=/tmp',
      input,
      output,
    });

    /* 启动第一个任务 */
    input.write('第一个任务\n');
    await new Promise((r) => setTimeout(r, 150)); // 此时任务运行中（500ms 延迟）

    /* busy 输入：'>' 进度查询 + 普通文字排队 */
    input.write('>\n');
    await new Promise((r) => setTimeout(r, 120));
    input.write('排队任务\n');
    await new Promise((r) => setTimeout(r, 120));

    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('REPL 挂起')), 8000))]);

    /* '>' 有进度反馈（状态行），不被静默丢弃 */
    assert.ok(buf.includes('任务运行中'), `应有运行中反馈，实际片段:\n${buf.slice(-400)}`);
    /* 排队提示 */
    assert.ok(buf.includes('输入已排队'), `应有"输入已排队"提示，实际片段:\n${buf.slice(-400)}`);
    /* 排队任务在第一个任务结束后被处理（两次 agent 调用） */
    assert.ok(h.llm.turnsConsumed >= 2, `排队输入应被处理，llm 调用数=${h.llm.turnsConsumed}`);
    assert.ok(buf.includes('排队任务完成'), '排队任务应执行并输出结果');
  } finally {
    h.cleanup();
  }
});

test('turn 状态事件：每轮发出 turn/maxTurns', async () => {
  const h = makeHarness({
    permissionMode: 'bypass',
    script: [
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'git status' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  try {
    const turns: Array<{ turn: number; maxTurns: number }> = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'turn') turns.push({ turn: e.turn, maxTurns: e.maxTurns });
    });
    await h.agent.run('go');
    assert.ok(turns.length >= 2, `应至少 2 轮 turn 事件，实际 ${turns.length}`);
    assert.equal(turns[0].turn, 1);
    assert.equal(turns[1].turn, 2);
    assert.ok(turns[0].maxTurns > 0);
  } finally {
    h.cleanup();
  }
});
