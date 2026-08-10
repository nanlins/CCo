/**
 * 配置加载 —— 单个来源：环境变量 + .env（dotenv）。
 * 双协议：
 *   LLM_PROTOCOL=anthropic（默认）→ 任意 Anthropic 兼容端点（DeepSeek / GLM / Kimi 只需改 baseUrl）
 *   LLM_PROTOCOL=openai            → 任意 OpenAI 兼容端点（百炼 compatible-mode / OpenAI / vLLM 等）
 */
import 'dotenv/config';
import path from 'node:path';
import type { PermissionMode } from './types.js';

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
}

function envStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envBool(name: string): boolean {
  return ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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