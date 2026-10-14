#!/usr/bin/env node
/**
 * DSH 远程接入反向代理（原型验证版）。
 *
 * 作用：让「非 loopback」的客户端能访问只监听 127.0.0.1 的 DSH，
 *       且【完全不改动 DSH 的任何配置】。
 *
 * 原理：DSH 的请求信任栅栏与 cookie 都绑定 `authority`（Host 头）：
 *   - 栅栏要求 Host 是 loopback 或 trustedHosts 条目
 *   - cookie 名 = 'dsh-auth-' + sha256(authority)
 * 所以本代理在转发时把 Host / Origin 重写回 '127.0.0.1:19387'，
 * DSH 侧看到的就与本地浏览器完全一致。
 */
import http from 'node:http';
import net from 'node:net';

const LISTEN_HOST = process.env.PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PROXY_PORT || 18080);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 19387;
const REWRITE_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

/** 把请求头里的 Host / Origin 重写回 loopback authority。 */
function rewriteHeaders(headers) {
  const out = { ...headers };
  out.host = REWRITE_AUTHORITY;
  if (out.origin !== undefined) {
    out.origin = `http://${REWRITE_AUTHORITY}`;
  }
  // 告诉上游这是同源导航/请求，配合 DSH 的 sec-fetch-site 校验
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

// ── 配对入口 ────────────────────────────────────────────────
// 手机首次访问时没有 cookie，会看到 DSH 的 401。
//
// 有两条配对通道：
//   A. /__pair?k=<一次性密钥>  —— 手动配对，密钥每次启动随机生成、用完即焚。
//      适合在「浏览器」里用，或者把链接发给手机。
//   B. /__pairauto             —— 自动配对，专供本 App 使用（见下）。
//
// 为什么 B 通道可以免密钥：
//   代理【只绑 Tailscale 网卡】，而 Tailscale 是私有加密网络 ——
//   能连到这个端口的前提是「已经在这条 tailnet 里」。
//   也就是说，能在网络层碰到这个入口的设备，本身就已被 Tailscale 认证过。
//   所以免密钥不会扩大暴露面：局域网与公网都摸不到这个端口。
//   它换来的好处是 App 无需主人手动粘贴任何东西。
//
// ⚠️ 这条设计依赖「代理只绑 Tailscale 网卡」这个前提。
//    如果把 PROXY_HOST 改成 0.0.0.0，务必同时删掉 B 通道。
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PAIR_KEY = process.env.PAIR_KEY || randomBytes(16).toString('hex');
let pairUsed = false;

/** 读取已签好的 cookie，返回 "name=value"；失败时抛错。 */
function readCookie() {
  const j = JSON.parse(readFileSync(process.env.COOKIE_FILE, 'utf8'));
  return `${j.cookieName}=${j.cookieValue}`;
}

/** 统一下发 cookie 并跳回首页。 */
function grantCookie(res) {
  const cookie = readCookie();
  res.writeHead(302, {
    // 不设 Domain，让客户端按「当前 host」绑定 —— 这正是 DSH 要的 authority
    'Set-Cookie': `${cookie}; Path=/; Max-Age=2592000; SameSite=Lax`,
    'Location': '/',
  });
  res.end();
}

function tryPair(req, res, urlObj) {
  const p = urlObj.pathname;

  // ── 通道 B：自动配对（App 用）──
  if (p === '/__pairauto') {
    try {
      grantCookie(res);
      console.log('自动配对：已下发 cookie 并重定向到 /');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('读取 cookie 文件失败: ' + e.message);
    }
    return true;
  }

  // ── 通道 A：手动配对（一次性密钥）──
  if (p !== '/__pair') return false;

  const k = urlObj.searchParams.get('k') || '';
  const a = Buffer.from(k);
  const b = Buffer.from(PAIR_KEY);
  const ok = !pairUsed && a.length === b.length && timingSafeEqual(a, b);

  if (!ok) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(pairUsed ? '配对密钥已使用过（一次性）。重启代理可生成新密钥。'
                     : '配对密钥不正确。');
    return true;
  }

  let cookie;
  try {
    cookie = readCookie();
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('读取 cookie 文件失败: ' + e.message);
    return true;
  }

  pairUsed = true;   // 用完即焚
  res.writeHead(302, {
    'Set-Cookie': `${cookie}; Path=/; Max-Age=2592000; SameSite=Lax`,
    'Location': '/',
  });
  res.end();
  console.log('配对成功：已下发 cookie 并重定向到 /');

  return true;
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://placeholder');
  if (tryPair(req, res, urlObj)) return;

  const opts = {
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers: rewriteHeaders(req.headers),
  };
  const up = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy upstream error: ' + e.message);
  });
  req.pipe(up);
});

// WebSocket / 其他 Upgrade 转发。
// 注意：实测 DSH 的 RPC 走 fetch() 流式响应，前端 bundle 里 WebSocket 出现 0 次，
// 所以正常情况下这个分支不会被触发 —— 留着纯属保险，哪天真出现 upgrade 也不至于断。
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    // 手工重建请求行 + 重写后的头
    const headers = rewriteHeaders(req.headers);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const vv of v) raw += `${k}: ${vv}\r\n`;
      else raw += `${k}: ${v}\r\n`;
    }
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`DSH 反向代理已启动: http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${REWRITE_AUTHORITY}`);
  console.log(`Host/Origin 将重写为: ${REWRITE_AUTHORITY}`);
  console.log('');
  console.log('手机首次配对（打开一次即可，密钥一次性）:');
  console.log(`  http://${LISTEN_HOST}:${LISTEN_PORT}/__pair?k=${PAIR_KEY}`);
  console.log('');
});
