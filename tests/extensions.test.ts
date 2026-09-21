import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageBus, Teammate } from '../src/tools/teams.js';
import { TaskSystem } from '../src/tools/tasks.js';
import { Agent } from '../src/core/agent.js';
import { HookRegistry } from '../src/core/hooks.js';
import { PermissionGate } from '../src/core/permission.js';
import { ToolRegistry } from '../src/core/registry.js';
import { Transcript } from '../src/core/transcript.js';
import { MemoryStore } from '../src/core/memory.js';
import { MockLlm } from '../src/llm/mock.js';
import { loadConfig } from '../src/config.js';
import { selfReview } from '../src/tools/reflexion.js';
import type { Session } from '../src/types.js';

test('权限冒泡: 队友发 permission_request 给 Lead，收到 allow 后返回 true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bubble-'));
  const bus = new MessageBus(dir);
  bus.ensureAgent('lead');
  const config = loadConfig({ workspaceDir: dir, mock: true, permissionMode: 'auto' });
  const llm = new MockLlm({});
  const session: Session = {
    id: 'mate-bob',
    cwd: dir,
    baseSystem: 'x',
    messages: [],
    todos: [],
    startTime: Date.now(),
  };
  const tasks = new TaskSystem(path.join(dir, '.tasks'));
  const agent = new Agent({
    config,
    llm,
    registry: new ToolRegistry(),
    hooks: new HookRegistry(),
    permission: new PermissionGate({ mode: 'auto', ask: async () => false }),
    session,
    transcript: new Transcript(path.join(dir, '.transcripts'), 'mate-bob'),
    memory: new MemoryStore(path.join(dir, '.memory')),
    ask: async () => false,
    log: () => {},
    autoMemory: false,
  });
  const mate = new Teammate({ name: 'bob', bus, agent, tasks, maxRounds: 1 });

  // 异步发起冒泡，模拟 Lead 回复
  const p = mate.bubbleAsk('允许写文件吗?');
  // 等 request 到达 lead
  await new Promise((r) => setTimeout(r, 100));
  const reqs = await bus.drain('lead');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].type, 'permission_request');
  // Lead 回复 allow
  bus.send({ type: 'permission_response', from: 'lead', to: 'bob', requestId: reqs[0].requestId, text: 'allow' });
  const ok = await p;
  assert.equal(ok, true);

  // 第二个请求 Lead 回复 deny
  const p2 = mate.bubbleAsk('允许删除吗?');
  await new Promise((r) => setTimeout(r, 100));
  const reqs2 = await bus.drain('lead');
  bus.send({ type: 'permission_response', from: 'lead', to: 'bob', requestId: reqs2[0].requestId, text: 'deny' });
  const ok2 = await p2;
  assert.equal(ok2, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selfReview: 返回 LLM 评审意见', async () => {
  const llm = new MockLlm({
    script: [{ blocks: [{ type: 'text', text: '代码缺少空值检查，建议补充 try/catch' }] }],
  });
  const r = await selfReview({ kind: 'text', text: 'const x = obj.field.value;' }, llm);
  assert.ok(r.includes('空值检查'));
});

test('selfReview: 无问题时明确说明', async () => {
  const llm = new MockLlm({
    script: [{ blocks: [{ type: 'text', text: '未发现问题，代码完整正确' }] }],
  });
  const r = await selfReview({ kind: 'text', text: 'return 1;' }, llm);
  assert.ok(r.includes('未发现问题'));
});
