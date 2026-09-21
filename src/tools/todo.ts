/**
 * TodoWrite —— 没有计划的 Agent，做着做着就偏了（s05 模式）。
 * 结构化校验：content/status/activeForm 必填，最多 20 条，只允许一个 in_progress。
 * 状态存 session.todos，由 prompt.ts 渲染进 system prompt（每轮可见）。
 */
import type { ToolContext, TodoItem, ToolDef } from '../types.js';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export function renderTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return '（无待办）';
  const lines = todos.map((t) => {
    const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]';
    const suffix = t.status === 'in_progress' && t.activeForm ? ` <- ${t.activeForm}` : '';
    return `${mark} ${t.content}${suffix}`;
  });
  const done = todos.filter((t) => t.status === 'completed').length;
  return lines.join('\n') + `\n(${done}/${todos.length} completed)`;
}

export function todoTool(): ToolDef {
  return {
    schema: {
      name: 'TodoWrite',
      description: '维护当前任务的清单。每次调用都要写完整列表（所有条目）。',
      input_schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string' },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      },
    },
    executor: (args: Record<string, unknown>, ctx: ToolContext): string => {
      const raw = args.todos;
      if (!Array.isArray(raw)) return 'Error: todos must be an array';
      if (raw.length > 20) return 'Error: max 20 todos';
      const validated: TodoItem[] = [];
      let inProgress = 0;
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i] as Record<string, unknown>;
        const content = String(item.content ?? '').trim();
        const status = String(item.status ?? '').toLowerCase();
        const activeForm = String(item.activeForm ?? '').trim();
        if (!content) return `Error: item ${i}: content required`;
        if (!STATUSES.has(status)) return `Error: item ${i}: invalid status '${status}'`;
        if (!activeForm) return `Error: item ${i}: activeForm required`;
        if (status === 'in_progress') inProgress += 1;
        validated.push({ content, status: status as TodoItem['status'], activeForm });
      }
      if (inProgress > 1) return 'Error: only one in_progress allowed';
      ctx.session.todos = validated;
      return renderTodoList(validated);
    },
  };
}
