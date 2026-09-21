/**
 * 工具装配 —— 把全部工具集组合成标准工具池（main.ts / 测试复用）。
 * 需要实例的子系统（tasks/background/cron/teams/worktree/mcp）由装配方创建后注入。
 */
import type { ToolDef } from '../types.js';
import { fsTools } from './fs.js';
import { bashTool } from './shell.js';
import { todoTool } from './todo.js';
import { spawnSubagentTool } from './subagent.js';
import { loadSkillTool, type SkillLoader } from './skills.js';
import { taskTools, type TaskSystem } from './tasks.js';
import { backgroundTools, type BackgroundSystem } from './background.js';
import { cronTools, type CronScheduler } from './cron.js';
import { teamTools, type MessageBus } from './teams.js';
import { worktreeTools, type WorktreeManager } from './worktree.js';
import { mcpTools, type McpPool } from './mcp.js';
import { ragTools } from './rag.js';
import type { RagService } from './rag.js';
import { webTools } from './web.js';
import { pdfTool } from './pdf.js';
import { selfReviewTool } from './reflexion.js';

export interface HarnessServices {
  skills?: SkillLoader;
  tasks?: TaskSystem;
  background?: BackgroundSystem;
  cron?: CronScheduler;
  bus?: MessageBus;
  worktrees?: WorktreeManager;
  mcp?: McpPool;
  ownerName?: string;
  /** RAG 服务（注入后注册 search_docs / index_docs）。 */
  rag?: RagService;
}

export function standardTools(services: HarnessServices = {}): ToolDef[] {
  const tools: ToolDef[] = [
    bashTool(services.background),
    todoTool(),
    spawnSubagentTool(),
    ...fsTools(),
    ...webTools(),
    pdfTool(),
    selfReviewTool(),
  ];
  if (services.rag) {
    tools.push(
      ...ragTools({
        root: services.rag.root,
        embedder: services.rag.embedder,
        store: services.rag.store,
        stateFile: services.rag.stateFile,
      }),
    );
  }
  if (services.skills) tools.push(loadSkillTool(services.skills));
  if (services.tasks) tools.push(...taskTools(services.tasks, services.ownerName ?? 'lead'));
  if (services.background) tools.push(...backgroundTools(services.background));
  if (services.cron) tools.push(...cronTools(services.cron));
  if (services.bus) tools.push(...teamTools(services.bus, services.ownerName ?? 'lead'));
  if (services.worktrees) tools.push(...worktreeTools(services.worktrees, services.tasks));
  if (services.mcp) tools.push(...mcpTools(services.mcp));
  return tools;
}
