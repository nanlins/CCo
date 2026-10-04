/**
 * 终端主题 —— 统一颜色 token 与多级输出能力。
 *
 * 参考 nanoclaw setup/lib/theme.ts 的设计：
 *   - truecolor（COLORTERM=truecolor|24bit）      → 24-bit RGB
 *   - 256 色（COLORTERM=256color 或 TERM 含 256color）→ 38;5;NN
 *   - 否则                                        → 16 色降级
 *   - NO_COLOR 环境变量存在                       → 纯文本（无 ANSI，但保持可读结构）
 *   - 非 TTY（管道/重定向/CI）                    → 由 repl.ts 输出层 stripAnsi 处理
 *
 * 承重不变量：
 *   - 所有颜色经 fg/bg 生成，绝不直接拼接 256 色码（统一由 COLOR256 档决定）；
 *   - 颜色 token 不因 process.stdout.isTTY 而关闭（测试在非 TTY 下断言 ANSI 存在），
 *     仅 NO_COLOR 关闭；控制码（clear/cursor 等）不属于颜色，不随 NO_COLOR 关闭。
 */
import stringWidth from 'string-width';

const NO_COLOR = 'NO_COLOR' in process.env;
const TRUECOLOR = !NO_COLOR && (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');
const COLOR256 =
  !NO_COLOR && !TRUECOLOR && (process.env.COLORTERM === '256color' || /256color/.test(process.env.TERM ?? ''));

/** 是否输出 ANSI（NO_COLOR 时关闭）。 */
export const USE_ANSI = !NO_COLOR;

type Rgb = [number, number, number];

function style(code: string): string {
  return USE_ANSI ? `\x1b[${code}m` : '';
}

function fg(rgb: Rgb, code256: number, code16: string): string {
  if (!USE_ANSI) return '';
  if (TRUECOLOR) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (COLOR256) return `\x1b[38;5;${code256}m`;
  return `\x1b[${code16}m`;
}

function bg(rgb: Rgb, code256: number, code16: string): string {
  if (!USE_ANSI) return '';
  if (TRUECOLOR) return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (COLOR256) return `\x1b[48;5;${code256}m`;
  return `\x1b[${code16}m`;
}

/** 颜色 token（替换原 terminal.ts 中散落的硬编码 ANSI/256 色码）。 */
export const C = {
  reset: style('0'),
  bold: style('1'),
  dim: style('2'),
  italic: style('3'),
  underline: style('4'),
  // 前景
  black: fg([40, 42, 54], 235, '30'),
  red: fg([255, 85, 85], 203, '31'),
  green: fg([80, 250, 123], 84, '32'),
  yellow: fg([241, 250, 140], 228, '33'),
  blue: fg([98, 114, 164], 61, '34'),
  magenta: fg([255, 121, 198], 212, '35'),
  cyan: fg([139, 233, 253], 117, '36'),
  white: fg([248, 248, 242], 255, '37'),
  // 青蓝主题（16 色降级到 cyan）
  teal: fg([43, 183, 206], 44, '36'),
  aqua: fg([139, 233, 253], 80, '36'),
  cyanDim: fg([139, 233, 253], 37, '36'),
  gray: fg([98, 114, 164], 245, '90'),
  darkGray: fg([68, 71, 90], 240, '90'),
  orange: fg([255, 184, 108], 215, '33'),
  pink: fg([255, 121, 198], 211, '35'),
  purple: fg([189, 147, 249], 141, '35'),
  // 背景
  bgDark: bg([40, 42, 54], 235, '40'),
  bgTeal: bg([43, 183, 206], 44, '46'),
  bgGray: bg([68, 71, 90], 240, '40'),
  bgRed: bg([255, 85, 85], 124, '41'),
  // 控制码（非颜色，不随 NO_COLOR 关闭）
  clear: '\x1b[2J\x1b[H',
  clearLine: '\x1b[2K',
  savePos: '\x1b[s',
  restorePos: '\x1b[u',
  showCursor: '\x1b[?25h',
  hideCursor: '\x1b[?25l',
};

/** 品牌徽章（深底亮字），参考 nanoclaw brandChip。 */
export function brandChip(text: string): string {
  if (!USE_ANSI) return text;
  if (TRUECOLOR) return `\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1m${text}\x1b[0m`;
  if (COLOR256) return `\x1b[48;5;44m\x1b[38;5;235m\x1b[1m${text}\x1b[0m`;
  return `\x1b[46m\x1b[30m\x1b[1m${text}\x1b[0m`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** 去除 ANSI 转义序列（非 TTY/管道输出用）。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** 可见宽度（ANSI 计 0）。 */
export function visibleLength(s: string): number {
  return stringWidth(stripAnsi(s));
}

function wrapLine(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  const words = line.split(' ');
  const rows: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const word of words) {
    const wLen = visibleLength(word);
    if (curLen === 0) {
      cur = word;
      curLen = wLen;
    } else if (curLen + 1 + wLen <= width) {
      cur += ' ' + word;
      curLen += 1 + wLen;
    } else {
      rows.push(cur);
      cur = word;
      curLen = wLen;
    }
  }
  if (cur) rows.push(cur);
  return rows.join('\n');
}

/** 按 gutter 剩余宽度硬换行（中文/emoji 用 visibleLength 不越界）。 */
export function wrapForGutter(text: string, gutter: number): string {
  const cols = process.stdout.columns ?? 80;
  const width = Math.max(30, cols - gutter);
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

/** 截断标签使"基础 + 保留后缀"不超终端宽，超宽补省略号（ANSI 透传）。 */
export function fitToWidth(base: string, suffix: string): string {
  const cols = process.stdout.columns ?? 80;
  const budget = Math.max(20, cols - 7 - visibleLength(suffix));
  if (visibleLength(base) <= budget) return base;
  return truncateVisible(base, budget);
}

/** 按可见宽度截断，ANSI 透传、超宽补省略号。 */
function truncateVisible(str: string, width: number): string {
  if (width <= 0) return '';
  if (visibleLength(str) <= width) return str;
  const target = width - 1;
  let out = '';
  let used = 0;
  const re = ANSI_RE;
  let last = 0;
  let m: RegExpExecArray | null;
  const segs: Array<{ ansi: boolean; text: string }> = [];
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) segs.push({ ansi: false, text: str.slice(last, m.index) });
    segs.push({ ansi: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < str.length) segs.push({ ansi: false, text: str.slice(last) });

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  outer: for (const seg of segs) {
    if (seg.ansi) {
      out += seg.text;
      continue;
    }
    for (const { segment } of segmenter.segment(seg.text)) {
      const w = stringWidth(segment);
      if (used + w > target) break outer;
      out += segment;
      used += w;
    }
  }
  return out + '…';
}

/** 耗时格式化：<60s 显示 "47s"，≥60s 显示 "2m 34s"。 */
export function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

// 修改记录：
//   2026-10-03 新增：统一颜色 token（truecolor/16色/NO_COLOR 四级降级）+ brandChip/wrapForGutter/fitToWidth
