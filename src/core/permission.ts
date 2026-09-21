/**
 * 权限管线 —— 比教学版更早、更重投入（安全第一）。
 *
 * 四道闸门（顺序固定）：
 *   G0 settings.json 多来源规则（user < project < local < cli < session 合并后判断）
 *   G1 拒绝列表：命中即拒绝，不执行（bash/bg_run 危险模式 / 路径逃逸）
 *   G2 规则匹配：只读工具放行；bash 与 bg_run 共用同一命令分类器
 *   G3 用户审批：按模式处理
 *
 * 模式语义（PermissionMode）：
 *   ask    —— 非明确 safe 一律询问；
 *   auto   —— 只有"明确 safe 分类"自动放行（只读白名单命令 / 工作区内写入 /
 *             classifier 判 safe）；未知或危险命令一律转人工审批，绝不自动放行；
 *   deny   —— 拒绝一切需审批操作；
 *   bypass —— 显式的"全放行"模式（承接旧 auto 的放行语义，风险见 types.ts 注释）。
 *
 * 升级路径（文档化）：把 G2 的规则分类器替换为 LLM 分类器
 * （classifier 选项），即真实 CC 的 yoloClassifier 模式。
 */
import path from 'node:path';
import type { PermissionMode, ToolContext } from '../types.js';
import { Sandbox } from './sandbox.js';
import { matchRules, toolNameKey, type PermissionSettings } from './permissionSettings.js';
import { classifyShellCommand, segmentBinaries } from './commandClassifier.js';
import { isProtectedWritePath, isSecretReadPath, protectedReason } from './protectedPaths.js';

export interface PermissionDecision {
  allow: boolean;
  reason: string;
  asked?: boolean;
}

export interface PermissionGateOptions {
  mode: PermissionMode;
  ask: (question: string) => Promise<boolean>;
  /**
   * 富审批通道：返回用户原始答复（'y'/'a'/'n'…），用于 shell 命令的批量授权
   * （a = 允许本次任务中的同类命令）。未提供时退化为 ask 布尔通道。
   */
  askChoice?: (question: string) => Promise<string>;
  /** 可选 LLM 分类器：返回 'safe' 放行 / 'unsafe' 转审批 / 'skip' 走默认规则。 */
  classifier?: (
    toolName: string,
    args: Record<string, unknown>,
    workdir: string,
  ) => Promise<'safe' | 'unsafe' | 'skip'>;
  /** settings.json 多来源规则（G0 闸门）。 */
  settings?: PermissionSettings;
}

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_files',
  'task_list',
  'task_get',
  'bg_check',
  'cron_list',
  'team_list',
  'memory_search',
  'worktree_list',
  'mcp_list',
  'web_search',
  'web_extractor',
  'pdf_parsing',
  'search_docs',
  'index_docs',
  'rd_inbox',
  'teammate_status',
  'rerank_passages',
]);

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'apply_patch']);

/** 执行 shell 命令的工具：全部走同一套 deny list + 分类 + 审批管线（bg_run 不得绕过）。 */
const SHELL_TOOLS = new Set(['bash', 'bg_run']);

const HARNESS_TOOLS = new Set([
  'TodoWrite',
  'load_skill',
  'spawn_subagent',
  'spawn_teammate',
  'task_create',
  'task_update',
  'task_claim',
  'task_complete',
  'cron_add',
  'cron_remove',
  'memory_save',
  'memory_forget',
  'send_message',
  'broadcast',
  'send_plan_request',
  'request_plan_approval',
  'respond_plan',
  'respond_permission',
  'self_review',
  'create_worktree',
  'remove_worktree',
  'bind_task_worktree',
  'disconnect_mcp',
  'compact',
]);

/** 需要路径参数做受保护路径检查的读工具。 */
const PATH_READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_files']);

export function isInside(workdir: string, p: string): boolean {
  const resolved = path.resolve(workdir, p);
  const rel = path.relative(workdir, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PermissionGate {
  private mode: PermissionMode;
  private askFn: (question: string) => Promise<boolean>;
  private askChoiceFn?: (question: string) => Promise<string>;
  private classifier?: PermissionGateOptions['classifier'];
  private settings?: PermissionSettings;
  /** 本次任务批量授权的命令名（"允许本次任务中的类似命令"）。 */
  private sessionAllowedBinaries = new Set<string>();
  /** 本任务的审批次数（提示里展示，便于用户感知并选择批量授权）。 */
  private askCount = 0;

  constructor(opts: PermissionGateOptions) {
    this.mode = opts.mode;
    this.askFn = opts.ask;
    this.askChoiceFn = opts.askChoice;
    this.classifier = opts.classifier;
    this.settings = opts.settings;
  }

  /** 清空任务级批量授权（agent 每次 run 开始时调用，授权仅对本任务有效）。 */
  clearSessionApprovals(): void {
    this.sessionAllowedBinaries.clear();
    this.askCount = 0;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** 热更新 settings 规则（ConfigWatcher 监听到 settings.json 变化时调用）。 */
  setSettings(settings: PermissionSettings | undefined): void {
    this.settings = settings;
  }

  async check(
    toolName: string,
    args: Record<string, unknown>,
    ctx: Pick<ToolContext, 'workdir'>,
  ): Promise<PermissionDecision> {
    /* ---- G1a: 无条件安全层（任何 settings 规则都不得绕过） ----
       1) 命令 deny list；2) 受保护路径（权限/信任/密钥状态）写禁 + 密钥读禁 */
    if (SHELL_TOOLS.has(toolName)) {
      const cmd = String(args.command ?? '');
      const blocked = Sandbox.blockedByDenyList(cmd);
      if (blocked) return { allow: false, reason: blocked };
    }
    const pathArg = typeof args.path === 'string' ? args.path : undefined;
    if (pathArg && WRITE_TOOLS.has(toolName) && isProtectedWritePath(ctx.workdir, pathArg)) {
      return { allow: false, reason: protectedReason(pathArg) };
    }
    if (pathArg && PATH_READ_TOOLS.has(toolName) && isSecretReadPath(ctx.workdir, pathArg)) {
      return { allow: false, reason: `禁止读取密钥文件: ${pathArg}` };
    }

    /* ---- G0: settings.json 多来源规则（user < project < local < CLI < session 合并） ---- */
    if (this.settings) {
      const key = toolNameKey(toolName);
      if (this.settings.disabledTools.includes(key) || this.settings.disabledTools.includes(toolName)) {
        return { allow: false, reason: 'settings: tool disabled' };
      }
      const argText = JSON.stringify(args);
      const ruleHit =
        matchRules(this.settings.rules, key, argText) ?? matchRules(this.settings.rules, toolName, argText);
      if (ruleHit === 'deny') return { allow: false, reason: 'settings: denied by rule' };
      if (ruleHit === 'ask') return this.approve(`${toolName} ${argText.slice(0, 200)}`, 'settings: ask rule', true);
      /* allow 规则：显式放行（deny list 已在 G1a 先行拦截，不会被绕过） */
      if (ruleHit === 'allow') return { allow: true, reason: 'settings: allowed by rule' };
      const defaultBehavior = this.settings.defaults[key] ?? this.settings.defaults[toolName];
      if (defaultBehavior === 'deny') return { allow: false, reason: 'settings: tool denied' };
      if (defaultBehavior === 'allow') return { allow: true, reason: 'settings: tool allowed' };
    }

    /* ---- G1b: 写路径逃逸（词法层；realpath 层在 fs 执行器内兜底） ---- */
    if (pathArg && WRITE_TOOLS.has(toolName) && !isInside(ctx.workdir, pathArg)) {
      return { allow: false, reason: `Path escapes workspace: ${pathArg}` };
    }

    /* ---- 只读工具：永远放行 ---- */
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { allow: true, reason: 'read-only tool' };
    }

    /* ---- MCP 连接：deny 模式直接拒绝；其他模式由执行器内的信任门
           （展示命令 + 用户确认 + 信任持久化）把关，未确认不得启动子进程 ---- */
    if (toolName === 'connect_mcp') {
      if (this.mode === 'deny') return { allow: false, reason: 'deny mode: connect_mcp' };
      return { allow: true, reason: 'mcp trust gate enforced in executor' };
    }

    /* ---- Harness 工具（任务/团队/记忆等）：放行 ---- */
    if (HARNESS_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
      return { allow: true, reason: 'harness tool' };
    }

    /* ---- G2 + G3: bash / bg_run 完整命令分类（同一管线，禁止只看第一个 token） ---- */
    if (SHELL_TOOLS.has(toolName)) {
      const cmd = String(args.command ?? '');
      const verdict = this.classifier ? await this.classifier(toolName, args, ctx.workdir) : 'skip';
      if (verdict === 'safe') return { allow: true, reason: 'classifier: safe' };
      if (verdict === 'unsafe') {
        return this.approve(`${toolName}: ${cmd.slice(0, 200)}`, 'classifier: unsafe', true);
      }
      /* 静态完整命令分类：管道/链接/重定向/子 shell/敏感文件全部参与判断 */
      const cls = classifyShellCommand(cmd, ctx.workdir);
      if (cls.verdict === 'deny') return { allow: false, reason: cls.reason };
      if (cls.verdict === 'safe') return { allow: true, reason: 'classifier: safe read command' };
      /* 批量授权：命令所有段首命令都已被本任务授权 → 放行（不再重复询问同类命令） */
      const bins = segmentBinaries(cmd);
      if (bins.length > 0 && bins.every((b) => this.sessionAllowedBinaries.has(b))) {
        return { allow: true, reason: 'session batch approval (similar commands)' };
      }
      /* 非只读/无法静态验证：人工审批，提示含风险等级 + 批量授权选项 */
      return this.approveShell(toolName, cmd, cls.reason || 'non-read-only command');
    }

    /* ---- G2 + G3: 写工具 ---- */
    if (WRITE_TOOLS.has(toolName)) {
      const target = pathArg ?? String(args.path ?? '?');
      if (isInside(ctx.workdir, pathArg ?? '.')) {
        const verdict = this.classifier ? await this.classifier(toolName, args, ctx.workdir) : 'skip';
        if (verdict === 'unsafe') {
          return this.approve(`${toolName} ${target}`, 'classifier: unsafe', true);
        }
        if (this.mode === 'deny') return { allow: false, reason: 'deny mode: in-workspace write' };
        if (this.mode === 'ask') return this.approve(`${toolName} ${target}`, 'in-workspace write');
        /* auto / bypass：工作区内写入属于明确 safe 分类 */
        return { allow: true, reason: 'in-workspace write (auto)' };
      }
      return this.approve(`${toolName} ${target}`, 'outside workspace', true);
    }

    /* 未知工具默认 deny：仅显式注册（并在上述各集合中明确归类）或显式 allowlist 的工具可通过 */
    return { allow: false, reason: `unknown tool: ${toolName} not in any allow list (default deny)` };
  }

  private async approve(what: string, why: string, forceAsk = false): Promise<PermissionDecision> {
    if (this.mode === 'deny') return { allow: false, reason: `deny mode: ${why}` };
    /* bypass：显式全放行模式（旧 auto 语义），风险由使用者承担 */
    if (this.mode === 'bypass') return { allow: true, reason: `bypass mode: ${why}` };
    /* auto：仅未强制审批（forceAsk=false）的明确 safe 项可自动放行 */
    if (this.mode === 'auto' && !forceAsk) return { allow: true, reason: `auto mode: ${why}` };
    const ok = await this.askFn(`Allow? ${what} (${why}) [y/N]`);
    return { allow: ok, reason: ok ? 'user approved' : 'user denied', asked: true };
  }

  /**
   * shell 命令审批：提示含风险原因 + 本任务审批次数 + 批量授权选项。
   * 答复 y=本次允许；a=允许本任务中的同类命令（按段首命令名）；其余=拒绝。
   */
  private async approveShell(toolName: string, cmd: string, why: string): Promise<PermissionDecision> {
    if (this.mode === 'deny') return { allow: false, reason: `deny mode: ${why}` };
    if (this.mode === 'bypass') return { allow: true, reason: `bypass mode: ${why}` };
    this.askCount += 1;
    const bins = segmentBinaries(cmd);
    const batchOption = bins.length > 0 ? ` a=允许本任务同类命令(${bins.join('/')})` : '';
    const question = `Allow? ${toolName}: ${cmd.slice(0, 200)}\n  [风险: ${why} | 本任务第 ${this.askCount} 次审批 | y=本次允许${batchOption} n=拒绝]`;
    if (this.askChoiceFn) {
      const answer = (await this.askChoiceFn(question)).trim().toLowerCase();
      if (answer.startsWith('a')) {
        for (const b of bins) this.sessionAllowedBinaries.add(b);
        return { allow: true, reason: 'user batch-approved (similar commands this task)', asked: true };
      }
      if (answer.startsWith('y')) return { allow: true, reason: 'user approved', asked: true };
      return { allow: false, reason: 'user denied', asked: true };
    }
    const ok = await this.askFn(question);
    return { allow: ok, reason: ok ? 'user approved' : 'user denied', asked: true };
  }
}
