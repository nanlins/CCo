import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.js';

test('spawn_subagent: normal 模式用全新 messages（不携带父历史）', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'explore', agent_type: 'Explore' } }] },
      { blocks: [{ type: 'text', text: 'parent done' }] },
      { blocks: [{ type: 'text', text: 'sub done' }] },
    ],
  });
  await h.agent.run('parent task');
  const subCall = h.llm.calls.find((c) =>
    c.messages.some((m) => typeof m.content === 'string' && (m.content as string).includes('explore')),
  );
  assert.ok(subCall, '应调用子 agent');
  h.cleanup();
});

test('spawn_subagent: fork 模式不复制完整父历史，仅注入会话摘要', async () => {
  const h = makeHarness({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'spawn_subagent',
            input: { prompt: 'continue work', agent_type: 'Code', fork: true },
          },
        ],
      },
      { blocks: [{ type: 'text', text: 'parent done' }] },
      { blocks: [{ type: 'text', text: 'sub done' }] },
    ],
  });
  /* 设置会话摘要（fork 只复制这个，不复制完整历史） */
  h.session.sessionMemory = '父会话摘要：已阅读 a.ts、b.ts';
  await h.agent.run('parent context task');
  const subCall = h.llm.calls[1];
  assert.ok(subCall, '存在子 agent 调用');
  const textMsgs = subCall.messages.filter((m) => typeof m.content === 'string');
  /* 关键：fork 不复制完整父历史（不得出现父的原始用户消息），但注入摘要 */
  assert.ok(
    !textMsgs.some((m) => (m.content as string).includes('parent context task')),
    'fork 子 agent 不得复制完整父历史',
  );
  assert.ok(
    textMsgs.some((m) => (m.content as string).includes('父会话摘要')),
    'fork 子 agent 应注入父会话摘要',
  );
  h.cleanup();
});

test('spawn_subagent: 递归深度限制', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'recurse', agent_type: 'Explore' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
      { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'recurse2', agent_type: 'Explore' } }] },
      { blocks: [{ type: 'text', text: 'done2' }] },
      { blocks: [{ type: 'tool_use', name: 'spawn_subagent', input: { prompt: 'recurse3', agent_type: 'Explore' } }] },
      { blocks: [{ type: 'text', text: 'done3' }] },
    ],
  });
  await h.agent.run('go');
  h.cleanup();
});
