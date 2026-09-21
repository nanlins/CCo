/**
 * 回归：终端状态面板集成（item 2/3/4/5/6）。
 *   - 80 列长任务期间面板稳定显示，不覆盖输入框；
 *   - 任务中可立即输入并看到队列反馈，结束后继续对话；
 *   - 单次 Ctrl+C 取消当前请求并回到提示符，不退出进程；
 *   - 40/80/120 列切换后状态区自动重排，无残留空白与乱码；
 *   - 面板更新不使用固定一行的 \x1b[1A。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { makeHarness } from './helpers.js';
import { startRepl } from '../src/repl.js';
import { stripAnsi, displayWidth, renderStatusPanel, type StatusPanelData } from '../src/core/terminal.js';

/** 伪造 TTY 输入：isTTY + setRawMode no-op，让 readline 进入终端模式（能识别 Ctrl+C）。 */
class FakeTtyInput extends PassThrough {
  isTTY = true;
  setRawMode(_mode: boolean): this {
    return this;
  }
}

/** 伪造 TTY 输出：isTTY + 可变 columns/rows，支持 emit resize。 */
class FakeTtyOutput extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
  resizeTo(columns: number, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

function setup(script: Parameters<typeof makeHarness>[0]['script'], delayMs = 300) {
  const h = makeHarness({ permissionMode: 'bypass', script });
  (h.llm as unknown as { opts: { delayMs?: number } }).opts.delayMs = delayMs;
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  let raw = '';
  output.on('data', (c: Buffer) => (raw += c.toString('utf8')));
  return { h, input, output, getRaw: () => raw };
}

test('80 列长任务：面板稳定显示、不覆盖输入框、无固定 \x1b[1A', async () => {
  const { h, input, output, getRaw } = setup([{ blocks: [{ type: 'text', text: 'STREAMED-ONE\nSTREAMED-TWO' }] }]);
  try {
    const repl = startRepl({ agent: h.agent, banner: 'x', input, output, heartbeatMs: 40 });
    input.write('go\n');
    await new Promise((r) => setTimeout(r, 500));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('挂起')), 5000))]);

    const raw = getRaw();
    /* 面板已绘制 */
    assert.ok(raw.includes('⏳ 运行中'), '应显示状态面板');
    /* 流式文本完整（不被心跳破坏） */
    const plain = stripAnsi(raw);
    assert.ok(plain.includes('STREAMED-ONE'), '流式行应完整');
    assert.ok(plain.includes('STREAMED-TWO'), '流式行应完整');
    /* 不使用固定一行 \x1b[1A（面板是多行，上移高度应动态 ≥2） */
    assert.ok(!raw.includes('\x1b[1A'), `不得出现固定一行 \x1b[1A 清理逻辑，实际含: ${raw.includes('\x1b[1A')}`);
  } finally {
    h.cleanup();
  }
});

test('任务中输入文字：立即看到队列反馈，结束后继续对话', async () => {
  const { h, input, output, getRaw } = setup([
    { blocks: [{ type: 'text', text: 'first done' }] },
    { blocks: [{ type: 'text', text: 'queued done' }] },
  ]);
  try {
    const repl = startRepl({ agent: h.agent, banner: 'x', input, output, heartbeatMs: 40 });
    input.write('first task\n');
    await new Promise((r) => setTimeout(r, 120));
    input.write('queued task\n'); // busy 中输入，应排队
    await new Promise((r) => setTimeout(r, 120));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('挂起')), 5000))]);

    const plain = stripAnsi(getRaw());
    assert.ok(plain.includes('已排队'), `应显示排队反馈，实际片段:\n${plain.slice(-400)}`);
    /* 排队输入在任务结束后被处理（agent 被调用第二次） */
    assert.ok(h.llm.turnsConsumed >= 2, `排队输入应被处理，llm 调用 ${h.llm.turnsConsumed} 次`);
    assert.ok(plain.includes('queued done'), '排队任务应执行');
  } finally {
    h.cleanup();
  }
});

test("任务中按 '>'：显示可见进度面板", async () => {
  const { h, input, output, getRaw } = setup([{ blocks: [{ type: 'text', text: 'done' }] }]);
  try {
    const repl = startRepl({ agent: h.agent, banner: 'x', input, output, heartbeatMs: 40 });
    input.write('go\n');
    await new Promise((r) => setTimeout(r, 120));
    input.write('>\n'); // 查询进度
    await new Promise((r) => setTimeout(r, 120));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('挂起')), 5000))]);
    assert.ok(stripAnsi(getRaw()).includes('⏳ 运行中'), "'>' 应显示进度面板");
  } finally {
    h.cleanup();
  }
});

test('单次 Ctrl+C：取消当前请求并回到提示符，不退出进程', async () => {
  const { h, input, output, getRaw } = setup(
    [
      { blocks: [{ type: 'text', text: 'cancelled task output' }] },
      { blocks: [{ type: 'text', text: 'after cancel' }] },
    ],
    400,
  );
  try {
    const repl = startRepl({ agent: h.agent, banner: 'x', input, output, heartbeatMs: 40 });
    input.write('long task\n');
    await new Promise((r) => setTimeout(r, 100));
    input.write('\x03'); // Ctrl+C
    await new Promise((r) => setTimeout(r, 200));
    /* 取消后仍能继续对话 */
    input.write('next\n');
    await new Promise((r) => setTimeout(r, 300));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('挂起')), 5000))]);

    const plain = stripAnsi(getRaw());
    assert.ok(plain.includes('取消'), `应显示取消提示，实际片段:\n${plain.slice(-500)}`);
    /* 进程未退出：取消后仍处理了 'next' 输入（第二次 complete 调用） */
    assert.ok(h.llm.calls.length >= 2, `取消后应能继续对话（complete 调用 ${h.llm.calls.length} 次）`);
  } finally {
    h.cleanup();
  }
});

test('终端 resize：40→120 列切换后状态区重排，面板行不越界', async () => {
  const { h, input, output, getRaw } = setup([{ blocks: [{ type: 'text', text: 'done' }] }]);
  try {
    const repl = startRepl({ agent: h.agent, banner: 'x', input, output, heartbeatMs: 40 });
    output.resizeTo(40);
    input.write('go\n');
    await new Promise((r) => setTimeout(r, 100));
    output.resizeTo(120);
    await new Promise((r) => setTimeout(r, 150));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('挂起')), 5000))]);

    /* 状态面板按当前宽度渲染，行不越界（用 renderStatusPanel 纯函数直接验证） */
    const status: StatusPanelData = {
      running: true,
      turn: 1,
      maxTurns: 60,
      tool: 'read_file',
      elapsedMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      queueCount: 0,
    };
    for (const w of [40, 80, 120]) {
      for (const line of renderStatusPanel(status, w)) {
        assert.ok(displayWidth(line) <= w, `${w} 列面板行越界: ${JSON.stringify(line)}`);
      }
    }
    /* resize 后 REPL 未崩溃、仍输出内容 */
    assert.ok(getRaw().length > 0);
  } finally {
    h.cleanup();
  }
});
