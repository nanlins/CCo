/**
 * Redis 服务 —— 工具结果缓存 + 会话状态 + 限流。
 *
 * 功能：
 *   1. 工具结果缓存：相同工具+参数短期缓存（TTL 5分钟），避免重复执行
 *   2. 会话状态存储：跨进程共享会话元数据
 *   3. 限流：滑动窗口限制 LLM 调用频率
 *
 * 连接：redis://localhost:6379（Docker 容器 redis-local）
 */
import { Redis } from 'ioredis';
import type { Redis as RedisType } from 'ioredis';

export interface RedisServiceOptions {
  /** Redis 连接 URL（默认 redis://localhost:6379）。 */
  url?: string;
  /** 工具结果缓存 TTL（秒，默认 300）。 */
  toolCacheTtl?: number;
  /** 限流：每分钟最大 LLM 调用次数（默认 60）。 */
  rateLimitPerMinute?: number;
}

export class RedisService {
  private client: RedisType | null = null;
  private toolCacheTtl: number;
  private rateLimitPerMinute: number;
  private connected = false;

  constructor(private opts: RedisServiceOptions = {}) {
    this.toolCacheTtl = opts.toolCacheTtl ?? 300;
    this.rateLimitPerMinute = opts.rateLimitPerMinute ?? 60;
  }

  /** 连接 Redis（懒连接，失败时降级为无缓存模式）。 */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    try {
      const client = new Redis(this.opts.url ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: 2,
        retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });
      /* 生产级：连接断开必须落状态，否则 isConnected() 撒谎 + ioredis 抛 unhandled error */
      client.on('error', () => {
        this.connected = false;
      });
      client.on('end', () => {
        this.connected = false;
        this.client = null;
      });
      await client.connect();
      this.client = client;
      this.connected = true;
      return true;
    } catch {
      this.client = null;
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /* ---------- 工具结果缓存 ---------- */

  private toolCacheKey(toolName: string, args: Record<string, unknown>): string {
    const argsStr = JSON.stringify(args);
    return `anvil:tool:${toolName}:${argsStr.slice(0, 200)}`;
  }

  /** 获取缓存的工具结果（null 表示未命中）。 */
  async getToolCache(toolName: string, args: Record<string, unknown>): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(this.toolCacheKey(toolName, args));
    } catch {
      return null;
    }
  }

  /** 设置工具结果缓存。 */
  async setToolCache(toolName: string, args: Record<string, unknown>, result: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setex(this.toolCacheKey(toolName, args), this.toolCacheTtl, result);
    } catch {
      /* 忽略缓存失败 */
    }
  }

  /* ---------- 会话状态 ---------- */

  /** 保存会话元数据。 */
  async saveSessionMeta(sessionId: string, meta: Record<string, unknown>): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(`anvil:session:${sessionId}`, JSON.stringify(meta), 'EX', 86400);
    } catch {
      /* 忽略 */
    }
  }

  /** 获取会话元数据。 */
  async getSessionMeta(sessionId: string): Promise<Record<string, unknown> | null> {
    if (!this.client) return null;
    try {
      const data = await this.client.get(`anvil:session:${sessionId}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  /** 列出所有会话 ID。 */
  async listSessions(): Promise<string[]> {
    if (!this.client) return [];
    try {
      const keys = await this.client.keys('anvil:session:*');
      return keys.map((k: string) => k.replace('anvil:session:', ''));
    } catch {
      return [];
    }
  }

  /* ---------- 限流 ---------- */

  /** 检查是否允许 LLM 调用（滑动窗口限流）。 */
  async checkRateLimit(key = 'llm'): Promise<boolean> {
    if (!this.client) return true; // 无 Redis 时不限流
    try {
      const now = Date.now();
      const windowStart = now - 60_000;
      const redisKey = `anvil:ratelimit:${key}`;

      /* 移除窗口外的记录 */
      await this.client.zremrangebyscore(redisKey, 0, windowStart);
      /* 统计窗口内的调用次数 */
      const count = await this.client.zcard(redisKey);
      if (count >= this.rateLimitPerMinute) return false;
      /* 记录本次调用 */
      await this.client.zadd(redisKey, now, `${now}`);
      await this.client.expire(redisKey, 120);
      return true;
    } catch {
      return true; // 限流失败时放行
    }
  }

  /* ---------- 关闭 ---------- */

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.connected = false;
    }
  }
}
