import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamAccumulator,
  classifyHttpError,
  mapFinishReason,
  sseLines,
  toOpenAiMessages,
  toOpenAiTools,
} from '../src/llm/openai.js';
import { isPromptTooLong, isRetryableError } from '../src/core/recovery.js';
import type { Message } from '../src/types.js';

test('toOpenAiMessages: string / tool_use / tool_result 三种形态转换', () => {
  const messages: Message[] = [
    { role: 'user', content: '读一下文件' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来读' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.md' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'FILE-BODY' }] },
    { role: 'assistant', content: [{ type: 'text', text: '完成' }] },
  ];
  const out = toOpenAiMessages('SYS', messages);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'SYS');
  assert.deepEqual(out[1], { role: 'user', content: '读一下文件' });
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].content, '我来读');
  assert.equal(out[2].tool_calls?.length, 1);
  assert.equal(out[2].tool_calls?.[0].id, 'call_1');
  assert.equal(out[2].tool_calls?.[0].function.name, 'read_file');
  assert.equal(out[2].tool_calls?.[0].function.arguments, '{"path":"a.md"}');
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'call_1', content: 'FILE-BODY' });
  assert.deepEqual(out[4], { role: 'assistant', content: '完成' });
});

test('toOpenAiMessages: 无文本的 tool_use → content=null；并行多 tool_result 顺序保留', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'c1', name: 'glob', input: { pattern: '*.md' } },
        { type: 'tool_use', id: 'c2', name: 'grep', input: { pattern: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'r2' },
      ],
    },
  ];
  const out = toOpenAiMessages('S', messages);
  assert.equal(out[1].content, null);
  assert.equal(out[1].tool_calls?.length, 2);
  assert.equal(out[2].role, 'tool');
  assert.equal(out[3].role, 'tool');
  assert.equal((out[2] as { content: string }).content, 'r1');
  assert.equal((out[3] as { content: string }).content, 'r2');
});

test('toOpenAiTools: 包装为 function 类型', () => {
  const out = toOpenAiTools([
    {
      name: 'read_file',
      description: '读文件',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'function');
  assert.equal((out[0].function as { name: string }).name, 'read_file');
});

test('mapFinishReason: OpenAI → Anthropic 语义', () => {
  assert.equal(mapFinishReason('stop'), 'end_turn');
  assert.equal(mapFinishReason('length'), 'max_tokens');
  assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapFinishReason(null), 'end_turn');
});

test('StreamAccumulator: 文本增量 + tool_calls 名称单次下发 + 跨 chunk 拼接 arguments + usage', () => {
  const acc = new StreamAccumulator();
  assert.equal(acc.feed({ choices: [{ delta: { content: '你好' } }] }), '你好');
  acc.feed({ choices: [{ delta: { content: '，世界' } }] });
  acc.feed({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file', arguments: '' } }] } }],
  });
  acc.feed({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }],
  });
  acc.feed({
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] }, finish_reason: 'tool_calls' },
    ],
  });
  acc.feed({
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
  });

  assert.equal(acc.text, '你好，世界');
  assert.equal(acc.finishReason, 'tool_calls');
  const blocks = acc.blocks();
  assert.equal(blocks[0].type, 'text');
  const use = blocks[1];
  assert.ok(use.type === 'tool_use');
  if (use.type === 'tool_use') {
    assert.equal(use.id, 'call_9');
    assert.equal(use.name, 'read_file');
    assert.deepEqual(use.input, { path: 'a.md' });
  }
  assert.equal(acc.usage?.prompt_tokens, 100);
  assert.equal(acc.usage?.prompt_tokens_details?.cached_tokens, 60);
});

test('StreamAccumulator: provider 重复下发 name 不导致名称重复（首次赋值语义）', () => {
  const acc = new StreamAccumulator();
  acc.feed({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }],
  });
  /* provider 在后续 chunk 重复下发完整 name → 不应拼接为 read_fileread_file */
  acc.feed({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":' } }] },
      },
    ],
  });
  acc.feed({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] } }],
  });
  const blocks = acc.blocks();
  const use = blocks[0];
  assert.ok(use.type === 'tool_use');
  if (use.type === 'tool_use') {
    assert.equal(use.name, 'read_file', '重复 name chunk 不得导致名称重复');
    assert.deepEqual(use.input, { path: 'a.md' });
  }
});

test('sseLines: 跨 chunk 半行切分 + [DONE]', async () => {
  const enc = new TextEncoder();
  const parts = [enc.encode('data: {"a":1}\nda'), enc.encode('ta: {"b":2}\n\ndata: [DONE]\n')];
  async function* gen(): AsyncGenerator<Uint8Array> {
    for (const p of parts) yield p;
  }
  const lines: string[] = [];
  for await (const l of sseLines(gen())) lines.push(l);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '[DONE]']);
});

test('classifyHttpError: 上下文超限 → prompt_too_long（对齐 recovery.isPromptTooLong）', () => {
  const body = JSON.stringify({
    error: {
      message: "This model's maximum context length is 131072 tokens. However, you requested 200000 tokens",
      type: 'invalid_request_error',
    },
  });
  const err = classifyHttpError(400, body);
  assert.equal(err.status, 400);
  assert.ok(isPromptTooLong(err), 'should be detected as prompt_too_long');
});

test('classifyHttpError: 429 带 status（对齐 recovery.isRetryableError）', () => {
  const err = classifyHttpError(429, JSON.stringify({ error: { message: 'Rate limit' } }));
  assert.ok(isRetryableError(err));
  assert.ok(!isPromptTooLong(err));
});
