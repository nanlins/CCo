/**
 * 工作流运行时 —— 固定步骤编排 + journal 持久化 + 可恢复执行 + 依赖并行。
 *
 * 职责（对照 learn-claude-code s16_workflow_runtime 的最小可用子集）：
 *   - runWorkflow：按依赖拓扑执行步骤，同层无依赖的步骤并行；
 *   - journal 持久化：每步开始/完成/失败写入 JSON 日志，崩溃后 resumeWorkflow 跳过已完成步骤；
 *   - 单步失败记录后继续（收集所有失败），不中途抛异常拖垮整体。
 *
 * 承重不变量：
 *   - 不依赖 LLM；步骤是普通 async 函数；
 *   - journal 写入原子（先写临时文件再 rename），损坏时回退为空进度。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface WorkflowStep<Ctx> {
  id: string;
  title: string;
  dependsOn?: string[];
  run: (ctx: Ctx) => Promise<void>;
}

export interface WorkflowResult {
  ok: boolean;
  completed: string[];
  failed: Array<{ id: string; error: string }>;
}

interface JournalEntry {
  id: string;
  status: 'done' | 'failed';
  error?: string;
}

interface Journal {
  steps: Record<string, JournalEntry>;
}

function readJournal(file: string): Journal {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { steps: parsed?.steps ?? {} };
  } catch {
    return { steps: {} };
  }
}

function writeJournal(file: string, journal: Journal): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2));
  fs.renameSync(tmp, file);
}

export async function runWorkflow<Ctx>(
  steps: WorkflowStep<Ctx>[],
  ctx: Ctx,
  options: { journalPath?: string; parallel?: boolean } = {},
): Promise<WorkflowResult> {
  const journalFile = options.journalPath;
  const journal = journalFile ? readJournal(journalFile) : { steps: {} };
  const byId = new Map(steps.map((s) => [s.id, s]));
  const completed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  const mark = (id: string, status: 'done' | 'failed', error?: string): void => {
    journal.steps[id] = { id, status, error };
    if (journalFile) writeJournal(journalFile, journal);
  };

  const runStep = async (step: WorkflowStep<Ctx>): Promise<void> => {
    if (journal.steps[step.id]?.status === 'done') {
      completed.push(step.id);
      return;
    }
    try {
      await step.run(ctx);
      mark(step.id, 'done');
      completed.push(step.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      mark(step.id, 'failed', message);
      failed.push({ id: step.id, error: message });
    }
  };

  const pending = [...steps];
  while (pending.length > 0) {
    const ready = pending.filter((s) =>
      (s.dependsOn ?? []).every((d) => completed.includes(d) || byId.get(d) === undefined),
    );
    if (ready.length === 0) {
      /* 剩余步骤存在未满足依赖（可能依赖失败），记录并放弃 */
      for (const s of pending) {
        failed.push({
          id: s.id,
          error: `依赖未满足: ${(s.dependsOn ?? []).filter((d) => !completed.includes(d)).join(', ')}`,
        });
      }
      break;
    }
    pending.splice(0, pending.length, ...pending.filter((s) => !ready.includes(s)));
    if (options.parallel) {
      await Promise.all(ready.map(runStep));
    } else {
      for (const s of ready) await runStep(s);
    }
  }

  return { ok: failed.length === 0, completed, failed };
}

// 修改记录：
//   2026-10-03 新增：最小可用工作流运行时（固定步骤/依赖并行/journal 持久化/可恢复执行）
