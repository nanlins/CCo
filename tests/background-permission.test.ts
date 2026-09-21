/**
 * P0 回归：bg_run 执行器层纵深防御 —— 即使权限层被绕过，
 * BackgroundSystem 也不得执行 deny list 命中的命令；
 * 超时/输出上限默认值与 bash(Sandbox) 一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundSystem, backgroundTools } from '../src/tools/background.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bg-'));
}

test('bg_run 执行器：deny list 命令直接返回 Error，不启动任务', async () => {
  const dir = tmp();
  try {
    const marker = path.join(dir, 'PWNED.txt');
    const bg = new BackgroundSystem({ cwd: dir });
    const bgRun = backgroundTools(bg).find((t) => t.schema.name === 'bg_run')!;
    const out = String(
      await bgRun.executor(
        { command: `rm -rf / && node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"` },
        {} as never,
      ),
    );
    assert.ok(out.startsWith('Error: Blocked'), `实际: ${out}`);
    assert.equal(bg.list().length, 0, '不得创建任务');
    assert.ok(!fs.existsSync(marker));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BackgroundSystem.start：deny list 命令抛错（任何调用路径都不得绕过）', () => {
  const dir = tmp();
  try {
    const bg = new BackgroundSystem({ cwd: dir });
    assert.throws(() => bg.start('sudo reboot'), /Blocked/);
    assert.throws(() => bg.start('rm -rf /'), /Blocked/);
    assert.equal(bg.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bg_run 执行器：正常命令启动成功', async () => {
  const dir = tmp();
  try {
    const bg = new BackgroundSystem({ cwd: dir });
    const bgRun = backgroundTools(bg).find((t) => t.schema.name === 'bg_run')!;
    const out = String(await bgRun.executor({ command: 'echo bg-ok' }, {} as never));
    assert.ok(out.startsWith('Started bg_'), `实际: ${out}`);
    assert.equal(bg.list().length, 1);
    /* 等待任务结束，验证输出限制内的正常采集 */
    const id = out.split(' ')[1];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const job = bg.get(id);
      if (job && job.status !== 'running') {
        assert.equal(job.status, 'completed');
        assert.ok(job.output.includes('bg-ok'));
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail('后台任务未在 10s 内完成');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
