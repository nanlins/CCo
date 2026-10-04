/**
 * Memory —— 压缩会丢细节，要有一层不丢的（s09 模式）。
 *
 * 文件仓库 + 索引：.memory/<name>.md（YAML frontmatter: name/description）。
 * 检索用 LLM 选择（不是 embedding）：把目录 + 查询喂给 LLM，返回命中的名字。
 * autoExtract：Stop 时从对话尾部提取候选记忆（教学版同款时机：stop hook）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LlmClient } from '../llm/client.js';
import type { Message } from '../types.js';
import { cosineSimilarity, type EmbeddingProvider } from '../rag/embedding.js';
import { safeWrite } from './safeWrite.js';

export interface MemoryEntry {
  name: string;
  description: string;
  body: string;
}

export class MemoryStore {
  constructor(private dir: string) {
    safeWrite(() => fs.mkdirSync(dir, { recursive: true }), 'memory 目录');
  }

  private file(name: string): string {
    return path.join(this.dir, `${sanitizeName(name)}.md`);
  }

  save(entry: MemoryEntry): string {
    const content = `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n\n${entry.body}`;
    safeWrite(() => fs.writeFileSync(this.file(entry.name), content, 'utf8'), 'memory ');
    return `Saved memory '${entry.name}'`;
  }

  load(name: string): string {
    const raw = fs.readFileSync(this.file(name), 'utf8');
    return stripFrontmatter(raw);
  }

  forget(name: string): string {
    const f = this.file(name);
    if (!fs.existsSync(f)) return `No memory '${name}'`;
    fs.unlinkSync(f);
    return `Forgot memory '${name}'`;
  }

  list(): MemoryEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => parseFrontmatter(fs.readFileSync(path.join(this.dir, f), 'utf8')))
      .filter((e): e is MemoryEntry => e.name !== '');
  }

  /** 目录行：`0: name — description`（注入 system prompt）。 */
  catalog(): string {
    const entries = this.list();
    if (entries.length === 0) return '（无记忆）';
    return entries.map((e, i) => `${i}: ${e.name} — ${e.description}`).join('\n');
  }

  /** LLM 检索：返回命中的记忆全文（结构化输出，失败回退文本解析）。 */
  async search(query: string, llm: LlmClient): Promise<string> {
    const cat = this.catalog();
    if (cat === '（无记忆）') return cat;
    const names = await this.selectRelevant(query, llm);
    if (names.length === 0) return '（无匹配记忆）';
    return names
      .map((n) => {
        const f = this.file(n);
        return fs.existsSync(f) ? `### ${n}\n${this.load(n)}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /** 向量检索：用 embedding 相似度选择记忆（0 API 调用，更快）。 */
  async searchByVector(query: string, embedder: EmbeddingProvider, topK = 3): Promise<string> {
    const entries = this.list();
    if (entries.length === 0) return '（无记忆）';

    /* 计算查询向量 */
    const qVecs = await embedder.embed([query]);
    const qVec = qVecs[0];
    if (!qVec) return '（无记忆）';

    /* 计算每个记忆的向量并排序 */
    const texts = entries.map((e) => `${e.name} ${e.description} ${e.body.slice(0, 200)}`);
    const memVecs = await embedder.embed(texts);

    const scored = entries
      .map((e, i) => ({ entry: e, score: cosineSimilarity(qVec, memVecs[i] ?? []) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter((x) => x.score > 0.1); // 相似度阈值

    if (scored.length === 0) return '（无匹配记忆）';

    return scored
      .map(({ entry, score }) => `### ${entry.name}（相似度=${score.toFixed(3)}）\n${this.load(entry.name)}`)
      .join('\n\n');
  }

  /** 记忆选择：优先结构化输出，同一响应文本兜底。 */
  private async selectRelevant(query: string, llm: LlmClient): Promise<string[]> {
    const cat = this.catalog();
    const result = await llm.complete({
      system: 'You select memory entries by relevance.',
      messages: [{ role: 'user', content: `Query: ${query}\nCatalog:\n${cat}\n\nSelect up to 3 relevant entries.` }],
      tools: [],
      maxTokens: 300,
      structured: {
        name: 'select_memories',
        description: 'Return the selected memory names as a JSON array.',
        schema: {
          type: 'object',
          properties: { selected_memories: { type: 'array', items: { type: 'string' } } },
          required: ['selected_memories'],
        },
      },
    });
    if (Array.isArray(result.structured?.selected_memories)) {
      return (result.structured.selected_memories as unknown[]).filter((n): n is string => typeof n === 'string');
    }
    const names = parseJsonArray(extractText(result));
    return names.filter((n): n is string => typeof n === 'string');
  }

  /** Stop 时提取候选记忆（LLM 决定，优先结构化输出）。 */
  async autoExtract(messages: Message[], llm: LlmClient, maxTokens = 1000): Promise<number> {
    const tail = messages.slice(-12);
    const serialized = tail
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => ('text' in b ? b.text : `[${b.type}]`)).join('\n'),
      )
      .join('\n---\n');
    const system =
      'You extract durable user preferences and project facts from a conversation. ' +
      'Names must be lowercase kebab-case. Empty array if nothing durable.';
    const result = await llm.complete({
      system,
      messages: [{ role: 'user', content: serialized }],
      tools: [],
      maxTokens,
      structured: {
        name: 'extract_memories',
        description: 'Extract durable memories as JSON.',
        schema: {
          type: 'object',
          properties: {
            memories: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  body: { type: 'string' },
                },
                required: ['name', 'description', 'body'],
              },
            },
          },
          required: ['memories'],
        },
      },
    });
    /* 结构化优先；同一响应的文本 JSON 兜底（兼容不支持 tool_choice 的端点）。 */
    let raw: unknown[] = Array.isArray(result.structured?.memories) ? (result.structured.memories as unknown[]) : [];
    if (raw.length === 0) {
      raw = parseJsonArray(extractText(result));
    }
    let saved = 0;
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const name = String(e.name ?? '');
      const description = String(e.description ?? '');
      const body = String(e.body ?? '');
      if (!name || !description || !body) continue;
      this.save({ name, description, body });
      saved += 1;
    }
    return saved;
  }

  /* ---------- Consolidate（Dream：去重/合并矛盾/淘汰过时） ---------- */

  private lockFile(): string {
    return path.join(this.dir, '.consolidate-lock');
  }

  /** 四层门控：时间间隔 / 条目阈值 / 会话门控 / 锁门控。返回是否应该执行。 */
  shouldConsolidate(opts: { minIntervalMs?: number; minEntries?: number; minSessions?: number } = {}): boolean {
    const minInterval = opts.minIntervalMs ?? 24 * 60 * 60 * 1000; // 默认 24h
    const minEntries = opts.minEntries ?? 10;
    // 1. 时间门控：距上次合并 ≥ minInterval
    if (fs.existsSync(this.lockFile())) {
      const mtime = fs.statSync(this.lockFile()).mtimeMs;
      if (Date.now() - mtime < minInterval) return false;
    }
    // 2. 条目阈值：记忆数量足够多才值得整理
    if (this.list().length < minEntries) return false;
    // 3. 锁门控：没有其他进程正在合并（锁文件 mtime 在 1 小时内视为活跃）
    if (fs.existsSync(this.lockFile())) {
      const mtime = fs.statSync(this.lockFile()).mtimeMs;
      if (Date.now() - mtime < 60 * 60 * 1000) return false;
    }
    return true;
  }

  /** 执行 Consolidate：LLM 去重合并，替换全部记忆文件。返回合并前后数量。 */
  async consolidate(llm: LlmClient, maxTokens = 2000): Promise<{ before: number; after: number }> {
    const entries = this.list();
    const before = entries.length;
    if (before < 2) return { before, after: before };

    const serialized = entries.map((e) => `- ${e.name}: ${e.description}\n  ${e.body.slice(0, 500)}`).join('\n');
    const system =
      'You consolidate a memory store. Deduplicate, merge contradictions (keep the newer/more specific), ' +
      'drop outdated entries. Names must be lowercase kebab-case. Return the final list.';

    let raw: unknown[];
    const result = await llm.complete({
      system,
      messages: [{ role: 'user', content: `Existing memories:\n${serialized}` }],
      tools: [],
      maxTokens,
      structured: {
        name: 'consolidate_memories',
        description: 'Return the consolidated memory list.',
        schema: {
          type: 'object',
          properties: {
            memories: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  body: { type: 'string' },
                },
                required: ['name', 'description', 'body'],
              },
            },
          },
          required: ['memories'],
        },
      },
    });
    raw = Array.isArray(result.structured?.memories) ? (result.structured.memories as unknown[]) : [];
    if (raw.length === 0) raw = parseJsonArray(extractText(result));
    if (raw.length === 0) return { before, after: before };

    // 记录合并时间（锁文件 mtime 即 lastConsolidatedAt）
    safeWrite(() => {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.lockFile(), JSON.stringify({ ts: Date.now() }), 'utf8');
    }, 'memory 锁');

    const valid: MemoryEntry[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const name = String(e.name ?? '');
      const description = String(e.description ?? '');
      const body = String(e.body ?? '');
      if (!name || !description || !body) continue;
      valid.push({ name, description, body });
    }
    if (valid.length === 0) return { before, after: before };

    // 删除旧文件，写入合并结果
    for (const e of entries) this.forget(e.name);
    for (const e of valid) this.save(e);
    return { before, after: valid.length };
  }
}

/* ---------- frontmatter 解析（免 yaml 依赖） ---------- */

function sanitizeName(name: string): string {
  return name.replace(/[^\w-]/g, '_').slice(0, 64);
}

function parseFrontmatter(raw: string): Partial<MemoryEntry> {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { name: '', description: '', body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { name: meta.name ?? '', description: meta.description ?? '', body: m[2].trim() };
}

function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1].trim() : raw;
}

/* ---------- LLM 输出解析 ---------- */

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
