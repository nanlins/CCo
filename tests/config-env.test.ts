/**
 * 回归：/model /apikey /baseurl 重启后生效（.env 分层加载优先级）。
 *   优先级（高 → 低）：真实环境变量 > 工作区 .env（HARNESS_CWD）> 进程 cwd .env。
 *   修复场景：anvil 全局命令下 cwd=项目根、工作区=用户目录，
 *   /apikey 等写入工作区 .env，重启后必须能读回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotenvLayered } from '../src/config.js';
import { setEnvValue } from '../src/core/configManager.js';

const KEYS: string[] = [];

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  KEYS.push(key);
}

function cleanupEnv(): void {
  for (const k of KEYS.splice(0)) delete process.env[k];
}

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-'));
}

test('分层加载：工作区 .env 优先于 cwd .env，真实环境变量最高', () => {
  const ws = mkDir();
  const cwd = mkDir();
  try {
    const uniq = Date.now().toString(36);
    /* 真实环境变量（模拟 shell 已导出） */
    setEnv(`REAL_${uniq}`, 'from-shell');
    /* cwd .env（项目根传统位置） */
    fs.writeFileSync(
      path.join(cwd, '.env'),
      [`CWDONLY_${uniq}=from-cwd`, `SHARED_${uniq}=cwd-value`, `REAL_${uniq}=cwd-should-not-win`].join('\n'),
      'utf8',
    );
    /* 工作区 .env（/apikey /model 写入的位置） */
    fs.writeFileSync(
      path.join(ws, '.env'),
      [`WSONLY_${uniq}=from-ws`, `SHARED_${uniq}=ws-value`, `REAL_${uniq}=ws-should-not-win`].join('\n'),
      'utf8',
    );

    loadDotenvLayered(ws, cwd);

    assert.equal(process.env[`CWDONLY_${uniq}`], 'from-cwd', 'cwd .env 的键应被加载');
    assert.equal(process.env[`WSONLY_${uniq}`], 'from-ws', '工作区 .env 的键应被加载');
    assert.equal(process.env[`SHARED_${uniq}`], 'ws-value', '同一键：工作区 .env 必须优先于 cwd .env');
    assert.equal(process.env[`REAL_${uniq}`], 'from-shell', '真实环境变量必须最高优先');
  } finally {
    cleanupEnv();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('setEnvValue 写入工作区 .env 后，分层加载能读回（重启生效闭环）', () => {
  const ws = mkDir();
  const cwd = mkDir();
  try {
    const uniq = Date.now().toString(36);
    /* 模拟 /model /apikey /baseurl 运行时写入 */
    setEnvValue(ws, `MODEL_ID_TEST_${uniq}`, 'deepseek-v4-flash');
    setEnvValue(ws, `OPENAI_BASE_URL_TEST_${uniq}`, 'https://opencode.ai/zen/go/v1');
    /* 模拟重启：重新分层加载（工作区优先） */
    loadDotenvLayered(ws, cwd);
    assert.equal(process.env[`MODEL_ID_TEST_${uniq}`], 'deepseek-v4-flash');
    assert.equal(process.env[`OPENAI_BASE_URL_TEST_${uniq}`], 'https://opencode.ai/zen/go/v1');

    /* 更新已有键（/model 再次切换）→ 覆盖旧值 */
    setEnvValue(ws, `MODEL_ID_TEST_${uniq}`, 'other-model');
    const content = fs.readFileSync(path.join(ws, '.env'), 'utf8');
    assert.ok(!content.includes('deepseek-v4-flash'), '旧值应被覆盖而不是追加');
    assert.ok(content.includes('other-model'));
  } finally {
    cleanupEnv();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('损坏的 .env 不影响加载', () => {
  const ws = mkDir();
  const cwd = mkDir();
  try {
    const uniq = Date.now().toString(36);
    fs.writeFileSync(path.join(ws, '.env'), `\u0000\u0001 binary garbage`, 'utf8');
    fs.writeFileSync(path.join(cwd, '.env'), `OKKEY_${uniq}=ok`, 'utf8');
    assert.doesNotThrow(() => loadDotenvLayered(ws, cwd));
    assert.equal(process.env[`OKKEY_${uniq}`], 'ok');
  } finally {
    cleanupEnv();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
