/**
 * URL 安全守卫 —— web 工具的 SSRF 防护。
 *
 * 拒绝目标：loopback / 私有网段 / link-local（含云 metadata 169.254.169.254）/
 * multicast / reserved / CGNAT / IPv6 ULA 等一切非公网地址，以及
 * localhost / *.local / *.internal 等主机名。
 *
 * 绕过对策：
 *   1. 域名先 DNS 解析，任一解析地址落在私网即拒绝（防域名绕过 IP 检查）；
 *   2. 重定向逐跳校验（redirect: manual + 每跳重新过守卫），防 302 跳板进内网；
 *   3. 可配置公网白名单（WEB_ALLOWED_HOSTS）：非空时仅放行名单内主机。
 *
 * 已知取舍：DNS 预检与 fetch 再次解析之间存在理论上的 DNS-rebinding 窗口；
 * 生产环境应叠加出口代理或网络层 ACL（文档已注明）。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export interface UrlGuardOptions {
  /** 公网白名单：非空时仅允许列表内主机（精确匹配或 *.suffix）。 */
  allowedHosts?: string[];
}

const BLOCKED_HOST_RX = /(^|\.)local$|(^|\.)internal$|^localhost$/i;

/** 主机白名单匹配：精确匹配或子域名（*.suffix）匹配。导出供测试。 */
export function hostMatchesAllowlist(host: string, allowedHosts: string[]): boolean {
  const h = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.length > 0 && (h === e || h.endsWith('.' + e));
  });
}

/** 判断一个 IP（v4/v6 字面量）是否属于被禁止的内网/保留地址。 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true; // 无法识别一律拒绝
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 私有
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + 云 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私有
  if (a === 192 && b === 168) return true; // 192.168/16 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && (b === 0 || b === 2)) return true; // 192.0.0/24 保留、192.0.2/24 测试
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51) return true; // 198.51.100/24 测试
  if (a === 203 && b === 0) return true; // 203.0.113/24 测试
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 广播
  return false;
}

function isBlockedV6(ip: string): boolean {
  const v6 = ip.toLowerCase();
  // IPv4-mapped（::ffff:1.2.3.4）→ 按内嵌 v4 判断
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  const groups = expandV6(v6);
  if (!groups) return true;
  const g0 = groups[0];
  if (groups.every((g) => g === 0)) return true; // :: 未指定
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA 私网
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && groups[1] === 0xdb8) return true; // 2001:db8::/32 文档
  return false;
}

/** 展开 '::' 为 8 组 16 位数值；非法返回 null。 */
function expandV6(ip: string): number[] | null {
  let addr = ip;
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  if (addr.includes('.')) {
    // 尾部内嵌 v4（如 fe80::1.2.3.4）→ 转两组十六进制
    const idx = addr.lastIndexOf(':');
    const v4 = addr.slice(idx + 1);
    if (!net.isIPv4(v4)) return null;
    const [a, b, c, d] = v4.split('.').map(Number);
    addr = addr.slice(0, idx + 1) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null =>
    s === ''
      ? []
      : s.split(':').map((h) => {
          if (!/^[0-9a-f]{1,4}$/.test(h)) return NaN;
          return parseInt(h, 16);
        });
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail || head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/**
 * 校验 URL 可安全抓取；不安全则抛错。
 * 返回解析后的 URL（供调用方继续 fetch）。
 */
export async function assertPublicUrl(rawUrl: string, opts: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('Empty host');

  /* 白名单模式：仅放行名单内主机 */
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    if (!hostMatchesAllowlist(host, opts.allowedHosts)) {
      throw new Error(`Blocked: host '${host}' not in WEB_ALLOWED_HOSTS allowlist`);
    }
  }

  /* IP 字面量直接判断 */
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Blocked: ${host} is a private/loopback/link-local/reserved address`);
    return url;
  }

  /* 主机名黑名单 */
  if (BLOCKED_HOST_RX.test(host)) throw new Error(`Blocked host: ${host}`);

  /* DNS 解析：任一地址落在私网即拒绝 */
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`DNS lookup failed for ${host}`);
  }
  if (addrs.length === 0) throw new Error(`No DNS records for ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`Blocked: ${host} resolves to private/reserved address ${a.address}`);
    }
  }
  return url;
}

/**
 * 带重定向防护的抓取：每跳都重新过 assertPublicUrl（防 302 跳板进内网）。
 */
export async function fetchGuarded(
  rawUrl: string,
  opts: UrlGuardOptions & { init?: RequestInit; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const url = await assertPublicUrl(current, opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    let resp: Response;
    try {
      resp = await fetch(url, { ...opts.init, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const status = resp.status;
    if (status >= 300 && status < 400) {
      const location = resp.headers.get('location');
      if (!location || hop >= maxRedirects) throw new Error('Redirect limit exceeded');
      current = new URL(location, url).toString();
      continue;
    }
    return resp;
  }
}
