import test from 'node:test';
import assert from 'node:assert/strict';
import { YoloClassifier } from '../src/core/yoloClassifier.js';
import { MockLlm } from '../src/llm/mock.js';

function makeYolo(script: Array<{ verdict: string }>, opts: { maxConsecutiveUnsafe?: number } = {}): YoloClassifier {
  const llm = new MockLlm({
    script: script.map((s) => ({
      blocks: [
        {
          type: 'tool_use',
          name: 'classify_permission',
          input: { verdict: s.verdict, reason: 'test' },
        },
      ],
    })),
  });
  return new YoloClassifier({ llm, maxConsecutiveUnsafe: opts.maxConsecutiveUnsafe });
}

test('classify: safe 判定放行', async () => {
  const yolo = makeYolo([{ verdict: 'safe' }]);
  assert.equal(await yolo.classify('bash', { command: 'git log' }, '/tmp'), 'safe');
});

test('classify: unsafe 判定转审批', async () => {
  const yolo = makeYolo([{ verdict: 'unsafe' }]);
  assert.equal(await yolo.classify('bash', { command: 'rm -rf x' }, '/tmp'), 'unsafe');
});

test('classify: 连续 unsafe 达阈值后回退 skip（人工接管）', async () => {
  const yolo = makeYolo([{ verdict: 'unsafe' }, { verdict: 'unsafe' }, { verdict: 'unsafe' }, { verdict: 'unsafe' }], {
    maxConsecutiveUnsafe: 3,
  });
  assert.equal(await yolo.classify('bash', { command: 'a' }, '/tmp'), 'unsafe');
  assert.equal(await yolo.classify('bash', { command: 'b' }, '/tmp'), 'unsafe');
  assert.equal(await yolo.classify('bash', { command: 'c' }, '/tmp'), 'unsafe');
  assert.equal(await yolo.classify('bash', { command: 'd' }, '/tmp'), 'skip');
});

test('classify: 相同输入命中缓存（不重复调 LLM）', async () => {
  const llm = new MockLlm({
    script: [
      {
        blocks: [{ type: 'tool_use', name: 'classify_permission', input: { verdict: 'safe', reason: 'x' } }],
      },
    ],
  });
  const yolo = new YoloClassifier({ llm });
  await yolo.classify('bash', { command: 'git status' }, '/tmp');
  await yolo.classify('bash', { command: 'git status' }, '/tmp');
  assert.equal(llm.turnsConsumed, 1, '第二次应命中缓存');
});

test('classify: LLM 失败时返回 skip（不阻塞）', async () => {
  const llm = new MockLlm({});
  const yolo = new YoloClassifier({ llm });
  const r = await yolo.classify('bash', { command: 'x' }, '/tmp');
  assert.equal(r, 'skip');
});
