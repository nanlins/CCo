/**
 * P2 回归：会话、插件和终端行为。
 *   - /resume 全量恢复：messages + todos + readFileState + session id + transcript；
 *   - 插件卸载按显示名或安装目录名都能找到目标；
 *   - 非 TTY 模式禁用 ANSI 清屏与装饰输出（支持连续管道命令）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { makeHarness, setTerminalSize } from './helpers.js';
import { Transcript } from '../src/core/transcript.js';
import { PluginMarket } from '../src/core/pluginMarket.js';
import { startRepl } from '../src/repl.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

test('/resume 全量恢复：messages + todos + readFileState + session id', async () => {
  const script: ScriptedTurn[] = [
    {
      blocks: [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: '分析数据', status: 'completed', activeForm: '分析数据中' },
              { content: '写报告', status: 'pending', activeForm: '写报告中' },
            ],
          },
        },
      ],
    },
    { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'a.txt', content: 'hello-a' } }] },
    { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } }] },
    { blocks: [{ type: 'text', text: 'done' }] },
  ];
  const h1 = makeHarness({ script, permissionMode: 'auto' });
  try {
    await h1.agent.run('do it');
    const originalId = h1.session.id;
    const originalTodos = JSON.parse(JSON.stringify(h1.session.todos));
    assert.ok(originalTodos.length >= 2, 'TodoWrite 应已写入 todos');

    /* run 结束后快照已落盘（v2：含 todos + readPaths） */
    const dir = path.join(h1.workdir, '.transcripts');
    const snapFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.messages.json'));
    assert.equal(snapFiles.length, 1, '应恰好有一个快照文件');
    const snapId = snapFiles[0].replace('.messages.json', '');
    const t = new Transcript(dir, snapId);
    const snap = t.loadSessionSnapshot();
    assert.ok(snap, '快照应存在');
    assert.equal(snap!.sessionId, originalId, '快照内 sessionId 应为 agent 会话 id');
    assert.ok((snap!.todos?.length ?? 0) >= 2, '快照应包含 todos');
    assert.ok(
      (snap!.readPaths ?? []).some((p) => p.endsWith('a.txt')),
      '快照应包含 readFileState 已读路径',
    );

    /* 新会话恢复（/resume 的核心逻辑） */
    const h2 = makeHarness({ permissionMode: 'auto' });
    try {
      h2.agent.restoreSession({
        sessionId: snap!.sessionId,
        messages: snap!.messages,
        todos: snap!.todos,
        readPaths: snap!.readPaths,
      });
      assert.equal(h2.session.id, originalId, 'session id 必须恢复');
      assert.deepEqual(h2.session.todos, originalTodos, 'todos 必须恢复');
      assert.equal(h2.session.messages.length, snap!.messages.length, 'messages 必须恢复');
      assert.ok(
        h2.agent.readFileState.snapshot().some((p) => p.endsWith('a.txt')),
        'readFileState 必须恢复（重读未变化文件可返回 stub）',
      );
    } finally {
      h2.cleanup();
    }
  } finally {
    h1.cleanup();
  }
});

test('快照兼容旧格式（纯 messages 数组）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-snap-'));
  try {
    const t = new Transcript(dir, 'legacy-session');
    /* 旧格式：直接写数组 */
    fs.writeFileSync(
      path.join(dir, 'legacy-session.messages.json'),
      JSON.stringify([{ role: 'user', content: 'hi' }]),
      'utf8',
    );
    const snap = t.loadSessionSnapshot();
    assert.ok(snap, '旧格式快照应可读');
    assert.equal(snap!.messages.length, 1);
    assert.equal(snap!.sessionId, 'legacy-session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('插件卸载：显示名与安装目录名都能命中', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plugin-'));
  try {
    /* plugin-a：manifest 显示名与目录名不同 */
    fs.mkdirSync(path.join(workdir, 'skills', 'plugin-a'), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, 'skills', 'plugin-a', 'plugin.json'),
      JSON.stringify({ name: 'My Cool Plugin', description: 'demo', version: '1.0.0' }),
      'utf8',
    );
    /* plugin-b：只有 SKILL.md frontmatter */
    fs.mkdirSync(path.join(workdir, 'skills', 'plugin-b'), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, 'skills', 'plugin-b', 'SKILL.md'),
      '---\nname: Beta Skill\ndescription: demo2\n---\n# Beta\n',
      'utf8',
    );
    const market = new PluginMarket(workdir);

    /* 按显示名卸载 */
    const r1 = market.uninstall('My Cool Plugin');
    assert.ok(r1.success, `按显示名卸载应成功: ${r1.message}`);
    assert.ok(!fs.existsSync(path.join(workdir, 'skills', 'plugin-a')), '目录应被删除');

    /* 按 SKILL.md 显示名卸载 */
    const r2 = market.uninstall('Beta Skill');
    assert.ok(r2.success, `按 SKILL.md 显示名卸载应成功: ${r2.message}`);
    assert.ok(!fs.existsSync(path.join(workdir, 'skills', 'plugin-b')));

    /* 按目录名卸载（重建后） */
    fs.mkdirSync(path.join(workdir, 'skills', 'plugin-c'), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, 'skills', 'plugin-c', 'plugin.json'),
      JSON.stringify({ name: 'Gamma', description: 'd' }),
      'utf8',
    );
    const r3 = market.uninstall('plugin-c');
    assert.ok(r3.success, `按目录名卸载应成功: ${r3.message}`);

    /* 未知名称 */
    const r4 = market.uninstall('no-such-plugin');
    assert.ok(!r4.success);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('非 TTY 模式：输出无 ANSI 转义、无清屏（支持管道）', async () => {
  const h = makeHarness();
  const input = new PassThrough();
  const output = new PassThrough();
  setTerminalSize(output);
  let buf = '';
  output.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  try {
    const repl = startRepl({
      agent: h.agent,
      banner: '小锤 Anvil — MOCK | mode=auto | workdir=/tmp',
      input,
      output, // PassThrough 无 isTTY → 非 TTY 素模式
    });
    input.write('/help\n');
    await new Promise((r) => setTimeout(r, 300));
    input.end();
    await Promise.race([repl, new Promise((_, rej) => setTimeout(() => rej(new Error('REPL 未退出')), 5000))]);
    assert.ok(buf.length > 0, '应有输出');
    assert.ok(
      !buf.includes('\x1b['),
      `非 TTY 输出不得含 ANSI 转义序列（前 200 字符）: ${JSON.stringify(buf.slice(0, 200))}`,
    );
    assert.ok(buf.includes('/help'), '帮助内容应正常输出');
  } finally {
    h.cleanup();
  }
});
