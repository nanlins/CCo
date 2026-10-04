/**
 * 持久化写失败降级回归：工作区不可写时不抛异常、保持内存态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcript, AuditLog } from '../src/core/transcript.js';
import { MemoryStore } from '../src/core/memory.js';
import { resetSafeWriteWarning } from '../src/core/safeWrite.js';

test('持久化写失败降级：不抛异常、保持内存态、输出可读警告', () => {
  resetSafeWriteWarning();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ro-'));
  /* 用「文件」当目录父级：mkdirSync(blocker/sub) 必失败（ENOTDIR） */
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const badDir = path.join(blocker, 'sub');

  let warn = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warn += s;
    return true;
  };
  try {
    assert.doesNotThrow(() => new Transcript(badDir, 'sess1'));
    assert.doesNotThrow(() => new AuditLog(badDir));
    assert.doesNotThrow(() => new MemoryStore(badDir));

    const t = new Transcript(badDir, 'sess1');
    assert.doesNotThrow(() => {
      t.log('evt', { a: 1 });
      t.saveSnapshot([]);
      t.saveSessionSnapshot({ version: 2, sessionId: 'sess1', savedAt: '', messages: [] });
    });
    assert.equal(t.recent().length, 1, '内存态仍可读');

    const a = new AuditLog(badDir);
    assert.doesNotThrow(() => a.event('x'));

    const m = new MemoryStore(badDir);
    assert.doesNotThrow(() => m.save({ name: 'n', description: 'd', body: 'b' }));
  } finally {
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.match(warn, /\[警告\]/, '必须输出一条可读警告');
});
