/**
 * 文件工具集 —— 全部走 safePath 强约束（比教学版更重投入的安全第一）。
 * glob / grep 用原生 JS 实现（不依赖 shell 的 ls/rg），Windows 下行为一致。
 *
 * 符号链接防护：词法 isInside 只能挡 ".."，挡不住工作区内的 symlink/junction。
 * 所有读写在执行前额外做 realpath 校验：解析路径（不存在时取最近存在的祖先），
 * 要求解析后的真实位置仍在工作区（或只读白名单根）内；遍历（glob/grep/list）
 * 一律不跟随 symlink 条目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isInside } from '../core/permission.js';
import { FILE_UNCHANGED_STUB } from '../core/readFileState.js';
import { isProtectedWritePath, isSecretReadPath, protectedReason } from '../core/protectedPaths.js';
import type { ToolContext, ToolDef } from '../types.js';

/** real 路径包含关系判断（调用方必须已 realpath 化）。 */
function realWithin(target: string, anchor: string): boolean {
  const rel = path.relative(anchor, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * realpath 防逃逸：把 resolved（词法上已在某个 root 内）做一次真实解析——
 * 路径不存在时向上找最近存在的祖先再 realpath，并把不存在的尾部拼回。
 * 解析结果必须仍落在 roots 之一的 realpath 内，否则说明路径中某个
 * symlink/junction 组件指向了允许范围之外（例如工作区内链接写到工作区外）。
 */
function assertNoSymlinkEscape(resolved: string, roots: string[]): void {
  let probe = resolved;
  const tail: string[] = [];
  for (;;) {
    let exists: boolean;
    try {
      fs.lstatSync(probe);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) break;
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error(`Path escapes workspace (unresolvable): ${resolved}`);
    }
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let realTarget: string;
  try {
    realTarget = path.join(fs.realpathSync(probe), ...tail);
  } catch {
    throw new Error(`Path escapes workspace (realpath failed): ${resolved}`);
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue; // root 不存在则跳过
    }
    if (realWithin(realTarget, realRoot)) return;
  }
  throw new Error(`Path escapes workspace via symlink/junction: ${resolved}`);
}

export function safePath(workdir: string, p: string, extraReadRoots?: string[]): string {
  const resolved = path.resolve(workdir, p);
  const roots: string[] = [];
  if (isInside(workdir, resolved)) roots.push(workdir);
  /* 只读场景：允许配置（EXTRA_READ_ROOTS）内的额外目录，统一走正门而非 bash 后门。 */
  for (const root of extraReadRoots ?? []) {
    if (isInside(root, resolved)) roots.push(root);
  }
  if (roots.length === 0) throw new Error(`Path escapes workspace: ${p}`);
  assertNoSymlinkEscape(resolved, roots);
  return resolved;
}

function readRoots(ctx: ToolContext): string[] | undefined {
  return ctx.config?.extraReadRoots;
}

const readSchema = z.object({
  path: z.string().min(1),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().positive().optional(),
  lineNumbers: z.boolean().optional(),
});

const writeSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
});

const editSchema = z.object({
  path: z.string().min(1, 'path is required'),
  old_text: z.string().min(1, 'old_text is required'),
  new_text: z.string(),
});

const deleteSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

const listSchema = z.object({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
  depth: z.number().int().positive().optional(),
});

const globSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
});

const grepSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().optional(),
  literal: z.boolean().optional(),
  caseInsensitive: z.boolean().optional(),
});

/* ---------- read / write / edit / delete ---------- */

async function execRead(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const rawPath = String(args.path ?? '');
  /* 双重拦截（执行器层）：密钥文件禁止读入上下文 */
  if (isSecretReadPath(ctx.workdir, rawPath)) {
    return `Error: 禁止读取密钥文件: ${rawPath}`;
  }
  const p = safePath(ctx.workdir, rawPath, readRoots(ctx));
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  const offset = typeof args.offset === 'number' ? args.offset : 1;
  const lineNumbers = args.lineNumbers === true;

  if (ctx.readFileState && ctx.readFileState.isUnchanged(p)) {
    // 内容已被压缩/落盘移除时，重读必须返回完整内容（否则信息永久丢失）
    if (!ctx.readFileState.isEvicted(p)) {
      return FILE_UNCHANGED_STUB;
    }
    ctx.readFileState.clearEvicted(p);
  }

  /* 生产级护栏：超大文件拒绝整读，引导 offset/limit 或 grep，防 OOM */
  const MAX_READ_BYTES = 10 * 1024 * 1024;
  const st = await fs.promises.stat(p);
  if (st.size > MAX_READ_BYTES) {
    return `Error: file too large (${st.size} bytes > ${MAX_READ_BYTES}); use offset/limit to page through it, or grep for the relevant part`;
  }
  const raw = await fs.promises.readFile(p, 'utf8');
  ctx.readFileState?.markRead(p);
  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, offset - 1);
  if (start >= lines.length) {
    return `Error: offset ${offset} beyond end of file (${lines.length} lines)`;
  }
  const slice = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
  let out: string;
  if (lineNumbers) {
    /* 证据模式：完整源路径 + 行号前缀（行号=|内容），供报告校验器核对 file:line 引用 */
    out = `[source: ${p}]\n${slice.map((content, i) => `${start + i + 1}|${content}`).join('\n')}`;
  } else {
    out = slice.join('\n');
  }
  const omitted = lines.length - (start + slice.length);
  if (omitted > 0) {
    out += `\n... (${omitted} more lines; total ${lines.length}; use offset=${start + slice.length + 1} to continue)`;
  } else if (start > 0) {
    out += `\n(total ${lines.length} lines; read from offset=${offset})`;
  }
  return out;
}

async function execWrite(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const rawPath = String(args.path ?? '');
  /* 双重拦截（执行器层）：权限/信任/密钥状态文件禁止写入 */
  if (isProtectedWritePath(ctx.workdir, rawPath)) {
    return `Error: ${protectedReason(rawPath)}`;
  }
  const p = safePath(ctx.workdir, rawPath);
  const content = String(args.content ?? '');
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, content, 'utf8');
  return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${args.path}`;
}

async function execEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const rawPath = String(args.path ?? '');
  if (isProtectedWritePath(ctx.workdir, rawPath)) {
    return `Error: ${protectedReason(rawPath)}`;
  }
  const p = safePath(ctx.workdir, rawPath);
  const oldText = String(args.old_text ?? '');
  const newText = String(args.new_text ?? '');
  const original = await fs.promises.readFile(p, 'utf8');
  const idx = original.indexOf(oldText);
  if (idx < 0) return `Error: old_text not found in ${args.path}`;
  const updated = original.slice(0, idx) + newText + original.slice(idx + oldText.length);
  await fs.promises.writeFile(p, updated, 'utf8');
  return `Edited ${args.path}: replaced 1 occurrence`;
}

async function execDelete(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const rawPath = String(args.path ?? '');
  if (isProtectedWritePath(ctx.workdir, rawPath)) {
    return `Error: ${protectedReason(rawPath)}`;
  }
  const p = safePath(ctx.workdir, rawPath);
  if (!fs.existsSync(p)) return `Error: not found: ${args.path}`;
  await fs.promises.unlink(p);
  return `Deleted ${args.path}`;
}

async function execList(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = safePath(ctx.workdir, String(args.path ?? '.'), readRoots(ctx));
  const recursive = args.recursive === true;
  const entries = await fs.promises.readdir(p, { withFileTypes: true });
  if (!recursive) {
    /* 完整源路径（绝对路径，统一正斜杠），便于报告证据定位 */
    const lines = entries.map((e) => path.join(p, e.name).split(path.sep).join('/') + (e.isDirectory() ? '/' : ''));
    return lines.sort().join('\n') || '(empty)';
  }
  const maxDepth = typeof args.depth === 'number' ? args.depth : 6;
  const lines: string[] = [];
  await walkBounded(p, maxDepth, 1000, lines);
  lines.sort();
  const capped = lines.slice(0, 1000);
  const suffix = lines.length > capped.length ? `\n... (${lines.length - capped.length} more entries)` : '';
  return (capped.join('\n') || '(empty)') + suffix;
}

/** 带深度与条目上限的递归遍历（跳过 node_modules/.git 等），结果形如完整绝对路径 "…/src/a.ts"、"…/docs/"。 */
async function walkBounded(dir: string, maxDepth: number, cap: number, out: string[]): Promise<void> {
  if (maxDepth < 0 || out.length >= cap) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.tasks' || e.name === '.team') continue;
    /* 安全：不跟随 symlink/junction，防止遍历逃逸出工作区 */
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    const display = full.split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push(display + '/');
      await walkBounded(full, maxDepth - 1, cap, out);
    } else {
      out.push(display);
    }
  }
}

/* ---------- glob / grep（原生实现） ---------- */

/** 逐字符翻译 glob → 正则。双星号+斜杠的形式匹配零或多层目录（对齐主流 glob 语义）。 */
function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          out += '(?:.*/)?'; // '**/'：零或多层目录（docs/**/*.md 能命中 docs/a.md）
          i += 2;
        } else {
          out += '.*'; // 结尾 'a/**' 或 '**.md'：跨目录任意字符
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(
  dir: string,
  base: string,
  visit: (rel: string, full: string) => void | Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > 14) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.tasks' || e.name === '.team') continue;
    /* 安全：不跟随 symlink/junction，防止 glob/grep 逃逸出工作区 */
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      await walk(full, base, visit, depth + 1);
    } else {
      await visit(rel, full);
    }
  }
}

async function execGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) return 'Error: pattern required';
  const matcher = globToRegExp(pattern);
  const hits: string[] = [];
  await walk(ctx.workdir, ctx.workdir, (rel) => {
    if (matcher.test(rel)) hits.push(rel);
  });
  return hits.length ? hits.slice(0, 500).join('\n') : '（无匹配）';
}

async function execGrep(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? '');
  const startPath = String(args.path ?? '.');
  const literal = args.literal === true;
  const caseInsensitive = args.caseInsensitive === true;
  if (!pattern) return 'Error: pattern required';
  const rx = literal ? null : new RegExp(pattern, caseInsensitive ? 'i' : '');
  const needle = literal ? pattern.toLowerCase() : '';
  const startFull = safePath(ctx.workdir, startPath, readRoots(ctx));
  const isFile = fs.existsSync(startFull) && fs.statSync(startFull).isFile();
  const hits: string[] = [];

  /* 资源上限：单文件大小 / 总结果数 / 总读取字节，防 grep 打满上下文 */
  const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件 2MB
  const GREP_MAX_RESULTS = 200; // 总结果条数
  const GREP_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 累计读取 20MB
  let totalBytes = 0;
  let skipped = 0;

  const testFile = async (full: string) => {
    if (hits.length >= GREP_MAX_RESULTS || totalBytes >= GREP_MAX_TOTAL_BYTES) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return;
    }
    if (st.size > GREP_MAX_FILE_BYTES) {
      skipped += 1;
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      return;
    }
    totalBytes += Buffer.byteLength(raw, 'utf8');
    if (raw.includes('\u0000')) return; // binary
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = rx ? rx.test(line) : line.toLowerCase().includes(needle);
      if (match) {
        /* 完整源路径（绝对路径，统一正斜杠），供报告校验器核对 file:line 引用 */
        hits.push(`${full.split(path.sep).join('/')}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= GREP_MAX_RESULTS) break;
      }
    }
  };

  if (isFile) {
    await testFile(startFull);
  } else {
    await walk(startFull, startFull, (rel, full) => testFile(full));
  }
  if (hits.length === 0) return skipped > 0 ? `（无匹配；${skipped} 个超大文件已跳过）` : '（无匹配）';
  const suffixParts: string[] = [];
  if (hits.length >= GREP_MAX_RESULTS) suffixParts.push(`结果达到上限 ${GREP_MAX_RESULTS} 条，已截断`);
  if (skipped > 0) suffixParts.push(`${skipped} 个超大文件已跳过`);
  return hits.join('\n') + (suffixParts.length ? '\n... (' + suffixParts.join('；') + ')' : '');
}

/* ---------- 注册 ---------- */

export function fsTools(): ToolDef[] {
  return [
    {
      schema: {
        name: 'read_file',
        description: '从工作区读取文件。尽量完整读取；确需截断时用 offset+limit 分段读完全部内容，不要只读开头就引用。',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的路径' },
            limit: { type: 'integer', description: '最多读取的行数' },
            offset: { type: 'integer', description: '起始行号（从 1 开始），与 limit 配合分段读取' },
            lineNumbers: {
              type: 'boolean',
              description: 'true 时返回完整源路径 + 行号前缀（行号|内容），用于报告证据',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      validator: readSchema,
      executor: execRead,
      concurrencySafe: true,
      maxResultSizeChars: Number.POSITIVE_INFINITY,
    },
    {
      schema: {
        name: 'write_file',
        description: '把内容写入文件（自动创建所需目录）。',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的路径' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      validator: writeSchema,
      executor: execWrite,
    },
    {
      schema: {
        name: 'edit_file',
        description: '在文件中把一处 old_text 替换为 new_text。',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_text: { type: 'string' },
            new_text: { type: 'string' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
      validator: editSchema,
      executor: execEdit,
    },
    {
      schema: {
        name: 'delete_file',
        description: '从工作区删除一个文件（需要审批）。',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      validator: deleteSchema,
      executor: execDelete,
    },
    {
      schema: {
        name: 'list_files',
        description: '列出目录中的条目。recursive=true 递归列出整棵项目树（探索项目结构优先用它，而不是 shell 命令）。',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', default: '.' },
            recursive: { type: 'boolean', description: '递归列出子目录（默认 false）', default: false },
            depth: { type: 'integer', description: '递归最大层数（默认 6）' },
          },
        },
      },
      validator: listSchema,
      executor: execList,
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'glob',
        description:
          '按 glob 模式查找文件（支持 * ? **；`**/` 匹配零或多层目录，docs/**/*.md 可命中 docs 根下的 md）。',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string', description: '例如 src/**/*.ts 或 docs/**/*.md' } },
          required: ['pattern'],
        },
      },
      validator: globSchema,
      executor: execGlob,
      concurrencySafe: true,
    },
    {
      schema: {
        name: 'grep',
        description: '在文件中搜索文本（正则或字面量）。',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', default: '.', description: '文件或目录' },
            literal: { type: 'boolean', default: false },
            caseInsensitive: { type: 'boolean', default: false },
          },
          required: ['pattern'],
        },
      },
      validator: grepSchema,
      executor: execGrep,
      concurrencySafe: true,
    },
  ];
}
