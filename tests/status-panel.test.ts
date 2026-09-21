/**
 * 回归：状态面板多行渲染组件（item 1/5）。
 *   - renderStatusPanel(status, width) 返回 string[]，行数动态确定；
 *   - 每行显示宽度 ≤ width（中文/emoji/ANSI 按实际占用计算）；
 *   - 分别用 40/80/120 列验证，无一行越界、无意外换行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusPanel, displayWidth, truncateLine, type StatusPanelData } from '../src/core/terminal.js';

const SAMPLE: StatusPanelData = {
  running: true,
  turn: 3,
  maxTurns: 60,
  tool: 'read_file',
  elapsedMs: 42_000,
  inputTokens: 34065,
  outputTokens: 3105,
  queueCount: 2,
};

test('renderStatusPanel: 40/80/120 列每行显示宽度都不超过 width', () => {
  for (const w of [40, 80, 120]) {
    const lines = renderStatusPanel(SAMPLE, w);
    assert.ok(lines.length >= 3, `面板应为多行（${w} 列得到 ${lines.length} 行）`);
    for (const line of lines) {
      const dw = displayWidth(line);
      assert.ok(dw <= w, `${w} 列下面板行越界（宽度 ${dw}）: ${JSON.stringify(line)}`);
      assert.ok(!line.includes('\n'), `单行内不得含换行: ${JSON.stringify(line)}`);
    }
  }
});

test('renderStatusPanel: 行数动态确定（窄终端多行，宽终端少行）', () => {
  const narrow = renderStatusPanel(SAMPLE, 40);
  const wide = renderStatusPanel(SAMPLE, 120);
  assert.ok(narrow.length > wide.length, `窄终端应比宽终端行数多：40列=${narrow.length}, 120列=${wide.length}`);
});

test('renderStatusPanel: 中文/emoji 工具名按显示宽度截断，不越界', () => {
  const longTool = { ...SAMPLE, tool: '这是一个很长的中文工具名 read_file_with_very_long_name' };
  for (const w of [40, 60]) {
    for (const line of renderStatusPanel(longTool, w)) {
      assert.ok(displayWidth(line) <= w, `${w} 列下面板行越界: ${JSON.stringify(line)}`);
    }
  }
});

test('displayWidth: 中文/emoji/ANSI 按实际占用计算', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('⏳'), 2);
  assert.equal(displayWidth('\x1b[2m中文\x1b[0m'), 4, 'ANSI 序列计 0 宽');
  assert.equal(displayWidth('a中b'), 4);
});

test('truncateLine: 按显示宽度截断并补省略号，ANSI 透传', () => {
  const t1 = truncateLine('中文字符串很长', 6);
  assert.ok(displayWidth(t1) <= 6, `截断后宽度应 ≤6: ${JSON.stringify(t1)} (${displayWidth(t1)})`);
  assert.ok(t1.endsWith('…'), '截断应补省略号');
  /* ANSI 前缀应被保留 */
  const t2 = truncateLine('\x1b[2m中文字符很长\x1b[0m', 6);
  assert.ok(t2.startsWith('\x1b[2m'), 'ANSI 前缀应保留');
  assert.ok(displayWidth(t2) <= 6);
  /* 未超宽原样返回 */
  assert.equal(truncateLine('abc', 10), 'abc');
});

test('renderStatusPanel: 队列计数与取消状态反映到面板', () => {
  const lines = renderStatusPanel({ ...SAMPLE, queueCount: 3, cancelled: true }, 80).join('\n');
  assert.ok(lines.includes('排队 3 条'));
  assert.ok(lines.includes('已请求取消'));
});
