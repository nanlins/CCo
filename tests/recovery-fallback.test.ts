/**
 * P1 回归：恢复与降级逻辑。
 *   - fallbackModel 必须真正传给下一次 LLM.complete（不能只写日志）；
 *   - prompt_too_long 连续压缩有上限（默认 3 次），超过抛结构化错误，不得无限循环。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callWithRetry, PromptTooLongError, isRetryableError } from '../src/core/recovery.js';
import type { LlmClient, LlmResult } from '../src/llm/client.js';

class RateLimitError extends Error {
  status = 429;
}

class TooLongError extends Error {
  error = { type: 'prompt_too_long' };
}

/** 记录每次 complete 收到的 model 参数的假 LLM。 */
function makeRecordingLlm(behavior: (call: number, model?: string) => LlmResult): {
  llm: LlmClient;
  models: Array<string | undefined>;
} {
  const models: Array<string | undefined> = [];
  let call = 0;
  const llm: LlmClient = {
    complete: async (params) => {
      call += 1;
      models.push(params.model);
      return behavior(call, params.model);
    },
  };
  return { llm, models };
}

const okResult: LlmResult = { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', model: 'm' };

test('连续 429 后切换到 fallback 模型，且 fallback 真正传给 complete', async () => {
  const { llm, models } = makeRecordingLlm((call, model) => {
    /* 前 2 次（主模型）429；切到 fallback 后成功 */
    if (model !== 'fallback-model' && call <= 2) throw new RateLimitError('rate limited');
    return { ...okResult, model: model ?? 'primary' };
  });

  let switched: string | null = null;
  const result = await callWithRetry(
    (modelOverride) =>
      llm.complete({ system: '', messages: [], tools: [], maxTokens: 100, model: modelOverride ?? 'primary' }),
    { llm, fallbackModel: 'fallback-model', retryDelayMs: 1, log: () => {} },
    { onPromptTooLong: async () => [], onModelSwitch: (m) => (switched = m) },
  );

  assert.equal(switched, 'fallback-model', '应触发 onModelSwitch');
  assert.equal(result.model, 'fallback-model', '成功的一次必须跑在 fallback 模型上');
  /* complete 实际收到过 fallback 模型（不是只写日志） */
  assert.ok(models.includes('fallback-model'), `complete 收到的 model 序列: ${JSON.stringify(models)}`);
  /* 前两次是主模型 */
  assert.equal(models[0], 'primary');
  assert.equal(models[1], 'primary');
});

test('无 fallbackModel 时 429 重试直到上限后抛出原错误', async () => {
  const { llm } = makeRecordingLlm(() => {
    throw new RateLimitError('still limited');
  });
  await assert.rejects(
    () =>
      callWithRetry((m) => llm.complete({ system: '', messages: [], tools: [], maxTokens: 100, model: m }), {
        llm,
        retryDelayMs: 1,
        maxAttempts: 3,
        log: () => {},
      }),
    (err: unknown) => isRetryableError(err),
  );
});

test('prompt_too_long 连续压缩超过上限 → PromptTooLongError（不无限循环）', async () => {
  let compactCalls = 0;
  const { llm } = makeRecordingLlm(() => {
    /* 永远 prompt_too_long：若没有上限将无限循环 */
    throw new TooLongError('prompt is too long');
  });

  const start = Date.now();
  await assert.rejects(
    () =>
      callWithRetry(
        (m) => llm.complete({ system: '', messages: [], tools: [], maxTokens: 100, model: m }),
        { llm, retryDelayMs: 1, maxPromptTooLongCompacts: 2, log: () => {} },
        {
          onPromptTooLong: async () => {
            compactCalls += 1;
            return [];
          },
          onModelSwitch: () => {},
        },
      ),
    (err: unknown) => err instanceof PromptTooLongError && err.compacts === 2,
  );
  assert.equal(compactCalls, 2, '压缩只应执行上限次数');
  assert.ok(Date.now() - start < 5000, '不得陷入无限循环');
});

test('prompt_too_long 压缩一次后成功 → 正常返回', async () => {
  let compactCalls = 0;
  const { llm } = makeRecordingLlm((call) => {
    if (call === 1) throw new TooLongError('too long');
    return okResult;
  });
  const result = await callWithRetry(
    (m) => llm.complete({ system: '', messages: [], tools: [], maxTokens: 100, model: m }),
    { llm, retryDelayMs: 1, log: () => {} },
    {
      onPromptTooLong: async () => {
        compactCalls += 1;
        return [];
      },
      onModelSwitch: () => {},
    },
  );
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(compactCalls, 1);
});
