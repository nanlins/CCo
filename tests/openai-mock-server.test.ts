/**
 * 本地 OpenAI 兼容 mock server 闭环验证：
 *   SSE 流式 + tool_calls（tool call → 工具执行 → tool result 回传 → 最终回答）。
 * 不依赖任何外部服务：server 用 node:http 现场搭建，LLM 用 OpenAiLlm。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { OpenAiLlm } from '../src/llm/openai.js';
import { Agent } from '../src/core/agent.js';
import { HookRegistry } from '../src/core/hooks.js';
import { PermissionGate } from '../src/core/permission.js';
import { ToolRegistry } from '../src/core/registry.js';
import { Transcript } from '../src/core/transcript.js';
import { MemoryStore } from '../src/core/memory.js';
import { fsTools } from '../src/tools/fs.js';
import { callWithRetry } from '../src/core/recovery.js';
import type { Session } from '../src/types.js';

interface SeenRequest {
  auth?: string;
  body: Record<string, unknown>;
}

/** SSE 编码一个 chunk。 */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 流式返回 tool_calls（read_file）。 */
function streamToolCall(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    sse({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  /* arguments 分片流式下发，验证跨 chunk 拼接 */
  for (const part of ['{"pa', 'th":', '"a.txt"}']) {
    res.write(
      sse({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null },
        ],
      }),
    );
  }
  res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 流式返回最终文本（分片，验证流式输出事件）。 */
function streamFinalText(res: http.ServerResponse, fileContent: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const text = `文件内容是：${fileContent}`;
  for (const ch of text.match(/.{1,6}/g) ?? []) {
    res.write(sse({ choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] }));
  }
  res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  res.write(sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startMockOpenAI(
  seen: SeenRequest[],
  fileContent: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ auth: req.headers.authorization, body });
      const messages = body.messages as Array<{ role: string }>;
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (hasToolResult) streamFinalText(res, fileContent);
      else streamToolCall(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('OpenAI 兼容 mock server：流式 + tool call + tool result 全闭环', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-oai-'));
  const fileContent = 'HELLO-FROM-FILE';
  fs.writeFileSync(path.join(workdir, 'a.txt'), fileContent);
  const seen: SeenRequest[] = [];
  const server = await startMockOpenAI(seen, fileContent);
  try {
    const config = loadConfig({
      workspaceDir: workdir,
      mock: false,
      apiKey: '',
      llmProtocol: 'openai',
      openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      openaiApiKey: 'test-key-123',
      model: 'mock-model',
      permissionMode: 'auto',
    });
    const llm = new OpenAiLlm(config);
    const session: Session = {
      id: 'oai-test',
      cwd: workdir,
      baseSystem: 'test',
      messages: [],
      todos: [],
      startTime: Date.now(),
    };
    const registry = new ToolRegistry();
    registry.registerAll(fsTools());
    const agent = new Agent({
      config,
      llm,
      registry,
      hooks: new HookRegistry(),
      permission: new PermissionGate({ mode: 'auto', ask: async () => false }),
      session,
      transcript: new Transcript(path.join(workdir, '.transcripts'), 'oai-test'),
      memory: new MemoryStore(path.join(workdir, '.memory')),
      ask: async () => false,
      log: () => {},
      autoMemory: false,
    });

    const streamedText: string[] = [];
    agent.setOnEvent((e) => {
      if (e.type === 'text') streamedText.push(e.text);
    });

    const finalText = await agent.run('读一下 a.txt 并告诉我内容');

    /* 1. 最终回答包含文件内容（tool result 正确回传给了模型） */
    assert.ok(finalText.includes(fileContent), `最终回答应含文件内容，实际: ${finalText}`);

    /* 2. 流式：文本事件分多次到达 */
    assert.ok(streamedText.length > 1, `流式事件应多于 1 次，实际 ${streamedText.length}`);

    /* 3. 请求侧：鉴权头 + 两次调用（tool_call 轮 + 最终轮），第二次带 role:tool 消息 */
    assert.equal(seen.length, 2);
    assert.equal(seen[0].auth, 'Bearer test-key-123');
    const secondMsgs = seen[1].body.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
    const toolMsg = secondMsgs.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '第二次请求必须包含 tool result');
    assert.equal(toolMsg!.tool_call_id, 'call_abc');
    assert.ok(String(toolMsg!.content).includes(fileContent));
    const assistantWithCall = secondMsgs.find(
      (m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls,
    );
    assert.ok(assistantWithCall, '第二次请求必须回带 assistant 的 tool_calls');

    /* 4. 工具确实在执行：消息序列中存在 tool_use read_file */
    const hasReadToolUse = session.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.name === 'read_file'),
    );
    assert.ok(hasReadToolUse);
  } finally {
    await server.close();
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('OpenAiLlm + callWithRetry: 429 触发重试后成功（recovery 契约）', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit' } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const config = loadConfig({
      workspaceDir: os.tmpdir(),
      mock: false,
      llmProtocol: 'openai',
      openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
      openaiApiKey: 'k',
      model: 'm',
    });
    const llm = new OpenAiLlm(config);
    const result = await callWithRetry(() => llm.complete({ system: 's', messages: [], tools: [], maxTokens: 100 }), {
      llm,
      log: () => {},
    });
    assert.equal(result.content[0].type, 'text');
    assert.ok(calls >= 2, '429 应由 callWithRetry 重试');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
