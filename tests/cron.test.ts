import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CronScheduler, cronMatches, isValidCronExpr, parseField } from '../src/tools/cron.js';

test('parseField handles *, steps and ranges', () => {
  assert.deepEqual([...parseField('*/5', 59).values], [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual([...parseField('1-3', 59).values], [1, 2, 3]);
  assert.equal(parseField('*', 59).any, true);
});

test('cronMatches: basic fields', () => {
  const d = new Date(2026, 0, 4, 10, 30, 0); // 2026-01-04 10:30 (Sunday)
  assert.equal(cronMatches('30 10 * * *', d), true);
  assert.equal(cronMatches('0 10 * * *', d), false);
  assert.equal(cronMatches('30 9 * * *', d), false);
  assert.equal(cronMatches('30 10 4 * *', d), true);
  assert.equal(cronMatches('30 10 * 1 *', d), true);
  assert.equal(cronMatches('30 10 * 2 *', d), false);
});

test('cronMatches: dom/dow OR semantics when both constrained', () => {
  const d = new Date(2026, 0, 5, 9, 0, 0); // Monday the 5th
  assert.equal(cronMatches('0 9 5 * 1', d), true); // dom=5 matches, dow=1 matches
  assert.equal(cronMatches('0 9 10 * 1', d), true); // dow matches (10 != dom)
  assert.equal(cronMatches('0 9 10 * 2', d), false);
});

test('isValidCronExpr rejects bad expressions', () => {
  assert.equal(isValidCronExpr('* * * * *'), true);
  assert.equal(isValidCronExpr('* * * *'), false);
  assert.equal(isValidCronExpr('99 * * * *'), false);
});

test('scheduler tick fires once per minute and persists durable jobs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cron-'));
  const triggered: string[] = [];
  const s = new CronScheduler({ workdir: dir, onTrigger: (job) => triggered.push(job.id) });
  const job = s.add('* * * * *', 'run tests');
  const now = new Date(2026, 5, 15, 12, 0, 0);

  const first = s.tick(now);
  assert.deepEqual(first, [job.id]);
  const second = s.tick(now); // same minute → no re-fire
  assert.deepEqual(second, []);

  assert.ok(fs.existsSync(path.join(dir, '.cron', 'jobs.json')));
  const s2 = new CronScheduler({ workdir: dir });
  assert.equal(s2.list().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
