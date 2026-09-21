/**
 * P0 回归：read/write/edit/delete/list/glob/grep 都不能穿过 symlink 或 junction。
 * 词法 isInside 无法识别工作区内的链接组件，必须由 realpath 校验兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsTools } from '../src/tools/fs.js';
import type { ToolContext } from '../src/types.js';

interface Fixture {
  workdir: string;
  outside: string;
  cleanup: () => void;
}

/** 临时工作区 + 工作区外的目录（含 outside-notes.txt），并在工作区内建链接指向外部。 */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-symlink-'));
  const workdir = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'outside-notes.txt'), 'TOP-SECRET');
  fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'dir', 'inner.txt'), 'INNER-SECRET');

  /* 文件符号链接：ws/link-file.txt → outside/outside-notes.txt */
  fs.symlinkSync(path.join(outside, 'outside-notes.txt'), path.join(workdir, 'link-file.txt'));
  /* 目录符号链接：ws/link-dir → outside/dir */
  fs.symlinkSync(path.join(outside, 'dir'), path.join(workdir, 'link-dir'), 'dir');
  /* junction（Windows 无需管理员权限的目录链接）：ws/junction → outside */
  fs.symlinkSync(outside, path.join(workdir, 'junction'), 'junction');
  /* 正常文件，确认合法路径不受影响 */
  fs.writeFileSync(path.join(workdir, 'normal.txt'), 'hello');

  return {
    workdir,
    outside,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function ctx(workdir: string): ToolContext {
  return { workdir } as never;
}

function tool(name: string) {
  const def = fsTools().find((t) => t.schema.name === name);
  assert.ok(def, `tool ${name} not found`);
  return def!;
}

async function run(name: string, args: Record<string, unknown>, workdir: string): Promise<string> {
  try {
    return String(await tool(name).executor(args, ctx(workdir)));
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

test('write_file: 不能通过工作区内符号链接写到工作区外', async () => {
  const f = makeFixture();
  try {
    const out = await run('write_file', { path: 'link-file.txt', content: 'HACKED' }, f.workdir);
    assert.ok(out.includes('escapes workspace'), `应拒绝符号链接写入，实际: ${out}`);
    assert.equal(fs.readFileSync(path.join(f.outside, 'outside-notes.txt'), 'utf8'), 'TOP-SECRET');

    const out2 = await run('write_file', { path: 'link-dir/evil.txt', content: 'HACKED' }, f.workdir);
    assert.ok(out2.includes('escapes workspace'), `应拒绝穿过链接目录写入，实际: ${out2}`);
    assert.ok(!fs.existsSync(path.join(f.outside, 'dir', 'evil.txt')));

    const out3 = await run('write_file', { path: 'junction/evil2.txt', content: 'HACKED' }, f.workdir);
    assert.ok(out3.includes('escapes workspace'), `应拒绝穿过 junction 写入，实际: ${out3}`);
    assert.ok(!fs.existsSync(path.join(f.outside, 'evil2.txt')));

    /* 合法写入不受影响 */
    const ok = await run('write_file', { path: 'new.txt', content: 'fine' }, f.workdir);
    assert.ok(ok.startsWith('Wrote'));
  } finally {
    f.cleanup();
  }
});

test('edit_file: 不能通过符号链接编辑工作区外文件', async () => {
  const f = makeFixture();
  try {
    const out = await run('edit_file', { path: 'link-file.txt', old_text: 'TOP', new_text: 'LEAKED' }, f.workdir);
    assert.ok(out.includes('escapes workspace'), `实际: ${out}`);
    assert.equal(fs.readFileSync(path.join(f.outside, 'outside-notes.txt'), 'utf8'), 'TOP-SECRET');
  } finally {
    f.cleanup();
  }
});

test('read_file: 不能通过符号链接读取工作区外文件', async () => {
  const f = makeFixture();
  try {
    const out = await run('read_file', { path: 'link-file.txt' }, f.workdir);
    assert.ok(out.includes('escapes workspace'), `实际: ${out}`);
    assert.ok(!out.includes('TOP-SECRET'));
    const out2 = await run('read_file', { path: 'junction/outside-notes.txt' }, f.workdir);
    assert.ok(out2.includes('escapes workspace'), `实际: ${out2}`);
    /* 合法读取不受影响 */
    const ok = await run('read_file', { path: 'normal.txt' }, f.workdir);
    assert.equal(ok, 'hello');
  } finally {
    f.cleanup();
  }
});

test('delete_file: 不能通过符号链接删除工作区外文件', async () => {
  const f = makeFixture();
  try {
    const out = await run('delete_file', { path: 'link-file.txt' }, f.workdir);
    assert.ok(out.includes('escapes workspace'), `实际: ${out}`);
    assert.ok(fs.existsSync(path.join(f.outside, 'outside-notes.txt')));
  } finally {
    f.cleanup();
  }
});

test('list_files: 不能通过符号链接/junction 列出工作区外目录', async () => {
  const f = makeFixture();
  try {
    const out = await run('list_files', { path: 'link-dir' }, f.workdir);
    assert.ok(out.includes('escapes workspace'), `实际: ${out}`);
    const out2 = await run('list_files', { path: 'junction' }, f.workdir);
    assert.ok(out2.includes('escapes workspace'), `实际: ${out2}`);
  } finally {
    f.cleanup();
  }
});

test('glob: 不跟随 symlink/junction，不泄漏工作区外文件名', async () => {
  const f = makeFixture();
  try {
    const out = await run('glob', { pattern: '**/*.txt' }, f.workdir);
    assert.ok(out.includes('normal.txt'));
    assert.ok(!out.includes('outside-notes.txt'), `glob 不得穿过链接列出外部文件:\n${out}`);
    assert.ok(!out.includes('inner.txt'), `glob 不得穿过链接目录列出外部文件:\n${out}`);
    assert.ok(!out.includes('link-file.txt'), 'symlink 条目本身也不应出现在 glob 结果');
  } finally {
    f.cleanup();
  }
});

test('grep: 不跟随 symlink/junction，不读出工作区外内容', async () => {
  const f = makeFixture();
  try {
    const out = await run('grep', { pattern: 'SECRET' }, f.workdir);
    assert.ok(!out.includes('TOP-SECRET'), `grep 不得穿过链接读到外部内容:\n${out}`);
    assert.ok(!out.includes('INNER-SECRET'), `grep 不得穿过链接目录读到外部内容:\n${out}`);
    /* 显式指向链接路径也被拒绝 */
    const out2 = await run('grep', { pattern: 'SECRET', path: 'link-file.txt' }, f.workdir);
    assert.ok(out2.includes('escapes workspace') || out2.includes('无匹配'), `实际: ${out2}`);
    /* 合法 grep 不受影响 */
    const ok = await run('grep', { pattern: 'hello' }, f.workdir);
    assert.ok(ok.includes('normal.txt'));
  } finally {
    f.cleanup();
  }
});
