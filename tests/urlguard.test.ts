/**
 * P1 回归：web_extractor SSRF 防护。
 * 127.0.0.1 / 169.254.169.254（云 metadata）/ 192.168.x.x 等必须拒绝；
 * 全程用 IP 字面量与主机名黑名单断言，不发起真实网络请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, assertPublicUrl, hostMatchesAllowlist } from '../src/core/urlguard.js';
import { webExtractor } from '../src/tools/web.js';

test('isBlockedIp: loopback / 私网 / link-local / metadata / multicast / reserved 全部拦截', () => {
  const blocked = [
    '127.0.0.1',
    '127.8.8.8', // loopback
    '10.1.2.3', // 私有 A 类
    '172.16.0.1',
    '172.31.255.255', // 私有 B 类
    '192.168.0.1',
    '192.168.255.255', // 私有 C 类
    '169.254.169.254', // 云 metadata
    '169.254.1.1', // link-local
    '100.64.0.1', // CGNAT
    '0.0.0.0', // 未指定
    '224.0.0.1',
    '239.255.255.255', // multicast
    '240.0.0.1',
    '255.255.255.255', // reserved / 广播
    '::1',
    '::', // IPv6 loopback / 未指定
    'fe80::1', // IPv6 link-local
    'fd12:3456::1',
    'fc00::1', // IPv6 ULA 私网
    'ff02::1', // IPv6 multicast
    '::ffff:192.168.1.1', // IPv4-mapped 私网
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIp(ip), true, `${ip} 必须被拦截`);
  }
});

test('isBlockedIp: 公网地址放行', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    assert.equal(isBlockedIp(ip), false, `${ip} 应放行`);
  }
});

test('assertPublicUrl: 必须拒绝的内网 URL（含 metadata）', async () => {
  const urls = [
    'http://127.0.0.1/admin',
    'http://127.0.0.1:8080/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://10.0.0.5/',
    'http://172.20.10.2/',
    'http://localhost/secret',
    'http://foo.internal/api',
    'http://[::1]/',
    'http://[fd00::1]/',
    'file:///etc/passwd',
  ];
  for (const u of urls) {
    await assert.rejects(() => assertPublicUrl(u), undefined, `${u} 必须被拒绝`);
  }
});

test('assertPublicUrl: IP 字面量公网地址放行（不做 DNS，无网络依赖）', async () => {
  const url = await assertPublicUrl('https://93.184.216.34/page');
  assert.equal(url.hostname, '93.184.216.34');
});

test('assertPublicUrl: 白名单模式仅放行名单内主机', async () => {
  const opts = { allowedHosts: ['example.com', '93.184.216.34'] };
  /* 名单外主机：在 DNS 之前就被拒绝（无网络依赖） */
  await assert.rejects(() => assertPublicUrl('https://evil.com/x', opts), /allowlist/);
  await assert.rejects(() => assertPublicUrl('https://sub.other.com/x', opts), /allowlist/);
  await assert.rejects(() => assertPublicUrl('https://8.8.8.8/x', opts), /allowlist/);
  /* 名单内：子域名匹配（纯函数断言，避免 DNS 依赖）+ 公网 IP 放行 */
  assert.equal(hostMatchesAllowlist('cdn.example.com', ['example.com']), true);
  assert.equal(hostMatchesAllowlist('example.com', ['example.com']), true);
  assert.equal(hostMatchesAllowlist('notexample.com', ['example.com']), false);
  const okIp = await assertPublicUrl('https://93.184.216.34/', opts);
  assert.ok(okIp instanceof URL);
  /* 白名单不能豁免内网地址 */
  await assert.rejects(() => assertPublicUrl('https://127.0.0.1/', { allowedHosts: ['127.0.0.1'] }), /Blocked/);
});

test('web_extractor: 内网/metadata 地址直接拒绝（不发起请求）', async () => {
  const r1 = await webExtractor('http://127.0.0.1/');
  assert.ok(/Blocked|private|loopback/i.test(r1), `实际: ${r1}`);
  const r2 = await webExtractor('http://169.254.169.254/latest/meta-data/');
  assert.ok(/Blocked|private|link-local/i.test(r2), `实际: ${r2}`);
  const r3 = await webExtractor('http://192.168.0.100/');
  assert.ok(/Blocked|private/i.test(r3), `实际: ${r3}`);
  const r4 = await webExtractor('file:///etc/passwd');
  assert.ok(r4.includes('仅支持 http/https'));
});
