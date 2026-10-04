// 在二进制中搜索关键字，输出周围的可打印字符串
// 用法: node scan-binary.js <file> <keyword> [context=80] [max=60]
'use strict';
const fs = require('fs');
const [file, kw, ctxArg, maxArg] = process.argv.slice(2);
const ctx = Number(ctxArg || 80);
const max = Number(maxArg || 60);
const buf = fs.readFileSync(file);
const needle = Buffer.from(kw, 'utf8');
const seen = new Set();
let pos = 0;
let count = 0;
const printable = (b) => b >= 0x20 && b <= 0x7e;
while ((pos = buf.indexOf(needle, pos)) !== -1 && count < max) {
  let s = pos;
  while (s > 0 && pos - s < ctx && printable(buf[s - 1])) s--;
  let e = pos + needle.length;
  while (e < buf.length && e - pos < ctx + needle.length && printable(buf[e])) e++;
  const str = buf.slice(s, e).toString('latin1');
  if (!seen.has(str)) {
    seen.add(str);
    console.log(`@${pos}: ${str}`);
    count++;
  }
  pos += needle.length;
}
console.log(`-- ${count} unique hits shown`);
