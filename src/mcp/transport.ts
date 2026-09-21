/**
 * MCP Transport 抽象层 —— 多传输方式（对齐 CC 的 6 种 transport，教学版实现 3 种）。
 *
 *   stdio：子进程 stdin/stdout JSON-RPC（默认，跨平台）
 *   http：Streamable HTTP（POST JSON-RPC，响应为 JSON）
 *   sse：Server-Sent Events（POST 请求，响应为 SSE 流）
 *
 * 统一接口：connect / request / notify / close / onNotification
 */
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export interface McpMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface Transport {
  /** 建立连接。 */
  connect(): Promise<void>;
  /** 发送请求并等待响应。 */
  request(method: string, params: unknown): Promise<unknown>;
  /** 发送通知（无响应）。 */
  notify(method: string, params: unknown): void;
  /** 关闭连接。 */
  close(): void;
  /** 注册通知回调（server → client 推送）。 */
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** 是否已连接。 */
  isConnected(): boolean;
}

/* ---------- stdio transport ---------- */

export class StdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private connected = false;

  constructor(
    private command: string,
    private args: string[] = [],
  ) {}

  async connect(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.on('exit', () => {
      this.connected = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP server exited'));
      }
      this.pending.clear();
    });
    const stdout = this.child.stdout;
    if (!stdout) throw new Error('MCP server has no stdout');
    this.rl = readline.createInterface({ input: stdout as unknown as NodeJS.ReadableStream });
    this.rl.on('line', (line) => this.handleLine(line));
    this.connected = true;
  }

  private handleLine(line: string): void {
    let msg: McpMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
      else pending.resolve(msg.result);
    } else if (msg.method) {
      /* server → client 通知 */
      for (const h of this.notificationHandlers) h(msg.method, msg.params);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(msg: McpMessage): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    stdin.write(JSON.stringify(msg) + '\n');
  }

  close(): void {
    this.connected = false;
    this.rl?.close();
    this.child?.kill();
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/* ---------- HTTP transport（Streamable HTTP） ---------- */

export class HttpTransport implements Transport {
  private connected = false;
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async connect(): Promise<void> {
    /* HTTP transport 无需预连接，首次 request 时建立 */
    this.connected = true;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const body: McpMessage = { jsonrpc: '2.0', id, method, params };
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}: ${await resp.text()}`);
    const sessionId = resp.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      /* SSE 响应：解析 event stream */
      return this.parseSseResponse(resp);
    }
    const json = (await resp.json()) as McpMessage;
    if (json.error) throw new Error(json.error.message ?? 'MCP error');
    return json.result;
  }

  private async parseSseResponse(resp: Response): Promise<unknown> {
    const text = await resp.text();
    /* SSE 格式：data: {...}\n\n */
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const msg = JSON.parse(line.slice(6)) as McpMessage;
          if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
          if (msg.result !== undefined) return msg.result;
          if (msg.method) {
            for (const h of this.notificationHandlers) h(msg.method, msg.params);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
    return null;
  }

  notify(method: string, params: unknown): void {
    const body: McpMessage = { jsonrpc: '2.0', method, params };
    void fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  close(): void {
    this.connected = false;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/* ---------- SSE transport（长连接事件流） ---------- */

export class SseTransport implements Transport {
  private connected = false;
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private abortController: AbortController | null = null;
  private messageEndpoint: string | null = null;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async connect(): Promise<void> {
    this.abortController = new AbortController();
    /* SSE 连接：GET 请求，接收 event stream */
    const resp = await fetch(this.url, {
      headers: { Accept: 'text/event-stream', ...this.headers },
      signal: this.abortController.signal,
    });
    if (!resp.ok) throw new Error(`MCP SSE ${resp.status}`);
    this.connected = true;

    /* 读取 SSE 流 */
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('SSE no body');
    const decoder = new TextDecoder();
    let buffer = '';

    const processStream = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            this.handleSseData(line.slice(6));
          } else if (line.startsWith('event: endpoint')) {
            /* 服务端告知 message endpoint */
            const nextLine = lines[lines.indexOf(line) + 1];
            if (nextLine?.startsWith('data: ')) {
              this.messageEndpoint = nextLine.slice(6).trim();
            }
          }
        }
      }
    };
    void processStream().catch(() => {
      this.connected = false;
    });
  }

  private handleSseData(data: string): void {
    try {
      const msg = JSON.parse(data) as McpMessage;
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
        else pending.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.notificationHandlers) h(msg.method, msg.params);
      }
    } catch {
      /* 忽略解析错误 */
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const endpoint = this.messageEndpoint ?? this.url;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP SSE request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }).catch((err) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  notify(method: string, params: unknown): void {
    const endpoint = this.messageEndpoint ?? this.url;
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {});
  }

  close(): void {
    this.connected = false;
    this.abortController?.abort();
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/* ---------- 工厂 ---------- */

export type TransportType = 'stdio' | 'http' | 'sse' | 'ws';

export function createTransport(
  type: TransportType,
  config: { command?: string; args?: string[]; url?: string; headers?: Record<string, string> },
): Transport {
  switch (type) {
    case 'stdio':
      return new StdioTransport(config.command ?? '', config.args ?? []);
    case 'http':
      return new HttpTransport(config.url ?? '', config.headers ?? {});
    case 'sse':
      return new SseTransport(config.url ?? '', config.headers ?? {});
    case 'ws':
      return new WebSocketTransport(config.url ?? '', config.headers ?? {});
    default:
      throw new Error(`Unknown transport type: ${type}`);
  }
}

/* ---------- WebSocket transport ----------
 * 使用 Node.js 内置全局 WebSocket 客户端（Node ≥ 20.10 实验性 / ≥ 22 稳定）。
 * 注意：浏览器规范的全局 WebSocket 不支持自定义请求头；若 server 需要
 * Authorization，请改用 http transport 或把令牌放进 URL 查询参数。
 */

export class WebSocketTransport implements Transport {
  private ws: import('undici-types').WebSocket | null = null;
  private connected = false;
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private connectTimeoutMs = 10_000;
  private requestTimeoutMs = 30_000;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async connect(): Promise<void> {
    const WS = (globalThis as { WebSocket?: new (url: string) => import('undici-types').WebSocket }).WebSocket;
    if (typeof WS !== 'function') {
      throw new Error('WebSocket transport requires Node.js >= 20.10 (built-in global WebSocket)');
    }
    if (!/^wss?:\/\//i.test(this.url)) {
      throw new Error(`WebSocket transport requires ws:// or wss:// url, got: ${this.url}`);
    }
    const ws = new WS(this.url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket connect timeout (${this.connectTimeoutMs}ms): ${this.url}`));
      }, this.connectTimeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        const msg = (ev as { message?: string }).message;
        reject(new Error(`WebSocket connection failed: ${this.url}${msg ? ` (${msg})` : ''}`));
      });
    });
    this.ws = ws;
    this.connected = true;
    ws.addEventListener('message', (ev) => {
      const data = (ev as { data?: unknown }).data;
      this.handleData(typeof data === 'string' ? data : String(data));
    });
    ws.addEventListener('close', () => {
      this.connected = false;
      this.failPending(new Error('WebSocket closed'));
    });
  }

  private handleData(text: string): void {
    let msg: McpMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
      else pending.resolve(msg.result);
    } else if (msg.method) {
      for (const h of this.notificationHandlers) h(msg.method, msg.params);
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.connected || !this.ws) return Promise.reject(new Error('WebSocket not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP WS request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {
      /* 静默失败，对齐其它 transport */
    }
  }

  close(): void {
    this.connected = false;
    this.failPending(new Error('WebSocket transport closed'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }
}
