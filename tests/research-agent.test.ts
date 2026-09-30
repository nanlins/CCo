/**
 * 研究任务 agent 集成测试 —— 交付检查表提取、工具类别硬上限、低价值循环拦截。
 * 全程 MockLlm 离线运行，不依赖真实模型与网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

test('研究任务：run 开始时提取必答问题清单并写入 session.checklist', async () => {
  const script: ScriptedTurn[] = [{ blocks: [{ type: 'text', text: '报告' }] }];
  const h = makeHarness({ script, configOverrides: { researchMode: true } });
  try {
    await h.agent.run('阅读该项目，回答：它的沙箱隔离如何实现？底层进程通信的原理是什么？');
    assert.ok(h.session.checklist, '应提取 checklist');
    assert.ok(h.session.checklist.length >= 2, `应至少 2 个问题，实际 ${h.session.checklist?.length}`);
    assert.ok(
      h.session.checklist.some((q) => q.includes('沙箱')),
      '应含沙箱问题',
    );
  } finally {
    h.cleanup();
  }
});

test('研究任务：read_file 类别硬上限（超限被拦截，不执行）', async () => {
  /* 连续 5 次 read_file，类别上限 2 → 前 2 次执行，后 3 次返回 category budget exhausted */
  const script: ScriptedTurn[] = [
    ...[1, 2, 3, 4, 5].map((i) => ({
      blocks: [{ type: 'tool_use', name: 'read_file', input: { path: `f${i}.txt` } }],
    })),
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({
    script,
    configOverrides: { researchMode: true, maxReadFileCalls: 2 },
  });
  try {
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(h.workdir, `f${i}.txt`), `content${i}`, 'utf8');
    await h.agent.run('阅读该目录');

    const results = h.session.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    const ok = results.filter((b) => b.content.includes('content'));
    const blocked = results.filter((b) => b.content.includes('category budget exhausted'));
    assert.equal(ok.length, 2, `应恰好执行 2 次 read_file，实际 ${ok.length}`);
    assert.equal(blocked.length, 3, `应拦截 3 次越界 read_file，实际 ${blocked.length}`);
  } finally {
    h.cleanup();
  }
});

test('研究任务：同一路径反复诊断 → 低价值循环拦截（重定向回 list_files/read_file）', async () => {
  /* 对同一路径 read_file 用不同 limit 绕过"完全重复"守卫，命中路径级循环检测 */
  const script: ScriptedTurn[] = [
    ...[1, 2, 3, 4].map((i) => ({
      blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'same.txt', limit: i } }],
    })),
    { blocks: [{ type: 'text', text: '## 已完成检查\n-\n## 未完成检查\n-\n## 当前证据\n-\n## 风险项\n-' }] },
  ];
  const h = makeHarness({ script, configOverrides: { researchMode: true } });
  try {
    fs.writeFileSync(path.join(h.workdir, 'same.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });
    await h.agent.run('阅读该项目');

    const results = h.session.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    const blocked = results.filter((b) => b.content.includes('same path/object diagnosed'));
    assert.equal(results.length, 4, `应返回 4 个 read_file 结果，实际 ${results.length}`);
    assert.equal(blocked.length, 1, `第 4 次应被路径循环拦截，实际 ${blocked.length}`);
    assert.ok(
      events.some((m) => m.includes('low-value-loop')),
      `应有 low-value-loop 事件: ${events.join('|')}`,
    );
  } finally {
    h.cleanup();
  }
});
