/**
 * 性能压测 —— 工具执行延迟 / 并发工具 / 上下文压缩 / 权限判断。
 *
 * 用法：node --import tsx tests/perf/bench.ts
 * 无网络：全部用 MockLlm + 本地文件操作，测量真实耗时。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHarness } from '../helpers.js';
import { TaskSystem } from '../../src/tools/tasks.js';
import { compactMessages, compactHistory } from '../../src/core/compact.js';
import { PermissionGate } from '../../src/core/permission.js';
import { MockLlm } from '../../src/llm/mock.js';

const results: Array<{ name: string; ms: number }> = [];

async function measure(name: string, fn: () => Promise<void> | void): Promise<void> {
  const start = performance.now();
  await fn();
  results.push({ name, ms: Math.round(performance.now() - start) });
}

async function run() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perf-'));
  const h = makeHarness({ script: [{ blocks: [{ type: 'text', text: 'done' }] }] });

  console.log('===== 性能压测 =====\n');

  /* 1. 文件写入延迟 */
  const filePath = path.join(workdir, 'perf.txt');
  await measure('write_file ×100 (1KB each)', () => {
    for (let i = 0; i < 100; i++) fs.writeFileSync(filePath, 'x'.repeat(1000));
  });
  await measure('read_file ×100 (1KB each)', () => {
    for (let i = 0; i < 100; i++) fs.readFileSync(filePath, 'utf8');
  });

  /* 2. 权限判断延迟 */
  const gate = new PermissionGate({ mode: 'auto', ask: async () => false });
  await measure('权限判断 ×1000', async () => {
    for (let i = 0; i < 1000; i++) await gate.check('read_file', { path: 'x.txt' }, { workdir });
  });

  /* 3. 任务系统 CRUD */
  const tasks = new TaskSystem(path.join(workdir, '.tasks'));
  await measure('任务 create+claim+complete ×200', async () => {
    for (let i = 0; i < 200; i++) {
      const task = tasks.create(`task-${i}`);
      await tasks.claim(task.id, 'bench');
      await tasks.complete(task.id);
    }
  });

  /* 4. 上下文压缩管线（0 API） */
  const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 0; i < 80; i++) {
    msgs.push({ role: 'user', content: `message ${i} ` + 'x'.repeat(500) });
    msgs.push({ role: 'assistant', content: `reply ${i} ` + 'y'.repeat(500) });
  }
  await measure('压缩管线(0 API) ×100', () => {
    for (let i = 0; i < 100; i++) compactMessages(msgs, { thresholdChars: 100000 });
  });

  /* 5. 并发文件操作 */
  await measure('并发 10 个文件读写', async () => {
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const p = path.join(workdir, `f${Math.random()}.txt`);
        fs.writeFileSync(p, 'x'.repeat(1000));
        fs.readFileSync(p, 'utf8');
        fs.unlinkSync(p);
      }),
    );
  });

  /* 6. LLM 压缩摘要（Mock） */
  const mockLlm = new MockLlm({ script: [{ blocks: [{ type: 'text', text: '<summary>summary</summary>' }] }] });
  await measure('LLM 压缩摘要(单次)', async () => {
    await compactHistory(msgs as never, mockLlm, { maxTokens: 1000 });
  });

  /* 7. 完整 agent 循环（Mock, 3轮） */
  await measure('agent 循环 3 轮(Mock)', async () => {
    const h2 = makeHarness({
      script: [
        { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'a.txt', content: 'x' } }] },
        { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } }] },
        { blocks: [{ type: 'text', text: 'done' }] },
      ],
    });
    await h2.agent.run('test');
    h2.cleanup();
  });

  h.cleanup();
  fs.rmSync(workdir, { recursive: true, force: true });

  console.log('基准结果:\n');
  const rows: Array<[string, number]> = [];
  for (const r of results) rows.push([r.name, r.ms]);
  rows.sort((a, b) => b[1] - a[1]);
  for (const [name, ms] of rows) {
    console.log(`  ${name.padEnd(32)} ${String(ms).padStart(6)} ms`);
  }
  console.log('\n===========================');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
