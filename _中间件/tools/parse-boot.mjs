#!/usr/bin/env node
/** 从 DSH index.html 提取 __DSH_BOOT__ 并分析连接配置。 */
import { readFileSync } from 'node:fs';

const html = readFileSync(process.env.TEMP + '/dshidx.html', 'utf8');
const marker = 'globalThis["__DSH_BOOT__"] = ';
const start = html.indexOf(marker);
if (start < 0) { console.log('未找到 __DSH_BOOT__'); process.exit(1); }

const open = start + marker.length;
// 平衡花括号找到 JSON 结束
let depth = 0, end = -1, inStr = false, esc = false;
for (let i = open; i < html.length; i++) {
  const ch = html[i];
  if (inStr) {
    if (esc) esc = false;
    else if (ch === '\\') esc = true;
    else if (ch === '"') inStr = false;
    continue;
  }
  if (ch === '"') { inStr = true; continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}

const boot = JSON.parse(html.slice(open, end));
console.log('rev:', boot.rev);
console.log('顶层键:', Object.keys(boot).join(', '));
console.log('entries 数:', boot.entries.length);
console.log('');

console.log('=== 顶层配置字段（非 entries）===');
for (const [k, v] of Object.entries(boot)) {
  if (k === 'entries') continue;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  console.log(`  ${k}: ${s.slice(0, 300)}`);
}
console.log('');

console.log('=== connection/gateway 相关 entry ===');
for (const e of boot.entries) {
  if (/connection|gateway/i.test(e.id)) {
    console.log(`  id: ${e.id}`);
    console.log(`    url: ${e.url}`);
    console.log(`    inject: ${(e.inject || []).join(', ')}`);
  }
}

console.log('');
console.log('=== 是否出现 host/port 相关信息 ===');
for (const kw of ['19387', '127.0.0.1', 'ws://', 'wss://', 'authority', 'root']) {
  const n = html.split(kw).length - 1;
  console.log(`  ${kw}: ${n} 次`);
}

console.log('');
console.log('=== __DSH_CONNECTION_RECOVERY__ 等全局配置 ===');
for (const m of html.matchAll(/globalThis\["(__DSH_[A-Z_]+__)"\]\s*=\s*(\{[^<]*?\})/g)) {
  console.log(`  ${m[1]} = ${m[2].slice(0, 200)}`);
}
