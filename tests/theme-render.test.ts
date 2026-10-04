/**
 * 终端主题与审批卡片渲染回归（P0-1）：
 * 耗时格式化、宽度截断/换行、可见宽度、审批卡长文本不破框。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtDuration,
  fitToWidth,
  wrapForGutter,
  visibleLength,
  stripAnsi,
  brandChip,
  renderApprovalCard,
} from '../src/core/terminal.js';

test('fmtDuration: <60s 秒；≥60s 分秒', () => {
  assert.equal(fmtDuration(47_000), '47s');
  assert.equal(fmtDuration(154_000), '2m 34s');
  assert.equal(fmtDuration(60_000), '1m 0s');
});

test('visibleLength: 中文/emoji 计 2，ANSI 计 0', () => {
  assert.equal(visibleLength('中文'), 4);
  assert.equal(visibleLength('ab'), 2);
  assert.equal(visibleLength('\x1b[2m中文\x1b[0m'), 4);
});

test('fitToWidth: 短串不变，长串截断且可见宽度受限', () => {
  assert.equal(fitToWidth('短', 'x'), '短');
  const long = 'a'.repeat(200);
  const fitted = fitToWidth(long, '');
  assert.ok(visibleLength(fitted) <= (process.stdout.columns ?? 80), '截断后不得超过终端宽');
  assert.ok(fitted.endsWith('…'), '超长应补省略号');
});

test('wrapForGutter: 长行按宽度换行，不溢出', () => {
  const cols = process.stdout.columns ?? 80;
  const line = '词 '.repeat(100).trim();
  const wrapped = wrapForGutter(line, 2);
  for (const l of wrapped.split('\n')) {
    assert.ok(visibleLength(l) <= cols - 2, `换行后每行不超宽: ${visibleLength(l)}`);
  }
  assert.ok(wrapped.includes('\n'), '长行必须换行');
});

test('brandChip: 输出保留文本，NO_COLOR 下为纯文本', () => {
  const chip = brandChip('小锤 Anvil');
  assert.ok(stripAnsi(chip).includes('小锤 Anvil'));
});

test('renderApprovalCard: 超长 risk/request 换行且每行不破框', () => {
  const card = renderApprovalCard({
    risk: '危险操作 '.repeat(40),
    request: 'bash: ' + 'x'.repeat(300),
    askCount: 3,
    batch: 'git/npm',
  });
  for (const line of card.split('\n')) {
    assert.ok(visibleLength(line) <= 64, `审批卡每行 ≤64 列，实际 ${visibleLength(line)}: ${line}`);
  }
  assert.ok(card.includes('[y]'), '含单次允许');
  assert.ok(card.includes('[a]'), '含批量允许');
  assert.ok(card.includes('[n]'), '含拒绝');
  assert.ok(card.includes('本任务第 3 次审批'), '含审批次数');
});
