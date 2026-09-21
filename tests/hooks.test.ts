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

test('trigger returns first non-undefined result', async () => {
  const reg = new HookRegistry();
  reg.register('Stop', () => undefined);
  reg.register('Stop', () => ({ forceContinue: true }));
  const result = await reg.trigger('Stop', { messagesCount: 1 });
  assert.deepEqual(result, { forceContinue: true });
});
