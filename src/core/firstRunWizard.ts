/**
 * 首次启动向导 —— 交互式配置 provider / Key / 模型并验证连接。
 *
 * 承重不变量：
 *   - 密钥通过 askSecret 读取，验证通过前不写入 .env / 不落盘，失败可重试；
 *   - 验证失败只返回可操作错误信息，不抛异常拖垮启动；
 *   - 用户 EOF / 取消 → 返回 null，由调用方回退到静态引导。
 */

export type WizardProtocol = 'openai' | 'anthropic';

export interface WizardResult {
  protocol: WizardProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WizardDeps {
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
  log: (msg: string) => void;
}

function extractApiError(data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as { error?: { message?: string }; message?: string };
    if (d.error?.message) return d.error.message;
    if (d.message) return d.message;
  }
  return JSON.stringify(data).slice(0, 200);
}

/** 统一脱敏：去掉 endpoint / Authorization / api-key / 堆栈，截断到 ≤200 字符。 */
export function sanitizeError(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e);
  msg = msg.replace(/https?:\/\/[^\s'")]+/g, '<endpoint>');
  msg = msg.replace(/bearer\s+\S+/gi, 'Bearer ***');
  msg = msg.replace(/(sk|oc_sk)-[A-Za-z0-9._-]+/g, '***');
  msg = msg.replace(/\s+at\s+[^\s].*/g, '');
  return msg.trim().slice(0, 200);
}

async function verifyConnection(r: WizardResult): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    if (r.protocol === 'openai') {
      const url = `${r.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${r.apiKey}`,
          /* opencode 网关需要会话路由头；标准 OpenAI 兼容端点会忽略该头，无害 */
          'x-opencode-session': `wizard-${Math.random().toString(36).slice(2, 10)}`,
        },
        body: JSON.stringify({
          model: r.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await resp.json()) as unknown;
      if (!resp.ok) return { ok: false, error: sanitizeError(`HTTP ${resp.status}: ${extractApiError(data)}`) };
      const model = (data as { model?: string }).model ?? r.model;
      return { ok: true, model };
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: r.apiKey, baseURL: r.baseUrl, maxRetries: 0, timeout: 15000 });
    const m = await client.messages.create({
      model: r.model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, model: m.model };
  } catch (e) {
    return { ok: false, error: sanitizeError(e) };
  }
}

export async function runFirstRunWizard(deps: WizardDeps): Promise<WizardResult | null> {
  const { ask, askSecret, log } = deps;

  const protoAnswer = (
    await ask('选择协议 [1=OpenAI 兼容(DeepSeek/百炼/OpenAI)  2=Anthropic 兼容]（回车=1）: ')
  ).trim();
  const protocol: WizardProtocol = protoAnswer === '2' ? 'anthropic' : 'openai';

  const defUrl = protocol === 'openai' ? 'https://api.deepseek.com/v1' : 'https://api.anthropic.com';
  const baseUrl = (await ask(`Base URL（回车用 ${defUrl}）: `)).trim() || defUrl;

  const defModel = protocol === 'openai' ? 'deepseek-flash' : 'claude-sonnet-4-6';
  const model = (await ask(`模型（回车用 ${defModel}）: `)).trim() || defModel;

  const apiKey = (await askSecret('API Key（不回显，验证通过前不落盘）: ')).trim();
  if (!apiKey) {
    log('未输入 Key，已取消配置。');
    return null;
  }

  const result: WizardResult = { protocol, baseUrl, apiKey, model };

  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`正在验证连接（第 ${attempt} 次）…`);
    const v = await verifyConnection(result);
    if (v.ok) {
      log(`连接成功 ✅ model=${v.model}`);
      return result;
    }
    log(`连接失败 ❌ ${v.error}`);
    if (attempt >= 3) return null;
    const retry = (await ask('是否重新输入 Key 后重试？[y/N] ')).trim().toLowerCase();
    if (retry !== 'y' && retry !== 'yes') return null;
    const newKey = (await askSecret('重新输入 API Key: ')).trim();
    if (!newKey) return null;
    result.apiKey = newKey;
  }
  return null;
}

// 修改记录：
//   2026-10-03 新增：首次启动交互式向导（provider/Key/模型选择 + 连接验证，密钥验证通过前不落盘）
