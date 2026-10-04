/**
 * 首次启动向导错误脱敏回归（P1-3）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError } from '../src/core/firstRunWizard.js';

test('sanitizeError: 脱敏 endpoint/bearer/key/堆栈并截断 ≤200', () => {
  const e = new Error(
    'fetch failed https://api.deepseek.com/v1/chat Authorization: Bearer sk-abc123XYZ\n    at foo (/x.ts:1:2)',
  );
  const s = sanitizeError(e);
  assert.ok(!s.includes('api.deepseek.com'), 'endpoint 应脱敏');
  assert.ok(!s.includes('sk-abc123XYZ'), 'api key 应脱敏');
  assert.ok(!s.includes('at foo'), '堆栈应去除');
  assert.ok(s.length <= 200);
});

test('sanitizeError: 非 Error 输入也能脱敏截断', () => {
  const s = sanitizeError('oc_sk-verysecret ' + 'z'.repeat(400));
  assert.ok(!s.includes('oc_sk-verysecret'));
  assert.ok(s.length <= 200);
});
