/**
 * System Prompt 组装 —— 运行时分段拼接（s10 模式）。
 *
 * 提示词缓存友好：稳定段（BASE / WORKDIR / MODE / TOOLS）在前，
 * 易变段（SKILLS / MEMORY / TODOS）在后；tools 的 schema 本体走
 * API 的 cache_control，这里只放一行目录。
 */
import type { TodoItem, ToolSchema } from '../types.js';

export interface PromptSections {
  base: string;
  workdir: string;
  mode: string;
  tools: ToolSchema[];
  skills?: string;
  memory?: string;
  todos?: TodoItem[];
  extra?: string[];
  /** 已配置的环境变量名（仅名字，不注入值）：引导模型使用配置而不是探测默认端口。 */
  envVars?: string[];
}

export function assembleSystemPrompt(s: PromptSections): string {
  const parts: string[] = [s.base, `Workspace: ${s.workdir}`, `Permission mode: ${s.mode}`, renderToolCatalog(s.tools)];
  if (s.skills) parts.push(s.skills);
  if (s.memory) parts.push(s.memory);
  const todos = renderTodos(s.todos ?? []);
  if (todos) parts.push(todos);
  if (s.envVars?.length) parts.push(renderEnvVars(s.envVars));
  if (s.extra?.length) parts.push(...s.extra);
  return parts.join('\n\n');
}

/**
 * 环境变量清单（仅注入名字，绝不注入值）：
 * 让模型知道连接串已通过环境配置，直接用变量读取，而不是硬编码或盲猜默认端口。
 */
export function renderEnvVars(names: string[]): string {
  return [
    '## Environment variables (names only; values are secrets)',
    ...names.map((n) => `- ${n}`),
    'Read values from the environment instead of hardcoding (PowerShell: $env:NAME; cmd: %NAME%).',
    'Never print secret values.',
    'When the above variables are configured, do NOT use glob / list_files / node -e readdirSync for broad filesystem scanning to "find" config files or connection strings — read the variable directly.',
    'Do not probe default ports (e.g. 5432/6379/8000). Use the configured variable above or ask the user.',
  ].join('\n');
}

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '';
  const lines = todos.map((t) => {
    const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]';
    return `${mark} ${t.content}`;
  });
  const done = todos.filter((t) => t.status === 'completed').length;
  return `## Todo\n${lines.join('\n')}\n(${done}/${todos.length} completed)`;
}

export function renderToolCatalog(tools: ToolSchema[]): string {
  if (tools.length === 0) return '## Tools\n(none)';
  return `## Tools\n${tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`;
}
