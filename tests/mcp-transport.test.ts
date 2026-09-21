import test from 'node:test';
import assert from 'node:assert/strict';
import { StdioTransport, HttpTransport, SseTransport, createTransport } from '../src/mcp/transport.js';
import { generatePkce, discoverOAuth } from '../src/mcp/oauth.js';

test('createTransport: stdio 类型', () => {
  const t = createTransport('stdio', { command: 'node', args: ['-v'] });
  assert.ok(t instanceof StdioTransport);
  assert.equal(t.isConnected(), false);
});

test('createTransport: http 类型', () => {
  const t = createTransport('http', { url: 'http://localhost:8080/mcp' });
  assert.ok(t instanceof HttpTransport);
  assert.equal(t.isConnected(), false);
});

test('createTransport: sse 类型', () => {
  const t = createTransport('sse', { url: 'http://localhost:8080/sse' });
  assert.ok(t instanceof SseTransport);
  assert.equal(t.isConnected(), false);
});

test('createTransport: 未知类型抛错', () => {
  assert.throws(() => createTransport('unknown' as never, {}), /Unknown transport/);
});

test('generatePkce: 生成有效的 verifier 和 challenge', () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43, 'verifier 应至少 43 字符');
  assert.ok(challenge.length >= 43, 'challenge 应至少 43 字符');
  assert.notEqual(verifier, challenge);
});

test('generatePkce: 每次生成不同', () => {
  const a = generatePkce();
  const b = generatePkce();
  assert.notEqual(a.verifier, b.verifier);
});

test('discoverOAuth: 无效 URL 返回 null', async () => {
  const r = await discoverOAuth('http://localhost:1');
  assert.equal(r, null);
});

test('StdioTransport: onNotification 注册回调', () => {
  const t = new StdioTransport('node', ['-v']);
  let called = false;
  t.onNotification(() => {
    called = true;
  });
  assert.equal(called, false); // 未连接不触发
});

test('HttpTransport: notify 不抛错（无连接时静默失败）', () => {
  const t = new HttpTransport('http://localhost:1/mcp');
  assert.doesNotThrow(() => t.notify('test', {}));
});

test('SseTransport: close 后可重连标志重置', () => {
  const t = new SseTransport('http://localhost:1/sse');
  t.close();
  assert.equal(t.isConnected(), false);
});
