/**
 * 终端 UI —— ANSI 颜色工具 + 像素机器人吉祥物 + 格式化。
 * 深色青蓝色主题（Claude Code 风格）。
 */
import stringWidth from 'string-width';
import { C } from './terminalTheme.js';

export { C, brandChip, fmtDuration, wrapForGutter, fitToWidth, visibleLength } from './terminalTheme.js';

/* ---------- ANSI 颜色（统一 token，见 terminalTheme.ts） ---------- */

/** 上移 n 行。 */
export function up(n: number): string {
  return `\x1b[${n}A`;
}
/** 清空 n 行。 */
export function clearLines(n: number): string {
  return `\x1b[${n}A\x1b[${n}J`;
}

/** 去除 ANSI 转义序列（非 TTY/管道输出用，避免控制码污染下游）。 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/* ---------- 赛博机器人吉祥物（颜色差 + 反差感 + 科技感） ---------- */

/* 背景：深灰黑；主体：亮青；眼：品红；点缀/天线/核心：亮黄。强对比。 */
const BG = C.bgDark;
const CYAN = C.cyan;
const CYAN_HI = C.aqua;
const MAGENTA = C.magenta;
const YELLOW = C.yellow;

/* 字符→颜色 映射（未列出的非空格字符用亮青）。 */
const PALETTE: Record<string, string> = {
  '●': MAGENTA, // 发光眼
  '*': YELLOW, // 天线尖 / 核心（单宽，保证对齐）
  '·': YELLOW, // 电路点
  '━': CYAN_HI,
  '┏': CYAN_HI,
  '┓': CYAN_HI,
  '┗': CYAN_HI,
  '┛': CYAN_HI,
};

/** 11 行赛博机器人：天线 + 头部(●发光眼) + 核心(*,单宽对齐) + 电路点缀。 */
export const ROBOT_ART = [
  '              *               ',
  '              │               ',
  '      ┏━━━━━━━━━━━━━━━┓       ',
  '      ┃   ●       ●   ┃       ',
  '      ┃               ┃       ',
  '      ┃    ━━━━━━━    ┃       ',
  '      ┗━━━━━━━┳━━━━━━━┛       ',
  '      ┌───────╨───────┐       ',
  '      │  * CORE *     │       ',
  '      └───────────────┘       ',
  '      ·  ·  ·  ·  ·  ·  ·     ',
];

/** 渲染赛博机器人：空格=深背景，字符按调色板上色（颜色差/反差/科技感）。 */
export function renderRobot(): string[] {
  return ROBOT_ART.map((row) => {
    let out = BG;
    for (const ch of row) {
      if (ch === ' ') out += ' ';
      else out += (PALETTE[ch] ?? CYAN) + ch + BG;
    }
    return out + C.reset;
  });
}

/**
 * 渲染启动横幅：机器人在左，信息在右（并排）。
 * 返回可直接打印的行数组。
 */
export function renderBanner(opts: {
  model: string;
  mode: string;
  workdir: string;
  version: string;
  mock: boolean;
}): string[] {
  const art = renderRobot();
  const info: Array<[string, string]> = [
    ['NAME', C.aqua + C.bold + ' 小锤 Anvil' + C.reset + ' ' + C.dim + opts.version + C.reset],
    ['MODEL', C.white + opts.model + (opts.mock ? C.yellow + ' (MOCK)' + C.reset : C.reset)],
    ['MODE', C.teal + opts.mode + C.reset],
    ['WORKDIR', C.dim + opts.workdir + C.reset],
  ];

  const infoRows = info.map(([k, v]) => {
    return '  ' + C.dim + k.padEnd(8) + C.reset + v;
  });

  /* 机器人 9 行，信息 4 行，中间留白对齐 */
  const lines: string[] = [];
  const artWidth = 15;
  for (let i = 0; i < 9; i++) {
    const artRow = art[i] ?? '';
    const infoRow = infoRows[i] ?? '';
    lines.push(artRow.padEnd(artWidth) + infoRow);
  }
  return lines;
}

/* ---------- 分隔线 ---------- */

export function divider(title?: string, width = 60): string {
  if (!title) return C.darkGray + '─'.repeat(width) + C.reset;
  const side = Math.max(1, Math.floor((width - title.length - 2) / 2));
  return (
    C.darkGray +
    '─'.repeat(side) +
    ' ' +
    C.teal +
    title +
    C.reset +
    C.darkGray +
    ' ' +
    '─'.repeat(width - side - title.length - 2) +
    C.reset
  );
}

/* ---------- 标签 ---------- */

export function badge(text: string, color = C.teal): string {
  return C.bgDark + ' ' + color + C.bold + text + C.reset + C.bgDark + ' ' + C.reset;
}

export function toolLabel(name: string): string {
  return C.cyan + C.bold + name + C.reset;
}

export function cmdLabel(cmd: string): string {
  return C.yellow + cmd + C.reset;
}

export function fileLabel(path: string): string {
  return C.green + C.underline + path + C.reset;
}

export function errorLabel(msg: string): string {
  return C.red + C.bold + msg + C.reset;
}

/* ---------- diff 渲染 ---------- */

/** 渲染统一 diff（+ 绿 / - 红 / @@ 青）。 */
export function renderDiff(diffText: string): string[] {
  return diffText.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return C.teal + line + C.reset;
    }
    if (line.startsWith('+')) return C.green + line + C.reset;
    if (line.startsWith('-')) return C.red + line + C.reset;
    return C.gray + line + C.reset;
  });
}

/* ---------- 代码语法高亮（轻量正则级，覆盖常见语言） ---------- */

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'class',
  'import',
  'export',
  'from',
  'async',
  'await',
  'new',
  'try',
  'catch',
  'finally',
  'throw',
  'def',
  'lambda',
  'pass',
  'None',
  'True',
  'False',
  'and',
  'or',
  'not',
  'in',
  'is',
  'public',
  'private',
  'static',
  'void',
  'int',
  'string',
  'bool',
  'interface',
  'type',
  'extends',
  'implements',
  'this',
  'super',
  'yield',
  'switch',
  'case',
  'break',
  'continue',
  'do',
  'goto',
  'struct',
  'enum',
  'fn',
  'pub',
  'use',
  'mod',
  'match',
  'impl',
  'mut',
]);

/** 对单行代码做轻量语法高亮（关键字/字符串/注释/数字）。 */
export function highlightCodeLine(line: string): string {
  // 整行注释
  const trimmed = line.trimStart();
  if (/^(\/\/|#|--)/.test(trimmed)) return C.darkGray + line + C.reset;

  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    // 行内注释 //
    if (ch === '/' && line[i + 1] === '/') {
      out += C.darkGray + line.slice(i) + C.reset;
      break;
    }
    // 字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && line[j] !== quote) {
        if (line[j] === '\\') j++;
        j++;
      }
      out += C.green + line.slice(i, Math.min(j + 1, n)) + C.reset;
      i = j + 1;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9._xXa-fA-F]/.test(line[j])) j++;
      out += C.orange + line.slice(i, j) + C.reset;
      i = j;
      continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) out += C.purple + word + C.reset;
      else out += word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/* ---------- Markdown 渲染（保留代码块 + 语法高亮） ---------- */

/**
 * 有状态的 Markdown 行渲染器：逐行 feedLine，跨行记住代码块围栏状态，
 * 支持流式输出（REPL 逐行喂入）与一次性渲染（renderMarkdown）。
 */
export class MarkdownRenderer {
  private inCode = false;
  private codeLang = '';

  /** 喂入一行（不含换行符），返回终端着色后的行。 */
  feedLine(line: string): string {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!this.inCode) {
        this.inCode = true;
        this.codeLang = fence[1];
        return C.darkGray + '┌─[' + C.teal + (this.codeLang || 'code') + C.darkGray + ']─' + C.reset;
      }
      this.inCode = false;
      return C.darkGray + '└─' + C.reset;
    }
    if (this.inCode) {
      return C.darkGray + '│ ' + C.reset + highlightCodeLine(line);
    }
    return renderInlineMarkdown(line);
  }

  /** 流结束时调用：未闭合代码块兜底收边。返回 null 表示无需输出。 */
  end(): string | null {
    if (!this.inCode) return null;
    this.inCode = false;
    return C.darkGray + '└─' + C.reset;
  }
}

/**
 * 把 Markdown 文本渲染为终端行：
 *   - 代码块（```lang ... ```）保留并逐行语法高亮，加深色边框标识
 *   - 标题 # / ## 加粗上色
 *   - 加粗 **x**、行内代码 `x`、列表、引用做轻量着色
 */
export function renderMarkdown(text: string): string[] {
  const renderer = new MarkdownRenderer();
  const out = text.split('\n').map((line) => renderer.feedLine(line));
  const tail = renderer.end();
  if (tail) out.push(tail);
  return out;
}

/** 渲染单行 Markdown（非代码块）：标题/列表/引用/加粗/行内代码。 */
export function renderInlineMarkdown(line: string): string {
  // 标题
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    const color = level === 1 ? C.aqua : level === 2 ? C.teal : C.cyan;
    return color + C.bold + heading[2] + C.reset;
  }
  // 引用
  if (/^>\s?/.test(line)) {
    return C.dim + line.replace(/^>\s?/, '│ ') + C.reset;
  }
  // 列表
  const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (list) {
    return list[1] + C.teal + '· ' + C.reset + formatInline(list[3]);
  }
  return formatInline(line);
}

/** 行内格式：加粗 / 斜体 / 行内代码 / 链接。 */
function formatInline(text: string): string {
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => C.yellow + code + C.reset);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => C.bold + b + C.reset);
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) => C.underline + label + C.reset + C.dim + ` (${url})` + C.reset,
  );
  return out;
}

/* ---------- 分页 ---------- */

export interface PageResult {
  /** 当前页的行。 */
  pageLines: string[];
  /** 是否还有下一页。 */
  hasMore: boolean;
  /** 下一页起始偏移。 */
  nextOffset: number;
}

/** 把行数组按页高切片（纯函数，供 REPL 分页与测试复用）。 */
export function paginate(lines: string[], pageSize: number, offset = 0): PageResult {
  const size = Math.max(1, pageSize);
  const pageLines = lines.slice(offset, offset + size);
  const nextOffset = offset + pageLines.length;
  return { pageLines, hasMore: nextOffset < lines.length, nextOffset };
}

/* ---------- 显示宽度与状态面板（真实多行渲染组件） ---------- */

/** 字符串显示宽度：ANSI 序列计 0、中文/全角计 2、emoji（含 ZWJ 序列）计 2、其余计 1。 */
export function displayWidth(str: string): number {
  return stringWidth(str);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 把字符串按"ANSI 转义序列 / 普通文本"切段。 */
function splitAnsi(str: string): Array<{ ansi: boolean; text: string }> {
  const out: Array<{ ansi: boolean; text: string }> = [];
  const re = /\x1b\[[0-9;?]*[a-zA-Z]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) out.push({ ansi: false, text: str.slice(last, m.index) });
    out.push({ ansi: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ ansi: false, text: str.slice(last) });
  return out;
}

/** 按显示宽度截断（ANSI 透传、grapheme 粒度），超宽补省略号；结果显示宽度 ≤ width。 */
export function truncateLine(str: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(str) <= width) return str;
  const target = width - 1; // 留 1 列给省略号
  let out = '';
  let used = 0;
  outer: for (const seg of splitAnsi(str)) {
    if (seg.ansi) {
      out += seg.text;
      continue;
    }
    for (const { segment } of graphemeSegmenter.segment(seg.text)) {
      const w = stringWidth(segment);
      if (used + w > target) break outer;
      out += segment;
      used += w;
    }
  }
  return out + '…';
}

/** 把字段列表按显示宽度换行（每个字段用 ' · ' 连接，不超出 maxW）。 */
function wrapFields(fields: string[], maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const f of fields) {
    const candidate = cur ? `${cur} · ${f}` : f;
    if (stringWidth(candidate) <= maxW) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = f;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** 状态面板输入数据。 */
export interface StatusPanelData {
  /** 是否运行中（面板只在运行中展示）。 */
  running: boolean;
  turn: number;
  maxTurns: number;
  tool: string;
  elapsedMs: number;
  /** 本 run 累计输入 token（非当前上下文大小）。 */
  inputTokens: number;
  /** 本 run 累计输出 token。 */
  outputTokens: number;
  /** 当前消息数组的上下文估算 token（compact 估算；未提供则不显示）。 */
  contextTokens?: number;
  /** 已排队的输入条数。 */
  queueCount: number;
  /** 是否已请求取消（Ctrl+C）。 */
  cancelled?: boolean;
}

/** 权限审批卡片数据。 */
export interface ApprovalCardData {
  risk: string;
  request: string;
  askCount: number;
  /** 可批量授权的同类操作（如 shell 的 "git/npm" 或文件工具的 "write_file"），空则不显示批量选项。 */
  batch?: string;
}

/**
 * 渲染权限审批为结构化卡片（纯函数，无 ANSI）。
 * 含：风险原因、请求内容、本任务审批次数、单次允许 [y] / 同类批量允许 [a] / 切换 auto [t] / 拒绝 [n]。
 */
/** 按显示宽度把字符串切成多行（中文/emoji 不越界）。 */
function chunkByWidth(s: string, maxW: number): string[] {
  const out: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of Array.from(s)) {
    const cw = stringWidth(ch);
    if (w + cw > maxW && cur) {
      out.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

export function renderApprovalCard(d: ApprovalCardData): string {
  const width = 64;
  const inner = width - 2;
  const cellW = inner - 1; // 「│ 」前缀 + 内容，右侧 1 列留白
  const fill = (s: string): string => {
    const w = stringWidth(s);
    return '│ ' + s + ' '.repeat(Math.max(0, inner - w - 1)) + '│';
  };
  const rows: string[] = [];
  const head = '┌─ 权限审批 ';
  rows.push(head + '─'.repeat(Math.max(0, width - stringWidth(head) - 1)) + '┐');
  /* risk / request 任意长度：按显示宽度换行，绝不撑破边框 */
  for (const line of chunkByWidth(`风险: ${d.risk}`, cellW)) rows.push(fill(line));
  for (const line of chunkByWidth(`请求: ${d.request}`, cellW)) rows.push(fill(line));
  rows.push(fill(`本任务第 ${d.askCount} 次审批`));
  rows.push('│' + ' '.repeat(inner) + '│');
  rows.push(fill('[y] 本次允许'));
  if (d.batch) rows.push(fill(`[a] 允许本任务同类操作（${d.batch}）`));
  rows.push(fill('[t] 允许并切换本会话到 auto 模式'));
  rows.push(fill('[n] 拒绝'));
  rows.push('└' + '─'.repeat(inner) + '┘');
  return rows.join('\n');
}

/**
 * 状态面板耗时计算（纯函数）：
 * 审批等待期间（pausedAt > 0）冻结在暂停时刻，且此前累计的暂停时长不计入。
 */
export function computeElapsedMs(now: number, start: number, pausedAt = 0, pausedTotal = 0): number {
  if (start <= 0) return 0;
  const base = pausedAt > 0 ? pausedAt : now;
  return Math.max(0, base - start - pausedTotal);
}

/**
 * 渲染运行中状态面板为多行（纯函数，可测试）。
 * 行数动态确定（标题 + 内容换行 + 底边框），每行显示宽度 ≤ width。
 * 返回纯文本行（无 ANSI），由调用方决定着色。
 */
export function renderStatusPanel(status: StatusPanelData, width: number): string[] {
  const w = Math.max(12, Math.floor(width));
  const inner = w - 2; // 边框两列
  const title = '⏳ 运行中';
  const elapsed = status.elapsedMs > 0 ? Math.floor(status.elapsedMs / 1000).toString() : '0';

  const fields: string[] = [
    `轮次 ${status.turn}/${status.maxTurns}`,
    `工具 ${status.tool || '…'}`,
    `耗时 ${elapsed}s`,
    `累计输入 ${status.inputTokens} tok`,
    `累计输出 ${status.outputTokens} tok`,
  ];
  if (status.contextTokens !== undefined) {
    fields.push(`本轮上下文 约 ${Math.round(status.contextTokens / 1000)}k tok（估算）`);
  }
  if (status.queueCount > 0) fields.push(`排队 ${status.queueCount} 条`);
  fields.push(status.cancelled ? '已请求取消' : 'Ctrl+C 取消');

  const content = wrapFields(fields, inner - 1);
  const pad = (s: string, n: number): string => {
    const wd = stringWidth(s);
    return wd >= n ? s : s + ' '.repeat(n - wd);
  };

  const top = '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, inner - stringWidth(title) - 3)) + '┐';
  const lines: string[] = [truncateLine(top, w)];
  for (const c of content) {
    lines.push(truncateLine('│ ' + pad(c, inner - 1) + '│', w));
  }
  lines.push(truncateLine('└' + '─'.repeat(inner) + '┘', w));
  return lines;
}
