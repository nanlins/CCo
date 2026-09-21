/**
 * 证据可信度 —— 报告中的 file:line 引用必须能追溯到工具返回结果。
 *
 * read_file(lineNumbers=true) 返回 `[source: <path>]` + `行号|内容`；
 * grep 返回 `<完整路径>:<行号>: 内容`；list_files 返回完整路径。
 * 本模块从这些工具结果里重建"已验证行号集合"，再扫描最终报告里的
 * `file:line` 引用，无法验证的引用标记为"未验证"（禁止当作硬证据）。
 */
import path from 'node:path';
import type { ContentBlock, Message } from '../types.js';

export interface EvidenceRef {
  /** 原始引用文本（如 server.js:9）。 */
  raw: string;
  /** 命中的文件名（basename，便于与工具结果比对）。 */
  file: string;
  /** 行号。 */
  line: number;
  verified: boolean;
}

export interface EvidenceValidation {
  refs: EvidenceRef[];
  verified: string[];
  unverified: string[];
}

/** 从工具结果里重建 (basename -> 已验证行号集合)。 */
function collectVerifiedLines(messages: Message[]): Map<string, Set<number>> {
  const verified = new Map<string, Set<number>>();
  const addLine = (filePath: string, line: number): void => {
    if (!Number.isInteger(line) || line <= 0) return;
    const base = path.basename(filePath);
    if (!verified.has(base)) verified.set(base, new Set<number>());
    verified.get(base)!.add(line);
  };

  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type !== 'tool_result') continue;
      const text = b.content;
      /* read_file(lineNumbers=true)：`[source: <path>]` 头 + 每行 `行号|内容` */
      const srcMatch = text.match(/\[source: ([^\]]+)\]/);
      if (srcMatch) {
        const src = srcMatch[1];
        for (const line of text.split('\n')) {
          const m2 = line.match(/^(\d+)\|/);
          if (m2) addLine(src, Number(m2[1]));
        }
      }
      /* grep：`<完整路径>:<行号>: 内容` */
      for (const line of text.split('\n')) {
        const m2 = line.match(/^(.+?):(\d+):\s/);
        if (m2 && (m2[1].includes('/') || m2[1].includes('\\') || m2[1].includes('.'))) {
          addLine(m2[1], Number(m2[2]));
        }
      }
    }
  }
  return verified;
}

/** 扫描报告中的 `file:line` 引用，并标注是否可由工具结果验证。 */
export function validateEvidence(report: string, messages: Message[]): EvidenceValidation {
  const verified = collectVerifiedLines(messages);
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  const rx = /([A-Za-z0-9_./\\-]+\.\w+):(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(report)) !== null) {
    const raw = `${m[1]}:${m[2]}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const base = path.basename(m[1]);
    const line = Number(m[2]);
    const ok = verified.get(base)?.has(line) ?? false;
    refs.push({ raw, file: base, line, verified: ok });
  }
  return {
    refs,
    verified: refs.filter((r) => r.verified).map((r) => r.raw),
    unverified: refs.filter((r) => !r.verified).map((r) => r.raw),
  };
}
