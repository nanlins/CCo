/**
 * P2-2 回归：项目级 hook 信任门（供应链/信任边界）。
 *
 * 覆盖：
 *   - 未信任的 workspace .anvil/hooks.json 不注册、不执行（无确认通道时安全默认）；
 *   - 用户拒绝确认 → 不加载；
 *   - 用户确认 → 加载并持久化信任；再次加载不再询问；
 *   - hooks.json 内容变化 → 指纹失效，需重新确认；
 *   - 已信任 hook 可端到端触发执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookRegistry } from '../src/core/hooks.js';
import { loadProjectHooks } from '../src/core/hookLoader.js';

const HOOK_CMD = `node -e "console.log(JSON.stringify({block:true,message:'from hook'}))"`;

function setup(): { ws: string; trustDir: string; cleanup: () => void } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-ws-'));
  const trustDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-trust-'));
  fs.mkdirSync(path.join(ws, '.anvil'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.anvil', 'hooks.json'),
    JSON.stringify({ Stop: [{ type: 'command', command: HOOK_CMD }] }),
  );
  return {
    ws,
    trustDir,
    cleanup: () => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(trustDir, { recursive: true, force: true });
    },
  };
}

test('P2-2: 未信任项目级 hooks 不加载/不执行', async () => {
  const { ws, trustDir, cleanup } = setup();
  try {
    const reg = new HookRegistry();
    const loaded = await loadProjectHooks(reg, ws, () => {}, { trustDir });
    assert.equal(loaded, false);
    assert.equal(reg.list('Stop').length, 0, '未信任不得注册 hook');
    assert.equal(await reg.trigger('Stop', {}), undefined, '未注册不得执行');
  } finally {
    cleanup();
  }
});

test('P2-2: 用户拒绝确认 → 不加载', async () => {
  const { ws, trustDir, cleanup } = setup();
  try {
    const reg = new HookRegistry();
    let confirms = 0;
    const loaded = await loadProjectHooks(reg, ws, () => {}, {
      trustDir,
      confirmProject: async () => {
        confirms += 1;
        return false;
      },
    });
    assert.equal(loaded, false);
    assert.equal(confirms, 1, '应展示命令并询问一次');
    assert.equal(reg.list('Stop').length, 0);
  } finally {
    cleanup();
  }
});

test('P2-2: 确认信任后加载并持久化；内容变化后信任失效', async () => {
  const { ws, trustDir, cleanup } = setup();
  try {
    const reg = new HookRegistry();
    let confirms = 0;
    const loaded = await loadProjectHooks(reg, ws, () => {}, {
      trustDir,
      confirmProject: async () => {
        confirms += 1;
        return true;
      },
    });
    assert.equal(loaded, true);
    assert.equal(confirms, 1);
    assert.equal(reg.list('Stop').length, 1);
    assert.ok(fs.existsSync(path.join(trustDir, 'hooks-trusted.json')), '信任应持久化');

    /* 已信任：新 registry 再加载，不再询问 */
    const reg2 = new HookRegistry();
    const loaded2 = await loadProjectHooks(reg2, ws, () => {}, {
      trustDir,
      confirmProject: async () => {
        throw new Error('已信任不应再次询问');
      },
    });
    assert.equal(loaded2, true);
    assert.equal(reg2.list('Stop').length, 1);

    /* hooks.json 内容变化 → 指纹失效，无确认通道时跳过 */
    fs.appendFileSync(path.join(ws, '.anvil', 'hooks.json'), '\n');
    const reg3 = new HookRegistry();
    const loaded3 = await loadProjectHooks(reg3, ws, () => {}, { trustDir });
    assert.equal(loaded3, false, '内容变化后必须重新信任');
    assert.equal(reg3.list('Stop').length, 0);
  } finally {
    cleanup();
  }
});

test('P2-2: 已信任 hook 可端到端触发执行', async () => {
  const { ws, trustDir, cleanup } = setup();
  try {
    const reg = new HookRegistry();
    await loadProjectHooks(reg, ws, () => {}, { trustDir, confirmProject: async () => true });
    const r = await reg.trigger('Stop', { messagesCount: 1 });
    assert.equal(r?.block, true);
    assert.equal(r?.message, 'from hook');
  } finally {
    cleanup();
  }
});
