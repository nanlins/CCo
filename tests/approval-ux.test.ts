/**
 * P1 回归：审批 UX（文件操作同类批量授权 / ask→auto 快捷切换 / 面板计时冻结）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGate } from '../src/core/permission.js';
import { renderApprovalCard, computeElapsedMs } from '../src/core/terminal.js';
import { makeHarness } from './helpers.js';

test('审批卡包含 [t] 切换 auto 选项', () => {
  const card = renderApprovalCard({ risk: 'r', request: 'q', askCount: 1, batch: 'write_file' });
  assert.ok(card.includes('[t]'), '含切换 auto 选项');
  assert.ok(card.includes('write_file'), '含同类操作名');
});

test('computeElapsedMs: 审批暂停期间冻结且不计入暂停时长', () => {
  assert.equal(computeElapsedMs(10_000, 0), 0);
  assert.equal(computeElapsedMs(10_000, 2_000), 8_000);
  /* 暂停中：冻结在暂停时刻 */
  assert.equal(computeElapsedMs(30_000, 2_000, 12_000, 0), 10_000);
  /* 已恢复：累计暂停时长被扣除 */
  assert.equal(computeElapsedMs(30_000, 2_000, 0, 12_000), 16_000);
});

test('文件操作同类批量授权：a 后同类不再询问，异类仍询问', async () => {
  const h = makeHarness();
  try {
    const answers = ['a', 'n'];
    let calls = 0;
    const gate = new PermissionGate({
      mode: 'ask',
      ask: async () => false,
      askChoice: async () => {
        calls += 1;
        return answers.shift() ?? 'n';
      },
    });
    const d1 = await gate.check('write_file', { path: 'a.txt', content: 'x' }, { workdir: h.workdir });
    assert.equal(d1.allow, true);
    assert.ok(d1.reason.includes('batch'), `reason 应标明批量授权: ${d1.reason}`);
    const d2 = await gate.check('write_file', { path: 'b.txt', content: 'y' }, { workdir: h.workdir });
    assert.equal(d2.allow, true);
    assert.equal(calls, 1, '同类 write_file 不应再询问');
    const d3 = await gate.check('delete_file', { path: 'a.txt' }, { workdir: h.workdir });
    assert.equal(d3.allow, false, '异类 delete_file 仍询问（回答 n）');
    assert.equal(calls, 2);
  } finally {
    h.cleanup();
  }
});

test('文件操作 t 快捷：本次放行并切换会话到 auto', async () => {
  const h = makeHarness();
  try {
    let calls = 0;
    const gate = new PermissionGate({
      mode: 'ask',
      ask: async () => false,
      askChoice: async () => {
        calls += 1;
        return 't';
      },
    });
    const d1 = await gate.check('write_file', { path: 'a.txt', content: 'x' }, { workdir: h.workdir });
    assert.equal(d1.allow, true);
    assert.equal(gate.getMode(), 'auto');
    const d2 = await gate.check('write_file', { path: 'b.txt', content: 'y' }, { workdir: h.workdir });
    assert.equal(d2.allow, true);
    assert.equal(calls, 1, '切到 auto 后工作区内写入不应再询问');
    assert.equal(d2.asked, undefined);
  } finally {
    h.cleanup();
  }
});

test('shell 审批 t 快捷：本次放行并切换会话到 auto', async () => {
  const h = makeHarness();
  try {
    let calls = 0;
    const gate = new PermissionGate({
      mode: 'ask',
      ask: async () => false,
      askChoice: async () => {
        calls += 1;
        return 't';
      },
    });
    const d = await gate.check('bash', { command: 'node analyze.js' }, { workdir: h.workdir });
    assert.equal(d.allow, true);
    assert.equal(gate.getMode(), 'auto');
    assert.equal(calls, 1);
  } finally {
    h.cleanup();
  }
});

test('clearSessionApprovals 清空文件工具批量授权（任务边界）', async () => {
  const h = makeHarness();
  try {
    let calls = 0;
    const gate = new PermissionGate({
      mode: 'ask',
      ask: async () => false,
      askChoice: async () => {
        calls += 1;
        return 'a';
      },
    });
    await gate.check('write_file', { path: 'a.txt', content: 'x' }, { workdir: h.workdir });
    gate.clearSessionApprovals();
    await gate.check('write_file', { path: 'b.txt', content: 'y' }, { workdir: h.workdir });
    assert.equal(calls, 2, '任务边界后应重新询问');
  } finally {
    h.cleanup();
  }
});

test('P1-1: auto 模式下非危险 shell 命令直接放行（不弹审批）', async () => {
  const h = makeHarness();
  try {
    let asked = 0;
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => {
        asked += 1;
        return false;
      },
    });
    const d = await gate.check('bash', { command: 'node x.js' }, { workdir: h.workdir });
    assert.equal(d.allow, true, 'auto 下非危险命令应放行');
    assert.equal(asked, 0, '不得触发审批');
    assert.ok(!d.asked);
    assert.match(d.reason, /auto/i);
  } finally {
    h.cleanup();
  }
});

test('P1-1: auto 模式下危险命令仍被拦截（deny 优先）', async () => {
  const h = makeHarness();
  try {
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => {
        throw new Error('不应询问危险命令');
      },
    });
    const d = await gate.check('bash', { command: 'rm -rf /' }, { workdir: h.workdir });
    assert.equal(d.allow, false);
  } finally {
    h.cleanup();
  }
});

test('P1-1: auto 模式下 classifier 判 unsafe 仍转人工审批', async () => {
  const h = makeHarness();
  try {
    let asked = 0;
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => {
        asked += 1;
        return false;
      },
      classifier: async () => 'unsafe',
    });
    const d = await gate.check('bash', { command: 'node x.js' }, { workdir: h.workdir });
    assert.equal(asked, 1, 'unsafe 必须询问');
    assert.equal(d.allow, false);
  } finally {
    h.cleanup();
  }
});

test('P1-1 事故回归：[t] 切 auto 后连续 shell 命令不再弹审批', async () => {
  const h = makeHarness();
  try {
    const answers = ['t'];
    let choiceCalls = 0;
    const gate = new PermissionGate({
      mode: 'ask',
      ask: async () => false,
      askChoice: async () => {
        choiceCalls += 1;
        return answers.shift() ?? 'n';
      },
    });
    const d1 = await gate.check('bash', { command: 'npm install' }, { workdir: h.workdir });
    assert.equal(d1.allow, true);
    assert.equal(gate.getMode(), 'auto');
    const d2 = await gate.check('bash', { command: 'node biz.js' }, { workdir: h.workdir });
    assert.equal(d2.allow, true);
    assert.equal(choiceCalls, 1, '切 auto 后同类非危险命令不得再次弹审批');
  } finally {
    h.cleanup();
  }
});
