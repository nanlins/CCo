/**
 * 公共 API —— 库入口（测试与二次开发复用）。
 */
export { loadConfig, type AppConfig } from './config.js';
export { AnthropicLlm, type LlmClient, type LlmCallParams, type LlmResult } from './llm/client.js';
export { MockLlm, type ScriptedTurn } from './llm/mock.js';
export { Agent, type AgentEvent, type AgentOptions } from './core/agent.js';
export { HookRegistry, type HookEvent, type HookResult } from './core/hooks.js';
export { PermissionGate, isInside, type PermissionDecision } from './core/permission.js';
export { ToolRegistry } from './core/registry.js';
export { Sandbox } from './core/sandbox.js';
export { Transcript, AuditLog } from './core/transcript.js';
export { MemoryStore } from './core/memory.js';
export { detectPromptInjection, scanForInjection, type InjectionDetection } from './core/security.js';
export { YoloClassifier, type YoloVerdict } from './core/yoloClassifier.js';
export { compactMessages, compactHistory, snipCompact, microCompact, countChars } from './core/compact.js';
export { assembleSystemPrompt, renderTodos } from './core/prompt.js';
export { callWithRetry, isRetryableError, isPromptTooLong, backoffDelay } from './core/recovery.js';
export { TaskSystem, type TaskRecord } from './tools/tasks.js';
export { BackgroundSystem } from './tools/background.js';
export { CronScheduler, cronMatches, isValidCronExpr } from './tools/cron.js';
export { MessageBus, Teammate, teamTools, type TeamMessage } from './tools/teams.js';
export { WorktreeManager } from './tools/worktree.js';
export { McpPool, McpClient } from './tools/mcp.js';
export { SkillLoader } from './tools/skills.js';
export { webSearch, webExtractor, webTools } from './tools/web.js';
export { parsePdf, pdfTool } from './tools/pdf.js';
export { selfReview, selfReviewTool } from './tools/reflexion.js';
export { loadPermissionSettings, matchRules, toolNameKey } from './core/permissionSettings.js';
export { ModelRouter, type ModelTier, type RoutingDecision } from './core/modelRouter.js';
export { RedisService } from './core/redis.js';
export { DockerSandbox } from './core/dockerSandbox.js';
export { SessionManager, type SessionInfo } from './core/sessionManager.js';
export { ConfigWatcher } from './core/configWatcher.js';
export { exportConversation, type ExportFormat } from './core/exportConversation.js';
export { PluginMarket, type PluginInfo } from './core/pluginMarket.js';
export {
  analyzeCommand,
  isCommandSafe,
  getRiskDescription,
  type CommandAnalysis,
  type RiskLevel,
} from './core/commandAnalyzer.js';
export { setLocale, getLocale, t, type Locale } from './core/i18n.js';
export { ShortcutManager, createDefaultShortcuts } from './core/shortcuts.js';
export { configGuide, saveUserConfig, setEnvValue, readEnvValue, hasApiKey, hasEnvFile } from './core/configManager.js';
export { RagService, ragTools, type RagToolDeps } from './tools/rag.js';
export { createEmbedder, LocalHashEmbedder, OpenAiCompatibleEmbedder, cosineSimilarity } from './rag/embedding.js';
export { InMemoryVectorStore, PgVectorStore, createVectorStore } from './rag/vectorStore.js';
export { DocIndexer } from './rag/indexer.js';
export { collectDocs, chunkFile } from './rag/chunker.js';
export { standardTools } from './tools/index.js';
export { startRepl } from './repl.js';
export { createHarness, type Harness } from './main.js';
export * from './types.js';
