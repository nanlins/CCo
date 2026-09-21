/**
 * 配置管理 —— 让用户（部署者/使用者）方便地配置模型和 API key。
 *
 * 功能：
 *   1. 检查配置是否完整（有无 apiKey / model）
 *   2. 将用户配置写入 .env（持久化）
 *   3. 启动引导文案（无 key 时提示如何配置）
 *
 * 安全：.env 已被 .gitignore 排除，不会推送到 GitHub。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface UserConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 检查工作区是否已有 .env。 */
export function hasEnvFile(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.env'));
}

/** 检查是否已配置 apiKey（.env 或环境变量）。 */
export function hasApiKey(workspaceDir: string): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || readEnvValue(workspaceDir, 'ANTHROPIC_API_KEY').length > 0;
}

/** 读取 .env 中某个变量的值。 */
export function readEnvValue(workspaceDir: string, key: string): string {
  const envFile = path.join(workspaceDir, '.env');
  if (!fs.existsSync(envFile)) return '';
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0 && trimmed.slice(0, eq).trim() === key) {
        return trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* 忽略 */
  }
  return '';
}

/** 写入 .env（新增或更新变量）。 */
export function setEnvValue(workspaceDir: string, key: string, value: string): void {
  const envFile = path.join(workspaceDir, '.env');
  let lines: string[] = [];
  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, 'utf8').split('\n');
  }
  const newLine = `${key}=${value}`;
  const idx = lines.findIndex((l) => {
    const trimmed = l.trim();
    return !trimmed.startsWith('#') && trimmed.split('=')[0]?.trim() === key;
  });
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(envFile, lines.join('\n'), 'utf8');
}

/** 保存用户配置到 .env（持久化）。 */
export function saveUserConfig(workspaceDir: string, cfg: UserConfig): void {
  if (cfg.apiKey) setEnvValue(workspaceDir, 'ANTHROPIC_API_KEY', cfg.apiKey);
  if (cfg.baseUrl) setEnvValue(workspaceDir, 'ANTHROPIC_BASE_URL', cfg.baseUrl);
  if (cfg.model) setEnvValue(workspaceDir, 'MODEL_ID', cfg.model);
}

/** 生成配置引导文案（启动时无 key 时展示）。 */
export function configGuide(workspaceDir: string): string {
  const envFile = path.join(workspaceDir, '.env');
  const hasEnv = fs.existsSync(envFile);
  const lines: string[] = [];
  lines.push('未检测到模型配置，当前为离线演示模式（MOCK）。');
  lines.push('');
  lines.push('配置真实模型有两种方式：');
  lines.push('');
  if (hasEnv) {
    lines.push('  方式1：编辑 ' + envFile + ' 文件');
    lines.push('        填写 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL、MODEL_ID');
  } else {
    lines.push('  方式1：复制 .env.example 为 .env 并填写');
    lines.push('        （示例见 .env.example，含 DeepSeek/GLM/Kimi/MiniMax 配置）');
  }
  lines.push('');
  lines.push('  方式2：启动后输入命令（本会话生效）');
  lines.push('        /apikey sk-你的key     设置 API key');
  lines.push('        /model 模型ID         切换模型');
  lines.push('        /config               查看当前配置');
  lines.push('');
  lines.push('支持的模型（Anthropic 兼容端点）：');
  lines.push('  DeepSeek:  baseUrl=https://api.deepseek.com/anthropic');
  lines.push('  GLM:       baseUrl=https://open.bigmodel.cn/api/anthropic');
  lines.push('  Kimi:      baseUrl=https://api.moonshot.cn/anthropic');
  lines.push('  MiniMax:   baseUrl=https://api.minimaxi.com/anthropic');
  lines.push('');
  lines.push('输入 /help 查看所有命令。');
  return lines.join('\n');
}
