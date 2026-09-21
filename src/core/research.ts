/**
 * 只读研究任务支撑 —— 交付检查表、阅读策略、必答问题提取与任务识别。
 *
 * 研究类任务（"阅读…回答其原理/架构/运行逻辑/知识技能"）与写代码类任务不同：
 *   - 只读为主：禁止 bash 探索、禁止写文件；
 *   - 有"必答问题清单"，最终报告必须逐项核对，未完成必须标"未完成"；
 *   - 阅读有承重文件优先级，先读少量再按证据展开。
 */
export interface ResearchProfile {
  /** 必答问题清单（交付检查表）。 */
  questions: string[];
  /** 承重文件阅读优先级。 */
  readingPriority: string[];
}

/** 研究任务承重文件阅读优先级（先读少量承重文件，再按证据展开）。 */
export const RESEARCH_READING_PRIORITY = [
  'architecture.md',
  'index.ts',
  'router.ts',
  'session-manager.ts',
  'delivery.ts',
  'container-runner.ts',
  'poll-loop.ts',
  'providers/claude.ts',
  'db schema',
];

/** 低价值循环：同一路径/对象被反复诊断的容忍上限。 */
export const PATH_REPEAT_LIMIT = 3;

/** 提取工具调用所指向的"路径/对象"指纹（用于低价值循环检测）。 */
export function pathFingerprint(name: string, args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const a = args as Record<string, unknown>;
  /* read_file / glob / grep / list_files 等：以路径（或路径+pattern）为指纹 */
  const p = a.file_path ?? a.path ?? a.directory ?? a.filePath;
  if (typeof p === 'string' && p.trim()) {
    const pat = typeof a.pattern === 'string' ? a.pattern : '';
    return `${name}:${p}${pat ? ':' + pat : ''}`;
  }
  return null;
}

/** 研究关键词（识别"只读研究"意图）。 */
const RESEARCH_RX = /阅读|分析|回答|说明|介绍|阐述|讲解|原理|架构|运行逻辑|底层|知识|技能|梳理|解读|总结|理解|survey|research|analy|read\s/i;

/** 写代码/文件意图（识别"要动手改/写"的任务，这类不是研究）。 */
const WRITE_INTENT_RX = /(创建|新建|生成|写一个|实现一个|修改|编辑|修复|重构|添加一个|搭建一个|build|create|implement|fix|write\s+me)/i;

/** 判定输入是否为只读研究任务（含研究意图且无写代码意图）。 */
export function isResearchTask(input: string): boolean {
  return RESEARCH_RX.test(input) && !WRITE_INTENT_RX.test(input);
}

/**
 * 从用户输入中提取必答问题清单（交付检查表）。
 * 支持：问号切分、"回答/说明…其/以下 + 顿号列表"、"并说明/并回答 + 追加问题"、编号列表。
 */
export function extractQuestions(input: string): string[] {
  const questions: string[] = [];
  const text = input.replace(/\r?\n/g, ' ').trim();
  const push = (q: string): void => {
    const t = q.trim();
    if (t.length >= 2 && !questions.includes(t)) questions.push(t);
  };

  /* 1) 问号直接切分：每个问号前最近一句是问题 */
  const qParts = text.split(/[?？]/);
  for (let i = 0; i < qParts.length - 1; i++) {
    const seg = qParts[i].split(/[。；;]/).pop();
    if (seg) push(seg);
  }

  /* 2) "回答/说明/阐述/介绍/分析 + 其/以下/如下 + 顿号列表" */
  const listRe = /(?:回答|说明|阐述|介绍|分析)\s*(?:其|以下|如下)?\s*[：:]?\s*([^。；;]+)/;
  const lm = text.match(listRe);
  if (lm) {
    /* 列表主题在"并/还/同时/另外"引导的追加问题之前 */
    const main = lm[1].split(/[，,]\s*(?=并|还|同时|另外)/)[0];
    for (const t of main.split(/[、，,]/)) push(t);
  }

  /* 3) "并/还/同时/另外 + 说明/回答/..." 追加问题 */
  const extraRe = /(?:并|还|同时|另外)\s*(?:说明|回答|阐述|介绍|分析)\s*([^。；;]+)/;
  const em = text.match(extraRe);
  if (em) push(em[1]);

  /* 4) 编号列表（1. 2. 3. 或 1、2、3、） */
  const numRe = /(?:^|[；;。\n])\s*(\d+)[.、)）]\s*([^；;。\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(text)) !== null) push(m[2]);

  return questions;
}

/** 构建研究任务的 system prompt 附加段（交付检查表 + 阅读策略 + 只读约束）。 */
export function buildResearchPrompt(profile: ResearchProfile): string {
  const checklist = profile.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const priority = profile.readingPriority.join(' → ');
  return [
    '## 任务性质：只读研究（交付检查表驱动）',
    '- 禁止使用 bash 探索目录、探测中文路径、验证编码或生成临时 PowerShell/脚本文件；',
    '  目录探索一律用 list_files / glob，路径以用户提供或已确认的路径为准。',
    '- 默认禁用子代理（spawn_subagent）。确需拆分时，每个子代理必须带明确输出 schema、',
    '  独立 token 上限与必答问题编号，并返回可合并的片段。',
    `- 阅读策略：先读少量承重文件再按证据展开，不得先大规模扫描。优先级（文件不存在则跳过）：${priority}。`,
    '- 必答问题（交付检查表，逐项完成并持续更新）：',
    checklist,
    '- 最终报告必须包含"交付检查表"，逐项标注：完成/未完成、证据文件（file:line）、token 用量、未完成原因。',
    '  未完成的问题必须明确标"未完成"，不得伪装成完整结果；预算耗尽时只报告已确认证据。',
  ].join('\n');
}
