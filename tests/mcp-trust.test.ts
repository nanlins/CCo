/**
 * P0 回归：connect_mcp 信任门。
 * .mcp/servers.json 可以写任意 command（连接即启动子进程 = 任意代码执行），
 * 因此首次连接必须展示命令并经用户确认；未确认不得启动子进程；
 * 信任按"完整配置指纹"持久化到用户级目录（agent 不可写），配置变化需重新确认。
 * 工作区内的 .mcp/trusted.json 一律被忽略（预置匹配指纹也必须重新询问）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/core/registry.js';
import { McpPool } from '../src/tools/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ECHO_SERVER = path.resolve(HERE, '..', 'examples', 'mcp-echo-server.mjs');

interface Fixture {
  workdir: string;
  trustDir: string;
  cleanup: () => void;
}

/** 每个用例独立的 workdir + 用户级信任目录（测试不污染真实 HOME）。 */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-trust-'));
  const workdir = path.join(root, 'ws');
  const trustDir = path.join(root, 'home');
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(trustDir, { recursive: true });
  return {
    workdir,
    trustDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeServers(workdir: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workdir, '.mcp'), { recursive: true });
  fs.writeFileSync(path.join(workdir, '.mcp', 'servers.json'), JSON.stringify(cfg), 'utf8');
}

test('未确认的 MCP 配置不能启动子进程（ask 拒绝 → 无进程、无工具注册）', async () => {
  const f = makeFixture();
  const pool = new McpPool(f.workdir, () => {}, f.trustDir);
  try {
    const marker = path.join(f.workdir, 'PWNED.txt');
    /* 恶意配置：一旦启动就会写标记文件 */
    writeServers(f.workdir, {
      evil: {
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')`],
      },
    });
    const registry = new ToolRegistry();
    let asked = 0;
    const result = await pool.connect('evil', registry, async () => {
      asked += 1;
      return false; // 用户拒绝
    });
    assert.equal(asked, 1, '首次连接必须询问');
    assert.ok(/not trusted/i.test(result), `应报告未信任: ${result}`);
    assert.ok(!fs.existsSync(marker), '拒绝后绝不能启动子进程（标记文件不得出现）');
    assert.equal(registry.list().length, 0, '拒绝后不得注册任何工具');
    assert.ok(!pool.isTrusted('evil'));
  } finally {
    pool.closeAll();
    f.cleanup();
  }
});

test('非交互（无 ask 通道）时未信任配置直接拒绝', async () => {
  const f = makeFixture();
  const pool = new McpPool(f.workdir, () => {}, f.trustDir);
  try {
    writeServers(f.workdir, { echo: { command: process.execPath, args: [ECHO_SERVER] } });
    const registry = new ToolRegistry();
    const result = await pool.connect('echo', registry); // 无 ask
    assert.ok(/not trusted/i.test(result), `实际: ${result}`);
    assert.equal(registry.list().length, 0);
  } finally {
    pool.closeAll();
    f.cleanup();
  }
});

test('确认后连接成功并持久化信任到用户级目录；重连不再询问', async () => {
  const f = makeFixture();
  const pool = new McpPool(f.workdir, () => {}, f.trustDir);
  try {
    writeServers(f.workdir, { echo: { command: process.execPath, args: [ECHO_SERVER] } });
    const registry = new ToolRegistry();

    let asked = 0;
    const askYes = async (): Promise<boolean> => {
      asked += 1;
      return true;
    };
    const result = await pool.connect('echo', registry, askYes);
    assert.equal(asked, 1, '首次连接询问一次');
    assert.ok(result.startsWith('Connected'), `实际: ${result}`);
    assert.ok(registry.list().includes('mcp__echo__echo'), '应注册 echo 工具');
    assert.ok(pool.isTrusted('echo'), '确认后应被信任');
    /* 信任持久化在用户级目录，而不是 agent 可写的 workspace */
    assert.ok(fs.existsSync(path.join(f.trustDir, 'mcp-trusted.json')), '信任应持久化到用户级目录');
    assert.ok(!fs.existsSync(path.join(f.workdir, '.mcp', 'trusted.json')), 'workspace 内不得产生信任文件');
    await pool.disconnect('echo', registry);

    /* 已信任：再次连接不应再询问（ask 若被调用则计数增加） */
    const result2 = await pool.connect('echo', registry, askYes);
    assert.equal(asked, 1, '已信任后重连不得再次询问');
    assert.ok(result2.startsWith('Connected'), `实际: ${result2}`);
  } finally {
    pool.closeAll();
    f.cleanup();
  }
});

test('预置 workspace .mcp/trusted.json（指纹匹配）仍必须询问——信任只认用户级目录', async () => {
  const f = makeFixture();
  const pool = new McpPool(f.workdir, () => {}, f.trustDir);
  try {
    const cfg = { command: process.execPath, args: [ECHO_SERVER] };
    writeServers(f.workdir, { echo: cfg });
    /* 攻击者预置工作区信任文件（指纹完全匹配）——必须被忽略 */
    fs.mkdirSync(path.join(f.workdir, '.mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(f.workdir, '.mcp', 'trusted.json'),
      JSON.stringify({ echo: pool.fingerprint(cfg) }),
      'utf8',
    );
    const registry = new ToolRegistry();
    let asked = 0;
    const result = await pool.connect('echo', registry, async () => {
      asked += 1;
      return false;
    });
    assert.equal(asked, 1, '工作区预置信任无效，必须重新询问');
    assert.ok(/not trusted/i.test(result), `实际: ${result}`);
    assert.equal(registry.list().length, 0, '拒绝后不得注册工具');
  } finally {
    pool.closeAll();
    f.cleanup();
  }
});

test('配置变化后信任失效，需要重新确认', async () => {
  const f = makeFixture();
  const pool = new McpPool(f.workdir, () => {}, f.trustDir);
  try {
    writeServers(f.workdir, { echo: { command: process.execPath, args: [ECHO_SERVER] } });
    const registry = new ToolRegistry();
    await pool.connect('echo', registry, async () => true);
    assert.ok(pool.isTrusted('echo'));
    await pool.disconnect('echo', registry);

    /* 篡改配置（例如恶意 PR 修改了 args）→ 指纹变化 → 信任失效 */
    writeServers(f.workdir, { echo: { command: process.execPath, args: [ECHO_SERVER, '--evil-flag'] } });
    assert.ok(!pool.isTrusted('echo'), '配置变化后信任必须失效');
    let asked = 0;
    await pool.connect('echo', registry, async () => {
      asked += 1;
      return false;
    });
    assert.equal(asked, 1, '配置变化后必须重新确认');
  } finally {
    pool.closeAll();
    f.cleanup();
  }
});

test('指纹覆盖完整配置：headers/oauth 变化也使信任失效', () => {
  const f = makeFixture();
  const pool = new McpPool(f.workdir, () => {}, f.trustDir);
  try {
    const base = { url: 'https://mcp.example.com', transport: 'http' as const };
    const withHeaders = { ...base, headers: { Authorization: 'Bearer x' } };
    const withOauth = {
      ...base,
      oauth: { authorizationEndpoint: 'https://a', tokenEndpoint: 'https://t', clientId: 'c' },
    };
    assert.notEqual(pool.fingerprint(base), pool.fingerprint(withHeaders), 'headers 变化必须改变指纹');
    assert.notEqual(pool.fingerprint(base), pool.fingerprint(withOauth), 'oauth 变化必须改变指纹');
    assert.notEqual(pool.fingerprint(withHeaders), pool.fingerprint(withOauth));
  } finally {
    pool.closeAll();
    f.cleanup();
  }
});
