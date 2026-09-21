import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';

test('agent loop runs tool script to completion and writes file', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'a.txt', content: 'hello' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  const text = await h.agent.run('write a.txt');
  assert.equal(text, 'done');
  assert.equal(h.llm.turnsConsumed, 2);
  assert.equal(fs.readFileSync(path.join(h.workdir, 'a.txt'), 'utf8'), 'hello');
  h.cleanup();
});

test('unknown tool returns error result and loop continues', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'no_such_tool', input: {} }] },
      { blocks: [{ type: 'text', text: 'recovered' }] },
    ],
  });
  const text = await h.agent.run('go');
  assert.equal(text, 'recovered');
  h.cleanup();
});

test('max_tokens escalates token budget then completes without appending partial', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' },
      { blocks: [{ type: 'text', text: 'complete' }] },
    ],
  });
  const text = await h.agent.run('go');
  assert.equal(text, 'complete');
  assert.equal(h.llm.turnsConsumed, 2);
  assert.equal(h.llm.calls[0].maxTokens, 8192);
  assert.equal(h.llm.calls[1].maxTokens, 8192 * 4);
  h.cleanup();
});

test('deny mode blocks write tools with permission error result', async () => {
  const h = makeHarness({
    permissionMode: 'deny',
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'x.txt', content: 'x' } }] },
      { blocks: [{ type: 'text', text: 'ok' }] },
    ],
  });
  await h.agent.run('write');
  assert.ok(!fs.existsSync(path.join(h.workdir, 'x.txt')));
  const last = h.session.messages[h.session.messages.length - 2];
  const blocks = Array.isArray(last.content) ? last.content : [];
  const result = blocks.find((b) => b.type === 'tool_result') as { content: string } | undefined;
  assert.ok(result?.content.includes('Permission denied'));
  h.cleanup();
});

test('Stop hook forceContinue keeps the loop running', async () => {
  const h = makeHarness({
    script: [{ blocks: [{ type: 'text', text: 'first' }] }, { blocks: [{ type: 'text', text: 'second' }] }],
  });
  let continueOnce = true;
  h.hooks.register('Stop', () => {
    if (continueOnce) {
      continueOnce = false;
      return { forceContinue: true };
    }
    return undefined;
  });
  const text = await h.agent.run('go');
  assert.equal(text, 'second');
  assert.equal(h.llm.turnsConsumed, 2);
  h.cleanup();
});
