/**
 * 向量存储层 —— 可插拔后端。
 *
 * 1. InMemoryVectorStore：纯 JS，Map + 暴力余弦检索，JSON 持久化到磁盘。
 *    零依赖、离线可跑，教学默认实现。
 * 2. PgVectorStore：PostgreSQL + pgvector 扩展，`<=>` 余弦距离索引检索。
 *    生产级实现：建表 / upsert / HNSW 索引 / JSONB 元数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { cosineSimilarity } from './embedding.js';

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  /** 写入或覆盖一个向量。 */
  upsert(rec: VectorRecord): Promise<void>;
  /** 批量写入。 */
  upsertMany(recs: VectorRecord[]): Promise<void>;
  /** 余弦相似度 Top-K 检索。 */
  search(vector: number[], topK: number): Promise<SearchHit[]>;
  /** 记录数。 */
  count(): Promise<number>;
  /** 清空。 */
  clear(): Promise<void>;
}

/* ---------- 内存实现（默认，JSON 持久化） ---------- */

export class InMemoryVectorStore implements VectorStore {
  private records = new Map<string, VectorRecord>();
  private file: string;

  constructor(persistDir: string) {
    this.file = path.join(persistDir, 'vectors.json');
    fs.mkdirSync(persistDir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as VectorRecord[];
      for (const r of parsed) this.records.set(r.id, r);
    } catch {
      // 损坏则忽略
    }
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify([...this.records.values()]), 'utf8');
  }

  async upsert(rec: VectorRecord): Promise<void> {
    this.records.set(rec.id, rec);
    this.save();
  }

  async upsertMany(recs: VectorRecord[]): Promise<void> {
    for (const r of recs) this.records.set(r.id, r);
    this.save();
  }

  async search(vector: number[], topK: number): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const rec of this.records.values()) {
      const score = cosineSimilarity(vector, rec.vector);
      hits.push({ id: rec.id, score, metadata: rec.metadata });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.save();
  }
}

/* ---------- PostgreSQL + pgvector 实现 ---------- */

export interface PgVectorOptions {
  connectionString: string;
  /** 向量维度，必须与 embedding 维度一致（默认 384）。 */
  dims?: number;
  tableName?: string;
}

export class PgVectorStore implements VectorStore {
  private pool: pg.Pool;
  private table: string;
  private dims: number;
  private initialized = false;

  constructor(private opts: PgVectorOptions) {
    this.pool = new pg.Pool({ connectionString: opts.connectionString });
    this.table = opts.tableName ?? 'doc_vectors';
    this.dims = opts.dims ?? 384;
  }

  /** 建表 + HNSW 索引（幂等，首次使用时惰性执行）。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY,
      embedding vector(${this.dims}),
      metadata JSONB NOT NULL DEFAULT '{}'
    )`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_hnsw_idx ON ${this.table} USING hnsw (embedding vector_cosine_ops)`,
    );
    this.initialized = true;
  }

  async upsert(rec: VectorRecord): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO ${this.table} (id, embedding, metadata) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
      [rec.id, JSON.stringify(rec.vector), JSON.stringify(rec.metadata)],
    );
  }

  async upsertMany(recs: VectorRecord[]): Promise<void> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of recs) {
        await client.query(
          `INSERT INTO ${this.table} (id, embedding, metadata) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
          [r.id, JSON.stringify(r.vector), JSON.stringify(r.metadata)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async search(vector: number[], topK: number): Promise<SearchHit[]> {
    await this.init();
    const res = await this.pool.query<{ id: string; score: number; metadata: Record<string, unknown> }>(
      `SELECT id, 1 - (embedding <=> $1) AS score, metadata
       FROM ${this.table}
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [JSON.stringify(vector), topK],
    );
    return res.rows.map((r) => ({ id: r.id, score: r.score, metadata: r.metadata }));
  }

  async count(): Promise<number> {
    await this.init();
    const res = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${this.table}`);
    return Number(res.rows[0]?.n ?? 0);
  }

  async clear(): Promise<void> {
    await this.init();
    await this.pool.query(`DELETE FROM ${this.table}`);
  }

  close(): void {
    void this.pool.end();
  }
}

/* ---------- 工厂 ---------- */

export function createVectorStore(opts: {
  kind: 'memory' | 'pg';
  persistDir: string;
  pg?: PgVectorOptions;
}): VectorStore {
  if (opts.kind === 'pg' && opts.pg?.connectionString) {
    return new PgVectorStore(opts.pg);
  }
  return new InMemoryVectorStore(opts.persistDir);
}
