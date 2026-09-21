/**
 * P2 回归：真实业务执行效率。
 *   - 重复工具调用检测：同一命令连续执行超过 2 次 → 拦截并要求换策略
 *     （验收：同一命令不得连续执行 4 次，实际只执行 2 次）；
 *   - CSV 分析业务验收：mock 剧本高效完成（少量 LLM 调用，无重复拦截）；
 *   - 结构化错误：失败命令返回 exit code + 输出尾部 + Hint，模型可一次修正；
 *   - Windows shell 选择：PowerShell cmdlet 自动走 powershell.exe（避免无效重试）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import { Sandbox, pickShellArgs, formatShellError } from '../src/core/sandbox.js';
import type { ScriptedTurn } from '../src/llm/mock.js';

test('重复调用拦截：同一命令连续第 3 次起被拦截（实际只执行 2 次）', async () => {
  const script: ScriptedTurn[] = [];
  const cmd = 'node append.js';
  /* 剧本：同一命令连续调用 4 次（模拟模型对失败命令的盲目重试），最后总结 */
  for (let i = 0; i < 4; i++) {
    script.push({ blocks: [{ type: 'tool_use', name: 'bash', input: { command: cmd } }] });
  }
  script.push({ blocks: [{ type: 'text', text: 'stopped and summarized' }] });

  const h = makeHarness({ script, permissionMode: 'bypass' });
  try {
    /* append.js：每次执行追加一行（用于统计真实执行次数） */
    fs.writeFileSync(path.join(h.workdir, 'append.js'), "require('fs').appendFileSync('count.txt', 'x\\n');\n", 'utf8');
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });

    await h.agent.run('run the command');

    const countFile = path.join(h.workdir, 'count.txt');
    const executions = fs.existsSync(countFile)
      ? fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length
      : 0;
    assert.equal(executions, 2, `同一命令最多实际执行 2 次，实际 ${executions} 次`);
    assert.ok(
      events.some((m) => m.includes('repeat-guard')),
      '应触发 repeat-guard 拦截事件',
    );
    /* 第 3/4 次调用收到的是结构化拦截信息（要求换策略），而不是执行结果 */
    const msgs = h.session.messages;
    const repeatErrors = msgs
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result' && b.content.includes('identical tool call repeated'));
    assert.equal(repeatErrors.length, 2, '第 3、4 次调用应收到拦截信息');
  } finally {
    h.cleanup();
  }
});

test('不同命令交替执行不受重复拦截影响', async () => {
  const h = makeHarness({
    permissionMode: 'bypass',
    script: [
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node a.js' } }] },
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node b.js' } }] },
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node a.js' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  try {
    fs.writeFileSync(path.join(h.workdir, 'a.js'), "require('fs').appendFileSync('a.txt','1\\n');", 'utf8');
    fs.writeFileSync(path.join(h.workdir, 'b.js'), "require('fs').appendFileSync('b.txt','1\\n');", 'utf8');
    await h.agent.run('go');
    const aCount = fs.readFileSync(path.join(h.workdir, 'a.txt'), 'utf8').split('\n').filter(Boolean).length;
    const bCount = fs.readFileSync(path.join(h.workdir, 'b.txt'), 'utf8').split('\n').filter(Boolean).length;
    assert.equal(aCount, 2, '交替执行的相同命令不视为连续重复');
    assert.equal(bCount, 1);
  } finally {
    h.cleanup();
  }
});

test('CSV 分析业务验收：2 轮 LLM 调用完成任务，无重复拦截', async () => {
  const h = makeHarness({
    permissionMode: 'bypass',
    script: [
      /* 第 1 轮：直接运行分析脚本（一次到位，不反复试错） */
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node analyze.js data.csv' } }] },
      /* 第 2 轮：总结 */
      { blocks: [{ type: 'text', text: 'CSV 分析完成：3 行数据，sales 合计 600。' }] },
    ],
  });
  try {
    fs.writeFileSync(path.join(h.workdir, 'data.csv'), 'name,sales\na,100\nb,200\nc,300\n', 'utf8');
    fs.writeFileSync(
      path.join(h.workdir, 'analyze.js'),
      `const fs = require('fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\\n').slice(1);
const total = rows.reduce((s, r) => s + Number(r.split(',')[1]), 0);
console.log('rows=' + rows.length + ' total=' + total);
`,
      'utf8',
    );
    const events: string[] = [];
    h.agent.setOnEvent((e) => {
      if (e.type === 'system') events.push(e.message);
    });

    const finalText = await h.agent.run('分析 data.csv 的销售数据');

    /* 业务结果正确 */
    assert.ok(finalText.includes('CSV 分析完成'), `最终回答: ${finalText}`);
    /* 效率：只用了 2 次 LLM 调用（剧本轮数），bash 只执行 1 次 */
    assert.equal(h.llm.turnsConsumed, 2, `应 2 轮完成，实际 ${h.llm.turnsConsumed}`);
    assert.ok(!events.some((m) => m.includes('repeat-guard')), '高效路径不应触发重复拦截');
  } finally {
    h.cleanup();
  }
});

test('结构化错误：失败命令返回 exit code + Hint（模型可一次修正）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-err-'));
  try {
    const sandbox = new Sandbox({ cwd: dir, timeoutMs: 30_000 });
    const out = await sandbox.run('node no-such-script-xyz.js');
    assert.ok(out.startsWith('Error: command failed'), `实际: ${out.slice(0, 120)}`);
    assert.ok(out.includes('exit code'), '应包含退出码');
    assert.ok(out.includes('Hint:'), '应包含修正提示');
    assert.ok(out.includes('Do NOT retry the identical command'), '应明确禁止原样重试');
    /* 成功命令不带 Error 前缀（用脚本文件，避免 cmd.exe 对 -e 内联代码的引号/括号歧义） */
    fs.writeFileSync(path.join(dir, 'ok.js'), 'console.log(123);', 'utf8');
    const ok = await sandbox.run('node ok.js');
    assert.ok(!ok.startsWith('Error'), `实际: ${ok}`);
    assert.ok(ok.includes('123'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatShellError: Windows 常见失败模式给出针对性 Hint', () => {
  const out = formatShellError('Get-Foo', 1, "'Get-Foo' is not recognized as an internal or external command");
  assert.ok(out.includes('powershell') || out.includes('PowerShell'), '应提示 shell 差异');
  const out2 = formatShellError('cat x', 1, 'permission denied');
  assert.ok(out2.includes('sudo') || out2.includes('权限'), '应提示权限处理');
});

test('pickShellArgs: Windows 下 PowerShell cmdlet 自动选择 powershell.exe', () => {
  const ps = pickShellArgs('Get-Content foo.txt | Select-String bar');
  const cmd = pickShellArgs('node script.js');
  if (process.platform === 'win32') {
    assert.ok(/powershell/i.test(ps.shell), `cmdlet 应走 powershell，实际 ${ps.shell}`);
    assert.ok(/cmd/i.test(cmd.shell), `普通命令应走 cmd.exe，实际 ${cmd.shell}`);
  } else {
    assert.equal(ps.shell, '/bin/sh');
    assert.equal(cmd.shell, '/bin/sh');
  }
});
