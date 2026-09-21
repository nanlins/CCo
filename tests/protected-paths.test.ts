/**
 * P0 回归：Agent 不得修改自己的权限状态、信任状态与密钥文件。
 * 验收要求：
 *   - auto 模式写 `.claude/settings.local.json` 必须被拒绝（PermissionGate 层）；
 *   - 文件工具执行器双重拦截：write/edit/delete 命中保护路径直接 Error；
 *   - `.env` 等密钥文件禁止读入上下文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionGate } from '../src/core/permission.js';
import { isProtectedWritePath, isSecretReadPath } from '../src/core/protectedPaths.js';
import { fsTools } from '../src/tools/fs.js';
import type { ToolContext } from '../src/types.js';

function tmpWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prot-'));
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

test('isProtectedWritePath: 权限/信任/密钥状态文件全部命中', () => {
  const w = tmpWorkdir();
  try {
    const protectedPaths = [
      '.env',
      '.env.local',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.mcp/servers.json',
      '.mcp/trusted.json',
      'secrets.json',
      'keys/id_rsa',
      'cert.pem',
      'signing.key',
    ];
    for (const p of protectedPaths) {
      assert.equal(isProtectedWritePath(w, p), true, `${p} 应为受保护写入路径`);
    }
    /* 普通文件不受影响 */
    assert.equal(isProtectedWritePath(w, 'src/main.ts'), false);
    assert.equal(isProtectedWritePath(w, 'README.md'), false);
    assert.equal(isProtectedWritePath(w, '.env.example'), false);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('isSecretReadPath: .env 与密钥文件禁止读', () => {
  const w = tmpWorkdir();
  try {
    assert.equal(isSecretReadPath(w, '.env'), true);
    assert.equal(isSecretReadPath(w, 'config/.env.production'), true);
    assert.equal(isSecretReadPath(w, 'server.key'), true);
    assert.equal(isSecretReadPath(w, 'src/app.ts'), false);
    assert.equal(isSecretReadPath(w, '.env.example'), false);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('PermissionGate: auto 模式写 .claude/settings.local.json 必须拒绝', async () => {
  const w = tmpWorkdir();
  try {
    const gate = new PermissionGate({ mode: 'auto', ask: async () => true });
    for (const p of ['.claude/settings.local.json', '.claude/settings.json', '.mcp/servers.json', '.env']) {
      const d = await gate.check('write_file', { path: p, content: '{}' }, { workdir: w });
      assert.equal(d.allow, false, `auto 模式写 ${p} 必须拒绝`);
      assert.ok(d.reason.includes('受保护'), `reason: ${d.reason}`);
    }
    /* bypass 模式同样拒绝（保护路径先于模式判断） */
    const bypass = new PermissionGate({ mode: 'bypass', ask: async () => true });
    const d2 = await bypass.check('write_file', { path: '.env', content: 'x' }, { workdir: w });
    assert.equal(d2.allow, false, 'bypass 模式也不得写受保护路径');
    /* settings allow 规则不能豁免保护路径 */
    const gateWithAllow = new PermissionGate({
      mode: 'auto',
      ask: async () => true,
      settings: {
        rules: [{ toolName: 'Write', ruleBehavior: 'allow', ruleContent: 'settings.local.json', source: 'local' }],
        defaults: {},
        disabledTools: [],
      },
    });
    const d3 = await gateWithAllow.check(
      'write_file',
      { path: '.claude/settings.local.json', content: '{}' },
      { workdir: w },
    );
    assert.equal(d3.allow, false, 'settings allow 规则不得豁免受保护路径');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('执行器双重拦截：write/edit/delete 命中保护路径返回 Error', async () => {
  const w = tmpWorkdir();
  try {
    fs.mkdirSync(path.join(w, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(w, '.claude', 'settings.local.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(w, '.env'), 'SECRET=1', 'utf8');

    const w1 = await run('write_file', { path: '.claude/settings.local.json', content: '{"permissions":{}}' }, w);
    assert.ok(w1.startsWith('Error:') && w1.includes('受保护'), `实际: ${w1}`);
    assert.equal(fs.readFileSync(path.join(w, '.claude', 'settings.local.json'), 'utf8'), '{}', '文件内容不得被修改');

    const e1 = await run('edit_file', { path: '.env', old_text: 'SECRET=1', new_text: 'SECRET=pwned' }, w);
    assert.ok(e1.startsWith('Error:') && e1.includes('受保护'), `实际: ${e1}`);
    assert.equal(fs.readFileSync(path.join(w, '.env'), 'utf8'), 'SECRET=1');

    const d1 = await run('delete_file', { path: '.env' }, w);
    assert.ok(d1.startsWith('Error:') && d1.includes('受保护'), `实际: ${d1}`);
    assert.ok(fs.existsSync(path.join(w, '.env')), '.env 不得被删除');

    /* 普通文件写入不受影响 */
    const ok = await run('write_file', { path: 'normal.txt', content: 'fine' }, w);
    assert.ok(ok.startsWith('Wrote'), `实际: ${ok}`);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('执行器双重拦截：read_file 禁止读取 .env', async () => {
  const w = tmpWorkdir();
  try {
    fs.writeFileSync(path.join(w, '.env'), 'ANTHROPIC_API_KEY=sk-secret', 'utf8');
    const r = await run('read_file', { path: '.env' }, w);
    assert.ok(r.startsWith('Error:') && r.includes('密钥'), `实际: ${r}`);
    assert.ok(!r.includes('sk-secret'), '密钥内容不得出现在输出中');
    /* 普通文件读取不受影响 */
    fs.writeFileSync(path.join(w, 'a.txt'), 'hello', 'utf8');
    const ok = await run('read_file', { path: 'a.txt' }, w);
    assert.equal(ok, 'hello');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});
