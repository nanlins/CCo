/**
 * CLI 健壮性回归：
 *   - 非交互 EOF（输入结束）→ REPL 必须退出，进程不得悬挂；
 *   - /exit 退出；
 *   - 普通输入走完整 agent loop（mock LLM）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startRepl } from '../src/repl.js';
import { makeHarness, setTerminalSize } from './helpers.js';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}（REPL 未退出，进程悬挂）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function makeStreams(): { input: PassThrough; output: PassThrough; outText: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  setTerminalSize(output);
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
  });
  return { input, output, outText: () => buf };
}

test('REPL: 非交互 EOF（stdin 结束）必须退出，不得悬挂', async () => {
  const h = makeHarness();
  const { input, output, outText } = makeStreams();
  try {
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=auto | workdir=/tmp',
      input,
      output,
    });
    /* 立即结束输入（EOF） */
    input.end();
    await withTimeout(repl, 5000, 'EOF 后 REPL 未退出');
    assert.ok(outText().includes('小锤 Anvil'), 'banner 应已渲染');
  } finally {
    h.cleanup();
  }
});

test('REPL: /exit 命令退出', async () => {
  const h = makeHarness();
  const { input, output } = makeStreams();
  try {
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=auto | workdir=/tmp',
      input,
      output,
    });
    input.write('/exit\n');
    await withTimeout(repl, 5000, '/exit 后 REPL 未退出');
  } finally {
    h.cleanup();
  }
});

test('REPL: 普通输入跑完 agent loop 后继续等待，EOF 退出', async () => {
  const h = makeHarness();
  const { input, output, outText } = makeStreams();
  try {
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=auto | workdir=/tmp',
      input,
      output,
    });
    input.write('hello anvil\n');
    /* 等 agent 处理完（mock 立即返回） */
    await new Promise((r) => setTimeout(r, 300));
    input.end();
    await withTimeout(repl, 5000, 'agent 处理 + EOF 后 REPL 未退出');
    assert.ok(h.llm.turnsConsumed >= 1, 'agent 应至少被调用一次');
    assert.ok(outText().length > 0);
  } finally {
    h.cleanup();
  }
});

test('REPL: 未知斜杠命令显示帮助', async () => {
  const h = makeHarness();
  const { input, output, outText } = makeStreams();
  try {
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=auto | workdir=/tmp',
      input,
      output,
    });
    input.write('/nosuchcmd\n');
    await new Promise((r) => setTimeout(r, 200));
    input.end();
    await withTimeout(repl, 5000, 'EOF 后 REPL 未退出');
    assert.ok(outText().includes('/help'), '未知命令应回退到帮助');
  } finally {
    h.cleanup();
  }
});
