/**
 * P2 回归：cmd.exe 引号安全传参 + 环境变量名注入（不注入值）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickShellArgs, Sandbox } from '../src/core/sandbox.js';
import { assembleSystemPrompt } from '../src/core/prompt.js';

test('P2: cmd.exe 命令整体包裹引号并禁用 Node 转义（verbatim）', () => {
  const r = pickShellArgs('git commit -m "中文 消息"');
  if (process.platform === 'win32') {
    assert.equal(r.verbatim, true);
    assert.equal(r.args[r.args.length - 1], '"git commit -m "中文 消息""');
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
  } else {
    assert.equal(r.shell, '/bin/sh');
  }
});

test('P2: PowerShell cmdlet 仍走 powershell.exe 且不做 verbatim 包裹', () => {
  const r = pickShellArgs('Get-Content README.md');
  if (process.platform === 'win32') {
    assert.equal(r.shell, 'powershell.exe');
    assert.equal(r.args[r.args.length - 1], 'Get-Content README.md');
    assert.notEqual(r.verbatim, true);
  } else {
    assert.equal(r.shell, '/bin/sh');
  }
});

test('P2: 环境变量名注入系统提示（含变量名与防探测指引）', () => {
  const prompt = assembleSystemPrompt({
    base: 'BASE',
    workdir: '/w',
    mode: 'ask',
    tools: [],
    envVars: ['REDIS_URL', 'PG_CONNECTION_STRING'],
  });
  assert.match(prompt, /Environment variables/);
  assert.match(prompt, /REDIS_URL/);
  assert.match(prompt, /PG_CONNECTION_STRING/);
  assert.match(prompt, /Do not probe default ports/);
});

test('P2: 无环境变量时不渲染该段', () => {
  const prompt = assembleSystemPrompt({ base: 'B', workdir: '/w', mode: 'ask', tools: [] });
  assert.ok(!prompt.includes('Environment variables'));
});

test('P1-2: Sandbox.runWithExit 返回真实退出码（0 与非 0）', async () => {
  const s = new Sandbox({ cwd: process.cwd() });
  const ok = await s.runWithExit(`node -e "process.exit(0)"`);
  assert.equal(ok.exitCode, 0);
  const fail = await s.runWithExit(`node -e "process.exit(3)"`);
  assert.equal(fail.exitCode, 3);
  assert.match(fail.output, /Error/);
});
