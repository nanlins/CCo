import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../src/core/compact.js';
import { MockLlm } from '../src/llm/mock.js';

test('sessionMemory 足够长时复用（0 API 调用）', async () => {
  const llm = new MockLlm({});
  const memory = '会话摘要: 目标-重构agent循环。已用工具: read_file, write_file。结论-完成重构。'.repeat(50);
  const r = await compactHistory(
    [
      { role: 'user', content: 'old message' },
      { role: 'assistant', content: 'old reply' },
    ],
    llm,
    { maxTokens: 1000, sessionMemory: memory },
  );
  assert.equal(r.source, 'session-memory');
  assert.equal(llm.turnsConsumed, 0, '不应调用 LLM');
  assert.ok(r.messages[0].content.includes('会话摘要'));
  assert.ok(r.messages.length >= 2, '保留摘要+尾部');
});

test('sessionMemory 太短时走 LLM 摘要', async () => {
  const llm = new MockLlm({
    script: [{ blocks: [{ type: 'text', text: '<summary>short summary</summary>' }] }],
  });
  const r = await compactHistory(
    [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
    ],
    llm,
    { maxTokens: 1000, sessionMemory: '太短' },
  );
  assert.equal(r.source, 'llm');
  assert.equal(llm.turnsConsumed, 1);
  assert.equal(r.summary, 'short summary');
});

test('sessionMemory 不提供时走 LLM 摘要', async () => {
  const llm = new MockLlm({
    script: [{ blocks: [{ type: 'text', text: '<summary>s</summary>' }] }],
  });
  const r = await compactHistory([{ role: 'user', content: 'x' }], llm, { maxTokens: 1000 });
  assert.equal(r.source, 'llm');
});
