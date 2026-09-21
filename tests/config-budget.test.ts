/**
 * 回归：零值配置语义 + 总 token 预算（输入/总量）。
 *   - envInt/envIntOrUndefined 接受 0 与负数；
 *   - normalizeBudgetLimit：0=不限制(Infinity)、负数=禁用(0)、缺省=fallback；
 *   - Agent 预算在"发起下一次 LLM 请求前"检查（含输入/总量），而非结果返回后。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeBudgetLimit } from '../src/config.js';
import { makeHarness } from './helpers.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

function countExecutions(workdir: string): number {
  const p = path.join(workdir, 'count.txt');
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

test('normalizeBudgetLimit: 0=不限制 / 负数=禁用 / 缺省=fallback / 正数=自身', () => {
  assert.equal(normalizeBudgetLimit(0, 80), Number.POSITIVE_INFINITY);
  assert.equal(normalizeBudgetLimit(-1, 80), 0);
  assert.equal(normalizeBudgetLimit(undefined, 80), 80);
  assert.equal(normalizeBudgetLimit(42, 80), 42);
});

test('loadConfig: 环境变量 0 / 负数 / 缺省 三种解析', () => {
  const KEY = 'MAX_TOOL_CALLS_PER_RUN';
  try {
    process.env[KEY] = '0';
    assert.equal(loadConfig({ workspaceDir: process.cwd(), mock: true }).maxToolCallsPerRun, 0, '0 应解析为 0');
    process.env[KEY] = '-1';
    assert.equal(loadConfig({ workspaceDir: process.cwd(), mock: true }).maxToolCallsPerRun, -1, '负数应被解析');
    delete process.env[KEY];
    assert.equal(
      loadConfig({ workspaceDir: process.cwd(), mock: true }).maxToolCallsPerRun,
      undefined,
      '缺省应为 undefined',
    );
  } finally {
    delete process.env[KEY];
  }
});

test('Agent 预算 0 = 不限制：多次工具调用不被拦截', async () => {
  const script: ScriptedTurn[] = [];
  for (let i = 0; i < 5; i++) {
    /* 命令各不相同，避免触发"重复调用"拦截（与本测试无关的机制） */
    script.push({ blocks: [{ type: 'tool_use', name: 'bash', input: { command: `node append.js run-${i}` } }] });
  }
  script.push({ blocks: [{ type: 'text', text: 'done' }] });
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxToolCallsPerRun: 0 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    await h.agent.run('go');
    assert.equal(countExecutions(h.workdir), 5, '0=不限制：5 次工具调用都应执行');
  } finally {
    h.cleanup();
  }
});

test('Agent 预算负数 = 禁用：一次都不执行，立即最终报告', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxToolCallsPerRun: -1 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const finalText = await h.agent.run('go');
    assert.equal(countExecutions(h.workdir), 0, '负数=禁用：不得执行任何工具');
    assert.ok(finalText.includes('## 已完成检查'), '应进入最终报告模式');
  } finally {
    h.cleanup();
  }
});

test('总 token 预算：请求前检查，达到上限立即最终报告', async () => {
  /* 第 1 轮 LLM 返回 usage(输入 200 + 输出 100)；累计总 token 300 超过预算 250 */
  const script: ScriptedTurn[] = [
    {
      blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }],
      usage: { inputTokens: 200, outputTokens: 100 },
    },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxRunTotalTokens: 250 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    const finalText = await h.agent.run('go');
    assert.ok(
      events.some((m) => m.includes('总 token 达到预算')),
      `应有总量预算事件: ${events.join('|')}`,
    );
    assert.ok(finalText.includes('## 已完成检查'));
    assert.equal(countExecutions(h.workdir), 1, '总量预算耗尽后不得继续执行工具（第 2 次 bash 应被拦截）');
  } finally {
    h.cleanup();
  }
});

test('输入 token 预算：请求前检查', async () => {
  const script: ScriptedTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }], usage: { inputTokens: 500 } },
    { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node append.js' } }] },
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({ script, permissionMode: 'bypass', configOverrides: { maxRunInputTokens: 400 } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt','x\\n');", 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    await h.agent.run('go');
    assert.ok(
      events.some((m) => m.includes('输入 token 达到预算')),
      `应有输入预算事件: ${events.join('|')}`,
    );
    assert.equal(countExecutions(h.workdir), 1);
  } finally {
    h.cleanup();
  }
});
