/**
 * RAG —— search_docs / index_docs 工具（混合检索：向量 + 关键词）。
 *
 * 检索管线：
 *   1. 向量检索（语义）：查询 embedding → Top-K 余弦相似度
 *   2. 关键词打分（快速精排）：命中词加权
 *   3. 混合排序：向量分 × 0.6 + 关键词分 × 0.4
 *   4. 引用溯源：结果带 文件:行号 与章节标题
 *
 * 存储后端可插拔：InMemoryVectorStore（默认，零依赖）/ PgVectorStore（pgvector）。
 * embedding 可插拔：OpenAiCompatibleEmbedder（API）/ LocalHashEmbedder（本地兜底）。
 */
import type { ToolDef } from '../types.js';
import type { EmbeddingProvider } from '../rag/embedding.js';
import type { VectorStore } from '../rag/vectorStore.js';
import { DocIndexer, type IndexResult } from '../rag/indexer.js';
import { extractKeywords, scoreChunk } from '../rag/chunker.js';

export interface RagServiceOptions {
  root: string;
  embedder: EmbeddingProvider;
  store: VectorStore;
  stateFile: string;
}

export class RagService {
  private indexer: DocIndexer;

  constructor(private opts: RagServiceOptions) {
    this.indexer = new DocIndexer({
      root: opts.root,
      embedder: opts.embedder,
      store: opts.store,
      stateFile: opts.stateFile,
    });
  }
  get root(): string {
    return this.opts.root;
  }

  get embedder(): EmbeddingProvider {
    return this.opts.embedder;
  }

  get store(): VectorStore {
    return this.opts.store;
  }

  get stateFile(): string {
    return this.opts.stateFile;
  }

  /** 构建/更新索引。 */
  async index(): Promise<IndexResult> {
    return this.indexer.run();
  }

  /** 混合检索：向量 + 关键词（可选 LLM Rerank 二阶段精排）。 */
  async search(query: string, topK = 5, rerank?: { llm: import('../llm/client.js').LlmClient }): Promise<string> {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return '（无效查询）';

    const qVec = await this.opts.embedder.embed([query]);
    const vectorHits = await this.opts.store.search(qVec[0] ?? [], Math.max(topK * 4, 20));

    const scored = vectorHits
      .map((h) => ({
        hit: h,
        kw: scoreChunk(
          {
            file: String(h.metadata.file ?? ''),
            heading: String(h.metadata.heading ?? ''),
            startLine: Number(h.metadata.startLine ?? 0),
            text: String(h.metadata.text ?? ''),
          },
          keywords,
        ),
      }))
      .filter((x) => x.hit.score > 0.05 || x.kw > 0);

    /* 无命中判定：关键词零命中 且 向量分低于阈值（本地哈希 embedding 噪音大，阈值更高）。 */
    const simThreshold = this.opts.embedder.isLocal() ? 0.15 : 0.3;
    const maxSim = scored.reduce((m, x) => Math.max(m, x.hit.score), 0);
    if (scored.length === 0 || (maxSim < simThreshold && scored.every((x) => x.kw === 0))) {
      return '未找到相关内容（请尝试换关键词，或先运行 index_docs 建立文档索引）。';
    }

    let top = scored
      .sort((a, b) => b.hit.score * 0.6 + b.kw * 0.4 - (a.hit.score * 0.6 + a.kw * 0.4))
      .slice(0, Math.max(topK * 2, 10));

    /* Rerank（二阶段精排）：LLM 对候选按相关性打分排序（PDF-RAG 章节的粗排+精排架构）。 */
    if (rerank && top.length > 0) {
      const reranked = await rerankWithLlm(query, top, rerank.llm);
      if (reranked && reranked.length > 0) top = reranked.slice(0, topK);
    }

    return top
      .map(({ hit, kw }) => {
        const file = String(hit.metadata.file ?? '');
        const heading = String(hit.metadata.heading ?? '');
        const startLine = Number(hit.metadata.startLine ?? 0);
        const text = String(hit.metadata.text ?? '');
        const sim = hit.score.toFixed(3);
        return `### 来源: ${file}:${startLine}（§${heading}）相似度=${sim}${kw > 0 ? ` 关键词命中=${kw}` : ''}\n${text}`;
      })
      .join('\n\n---\n\n');
  }
}

/** LLM Rerank：让模型对候选块按与查询的相关性排序（返回原顺序的子集）。 */
async function rerankWithLlm(
  query: string,
  candidates: Array<{ hit: { id: string; score: number; metadata: Record<string, unknown> }; kw: number }>,
  llm: import('../llm/client.js').LlmClient,
): Promise<Array<{ hit: { id: string; score: number; metadata: Record<string, unknown> }; kw: number }> | null> {
  try {
    const list = candidates
      .map(
        (c, i) =>
          `${i}. ${String(c.hit.metadata.file ?? '')}:${Number(c.hit.metadata.startLine ?? 0)} — ${String(c.hit.metadata.text ?? '').slice(0, 200)}`,
      )
      .join('\n');
    const result = await llm.complete({
      system:
        'You rerank retrieved passages by relevance to the query. Keep only the most relevant, in order. Reply with JSON.',
      messages: [{ role: 'user', content: `Query: ${query}\nCandidates:\n${list}` }],
      tools: [],
      maxTokens: 200,
      structured: {
        name: 'rerank_passages',
        description: 'Return the reranked indices (from 0) in order.',
        schema: {
          type: 'object',
          properties: {
            order: { type: 'array', items: { type: 'integer' } },
          },
          required: ['order'],
        },
      },
    });
    const order = result.structured?.order as number[] | undefined;
    if (!Array.isArray(order) || order.length === 0) return null;
    const out: typeof candidates = [];
    for (const idx of order) {
      if (idx >= 0 && idx < candidates.length) out.push(candidates[idx]);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null; // rerank 失败回退原排序
  }
}

/* ---------- 工具 ---------- */

export interface RagToolDeps {
  root: string;
  embedder: EmbeddingProvider;
  store: VectorStore;
  stateFile: string;
}

export function ragTools(deps: RagToolDeps): ToolDef[] {
  const service = new RagService(deps);
  return [
    {
      schema: {
        name: 'search_docs',
        description:
          '在文档中做语义检索（向量 + 关键词混合），返回带文件行号引用的内容块。回答引用问题时先用它，找不到就说找不到。',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或问题' },
            top_k: { type: 'integer', description: '返回结果数（默认 5）', default: 5 },
          },
          required: ['query'],
        },
      },
      executor: async (args: Record<string, unknown>): Promise<string> => {
        const query = String(args.query ?? '');
        const topK = typeof args.top_k === 'number' ? args.top_k : 5;
        try {
          return await service.search(query, topK);
        } catch (err) {
          return `检索失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      schema: {
        name: 'index_docs',
        description: '构建/更新文档向量索引（增量：未变更文件跳过）。首次使用 search_docs 前运行一次。',
        input_schema: { type: 'object', properties: {} },
      },
      executor: async (): Promise<string> => {
        try {
          const r = await service.index();
          return `索引完成: 新索引 ${r.indexed} 块，当前共 ${r.total} 块。`;
        } catch (err) {
          return `索引失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}
