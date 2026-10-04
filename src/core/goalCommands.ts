/**
 * /goal —— 结构化完成判据（verifier）的显式登记入口。
 *
 * 职责：把"目标完成"的判据写入 session.verifiers，供 Stop 闸门（evaluateGoal）
 * 独立验证（文件存在 / 文件包含文本 / 命令退出码 0），而不是依赖模型自称完成。
 *
 * 关键导出：handleGoalCommand（纯函数 + session 变更，返回给 REPL 的文本）。
 * 承重不变量：不执行任何命令、不读文件；只登记判据，验证发生在 Stop 钩子。
 */
import type { Session } from '../types.js';

export const GOAL_USAGE = [
  '用法:',
  '  /goal                              查看当前验证器',
  '  /goal clear                        清空验证器与命令记录',
  '  /goal file <path>                  要求文件存在（相对工作区）',
  '  /goal contains <path> <text>       要求文件包含指定文本',
  '  /goal command <shell command>      要求该命令最近一次退出码为 0',
].join('\n');

function describe(session: Session): string {
  const verifiers = session.verifiers ?? [];
  if (verifiers.length === 0) return '（无验证器；Stop 闸门仅按 Todo 清空判定）';
  return verifiers
    .map((v, i) => {
      if (v.kind === 'fileExists') return `${i + 1}. file_exists: ${v.path}`;
      if (v.kind === 'fileContains') return `${i + 1}. file_contains: ${v.path} ⊇ "${v.text}"`;
      return `${i + 1}. command_exit0: ${v.command}`;
    })
    .join('\n');
}

export function handleGoalCommand(session: Session, args: string[]): string {
  const sub = (args[0] ?? 'list').toLowerCase();
  session.verifiers ??= [];

  if (sub === 'list') return describe(session);

  if (sub === 'clear') {
    session.verifiers = [];
    session.commandResults = [];
    return '已清空验证器与命令记录（Stop 闸门仅按 Todo 清空判定）。';
  }

  if (sub === 'file') {
    const p = args[1];
    if (!p) return GOAL_USAGE;
    session.verifiers.push({ kind: 'fileExists', path: p });
    return `已登记验证器: file_exists ${p}\n${describe(session)}`;
  }

  if (sub === 'contains') {
    const p = args[1];
    const text = args.slice(2).join(' ');
    if (!p || !text) return GOAL_USAGE;
    session.verifiers.push({ kind: 'fileContains', path: p, text });
    return `已登记验证器: file_contains ${p} ⊇ "${text}"\n${describe(session)}`;
  }

  if (sub === 'command') {
    const cmd = args.slice(1).join(' ');
    if (!cmd) return GOAL_USAGE;
    session.verifiers.push({ kind: 'commandExit0', command: cmd });
    return `已登记验证器: command_exit0 ${cmd}\n${describe(session)}`;
  }

  return GOAL_USAGE;
}

// 修改记录：
//   2026-10-04 新增：/goal 显式登记 fileExists/fileContains/commandExit0 验证器（P1-2）
