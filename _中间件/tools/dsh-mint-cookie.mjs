#!/usr/bin/env node
/**
 * 为 DSH 手机版签发浏览器会话 cookie。
 *
 * 原理：DSH 的 Web 认证 cookie 由 $DSH_HOME/.credentials.yaml 中
 * client-connection/browser-session 记录的持久密钥做 HMAC-SHA256 签名。
 * 本脚本读取该密钥，为指定 authority 签发一个合法的会话 cookie，
 * 供手机端 APK 在 adb reverse 隧道下使用。
 *
 * cookie 名 = 'dsh-auth-' + base64url(sha256(authority))
 * cookie 值 = 'v1.' + base64url(JSON payload) + '.' + base64url(hmac-sha256(secret, body))
 * payload   = { version: 1, authority, issuedAt, expiresAt }
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 86400000;
const DEFAULT_AUTHORITY = '127.0.0.1:19387';
const DEFAULT_MAX_AGE_DAYS = 30;
const RECORD_KEY = 'client-connection/browser-session';
const SECRET_BYTES = 32;

/** base64url 编码（去 padding）。 */
function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** base64url 解码。 */
function unb64u(text) {
  return Buffer.from(text, 'base64url');
}

/** 从 .credentials.yaml 提取 browser-session 的签名密钥。 */
function readSecret(credPath) {
  const text = readFileSync(credPath, 'utf8');
  const idx = text.indexOf(RECORD_KEY + ':');
  if (idx < 0) throw new Error(`${RECORD_KEY} 记录不存在于 ${credPath}`);
  // 只在该记录附近查找 secret，避免误取其他记录的字段
  const seg = text.slice(idx, idx + 400);
  const m = /^\s*secret:\s*([A-Za-z0-9_-]+)\s*$/m.exec(seg);
  if (!m) throw new Error('记录中缺少 secret 字段');
  const secret = unb64u(m[1]);
  if (secret.byteLength !== SECRET_BYTES) {
    throw new Error(`密钥长度异常：${secret.byteLength} 字节（期望 ${SECRET_BYTES}）`);
  }
  return secret;
}

/** cookie 名。 */
function cookieName(authority) {
  return 'dsh-auth-' + b64u(createHash('sha256').update(authority, 'utf8').digest());
}

/** 签发 cookie。 */
function makeCookie(authority, secret, maxAgeDays) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * DAY_MS;
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64u(createHmac('sha256', secret).update(body, 'ascii').digest());
  return { name: cookieName(authority), value: `v1.${body}.${sig}`, payload };
}

/** 自校验：用同一密钥回读签出的 cookie。 */
function verifyCookie(value, secret) {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const [, body, sig] = parts;
  const expect = b64u(createHmac('sha256', secret).update(body, 'ascii').digest());
  const a = unb64u(sig), b = unb64u(expect);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) return false;
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const dshHome = args[0] || process.env.DSH_HOME || join(homedir(), '.dsh');
  const authority = args[1] || DEFAULT_AUTHORITY;
  const maxAgeDays = Number(args[2] || DEFAULT_MAX_AGE_DAYS);

  const credPath = join(dshHome, '.credentials.yaml');
  const secret = readSecret(credPath);
  const { name, value, payload } = makeCookie(authority, secret, maxAgeDays);
  if (!verifyCookie(value, secret)) throw new Error('自校验失败：签出的 cookie 无法回读');

  const out = {
    authority,
    cookieName: name,
    cookieValue: value,
    setCookie: `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeDays * 86400}`,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    maxAgeDays,
  };
  writeFileSync(join(process.cwd(), 'cookie.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}

main();
