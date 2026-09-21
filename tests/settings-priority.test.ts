/**
 * P1 回归：settings 规则必须按 user < project < local < CLI < session 的
 * 优先级合并后再判断（修复 first-match-wins 导致低优先级 user allow
 * 压过高优先级 project/local deny 的缺陷）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionGate } from '../src/core/permission.js';
import { loadPermissionSettings, matchRules, type PermissionRule } from '../src/core/permissionSettings.js';

interface Env {
  workdir: string;
  fakeHome: string;
  prevUserProfile?: string;
  prevHome?: string;
}

function setup(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prio-'));
  const workdir = path.join(root, 'ws');
  const fakeHome = path.join(root, 'home');
  fs.mkdirSync(path.join(workdir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  return {
    workdir,
    fakeHome,
    prevUserProfile: process.env.USERPROFILE,
    prevHome: process.env.HOME,
  };
}

function teardown(env: Env): void {
  if (env.prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = env.prevUserProfile;
  if (env.prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.prevHome;
  fs.rmSync(path.dirname(env.workdir), { recursive: true, force: true });
}

function pointHome(env: Env): void {
  process.env.USERPROFILE = env.fakeHome;
  process.env.HOME = env.fakeHome;
}

function writeJson(file: string, obj: unknown): void {
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function gateFor(workdir: string): PermissionGate {
  return new PermissionGate({
    mode: 'auto',
    ask: async () => false,
    settings: loadPermissionSettings(workdir),
  });
}

test('优先级：user allow + project deny + local deny → deny', async () => {
  const env = setup();
  try {
    pointHome(env);
    writeJson(path.join(env.fakeHome, '.claude', 'settings.json'), { allowRules: { Bash: 'echo' } });
    writeJson(path.join(env.workdir, '.claude', 'settings.json'), { denyRules: { Bash: 'echo' } });
    writeJson(path.join(env.workdir, '.claude', 'settings.local.json'), { denyRules: { Bash: 'echo' } });
    const gate = gateFor(env.workdir);
    const r = await gate.check('bash', { command: 'echo hi' }, { workdir: env.workdir });
    assert.equal(r.allow, false, '高优先级 project/local deny 必须压过 user allow');
    assert.ok(r.reason.includes('denied'));
  } finally {
    teardown(env);
  }
});

test('优先级：project deny + local allow → allow（local 更高，allow 规则显式放行）', async () => {
  const env = setup();
  try {
    pointHome(env);
    writeJson(path.join(env.workdir, '.claude', 'settings.json'), { denyRules: { Bash: 'mytool' } });
    writeJson(path.join(env.workdir, '.claude', 'settings.local.json'), { allowRules: { Bash: 'mytool' } });
    const gate = gateFor(env.workdir);
    /* mytool 不在只读白名单：若无 local allow，将转审批（ask=false → 拒绝） */
    const r = await gate.check('bash', { command: 'mytool --run' }, { workdir: env.workdir });
    assert.equal(r.allow, true, 'local allow 必须压过 project deny 并显式放行');
    assert.ok(r.reason.includes('allowed by rule'));
  } finally {
    teardown(env);
  }
});

test('allow 规则不能绕过命令 deny list（纵深防御）', async () => {
  const env = setup();
  try {
    pointHome(env);
    writeJson(path.join(env.workdir, '.claude', 'settings.local.json'), { allowRules: { Bash: 'rm -rf' } });
    const gate = gateFor(env.workdir);
    const r = await gate.check('bash', { command: 'rm -rf /' }, { workdir: env.workdir });
    assert.equal(r.allow, false, 'deny list 优先于 settings allow');
    assert.ok(r.reason.includes('Blocked'));
  } finally {
    teardown(env);
  }
});

test('优先级：user deny + project allow → allow（project 更高）', async () => {
  const env = setup();
  try {
    pointHome(env);
    writeJson(path.join(env.fakeHome, '.claude', 'settings.json'), { denyRules: { Bash: 'echo' } });
    writeJson(path.join(env.workdir, '.claude', 'settings.json'), { allowRules: { Bash: 'echo' } });
    const gate = gateFor(env.workdir);
    const r = await gate.check('bash', { command: 'echo hi' }, { workdir: env.workdir });
    assert.equal(r.allow, true);
  } finally {
    teardown(env);
  }
});

test('优先级：CLI deny 压过 local allow；session allow 最高', async () => {
  const env = setup();
  try {
    pointHome(env);
    writeJson(path.join(env.workdir, '.claude', 'settings.local.json'), { allowRules: { Bash: 'echo' } });
    const cliDeny: PermissionRule = { toolName: 'Bash', ruleBehavior: 'deny', ruleContent: 'echo', source: 'cliArg' };
    const s1 = loadPermissionSettings(env.workdir, { cliArgRules: [cliDeny] });
    assert.equal(
      matchRules(s1.rules, 'Bash', JSON.stringify({ command: 'echo hi' })),
      'deny',
      'cliArg deny 应压过 local allow',
    );

    const sessionAllow: PermissionRule = {
      toolName: 'Bash',
      ruleBehavior: 'allow',
      ruleContent: 'echo',
      source: 'session',
    };
    const s2 = loadPermissionSettings(env.workdir, { cliArgRules: [cliDeny], sessionRules: [sessionAllow] });
    assert.equal(matchRules(s2.rules, 'Bash', JSON.stringify({ command: 'echo hi' })), 'allow', 'session allow 应最高');
  } finally {
    teardown(env);
  }
});

test('同一来源内：deny 强于 allow', () => {
  const rules: PermissionRule[] = [
    { toolName: 'Bash', ruleBehavior: 'allow', ruleContent: 'echo', source: 'project' },
    { toolName: 'Bash', ruleBehavior: 'deny', ruleContent: 'echo', source: 'project' },
  ];
  assert.equal(matchRules(rules, 'Bash', JSON.stringify({ command: 'echo hi' })), 'deny');
});

test('无命中规则 → null（不误伤）', () => {
  const rules: PermissionRule[] = [
    { toolName: 'Bash', ruleBehavior: 'deny', ruleContent: 'rm -rf', source: 'project' },
  ];
  assert.equal(matchRules(rules, 'Bash', JSON.stringify({ command: 'ls' })), null);
});
