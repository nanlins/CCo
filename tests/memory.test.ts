import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/core/memory.js';
import { MockLlm } from '../src/llm/mock.js';

function freshStore(): { store: MemoryStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mem-'));
  return { store: new MemoryStore(path.join(dir, '.memory')), dir };
}

test('save / catalog / load / forget round trip', () => {
  const { store, dir } = freshStore();
  store.save({ name: 'user-prefs', description: 'User prefers tabs', body: 'Always use tabs for indentation.' });
  assert.ok(store.catalog().includes('user-prefs'));
  assert.ok(store.load('user-prefs').includes('Always use tabs'));
  store.forget('user-prefs');
  assert.equal(store.catalog(), '（无记忆）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('search uses LLM to pick memories', async () => {
  const { store, dir } = freshStore();
  store.save({ name: 'tabs', description: 'tabs preference', body: 'use tabs' });
  store.save({ name: 'sql', description: 'sql style', body: 'uppercase keywords' });
  const llm = new MockLlm({ script: [{ blocks: [{ type: 'text', text: '["tabs"]' }] }] });
  const result = await store.search('indentation style?', llm);
  assert.ok(result.includes('use tabs'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('autoExtract saves durable facts from conversation tail', async () => {
  const { store, dir } = freshStore();
  const llm = new MockLlm({
    script: [
      {
        blocks: [
          {
            type: 'text',
            text: '[{"name":"use-tabs","description":"user preference","body":"User wants tabs over spaces"}]',
          },
        ],
      },
    ],
  });
  const saved = await store.autoExtract([{ role: 'user', content: 'please use tabs from now on' }], llm);
  assert.equal(saved, 1);
  assert.ok(store.catalog().includes('use-tabs'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('autoExtract: 结构化输出模式（tool_choice）', async () => {
  const { store, dir } = freshStore();
  const llm = new MockLlm({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'extract_memories',
            input: {
              memories: [
                { name: 'single-quotes', description: 'quote style', body: 'Use single quotes' },
                { name: 'no-mocks', description: 'testing rule', body: 'Never mock database' },
              ],
            },
          },
        ],
      },
    ],
  });
  const saved = await store.autoExtract([{ role: 'user', content: 'always single quotes, no db mocks' }], llm);
  assert.equal(saved, 2);
  assert.ok(store.catalog().includes('single-quotes'));
  assert.ok(store.catalog().includes('no-mocks'));
  assert.ok(llm.calls[0].structured?.name === 'extract_memories');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('search: 结构化输出选择记忆', async () => {
  const { store, dir } = freshStore();
  store.save({ name: 'tabs', description: 'tabs preference', body: 'use tabs' });
  const llm = new MockLlm({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'select_memories',
            input: { selected_memories: ['tabs'] },
          },
        ],
      },
    ],
  });
  const result = await store.search('indentation?', llm);
  assert.ok(result.includes('use tabs'));
  assert.ok(llm.calls[0].structured?.name === 'select_memories');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('consolidate: LLM 去重合并记忆', async () => {
  const { store, dir } = freshStore();
  store.save({ name: 'a', description: 'same fact', body: 'use tabs' });
  store.save({ name: 'b', description: 'same fact dup', body: 'tabs not spaces' });
  const llm = new MockLlm({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'consolidate_memories',
            input: {
              memories: [{ name: 'tabs-merged', description: 'merged fact', body: 'always use tabs' }],
            },
          },
        ],
      },
    ],
  });
  const r = await store.consolidate(llm);
  assert.equal(r.before, 2);
  assert.equal(r.after, 1);
  assert.ok(store.catalog().includes('tabs-merged'));
  assert.ok(!store.catalog().includes('a:'));
  assert.ok(llm.calls[0].structured?.name === 'consolidate_memories');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('consolidate: 门控 — 条目太少不合并', () => {
  const { store, dir } = freshStore();
  store.save({ name: 'a', description: 'x', body: 'y' });
  assert.equal(store.shouldConsolidate({ minEntries: 10 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('consolidate: 门控 — 时间间隔未到不合并', () => {
  const { store, dir } = freshStore();
  for (let i = 0; i < 12; i++) store.save({ name: `m${i}`, description: `d${i}`, body: `b${i}` });
  assert.equal(store.shouldConsolidate({ minEntries: 10 }), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
