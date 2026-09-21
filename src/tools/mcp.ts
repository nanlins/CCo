/**
 * MCP —— 外接工具，标准协议（s19 模式）。
 *
 * 支持 3 种 transport（对齐 CC 的 6 种，教学版实现核心 3 种）：
 *   stdio：子进程 JSON-RPC（默认）
 *   http：Streamable HTTP
 *   sse：Server-Sent Events
 *
 * 支持 OAuth 2.0 + PKCE 认证（远程 server）。
 * 支持 channel 反向通知（server → agent 推送消息）。
 *
 * 配置 .mcp/servers.json：
 *   { "docs": { "command": "node", "args": ["examples/mcp-echo-server.mjs"] } }
 *   { "remote": { "url": "https://api.example.com/mcp", "transport": "http", "oauth": {...} } }
 *
 * 工具名统一 mcp__server__tool；连接后动态注册进 ToolRegistry。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDef, ToolSchema } from '../types.js';
import type { ToolRegistry } from '../core/registry.js';
import { createTransport, type Transport, type TransportType } from '../mcp/transport.js';
import { TokenStore, authorize, type OAuthConfig } from '../mcp/oauth.js';

/** 用户级 MCP 信任存储目录（默认 ~/.anvil）。信任状态不得存放在 agent 可写的工作区内。 */
export function defaultMcpTrustDir(): string {
  return path.join(os.homedir(), '.anvil');
}

export interface McpServerConfig {
  /** stdio 模式：命令。 */
  command?: string;
  args?: string[];
  /** http/sse 模式：URL。 */
  url?: string;
  /** transport 类型（默认 stdio）。 */
  transport?: TransportType;
  /** 额外请求头（http/sse）。 */
  headers?: Record<string, string>;
  /** OAuth 配置（远程 server）。 */
  oauth?: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    scope?: string;
  };
}

export class McpClient {
  tools: ToolSchema[] = [];
  private transport: Transport;
  private reconnectAttempts = 0;
  private maxReconnects = 3;
  private intentionalClose = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private channelHandlers: Array<(source: string, message: string) => void> = [];
  private tokenStore: TokenStore | null = null;
  private oauthConfig: OAuthConfig | null = null;

  constructor(
    public name: string,
    private cfg: McpServerConfig,
    private workdir: string,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
  ) {
    const type = cfg.transport ?? 'stdio';
    this.transport = createTransport(type, {
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      headers: cfg.headers,
    });
    if (cfg.oauth) {
      this.oauthConfig = {
        authorizationEndpoint: cfg.oauth.authorizationEndpoint,
        tokenEndpoint: cfg.oauth.tokenEndpoint,
        clientId: cfg.oauth.clientId,
        scope: cfg.oauth.scope,
      };
      this.tokenStore = new TokenStore(path.join(workdir, '.mcp'));
    }
    /* channel 反向通知：server 推送消息给 agent */
    this.transport.onNotification((method, params) => {
      if (method === 'notifications/claude/channel') {
        const p = params as { message?: string };
        for (const h of this.channelHandlers) h(this.name, p.message ?? '');
      }
    });
  }

  async connect(): Promise<void> {
    if (this.intentionalClose) return;

    /* OAuth：获取有效令牌 */
    if (this.oauthConfig && this.tokenStore) {
      let token = await this.tokenStore.getValidToken(this.name, this.oauthConfig);
      if (!token) {
        this.log('info', `[mcp ${this.name}] 需要 OAuth 授权...`);
        const tokens = await authorize(this.oauthConfig);
        this.tokenStore.save(this.name, tokens);
        token = tokens.accessToken;
      }
      /* 注入 Authorization header */
      if (this.cfg.headers) {
        this.cfg.headers['Authorization'] = `Bearer ${token}`;
      } else {
        this.cfg.headers = { Authorization: `Bearer ${token}` };
      }
      /* 重建 transport 以应用新 header */
      const type = this.cfg.transport ?? 'stdio';
      this.transport = createTransport(type, {
        command: this.cfg.command,
        args: this.cfg.args,
        url: this.cfg.url,
        headers: this.cfg.headers,
      });
    }

    await this.transport.connect();

    const initResult = (await this.transport.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'anvil-agent', version: '0.1.0' },
    })) as { capabilities?: Record<string, unknown> };

    this.transport.notify('notifications/initialized', {});

    /* 检查 server 是否支持 channel 通知 */
    const caps = initResult?.capabilities ?? {};
    const experimental = (caps as { experimental?: Record<string, unknown> }).experimental ?? {};
    if (experimental['claude/channel']) {
      this.log('info', `[mcp ${this.name}] 支持 channel 反向通知`);
    }

    const listResult = (await this.transport.request('tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    this.tools = (listResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? `MCP tool from ${this.name}`,
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    this.reconnectAttempts = 0;
  }

  /** 注册 channel 通知回调。 */
  onChannel(handler: (source: string, message: string) => void): void {
    this.channelHandlers.push(handler);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      const res = (await this.transport.request('tools/call', { name, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const content = res.content ?? [];
      return content.map((c) => c.text ?? JSON.stringify(c)).join('\n') || JSON.stringify(res);
    } catch (err) {
      /* 连接断开 → 尝试重连 */
      if (!this.transport.isConnected() && this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        this.log('warn', `[mcp ${this.name}] 连接断开，尝试重连 (${this.reconnectAttempts}/${this.maxReconnects})`);
        try {
          await this.connect();
          return this.callTool(name, args);
        } catch {
          /* 重连失败 */
        }
      }
      throw err;
    }
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.transport.close();
  }
}

export class McpPool {
  private clients = new Map<string, McpClient>();
  private channelMessages: Array<{ source: string; message: string }> = [];
  /**
   * 信任存储目录：默认用户级（~/.anvil），不在 agent 可写的 workspace 内。
   * 这样 agent 即使能写 workspace 也无法给自己"预先授信"。
   */
  private trustDir: string;

  constructor(
    private workdir: string,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
    trustDir?: string,
  ) {
    this.trustDir = trustDir ?? defaultMcpTrustDir();
  }

  private configPath(): string {
    return path.join(this.workdir, '.mcp', 'servers.json');
  }

  private trustPath(): string {
    return path.join(this.trustDir, 'mcp-trusted.json');
  }

  private loadConfig(): Record<string, McpServerConfig> {
    if (!fs.existsSync(this.configPath())) return {};
    try {
      return JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) as Record<string, McpServerConfig>;
    } catch {
      return {};
    }
  }

  /* ---------- 信任门 ----------
   * .mcp/servers.json 可以写任意 command，连接即启动子进程（= 任意代码执行）。
   * 因此首次连接必须向用户展示命令并请求确认；确认结果按"完整配置指纹"持久化到
   * 用户级目录（~/.anvil/mcp-trusted.json，agent 不可写）。配置任何字段变化
   * （command/args/url/transport/headers/oauth）都会使信任失效，必须重新确认。
   * 工作区内的 .mcp/trusted.json 一律被忽略（防 agent 自我授信）。 */

  /** 服务器配置的人类可读描述（审批弹窗展示用）。 */
  describeServer(cfg: McpServerConfig): string {
    if (cfg.command) {
      return `command: ${cfg.command}${cfg.args?.length ? ' ' + cfg.args.join(' ') : ''}`;
    }
    if (cfg.url) return `url: ${cfg.url} (transport: ${cfg.transport ?? 'http'})`;
    return '(unknown server config)';
  }

  /** 完整配置指纹：command/args/url/transport/headers/oauth 任一变化都会使信任失效。 */
  fingerprint(cfg: McpServerConfig): string {
    const payload = JSON.stringify({
      command: cfg.command ?? null,
      args: cfg.args ?? [],
      url: cfg.url ?? null,
      transport: cfg.transport ?? (cfg.command ? 'stdio' : 'http'),
      headers: cfg.headers ?? {},
      oauth: cfg.oauth ?? null,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private loadTrust(): Record<string, string> {
    if (!fs.existsSync(this.trustPath())) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.trustPath(), 'utf8'));
      return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private saveTrust(trust: Record<string, string>): void {
    try {
      fs.mkdirSync(path.dirname(this.trustPath()), { recursive: true });
      fs.writeFileSync(this.trustPath(), JSON.stringify(trust, null, 2), 'utf8');
    } catch (err) {
      this.log('warn', `[mcp] failed to persist trust store: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 该 server 当前配置是否已被用户信任。 */
  isTrusted(name: string): boolean {
    const cfg = this.loadConfig()[name];
    if (!cfg) return false;
    return this.loadTrust()[name] === this.fingerprint(cfg);
  }

  available(): string[] {
    return Object.keys(this.loadConfig());
  }

  list(): string[] {
    return [...this.clients.keys()];
  }

  /** 获取并清空 channel 消息（供 agent inject 使用）。 */
  drainChannelMessages(): Array<{ source: string; message: string }> {
    const msgs = [...this.channelMessages];
    this.channelMessages = [];
    return msgs;
  }

  /**
   * 连接 MCP server。信任门：未信任的配置必须先经 ask 确认（展示命令），
   * 拒绝或未提供 ask（非交互）时绝不启动子进程。
   */
  async connect(name: string, registry: ToolRegistry, ask?: (question: string) => Promise<boolean>): Promise<string> {
    const cfg = this.loadConfig()[name];
    if (!cfg) {
      return `Error: unknown server '${name}'. Configure .mcp/servers.json. Available: ${this.available().join(', ') || '(none)'}`;
    }
    if (this.clients.has(name)) return `Already connected to '${name}'`;

    /* 信任门：首次连接（或配置变更后）必须用户确认 */
    if (!this.isTrusted(name)) {
      if (!ask) {
        return `Error: MCP server '${name}' is not trusted and no interactive approval channel is available; connection refused.`;
      }
      const desc = this.describeServer(cfg);
      const ok = await ask(
        `Connect MCP server '${name}'?\n  ${desc}\n  连接将启动上述子进程/远程连接（来自 .mcp/servers.json，属于可执行代码）。允许？ [y/N]`,
      );
      if (!ok) {
        return `Error: MCP server '${name}' not trusted by user; connection refused (no process was started).`;
      }
      const trust = this.loadTrust();
      trust[name] = this.fingerprint(cfg);
      this.saveTrust(trust);
      this.log('info', `[mcp] '${name}' trusted and recorded in ${this.trustPath()}`);
    }

    const client = new McpClient(name, cfg, this.workdir, this.log);
    /* channel 通知 → 收集到 pool */
    client.onChannel((source, message) => {
      this.channelMessages.push({ source, message });
    });
    try {
      await client.connect();
    } catch (err) {
      return `Error connecting to '${name}': ${err instanceof Error ? err.message : String(err)}`;
    }
    this.clients.set(name, client);
    let registered = 0;
    for (const tool of client.tools) {
      const fullName = `mcp__${name}__${tool.name}`;
      registry.register({
        schema: { ...tool, name: fullName },
        executor: async (args: Record<string, unknown>): Promise<string> => client.callTool(tool.name, args),
      });
      registered += 1;
    }
    return `Connected to '${name}'. Discovered tools: ${client.tools.map((t) => t.name).join(', ')} (registered ${registered})`;
  }

  async disconnect(name: string, registry: ToolRegistry): Promise<string> {
    const client = this.clients.get(name);
    if (!client) return `Not connected to '${name}'`;
    for (const tool of client.tools) registry.unregister(`mcp__${name}__${tool.name}`);
    client.close();
    this.clients.delete(name);
    return `Disconnected '${name}'`;
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

export function mcpTools(pool: McpPool): ToolDef[] {
  return [
    {
      schema: {
        name: 'connect_mcp',
        description: '从 .mcp/servers.json 连接一个 MCP server（支持 stdio/http/sse）；下一轮起它的工具可用。',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', description: '配置中的 server 名' } },
          required: ['name'],
        },
      },
      executor: async (
        args: Record<string, unknown>,
        ctx: {
          registry: ToolRegistry;
          ask: (question: string) => Promise<boolean>;
        },
      ): Promise<string> => pool.connect(String(args.name ?? ''), ctx.registry, ctx.ask),
    },
    {
      schema: {
        name: 'disconnect_mcp',
        description: '断开一个 MCP server 并移除它的工具。',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      executor: async (
        args: Record<string, unknown>,
        ctx: {
          registry: ToolRegistry;
        },
      ): Promise<string> => pool.disconnect(String(args.name ?? ''), ctx.registry),
    },
    {
      schema: {
        name: 'mcp_list',
        description: '列出已连接的 MCP server。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: (): string => {
        const list = pool.list();
        return list.length ? list.join(', ') : '（未连接 MCP server）';
      },
      concurrencySafe: true,
    },
  ];
}
