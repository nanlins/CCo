import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HookRegistry } from '../src/core/hooks.js';
import { makeHarness } from './helpers.js';

test('PreToolUse hook blocks tool execution', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'b.txt', content: 'x' } }] },
      { blocks: [{ type: 'text', text: 'fin' }] },
    ],
  });
  h.hooks.register('PreToolUse', () => ({ block: true, message: 'no writes today' }));
  await h.agent.run('write');
  assert.ok(!fs.existsSync(path.join(h.workdir, 'b.txt')));
  h.cleanup();
});

test('UserPromptSubmit hook can modify input', async () => {
  const h = makeHarness({ script: [{ blocks: [{ type: 'text', text: 'ok' }] }] });
  h.hooks.register('UserPromptSubmit', () => ({ modifiedInput: 'MODIFIED' }));
  await h.agent.run('original');
  const first = h.session.messages[0];
  assert.equal(first.content, 'MODIFIED');
  h.cleanup();
});

test('trigger 全部执行：第一个空、第二个 block → 合并为 block', async () => {
  const reg = new HookRegistry();
  let secondRan = false;
  reg.register('Stop', () => undefined);
  reg.register('Stop', () => {
    secondRan = true;
    return { block: true, blockingError: 'not done' };
  });
  const result = await reg.trigger('Stop', { messagesCount: 1 });
  assert.equal(secondRan, true, '第二个 hook 必须被执行');
  assert.equal(result?.block, true);
  assert.equal(result?.blockingError, 'not done');
});

test('trigger 合并：permissionBehavior 取最严格、消息拼接、updatedInput 浅合并', async () => {
  const reg = new HookRegistry();
  reg.register('PreToolUse', () => ({ permissionBehavior: 'allow', updatedInput: { a: 1 }, message: 'm1' }));
  reg.register('PreToolUse', () => ({ permissionBehavior: 'deny', updatedInput: { b: 2 }, message: 'm2' }));
  const r = await reg.trigger('PreToolUse', {});
  assert.equal(r?.permissionBehavior, 'deny');
  assert.deepEqual(r?.updatedInput, { a: 1, b: 2 });
  assert.match(r?.message ?? '', /m1[\s\S]*m2/);
});

test('单 hook 行为不变（返回原结果）', async () => {
  const reg = new HookRegistry();
  reg.register('Stop', () => undefined);
  reg.register('Stop', () => ({ forceContinue: true }));
  const result = await reg.trigger('Stop', { messagesCount: 1 });
  assert.deepEqual(result, { forceContinue: true });
});
