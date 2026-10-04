/**
 * 项目指令文件发现与加载。
 *
 * 职责：在工作区根目录及其父目录逐级查找 ANVIL.md / CLAUDE.md / AGENTS.md，
 *       读取内容供拼入 system prompt；找不到任何文件时返回空，绝不抛错。
 *
 * 承重不变量：
 *   - 读不到文件（不存在/权限/损坏）一律忽略并返回空，绝不让项目指令缺失拖垮启动；
 *   - 边界受控：最大深度（默认 5 层或到 git 根）、单文件大小上限、总长度上限，
 *     超限截断并在 files 标注"已截断"，绝不无限膨胀 system prompt。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 支持的指令文件名（按优先级降序）。AGENTS.md 为 opencode 约定，一并支持。 */
const INSTRUCTION_FILES = ['ANVIL.md', 'CLAUDE.md', 'AGENTS.md'] as const;

/** 边界默认值。 */
export const MAX_DEPTH = 5;
export const MAX_FILE_BYTES = 32 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024;

export interface ProjectInstructions {
  /** 拼接后的指令正文（已空行分隔、可整体拼入 system prompt）。 */
  text: string;
  /** 实际命中的文件绝对路径（被截断的追加 "（已截断）"）。 */
  files: string[];
  /** 是否有任何文件因大小/总长限制被截断或跳过。 */
  truncated: boolean;
}

export interface LoadInstructionsOptions {
  maxDepth?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export function loadProjectInstructions(workspaceDir: string, opts: LoadInstructionsOptions = {}): ProjectInstructions {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxFile = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;

  const files: string[] = [];
  const chunks: string[] = [];
  let total = 0;
  let truncated = false;
  let dir = path.resolve(workspaceDir);
  let depth = 0;

  while (depth <= maxDepth) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      if (files.includes(file)) continue;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (stat.size > maxFile) {
          truncated = true;
          files.push(`${file}（已截断）`);
          chunks.push(`<!-- 项目指令 ${name} 超单文件上限 ${maxFile}B，已跳过 -->`);
          continue;
        }
        let text = fs.readFileSync(file, 'utf-8').trim();
        if (!text) continue;
        if (total + text.length > maxTotal) {
          text = text.slice(0, Math.max(0, maxTotal - total)) + '\n…（已截断）';
          truncated = true;
        }
        total += text.length;
        files.push(truncated && total >= maxTotal ? `${file}（已截断）` : file);
        chunks.push(`<!-- 项目指令 ${name}: ${file} -->\n${text}`);
        if (total >= maxTotal) break;
      } catch {
        /* 文件不存在或不可读：忽略 */
      }
    }
    if (total >= maxTotal) break;
    /* 到 git 根即停止（项目边界） */
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }

  return { text: chunks.join('\n\n'), files, truncated };
}

// 修改记录：
//   2026-10-03 新增：项目指令文件（ANVIL.md/CLAUDE.md/AGENTS.md）自工作区向上逐级发现与加载
//   2026-10-03 加边界：最大深度（5 层/git 根）、单文件 32KB、总长 64KB，超限截断标注
