/**
 * Context Compact —— 上下文总会满，要有办法腾地方（s08 模式）。
 *
 * 四层管线（便宜的先跑，贵的后跑）：
 *   L3 budget：大 tool_result 落盘，上下文只留标记 + 预览
 *   L1 snip：裁掉对话中段（保护 tool_use/tool_result 配对）
 *   L2 micro：旧 tool_result 换占位符
 *   L4 LLM 摘要：仍超阈值时，禁止工具的纯文本压缩调用
 * 以及 reactiveCompact：prompt_too_long 时的应急路径（s11）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LlmClient } from '../llm/client.js';
import type { Message, ToolResultBlock } from '../types.js';
import { countChars, isToolResultBlock, messageBlocks } from '../types.js';
import type { ReadFileState } from './readFileState.js';

export interface CompactOptions {
  thresholdChars: number;
  /** token 阈值（主闸门）：估算输入 token 超此值即触发 L3 落盘。 */
  thresholdTokens: number;
  /** 输入 token 预算上限（80% 触发预警提示）。 */
  budgetTokens: number;
  /** L1 snip 的 token 触发阈值（消息数未超但 token 超限也裁中段）。 */
  snipTokens: number;
  /** 只读长输出预览保留字符数（L2 截断）。 */
  previewChars: number;
  maxMessages: number;
  keepHead: number;
  keepRecentToolResults: number;
  maxToolResultChars: number;
  persistDir: string;
  onAction?: (action: string) => void;
  /** 压缩/落盘时把对应文件标记为 evicted，供 read_file 重读完整内容。 */
  readFileState?: ReadFileState;
  /** 解析 read_file 相对路径的基准目录（默认进程 cwd）。 */
  baseDir?: string;
}

const DEFAULTS = {
  maxMessages: 50,
  keepHead: 3,
  keepRecentToolResults: 3,
  maxToolResultChars: 200_000,
  thresholdTokens: 40_000,
  budgetTokens: 100_000,
  snipTokens: 60_000,
  previewChars: 1200,
};

/** 知识类工具的结果是 agent 推理的依据，压缩掉会造成"读了后面忘了前面"。 */
const KNOWLEDGE_TOOLS = new Set(['read_file', 'pdf_parsing', 'search_docs']);

/** 只读长输出：L2 用"预览截断"而非 40 字占位，保留头部供快速回顾。 */
const PREVIEW_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep',
  'glob',
  'pdf_parsing',
  'search_docs',
  'bash',
  'bg_check',
  'web_fetch',
]);

/** 粗略 token 估算：CJK/全角字符约 1 token，其余约 4 字符/token。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 估算整段消息的输入 token（含 tool_use 参数与 tool_result 内容）。 */
export function countMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') total += estimateTokens(b.text);
      else if (b.type === 'tool_use') total += estimateTokens(JSON.stringify(b.input)) + 20;
      else if (isToolResultBlock(b)) total += estimateTokens(b.content);
    }
  }
  return total;
}

/** 扫描全部消息，建立 tool_use_id -> { name, path } 映射，用于识别每个 tool_result 的来源。 */
function buildToolMap(messages: Message[]): Map<string, { name: string; path?: string }> {
  const map = new Map<string, { name: string; path?: string }>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const input = b.input as Record<string, unknown>;
        map.set(b.id, {
          name: b.name,
          path: typeof input.path === 'string' ? input.path : undefined,
        });
      }
    }
  }
  return map;
}

/** 解析 read_file 的绝对路径；无法解析时返回 null。 */
function resolveReadPath(baseDir: string | undefined, rel: string): string | null {
  try {
    return path.resolve(baseDir ?? '.', rel);
  } catch {
    return null;
  }
}

/** 同步三层（0 API）。 */
export function compactMessages(messages: Message[], opts: Partial<CompactOptions>): Message[] {
  const o: CompactOptions = {
    thresholdChars: 50_000,
    persistDir: '.task_outputs/tool-results',
    ...DEFAULTS,
    ...opts,
  };
  let msgs = messages;
  const toolMap = buildToolMap(msgs);
  msgs = toolResultBudget(msgs, o, toolMap);
  msgs = snipCompact(msgs, o);
  msgs = microCompact(msgs, o, toolMap);
  /* token 预算上限提示：接近预算时给出可操作反馈（避免无声撞上 prompt_too_long） */
  const tokens = countMessageTokens(msgs);
  if (tokens > o.budgetTokens * 0.8) {
    o.onAction?.(`[compact] ⚠ 输入约 ${tokens} tokens，接近预算 ${o.budgetTokens}；建议 /compact 或拆分子任务`);
  }
  return msgs;
}

/** 把 [start, end) 区间内被移除的知识类 read 路径标记 evicted，保证重读能拿回全文。 */
function evictKnowledgeInRegion(
  messages: Message[],
  start: number,
  end: number,
  o: Pick<CompactOptions, 'readFileState' | 'baseDir'>,
): void {
  if (!o.readFileState) return;
  for (let i = start; i < end && i < messages.length; i++) {
    for (const b of messageBlocks(messages[i])) {
      if (b.type !== 'tool_use' || !KNOWLEDGE_TOOLS.has(b.name)) continue;
      const rel = (b.input as Record<string, unknown>).path;
      if (typeof rel !== 'string' || !rel) continue;
      const abs = resolveReadPath(o.baseDir, rel);
      if (abs) o.readFileState.markEvicted(abs);
    }
  }
}

/* ---------- L3: budget（大结果落盘） ---------- */

function toolResultBudget(
  messages: Message[],
  o: CompactOptions,
  toolMap: Map<string, { name: string; path?: string }>,
): Message[] {
  /* 通道 1：最新一批 tool_result 超过单批预算 → 落盘最大的若干条 */
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const results = messageBlocks(last).filter(isToolResultBlock);
    const total = results.reduce((s, r) => s + r.content.length, 0);
    if (results.length > 0 && total > o.maxToolResultChars) {
      persistLargestResults(results, total - o.maxToolResultChars, o, toolMap);
    }
  }
  /* 通道 2（双闸门）：估算输入 token 超阈值 或 字符数超阈值 → 对历史中最大的结果落盘，
     直到回到阈值以下。这是 0-API 的主动压缩，防止直接撞上 prompt_too_long。 */
  const tokens = countMessageTokens(messages);
  const chars = countChars(messages);
  if (tokens > o.thresholdTokens || chars > o.thresholdChars) {
    const all: ToolResultBlock[] = [];
    for (const m of messages) {
      for (const b of messageBlocks(m)) {
        if (!isToolResultBlock(b) || b.content.length <= 2500 || b.content.startsWith('<persisted-output')) continue;
        /* 知识类（read_file 等）不在此落盘：由 L2 预览截断处理，避免"落盘→重读→再超阈"循环。 */
        const src = toolMap.get(b.tool_use_id);
        if (src && KNOWLEDGE_TOOLS.has(src.name)) continue;
        all.push(b);
      }
    }
    if (all.length > 0) {
      const freedChars = Math.max(chars - o.thresholdChars, (tokens - o.thresholdTokens) * 3);
      persistLargestResults(all, freedChars, o, toolMap);
    }
  }
  return messages;
}

/** 把最大的若干 tool_result 落盘，只留预览+指针，直到释放够 freedChars。 */
function persistLargestResults(
  results: ToolResultBlock[],
  freedChars: number,
  o: CompactOptions,
  toolMap: Map<string, { name: string; path?: string }>,
): void {
  if (freedChars <= 0 || results.length === 0) return;
  fs.mkdirSync(o.persistDir, { recursive: true });
  const sorted = [...results].sort((a, b) => b.content.length - a.content.length);
  let budget = freedChars;
  let persisted = 0;
  for (const r of sorted) {
    if (budget <= 0) break;
    const originalLen = r.content.length;
    const fname = `tool_result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
    fs.writeFileSync(path.join(o.persistDir, fname), r.content, 'utf8');
    r.content = `<persisted-output file="${fname}" note="Full content on disk; read it back if needed.">\n${r.content.slice(0, o.previewChars)}`;
    budget -= originalLen - r.content.length;
    persisted += 1;
    o.onAction?.(`[compact L3] persisted ${fname}`);
    /* 知识类文件被落盘移除 → 标记 evicted，重读时返回完整内容 */
    const src = toolMap.get(r.tool_use_id);
    if (o.readFileState && src && KNOWLEDGE_TOOLS.has(src.name) && src.path) {
      const abs = resolveReadPath(o.baseDir, src.path);
      if (abs) o.readFileState.markEvicted(abs);
    }
  }
  if (persisted > 0) o.onAction?.(`[compact L3] persisted ${persisted} large tool results to disk`);
}

/* ---------- L1: snip（裁中段） ---------- */

function hasToolUse(m: Message): boolean {
  return messageBlocks(m).some((b) => b.type === 'tool_use');
}

function isToolResultMessage(m: Message): boolean {
  return messageBlocks(m).some(isToolResultBlock);
}

export function snipCompact(messages: Message[], o: CompactOptions): Message[] {
  const overTokens = countMessageTokens(messages) > o.snipTokens;
  if (messages.length <= o.maxMessages && !overTokens) return messages;
  /* token 超限但消息数未超：仍裁中段（保留头部 + 最近约一半） */
  const keepTail = overTokens
    ? Math.max(4, Math.min(o.maxMessages - o.keepHead, Math.floor(messages.length * 0.5)))
    : o.maxMessages - o.keepHead;
  let headEnd = o.keepHead;
  let tailStart = messages.length - keepTail;

  /* 优先找"自然断点"：切口前后都不是半截工具对 */
  const headSafe = findSafeBoundary(messages, headEnd, Math.max(1, headEnd - 8), headEnd + 8);
  if (headSafe >= 0) headEnd = headSafe;
  const tailSafe = findSafeBoundary(messages, tailStart, tailStart - 8, Math.min(messages.length - 1, tailStart + 8));
  if (tailSafe >= 0) tailStart = tailSafe;

  /* 退路：教学版保护逻辑（限步，防止纯工具对序列级联吞掉整个对话） */
  let guard = 0;
  while (
    headEnd < tailStart &&
    guard < 8 &&
    hasToolUse(messages[headEnd - 1]) &&
    isToolResultMessage(messages[headEnd])
  ) {
    headEnd += 1;
    guard += 1;
  }
  guard = 0;
  while (
    tailStart > headEnd &&
    guard < 8 &&
    isToolResultMessage(messages[tailStart]) &&
    hasToolUse(messages[tailStart - 1])
  ) {
    tailStart -= 1;
    guard += 1;
  }

  if (tailStart <= headEnd) return messages;
  const snippedCount = tailStart - headEnd;
  /* 被裁掉的知识类内容标记 evicted：否则重读会撞上 FILE_UNCHANGED_STUB，信息永久丢失 */
  evictKnowledgeInRegion(messages, headEnd, tailStart, o);
  const out = [
    ...messages.slice(0, headEnd),
    { role: 'user' as const, content: `[snipped ${snippedCount} messages from conversation middle]` },
    ...messages.slice(tailStart),
  ];
  o.onAction?.(`[compact L1] snipped ${snippedCount} messages`);
  return out;
}

/** 在 [lo, hi] 内找切口位置 i：messages[i-1] 不含 tool_use 且 messages[i] 不是 tool_result。 */
function findSafeBoundary(messages: Message[], desired: number, lo: number, hi: number): number {
  const scan = (from: number, to: number, step: number): number => {
    for (let i = from; i >= lo && i <= hi; i += step) {
      if (i <= 0 || i >= messages.length) continue;
      const before = messages[i - 1];
      const after = messages[i];
      const beforeUse = hasToolUse(before) && !isToolResultMessage(before);
      const afterResult = isToolResultMessage(after);
      if (!beforeUse && !afterResult) return i;
    }
    return -1;
  };
  const up = scan(desired, hi, 1);
  if (up >= 0) return up;
  return scan(desired - 1, lo, -1);
}
/* ---------- L2: micro（旧结果占位） ---------- */

export function microCompact(
  messages: Message[],
  o: CompactOptions,
  toolMap: Map<string, { name: string; path?: string }> = buildToolMap(messages),
): Message[] {
  const results: ToolResultBlock[] = [];
  for (const m of messages) {
    for (const b of messageBlocks(m)) {
      if (isToolResultBlock(b)) results.push(b);
    }
  }
  const toCompact = results.slice(0, Math.max(0, results.length - o.keepRecentToolResults));
  if (toCompact.length === 0) return messages;
  let compacted = 0;
  for (const block of toCompact) {
    if (block.content.length <= 120) continue;
    if (block.content.startsWith('[Earlier tool result compacted')) continue;
    if (block.content.startsWith('<persisted-output')) continue; // 已落盘
    const src = toolMap.get(block.tool_use_id);
    /* 只读长输出（read_file/list_files/grep/git status 等）：预览截断而非 40 字占位。
       保留头部供快速回顾；需要完整内容时模型可重新读取。 */
    if (src && PREVIEW_TOOLS.has(src.name)) {
      if (block.content.length > o.previewChars) {
        block.content = `${block.content.slice(0, o.previewChars)}\n…[truncated ${block.content.length - o.previewChars} chars; re-read if needed]`;
        compacted += 1;
      }
      continue;
    }
    block.content = '[Earlier tool result compacted. Re-run if needed.]';
    compacted += 1;
  }
  if (compacted > 0) o.onAction?.(`[compact L2] compacted ${compacted} old tool results`);
  return messages;
}

/* ---------- L4: LLM 摘要（1 API，文本专用） ---------- */

const COMPACT_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
You are compacting a coding-agent conversation transcript.
Keep: current goal, completed work, remaining work, user constraints, key file paths, pending decisions.
Drop: intermediate exploration, repeated tool outputs.
First write <analysis>...</analysis> reasoning, then write <summary>...</summary> with the final summary only.`;

export interface CompactHistoryOptions {
  maxTokens: number;
  keepRecentMessages?: number;
  /** 可选：compact 后恢复最近读过的文件内容。 */
  readFileState?: ReadFileState;
  /** 可选：恢复文件的目录基准（默认进程 cwd）。 */
  restoreBaseDir?: string;
  maxFilesToRestore?: number;
  maxTokensPerFile?: number;
  /** 可选：session memory（跨压缩的会话摘要）。足够长时直接复用，不调 LLM。 */
  sessionMemory?: string;
  /** session memory 复用阈值（字符数，默认 2000）。 */
  sessionMemoryMinChars?: number;
}

export interface CompactHistoryResult {
  messages: Message[];
  summary: string;
  /** 摘要来源：'llm'（调用了模型）或 'session-memory'（复用已有摘要，0 API）。 */
  source: 'llm' | 'session-memory';
}

export async function compactHistory(
  messages: Message[],
  llm: LlmClient,
  opts: CompactHistoryOptions,
): Promise<CompactHistoryResult> {
  /* SessionMemoryCompact：session memory 足够时直接复用，跳过 LLM 调用（CC 的 sessionMemoryCompact） */
  const minChars = opts.sessionMemoryMinChars ?? 2000;
  if (opts.sessionMemory && opts.sessionMemory.length >= minChars) {
    const keep = opts.keepRecentMessages ?? 10;
    evictDroppedPrefix(messages, keep, opts);
    const tail = messages.slice(-keep);
    const restored = opts.readFileState
      ? restoreRecentFileReads(messages, opts.readFileState, {
          baseDir: opts.restoreBaseDir,
          maxFiles: opts.maxFilesToRestore ?? 5,
          maxCharsPerFile: (opts.maxTokensPerFile ?? 5000) * 4,
        })
      : [];
    return {
      messages: [
        { role: 'user', content: `[Conversation compacted. Summary:\n${opts.sessionMemory}]` },
        ...tail,
        ...restored,
      ],
      summary: opts.sessionMemory,
      source: 'session-memory',
    };
  }

  const serialized = serializeForCompaction(messages);
  const result = await llm.complete({
    system: 'You are a conversation compaction engine. Text only. Never call tools.',
    messages: [{ role: 'user', content: `${COMPACT_PROMPT}\n\n${serialized}` }],
    tools: [],
    maxTokens: opts.maxTokens,
  });
  const text = result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const summary = extractSummary(text) ?? text;
  const keep = opts.keepRecentMessages ?? 10;
  evictDroppedPrefix(messages, keep, opts);
  const tail = messages.slice(-keep);

  const restored = opts.readFileState
    ? restoreRecentFileReads(messages, opts.readFileState, {
        baseDir: opts.restoreBaseDir,
        maxFiles: opts.maxFilesToRestore ?? 5,
        maxCharsPerFile: (opts.maxTokensPerFile ?? 5000) * 4,
      })
    : [];

  return {
    messages: [{ role: 'user', content: `[Conversation compacted. Summary:\n${summary}]` }, ...tail, ...restored],
    summary,
    source: 'llm',
  };
}

/** 压缩会丢弃尾部之前的全部消息：把其中的知识类 read 路径标记 evicted，防止重读撞上 stub。 */
function evictDroppedPrefix(messages: Message[], keep: number, opts: CompactHistoryOptions): void {
  if (!opts.readFileState) return;
  const dropEnd = Math.max(0, messages.length - keep);
  evictKnowledgeInRegion(messages, 0, dropEnd, {
    readFileState: opts.readFileState,
    baseDir: opts.restoreBaseDir,
  });
}

/** 从被压缩的历史中提取最近 read_file 的路径，重新读取未变化文件并注入上下文。 */
function restoreRecentFileReads(
  messages: Message[],
  rfs: ReadFileState,
  opts: { baseDir?: string; maxFiles: number; maxCharsPerFile: number },
): Message[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (let i = messages.length - 1; i >= 0 && files.length < opts.maxFiles; i--) {
    for (const b of messageBlocks(messages[i])) {
      if (b.type === 'tool_use' && b.name === 'read_file') {
        const p = String((b.input as Record<string, unknown>).path ?? '');
        if (p && !seen.has(p)) {
          seen.add(p);
          files.push(p);
          if (files.length >= opts.maxFiles) break;
        }
      }
    }
  }
  if (files.length === 0) return [];

  const restored: Message[] = [];
  for (const rel of files) {
    const abs = opts.baseDir ? path.resolve(opts.baseDir, rel) : path.resolve(rel);
    if (!rfs.isUnchanged(abs)) continue;
    try {
      const content = fs.readFileSync(abs, 'utf8').slice(0, opts.maxCharsPerFile);
      restored.push({
        role: 'user',
        content: `[Restored context] File ${rel}:\n${content}`,
      });
      /* 内容已重新注入上下文 → 清除 evicted 标记（重读返回 stub 即可，避免重复灌全文） */
      rfs.clearEvicted(abs);
    } catch {
      // 文件不存在或不可读则跳过
    }
  }
  return restored;
}

/** prompt_too_long 时的应急压缩（s11 路径 2）。 */
export async function reactiveCompact(
  messages: Message[],
  llm: LlmClient,
  opts: CompactHistoryOptions,
): Promise<CompactHistoryResult> {
  return compactHistory(messages, llm, { ...opts, keepRecentMessages: 6 });
}

function extractSummary(text: string): string | null {
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/);
  return m ? m[1].trim() : null;
}

function serializeForCompaction(messages: Message[]): string {
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return `${m.role}: ${m.content}`;
      const parts = m.content.map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 300)}]`;
        return `[tool_result ${b.content.slice(0, 500)}]`;
      });
      return `${m.role}: ${parts.join('\n')}`;
    })
    .join('\n---\n');
}

/** 总字符数（供阈值判断）。 */
export { countChars };
