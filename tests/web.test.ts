import test from 'node:test';
import assert from 'node:assert/strict';
import { webExtractor, parseBingResultsForTest, htmlToTextForTest } from '../src/tools/web.js';

test('web_extractor: 拒绝非 http/https', async () => {
  const r = await webExtractor('file:///etc/passwd');
  assert.ok(r.includes('仅支持 http/https'));
});

test('htmlToText: 去除标签与脚本，保留正文', () => {
  const html =
    '<html><head><title>x</title></head><body><script>alert(1)</script><h1>标题</h1><p>正文内容</p></body></html>';
  const text = htmlToTextForTest(html);
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('正文内容'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('<script>'));
});

test('parseBingResults: 解析 Bing 结果块', () => {
  const html =
    '<li class="b_algo"><h2><a href="https://example.com/page">示例标题</a></h2><p>这是一段摘要内容</p></li>';
  const results = parseBingResultsForTest(html, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, '示例标题');
  assert.equal(results[0].url, 'https://example.com/page');
  assert.ok(results[0].snippet.includes('摘要'));
});

test('parseBingResults: 空结果', () => {
  assert.deepEqual(parseBingResultsForTest('<html>nothing</html>', 5), []);
});
