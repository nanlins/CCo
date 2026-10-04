/**
 * 只读命令越界 + pluginMarket 远程安装安全 回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyShellCommand } from '../src/core/commandClassifier.js';
import { PluginMarket } from '../src/core/pluginMarket.js';

const WD = process.cwd();

test('P0-1: PowerShell 只读 cmdlet 越界读工作区外 → deny', () => {
  const r = classifyShellCommand('Get-Content C:\\Windows\\win.ini', WD);
  assert.equal(r.verdict, 'deny');
});

test('P0-1: POSIX 只读命令越界读 → deny', () => {
  assert.equal(classifyShellCommand('cat /etc/passwd', WD).verdict, 'deny');
  assert.equal(classifyShellCommand('head ../../etc/hosts', WD).verdict, 'deny');
});

test('P0-1: 区内只读命令 → safe', () => {
  assert.equal(classifyShellCommand('Get-Content README.md', WD).verdict, 'safe');
  assert.equal(classifyShellCommand('cat src/index.ts', WD).verdict, 'safe');
  assert.equal(classifyShellCommand('grep foo src/index.ts', WD).verdict, 'safe');
  assert.equal(classifyShellCommand('ls', WD).verdict, 'safe');
});

test('P0-1: 含变量/波浪号目标无法静态验证 → ask', () => {
  assert.equal(classifyShellCommand('Get-Content $env:USERPROFILE\\x.txt', WD).verdict, 'ask');
  assert.equal(classifyShellCommand('cat ~/notes.md', WD).verdict, 'ask');
});

test('P0-1: extraReadRoots 内的目标放行', () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-extra-'));
  const file = path.join(extra, 'notes.md');
  fs.writeFileSync(file, 'x');
  const r = classifyShellCommand(`cat ${file}`, WD, [extra]);
  assert.equal(r.verdict, 'safe');
  fs.rmSync(extra, { recursive: true, force: true });
});

test('P1: pluginMarket registryStatus 未配置 → 明确提示', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pm-'));
  const market = new PluginMarket(dir);
  const s = market.registryStatus();
  assert.equal(s.configured, false);
  assert.match(s.hint, /ANVIL_PLUGIN_REGISTRY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P1: pluginMarket URL 安装拒绝路径穿越', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pm2-'));
  const market = new PluginMarket(dir);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ name: 'evil', files: { '../escape.md': 'x' } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const r = await market.install('https://example.com/evil.json');
    assert.equal(r.success, false);
    assert.match(r.message, /越界/);
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.md')));
  } finally {
    globalThis.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: pluginMarket URL 安装合法 JSON 插件包成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pm3-'));
  const market = new PluginMarket(dir);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ name: 'goodplug', files: { 'SKILL.md': '---\nname: goodplug\n---' } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const r = await market.install('https://example.com/good.json');
    assert.equal(r.success, true);
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'goodplug', 'SKILL.md')));
  } finally {
    globalThis.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
