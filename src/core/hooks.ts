/**
 * Hook 系统 —— 挂在循环上，不写进循环里（s04 模式）。
 *
 * 事件（教学版从 4 个扩充到 16 个，覆盖真实 CC 核心事件中的高频子集）：
 *   工具相关：PreToolUse / PostToolUse / PostToolUseFailure
 *   会话相关：SessionStart / SessionEnd / Stop / StopFailure / Setup
 *   用户交互：UserPromptSubmit / Notification / PermissionRequest / PermissionDenied
 *   子 Agent：SubagentStart / SubagentStop
 *   压缩相关：PreCompact / PostCompact
 *
 * 注：真实 Claude Code 的核心事件多于 16 个，本教学版只实现上述子集，
 *     未实现的事件不会虚假注册。
 *
 * HookResult（对齐 CC 的常用字段）：
 *   block / message / forceContinue / modifiedInput /
 *   updatedInput（修改工具参数）/ blockingError（注入让模型自纠）/
 *   additionalContext（附加上下文）/ permissionBehavior（hook 返回权限决策）
 */
export type HookEvent =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'Setup'
  | 'Notification'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact';

export interface PreToolUsePayload {
  toolName: string;
  args: Record<string, unknown>;
  workdir: string;
}

export interface PostToolUsePayload extends PreToolUsePayload {
  output: string;
  error?: string;
}

export interface HookResult {
  block?: boolean;
  message?: string;
  forceContinue?: boolean;
  modifiedInput?: string;
  /** 修改工具参数（PreToolUse 返回时覆盖本次调用的输入）。 */
  updatedInput?: Record<string, unknown>;
  /** 阻塞错误：注入对话让模型自纠（Stop hook 场景）。 */
  blockingError?: string;
  /** 附加上下文（注入 user 消息）。 */
  additionalContext?: string;
  /** hook 直接返回权限决策（allow/deny/ask）。 */
  permissionBehavior?: 'allow' | 'deny' | 'ask';
}

export type HookCallback = (
  payload:
    | PreToolUsePayload
    | PostToolUsePayload
    | { input: string }
    | { messagesCount: number }
    | { sessionId: string }
    | Record<string, unknown>,
) => HookResult | void | Promise<HookResult | void>;

export class HookRegistry {
  private hooks = new Map<HookEvent, HookCallback[]>();

  register(event: HookEvent, callback: HookCallback): void {
    const list = this.hooks.get(event) ?? [];
    list.push(callback);
    this.hooks.set(event, list);
  }

  list(event: HookEvent): HookCallback[] {
    return this.hooks.get(event) ?? [];
  }

  /**
   * 触发事件的全部 hook（同事件多 hook 全部执行并合并，不再"首个非空即返回"）：
   * 任一 hook 判定 blocking/deny 则最终 blocking；permissionBehavior 取最严格；
   * 其余字段合并（消息类拼接去重，updatedInput 浅合并）。全空 → undefined（单 hook 行为不变）。
   */
  async trigger(event: HookEvent, payload: unknown): Promise<HookResult | undefined> {
    const list = this.hooks.get(event) ?? [];
    if (list.length === 0) return undefined;
    const results: HookResult[] = [];
    for (const cb of list) {
      const result = await cb(payload as never);
      if (result !== undefined && result !== null) results.push(result);
    }
    if (results.length === 0) return undefined;
    if (results.length === 1) return results[0];
    return mergeHookResults(results);
  }

  /** 汇总所有事件（供 UI/审计展示已注册的 hook）。 */
  registeredEvents(): HookEvent[] {
    return [...this.hooks.keys()];
  }
}

/** permissionBehavior 严格度：deny > ask > allow > 未设置。 */
function permissionRank(b?: HookResult['permissionBehavior']): number {
  return b === 'deny' ? 3 : b === 'ask' ? 2 : b === 'allow' ? 1 : 0;
}

/** 多 hook 结果合并（导出以便单测）：block/forceContinue 任一为真；决策取最严格。 */
export function mergeHookResults(results: HookResult[]): HookResult {
  const mergeText = (a: string | undefined, b: string | undefined): string | undefined => {
    if (!a) return b;
    if (!b) return a;
    return a.includes(b) ? a : `${a}\n${b}`;
  };
  const merged: HookResult = {};
  for (const r of results) {
    if (r.block) merged.block = true;
    if (r.forceContinue) merged.forceContinue = true;
    if (permissionRank(r.permissionBehavior) > permissionRank(merged.permissionBehavior)) {
      merged.permissionBehavior = r.permissionBehavior;
    }
    merged.message = mergeText(merged.message, r.message);
    merged.blockingError = mergeText(merged.blockingError, r.blockingError);
    merged.additionalContext = mergeText(merged.additionalContext, r.additionalContext);
    if (r.modifiedInput !== undefined) merged.modifiedInput = r.modifiedInput;
    if (r.updatedInput) merged.updatedInput = { ...merged.updatedInput, ...r.updatedInput };
  }
  return merged;
}
