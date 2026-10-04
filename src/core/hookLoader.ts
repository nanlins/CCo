/**
 * 外部 Hook 加载器 —— 从用户级 / 项目级配置文件加载命令型 hook。
 *
 * 约定：
 *   - 用户级：<home>/.anvil/hooks.json（视为可信，总是加载）
 *   - 项目级：<workspace>/.anvil/hooks.json（不可信来源：打开任意仓库即加载 = 任意命令执行，
 *     必须经显式信任确认；信任按"文件内容指纹"持久化到 <home>/.anvil/hooks-trusted.json，
 *     内容任何变化都会使信任失效并重新确认）
 * 格式：
 *   { "<HookEvent>": [ { "type": "command", "command": "node ./hook.js", "timeout": 5000 } ] }
 *   command 经 shell 执行，payload 以 JSON 写入 stdin，stdout 若为合法 JSON 则作为 HookResult。
 *
 * 承重不变量（可控降级 + 信任边界）：
 *   - 配置文件缺失/损坏 → 忽略；
 *   - 命令执行失败（非零退出/超时/spawn 失败/stdout 非 JSON）→ 记录日志后返回 undefined，绝不阻断主循环；
 *   - 项目级 hook 未确认信任前绝不注册/执行（无确认通道时默认跳过）。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookRegistry, type HookEvent, type HookResult } from './hooks.js';

/** 16 个合法事件（与 HookEvent 类型一致）。 */
const EVENT_NAMES = new Set<HookEvent>([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'Setup',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
]);

export interface CommandHookSpec {
  type: 'command';
  command: string;
  timeout?: number;
}

export type HookFile = Record<string, CommandHookSpec | CommandHookSpec[]>;

const DEFAULT_TIMEOUT = 5000;

function readHookFile(file: string): HookFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookFile) : null;
  } catch {
    return null;
  }
}

function runCommandHook(command: string, payload: unknown, timeoutMs: number): Promise<HookResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: HookResult | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      done(undefined);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      done(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', () => {
      /* stderr 供调试，不阻断 */
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(undefined);
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        done(undefined);
        return;
      }
      try {
        done(JSON.parse(trimmed) as HookResult);
      } catch {
        done(undefined);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
    child.stdin?.write(JSON.stringify(payload ?? {}));
    child.stdin?.end();
  });
}

export interface ExternalHookLogger {
  (level: 'warn' | 'error', msg: string): void;
}

/** 项目级 hook 信任门选项。 */
export interface HookTrustOptions {
  /** 信任存储目录（默认 <home>/.anvil）；测试可注入临时目录。 */
  trustDir?: string;
  /**
   * 首次加载项目级 hook 的确认通道：入参为"文件 + 将执行的命令"清单，返回 true 才加载。
   * 未提供时项目级 hook 一律跳过（安全默认）。
   */
  confirmProject?: (summary: string) => Promise<boolean>;
}

function trustPath(trustDir?: string): string {
  return path.join(trustDir ?? path.join(os.homedir(), '.anvil'), 'hooks-trusted.json');
}

function fingerprint(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function loadTrust(file: string): Record<string, string> {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveTrust(file: string, trust: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(trust, null, 2), 'utf8');
  } catch {
    /* 信任持久化失败不影响本次加载（下次会再次询问） */
  }
}

/** 把 hooks.json 的合法条目注册进 registry（对已读取的数据，不涉及信任判断）。 */
function registerHookFile(registry: HookRegistry, data: HookFile, file: string, log: ExternalHookLogger): void {
  for (const [event, spec] of Object.entries(data)) {
    if (!EVENT_NAMES.has(event as HookEvent)) {
      log('warn', `[hook] 未知事件 ${event}，已忽略（${file}）`);
      continue;
    }
    const specs = (Array.isArray(spec) ? spec : [spec]) as CommandHookSpec[];
    for (const s of specs) {
      if (s?.type !== 'command' || typeof s.command !== 'string') {
        log('warn', `[hook] 事件 ${event} 存在非法条目，已忽略（${file}）`);
        continue;
      }
      const timeout = typeof s.timeout === 'number' && s.timeout > 0 ? s.timeout : DEFAULT_TIMEOUT;
      registry.register(event as HookEvent, (payload) => runCommandHook(s.command, payload, timeout));
    }
  }
}

/** 人类可读的"将执行的命令"清单（信任确认弹窗展示用）。 */
export function describeHookFile(data: HookFile, file: string): string {
  const lines: string[] = [`项目级 hooks 文件: ${file}`, '加载后将执行以下命令：'];
  for (const [event, spec] of Object.entries(data)) {
    for (const s of Array.isArray(spec) ? spec : [spec]) {
      if (s?.type === 'command' && typeof s.command === 'string') lines.push(`- [${event}] ${s.command}`);
    }
  }
  lines.push('是否信任并加载？（y/N）');
  return lines.join('\n');
}

/** 加载用户级 hook（<home>/.anvil/hooks.json，视为可信）。 */
export function loadUserHooks(registry: HookRegistry, log: ExternalHookLogger): void {
  const file = path.join(os.homedir(), '.anvil', 'hooks.json');
  const data = readHookFile(file);
  if (!data) return;
  registerHookFile(registry, data, file, log);
}

/**
 * 加载项目级 hook（<workspace>/.anvil/hooks.json）：需显式信任（按内容指纹持久化）。
 * 返回是否已注册。未信任且无确认通道 / 用户拒绝 → 不注册、不执行。
 */
export async function loadProjectHooks(
  registry: HookRegistry,
  workspaceDir: string,
  log: ExternalHookLogger,
  opts: HookTrustOptions = {},
): Promise<boolean> {
  const file = path.join(workspaceDir, '.anvil', 'hooks.json');
  const data = readHookFile(file);
  if (!data) return false;
  const fp = fingerprint(file);
  if (!fp) return false;
  const tp = trustPath(opts.trustDir);
  const trust = loadTrust(tp);
  if (trust[workspaceDir] === fp) {
    registerHookFile(registry, data, file, log);
    return true;
  }
  if (!opts.confirmProject) {
    log('warn', `[hook] 项目级 hooks 未信任，已跳过（${file}）；确认后才会执行`);
    return false;
  }
  const ok = await opts.confirmProject(describeHookFile(data, file));
  if (!ok) {
    log('warn', `[hook] 项目级 hooks 未获信任，已跳过（${file}）`);
    return false;
  }
  trust[workspaceDir] = fp;
  saveTrust(tp, trust);
  registerHookFile(registry, data, file, log);
  log('warn', `[hook] 项目级 hooks 已信任并加载（${file}）`);
  return true;
}

/** 兼容入口：用户级（总是）+ 项目级（走信任门，无确认通道则仅加载已信任的）。 */
export async function loadExternalHooks(
  registry: HookRegistry,
  workspaceDir: string,
  log: ExternalHookLogger,
  opts: HookTrustOptions = {},
): Promise<void> {
  loadUserHooks(registry, log);
  await loadProjectHooks(registry, workspaceDir, log, opts);
}

// 修改记录：
//   2026-10-03 新增：从用户级/项目级 .anvil/hooks.json 加载命令型外部 hook，失败可控降级
//   2026-10-04 安全修复（P2-2）：项目级 hook 增加信任门（命令清单确认 + 内容指纹持久化），
//              未确认信任前不注册/不执行；拆出 loadUserHooks/loadProjectHooks
