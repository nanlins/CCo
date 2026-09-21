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
}

export function assembleSystemPrompt(s: PromptSections): string {
  const parts: string[] = [s.base, `Workspace: ${s.workdir}`, `Permission mode: ${s.mode}`, renderToolCatalog(s.tools)];
  if (s.skills) parts.push(s.skills);
  if (s.memory) parts.push(s.memory);
  const todos = renderTodos(s.todos ?? []);
  if (todos) parts.push(todos);
  if (s.extra?.length) parts.push(...s.extra);
  return parts.join('\n\n');
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
