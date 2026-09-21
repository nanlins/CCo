/**
 * P1 回归：冷启动模型切换。
 *   - 无 key 启动 → MockLlm；执行 /apikey 等价操作（rebuildLlm）后 LLM 实例必须替换，
 *     不得继续使用 Mock；
 *   - /baseurl、/protocol 切换端点/协议后同样重建实例；
 *   - /config 输出完整且脱敏。
 *
 * 注意：测试通过显式 override 隔离环境（不读取/不修改真实 .env；密钥只作为测试值传入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, maskKey, type HarnessOverrides } from '../src/main.js';
import { MockLlm } from '../src/llm/mock.js';
import { AnthropicLlm } from '../src/llm/client.js';
import { OpenAiLlm } from '../src/llm/openai.js';

function tmpWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cold-'));
}

/** 隔离本机 .env 的密封配置：禁用 redis/pg/向量库/路由等一切外部依赖。 */
function hermetic(workspaceDir: string, extra: HarnessOverrides = {}): HarnessOverrides {
  return {
    workspaceDir,
    mock: false,
    apiKey: '',
    baseUrl: 'http://127.0.0.1:9/anthropic',
    llmProtocol: 'anthropic',
    openaiApiKey: '',
    openaiBaseUrl: 'http://127.0.0.1:9/v1',
    redisUrl: '',
    pgConnectionString: '',
    vectorStore: 'memory',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingModel: '',
    flashModelId: '',
    proModelId: '',
    fallbackModel: '',
    yolo: false,
    dockerSandbox: false,
    sandboxCmd: '',
    ...extra,
  };
}

test('buildLlm: 无 key → Mock；有 key → 对应协议的真实客户端', () => {
  const w = tmpWorkdir();
  try {
    const noKey = createHarness(hermetic(w));
    assert.ok(noKey.llm instanceof MockLlm, '无 key 应为 MockLlm');
    noKey.close();

    const withKey = createHarness(hermetic(w, { apiKey: 'sk-test-123456' }));
    assert.ok(withKey.llm instanceof AnthropicLlm, 'anthropic 协议 + key 应为 AnthropicLlm');
    withKey.close();

    const oai = createHarness(
      hermetic(w, { llmProtocol: 'openai', openaiApiKey: 'sk-oai-123456', openaiBaseUrl: 'http://127.0.0.1:9/v1' }),
    );
    assert.ok(oai.llm instanceof OpenAiLlm, 'openai 协议 + key 应为 OpenAiLlm');
    oai.close();
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('冷启动 /apikey：rebuildLlm 后实例必须从 Mock 切换为真实 LLM', () => {
  const w = tmpWorkdir();
  const h = createHarness(hermetic(w));
  try {
    assert.ok(h.llm instanceof MockLlm, '启动时无 key → Mock');

    /* 模拟 /apikey sk-xxx：写入 key → 重建并热替换 */
    h.config.apiKey = 'sk-test-abcdef123';
    h.config.mock = false;
    h.rebuildLlm();

    assert.ok(!(h.llm instanceof MockLlm), 'rebuildLlm 后不得继续使用 Mock');
    assert.ok(h.llm instanceof AnthropicLlm, '应切换为 AnthropicLlm');
    /* 再次更换 key 仍可重建 */
    h.config.apiKey = 'sk-test-second99';
    h.rebuildLlm();
    assert.ok(h.llm instanceof AnthropicLlm);
  } finally {
    h.close();
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('/protocol + /baseurl：切换协议与端点后重建实例', () => {
  const w = tmpWorkdir();
  const h = createHarness(hermetic(w, { apiKey: 'sk-test-123456' }));
  try {
    assert.ok(h.llm instanceof AnthropicLlm);
    /* 模拟 /protocol openai + /baseurl（千问 → DeepSeek 场景） */
    h.config.llmProtocol = 'openai';
    h.config.openaiApiKey = 'sk-oai-999';
    h.config.openaiBaseUrl = 'https://api.deepseek.com/v1';
    h.rebuildLlm();
    assert.ok(h.llm instanceof OpenAiLlm, '切到 openai 协议后应为 OpenAiLlm');
    /* 切回 anthropic */
    h.config.llmProtocol = 'anthropic';
    h.rebuildLlm();
    assert.ok(h.llm instanceof AnthropicLlm);
  } finally {
    h.close();
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('maskKey: 脱敏显示（保留末 4 位，不泄露完整 key）', () => {
  assert.equal(maskKey(undefined), '（未设置）');
  assert.equal(maskKey('abc'), '****');
  const masked = maskKey('sk-ant-verysecretkey-1234');
  assert.ok(masked.includes('1234'), '应保留末 4 位');
  assert.ok(!masked.includes('verysecretkey'), '不得包含完整 key');
});
