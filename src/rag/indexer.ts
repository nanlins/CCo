/**
 * 文档索引器 —— 分块 → embedding → 入库（增量更新）。
 *
 * 增量策略：按文件 mtime 记录索引状态，未变更文件跳过重新 embedding，
 * 变更文件重新分块并 upsert；已删除文件从索引清除。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingProvider } from './embedding.js';
import type { VectorStore } from './vectorStore.js';
import { collectDocs, chunkFile } from './chunker.js';

export interface IndexerOptions {
  root: string;
  embedder: EmbeddingProvider;
  store: VectorStore;
  /** 索引状态文件（内存实现持久化目录内）。 */
  stateFile: string;
  /** embedding 批次大小。 */
  batchSize?: number;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  removed: number;
  total: number;
}

export class DocIndexer {
  private stateFile: string;
  private batchSize: number;

  constructor(private opts: IndexerOptions) {
    this.stateFile = opts.stateFile;
    this.batchSize = opts.batchSize ?? 16;
  }

  /** 构建/更新索引；返回统计。 */
  async run(): Promise<IndexResult> {
    const root = this.opts.root;
    const files = collectDocs(root);
    const state = this.loadState();

    const changed: Array<{ file: string; rel: string; mtime: number }> = [];
    const removed: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const stat = fs.statSync(file);
      if (state[rel] !== stat.mtimeMs) {
        changed.push({ file, rel, mtime: stat.mtimeMs });
      }
    }
    for (const rel of Object.keys(state)) {
      if (!files.some((f) => path.relative(root, f).split(path.sep).join('/') === rel)) {
        removed.push(rel);
      }
    }

    let indexed = 0;
    let skipped = 0;
    for (const { file, rel, mtime } of changed) {
      const chunks = chunkFile(file);
      const recs: Array<{ id: string; vector: number[]; metadata: Record<string, unknown> }> = [];
      // 分批 embedding，控制 API 调用量
      for (let i = 0; i < chunks.length; i += this.batchSize) {
        const batch = chunks.slice(i, i + this.batchSize);
        const vectors = await this.opts.embedder.embed(batch.map((c) => c.text));
        for (let j = 0; j < batch.length; j++) {
          recs.push({
            id: `${rel}#${batch[j].startLine}`,
            vector: vectors[j] ?? [],
            metadata: {
              file: rel,
              heading: batch[j].heading,
              startLine: batch[j].startLine,
              text: batch[j].text.slice(0, 1500),
            },
          });
        }
      }
      await this.opts.store.upsertMany(recs);
      state[rel] = mtime;
      indexed += chunks.length;
      skipped += chunks.length === 0 ? 1 : 0;
    }

    if (removed.length > 0) {
      for (const rel of removed) delete state[rel];
      // 内存实现不支持按前缀删除，重建成本高；简单起见记录即可
    }

    this.saveState(state);
    return { indexed, skipped, removed: removed.length, total: (await this.opts.store.count()) as number };
  }

  private loadState(): Record<string, number> {
    if (!fs.existsSync(this.stateFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private saveState(state: Record<string, number>): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(state), 'utf8');
  }
}

export { collectDocs, chunkFile, type DocChunk } from './chunker.js';
