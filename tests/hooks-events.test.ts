import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';

test('SessionStart / SessionEnd hook 触发', async () => {
  const h = makeHarness({
    script: [{ blocks: [{ type: 'text', text: 'done' }] }],
  });
  const events: string[] = [];
  h.hooks.register('SessionStart', (p) => {
    events.push(`start:${(p as { input: string }).input}`);
    return undefined;
  });
  h.hooks.register('SessionEnd', (p) => {
    events.push(`end:${(p as { sessionId: string }).sessionId}`);
    return undefined;
  });
  await h.agent.run('hello');
  assert.equal(events.length, 2);
  assert.ok(events[0].startsWith('start:hello'));
  assert.ok(events[1].startsWith('end:'));
  h.cleanup();
});

test('PreCompact / PostCompact hook 触发', async () => {
  const h = makeHarness({
    script: [{ blocks: [{ type: 'text', text: 'done' }] }],
  });
  const events: string[] = [];
  h.hooks.register('PreCompact', () => {
    events.push('pre');
    return undefined;
  });
  h.hooks.register('PostCompact', () => {
    events.push('post');
    return undefined;
  });
  await h.agent.run('go');
  assert.ok(events.includes('pre'));
  assert.ok(events.includes('post'));
  h.cleanup();
});

test('PreToolUse updatedInput 修改工具参数', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'a.txt', content: 'original' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  h.hooks.register('PreToolUse', (p) => {
    const payload = p as { toolName: string; args: Record<string, unknown> };
    if (payload.toolName === 'write_file' && payload.args.path === 'a.txt') {
      return { updatedInput: { path: 'b.txt', content: 'modified' } };
    }
    return undefined;
  });
  await h.agent.run('write');
  assert.ok(!fs.existsSync(path.join(h.workdir, 'a.txt')));
  assert.equal(fs.readFileSync(path.join(h.workdir, 'b.txt'), 'utf8'), 'modified');
  h.cleanup();
});

test('PostToolUseFailure 在工具异常时触发', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'missing.txt' } }] },
      { blocks: [{ type: 'text', text: 'recovered' }] },
    ],
  });
  let failed = false;
  h.hooks.register('PostToolUseFailure', (p) => {
    const payload = p as { toolName: string; error?: string };
    if (payload.toolName === 'read_file' && payload.error) failed = true;
    return undefined;
  });
  const text = await h.agent.run('read');
  assert.equal(text, 'recovered');
  assert.equal(failed, true, '应触发 PostToolUseFailure');
  h.cleanup();
});

test('Stop blockingError 注入自纠后继续', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'text', text: 'first answer' }] },
      { blocks: [{ type: 'text', text: 'fixed answer' }] },
    ],
  });
  let first = true;
  h.hooks.register('Stop', (_p) => {
    if (first) {
      first = false;
      return { blockingError: '回答不完整，需要包含验证步骤' };
    }
    return undefined;
  });
  const text = await h.agent.run('task');
  assert.equal(text, 'fixed answer');
  assert.equal(h.llm.turnsConsumed, 2);
  h.cleanup();
});
