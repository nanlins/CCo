/**
 * P1 回归：入口选择器 resolveEntryMode / latestSrcMtime（消除 dist 陈旧脚枪）。
 *
 * 每条用例使用临时目录与精确 mtime 模拟三条路径：
 *   - src 新于 dist → 源码模式 + 告警
 *   - dist 新于等于 src → dist 模式
 *   - ANVIL_USE_DIST=0/1 强制覆盖
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEntryMode, latestSrcMtime } from '../bin/anvil.js';

/** 在 root 下建 src/sub/a.ts 和 dist/main.js 并设精确 mtime。 */
function setup(tsMtimeMs: number, jsMtimeMs: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entry-'));
  const srcDir = path.join(root, 'src', 'sub');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  const tsFile = path.join(srcDir, 'a.ts');
  fs.writeFileSync(tsFile, '// test');
  fs.utimesSync(tsFile, tsMtimeMs / 1000, tsMtimeMs / 1000);
  const jsFile = path.join(distDir, 'main.js');
  fs.writeFileSync(jsFile, '"use strict";');
  fs.utimesSync(jsFile, jsMtimeMs / 1000, jsMtimeMs / 1000);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('src 新于 dist → 源码模式 + 告警', () => {
  const tsMs = Date.now();
  const jsMs = tsMs - 60_000; // dist 旧 1 分钟
  const { root, cleanup } = setup(tsMs, jsMs);
  try {
    const r = resolveEntryMode(root, {});
    assert.equal(r.mode, 'src');
    assert.match(r.warning ?? '', /dist 落后于 src/);
  } finally {
    cleanup();
  }
});

test('dist 新于等于 src → dist 模式', () => {
  const jsMs = Date.now();
  const tsMs = jsMs - 60_000; // src 旧 1 分钟
  const { root, cleanup } = setup(tsMs, jsMs);
  try {
    const r = resolveEntryMode(root, {});
    assert.equal(r.mode, 'dist');
    assert.equal(r.warning, undefined, 'dist 模式不得有告警');
  } finally {
    cleanup();
  }
});

test('dist 与 src 同时 → dist 模式', () => {
  const ms = Date.now();
  const { root, cleanup } = setup(ms, ms);
  try {
    const r = resolveEntryMode(root, {});
    assert.equal(r.mode, 'dist');
  } finally {
    cleanup();
  }
});

test('ANVIL_USE_DIST=0 强制源码', () => {
  const now = Date.now();
  const { root, cleanup } = setup(now - 60_000, now);
  try {
    const r = resolveEntryMode(root, { ANVIL_USE_DIST: '0' });
    assert.equal(r.mode, 'src');
  } finally {
    cleanup();
  }
});

test('ANVIL_USE_DIST=1 强制 dist', () => {
  // dist 不存在也应强制走 dist 路径（启动时 node dist/main.js 会报错但那是预期）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entry-2-'));
  try {
    const r = resolveEntryMode(root, { ANVIL_USE_DIST: '1' });
    assert.equal(r.mode, 'dist');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dist 缺失 → 回退源码模式', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entry-3-'));
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.ts'), '// test');
  try {
    const r = resolveEntryMode(root, {});
    assert.equal(r.mode, 'src');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('latestSrcMtime: 递归取 .ts 文件最新 mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entry-4-'));
  try {
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'a');
    fs.writeFileSync(path.join(srcDir, 'sub', 'b.ts'), 'b');
    // b.ts 更新
    const bMtime = Date.now() + 5000;
    fs.utimesSync(path.join(srcDir, 'sub', 'b.ts'), bMtime / 1000, bMtime / 1000);
    const latest = latestSrcMtime(srcDir);
    assert.ok(latest > 0, '应找到 .ts 文件');
    assert.ok(Math.abs(latest - bMtime) < 2000, `最新 mtime 应接近 b.ts（${latest} vs ${bMtime}）`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('latestSrcMtime: 无 .ts 文件 → 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entry-5-'));
  try {
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    assert.equal(latestSrcMtime(srcDir), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
