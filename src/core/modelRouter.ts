/**
 * 多模型路由 —— 根据任务复杂度选择最合适的模型（成本优化）。
 *
 * 路由策略：
 *   - 简单任务（查询/列举/读取）→ flash 模型（便宜快速）
 *   - 中等任务（编辑/创建/搜索）→ 默认模型
 *   - 复杂任务（重构/多文件/推理）→ pro 模型（高质量）
 *
 * 判断依据：
 *   1. 工具类型（只读 vs 写入 vs 多工具）
 *   2. 任务描述关键词（"重构"/"优化"/"分析" → 复杂）
 *   3. 上下文长度（长上下文 → 复杂）
 *   4. 用户显式指定（/model 命令）
 */

export type ModelTier = 'flash' | 'default' | 'pro';

export interface ModelRouterConfig {
  /** flash 模型 ID（简单任务）。 */
  flashModel?: string;
  /** 默认模型 ID。 */
  defaultModel: string;
  /** pro 模型 ID（复杂任务）。 */
  proModel?: string;
  /** 上下文长度阈值：超过此值升级为 pro。 */
  contextThreshold?: number;
}

export interface RoutingDecision {
  model: string;
  tier: ModelTier;
  reason: string;
}

/* 简单任务关键词（查询/列举/读取） */
const SIMPLE_KEYWORDS = /^(列出|查看|读取|显示|搜索|查找|list|show|read|find|search|get|cat|ls|dir)/i;

/* 复杂任务关键词（重构/优化/分析/多文件） */
const COMPLEX_KEYWORDS =
  /(重构|优化|分析|设计|架构|review|refactor|optimize|analyze|design|architecture|多文件|跨模块|全面|彻底)/i;

/* 只读工具（倾向 flash） */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_files',
  'web_search',
  'web_extractor',
  'search_docs',
  'task_list',
  'task_get',
  'mcp_list',
  'teammate_status',
]);

/* 写入工具（倾向 default/pro） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'bash']);

export class ModelRouter {
  private config: ModelRouterConfig;
  private forcedTier: ModelTier | null = null;

  constructor(config: ModelRouterConfig) {
    this.config = config;
  }

  /** 强制指定 tier（/model 命令）。 */
  forceTier(tier: ModelTier | null): void {
    this.forcedTier = tier;
  }

  getForcedTier(): ModelTier | null {
    return this.forcedTier;
  }

  /** 路由决策：根据任务特征选择模型。 */
  route(context: {
    userMessage?: string;
    toolNames?: string[];
    contextLength?: number;
    turnCount?: number;
  }): RoutingDecision {
    /* 用户强制指定 */
    if (this.forcedTier) {
      return this.resolveTier(this.forcedTier, '用户强制指定');
    }

    const { userMessage = '', toolNames = [], contextLength = 0, turnCount = 0 } = context;

    /* 1. 关键词判断 */
    if (COMPLEX_KEYWORDS.test(userMessage)) {
      return this.resolveTier('pro', '复杂任务关键词');
    }
    if (SIMPLE_KEYWORDS.test(userMessage) && toolNames.length <= 1) {
      return this.resolveTier('flash', '简单查询任务');
    }

    /* 2. 工具类型判断 */
    const hasWrite = toolNames.some((t) => WRITE_TOOLS.has(t));
    const allReadOnly = toolNames.length > 0 && toolNames.every((t) => READ_ONLY_TOOLS.has(t));
    if (allReadOnly && toolNames.length <= 2) {
      return this.resolveTier('flash', '只读工具');
    }
    if (hasWrite && toolNames.length >= 3) {
      return this.resolveTier('pro', '多工具写入');
    }

    /* 3. 上下文长度判断 */
    const threshold = this.config.contextThreshold ?? 50_000;
    if (contextLength > threshold) {
      return this.resolveTier('pro', '长上下文');
    }

    /* 4. 轮次判断（多轮对话后期倾向 pro） */
    if (turnCount > 10) {
      return this.resolveTier('pro', '多轮对话后期');
    }

    /* 默认 */
    return this.resolveTier('default', '默认路由');
  }

  private resolveTier(tier: ModelTier, reason: string): RoutingDecision {
    let model: string;
    switch (tier) {
      case 'flash':
        model = this.config.flashModel ?? this.config.defaultModel;
        break;
      case 'pro':
        model = this.config.proModel ?? this.config.defaultModel;
        break;
      default:
        model = this.config.defaultModel;
    }
    return { model, tier, reason };
  }
}
