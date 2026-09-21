/**
 * 文档分块与关键词打分 —— rag 层共享工具。
 * 独立模块避免 tools/rag.ts 与 rag/indexer.ts 循环依赖。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface DocChunk {
  file: string;
  heading: string;
  startLine: number;
  text: string;
}

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.tasks',
  '.team',
  '.transcripts',
  '.task_outputs',
  '.worktrees',
  '.cron',
  '.memory',
  '.audit',
  '.mcp',
  '.vector_index',
]);

/** 收集目录下所有 .md / .txt 文件。 */
export function collectDocs(root: string, limit = 200): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (/\.(md|txt|mdown)$/i.test(e.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

/** 按标题/固定行数分块。 */
export function chunkFile(file: string, maxLines = 60): DocChunk[] {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const chunks: DocChunk[] = [];
  let current: string[] = [];
  let heading = '';
  let startLine = 1;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ file, heading: heading || '(no heading)', startLine, text: current.join('\n') });
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      // 新标题到来：当前块已有实质内容（≥2 行）则切块；空块（紧邻标题）继续
      if (current.length >= 2) flush();
      heading = h[2].trim();
      startLine = i + 1;
      current.push(line);
    } else {
      current.push(line);
    }
    if (current.length >= maxLines) flush();
  }
  flush();
  return chunks;
}

/* ---------- 关键词打分 ---------- */

export function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。.;；:：!！?？]+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
}

export function scoreChunk(chunk: DocChunk, keywords: string[]): number {
  let score = 0;
  const text = chunk.text.toLowerCase();
  for (const kw of keywords) {
    if (text.includes(kw)) score += 2;
    for (const token of kw.split(/\s+/)) {
      if (token.length > 1 && text.includes(token)) score += 1;
    }
  }
  return score;
}
