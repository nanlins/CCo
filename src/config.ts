/**
 * 配置加载 —— 环境变量 + 分层 .env（dotenv）。
 * 双协议：
 *   LLM_PROTOCOL=anthropic（默认）→ 任意 Anthropic 兼容端点（DeepSeek / GLM / Kimi 只需改 baseUrl）
 *   LLM_PROTOCOL=openai            → 任意 OpenAI 兼容端点（百炼 compatible-mode / OpenAI / vLLM 等）
 *
 * .env 分层加载优先级（高 → 低）：
 *   1. 真实环境变量（shell 已导出的永远最高，不被任何 .env 覆盖）
 *   2. 工作区 .env（HARNESS_CWD/.env —— /apikey /model /baseurl 运行时写入这里）
 *   3. 进程 cwd .env（项目根传统位置）
 * 这样修复了"anvil 全局命令下 /model /apikey 写入工作区 .env 但重启不生效"的问题
 * （此前只读 process.cwd()/.env，而 anvil 的 cwd 是项目根、工作区是用户目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { PermissionMode } from './types.js';

/**
 * 分层加载 .env：真实环境变量最高优先，其次工作区 .env，最后 cwd .env。
 * 参数可注入（测试用）；默认工作区 = HARNESS_CWD ?? process.cwd()。
 */
export function loadDotenvLayered(workspaceDir?: string, cwdDir?: string): void {
  /* 捕获加载任何 .env 之前就已存在的环境变量（真实 shell 环境），这些永不被覆盖 */
  const realEnvKeys = new Set(Object.keys(process.env));

  const loadOne = (file: string, allowOverride: boolean): void => {
    if (!fs.existsSync(file)) return;
    try {
      const parsed = dotenv.parse(fs.readFileSync(file));
      for (const [key, value] of Object.entries(parsed)) {
        if (realEnvKeys.has(key)) continue; // 真实环境变量最高优先
        if (!allowOverride && process.env[key] !== undefined) continue;
        process.env[key] = value;
      }
    } catch {
      /* 损坏的 .env 忽略 */
    }
  };

  const cwdEnv = path.join(cwdDir ?? process.cwd(), '.env');
  const wsResolved = path.resolve(workspaceDir ?? process.env.HARNESS_CWD ?? process.cwd());
  const workspaceEnv = path.join(wsResolved, '.env');

  /* 先加载低优先级（cwd），再加载高优先级（工作区，允许覆盖前者设置的键） */
  loadOne(cwdEnv, false);
  if (workspaceEnv !== cwdEnv) loadOne(workspaceEnv, true);
}
loadDotenvLayered();

export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel?: string;
  permissionMode: PermissionMode;
  sandboxCmd?: string;
  maxTokens: number;
  compactThresholdChars: number;
  maxToolOutputChars: number;
  workspaceDir: string;
  mock: boolean;
  /** LLM 协议：anthropic（默认）或 openai（OpenAI 兼容端点）。 */
  llmProtocol: 'anthropic' | 'openai';
  /** OpenAI 兼容端点（llmProtocol=openai 时使用）。 */
  openaiBaseUrl: string;
  /** OpenAI 兼容端点密钥（缺省回退 ANTHROPIC_API_KEY）。 */
  openaiApiKey: string;
  /** 采样参数（可选）。 */
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** RAG: embedding 与向量存储配置（可选，缺省用本地兜底）。 */
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  vectorStore?: 'memory' | 'pg';
  pgConnectionString?: string;
  /** YoloClassifier：auto 模式下 LLM 自动审批安全操作（YOLO=1 启用）。 */
  yolo?: boolean;
  /** Redis 连接 URL（REDIS_URL）。 */
  redisUrl?: string;
  /** 多模型路由：flash 模型（简单任务）。 */
  flashModelId?: string;
  /** 多模型路由：pro 模型（复杂任务）。 */
  proModelId?: string;
  /** Docker 沙箱：命令容器执行（DOCKER_SANDBOX=1 启用）。 */
  dockerSandbox?: boolean;
  /** 额外只读目录（EXTRA_READ_ROOTS，分隔符同 PATH）：read/glob/grep/list 可越出工作区读取。 */
  extraReadRoots: string[];
  /** web 工具公网白名单（WEB_ALLOWED_HOSTS，逗号分隔）：非空时仅允许名单内主机。 */
  webAllowedHosts?: string[];
  /** 同一工具调用连续执行上限（MAX_REPEAT_TOOL_CALLS，默认 2，超过即拦截）。 */
  maxRepeatToolCalls?: number;
  /** 单次 run 工具调用上限（MAX_TOOL_CALLS_PER_RUN，默认 80）。 */
  maxToolCallsPerRun?: number;
  /** 单次 run 输出 token 预算（MAX_RUN_OUTPUT_TOKENS，默认 200000）。 */
  maxRunOutputTokens?: number;
  /** 单次 run 输入 token 预算（MAX_RUN_INPUT_TOKENS，默认 400000）。 */
  maxRunInputTokens?: number;
  /** 单次 run 总 token 预算（输入+输出，MAX_RUN_TOTAL_TOKENS，默认 500000）。 */
  maxRunTotalTokens?: number;
  /** 单次 run LLM 调用次数上限（MAX_LLM_CALLS_PER_RUN，默认 40）。 */
  maxLlmCallsPerRun?: number;
  /** 重试退避基础延迟毫秒（RETRY_DELAY_MS，缺省用指数退避；测试可设为 1 加速）。 */
  retryDelayMs?: number;
  /** 单任务 subagent 数量上限（MAX_SUBAGENTS_PER_TASK，默认 3）。 */
  maxSubagentsPerTask?: number;
  /** subagent 内部预算（SUBAGENT_MAX_*）。 */
  subagentMaxTurns?: number;
  subagentMaxToolCalls?: number;
  subagentMaxLlmCalls?: number;
  subagentMaxOutputTokens?: number;
  subagentMaxInputTokens?: number;
  subagentMaxTotalTokens?: number;
  /** subagent wall-clock 超时（SUBAGENT_TIMEOUT_MS，默认 300000）。 */
  subagentTimeoutMs?: number;
  /** 只读研究模式（RESEARCH_MODE=1）：启用交付检查表 + 阅读策略 + 研究任务硬预算。 */
  researchMode?: boolean;
  /** 研究任务 read_file 类别上限（READ_FILE_LIMIT，默认 18）。 */
  maxReadFileCalls?: number;
  /** 研究任务 bash 类别上限（BASH_LIMIT，默认 3）。 */
  maxBashCalls?: number;
  /** 研究任务 write 类别上限（WRITE_FILE_LIMIT，默认 0=禁止写入）。 */
  maxWriteFileCalls?: number;
  /** subagent 全局聚合预算（SUBAGENT_TOTAL_*）。 */
  subagentTotalToolCalls?: number;
  subagentTotalOutputTokens?: number;
  /** 先规划再执行（AUTO_PLAN）：true 强制规划 / false 关闭 / undefined 启发式。 */
  autoPlan?: boolean;
  /** 触发规划的输入长度阈值（PLAN_THRESHOLD_CHARS，默认 160）。 */
  planThresholdChars?: number;
  /** 规划步骤数上限（PLAN_MAX_STEPS，默认 8）。 */
  planMaxSteps?: number;
}

function envStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envBool(name: string): boolean {
  return ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase());
}

/** 三态布尔：未设置返回 undefined（交由调用方区分"显式关"与"启发式"）。 */
function envBoolOrUndefined(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  /* 接受 0 与负数：0=不限制、负数=禁用（语义见 normalizeBudgetLimit） */
  return Number.isFinite(n) ? n : fallback;
}

/** 未设置返回 undefined（交给调用方用默认值）；设置了则接受 0 与负数。 */
function envIntOrUndefined(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 归一化预算上限的语义（MAX_* / SUBAGENT_* 所有数值预算字段统一规则）：
 *   undefined → fallback（默认值）
 *   0         → 不限制（返回 Infinity）
 *   负数      → 禁用（返回 0，立即拦截，一次都不放行）
 * 消费方（agent.ts / subagent.ts）据此统一解释，0 与负数的含义写进 /config 与 .env.example。
 */
export function normalizeBudgetLimit(value: number | undefined, fallback: number): number {
  const v = value ?? fallback;
  if (v === 0) return Number.POSITIVE_INFINITY;
  if (v < 0) return 0;
  return v;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg: AppConfig = {
    apiKey: overrides.apiKey ?? envStr('ANTHROPIC_API_KEY'),
    baseUrl: overrides.baseUrl ?? envStr('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    model: overrides.model ?? envStr('MODEL_ID', 'claude-sonnet-4-6'),
    fallbackModel: overrides.fallbackModel ?? (envStr('FALLBACK_MODEL_ID') || undefined),
    llmProtocol: overrides.llmProtocol ?? (envStr('LLM_PROTOCOL', 'anthropic') === 'openai' ? 'openai' : 'anthropic'),
    openaiBaseUrl: overrides.openaiBaseUrl ?? envStr('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiApiKey: overrides.openaiApiKey ?? (envStr('OPENAI_API_KEY') || envStr('ANTHROPIC_API_KEY')),
    permissionMode: overrides.permissionMode ?? (envStr('PERMISSION_MODE', 'ask') as PermissionMode),
    sandboxCmd: overrides.sandboxCmd ?? (envStr('SANDBOX_CMD') || undefined),
    maxTokens: overrides.maxTokens ?? envInt('MAX_TOKENS', 8192),
    compactThresholdChars: overrides.compactThresholdChars ?? envInt('COMPACT_THRESHOLD_CHARS', 50000),
    maxToolOutputChars: overrides.maxToolOutputChars ?? envInt('MAX_TOOL_OUTPUT_CHARS', 50000),
    workspaceDir: path.resolve(overrides.workspaceDir ?? envStr('HARNESS_CWD', process.cwd())),
    mock: overrides.mock ?? envBool('MOCK'),
    temperature: overrides.temperature ?? envFloat('TEMPERATURE'),
    topP: overrides.topP ?? envFloat('TOP_P'),
    stopSequences: overrides.stopSequences ?? envList('STOP_SEQUENCES'),
    embeddingBaseUrl: overrides.embeddingBaseUrl ?? (envStr('EMBEDDING_BASE_URL') || undefined),
    embeddingApiKey: overrides.embeddingApiKey ?? (envStr('EMBEDDING_API_KEY') || undefined),
    embeddingModel: overrides.embeddingModel ?? (envStr('EMBEDDING_MODEL') || undefined),
    vectorStore: overrides.vectorStore ?? (envStr('VECTOR_STORE', 'memory') as 'memory' | 'pg'),
    pgConnectionString: overrides.pgConnectionString ?? (envStr('PG_CONNECTION_STRING') || undefined),
    yolo: overrides.yolo ?? envBool('YOLO'),
    extraReadRoots: overrides.extraReadRoots ?? envPathList('EXTRA_READ_ROOTS'),
    webAllowedHosts: overrides.webAllowedHosts ?? envList('WEB_ALLOWED_HOSTS'),
    maxRepeatToolCalls: overrides.maxRepeatToolCalls ?? envIntOrUndefined('MAX_REPEAT_TOOL_CALLS'),
    maxToolCallsPerRun: overrides.maxToolCallsPerRun ?? envIntOrUndefined('MAX_TOOL_CALLS_PER_RUN'),
    maxRunOutputTokens: overrides.maxRunOutputTokens ?? envIntOrUndefined('MAX_RUN_OUTPUT_TOKENS'),
    maxRunInputTokens: overrides.maxRunInputTokens ?? envIntOrUndefined('MAX_RUN_INPUT_TOKENS'),
    maxRunTotalTokens: overrides.maxRunTotalTokens ?? envIntOrUndefined('MAX_RUN_TOTAL_TOKENS'),
    maxLlmCallsPerRun: overrides.maxLlmCallsPerRun ?? envIntOrUndefined('MAX_LLM_CALLS_PER_RUN'),
    retryDelayMs: overrides.retryDelayMs ?? envIntOrUndefined('RETRY_DELAY_MS'),
    maxSubagentsPerTask: overrides.maxSubagentsPerTask ?? envIntOrUndefined('MAX_SUBAGENTS_PER_TASK'),
    subagentMaxTurns: overrides.subagentMaxTurns ?? envIntOrUndefined('SUBAGENT_MAX_TURNS'),
    subagentMaxToolCalls: overrides.subagentMaxToolCalls ?? envIntOrUndefined('SUBAGENT_MAX_TOOL_CALLS'),
    subagentMaxLlmCalls: overrides.subagentMaxLlmCalls ?? envIntOrUndefined('SUBAGENT_MAX_LLM_CALLS'),
    subagentMaxOutputTokens: overrides.subagentMaxOutputTokens ?? envIntOrUndefined('SUBAGENT_MAX_OUTPUT_TOKENS'),
    subagentMaxInputTokens: overrides.subagentMaxInputTokens ?? envIntOrUndefined('SUBAGENT_MAX_INPUT_TOKENS'),
    subagentMaxTotalTokens: overrides.subagentMaxTotalTokens ?? envIntOrUndefined('SUBAGENT_MAX_TOTAL_TOKENS'),
    subagentTimeoutMs: overrides.subagentTimeoutMs ?? envIntOrUndefined('SUBAGENT_TIMEOUT_MS'),
    subagentTotalToolCalls: overrides.subagentTotalToolCalls ?? envIntOrUndefined('SUBAGENT_TOTAL_TOOL_CALLS'),
    subagentTotalOutputTokens: overrides.subagentTotalOutputTokens ?? envIntOrUndefined('SUBAGENT_TOTAL_OUTPUT_TOKENS'),
    researchMode: overrides.researchMode ?? envBool('RESEARCH_MODE'),
    maxReadFileCalls: overrides.maxReadFileCalls ?? envIntOrUndefined('READ_FILE_LIMIT'),
    maxBashCalls: overrides.maxBashCalls ?? envIntOrUndefined('BASH_LIMIT'),
    maxWriteFileCalls: overrides.maxWriteFileCalls ?? envIntOrUndefined('WRITE_FILE_LIMIT'),
    autoPlan: overrides.autoPlan ?? envBoolOrUndefined('AUTO_PLAN'),
    planThresholdChars: overrides.planThresholdChars ?? envInt('PLAN_THRESHOLD_CHARS', 160),
    planMaxSteps: overrides.planMaxSteps ?? envInt('PLAN_MAX_STEPS', 8),
    redisUrl: overrides.redisUrl ?? (envStr('REDIS_URL') || undefined),
    flashModelId: overrides.flashModelId ?? (envStr('FLASH_MODEL_ID') || undefined),
    proModelId: overrides.proModelId ?? (envStr('PRO_MODEL_ID') || undefined),
    dockerSandbox: overrides.dockerSandbox ?? envBool('DOCKER_SANDBOX'),
  };
  return cfg;
}

function envFloat(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : undefined;
}

function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** PATH 风格分隔符（Windows ';' / POSIX ':'）列表，解析为绝对路径。 */
function envPathList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}
