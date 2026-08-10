/**
 * 权限管线 —— 比教学版更早、更重投入（安全第一）。
 *
 * 三道闸门（顺序固定）：
 *   G1 拒绝列表：命中即拒绝，不执行（bash 危险模式 / 路径逃逸）
 *   G2 规则匹配：只读工具放行；bash 用规则分类器（YOLO 占位）判断安全/危险
 *   G3 用户审批：危险操作按模式处理（ask → 询问；auto → 放行；deny → 拒绝）
 *
 * 升级路径（文档化）：把 G2 的规则分类器替换为 LLM 分类器
 * （classifier 选项），即真实 CC 的 yoloClassifier 模式。
 */
import path from 'node:path';
import type { PermissionMode, ToolContext } from '../types.js';
import { Sandbox } from './sandbox.js';
import { matchRules, toolNameKey, type PermissionRule, type PermissionSettings } from './permissionSettings.js';

export interface PermissionDecision {
  allow: boolean;
  reason: string;
  asked?: boolean;
}

export interface PermissionGateOptions {
  mode: PermissionMode;
  ask: (question: string) => Promise<boolean>;
  /** 可选 LLM 分类器：返回 'safe' 放行 / 'unsafe' 转审批 / 'skip' 走默认规则。 */
  classifier?: (toolName: string, args: Record<string, unknown>, workdir: string) => Promise<'safe' | 'unsafe' | 'skip'>;
  /** settings.json 多来源规则（G0 闸门）。 */
  settings?: PermissionSettings;
}

const READ_ONLY_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'list_files',
  'task_list', 'task_get', 'bg_check', 'cron_list',
  'team_list', 'memory_search', 'worktree_list', 'mcp_list',
  'web_search', 'web_extractor', 'pdf_parsing', 'search_docs', 'index_docs',
]);

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'apply_patch']);

const HARNESS_TOOLS = new Set([
  'TodoWrite', 'load_skill', 'spawn_subagent', 'task_create', 'task_update',
  'task_claim', 'task_complete', 'bg_run', 'cron_add', 'cron_remove',
  'memory_save', 'memory_forget', 'send_message', 'broadcast',
  'request_plan_approval', 'respond_plan', 'create_worktree', 'remove_worktree',
  'bind_task_worktree', 'connect_mcp', 'disconnect_mcp', 'compact',
]);

/** 只读安全命令（规则分类器白名单）。 */
const SAFE_READ_CMD =
  /^(git\s+(status|log|diff|show|branch|remote|config|help|--version|rev-parse|ls-files|stash\s+list)|ls\b|dir\b|cat\b|type\b|more\b|findstr\b|rg\b|grep\b|find\b|pwd\b|cd\b|echo\b|whoami\b|node\s+(-v|--version)|npm\s+(-v|--version)|git\s+status|Get-ChildItem\b|Get-Content\b|Select-String\b|Test-Path\b|Get-Item\b|Get-Command\b|Get-Location\b|Set-Location\b)/i;

const DANGEROUS_CMD =
  /(\brm\s|\bdel\s|\brd\s|\brmdir\b|\bmove\s|\bren\s|git\s+reset\s+--hard|git\s+push\s+(-f|--force)|git\s+checkout\s+-f|git\s+clean\s+-f|taskkill\b|\bkill\s|format\s|mkfs\b|shutdown\b|reboot\b)/i;

/** 只读白名单的补充黑名单：读命令管道到执行/下载/写盘 = 远程代码执行或数据外传，
    例如 `Get-Content x.ps1 | iex` 绝不能被 auto 模式自动放行。 */
const UNSAFE_READ_ADDON =
  /(iex\b|Invoke-Expression|Invoke-Command|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Start-Job|Start-BitsTransfer|New-Object\s+(System\.Net\.)?WebClient|DownloadString|DownloadFile|Out-File|Set-Content|Add-Content|Clear-Content|Remove-Item|Set-ExecutionPolicy|\bcurl\b|\bwget\b|net\s+user|reg\s+add|schtasks\b)/i;

export function isInside(workdir: string, p: string): boolean {
  const resolved = path.resolve(workdir, p);
  const rel = path.relative(workdir, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PermissionGate {
  private mode: PermissionMode;
  private askFn: (question: string) => Promise<boolean>;
  private classifier?: PermissionGateOptions['classifier'];
  private settings?: PermissionSettings;

  constructor(opts: PermissionGateOptions) {
    this.mode = opts.mode;
    this.askFn = opts.ask;
    this.classifier = opts.classifier;
    this.settings = opts.settings;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  async check(
    toolName: string,
    args: Record<string, unknown>,
    ctx: Pick<ToolContext, 'workdir'>,
  ): Promise<PermissionDecision> {
    /* ---- G0: settings.json 多来源规则（最高优先，hook allow 也不能绕过） ---- */
    if (this.settings) {
      const key = toolNameKey(toolName);
      if (this.settings.disabledTools.includes(key) || this.settings.disabledTools.includes(toolName)) {
        return { allow: false, reason: 'settings: tool disabled' };
      }
      const argText = JSON.stringify(args);
      const ruleHit = matchRules(this.settings.rules, key, argText) ?? matchRules(this.settings.rules, toolName, argText);
      if (ruleHit === 'deny') return { allow: false, reason: 'settings: denied by rule' };
      if (ruleHit === 'ask') return this.approve(`${toolName} ${argText.slice(0, 200)}`, 'settings: ask rule', true);
      const defaultBehavior = this.settings.defaults[key] ?? this.settings.defaults[toolName];
      if (defaultBehavior === 'deny') return { allow: false, reason: 'settings: tool denied' };
      if (defaultBehavior === 'allow') return { allow: true, reason: 'settings: tool allowed' };
    }

    /* ---- G1: 拒绝列表 ---- */
    if (toolName === 'bash') {
      const cmd = String(args.command ?? '');
      const blocked = Sandbox.blockedByDenyList(cmd);
      if (blocked) return { allow: false, reason: blocked };
    }
    const pathArg = typeof args.path === 'string' ? args.path : undefined;
    if (pathArg && WRITE_TOOLS.has(toolName) && !isInside(ctx.workdir, pathArg)) {
      return { allow: false, reason: `Path escapes workspace: ${pathArg}` };
    }

    /* ---- 只读工具：永远放行 ---- */
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { allow: true, reason: 'read-only tool' };
    }

    /* ---- Harness 工具（任务/团队/记忆等）：放行 ---- */
    if (HARNESS_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
      return { allow: true, reason: 'harness tool' };
    }

    /* ---- G2 + G3: bash 分类 ---- */
    if (toolName === 'bash') {
      const cmd = String(args.command ?? '');
      const verdict = this.classifier
        ? await this.classifier('bash', args, ctx.workdir)
        : 'skip';
      if (verdict === 'safe') return { allow: true, reason: 'classifier: safe' };
      if (verdict === 'unsafe') {
        return this.approve(`bash: ${cmd.slice(0, 200)}`, 'classifier: unsafe', true);
      }
      const safe = SAFE_READ_CMD.test(cmd) && !DANGEROUS_CMD.test(cmd) && !UNSAFE_READ_ADDON.test(cmd);
      if (safe) return { allow: true, reason: 'classifier: safe read command' };
      return this.approve(`bash: ${cmd.slice(0, 200)}`, 'potentially dangerous command');
    }

    /* ---- G2 + G3: 写工具 ---- */
    if (WRITE_TOOLS.has(toolName)) {
      const target = pathArg ?? String(args.path ?? '?');
      if (isInside(ctx.workdir, pathArg ?? '.')) {
        const verdict = this.classifier
          ? await this.classifier(toolName, args, ctx.workdir)
          : 'skip';
        if (verdict === 'unsafe') {
          return this.approve(`${toolName} ${target}`, 'classifier: unsafe', true);
        }
        if (this.mode === 'deny') return { allow: false, reason: 'deny mode: in-workspace write' };
        if (this.mode === 'ask') return this.approve(`${toolName} ${target}`, 'in-workspace write');
        return { allow: true, reason: 'in-workspace write (auto)' };
      }
      return this.approve(`${toolName} ${target}`, 'outside workspace');
    }

    return { allow: true, reason: 'unknown tool: default allow' };
  }

  private async approve(what: string, why: string, forceAsk = false): Promise<PermissionDecision> {
    if (this.mode === 'deny') return { allow: false, reason: `deny mode: ${why}` };
    /* classifier 判定 unsafe 时，即使 auto 模式也转人工审批（不可绕过） */
    if (this.mode === 'auto' && !forceAsk) return { allow: true, reason: `auto mode: ${why}` };
    const ok = await this.askFn(`Allow? ${what} (${why}) [y/N]`);
    return { allow: ok, reason: ok ? 'user approved' : 'user denied', asked: true };
  }
}