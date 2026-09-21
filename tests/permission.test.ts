import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGate } from '../src/core/permission.js';
import { makeHarness } from './helpers.js';

test('gate 1: deny list blocks dangerous bash immediately', async () => {
  const h = makeHarness();
  const gate = new PermissionGate({ mode: 'auto', ask: async () => true });
  const d = await gate.check('bash', { command: 'rm -rf /' }, { workdir: h.workdir });
  assert.equal(d.allow, false);
  const d2 = await gate.check('bash', { command: 'sudo apt install x' }, { workdir: h.workdir });
  assert.equal(d2.allow, false);
  h.cleanup();
});

test('classifier: safe read command allowed in ask mode without asking', async () => {
  let asked = 0;
  const gate = new PermissionGate({
    mode: 'ask',
    ask: async () => {
      asked += 1;
      return true;
    },
  });
  const d = await gate.check('bash', { command: 'git status' }, { workdir: '.' });
  assert.equal(d.allow, true);
  assert.equal(asked, 0);
});

test('auto 模式：危险/未知命令必须人工审批，不再自动放行（P0 修复）', async () => {
  const h = makeHarness();
  let asked = 0;
  const askGate = new PermissionGate({
    mode: 'ask',
    ask: async () => {
      asked += 1;
      return true;
    },
  });
  const d = await askGate.check('bash', { command: 'del temp.txt' }, { workdir: h.workdir });
  assert.equal(d.allow, true);
  assert.equal(asked, 1);

  /* auto：危险命令转人工（ask 返回 false → 拒绝） */
  const autoGate = new PermissionGate({ mode: 'auto', ask: async () => false });
  const d2 = await autoGate.check('bash', { command: 'del temp.txt' }, { workdir: h.workdir });
  assert.equal(d2.allow, false, 'auto 模式不得自动放行危险命令');
  assert.equal(d2.reason, 'user denied');

  /* auto：未知命令同样转人工 */
  let askedAuto = 0;
  const autoGate2 = new PermissionGate({
    mode: 'auto',
    ask: async () => {
      askedAuto += 1;
      return true;
    },
  });
  const d3 = await autoGate2.check('bash', { command: 'node some-script.js' }, { workdir: h.workdir });
  assert.equal(d3.allow, true);
  assert.equal(askedAuto, 1, 'auto 模式下未知命令必须询问');

  /* auto：明确 safe 的只读命令仍然自动放行（不询问） */
  let askedSafe = 0;
  const autoGate3 = new PermissionGate({
    mode: 'auto',
    ask: async () => {
      askedSafe += 1;
      return false;
    },
  });
  const d4 = await autoGate3.check('bash', { command: 'git status' }, { workdir: h.workdir });
  assert.equal(d4.allow, true);
  assert.equal(askedSafe, 0, '明确 safe 命令不应询问');

  /* bypass：显式全放行模式（旧 auto 语义），不询问直接放行 */
  let askedBypass = 0;
  const bypassGate = new PermissionGate({
    mode: 'bypass',
    ask: async () => {
      askedBypass += 1;
      return false;
    },
  });
  const d5 = await bypassGate.check('bash', { command: 'del temp.txt' }, { workdir: h.workdir });
  assert.equal(d5.allow, true);
  assert.equal(askedBypass, 0);
  assert.ok(d5.reason.includes('bypass'));
  h.cleanup();
});

test('write tools: path escape denied always; in-workspace allowed in auto', async () => {
  const h = makeHarness();
  const gate = new PermissionGate({ mode: 'auto', ask: async () => true });
  const out = await gate.check('write_file', { path: '../escape.txt', content: 'x' }, { workdir: h.workdir });
  assert.equal(out.allow, false);
  const inside = await gate.check('write_file', { path: 'ok.txt', content: 'x' }, { workdir: h.workdir });
  assert.equal(inside.allow, true);
  h.cleanup();
});

test('read-only tools always allowed even in deny mode', async () => {
  const h = makeHarness();
  const gate = new PermissionGate({ mode: 'deny', ask: async () => false });
  const d = await gate.check('read_file', { path: 'x.txt' }, { workdir: h.workdir });
  assert.equal(d.allow, true);
  h.cleanup();
});

/* ---------- bg_run 与 bash 同一权限管线（P0 修复） ---------- */

test('bg_run: deny 模式必须拒绝', async () => {
  const h = makeHarness();
  const gate = new PermissionGate({ mode: 'deny', ask: async () => true });
  const d = await gate.check('bg_run', { command: 'node build.js' }, { workdir: h.workdir });
  assert.equal(d.allow, false, 'deny 模式下 bg_run 必须被拒绝');
  h.cleanup();
});

test('bg_run: 危险命令被 deny list 拦截（与 bash 相同）', async () => {
  const h = makeHarness();
  const gate = new PermissionGate({ mode: 'bypass', ask: async () => true });
  for (const cmd of ['rm -rf /', 'sudo reboot', 'del /s C:\\']) {
    const d = await gate.check('bg_run', { command: cmd }, { workdir: h.workdir });
    assert.equal(d.allow, false, `bg_run 必须拦截: ${cmd}`);
    assert.ok(d.reason.includes('Blocked'), `reason 应来自 deny list: ${d.reason}`);
  }
  h.cleanup();
});

test('bg_run: auto 模式下未知命令转人工审批', async () => {
  const h = makeHarness();
  let asked = 0;
  const gate = new PermissionGate({
    mode: 'auto',
    ask: async () => {
      asked += 1;
      return false;
    },
  });
  const d = await gate.check('bg_run', { command: 'python train.py' }, { workdir: h.workdir });
  assert.equal(d.allow, false);
  assert.equal(asked, 1, 'bg_run 未知命令必须询问');
  h.cleanup();
});

test('bg_run: safe 只读命令自动放行（与 bash 一致）', async () => {
  const h = makeHarness();
  let asked = 0;
  const gate = new PermissionGate({
    mode: 'auto',
    ask: async () => {
      asked += 1;
      return false;
    },
  });
  const d = await gate.check('bg_run', { command: 'git log --oneline' }, { workdir: h.workdir });
  assert.equal(d.allow, true);
  assert.equal(asked, 0);
  h.cleanup();
});

test('connect_mcp: deny 模式必须拒绝（P0 修复）', async () => {
  const h = makeHarness();
  const gate = new PermissionGate({ mode: 'deny', ask: async () => true });
  const d = await gate.check('connect_mcp', { name: 'echo' }, { workdir: h.workdir });
  assert.equal(d.allow, false);
  /* 其他模式交给执行器信任门 */
  const gate2 = new PermissionGate({ mode: 'auto', ask: async () => false });
  const d2 = await gate2.check('connect_mcp', { name: 'echo' }, { workdir: h.workdir });
  assert.equal(d2.allow, true);
  assert.ok(d2.reason.includes('trust gate'));
  h.cleanup();
});
