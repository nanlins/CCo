/**
 * REPL —— 终端 UI（Claude Code 风格）。
 *
 * 深色青蓝色主题 + 像素机器人吉祥物 + 会话日志滚动 + diff 彩色展示 + 权限弹窗审批。
 *
 * 健壮性（本轮加固）：
 *   - 非交互 EOF：readline close 时 question 立即 reject，循环退出，进程不再悬挂；
 *   - Ctrl+C：agent 运行中 → requestCancel()（安全点取消）；空闲双击 → 退出；
 *   - 多行编辑：行尾反斜杠续行；
 *   - Tab 补全：斜杠命令补全；
 *   - Markdown：流式渲染代码块（语法高亮）；长输出分页（--More--）。
 */
import readline from 'node:readline/promises';
import { cursorTo, clearLine, moveCursor } from 'node:readline';
import type { Agent, AgentEvent } from './core/agent.js';
import {
  C,
  renderRobot,
  divider,
  badge,
  toolLabel,
  fileLabel,
  errorLabel,
  renderDiff,
  renderMarkdown,
  MarkdownRenderer,
  paginate,
  stripAnsi,
  renderStatusPanel,
  type StatusPanelData,
} from './core/terminal.js';
import { configGuide } from './core/configManager.js';
import { t } from './core/i18n.js';

export interface ReplOptions {
  agent: Agent;
  banner?: string;
  streams?: boolean;
  /** 未配置 API key 时显示配置引导。 */
  needsConfig?: boolean;
  onReady?: (askQuestion: (question: string) => Promise<string>) => void;
  onCommand?: (cmd: string, args: string[]) => Promise<string | void>;
  /** 注入输入/输出流（测试用；默认 process.stdin/stdout）。 */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };
  /** 参与 Tab 补全的斜杠命令列表。 */
  commands?: string[];
  /** 状态心跳间隔毫秒（默认 3000；测试可调小）。 */
  heartbeatMs?: number;
}

const VERSION = 'v0.1.0';

const DEFAULT_COMMANDS = [
  '/help',
  '/clear',
  '/tools',
  '/config',
  '/compact',
  '/tasks',
  '/memory',
  '/team',
  '/mode',
  '/model',
  '/apikey',
  '/baseurl',
  '/protocol',
  '/resume',
  '/retry',
  '/sessions',
  '/session-delete',
  '/export',
  '/plugins',
  '/plugin-install',
  '/plugin-uninstall',
  '/usage',
  '/lang',
  '/exit',
];

const HELP = `命令：
  /help      显示帮助
  /clear     清空对话历史
  /tools     列出可用工具
  /config    显示配置摘要
  /compact   强制压缩对话
  /tasks     显示任务看板
  /memory    显示记忆目录
  /team      显示队友
  /mode      显示或设置权限模式（ask|auto|deny|bypass）
  /model     显示或切换模型
  /apikey    设置 API key 并切换真实 LLM
  /baseurl   切换模型端点（千问↔DeepSeek 等）
  /protocol  切换 LLM 协议（anthropic|openai）
  /resume    恢复历史会话（/resume <sessionId>）
  /retry     复用最后 checkpoint 续跑中断任务
  /sessions  列出全部可恢复会话
  /export    导出对话（/export [md|json] [文件路径]）
  /plugins   列出已安装 plugin；/plugin-install <路径>；/plugin-uninstall <名称>
  /usage     显示 token 用量统计
  /lang      切换界面语言（/lang zh|en）
  /exit      退出
其他输入都会发送给 agent。行尾加反斜杠 \\ 可多行输入；Ctrl+C 取消当前任务。
运行中：输入 > 查询当前进度（轮次/工具/耗时/token）；输入普通文字会排队，任务结束后依次处理。`;

/** 保存当前终端内容（重启 readline 时用）。 */
const logBuffer: string[] = [];

/** 日志输出槽：默认 stdout；startRepl 注入 output 流后改道（测试/非默认输出）。 */
let outSink: (s: string) => void = (s) => process.stdout.write(s);

function log(msg: string): void {
  logBuffer.push(msg);
  outSink(msg + '\n');
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const output = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  /* 非 TTY（管道/重定向/CI）：禁用 ANSI 清屏与装饰，输出纯文本，支持连续管道命令 */
  const isTTY = Boolean((output as { isTTY?: boolean }).isTTY);
  const paint = (s: string): string => (isTTY ? s : stripAnsi(s));
  /* 输出函数：busy 期间先擦面板、写内容、再重绘面板（状态区设置好后会覆盖此实现） */
  let writeContent: (s: string) => void = (s) => output.write(paint(s));
  const writeOut = (s: string): void => writeContent(s);
  /* 日志统一走注入的 output 流（默认 stdout），保证可测试与可重定向 */
  outSink = (s) => writeContent(s);
  /* 待处理输入队列（busy 期间非阻塞收集，任务结束后依次处理） */
  const inputQueue: string[] = [];

  /* 首次启动：清屏 + 渲染 banner（非 TTY 不清屏，避免污染管道输出） */
  if (logBuffer.length === 0 && isTTY) {
    writeOut(C.clear);
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
  const modelPart =
    bannerStr
      .split('|')[0]
      ?.replace(/小锤 Anvil — /, '')
      .trim() ?? '';
  if (modelPart) model = modelPart;

  /* 新布局：小人物顶部居中 → 名称/版本 → 示例问题 */
  const art = renderRobot();
  const centered = art.map((l) => {
    const plainLen = l.replace(/\x1b\[[0-9;]*m/g, '').length;
    const pad = Math.max(0, Math.floor((60 - plainLen) / 2));
    return ' '.repeat(pad) + l;
  });
  for (const line of centered) log(line);
  log('');
  log(C.teal + C.bold + '  小锤 Anvil' + C.reset + '  ' + C.dim + VERSION + C.reset);
  log(
    '  ' + C.dim + '模型: ' + C.reset + C.white + model + C.reset + (mode ? C.dim + ' | 模式: ' + C.reset + mode : ''),
  );
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

  /* 事件输出：text 流式经 MarkdownRenderer 渲染（代码块语法高亮） */
  let textBuffer = '';
  const md = new MarkdownRenderer();
  /* 运行中状态跟踪（面板：当前轮次 / 工具 / 耗时 / token / 队列） */
  let statusTurn = 0;
  let statusMaxTurns = 0;
  let statusTool = '';
  let statusStart = 0;
  opts.agent.setOnEvent((e: AgentEvent) => {
    switch (e.type) {
      case 'text': {
        textBuffer += e.text;
        const lines = textBuffer.split('\n');
        textBuffer = lines.pop() ?? '';
        for (const line of lines) {
          writeOut(md.feedLine(line) + '\n');
        }
        break;
      }
      case 'turn': {
        statusTurn = e.turn;
        statusMaxTurns = e.maxTurns;
        break;
      }
      case 'tool_use': {
        if (textBuffer.trim()) {
          writeOut(md.feedLine(textBuffer) + '\n');
          textBuffer = '';
        }
        statusTool = e.name;
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
          log('  ' + errorLabel('⛔ ' + t('error.permission_denied')) + C.dim + ' ' + e.reason + C.reset);
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

  /* ---- 运行中状态面板（真实多行渲染组件） ----
     面板位于提示符上方、内容下方，高度动态确定；更新用 readline 游标原语
     （moveCursor/clearLine）按当前高度移动，不假设"永远一行"。 */

  /** 读取终端列数（注入 output.columns 或 process.stdout.columns）。 */
  const getColumns = (): number => (output as { columns?: number }).columns ?? process.stdout.columns ?? 80;

  /** 组装状态面板输入数据。 */
  const buildStatusData = (): StatusPanelData => {
    const u = opts.agent.usage.summary();
    return {
      running: true,
      turn: statusTurn,
      maxTurns: statusMaxTurns,
      tool: statusTool,
      elapsedMs: statusStart > 0 ? Date.now() - statusStart : 0,
      inputTokens: u.totalInput,
      outputTokens: u.totalOutput,
      queueCount: inputQueue.length,
      cancelled: opts.agent.isCancelRequested(),
    };
  };

  /* 面板几何状态：当前占据的行数 + 是否已绘制 */
  let statusHeight = 0;
  let statusActive = false;

  /** 擦除面板：上移 statusHeight 行、逐行清空、回到锚点（内容末尾）。 */
  function erasePanel(): void {
    if (!isTTY || !statusActive || statusHeight <= 0) return;
    moveCursor(output, 0, -statusHeight);
    for (let i = 0; i < statusHeight; i++) {
      clearLine(output, 0);
      moveCursor(output, 0, 1);
    }
    moveCursor(output, 0, -statusHeight);
    statusActive = false;
    statusHeight = 0;
  }

  /** 在锚点处绘制面板，光标停在面板下方（提示符行）。 */
  function drawPanel(): void {
    if (!isTTY) return;
    const lines = renderStatusPanel(buildStatusData(), getColumns());
    for (const l of lines) output.write(paint(C.dim + l + C.reset + '\n'));
    statusHeight = lines.length;
    statusActive = true;
  }

  /** 写内容：先擦面板、写内容、再重绘面板（面板始终贴底，不覆盖内容）。 */
  function writeContentImpl(s: string): void {
    if (!isTTY || !statusActive) {
      output.write(paint(s));
      return;
    }
    erasePanel();
    output.write(paint(s));
    drawPanel();
  }

  /** 心跳/事件重绘面板（无新内容）。 */
  function refreshPanel(): void {
    if (!isTTY || !statusActive) return;
    erasePanel();
    drawPanel();
  }

  /** 清空面板（busy 结束）。 */
  function clearPanel(): void {
    if (!isTTY || !statusActive) return;
    erasePanel();
  }

  /* 接入输出函数 */
  writeContent = writeContentImpl;

  const flushTextBuffer = (): void => {
    if (textBuffer.trim()) {
      writeOut(md.feedLine(textBuffer) + '\n');
      textBuffer = '';
    }
    const tail = md.end();
    if (tail) writeOut(tail + '\n');
  };

  /* Tab 补全：斜杠命令 */
  const commandList = opts.commands ?? DEFAULT_COMMANDS;
  const completer = (line: string): [string[], string] => {
    if (line.startsWith('/')) {
      const hits = commandList.filter((c) => c.startsWith(line));
      return [hits.length ? hits : commandList, line];
    }
    return [[], line];
  };

  const rl = readline.createInterface({
    input,
    output,
    completer,
    terminal: Boolean((input as { isTTY?: boolean }).isTTY),
  });

  /* Ctrl+C：运行中 → 请求取消；空闲 → 提示，1.5s 内再来一次则退出 */
  let busy = false;
  let lastIdleSigint = 0;
  let exitRequested = false;
  rl.on('SIGINT', () => {
    if (busy) {
      opts.agent.requestCancel();
      refreshPanel();
      writeContent(C.yellow + '  ' + t('repl.cancel_requested') + C.reset + '\n');
      return;
    }
    const now = Date.now();
    if (now - lastIdleSigint < 1500) {
      exitRequested = true;
      writeOut('\n');
      rl.close();
      return;
    }
    lastIdleSigint = now;
    writeOut('\n' + C.dim + '  ' + t('repl.exit_hint') + C.reset + '\n');
    rl.prompt();
  });

  /* 终端 resize：按新宽度立即重绘状态区（readline 也会发出 SIGWINCH） */
  const onResize = (): void => {
    if (busyActive && isTTY) refreshPanel();
  };
  (output as NodeJS.WritableStream & { on?: (ev: string, cb: () => void) => void }).on?.('resize', onResize);
  if (output !== process.stdout && (process.stdout as { on?: (ev: string, cb: () => void) => void }).on) {
    process.stdout.on('resize', onResize);
  }

  /** raw 模式读一个按键（分页器用）：先暂停 readline，接管 stdin，读完恢复，禁止与 readline 同时切 raw。 */
  function readKey(): Promise<string> {
    return new Promise((resolve) => {
      rl.pause();
      try {
        (input as NodeJS.ReadableStream & { setRawMode?: (m: boolean) => void }).setRawMode?.(true);
      } catch {
        /* 非终端直接回退 */
      }
      const onData = (chunk: Buffer): void => {
        (input as NodeJS.ReadableStream & { removeListener: (e: string, cb: unknown) => void }).removeListener(
          'data',
          onData,
        );
        try {
          (input as NodeJS.ReadableStream & { setRawMode?: (m: boolean) => void }).setRawMode?.(false);
        } catch {
          /* ignore */
        }
        rl.resume();
        resolve(chunk.toString('utf8'));
      };
      (input as NodeJS.ReadableStream & { once: (e: string, cb: unknown) => void }).once('data', onData);
    });
  }

  /** 交互式分页输出（非 TTY 或内容不足一页时直接全部打印）。 */
  async function printPaged(text: string): Promise<void> {
    const lines = text.split('\n');
    const pageSize = Math.max(4, ((output as { rows?: number }).rows ?? process.stdout.rows ?? 24) - 3);
    if (!isTTY || lines.length <= pageSize) {
      output.write(paint(lines.join('\n') + '\n'));
      return;
    }
    let offset = 0;
    for (;;) {
      const { pageLines, hasMore, nextOffset } = paginate(lines, pageSize, offset);
      output.write(paint(pageLines.join('\n') + '\n'));
      if (!hasMore) return;
      output.write(paint(C.darkGray + `--More-- (${nextOffset}/${lines.length}, 空格:下一页 q:退出)` + C.reset));
      const key = await readKey();
      cursorTo(output, 0);
      clearLine(output, 0);
      if (key === 'q' || key === '\u0003') return; // q 或 Ctrl+C 退出分页
      offset = key === '\r' || key === '\n' ? offset + 1 : nextOffset;
    }
  }

  /* ---- 单一输入调度器：所有 readline 输入收敛到唯一 pump 循环，从根上消除并发 question 竞争 ----
     三种"行消费者"(sink)：
       1) 空闲：sink=null，行进 mainChannel（主命令循环）
       2) 权限弹窗：sink=权限 resolver，下一行作为审批答复
       3) busy：sink=busySink，'>' 显示进度、其它文字进待处理队列
     同一时刻只有一个 sink 生效，且只在同步代码里切换，绝无"弹窗瞬间键入丢行"。 */
  let sink: ((line: string) => void) | null = null;
  let sinkPrompt = '❯ ';
  let busyActive = false;

  /** 同步修改提示符：同时更新 readline 的 prompt 状态并重绘（保留当前输入行）。 */
  const setPromptSync = (p: string): void => {
    sinkPrompt = p;
    if (isTTY && (input as { isTTY?: boolean }).isTTY) {
      rl.setPrompt(p);
      /* readline 已关闭（EOF）时 prompt 会抛 ERR_USE_AFTER_CLOSE，需跳过 */
      if (!(rl as unknown as { closed?: boolean }).closed) {
        rl.prompt(true);
      }
    }
  };

  const mainChannel = (() => {
    const queue: string[] = [];
    const waiters: Array<{ resolve: (l: string) => void; reject: (e: Error) => void }> = [];
    let closed = false;
    return {
      push(line: string): void {
        const w = waiters.shift();
        if (w) w.resolve(line);
        else queue.push(line);
      },
      next(): Promise<string> {
        if (queue.length > 0) return Promise.resolve(queue.shift()!);
        if (closed) return Promise.reject(new Error('EOF'));
        return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      },
      close(): void {
        closed = true;
        for (const w of waiters.splice(0)) w.reject(new Error('EOF'));
      },
    };
  })();

  /* 唯一 readline 读取循环（永不并发 question）。
     注意：node:readline/promises 的 question 在 interface 关闭时不会自动 reject，
     必须自行监听 close 事件，否则 EOF 后进程悬挂。 */
  const pumpQuestion = (prompt: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if ((rl as unknown as { closed?: boolean }).closed) {
        reject(new Error('EOF'));
        return;
      }
      let settled = false;
      const onClose = (): void => {
        if (!settled) {
          settled = true;
          reject(new Error('EOF'));
        }
      };
      rl.once('close', onClose);
      rl.question(prompt).then(
        (v) => {
          if (settled) return;
          settled = true;
          rl.removeListener('close', onClose);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          rl.removeListener('close', onClose);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });

  void (async () => {
    for (;;) {
      if ((rl as unknown as { closed?: boolean }).closed) break;
      let line: string;
      try {
        line = await pumpQuestion(sinkPrompt);
      } catch {
        break; // EOF / 关闭
      }
      const s = sink as ((line: string) => void) | null;
      if (s) s(line);
      else mainChannel.push(line);
    }
    /* EOF 结清：挂起的 sink 收到空行（权限 → 空答复=拒绝；busy → 忽略） */
    const s = sink as ((line: string) => void) | null;
    sink = null;
    if (s) s('');
    mainChannel.close();
  })();

  /** busy 行消费者：'>' 显示可见进度面板，普通文字入待处理队列（非阻塞）。 */
  const busySink = (line: string): void => {
    const t2 = line.trim();
    if (t2 === '>') {
      refreshPanel();
    } else if (t2) {
      inputQueue.push(t2);
      writeContent(C.yellow + `  当前任务运行中，输入已排队（共 ${inputQueue.length} 条）: ${t2}` + C.reset + '\n');
    }
    if (busyActive && !(rl as unknown as { closed?: boolean }).closed) {
      sink = busySink;
      sinkPrompt = '';
    }
  };

  /* 权限审批：写文件前弹窗（ask 模式时由 PermissionGate 调用 askFn） */
  opts.onReady?.(async (question: string): Promise<string> => {
    log('');
    log('  ' + badge(t('repl.badge.permission'), C.yellow));
    for (const line of renderMarkdown(question)) log('  ' + line);
    /* 接管 sink：下一行即审批答复（单泵串行，无竞争） */
    const answer = await new Promise<string>((resolve) => {
      sink = (l) => {
        sink = null;
        resolve(l);
      };
      setPromptSync('  ' + C.yellow + '❓ ' + C.reset);
    });
    /* 答复后恢复：仍在 busy 则回到 busy sink，否则回空闲 */
    if (busyActive) {
      sink = busySink;
      sinkPrompt = '';
    } else {
      sink = null;
      setPromptSync('❯ ');
    }
    writeContent('  ' + C.dim + '→ ' + answer.trim() + C.reset + '\n');
    return answer.trim();
  });

  for (;;) {
    if (exitRequested) break;
    let line: string;
    if (inputQueue.length > 0) {
      line = inputQueue.shift()!;
      log('');
      log(C.dim + '  （处理排队输入）' + C.reset + ' ' + line);
    } else {
      try {
        /* 单一输入调度器：主循环只从 mainChannel 取行（提示符由 pump 用 sinkPrompt 管理） */
        line = await mainChannel.next();
      } catch {
        break; // EOF / readline 关闭：干净退出
      }
    }
    let trimmed = line.trim();
    if (!trimmed) continue;

    /* 多行编辑：行尾反斜杠续行 */
    while (trimmed.endsWith('\\')) {
      trimmed = trimmed.slice(0, -1).trimEnd();
      let cont: string;
      sinkPrompt = '⋮ ';
      try {
        cont = await mainChannel.next();
      } catch {
        cont = '';
      }
      sinkPrompt = '❯ ';
      trimmed = trimmed + '\n' + cont.trim();
      if (!cont.trim()) break;
    }
    if (!trimmed) continue;
    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit') break;

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
      const handled = await opts.onCommand?.(cmd, rest);
      if (handled) {
        /* 长输出分页 */
        await printPaged('  ' + String(handled).split('\n').join('\n  '));
        continue;
      }
      log(HELP);
      continue;
    }

    /* 用户指令入日志（超长截断回显） */
    log('');
    const echo = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…（共 ${trimmed.length} 字符）` : trimmed;
    log('  ' + badge(t('repl.badge.you')) + C.bold + ' ' + echo.split('\n').join(' ↵ ') + C.reset);
    log('');

    busy = true;
    busyActive = true;
    sink = busySink;
    statusStart = Date.now();
    statusTurn = 0;
    statusTool = '';
    /* 进入 busy：绘制初始面板，提示符清空（面板即 busy UI） */
    const isTTYOut = Boolean((output as { isTTY?: boolean }).isTTY);
    if (isTTYOut) {
      drawPanel();
      setPromptSync('');
    } else {
      sinkPrompt = '';
    }
    /* 状态心跳：运行中定时重绘面板（仅 TTY） */
    const heartbeat = isTTYOut
      ? setInterval(() => {
          refreshPanel();
        }, opts.heartbeatMs ?? 3000)
      : null;
    try {
      const text = await opts.agent.run(trimmed);
      if (heartbeat) clearInterval(heartbeat);
      clearPanel();
      flushTextBuffer();
      log('');
      log(divider());
      log('');
      if (text && !opts.streams) {
        log(C.gray + '  ' + text + C.reset);
      }
      if (inputQueue.length > 0) {
        log(C.dim + `  （${inputQueue.length} 条排队输入将依次处理）` + C.reset);
      }
    } catch (err) {
      if (heartbeat) clearInterval(heartbeat);
      clearPanel();
      flushTextBuffer();
      const msg = err instanceof Error ? err.message : String(err);
      log('');
      log('  ' + errorLabel(`${t('repl.error')} ${msg}`));
      /* 欠费/权限类错误给出可操作提示 */
      if (
        /overdue-payment|access denied|account is in good standing|insufficient balance|balance insufficient|quota/i.test(
          msg,
        )
      ) {
        log(
          '  ' +
            C.dim +
            '提示：可能是 API key 欠费或权限问题。会话已保存，可 /resume 恢复、/export 导出；或 /apikey sk-xxx 更换 key 后重试。' +
            C.reset,
        );
      }
    } finally {
      busy = false;
      busyActive = false;
      sink = null;
      setPromptSync('❯ ');
    }
  }
  rl.close();
}

/** 清理 Markdown 符号（保留给测试与外部复用；REPL 流式渲染用 MarkdownRenderer）。 */
export function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/^>\s*/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}
