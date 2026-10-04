/**
 * 项目指令加载边界回归（P1-2）：命中 / 无文件 / 单文件超限 / 总长超限 / 深度 / git 根。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectInstructions } from '../src/core/projectInstructions.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pi-'));
}

test('projectInstructions: 命中工作区 ANVIL.md', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.git'), '');
  fs.writeFileSync(path.join(dir, 'ANVIL.md'), '# 规则\n你是助手');
  const r = loadProjectInstructions(dir);
  assert.ok(r.text.includes('你是助手'));
  assert.equal(r.files.length, 1);
  assert.equal(r.truncated, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projectInstructions: 无文件返回空', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.git'), '');
  const r = loadProjectInstructions(dir);
  assert.equal(r.text, '');
  assert.deepEqual(r.files, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projectInstructions: 单文件超限 → 跳过并标注截断', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.git'), '');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x'.repeat(100));
  const r = loadProjectInstructions(dir, { maxFileBytes: 50 });
  assert.equal(r.truncated, true);
  assert.ok(r.files.some((f) => f.includes('已截断')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projectInstructions: 总长超限 → 截断正文', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.git'), '');
  fs.writeFileSync(path.join(dir, 'ANVIL.md'), 'A'.repeat(300));
  const r = loadProjectInstructions(dir, { maxFileBytes: 1000, maxTotalBytes: 100 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('已截断'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projectInstructions: 深度受限（maxDepth=0 不读父目录）', () => {
  const parent = tmp();
  const child = path.join(parent, 'child');
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(parent, 'ANVIL.md'), 'parent-rule');
  const r = loadProjectInstructions(child, { maxDepth: 0 });
  assert.equal(r.text, '', '不得到父目录读取');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('projectInstructions: git 根为边界', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.git'), '');
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'root-rule');
  const r = loadProjectInstructions(sub);
  assert.ok(r.text.includes('root-rule'));
  fs.rmSync(root, { recursive: true, force: true });
});
