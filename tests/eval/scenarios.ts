/**
 * Agent 评估场景 —— 定义任务、期望结果检查器与指标采集。
 *
 * 每个场景包含：
 *   id/prompt      —— 任务本身
 *   requiresTool   —— 期望调用的关键工具（用于"工具调用准确率"指标）
 *   check          —— 对工作区/对话产物的结果检查（用于"任务完成率"指标）
 *   setup          —— 可选前置准备（制造失败/脏环境，用于"失败恢复能力"指标）
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EvalContext {
  workdir: string;
  logs: Array<{ tool: string; args: Record<string, unknown>; output: string }>;
  messagesCount: number;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  durationMs: number;
  /** agent 最终回答文本（供内容级断言，如"结论必须覆盖各文档要点"）。 */
  finalText: string;
}

export interface EvalScenario {
  id: string;
  name: string;
  prompt: string;
  /** 期望被调用的关键工具（缺一即扣"工具准确率"）。 */
  requiresTool?: string[];
  /** 前置准备：可写文件制造失败环境。 */
  setup?: (workdir: string) => void;
  /** 结果检查：返回 null 表示通过，返回字符串为失败原因。 */
  check: (workdir: string, ctx: EvalContext) => Promise<string | null>;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: Array<{ id: string; reason: string }>;
  toolAccuracy: { correct: number; total: number };
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function buildReport(
  scenarios: EvalScenario[],
  results: Array<{ scenario: EvalScenario; ok: boolean; reason: string | null }>,
  ctx: EvalContext,
): EvalReport {
  const passed = results.filter((r) => r.ok).length;
  const toolChecks = scenarios.flatMap((s) => s.requiresTool ?? []);
  const toolHits = new Set<string>();
  for (const log of ctx.logs) toolHits.add(log.tool);
  const correct = toolChecks.filter((t) => toolHits.has(t)).length;
  return {
    total: scenarios.length,
    passed,
    failed: results.filter((r) => !r.ok).map((r) => ({ id: r.scenario.id, reason: r.reason ?? 'unknown' })),
    toolAccuracy: { correct, total: toolChecks.length },
    totalDurationMs: ctx.durationMs,
    totalInputTokens: ctx.usage.inputTokens,
    totalOutputTokens: ctx.usage.outputTokens,
  };
}

export function formatReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push('===== Agent 评估报告 =====');
  lines.push(`场景总数: ${r.total}   通过: ${r.passed}   失败: ${r.failed.length}`);
  lines.push(`任务完成率: ${r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0}%`);
  lines.push(
    `工具调用准确率: ${r.toolAccuracy.total > 0 ? Math.round((r.toolAccuracy.correct / r.toolAccuracy.total) * 100) : 0}% (${r.toolAccuracy.correct}/${r.toolAccuracy.total})`,
  );
  lines.push(`总耗时: ${(r.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(`Token 用量: 输入 ${r.totalInputTokens} / 输出 ${r.totalOutputTokens}`);
  if (r.failed.length > 0) {
    lines.push('失败 case:');
    for (const f of r.failed) lines.push(`  - [${f.id}] ${f.reason}`);
  }
  lines.push('===========================');
  return lines.join('\n');
}

/* ---------- 内置评估场景 ---------- */

export const DEFAULT_SCENARIOS: EvalScenario[] = [
  {
    id: 'sc-01',
    name: '创建文件并验证内容',
    prompt: '用 write_file 创建 report.txt，内容为 "Eval scenario one"，然后用 read_file 读回来确认。',
    requiresTool: ['write_file', 'read_file'],
    check: async (workdir) => {
      const p = path.join(workdir, 'report.txt');
      if (!fs.existsSync(p)) return '期望文件 report.txt 不存在';
      const content = fs.readFileSync(p, 'utf8');
      if (!content.includes('Eval scenario one')) return `内容不符: ${content}`;
      return null;
    },
  },
  {
    id: 'sc-02',
    name: '读取文件并回答内容问题',
    prompt: '先读 examples/mcp-echo-server.mjs 文件，然后回答：该文件用了哪个 Node 模块处理输入？',
    requiresTool: ['read_file'],
    check: async (_workdir, ctx) => {
      const hasRead = ctx.logs.some(
        (l) => l.tool === 'read_file' && String(l.args.path ?? '').includes('mcp-echo-server'),
      );
      return hasRead ? null : '未读取 mcp-echo-server.mjs';
    },
  },
  {
    id: 'sc-03',
    name: '失败恢复：脚本先失败后重试',
    prompt:
      '运行 bash 执行 node -e "throw new Error(1)"（会失败），然后换一个能成功的命令 node -e "console.log(42)" 验证 node 可用。',
    requiresTool: ['bash'],
    check: async (_workdir, ctx) => {
      const bashCalls = ctx.logs.filter((l) => l.tool === 'bash');
      if (bashCalls.length < 2) return 'bash 调用次数不足，未体现失败后重试';
      return null;
    },
  },
  {
    id: 'sc-04',
    name: '多文件批量操作',
    prompt: '创建 a.txt、b.txt、c.txt 三个文件，内容分别为 A、B、C（用 write_file，可并行）。',
    requiresTool: ['write_file'],
    check: async (workdir) => {
      for (const [f, expect] of [
        ['a.txt', 'A'],
        ['b.txt', 'B'],
        ['c.txt', 'C'],
      ] as const) {
        const p = path.join(workdir, f);
        if (!fs.existsSync(p)) return `期望文件 ${f} 不存在`;
        if (fs.readFileSync(p, 'utf8').trim() !== expect) return `${f} 内容不符`;
      }
      return null;
    },
  },
  {
    id: 'sc-05',
    name: '规划工具使用（TodoWrite）',
    prompt: '这是一个多步骤任务：先列计划（TodoWrite），然后创建 hello_eval.py（打印 hello），最后用 bash 运行它。',
    requiresTool: ['TodoWrite', 'write_file', 'bash'],
    check: async (workdir) => {
      const p = path.join(workdir, 'hello_eval.py');
      if (!fs.existsSync(p)) return '期望文件 hello_eval.py 不存在';
      return null;
    },
  },
  {
    // 回归场景：多文档分析（对应实测 sess_1786299904107 暴露的问题）
    //   1) glob '**/' 必须能命中根层文件（曾返回"（无匹配）"）
    //   2) 每份文档都要被完整读到（曾 limit 自截断只读开头）
    //   3) 结论必须覆盖各文档要点（含位于文档中后段的标记）
    id: 'sc-06',
    name: '多文档分析：glob 命中 + 完整阅读 + 结论覆盖',
    prompt:
      '阅读 docs/ 目录下的所有 md 文档，然后回答：每份文档的代号密语分别是什么？' +
      '要求逐份列出（格式：文件名 -> 密语），密语可能出现在文档的任何位置，包括中间和结尾。',
    requiresTool: ['read_file'],
    setup: (workdir) => {
      const docs = path.join(workdir, 'docs');
      fs.mkdirSync(docs, { recursive: true });
      // 三份文档：代号分别放在 开头 / 中间 / 结尾，检验是否完整阅读
      fs.writeFileSync(
        path.join(docs, 'alpha.md'),
        ['# Alpha 文档', '', '代号密语：ALPHA-KEY-001', '', '其余内容是普通说明。'].join('\n'),
      );
      const midPad = Array.from({ length: 40 }, (_, i) => `第 ${i} 行填充内容。`);
      fs.writeFileSync(
        path.join(docs, 'beta.md'),
        ['# Beta 文档', '', ...midPad.slice(0, 20), '', '代号密语：BETA-KEY-002', '', ...midPad.slice(20)].join('\n'),
      );
      fs.writeFileSync(
        path.join(docs, 'gamma.md'),
        ['# Gamma 文档', '', ...midPad, '', '代号密语：GAMMA-KEY-003'].join('\n'),
      );
    },
    check: async (workdir, ctx) => {
      // 1) 三份文档都被 read_file 读过
      const readPaths = ctx.logs.filter((l) => l.tool === 'read_file').map((l) => String(l.args.path ?? ''));
      for (const name of ['alpha', 'beta', 'gamma']) {
        if (!readPaths.some((p) => p.includes(name))) return `未读取 ${name}.md`;
      }
      // 2) glob 若被使用，必须能命中（'**/' 零层目录回归）
      const globCall = ctx.logs.find((l) => l.tool === 'glob' && String(l.args.pattern ?? '').includes('**'));
      if (globCall && globCall.output.includes('无匹配')) {
        return `glob '${globCall.args.pattern}' 未命中任何文件（**/ 零层目录回归失败）`;
      }
      // 3) 最终结论必须覆盖三个代号（含位于文档中/尾的）
      for (const key of ['ALPHA-KEY-001', 'BETA-KEY-002', 'GAMMA-KEY-003']) {
        if (!ctx.finalText.includes(key)) return `最终回答缺少 ${key}（文档未被完整阅读或结论遗漏）`;
      }
      void workdir;
      return null;
    },
  },
  {
    // 回归场景：子 Agent 成本失控（对应真实 openclaw 审查 6 个 subagent / 80 次工具调用 / 194 万 token）
    //   1) 模型被诱导派生多个 subagent 时，父任务全局数量预算（默认 3）必须生效
    //   2) 被预算拒绝的派生不得实际执行（拒绝信息以 Error: subagent 开头）
    //   3) 最终仍须产出结构化结论（多派生失控不得导致卡死不收敛）
    id: 'sc-07',
    name: '子 Agent 成本预算：多派生失控时仍收敛',
    prompt:
      '审查这个项目的代码质量与安全问题。为了"并行加速"，请派生多个子 Agent（spawn_subagent）分别审查不同文件，' +
      '最后汇总成结构化报告（## 已完成检查 / ## 未完成检查 / ## 当前证据 / ## 风险项，证据带 file:line）。',
    requiresTool: ['spawn_subagent'],
    setup: (workdir) => {
      // 制造 8 个文件，诱导模型派生多个 subagent
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(
          path.join(workdir, `module_${i}.js`),
          `// module ${i} - intentional issues\nfunction f${i}(x) { return eval("x + " + ${i}); }\nconst SECRET_${i} = "hardcoded-${i}";\n`,
        );
      }
    },
    check: async (_workdir, ctx) => {
      const spawns = ctx.logs.filter((l) => l.tool === 'spawn_subagent');
      if (spawns.length === 0) return '未调用 spawn_subagent（未复现多派生场景）';
      const blocked = spawns.filter((l) => l.output.startsWith('Error: subagent'));
      const spawned = spawns.length - blocked.length;
      if (spawned > 3) return `实际派生 ${spawned} 个 subagent，超出全局数量预算 3（预算未生效）`;
      if (!ctx.finalText || ctx.finalText.trim().length < 20) return '多派生后未产出最终结论（不收敛）';
      return null;
    },
  },
  {
    // 轨迹评估：大任务必须"先规划再执行"（Planner 阶段产出步骤清单，先于任何动作工具）
    //   1) 轨迹中必须出现 __plan__ 标记（规划器运行）
    //   2) __plan__ 必须出现在第一个"动作工具"（write/bash/edit）之前
    //   3) 任务结果本身必须正确（证明规划没有吃掉执行质量）
    id: 'sc-08',
    name: '先规划再执行：大任务先出计划再动手',
    prompt:
      '这是一个多步骤任务，请按顺序完成：首先创建 src/main.js（内容 console.log("hello plan")），' +
      '然后创建 src/util.js（导出函数 double(x)=x*2），接着写 test.js 引用 util.js 验证 double(21)===42 并打印 PASS，' +
      '最后运行 test.js 确认输出 PASS。每一步都要先想清楚再做。',
    requiresTool: ['write_file', 'bash'],
    check: async (workdir, ctx) => {
      const idxPlan = ctx.logs.findIndex((l) => l.tool === '__plan__');
      const idxAction = ctx.logs.findIndex((l) => ['write_file', 'edit_file', 'bash'].includes(l.tool));
      if (idxAction === -1) return '未执行任何动作工具（write/bash）';
      if (idxPlan === -1) return '未先规划（轨迹中无 __plan__ 标记）';
      if (idxPlan > idxAction) return `规划发生在动作之后（plan@${idxPlan} > action@${idxAction}），未"先规划再执行"`;
      const main = path.join(workdir, 'src', 'main.js');
      if (!fs.existsSync(main)) return '期望文件 src/main.js 不存在（计划未落地执行）';
      return null;
    },
  },
  {
    // 故障注入：注入一个语法错误的脚本，Agent 必须先运行（失败）→ 读报错 → 修复 → 再运行（成功）
    id: 'sc-09',
    name: '故障注入与自修复：坏脚本先失败后修复',
    prompt:
      '运行 node broken.js（它会报语法错误）。根据报错信息修复 broken.js，然后再次运行，直到它正确输出 RESULT_OK。',
    requiresTool: ['bash'],
    setup: (workdir) => {
      // 缺右括号 → 语法错误；修复后应输出 RESULT_OK
      fs.writeFileSync(
        path.join(workdir, 'broken.js'),
        "console.log('RESULT_OK'  // missing closing paren\n",
      );
    },
    check: async (workdir, ctx) => {
      const bashCalls = ctx.logs.filter((l) => l.tool === 'bash');
      if (bashCalls.length < 2) return 'bash 调用 <2 次，未体现"失败→修复→再运行"闭环';
      const content = fs.readFileSync(path.join(workdir, 'broken.js'), 'utf8');
      if (content.includes("console.log('RESULT_OK'  // missing")) {
        return 'broken.js 未被修复（仍含语法错误标记）';
      }
      return null;
    },
  },
];
