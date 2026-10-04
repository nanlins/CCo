/**
 * LLM thinking 模型结构化输出兼容回归（P0-2）。
 *
 * 验证：
 *  1) thinking 模型（deepseek-flash）结构化调用不发 tool_choice，改走文本 JSON 并正确解析；
 *  2) 普通模型被服务端拒绝 tool_choice 时自动降级重试文本 JSON；
 *  3) 文本 JSON 解析器容忍 markdown 围栏与前后解释文字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { loadConfig } from '../src/config.js';
import { OpenAiLlm, isThinkingModel, parseJsonObject } from '../src/llm/openai.js';
import type { LlmCallParams } from '../src/llm/client.js';

function sseResponse(text: string): Response {
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: Readable.from([Buffer.from(payload)]),
  } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify({ error: { message, type: 'invalid_request_error' } }),
  } as unknown as Response;
}

function structuredParams(model: string): LlmCallParams {
  return {
    system: '你是规划器',
    messages: [{ role: 'user', content: '任务' }],
    tools: [],
    maxTokens: 256,
    model,
    structured: {
      name: 'plan',
      description: '输出分步骤计划',
      schema: { type: 'object', properties: { steps: { type: 'array' } } },
    },
  };
}

function testConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({ openaiBaseUrl: 'https://fake.local/v1', openaiApiKey: 'sk-test' });
}

test('P0-2: thinking 模型识别与文本 JSON 提取', () => {
  assert.equal(isThinkingModel('deepseek-flash'), true);
  assert.equal(isThinkingModel('deepseek-reasoner'), true);
  assert.equal(isThinkingModel('o1-mini'), true);
  assert.equal(isThinkingModel('gpt-4o'), false);
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('好的，结果如下：{"a":2}（完毕）'), { a: 2 });
  assert.equal(parseJsonObject('没有 JSON'), undefined);
});

test('P0-2: deepseek-flash 结构化调用不发 tool_choice，文本 JSON 解析成功', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return sseResponse('{"steps":[{"text":"读文件"}]}');
  }) as unknown as typeof fetch;
  try {
    const llm = new OpenAiLlm(testConfig());
    const r = await llm.complete(structuredParams('deepseek-flash'));
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].tool_choice, undefined, 'thinking 模型不应带 tool_choice');
    assert.equal(bodies[0].tools, undefined, 'thinking 模型不应带强制工具');
    const sys = (bodies[0].messages as Array<{ role: string; content: string }>)[0];
    assert.match(sys.content, /结构化输出/);
    assert.match(sys.content, /JSON Schema/);
    assert.deepEqual(r.structured, { steps: [{ text: '读文件' }] });
  } finally {
    globalThis.fetch = orig;
  }
});

test('P0-2: 普通模型被拒 tool_choice → 自动降级文本 JSON 重试', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    if (body.tool_choice) {
      return errorResponse(400, 'Thinking mode does not support this tool_choice');
    }
    return sseResponse('{"steps":[]}');
  }) as unknown as typeof fetch;
  try {
    const llm = new OpenAiLlm(testConfig());
    const r = await llm.complete(structuredParams('gpt-4o'));
    assert.equal(bodies.length, 2, '应发生一次降级重试');
    assert.ok(bodies[0].tool_choice, '首次应带强制 tool_choice');
    assert.equal(bodies[1].tool_choice, undefined, '重试不应带 tool_choice');
    assert.deepEqual(r.structured, { steps: [] });
  } finally {
    globalThis.fetch = orig;
  }
});
