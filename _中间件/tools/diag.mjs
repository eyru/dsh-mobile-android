#!/usr/bin/env node
/** 诊断：比对 cookie 名哈希、密钥长度、签名三要素。 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const cred = readFileSync('C:/Users/hrcsn/.dsh/.credentials.yaml', 'utf8');
const idx = cred.indexOf('client-connection/browser-session:');
const seg = cred.slice(idx, idx + 400);
const m = /^\s*secret:\s*([A-Za-z0-9_-]+)\s*$/m.exec(seg);
const secretStr = m[1];
const secret = Buffer.from(secretStr, 'base64url');

console.log('secret 字符串长度:', secretStr.length);
console.log('secret 解码后字节数:', secret.byteLength);
console.log('secret base64:', secret.toString('base64'));

const authority = '127.0.0.1:19387';
const digest = createHash('sha256').update(authority, 'utf8').digest();
const cookieName = 'dsh-auth-' + digest.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
console.log('authority:', JSON.stringify(authority));
console.log('sha256 hex:', digest.toString('hex'));
console.log('cookie 名:', cookieName);

// 用 DSH 完全一致的算法签一份
function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 86400000;
const payload = { version: 1, authority, issuedAt, expiresAt };
const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
const sig = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
console.log('body:', body);
console.log('cookie 值: v1.' + body + '.' + sig);
console.log('authority 回读:', JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).authority);
