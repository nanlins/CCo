/**
 * 受保护路径 —— Agent 不得修改自己的权限状态、信任状态与密钥文件。
 *
 * 双重拦截：
 *   1. PermissionGate（permission.ts）：写工具命中保护路径 → deny（先于 settings allow 规则）；
 *   2. 文件工具执行器（fs.ts）：write/edit/delete 执行前再查一次（防绕过权限层的直接调用）。
 *
 * 读取侧：.env 等密钥文件同样禁止读取（防密钥进入上下文）；
 * settings/trusted 等状态文件允许读（只读不改变安全边界）。
 */
import path from 'node:path';

/** 工作区内"禁止写入/编辑/删除"的相对路径（精确匹配）。 */
const PROTECTED_EXACT = new Set([
  '.env',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp/servers.json',
  '.mcp/trusted.json', // 兼容旧位置：信任存储已迁移到用户级目录，工作区副本一律冻结
]);

/** 工作区内"禁止写入"的路径前缀（目录级）。 */
const PROTECTED_PREFIXES = ['.claude/', '.mcp/'];

/** 密钥/凭据文件名模式（写禁 + 读禁）。注意排除 .env.example 等模板文件。 */
const SECRET_FILE_RX =
  /(^|[/\\])(\.env(\.(?!example$|sample$|template$).+)?|\.npmrc|\.netrc|\.htpasswd|id_rsa|id_ed25519|id_ecdsa|credentials(\.json)?|secrets?(\.[a-z]+)?|authorized_keys|known_hosts|token(\.json)?|\.aws[/\\]credentials|\.kube[/\\]config|.+\.pem|.+\.key|.+\.p12|.+\.pfx)$/i;

function normalizeRel(workdir: string, p: string): string {
  const resolved = path.resolve(workdir, p);
  const rel = path.relative(workdir, resolved);
  return rel.split(path.sep).join('/');
}

/** 该路径是否为受保护的写入目标（write/edit/delete 必须拒绝）。 */
export function isProtectedWritePath(workdir: string, p: string): boolean {
  const rel = normalizeRel(workdir, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // 路径逃逸由其它检查处理
  if (PROTECTED_EXACT.has(rel)) return true;
  for (const prefix of PROTECTED_PREFIXES) {
    if (rel.startsWith(prefix)) return true;
  }
  return SECRET_FILE_RX.test(rel);
}

/** 该路径是否为密钥文件（读取必须拒绝，防密钥进入模型上下文）。 */
export function isSecretReadPath(workdir: string, p: string): boolean {
  const rel = normalizeRel(workdir, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    /* 工作区外路径：只按文件名模式判断（EXTRA_READ_ROOTS 场景） */
    return SECRET_FILE_RX.test(p.split(/[/\\]/).join('/'));
  }
  return SECRET_FILE_RX.test(rel);
}

/** 供错误消息/测试使用的保护原因。 */
export function protectedReason(p: string): string {
  return `受保护路径（权限/信任/密钥状态）: ${p} — agent 不得修改自身权限与信任状态`;
}
