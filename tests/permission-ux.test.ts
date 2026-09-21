/**
 * P1 回归：权限审批体验。
 *   - `2>/dev/null`、`2>&1`、`>NUL` 不按危险写入处理（不触发询问）；
 *   - 明确只读命令保留自动放行（不退回到一律询问）；
 *   - 连续同类命令批量授权：回答 a 后，同类命令（按段首命令名）本任务内不再询问。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGate } from '../src/core/permission.js';
import { classifyShellCommand } from '../src/core/commandClassifier.js';
import { makeHarness } from './helpers.js';

test('stderr/NUL 重定向豁免：不触发危险写入询问', async () => {
  const h = makeHarness();
  try {
    let asked = 0;
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => {
        asked += 1;
        return true;
      },
    });
    /* 只读命令 + stderr 重定向 → 仍然是 safe，自动放行，不询问 */
    for (const cmd of ['git status 2>/dev/null', 'ls -la 2>&1', 'git log --oneline 2>nul']) {
      const d = await gate.check('bash', { command: cmd }, { workdir: h.workdir });
      assert.equal(d.allow, true, `${cmd} 应放行`);
      assert.ok(!d.asked, `${cmd} 不应询问`);
    }
    assert.equal(asked, 0, 'stderr/NUL 重定向不得触发询问');

    /* echo + >NUL（空设备）→ 无写入副作用，不询问 */
    const d2 = await gate.check('bash', { command: 'echo hi >NUL' }, { workdir: h.workdir });
    assert.equal(d2.allow, true);
    assert.ok(!d2.asked, '>NUL 不应触发询问');

    /* 分类器层面：stderr 重定向不产生写重定向目标 */
    const cls = classifyShellCommand('git status 2>/dev/null', h.workdir);
    assert.equal(cls.verdict, 'safe');
  } finally {
    h.cleanup();
  }
});

test('真实写入重定向仍然受控（> 到工作区外 deny，工作区内 ask）', async () => {
  const h = makeHarness();
  try {
    const gate = new PermissionGate({ mode: 'auto', ask: async () => false });
    const dOut = await gate.check('bash', { command: 'echo x > ..\\evil.txt' }, { workdir: h.workdir });
    assert.equal(dOut.allow, false, '越出工作区的重定向必须 deny');
    let asked = 0;
    const gate2 = new PermissionGate({
      mode: 'auto',
      ask: async () => {
        asked += 1;
        return false;
      },
    });
    const dIn = await gate2.check('bash', { command: 'echo x > inside.txt' }, { workdir: h.workdir });
    assert.equal(asked, 1, '工作区内写入重定向应询问（这是真实写入，不豁免）');
    assert.equal(dIn.allow, false);
  } finally {
    h.cleanup();
  }
});

test('批量授权：回答 a 后同类命令本任务内不再询问', async () => {
  const h = makeHarness();
  try {
    const answers: string[] = ['a']; // 第一次回答 a（允许本任务同类命令）
    let choiceCalls = 0;
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => false,
      askChoice: async () => {
        choiceCalls += 1;
        return answers.shift() ?? 'n';
      },
    });
    /* node 非只读白名单 → 第一次询问 */
    const d1 = await gate.check('bash', { command: 'node analyze.js' }, { workdir: h.workdir });
    assert.equal(d1.allow, true, '回答 a 应放行');
    assert.equal(choiceCalls, 1, '第一次应询问');

    /* 同类命令（node ...）→ 批量授权生效，不再询问 */
    const d2 = await gate.check('bash', { command: 'node other-script.js --flag' }, { workdir: h.workdir });
    assert.equal(d2.allow, true);
    assert.equal(choiceCalls, 1, '批量授权后同类命令不得再次询问');
    assert.ok(d2.reason.includes('batch'), `reason 应标明批量授权: ${d2.reason}`);

    /* 不同类命令（python）→ 仍会询问 */
    const d3 = await gate.check('bash', { command: 'python x.py' }, { workdir: h.workdir });
    assert.equal(choiceCalls, 2, '不同类命令应重新询问');
    assert.equal(d3.allow, false); // 回答 n

    /* clearSessionApprovals 后重新询问（任务边界） */
    gate.clearSessionApprovals();
    await gate.check('bash', { command: 'node analyze.js' }, { workdir: h.workdir });
    assert.equal(choiceCalls, 3, '清空批量授权后应重新询问');
  } finally {
    h.cleanup();
  }
});

test('批量授权不适用于危险路径：deny list / 受保护路径优先', async () => {
  const h = makeHarness();
  try {
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => true,
      askChoice: async () => 'a',
    });
    /* 先授权 node */
    await gate.check('bash', { command: 'node a.js' }, { workdir: h.workdir });
    /* deny list 命令即使含已授权二进制也拒绝 */
    const d1 = await gate.check('bash', { command: 'node a.js && sudo rm x' }, { workdir: h.workdir });
    assert.equal(d1.allow, false, 'deny list 优先于批量授权');
    /* 重定向越界优先 */
    const d2 = await gate.check('bash', { command: 'node a.js > ..\\x.txt' }, { workdir: h.workdir });
    assert.equal(d2.allow, false, '重定向越界优先于批量授权');
  } finally {
    h.cleanup();
  }
});

test('明确只读命令保留自动放行（不退回到一律询问）', async () => {
  const h = makeHarness();
  try {
    let asked = 0;
    const gate = new PermissionGate({
      mode: 'auto',
      ask: async () => {
        asked += 1;
        return true;
      },
    });
    for (const cmd of ['git status', 'ls -la', 'cat README.md', 'grep -r foo src', 'Get-ChildItem src']) {
      const d = await gate.check('bash', { command: cmd }, { workdir: h.workdir });
      assert.equal(d.allow, true, `${cmd} 只读命令应自动放行`);
    }
    assert.equal(asked, 0, '只读白名单命令不得询问');
  } finally {
    h.cleanup();
  }
});
