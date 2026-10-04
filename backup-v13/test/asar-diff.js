// 诊断：对任意 app.asar 逐条报告补丁命中情况，并打印未命中锚点的上下文
//   node test/asar-diff.js <app.asar> [bundle 文件路径（可选，直接分析裸 bundle）]
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../lib/launcher-core.js');

const target = process.argv[2];
if (!target) { console.error('用法: node test/asar-diff.js <app.asar|bundle.js> [initial|shared|primary]'); process.exit(2); }
// 用 asar 头部魔数判断，而不是文件名后缀（备份文件常叫 app.asar.backup-xxx）
let bare = true;
if (fs.existsSync(target)) {
  const fd = fs.openSync(target, 'r');
  const b = Buffer.alloc(16);
  const n = fs.readSync(fd, b, 0, 16, 0);
  fs.closeSync(fd);
  if (n === 16 && b.readUInt32LE(0) === 4 && b.readUInt32LE(4) > 0 && b.readUInt32LE(12) > 2 && b.readUInt32LE(12) < 1 << 30) bare = false;
}

console.log('目标:', target, fs.existsSync(target) ? `(${fs.statSync(target).size} 字节, sha256=${core.sha256File(target).slice(0, 16)}…)` : '(不存在)');
if (!fs.existsSync(target)) process.exit(2);

let role = {}, content = new Map();
if (bare) {
  const name = process.argv[3] || 'initial';
  role[name] = { rel: path.basename(target) };
  content.set(role[name].rel, fs.readFileSync(target).toString('latin1'));
} else {
  const loc = core.locateBundles(target);
  try {
    for (const [n, e] of Object.entries(loc.role)) {
      if (!e) { console.log(`  角色 ${n}: 未定位到`); continue; }
      role[n] = e;
      content.set(e.rel, loc.text(e));
      console.log(`  角色 ${n}: ${e.rel} (${e.size}B)`);
    }
  } finally { fs.closeSync(loc.fd); }
}

let bad = 0;
for (const p of core.PATCHES) {
  const e = role[p.file];
  if (!e) { console.log(`  SKIP ${p.file}/${p.note}（角色缺失）`); bad++; continue; }
  const s = content.get(e.rel);
  let actual;
  if (p.regex) actual = (s.match(new RegExp(p.regex.source, 'g')) || []).length;
  else actual = s.split(p.old).length - 1;
  const hit = actual === p.expect;
  if (!hit) bad++;
  console.log(`  ${hit ? 'OK  ' : 'MISS'} [${p.file}] ${p.note}  期望 ${p.expect} 实际 ${actual}`);
  if (!hit) {
    // 把锚点拆成较短的片段，逐个看哪一段还在
    const needle = p.old || null;
    const probe = needle ? needle : null;
    if (probe) {
      const parts = probe.split(/\)|,|\{|\}/).filter(x => x.length > 8).slice(0, 6);
      for (const part of parts) {
        const c = s.split(part).length - 1;
        console.log(`       片段 ${c ? '命中' : '缺失'}(${c}) : ${part.slice(0, 90)}`);
      }
      const at = s.indexOf(parts[0]);
      if (at >= 0) console.log('       上下文: …' + s.slice(at, at + 320) + '…');
    } else {
      // 正则锚点：用其字面量片段探测
      const lits = (p.regex.source.match(/[\w$`]{12,}/g) || []).slice(0, 4);
      for (const lit of lits) console.log(`       字面量 ${s.includes(lit) ? '命中' : '缺失'} : ${lit.slice(0, 90)}`);
    }
  }
}
console.log(bad === 0 ? '\n全部命中' : `\n${bad} 处未命中`);
