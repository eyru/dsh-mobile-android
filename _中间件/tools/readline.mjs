#!/usr/bin/env node
/** 精确读取指定行的完整内容，避免 grep/read 的截断。 */
import { readFileSync } from 'node:fs';

const f = process.argv[2];
const lineNo = Number(process.argv[3]);
const lines = readFileSync(f, 'utf8').split(/\r?\n/);
const line = lines[lineNo - 1];

console.log('=== 行 ' + lineNo + ' 完整内容（长度 ' + line.length + '）===');
console.log(line);
console.log('');
console.log('=== 是否含 "§4.30" ===', line.includes('§4.30'));
console.log('=== 是否含 "详见" ===', line.includes('详见'));
