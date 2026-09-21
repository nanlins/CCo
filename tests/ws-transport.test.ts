/**
 * MCP WebSocket transport 回归：真实连接本地 WS server（RFC6455 握手 + 帧编解码），
 * 验证 initialize / tools/list / tools/call 闭环与 server→client 通知。
 * （修复声明：此前 WebSocketTransport 是占位实现，Node 20/24 均无法连接。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketTransport, createTransport } from '../src/mcp/transport.js';
import { McpClient } from '../src/tools/mcp.js';

/* ---------- 最小 WebSocket server（仅测试用：握手 + 文本帧收发） ---------- */

function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; total: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  offset += maskLen;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, total: offset + len };
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

interface WsServer {
  port: number;
  close: () => Promise<void>;
}

async function startWsServer(
  handler: (msg: Record<string, unknown>, send: (obj: unknown) => void) => void,
): Promise<WsServer> {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (obj: unknown): void => {
      socket.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = parseFrame(buf);
        if (!frame) break;
        buf = buf.subarray(frame.total);
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa)); // ping → pong
          continue;
        }
        if (frame.opcode === 0x1) {
          try {
            handler(JSON.parse(frame.payload.toString('utf8')), send);
          } catch {
            /* 忽略坏帧 */
          }
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function echoMcpHandler(msg: Record<string, unknown>, send: (obj: unknown) => void): void {
  const id = msg.id as number | undefined;
  if (id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'ws-echo', version: '1.0' } },
      });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'ws_echo',
              description: 'echo over websocket',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        },
      });
      break;
    case 'tools/call': {
      const params = msg.params as { name?: string; arguments?: { text?: string } };
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `ws-echo: ${params?.arguments?.text ?? ''}` }] },
      });
      break;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } });
  }
}

test('WebSocketTransport: 真实连接 + JSON-RPC 请求/响应 + 通知', async () => {
  const received: Array<{ method: string; params: unknown }> = [];
  const server = await startWsServer((msg, send) => {
    if (msg.method === 'ping-from-client') {
      /* 客户端 notify → server 反向推送一条通知 */
      send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { message: 'hello-from-server' } });
      return;
    }
    echoMcpHandler(msg, send);
  });
  try {
    const t = new WebSocketTransport(`ws://127.0.0.1:${server.port}`);
    t.onNotification((method, params) => received.push({ method, params }));
    await t.connect();
    assert.equal(t.isConnected(), true);

    const init = (await t.request('initialize', {})) as { serverInfo?: { name?: string } };
    assert.equal(init.serverInfo?.name, 'ws-echo');

    t.notify('ping-from-client', {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.length, 1, '应收到 server 推送通知');
    assert.equal(received[0].method, 'notifications/claude/channel');

    t.close();
    assert.equal(t.isConnected(), false);
  } finally {
    await server.close();
  }
});

test('WebSocketTransport: 连接失败给出明确错误（不静默假连接）', async () => {
  const t = new WebSocketTransport('ws://127.0.0.1:1'); // 端口 1 必然拒绝
  await assert.rejects(() => t.connect(), /connection failed|timeout/i);
  assert.equal(t.isConnected(), false);
});

test('createTransport: ws 类型返回 WebSocketTransport', () => {
  const t = createTransport('ws', { url: 'ws://127.0.0.1:9999' });
  assert.ok(t instanceof WebSocketTransport);
});

test('McpClient over ws: initialize → tools/list → tools/call 全闭环', async () => {
  const server = await startWsServer(echoMcpHandler);
  try {
    const client = new McpClient('wsserver', { url: `ws://127.0.0.1:${server.port}`, transport: 'ws' }, process.cwd());
    await client.connect();
    assert.equal(client.tools.length, 1);
    assert.equal(client.tools[0].name, 'ws_echo');
    const out = await client.callTool('ws_echo', { text: '你好' });
    assert.equal(out, 'ws-echo: 你好');
    client.close();
  } finally {
    await server.close();
  }
});
