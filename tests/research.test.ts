/**
 * research.ts 单元测试 —— 只读研究任务的必答问题提取、任务识别、路径指纹与提示词构建。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQuestions,
  isResearchTask,
  pathFingerprint,
  buildResearchPrompt,
  PATH_REPEAT_LIMIT,
} from '../src/core/research.js';

test('extractQuestions：问号切分', () => {
  const q = extractQuestions('阅读该项目，回答：它是如何做沙箱隔离的？底层是如何实现进程通信的？');
  assert.ok(q.length >= 2, `应提取至少 2 个问题，实际 ${q.length}: ${q.join(' | ')}`);
  assert.ok(
    q.some((x) => x.includes('沙箱')),
    `应含沙箱问题: ${q.join(' | ')}`,
  );
});

test('extractQuestions：编号列表', () => {
  const q = extractQuestions('请回答以下问题：1. 它的路由机制是什么 2. 会话如何持久化 3. 工具权限如何校验');
  assert.ok(
    q.some((x) => x.includes('路由')),
    `应含编号1问题: ${q.join(' | ')}`,
  );
  assert.ok(
    q.some((x) => x.includes('持久化')),
    `应含编号2问题: ${q.join(' | ')}`,
  );
  assert.ok(
    q.some((x) => x.includes('权限')),
    `应含编号3问题: ${q.join(' | ')}`,
  );
});

test('extractQuestions：去重', () => {
  const q = extractQuestions('它的架构是什么？它的架构是什么？');
  const dup = q.filter((x) => x.includes('架构'));
  assert.equal(dup.length, 1, `应去重: ${q.join(' | ')}`);
});

test('isResearchTask：研究意图且无写代码意图 → true', () => {
  assert.equal(isResearchTask('阅读并分析该项目的运行逻辑'), true);
  assert.equal(isResearchTask('说明这个框架的架构与原理'), true);
});

test('isResearchTask：写代码意图 → false', () => {
  assert.equal(isResearchTask('实现一个登录功能'), false);
  assert.equal(isResearchTask('修复这个 bug'), false);
  assert.equal(isResearchTask('重构路由层'), false);
});

test('pathFingerprint：read_file 以路径为指纹', () => {
  assert.equal(pathFingerprint('read_file', { path: '/a/b.ts' }), 'read_file:/a/b.ts');
  assert.equal(pathFingerprint('read_file', { file_path: '/a/b.ts' }), 'read_file:/a/b.ts');
});

test('pathFingerprint：bash 无路径 → null', () => {
  assert.equal(pathFingerprint('bash', { command: 'ls -la' }), null);
});

test('buildResearchPrompt：含检查表与阅读优先级', () => {
  const p = buildResearchPrompt({ questions: ['Q1', 'Q2'], readingPriority: ['a.md', 'b.ts'] });
  assert.ok(p.includes('交付检查表'), '应含检查表标题');
  assert.ok(p.includes('Q1'), '应含 Q1');
  assert.ok(p.includes('a.md → b.ts'), '应含阅读优先级');
  assert.ok(p.includes('只读'), '应含只读约束');
});

test('PATH_REPEAT_LIMIT：低价值循环上限为 3', () => {
  assert.equal(PATH_REPEAT_LIMIT, 3);
});
