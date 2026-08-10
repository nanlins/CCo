/**
 * REPL —— 终端 UI（Claude Code 风格）。
 *
 * 深色青蓝色主题 + 像素机器人吉祥物 + 会话日志滚动 + diff 彩色展示 + 权限弹窗审批。
 *
 * 布局：
 *   顶部：机器人 art + 版本/模型/路径
 *   中部：会话日志（滚动输出 AI 执行的命令、文件修改、diff 变更）
 *   底部：输入提示符
 *
 * 权限审批：写文件前弹窗显示变更，用户 y/N 决定是否允许。
 */
import readline from 'node:readline/promises';
import type { Agent, AgentEvent } from './core/agent.js';
import { C, renderRobot, divider, badge, toolLabel, cmdLabel, fileLabel, errorLabel, renderDiff, up } from './core/terminal.js';
import { configGuide } from './core/configManager.js';

export interface ReplOptions {
  agent: Agent;
  banner?: string;
  streams?: boolean;
  /** 未配置 API key 时显示配置引导。 */
  needsConfig?: boolean;
  onReady?: (askQuestion: (question: string) => Promise<string>) => void;
  onCommand?: (cmd: string, args: string[]) => Promise<string | void>;
}

const VERSION = 'v0.1.0';

const HELP = `命令：
  /help      显示帮助
  /clear     清空对话历史
  /tools     列出可用工具
  /config    显示配置摘要
  /compact   强制压缩对话
  /tasks     显示任务看板
  /memory    显示记忆目录
  /team      显示队友
  /mode      显示或设置权限模式（ask|auto|deny）
  /resume    恢复历史会话（/resume <sessionId>）
  /exit      退出
其他输入都会发送给 agent。`;

/** 保存当前终端内容（重启 readline 时用）。 */
let logBuffer: string[] = [];

function log(msg: string): void {
  logBuffer.push(msg);
  console.log(msg);
}

/** 清屏并渲染完整界面（重启 readline 后恢复）。 */
function renderScreen(): void {
  process.stdout.write(C.clear);
  // banner 已由 main 打印，这里只恢复日志
  for (const line of logBuffer) {
    process.stdout.write(line + '\n');
  }
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  /* 首次启动：清屏 + 渲染 banner */
  if (logBuffer.length === 0) {
    process.stdout.write(C.clear);
  }

  /* 解析 banner（main 传入格式: "小锤 Anvil — model | mode=xx | workdir=yyy"） */
  const bannerStr = opts.banner ?? '';
  let model = bannerStr;
  let mode = '';
  let workdir = '';
  const modeMatch = bannerStr.match(/mode=(\S+)/);
  if (modeMatch) mode = modeMatch[1];
  const dirMatch = bannerStr.match(/workdir=(\S+)/);
  if (dirMatch) workdir = dirMatch[1];
  const modelPart = bannerStr.split('|')[0]?.replace(/小锤 Anvil — /, '').trim() ?? '';
  if (modelPart) model = modelPart;

  /* 新布局：小人物顶部居中 → 名称/版本 → 示例问题 */
  const art = renderRobot();
  const artWidth = Math.max(...art.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
  const centered = art.map((l) => {
    const plainLen = l.replace(/\x1b\[[0-9;]*m/g, '').length;
    const pad = Math.max(0, Math.floor((60 - plainLen) / 2));
    return ' '.repeat(pad) + l;
  });
  for (const line of centered) log(line);
  log('');
  log(C.teal + C.bold + '  小锤 Anvil' + C.reset + '  ' + C.dim + VERSION + C.reset);
  log('  ' + C.dim + '模型: ' + C.reset + C.white + model + C.reset + (mode ? C.dim + ' | 模式: ' + C.reset + mode : ''));
  log('  ' + C.dim + '工作区: ' + C.reset + C.gray + workdir + C.reset);
  log('');
  log('  ' + C.dim + '入门:' + C.reset);
  log('  ' + C.gray + '  1. ' + C.reset + C.cyan + '创建 ANVIL.md 文件来自定义交互行为' + C.reset);
  log('  ' + C.gray + '  2. ' + C.reset + C.cyan + '输入 /help 获取更多信息' + C.reset);
  log('  ' + C.gray + '  3. ' + C.reset + C.cyan + '可以提问编程问题、编辑代码或者运行命令' + C.reset);
  log('  ' + C.gray + '  4. ' + C.reset + C.cyan + '描述尽量具体，以获得最佳输出结果' + C.reset);

  /* 未配置 API key：显示配置引导 */
  if (opts.needsConfig) {
    log('');
    log(C.yellow + '  ⚠ ' + C.reset + '未配置模型 API key，当前为离线演示模式');
    log('');
    const guide = configGuide(workdir);
    for (const line of guide.split('\n')) {
      log('  ' + C.dim + line + C.reset);
    }
  }

  log('');
  log(divider('会话日志'));
  log('');

  /* 事件输出：text 流式缓冲，按完整行清理 Markdown（避免跨片段匹配不到） */
  let textBuffer = '';
  opts.agent.setOnEvent((e: AgentEvent) => {
    switch (e.type) {
      case 'text': {
        textBuffer += e.text;
        /* 按换行切分：完整行立即清理输出，残缺行留缓冲 */
        const lines = textBuffer.split('\n');
        textBuffer = lines.pop() ?? '';
        for (const line of lines) {
          process.stdout.write(cleanMarkdown(line) + '\n');
        }
        break;
      }
      case 'tool_use': {
        if (textBuffer.trim()) {
          process.stdout.write(cleanMarkdown(textBuffer));
          textBuffer = '';
        }
        const args = JSON.stringify(e.args ?? {}).slice(0, 80);
        log('');
        log('  ' + badge('TOOL') + ' ' + toolLabel(e.name) + C.dim + ' ' + args + C.reset);
        break;
      }
      case 'tool_result': {
        break;
      }
      case 'diff': {
        log('');
        log('  ' + badge('DIFF', C.cyan) + ' ' + fileLabel(e.file));
        for (const line of renderDiff(e.diff)) {
          log('  ' + line);
        }
        break;
      }
      case 'permission': {
        if (!e.allow) {
          log('');
          log('  ' + errorLabel('⛔ 权限被拒绝') + C.dim + ' ' + e.reason + C.reset);
        }
        break;
      }
      case 'system': {
        log('');
        log('  ' + C.dim + '[' + e.message + ']' + C.reset);
        break;
      }
      case 'compact': {
        log('  ' + C.dim + '  [压缩] ' + e.action + C.reset);
        break;
      }
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  /* 权限审批：写文件前弹窗（ask 模式时由 PermissionGate 调用 askFn） */
  opts.onReady?.(async (question: string): Promise<string> => {
    log('');
    log('  ' + badge('权限请求', C.yellow));
    log('  ' + question);
    const answer = await rl.question('  ' + C.yellow + '❓ ' + C.reset);
    process.stdout.write(up(1) + C.clearLine + '  ' + C.dim + '→ ' + answer.trim() + C.reset + '\n');
    return answer.trim();
  });

  for (;;) {
    let line: string;
    try {
      /* 提示符必须无 ANSI：readline 按提示符长度计算换行，带颜色码会让长输入重绘错乱（首行重复） */
      line = await rl.question('❯ ');
    } catch {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit') break;

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
      const handled = await opts.onCommand?.(cmd, rest);
      if (handled) {
        log('  ' + String(handled));
        continue;
      }
      log(HELP);
      continue;
    }

    /* 用户指令入日志：刚输入的内容不整段复读，长输入只留摘要（避免"再说一遍"的冗余感） */
    log('');
    const echo = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…（共 ${trimmed.length} 字）` : trimmed;
    log('  ' + badge('你') + C.bold + ' ' + echo + C.reset);
    log('');

    try {
      const text = await opts.agent.run(trimmed);
      /* flush 剩余文本缓冲 */
      if (textBuffer.trim()) {
        process.stdout.write(cleanMarkdown(textBuffer));
        textBuffer = '';
      }
      log('');
      log(divider());
      log('');
      if (text && !opts.streams) {
        log(C.gray + '  ' + text + C.reset);
      }
    } catch (err) {
      if (textBuffer.trim()) {
        process.stdout.write(cleanMarkdown(textBuffer));
        textBuffer = '';
      }
      const msg = err instanceof Error ? err.message : String(err);
      log('');
      log('  ' + errorLabel(`[错误] ${msg}`));
      /* 计费/账户级错误单独提示：与密钥字符串无关，避免"换了 key 怎么还报错"的困惑 */
      if (/overdue-payment|access denied|account is in good standing|insufficient balance|balance insufficient|quota/i.test(msg)) {
        log('  ' + C.dim + '提示：这是账户计费/权限级错误——同一账户换新 key 也会失败。' +
          '充值或换账户后直接重试即可：/apikey sk-xxx 立即生效，无需重启。' + C.reset);
      }
    }
  }
  rl.close();
}

/** 清理 Markdown 符号，终端显示干净（去掉 ** 加粗、* 斜体、# 标题、` 代码等）。 */
export function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **加粗** → 内容
    .replace(/\*(.+?)\*/g, '$1')       // *斜体* → 内容
    .replace(/__([^_]+)__/g, '$1')     // __下划线__
    .replace(/^#{1,6}\s*/gm, '')       // 标题 # ## ###
    .replace(/`([^`]+)`/g, '$1')       // `行内代码` → 内容
    .replace(/^\s*[-*]\s+/gm, '· ')    // 列表 - 或 * → · 符号
    .replace(/^>\s*/gm, '')            // 引用 >
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'); // 链接 [文本](url) → 文本(url)
}
