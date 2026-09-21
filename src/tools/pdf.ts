/**
 * PDF 解析工具 —— pdf_parsing（pdfjs-dist 文本提取）。
 *
 * 读取本地 PDF 文件，提取每页文本，供模型问答/总结/数据提取。
 * 安全：路径走 safePath 约束（只能读工作区内文件），输出上限防打满上下文。
 */
import './pdfPolyfill.js'; // 必须在 pdfjs 之前：提供 DOMMatrix/Path2D polyfill
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ToolContext, ToolDef } from '../types.js';
import { isInside } from '../core/permission.js';

const MAX_PDF_CHARS = 20_000;

/** 提取 PDF 文本：返回带页码标记的文本。 */
export async function parsePdf(workdir: string, filePath: string, maxPages?: number): Promise<string> {
  const resolved = path.resolve(workdir, filePath);
  if (!isInside(workdir, resolved)) {
    return `（路径超出工作区: ${filePath}）`;
  }
  if (!fs.existsSync(resolved)) return `（文件不存在: ${filePath}）`;
  if (!/\.pdf$/i.test(resolved)) return `（不是 PDF 文件: ${filePath}）`;

  const data = new Uint8Array(fs.readFileSync(resolved));
  const doc = await getDocument({
    data,
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
  }).promise;

  const limit = maxPages ?? doc.numPages;
  const parts: string[] = [];
  let total = 0;

  for (let p = 1; p <= Math.min(limit, doc.numPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => ('str' in it ? (it as { str: string }).str : '')).join(' ');
    const block = `--- 第 ${p} 页 ---\n${pageText.trim()}`;
    parts.push(block);
    total += block.length;
    if (total > MAX_PDF_CHARS) break;
  }

  await doc.cleanup();
  const text = parts.join('\n');
  if (!text.trim()) return `（未能从 ${filePath} 提取到文本，可能是扫描版 PDF）`;
  return text.length > MAX_PDF_CHARS ? text.slice(0, MAX_PDF_CHARS) + '\n...[内容过长已截断]' : text;
}

const pdfSchema = z.object({
  path: z.string().min(1, 'path 不能为空'),
  max_pages: z.number().int().positive().optional(),
});

export function pdfTool(): ToolDef {
  return {
    schema: {
      name: 'pdf_parsing',
      description: '读取并解析工作区内的 PDF 文件为文本（按页）。适合论文、财报、说明书的问答与总结。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'PDF 文件路径（相对工作区）' },
          max_pages: { type: 'integer', description: '最多解析页数（默认全部）' },
        },
        required: ['path'],
      },
    },
    validator: pdfSchema,
    executor: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const filePath = String(args.path ?? '');
      const maxPages = typeof args.max_pages === 'number' ? args.max_pages : undefined;
      try {
        return await parsePdf(ctx.workdir, filePath, maxPages);
      } catch (err) {
        return `PDF 解析失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    concurrencySafe: true,
  };
}
