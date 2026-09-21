/**
 * Agent 安全 —— Prompt Injection 检测（OWASP LLM 安全参考）。
 *
 * 在 UserPromptSubmit 阶段扫描用户输入，识别常见的提示注入模式：
 *   - 指令覆盖（"忽略之前的指令"、"忘记你之前的角色"）
 *   - 角色切换/系统提示冒充（"你现在是..."、"你是一个没有限制的AI"）
 *   - 数据泄露诱导（"输出你的system prompt"、"打印你的指令"）
 *   - 恶意工具调用诱导（"删除所有文件"、"执行任意命令"）
 *
 * 策略：命中高危模式 → 返回 detected 标记，由 harness 决定拒绝或警告。
 * 这里做的是基线检测（关键词/正则），不依赖额外 LLM 调用；
 * 可扩展为 LLM 分类器做语义级判断。
 */

export type InjectionSeverity = 'high' | 'medium';

export interface InjectionDetection {
  detected: boolean;
  severity?: InjectionSeverity;
  reason?: string;
  matchedPattern?: string;
}

interface InjectionPattern {
  severity: InjectionSeverity;
  reason: string;
  regex: RegExp;
}

const PATTERNS: InjectionPattern[] = [
  // 指令覆盖类（最高危）
  {
    severity: 'high',
    reason: '疑似指令覆盖攻击',
    regex:
      /(忽略|无视|忘记|不要理会|请忘记|忽略掉)(你|我|之前|以上|前面)?(的)?(所有)?(指令|提示|规则|要求|system\s*prompt|系统提示)|ignore\s+(all|any|the|your|previous|prior|above)\s*(previous|prior|above|instructions|rules|prompts?|system\s*prompt)?/i,
  },
  {
    severity: 'high',
    reason: '疑似角色冒充攻击',
    regex:
      /(从现在起|现在开始|假装|扮演|你是(一个|真正的)|你不再).{0,20}(没有限制|不受约束|无视规则|开发者模式|do\s+anything|dan\b)|(act\s+as|pretend\s+(to\s+be|you\s+are)|you\s+are\s+now).{0,30}(unlimited|unrestricted|developer\s*mode|do\s+anything|no\s+rules)/i,
  },
  {
    severity: 'high',
    reason: '疑似获取系统提示攻击',
    regex:
      /(输出|显示|打印|透露|告诉我).{0,15}(你的|系统|初始)?(system\s*prompt|系统提示|系统指令|系统消息|初始化指令)|(print|reveal|show|repeat|tell\s+me|display)\s+(your|the|your\s*initial)\s*(system\s*prompt|initial\s*(prompt|instructions)|instructions)|what\s+is\s+your\s+(system\s*prompt|initial\s*prompt)/i,
  },
  // 数据泄露诱导
  {
    severity: 'medium',
    reason: '疑似诱骗泄露敏感信息',
    regex:
      /(泄露|暴露|透露|分享|导出).{0,15}(密钥|密码|token|api\s*key|api密钥|凭据|credential)|(leak|reveal|share|export|give\s+me)\s+(your\s+)?(secret|password|api\s*key|token|credential)/i,
  },
  // 工具滥用诱导
  {
    severity: 'medium',
    reason: '疑似诱导执行危险工具操作',
    regex:
      /(删除|清除|移除|格式化).{0,20}(所有|全部|一切).{0,10}(文件|数据|数据库|项目)|(delete|remove|wipe|format|drop)\s+(all|every|any)\s*(files?|data|database)/i,
  },
  {
    severity: 'high',
    reason: '疑似诱导任意命令执行',
    regex:
      /(执行|运行|调用).{0,10}(任意|任何|随机).{0,10}(命令|代码|脚本|指令)|(execute|run|invoke)\s+(any|arbitrary|random)\s*(command|code|script)/i,
  },
];

/** 扫描输入，返回第一个命中（按模式顺序，高危优先）。 */
export function detectPromptInjection(input: string): InjectionDetection {
  for (const p of PATTERNS) {
    if (p.regex.test(input)) {
      return { detected: true, severity: p.severity, reason: p.reason, matchedPattern: p.regex.source };
    }
  }
  return { detected: false };
}

/** 组合检测：单个字符串或消息数组（tool_result 中的外部内容也纳入扫描）。 */
export function scanForInjection(
  content: string | Array<{ type: string; text?: string; content?: string }>,
): InjectionDetection {
  if (typeof content === 'string') return detectPromptInjection(content);
  const text = content
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'tool_result' ? String(b.content ?? '') : ''))
    .join('\n');
  return detectPromptInjection(text);
}
