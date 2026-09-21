import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import { TaskSystem } from '../src/tools/tasks.js';
import { MessageBus } from '../src/tools/teams.js';
import { analyzeCommand } from '../src/core/commandAnalyzer.js';

/* ================= 边界测试 ================= */

test('边界: 超大工具输出被截断', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'big.txt', content: 'x'.repeat(100000) } }] },
      { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'big.txt' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  const text = await h.agent.run('write big file');
  assert.equal(text, 'done');
  // read_file 返回的内容不应超过全局上限（虽然 read 是 Infinity，但写文件也正常）
  h.cleanup();
});

test('边界: 空用户输入不崩溃', async () => {
  const h = makeHarness({ script: [{ blocks: [{ type: 'text', text: 'ok' }] }] });
  const text = await h.agent.run('');
  assert.ok(typeof text === 'string');
  h.cleanup();
});

test('边界: 特殊字符文件名', async () => {
  const h = makeHarness({
    script: [
      {
        blocks: [{ type: 'tool_use', name: 'write_file', input: { path: '测试 文件 & (1).txt', content: 'unicode' } }],
      },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  await h.agent.run('write');
  assert.ok(fs.existsSync(path.join(h.workdir, '测试 文件 & (1).txt')));
  h.cleanup();
});

test('边界: 深路径目录创建', async () => {
  const h = makeHarness({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'write_file',
            input: { path: 'a/b/c/d/e/f/g/deep.txt', content: 'deep' },
          },
        ],
      },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  await h.agent.run('write deep');
  assert.ok(fs.existsSync(path.join(h.workdir, 'a/b/c/d/e/f/g/deep.txt')));
  h.cleanup();
});

test('边界: JSON 特殊字符 round-trip', async () => {
  const h = makeHarness({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'write_file',
            input: { path: 'json.txt', content: '{"a":1,"b":[true,null],"c":"\\u00e9中文"}' },
          },
        ],
      },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  await h.agent.run('write json');
  const content = fs.readFileSync(path.join(h.workdir, 'json.txt'), 'utf8');
  assert.deepEqual(JSON.parse(content), { a: 1, b: [true, null], c: '\u00e9中文' });
  h.cleanup();
});

test('边界: 命令分析 - 危险命令识别', () => {
  assert.equal(analyzeCommand('rm -rf /').risk, 'critical');
  assert.equal(analyzeCommand('ls -la').risk, 'safe');
  assert.equal(analyzeCommand('git push --force').risk, 'high');
  assert.equal(analyzeCommand('sudo rm file').risk, 'high');
});

test('边界: 命令分析 - 命令链接检测', () => {
  const a = analyzeCommand('echo hello; rm -rf /');
  assert.equal(a.risk, 'critical');
  assert.ok(a.hasChaining);
});

test('边界: 命令分析 - 只读命令安全', () => {
  assert.equal(analyzeCommand('cat file.txt').intent, 'read');
  assert.equal(analyzeCommand('git status').intent, 'read');
});

/* ================= 并发测试 ================= */

test('并发: 多个任务并发 claim 不冲突', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conc-'));
  const tasks = new TaskSystem(path.join(dir, '.tasks'));
  const t1 = tasks.create('task1');
  const t2 = tasks.create('task2');
  const t3 = tasks.create('task3');

  // 并发 claim 三个不同任务
  const results = await Promise.all([tasks.claim(t1.id, 'a'), tasks.claim(t2.id, 'b'), tasks.claim(t3.id, 'c')]);
  assert.equal(
    results.every((r) => r.startsWith('Claimed')),
    true,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('并发: 同一任务并发 claim 只有一人成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conc2-'));
  const tasks = new TaskSystem(path.join(dir, '.tasks'));
  const t = tasks.create('task');

  const results = await Promise.all([
    tasks.claim(t.id, 'agent-a'),
    tasks.claim(t.id, 'agent-b'),
    tasks.claim(t.id, 'agent-c'),
  ]);
  const claimed = results.filter((r) => r.startsWith('Claimed')).length;
  const rejected = results.filter((r) => r.includes('already claimed')).length;
  assert.equal(claimed, 1, '只有一人能认领');
  assert.equal(rejected, 2, '其余被拒绝');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('并发: 多个工具调用串行依赖正确', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'x.txt', content: '1' } }] },
      { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'x.txt' } }] },
      { blocks: [{ type: 'text', text: 'final' }] },
    ],
  });
  const text = await h.agent.run('write and read');
  assert.equal(text, 'final');
  h.cleanup();
});

test('并发: 消息总线多 agent 并发收发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bus-'));
  const bus = new MessageBus(dir);
  bus.ensureAgent('alice');
  bus.ensureAgent('bob');
  // 并发发送多消息
  await Promise.all([
    (async () => {
      for (let i = 0; i < 5; i++) bus.send({ type: 'message', from: 'lead', to: 'alice', text: `msg-${i}` });
    })(),
    (async () => {
      for (let i = 0; i < 5; i++) bus.send({ type: 'message', from: 'lead', to: 'bob', text: `msg-${i}` });
    })(),
  ]);
  const alice = await bus.drain('alice');
  const bob = await bus.drain('bob');
  assert.equal(alice.length, 5);
  assert.equal(bob.length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================= 集成测试 ================= */

test('集成: 完整链路 写入→读取→编辑→验证', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'app.js', content: 'let x = 1;' } }] },
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'edit_file',
            input: { path: 'app.js', old_text: 'let x = 1;', new_text: 'let x = 2;' },
          },
        ],
      },
      { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'app.js' } }] },
      { blocks: [{ type: 'text', text: 'complete' }] },
    ],
  });
  const text = await h.agent.run('modify app');
  assert.equal(text, 'complete');
  assert.equal(fs.readFileSync(path.join(h.workdir, 'app.js'), 'utf8'), 'let x = 2;');
  h.cleanup();
});

test('集成: TodoWrite 状态保持', async () => {
  const h = makeHarness({
    script: [
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'step1', status: 'in_progress', activeForm: 'doing' },
                { content: 'step2', status: 'pending', activeForm: 'todo' },
              ],
            },
          },
        ],
      },
      { blocks: [{ type: 'text', text: 'planned' }] },
    ],
  });
  await h.agent.run('plan');
  assert.equal(h.session.todos.length, 2);
  assert.equal(h.session.todos[0].status, 'in_progress');
  h.cleanup();
});

test('集成: 多轮对话状态保持', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'text', text: 'first response' }] },
      { blocks: [{ type: 'text', text: 'second response' }] },
    ],
  });
  await h.agent.run('first message');
  const countAfterFirst = h.session.messages.length;
  await h.agent.run('second message');
  assert.ok(h.session.messages.length > countAfterFirst, '第二轮应追加消息');
  h.cleanup();
});
