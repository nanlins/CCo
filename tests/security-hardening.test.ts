/**
 * 回归：安全收紧（item 11）。
 *   - 未知工具默认 deny（仅显式注册/显式 allowlist 的工具可通过）；
 *   - grep 增加单文件大小、总结果数、总读取字节上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionGate } from '../src/core/permission.js';
import { fsTools } from '../src/tools/fs.js';
import type { ToolContext } from '../src/types.js';

function ctx(workdir: string): ToolContext {
  return { workdir } as never;
}

test('未知工具默认 deny', async () => {
  const gate = new PermissionGate({ mode: 'auto', ask: async () => true });
  const d = await gate.check('totally_unknown_tool', {}, { workdir: '.' });
  assert.equal(d.allow, false, '未知工具必须默认 deny');
  assert.ok(d.reason.includes('unknown tool'), `reason: ${d.reason}`);
  /* 显式注册的工具（如 read_file）不受影响 */
  const d2 = await gate.check('read_file', { path: 'x.txt' }, { workdir: '.' });
  assert.equal(d2.allow, true);
});

test('grep 单文件大小上限：超大文件跳过并提示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grep-'));
  try {
    /* 构造一个 >2MB 的文件 */
    const big = path.join(dir, 'big.txt');
    const chunk = 'a'.repeat(1024 * 1024);
    fs.writeFileSync(big, chunk + chunk + chunk); // 3MB
    fs.writeFileSync(path.join(dir, 'small.txt'), 'apple here', 'utf8');

    const out = String(
      await fsTools()
        .find((t) => t.schema.name === 'grep')!
        .executor({ pattern: 'a' }, ctx(dir)),
    );
    /* small.txt 命中；big.txt 被跳过 */
    assert.ok(out.includes('small.txt'), `应命中 small.txt: ${out}`);
    assert.ok(!out.includes('big.txt'), '超大文件应被跳过');
    assert.ok(out.includes('超大文件已跳过'), `应提示超大文件跳过: ${out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('grep 总结果数上限：超过后截断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grep-'));
  try {
    /* 生成一个含 300 行匹配的文件（超过 200 结果上限） */
    const lines = Array.from({ length: 300 }, (_, i) => `needle line ${i}`);
    fs.writeFileSync(path.join(dir, 'many.txt'), lines.join('\n'), 'utf8');
    const out = String(
      await fsTools()
        .find((t) => t.schema.name === 'grep')!
        .executor({ pattern: 'needle' }, ctx(dir)),
    );
    assert.ok(out.includes('结果达到上限'), `应提示结果截断: ${out}`);
    const hitCount = out.split('\n').filter((l) => l.includes(':')).length - (out.includes('结果达到上限') ? 1 : 0);
    assert.ok(hitCount <= 200, `结果应截断到 200，实际 ${hitCount}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
