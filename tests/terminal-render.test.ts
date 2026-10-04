/**
 * 终端渲染回归：Markdown 代码块高亮、行内格式、分页切片。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMarkdown,
  MarkdownRenderer,
  paginate,
  highlightCodeLine,
  renderInlineMarkdown,
} from '../src/core/terminal.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('renderMarkdown: 围栏代码块保留内容并加边框', () => {
  const text = '说明：\n```js\nconst x = 1;\n```\n结束';
  const lines = renderMarkdown(text);
  const plain = lines.map(stripAnsi);
  assert.ok(
    plain.some((l) => l.includes('┌─[js]')),
    '应有代码块上边框',
  );
  assert.ok(
    plain.some((l) => l.includes('const x = 1;')),
    '代码内容必须保留',
  );
  assert.ok(
    plain.some((l) => l.includes('└─')),
    '应有代码块下边框',
  );
});

test('renderMarkdown: 未闭合代码块兜底收边', () => {
  const lines = renderMarkdown('```\ncode here');
  const plain = lines.map(stripAnsi);
  assert.ok(plain[plain.length - 1].includes('└─'));
});

test('renderMarkdown: 标题与列表着色不丢内容', () => {
  const lines = renderMarkdown('# 标题\n- 项目一');
  const plain = lines.map(stripAnsi);
  assert.ok(plain[0].includes('标题'));
  assert.ok(plain[1].includes('项目一'));
});

test('MarkdownRenderer: 流式逐行喂入与一次性渲染一致', () => {
  const text = '```py\nprint("hi")\n```';
  const r = new MarkdownRenderer();
  const streamed = text.split('\n').map((l) => stripAnsi(r.feedLine(l)));
  const ended = r.end();
  assert.equal(ended, null, '闭合后无需兜底');
  const batch = renderMarkdown(text).map(stripAnsi);
  assert.deepEqual(streamed, batch);
});

test('highlightCodeLine: 整行注释与字符串着色（NO_COLOR 下也不丢内容）', () => {
  const commented = highlightCodeLine('// a comment');
  assert.ok(stripAnsi(commented).includes('// a comment'), '注释内容必须保留');
  const stringLine = highlightCodeLine('x = "abc"');
  assert.ok(stripAnsi(stringLine).includes('"abc"'), '字符串内容必须保留');
});

test('renderInlineMarkdown: 行内代码与加粗保留原文', () => {
  const out = renderInlineMarkdown('用 `npm test` 运行 **全部测试**');
  const plain = stripAnsi(out);
  assert.ok(plain.includes('npm test'));
  assert.ok(plain.includes('全部测试'));
});

test('paginate: 切片与 hasMore/nextOffset 正确', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `L${i}`);
  const p1 = paginate(lines, 10, 0);
  assert.equal(p1.pageLines.length, 10);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.nextOffset, 10);
  const p3 = paginate(lines, 10, 20);
  assert.equal(p3.pageLines.length, 5);
  assert.equal(p3.hasMore, false);
  /* 尾页不足一页 */
  const small = paginate(['a', 'b'], 10, 0);
  assert.equal(small.hasMore, false);
});
