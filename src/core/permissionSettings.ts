/**
 * 权限规则来源 —— 对齐真实 CC 的多来源规则合并（s03 深入）。
 *
 * CC 的规则来自 8 个来源，本实现支持 5 个：
 *   1. user     ~/.claude/settings.json
 *   2. project  <workspace>/.claude/settings.json
 *   3. local    <workspace>/.claude/settings.local.json
 *   4. cliArg   CLI 参数（--allowedTools / --deniedTools）
 *   5. session  会话内临时授权
 * 优先级（低 → 高）：user < project < local < cliArg < session。
 *
 * 合并语义（修复 first-match-wins 缺陷）：
 *   先收集全部命中的规则，再按来源优先级取最高者；同一来源内 deny > ask > allow。
 *   因此低优先级 user allow 不能压过高优先级 project/local deny。
 *
 * 规则格式（对齐 CC）：
 *   { "toolName": "Bash", "ruleBehavior": "deny" | "allow", "ruleContent": "pattern" }
 *   toolName 为工具名（如 Bash / Write / Read），ruleContent 为命令/路径包含匹配。
 */

import fs from 'node:fs';
import path from 'node:path';

export type RuleBehavior = 'allow' | 'deny' | 'ask';

export type RuleSource = 'user' | 'project' | 'local' | 'cliArg' | 'session';

export interface PermissionRule {
  toolName: string;
  ruleBehavior: RuleBehavior;
  ruleContent: string;
  source: RuleSource;
}

export interface PermissionSettings {
  /** 工具级 allow/deny/ask 规则列表。 */
  rules: PermissionRule[];
  /** 工具级默认行为（如 "Bash": "allow"）。 */
  defaults: Record<string, RuleBehavior>;
  /** 额外：disabledTools（完全禁用）。 */
  disabledTools: string[];
}

/** 来源优先级（低 → 高）：user < project < local < cliArg < session。 */
export const SOURCE_PRIORITY: Record<RuleSource, number> = {
  user: 0,
  project: 1,
  local: 2,
  cliArg: 3,
  session: 4,
};

/** 同一来源内的行为强度：deny > ask > allow。 */
const BEHAVIOR_RANK: Record<RuleBehavior, number> = { deny: 2, ask: 1, allow: 0 };

export function loadPermissionSettings(
  workspaceDir: string,
  opts: {
    /** CLI 参数规则（--allowedTools / --deniedTools）。 */
    cliArgRules?: PermissionRule[];
    /** 会话内临时授权规则。 */
    sessionRules?: PermissionRule[];
  } = {},
): PermissionSettings {
  const sources: Array<{ source: PermissionRule['source']; file: string }> = [
    { source: 'user', file: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json') },
    { source: 'project', file: path.join(workspaceDir, '.claude', 'settings.json') },
    { source: 'local', file: path.join(workspaceDir, '.claude', 'settings.local.json') },
  ];

  const rules: PermissionRule[] = [];
  const defaults: Record<string, RuleBehavior> = {};
  const disabledTools = new Set<string>();

  /* 文件来源按低 → 高顺序加载，defaults 高优先级覆盖低优先级 */
  for (const { source, file } of sources) {
    const parsed = parseSettingsFile(file);
    if (!parsed) continue;
    for (const [toolName, behavior] of Object.entries(parsed.permissions ?? {})) {
      defaults[toolName] = behavior;
    }
    for (const tool of parsed.disabledTools ?? []) {
      disabledTools.add(tool);
    }
    for (const [toolName, content] of Object.entries(parsed.denyRules ?? {})) {
      for (const c of Array.isArray(content) ? content : [content]) {
        rules.push({ toolName, ruleBehavior: 'deny', ruleContent: String(c), source });
      }
    }
    for (const [toolName, content] of Object.entries(parsed.askRules ?? {})) {
      for (const c of Array.isArray(content) ? content : [content]) {
        rules.push({ toolName, ruleBehavior: 'ask', ruleContent: String(c), source });
      }
    }
    for (const [toolName, content] of Object.entries(parsed.allowRules ?? {})) {
      for (const c of Array.isArray(content) ? content : [content]) {
        rules.push({ toolName, ruleBehavior: 'allow', ruleContent: String(c), source });
      }
    }
  }

  /* CLI 参数规则（优先级高于文件来源；内容级 deny 只按规则匹配，不再整工具禁用） */
  for (const r of opts.cliArgRules ?? []) {
    rules.push(r);
  }

  /* 会话内临时授权（最高优先级） */
  for (const r of opts.sessionRules ?? []) {
    rules.push(r);
  }

  return { rules, defaults, disabledTools: [...disabledTools] };
}

function parseSettingsFile(file: string): {
  permissions?: Record<string, RuleBehavior>;
  disabledTools?: string[];
  denyRules?: Record<string, string | string[]>;
  askRules?: Record<string, string | string[]>;
  allowRules?: Record<string, string | string[]>;
} | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      permissions: raw.permissions as Record<string, RuleBehavior> | undefined,
      disabledTools: Array.isArray(raw.disabledTools) ? raw.disabledTools.map(String) : undefined,
      denyRules: raw.denyRules as Record<string, string | string[]> | undefined,
      askRules: raw.askRules as Record<string, string | string[]> | undefined,
      allowRules: raw.allowRules as Record<string, string | string[]> | undefined,
    };
  } catch {
    return null; // 损坏忽略
  }
}

/**
 * 检查规则列表：收集全部命中规则后按来源优先级合并（user < project < local < cliArg < session），
 * 同一来源内 deny > ask > allow。返回合并后的行为或 null（无命中）。
 */
export function matchRules(rules: PermissionRule[], toolName: string, argText: string): RuleBehavior | null {
  let best: PermissionRule | null = null;
  for (const r of rules) {
    if (r.toolName !== toolName) continue;
    if (!argText.includes(r.ruleContent)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const pNew = SOURCE_PRIORITY[r.source] ?? 0;
    const pBest = SOURCE_PRIORITY[best.source] ?? 0;
    if (pNew > pBest || (pNew === pBest && BEHAVIOR_RANK[r.ruleBehavior] > BEHAVIOR_RANK[best.ruleBehavior])) {
      best = r;
    }
  }
  return best ? best.ruleBehavior : null;
}

/** 工具名的宽松匹配（CC 的规则用工具显示名，如 Bash/Write/Read）。 */
export function toolNameKey(toolName: string): string {
  const map: Record<string, string> = {
    bash: 'Bash',
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    delete_file: 'Delete',
    glob: 'Glob',
    grep: 'Grep',
    bg_run: 'Bash',
  };
  return map[toolName] ?? toolName;
}

/**
 * 配置来源校验（ConfigWatcher 重载前调用）：
 * 返回损坏/无法解析的 settings 文件列表。损坏文件不得静默生效——
 * loadPermissionSettings 会跳过它们，这里显式报告以便告警（可能是半写入/篡改）。
 */
export function validateSettingsSources(workspaceDir: string): { corrupt: string[] } {
  const files = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json'),
    path.join(workspaceDir, '.claude', 'settings.json'),
    path.join(workspaceDir, '.claude', 'settings.local.json'),
  ];
  const corrupt: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!raw || typeof raw !== 'object') corrupt.push(f);
    } catch {
      corrupt.push(f);
    }
  }
  return { corrupt };
}
