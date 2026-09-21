import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionGate } from '../src/core/permission.js';
import { loadPermissionSettings } from '../src/core/permissionSettings.js';

function makeGate(mode: 'ask' | 'auto' | 'deny', workdir: string, asks: string[] = []): PermissionGate {
  return new PermissionGate({
    mode,
    ask: async (q) => {
      asks.push(q);
      return false;
    },
    settings: loadPermissionSettings(workdir),
  });
}

test('settings: 工具级 deny 直接拒绝（即使 auto 模式）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { Bash: 'deny' } }));
  const gate = makeGate('auto', dir);
  const r = await gate.check('bash', { command: 'echo hi' }, { workdir: dir });
  assert.equal(r.allow, false);
  assert.ok(r.reason.includes('denied'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings: 工具级 allow 直接放行（即使 ask 模式）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { Write: 'allow' } }));
  const gate = makeGate('ask', dir);
  const r = await gate.check('write_file', { path: 'a.txt', content: 'x' }, { workdir: dir });
  assert.equal(r.allow, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings: denyRules 按内容匹配', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ denyRules: { Bash: 'rm -rf' } }));
  const gate = makeGate('auto', dir);
  const r = await gate.check('bash', { command: 'rm -rf foo' }, { workdir: dir });
  assert.equal(r.allow, false);
  // 不匹配的命令放行
  const r2 = await gate.check('bash', { command: 'ls' }, { workdir: dir });
  assert.equal(r2.allow, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings: disabledTools 禁用整个工具', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ disabledTools: ['Bash'] }));
  const gate = makeGate('auto', dir);
  const r = await gate.check('bash', { command: 'ls' }, { workdir: dir });
  assert.equal(r.allow, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings: 高优先级 local 覆盖 project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { Bash: 'deny' } }));
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { Bash: 'allow' } }),
  );
  const gate = makeGate('ask', dir);
  const r = await gate.check('bash', { command: 'echo hi' }, { workdir: dir });
  assert.equal(r.allow, true, 'local 应覆盖 project');
  fs.rmSync(dir, { recursive: true, force: true });
});
