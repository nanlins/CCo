/**
 * P0 回归：完整命令分类器 —— 禁止"只看第一个 token"判定整条命令安全。
 * 验收要求：
 *   - `echo INJECTED > ..\pwn.txt` 必须拒绝，且 workspace 外不得出现文件；
 *   - `cd workspace && node write.js` 必须询问，不能零询问放行；
 *   - `type .env` 与 `Get-Content .env` 必须拒绝（密钥文件）；
 *   - bg_run 执行相同危险命令必须同样拒绝（与 bash 同一套逻辑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyShellCommand, splitShellSegments, extractRedirectTargets } from '../src/core/commandClassifier.js';
import { PermissionGate } from '../src/core/permission.js';
import { makeHarness } from './helpers.js';

/* ---------- 分类器单元行为 ---------- */

test('splitShellSegments: 引号感知分段（; && || | 换行）', () => {
  assert.deepEqual(splitShellSegments('a; b && c || d | e'), ['a', 'b', 'c', 'd', 'e']);
  /* 引号内的分隔符不是边界 */
  assert.deepEqual(splitShellSegments('echo "a && b" ; ls'), ['echo "a && b"', 'ls']);
  assert.deepEqual(splitShellSegments("echo 'x; y'"), ["echo 'x; y'"]);
});

test('extractRedirectTargets: 提取写重定向目标（引号外）', () => {
  assert.deepEqual(extractRedirectTargets('echo x > out.txt'), ['out.txt']);
  assert.deepEqual(extractRedirectTargets('echo x >> ..\\pwn.txt'), ['..\\pwn.txt']);
  assert.deepEqual(extractRedirectTargets('echo "a > b"'), []); // 引号内的 > 不是重定向
});

test('classifyShellCommand: 重定向目标越出工作区 → deny', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cls-'));
  try {
    for (const cmd of ['echo INJECTED > ..\\pwn.txt', 'echo x > ../pwn.txt', 'ls > C:\\temp\\out.txt']) {
      const cls = classifyShellCommand(cmd, workdir);
      assert.equal(cls.verdict, 'deny', `${cmd} 应 deny，实际 ${cls.verdict} (${cls.reason})`);
    }
    /* /dev/null 与 工作区内目标不 deny（工作区内写入转审批） */
    assert.notEqual(classifyShellCommand('echo x > /dev/null', workdir).verdict, 'deny');
    assert.equal(classifyShellCommand('echo x > inside.txt', workdir).verdict, 'ask');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('classifyShellCommand: 链接命令逐段判断，非只读段 → ask', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cls-'));
  try {
    /* cd 安全 + node 执行脚本非只读 → 整条命令 ask */
    assert.equal(classifyShellCommand('cd workspace && node write.js', workdir).verdict, 'ask');
    /* 全部只读 → safe */
    assert.equal(classifyShellCommand('git status && git log --oneline', workdir).verdict, 'safe');
    assert.equal(classifyShellCommand('ls | grep ts', workdir).verdict, 'safe');
    /* 只读命令 + 危险段 → ask（不得因第一段安全而整体放行） */
    assert.equal(classifyShellCommand('git status && npm run build', workdir).verdict, 'ask');
    /* 命令替换无法静态验证 → ask */
    assert.equal(classifyShellCommand('echo $(cat /etc/passwd)', workdir).verdict, 'ask');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('classifyShellCommand: 敏感文件（.env/密钥）读取 → deny', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cls-'));
  try {
    for (const cmd of ['type .env', 'cat .env', 'Get-Content .env', 'head -5 .env.production', 'grep KEY id_rsa']) {
      const cls = classifyShellCommand(cmd, workdir);
      assert.equal(cls.verdict, 'deny', `${cmd} 应 deny，实际 ${cls.verdict} (${cls.reason})`);
    }
    /* 非读命令引用敏感文件 → ask（不静默放行） */
    assert.equal(classifyShellCommand('cp .env backup.env', workdir).verdict, 'ask');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('classifyShellCommand: 只读白名单（git 子命令受限）', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cls-'));
  try {
    assert.equal(classifyShellCommand('git status', workdir).verdict, 'safe');
    assert.equal(classifyShellCommand('git log --oneline -5', workdir).verdict, 'safe');
    /* git push/commit 非只读 → ask */
    assert.equal(classifyShellCommand('git push origin main', workdir).verdict, 'ask');
    assert.equal(classifyShellCommand('git config user.name x', workdir).verdict, 'ask');
    /* find 带 -delete → ask（不得视为只读） */
    assert.equal(classifyShellCommand('find . -name "*.log" -delete', workdir).verdict, 'ask');
    assert.equal(classifyShellCommand('find . -name "*.ts"', workdir).verdict, 'safe');
    /* PowerShell 只读 cmdlet */
    assert.equal(classifyShellCommand('Get-ChildItem src', workdir).verdict, 'safe');
    assert.equal(classifyShellCommand('Test-Path a.txt', workdir).verdict, 'safe');
    /* PowerShell 写 cmdlet → ask */
    assert.equal(classifyShellCommand('New-Item evil.txt', workdir).verdict, 'ask');
    assert.equal(classifyShellCommand('Remove-Item a.txt', workdir).verdict, 'ask');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

/* ---------- 权限门集成：bash 与 bg_run 同一套逻辑 ---------- */

test('gate: 重定向逃逸命令 bash/bg_run 都拒绝（auto 模式也不放行）', async () => {
  const h = makeHarness();
  try {
    const gate = new PermissionGate({ mode: 'auto', ask: async () => true });
    for (const tool of ['bash', 'bg_run']) {
      const d = await gate.check(tool, { command: 'echo INJECTED > ..\\pwn.txt' }, { workdir: h.workdir });
      assert.equal(d.allow, false, `${tool} 必须拒绝重定向逃逸`);
      assert.ok(d.reason.includes('重定向'), `reason: ${d.reason}`);
    }
  } finally {
    h.cleanup();
  }
});

test('gate: `cd ws && node write.js` 必须询问（auto 模式不得零询问放行）', async () => {
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
    const d = await gate.check('bash', { command: 'cd workspace && node write.js' }, { workdir: h.workdir });
    assert.equal(asked, 1, '非只读命令必须询问');
    assert.equal(d.allow, false, 'ask 返回 false → 拒绝');
    /* bg_run 相同命令同样询问 */
    asked = 0;
    const d2 = await gate.check('bg_run', { command: 'cd workspace && node write.js' }, { workdir: h.workdir });
    assert.equal(asked, 1, 'bg_run 必须与 bash 同一套逻辑');
    assert.equal(d2.allow, false);
  } finally {
    h.cleanup();
  }
});

test('gate: `type .env` / `Get-Content .env` bash 与 bg_run 都拒绝', async () => {
  const h = makeHarness();
  try {
    const gate = new PermissionGate({ mode: 'auto', ask: async () => true });
    for (const tool of ['bash', 'bg_run']) {
      for (const cmd of ['type .env', 'Get-Content .env']) {
        const d = await gate.check(tool, { command: cmd }, { workdir: h.workdir });
        assert.equal(d.allow, false, `${tool} ${cmd} 必须拒绝`);
        assert.ok(d.reason.includes('敏感文件') || d.reason.includes('密钥'), `reason: ${d.reason}`);
      }
    }
  } finally {
    h.cleanup();
  }
});

test('端到端：agent 执行重定向逃逸命令被拒，workspace 外不产生文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
  const workdir = path.join(root, 'ws');
  fs.mkdirSync(workdir, { recursive: true });
  const h = makeHarness({
    permissionMode: 'auto',
    script: [
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'echo INJECTED > ..\\pwn.txt' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  try {
    /* makeHarness 的 workdir 是它自己的临时目录；这里直接复用 gate + 工具执行验证 */
    const gate = new PermissionGate({ mode: 'auto', ask: async () => false });
    const d = await gate.check('bash', { command: 'echo INJECTED > ..\\pwn.txt' }, { workdir });
    assert.equal(d.allow, false);
    /* 权限拒绝 → 沙箱从不执行 → 工作区外不得出现文件 */
    assert.ok(!fs.existsSync(path.join(root, 'pwn.txt')), 'workspace 外不得出现 pwn.txt');
    void h;
  } finally {
    h.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
