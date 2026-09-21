import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fsTools } from '../src/tools/fs.js';
import type { ToolContext } from '../src/types.js';

function mkWorkdir(): string {
  return fs.mkdtempSync(path.join(process.cwd(), '.fs-test-'));
}

function ctx(workdir: string, extra?: Partial<ToolContext>): ToolContext {
  return { workdir, ...extra } as never;
}

function tool(name: string) {
  const def = fsTools().find((t) => t.schema.name === name);
  assert.ok(def, `tool ${name} not found`);
  return def!;
}

function makeTree(root: string): void {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# A');
  fs.writeFileSync(path.join(root, 'docs', 'b.md'), '# B');
  fs.writeFileSync(path.join(root, 'docs', 'sub', 'c.md'), '# C');
  fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'x');
}

test('glob: **/ matches zero directory levels (docs/**/*.md hits docs root)', async () => {
  const dir = mkWorkdir();
  try {
    makeTree(dir);
    const out = await tool('glob').executor({ pattern: 'docs/**/*.md' }, ctx(dir));
    assert.ok(typeof out === 'string');
    assert.ok(out.includes('docs/a.md'), `missing docs/a.md in:\n${out}`);
    assert.ok(out.includes('docs/b.md'), `missing docs/b.md in:\n${out}`);
    assert.ok(out.includes('docs/sub/c.md'), `missing docs/sub/c.md in:\n${out}`);
    assert.ok(!out.includes('无匹配'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('glob: single * does not cross directories', async () => {
  const dir = mkWorkdir();
  try {
    makeTree(dir);
    const out = await tool('glob').executor({ pattern: 'docs/*.md' }, ctx(dir));
    assert.ok(out.includes('docs/a.md'));
    assert.ok(!out.includes('sub/c.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('glob: top-level **/*.md matches root-level files too', async () => {
  const dir = mkWorkdir();
  try {
    makeTree(dir);
    fs.writeFileSync(path.join(dir, 'root.md'), 'r');
    const out = await tool('glob').executor({ pattern: '**/*.md' }, ctx(dir));
    assert.ok(out.includes('root.md'));
    assert.ok(out.includes('docs/a.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list_files: recursive lists the tree with depth cap', async () => {
  const dir = mkWorkdir();
  try {
    makeTree(dir);
    const out = await tool('list_files').executor({ recursive: true }, ctx(dir));
    assert.ok(typeof out === 'string');
    assert.ok(out.includes('docs/'));
    assert.ok(out.includes('docs/a.md'));
    assert.ok(out.includes('docs/sub/c.md'));
    assert.ok(out.includes('src/x.ts'));
    const shallow = await tool('list_files').executor({ recursive: true, depth: 1 }, ctx(dir));
    assert.ok(shallow.includes('docs/a.md'));
    assert.ok(!shallow.includes('docs/sub/c.md'), 'depth=1 should not reach docs/sub/c.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: offset+limit pages through file and reports remaining', async () => {
  const dir = mkWorkdir();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    fs.writeFileSync(path.join(dir, 'f.txt'), lines.join('\n'));
    const t = tool('read_file');
    const p1 = await t.executor({ path: 'f.txt', limit: 4 }, ctx(dir));
    assert.ok(p1.includes('line-1'));
    assert.ok(p1.includes('line-4'));
    assert.ok(!p1.includes('line-5'));
    assert.ok(p1.includes('offset=5'), 'truncation hint should tell how to continue');
    const p2 = await t.executor({ path: 'f.txt', offset: 5, limit: 4 }, ctx(dir));
    assert.ok(p2.includes('line-5'));
    assert.ok(p2.includes('line-8'));
    const p3 = await t.executor({ path: 'f.txt', offset: 9 }, ctx(dir));
    assert.ok(p3.includes('line-9'));
    assert.ok(p3.includes('line-10'));
    const bad = await t.executor({ path: 'f.txt', offset: 99 }, ctx(dir));
    assert.ok(String(bad).startsWith('Error'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safePath: extraReadRoots allows cross-dir reads, writes stay workspace-only', async () => {
  const workdir = mkWorkdir();
  const otherRoot = mkWorkdir();
  try {
    fs.writeFileSync(path.join(otherRoot, 'ext.md'), 'external');
    // 读：配置了 extraReadRoots 可越出工作区
    const out = await tool('read_file').executor(
      { path: path.join(otherRoot, 'ext.md') },
      ctx(workdir, { config: { extraReadRoots: [otherRoot] } } as never),
    );
    assert.equal(out, 'external');
    // 读：未配置则拒绝
    const denied = await tool('read_file')
      .executor({ path: path.join(otherRoot, 'ext.md') }, ctx(workdir))
      .then(
        () => 'no-error',
        (e: Error) => e.message,
      );
    assert.ok(String(denied).includes('escapes workspace'));
    // 写：即使配了 extraReadRoots 也不允许越出工作区（executor 直接抛错）
    const writeOut = await tool('write_file')
      .executor(
        { path: path.join(otherRoot, 'hack.txt'), content: 'x' },
        ctx(workdir, { config: { extraReadRoots: [otherRoot] } } as never),
      )
      .then(
        (r) => String(r),
        (e: Error) => e.message,
      );
    assert.ok(writeOut.includes('escapes workspace'), `write should be rejected, got: ${writeOut}`);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});
