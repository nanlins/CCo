/**
 * P2 回归：配额错误保存部分结果并保持进程存活。
 *   - Insufficient Balance / quota / 429（重试耗尽）→ 捕获、保存 checkpoint、
 *     输出结构化中断报告（已完成/未完成/证据/风险），不上抛（REPL 存活）；
 *   - 错误信息转为用户可理解提示，不直接暴露 API 响应原文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import { isFatalQuotaError, isRateLimitError, isQuotaError, humanizeLlmError } from '../src/core/recovery.js';
import { Transcript } from '../src/core/transcript.js';
import { MockLlm } from '../src/llm/mock.js';
import type { LlmClient, LlmCallParams, LlmResult } from '../src/llm/client.js';

class QuotaLlm implements LlmClient {
  constructor(private err: Error & { status?: number }) {}
  calls = 0;
  complete(_params: LlmCallParams): Promise<LlmResult> {
    this.calls += 1;
    return Promise.reject(this.err);
  }
}

test('isFatalQuotaError / isRateLimitError / humanizeLlmError 识别与转译（429/402 分离）', () => {
  const e402 = Object.assign(new Error('payment required'), { status: 402 });
  const e429 = Object.assign(new Error('rate limit'), { status: 429 });
  const eBalance = new Error('Insufficient Balance: please recharge');
  const eQuota = new Error('quota exceeded for this account');
  const e500 = Object.assign(new Error('internal error'), { status: 500 });
  /* 402/余额/quota → 致命配额；429 → 限流（非致命） */
  assert.ok(isFatalQuotaError(e402));
  assert.ok(isFatalQuotaError(eBalance));
  assert.ok(isFatalQuotaError(eQuota));
  assert.ok(!isFatalQuotaError(e429), '429 是限流，非致命配额');
  assert.ok(!isFatalQuotaError(e500), '500 非配额错误');
  assert.ok(isRateLimitError(e429));
  assert.ok(!isRateLimitError(e402));

  /* 供应商欠费真实变体：dashscope Arrearage(400) / opencode CreditsError(401) 也应识别为致命配额 */
  const eArrear = Object.assign(new Error('Access denied, please make sure your account is in good standing'), {
    status: 400,
    error: { type: 'Arrearage', message: 'overdue-payment' },
  });
  const eCredits = Object.assign(new Error('Insufficient balance. Manage your billing'), {
    status: 401,
    error: { type: 'CreditsError', message: 'Insufficient balance' },
  });
  assert.ok(isFatalQuotaError(eArrear), 'dashscope Arrearage 应识别为致命配额');
  assert.ok(isFatalQuotaError(eCredits), 'opencode CreditsError 应识别为致命配额');
  assert.ok(humanizeLlmError(eArrear).includes('余额不足'), 'Arrearage 应转译为余额不足');
  /* isQuotaError 兼容旧名 = isFatalQuotaError */
  assert.ok(isQuotaError(e402));
  assert.ok(!isQuotaError(e429));

  assert.ok(humanizeLlmError(eBalance).includes('余额不足'));
  assert.ok(humanizeLlmError(e429).includes('限流'));
  /* 402 与 429 的 UI 文案不同 */
  assert.notEqual(humanizeLlmError(e402), humanizeLlmError(e429));
  /* 不暴露原始 API 响应原文 */
  assert.ok(!humanizeLlmError(eBalance).includes('please recharge'));
});

test('Insufficient Balance：保存 checkpoint + 返回结构化中断报告 + 不上抛', async () => {
  const h = makeHarness({ permissionMode: 'bypass', configOverrides: { retryDelayMs: 1 } });
  try {
    const quotaErr = Object.assign(new Error('Insufficient Balance'), { status: 402 });
    h.agent.setLlm(new QuotaLlm(quotaErr));

    /* 先放一条工具证据进 messages，验证报告能收集证据 */
    h.session.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'grep 结果: src/a.ts:10 发现问题' }],
    });

    let threw = false;
    let report = '';
    try {
      report = await h.agent.run('审查代码');
    } catch {
      threw = true;
    }
    assert.equal(threw, false, '配额错误不得上抛（REPL 保持存活）');
    /* 结构化中断报告四部分 */
    for (const s of ['## 已完成检查', '## 未完成检查', '## 当前证据', '## 风险项']) {
      assert.ok(report.includes(s), `中断报告应含「${s}」`);
    }
    assert.ok(report.includes('余额不足'), '应使用转译后的友好提示');
    assert.ok(report.includes('grep 结果'), '报告应包含已收集的工具证据');
    /* 402 → quota_exhausted 状态 */
    assert.equal(h.agent.getRunStatus(), 'quota_exhausted');
    /* checkpoint 已保存 */
    const snapFile = path.join(h.workdir, '.transcripts', 'test.messages.json');
    assert.ok(fs.existsSync(snapFile), 'checkpoint 应存在');
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    assert.ok(snap.finalReport.includes('余额不足'), 'checkpoint 应含中断报告');
    assert.ok(Array.isArray(snap.messages) && snap.messages.length > 0);
  } finally {
    h.cleanup();
  }
});

test('429 重试耗尽：同样按配额中断处理（保活 + checkpoint）', async () => {
  const h = makeHarness({ permissionMode: 'bypass', configOverrides: { retryDelayMs: 1 } });
  try {
    const rateErr = Object.assign(new Error('rate limit reached'), { status: 429 });
    h.agent.setLlm(new QuotaLlm(rateErr));
    let threw = false;
    let report = '';
    try {
      report = await h.agent.run('go');
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    assert.ok(report.includes('## 风险项'));
    assert.ok(report.includes('限流') || report.includes('配额'));
    /* 429 → rate_limited（非 quota_exhausted） */
    assert.equal(h.agent.getRunStatus(), 'rate_limited');
  } finally {
    h.cleanup();
  }
});

test('REPL 存活：配额错误后 REPL 正常显示报告并可继续', async () => {
  const { PassThrough } = await import('node:stream');
  const { startRepl } = await import('../src/repl.js');
  const { setTerminalSize } = await import('./helpers.js');
  const h = makeHarness({ permissionMode: 'bypass', configOverrides: { retryDelayMs: 1 } });
  const input = new PassThrough();
  const output = new PassThrough();
  setTerminalSize(output);
  let buf = '';
  output.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  try {
    const quotaErr = Object.assign(new Error('Insufficient Balance'), { status: 402 });
    h.agent.setLlm(new QuotaLlm(quotaErr));
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=bypass | workdir=/tmp',
      input,
      output,
    });
    input.write('审查一下\n');
    await new Promise((r) => setTimeout(r, 400));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('REPL 挂起')), 5000))]);
    assert.ok(
      buf.includes('## 风险项') || buf.includes('余额不足'),
      `REPL 应显示中断报告，实际片段: ${buf.slice(-300)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('/retry 机制：配额中断后复用 checkpoint 重跑可继续完成', async () => {
  const h = makeHarness({ permissionMode: 'bypass', configOverrides: { retryDelayMs: 1 } });
  try {
    /* 1) 配额 LLM 触发中断：保存 checkpoint + 返回中断报告 */
    const quotaErr = Object.assign(new Error('Insufficient Balance'), { status: 402 });
    h.agent.setLlm(new QuotaLlm(quotaErr));
    const interrupted = await h.agent.run('审查代码');
    assert.ok(interrupted.includes('## 风险项'), '应返回中断报告');

    /* 2) 读取 checkpoint（模拟 /retry 的复用逻辑） */
    const snap = new Transcript(path.join(h.workdir, '.transcripts'), 'test').loadSessionSnapshot();
    assert.ok(snap, 'checkpoint 应存在');
    assert.ok(Array.isArray(snap!.messages) && snap!.messages.length > 0, 'checkpoint 应含 messages');

    /* 3) 换成正常 LLM，恢复 checkpoint 后自动续跑（/retry 的核心） */
    h.agent.setLlm(
      new MockLlm({
        script: [
          {
            blocks: [
              {
                type: 'text',
                text: '## 已完成检查\n- 完成\n## 未完成检查\n- 无\n## 当前证据\n- evidence\n## 风险项\n- 无',
              },
            ],
          },
        ],
      }),
    );
    h.agent.restoreSession({
      sessionId: snap!.sessionId,
      messages: snap!.messages,
      todos: snap!.todos,
      readPaths: snap!.readPaths,
    });
    const retried = await h.agent.run('（重试）请继续完成');
    assert.ok(retried.includes('## 已完成检查'), '重试后应产出结构化结论');
    /* 重试后的结果也写回 checkpoint */
    const snap2 = new Transcript(path.join(h.workdir, '.transcripts'), snap!.sessionId).loadSessionSnapshot();
    assert.ok(snap2 && snap2.messages.length > 0, '重试后应更新 checkpoint');
  } finally {
    h.cleanup();
  }
});
