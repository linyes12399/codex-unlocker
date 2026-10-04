// Codex 桌面应用补丁：解锁 max/ultra 思考强度（保留原有 Fast 档补丁）
// 用法: node patch-and-repack.js   (只生成 app.asar.new，不直接替换原文件)
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const ASAR = 'C:/Users/86176/ChatGPT-Patched/app/resources/app.asar';
const OUT = 'F:/test/AI项目/codex修复/app.asar.new';
const BUNDLES = 'F:/test/AI项目/codex修复/webview-assets'; // 已解出的当前版 3 个 bundle

// ---------- asar 读取 ----------
function readHeader(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const jsonLen = b.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  fs.closeSync(fd);
  return { header: JSON.parse(jb.toString('utf8')), jsonLen };
}

// ---------- 补丁定义 ----------
const FLAT_BODY = 'for(let t of e){if(t.thinkingEffort==null)continue;let n=r.get(t.slug);if(n==null)r.set(t.slug,n={top:t,hasU:!1,hasM:!1});n.top=t;t.thinkingEffort===`ultra`&&(n.hasU=!0);t.thinkingEffort===`max`&&(n.hasM=!0)}for(let t of r.values()){t.hasU||e.push({...t.top,thinkingEffort:`ultra`,title:`Ultra`,selectedLabel:void 0});t.hasM||e.push({...t.top,thinkingEffort:`max`,title:`Max`,selectedLabel:void 0})}return e';
const FLAT_INJ_FN = '(e=>{let r=new Map;' + FLAT_BODY + '})';
const GROUP_INJ_FN = '(e=>{let r;for(let t of e){r=new Map;for(let n of t.options??[]){if(n.thinkingEffort==null)continue;let i=r.get(n.slug);if(i==null)r.set(n.slug,i={top:n,hasU:!1,hasM:!1});i.top=n;n.thinkingEffort===`ultra`&&(i.hasU=!0);n.thinkingEffort===`max`&&(i.hasM=!0)}if(r.size){t.options=t.options??[];for(let n of r.values()){n.hasU||t.options.push({...n.top,thinkingEffort:`ultra`,title:`Ultra`,selectedLabel:void 0});n.hasM||t.options.push({...n.top,thinkingEffort:`max`,title:`Max`,selectedLabel:void 0})}}}return e})';

const PATCHES = [
  {
    file: 'app-initial-fd3c4b862660.js',
    old: 'e.get(yg,`536305374`)', rep: '!0', expect: 4,
    note: 'gate 536305374 (ultra 保存/使用开关) -> 永远开启',
  },
  {
    file: 'app-initial-fd3c4b862660.js',
    old: 'e(yg,`536305374`)', rep: '!0', expect: 1,
    note: 'gate 536305374 (sbn 路径) -> 永远开启',
  },
  {
    file: 'app-initial-fd3c4b862660.js',
    old: '!t&&a.includes(i)&&(o=a.filter(e=>e!==i))',
    rep: '!t&&a.includes(i)&&(o=a)', expect: 1,
    note: 'a8r: 不再把 max/ultra 剔出 enabled 列表(也就不会触发 o8r 降级)',
  },
  {
    file: 'app-initial-fd3c4b862660.js',
    old: 'await o8r(e,n,r,i)', rep: '0', expect: 1,
    note: 'o8r 自动降级调用 -> 空操作(保险)',
  },
  {
    file: 'app-initial-fd3c4b862660.js',
    old: 'let u=[],d=null,f=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),p=o&&c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return c.forEach(',
    rep: 'let u=[],d=null,f=!0,p=!0;c=c.map(e=>{let t=e.supportedReasoningEfforts??[],n=t.some(t=>t.reasoningEffort===`max`),r=t.some(t=>t.reasoningEffort===`ultra`);return{...e,supportedReasoningEfforts:[...t,...n?[]:[{reasoningEffort:`max`,description:`max effort`}],...r?[]:[{reasoningEffort:`ultra`,description:`Maximum reasoning with automatic task delegation`}]]}});return c.forEach(',
    expect: 1,
    note: 'K6r: 每个模型目录条目补齐 max/ultra 支持档',
  },
  {
    file: 'app-initial-fd3c4b862660.js',
    old: 'let e=o?r.supportedReasoningEfforts:r.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),n=(t===`copilot`?[e.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:e).filter(({reasoningEffort:e})=>U_e(e)&&i.has(e)),a={...r,supportedReasoningEfforts:n};',
    rep: 'let n=r.supportedReasoningEfforts,a={...r,supportedReasoningEfforts:n};',
    expect: 1,
    note: 'K6r: 去掉 includeUltra/U_e/enabled 三重过滤',
  },
  {
    file: 'app-initial-fd3c4b862660.js',
    old: 'm=e?.includeUltraReasoningEffort!==!1', rep: 'm=!0', expect: 1,
    note: 'd8r: includeUltraReasoningEffort 强制 true',
  },
  {
    file: 'app-shared-a906948d8868.js',
    old: 'd=pgn(c.length>0?c:l.length>0?l:u),',
    rep: 'd=' + FLAT_INJ_FN + '(pgn(c.length>0?c:l.length>0?l:u)),',
    expect: 1,
    note: '滑块解析器: options 补 max/ultra 档',
  },
  {
    file: 'app-shared-a906948d8868.js',
    old: 'f=ugn(s,o,n),p=a,',
    rep: 'f=' + GROUP_INJ_FN + '(ugn(s,o,n)),p=' + FLAT_INJ_FN + '(a),',
    expect: 1,
    note: '滑块解析器: versionOptions + internalOptions 补 max/ultra 档',
  },
  {
    file: 'app-shared-a906948d8868.js',
    old: 'return{serviceTiersByModelSlug:_,alphaModelSlugs:',
    rep: '_=((e,r)=>{for(let[t]of r){let i=e[t]??(e[t]=[]);for(const o of [`fast`,`ultrafast`]){i.some(e=>e.id===o)||i.push({id:o,name:o===`fast`?`Fast`:`Ultrafast`,description:``})}}return e})(_,n);return{serviceTiersByModelSlug:_,alphaModelSlugs:',
    expect: 1,
    note: '滑块解析器: 每个模型的 speed 档补齐 Fast/Ultrafast（Standard 天然存在）',
  },
  {
    file: 'app-primary-84ad97f06929.js',
    old: '(t==null||r==null||r.includes(I3[t]))',
    rep: '(t==null||r==null||r.includes(I3[t])||t===`max`||t===`ultra`)',
    expect: 1,
    note: 'Xyt: 强度滑块过滤放行 max/ultra',
  },
];

// ---------- 读取 bundle 并打补丁 ----------
const patched = new Map(); // rel -> Buffer
{
  const perFile = new Map();
  for (const p of PATCHES) {
    if (!perFile.has(p.file)) perFile.set(p.file, fs.readFileSync(BUNDLES + '/' + p.file, 'utf8'));
  }
  for (const p of PATCHES) {
    let s = perFile.get(p.file);
    const count = s.split(p.old).length - 1;
    if (count !== p.expect) {
      console.error(`FAIL [${p.file}] ${p.note} : 期望 ${p.expect} 处, 实际 ${count} 处 -> "${p.old.slice(0, 60)}..."`);
      process.exit(1);
    }
    s = s.split(p.old).join(p.rep);
    perFile.set(p.file, s);
    console.log(`OK  [${p.file}] x${count}  ${p.note}`);
  }
  for (const [f, s] of perFile) patched.set('webview/assets/' + f, Buffer.from(s, 'utf8'));
  // 落盘补丁后的 bundle 并做语法校验（防止打补丁引入语法错误）
  fs.mkdirSync('F:/test/AI项目/codex修复/patched-bundles', { recursive: true });
  const { execSync } = require('child_process');
  for (const [f, s] of perFile) {
    const out = 'F:/test/AI项目/codex修复/patched-bundles/' + f;
    fs.writeFileSync(out, s);
    try { execSync(`node --check "${out}"`, { stdio: 'pipe' }); console.log(`SYNTAX OK: ${f}`); }
    catch (e) { console.error(`SYNTAX FAIL: ${f}\n` + e.stderr.toString().slice(0, 600)); process.exit(1); }
  }
}

// ---------- 解析原 asar，收集文件清单 ----------
const { header, jsonLen: oldJsonLen } = readHeader(ASAR);
const oldDataBase = 16 + oldJsonLen;
const oldFd = fs.openSync(ASAR, 'r');

const entries = []; // {node, rel, oldOffset, size, patchedBuf|null}
(function collect(node, path) {
  if (node.files) { for (const k of Object.keys(node.files)) collect(node.files[k], path + '/' + k); return; }
  if (node.size === undefined || node.unpacked) return;
  const rel = path.slice(1);
  entries.push({ node, rel, oldOffset: Number(node.offset), size: node.size, patchedBuf: patched.get(rel) || null });
})(header, '');
console.log(`packed files: ${entries.length}, patched among them: ${entries.filter(e => e.patchedBuf).length}`);
if (entries.filter(e => e.patchedBuf).length !== new Set(PATCHES.map(p => p.file)).size) {
  console.error('FAIL: 补丁文件未全部在 asar 中找到'); process.exit(1);
}

// ---------- 分配新偏移（8 字节对齐）并更新 header ----------
function integrityOf(buf) {
  const hex = b => crypto.createHash('sha256').update(b).digest('hex');
  const blocks = [];
  for (let i = 0; i < buf.length; i += 4194304) blocks.push(hex(buf.subarray(i, Math.min(buf.length, i + 4194304))));
  return { algorithm: 'SHA256', hash: hex(buf), blockSize: 4194304, blocks };
}
let cursor = 0;
for (const e of entries) {
  cursor = Math.ceil(cursor / 8) * 8;
  e.newOffset = cursor;
  e.newSize = e.patchedBuf ? e.patchedBuf.length : e.size;
  e.node.offset = String(e.newOffset);
  e.node.size = e.newSize;
  if (e.patchedBuf) e.node.integrity = integrityOf(e.patchedBuf); // 重算分块哈希，否则 Electron 启动即 FATAL
  cursor += e.newSize;
}
const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
const dataBase = 16 + jsonBuf.length;
const totalSize = dataBase + cursor;

// ---------- 写出新 asar ----------
const newFd = fs.openSync(OUT, 'w');
const prefix = Buffer.alloc(16);
prefix.writeUInt32LE(4, 0);
prefix.writeUInt32LE(jsonBuf.length + 8, 4);
prefix.writeUInt32LE(jsonBuf.length + 4, 8);
prefix.writeUInt32LE(jsonBuf.length, 12);
fs.writeSync(newFd, prefix);
fs.writeSync(newFd, jsonBuf);
let written = dataBase;

const CHUNK = 8 * 1024 * 1024;
const zero = Buffer.alloc(8);
for (const e of entries) {
  while (written < dataBase + e.newOffset) { const n = Math.min(8, dataBase + e.newOffset - written); fs.writeSync(newFd, zero, 0, n); written += n; }
  if (e.patchedBuf) {
    fs.writeSync(newFd, e.patchedBuf); written += e.patchedBuf.length;
  } else {
    let pos = 0;
    while (pos < e.size) {
      const n = Math.min(CHUNK, e.size - pos);
      const b = Buffer.alloc(n);
      fs.readSync(oldFd, b, 0, n, oldDataBase + e.oldOffset + pos);
      fs.writeSync(newFd, b); written += n; pos += n;
    }
  }
}
fs.closeSync(newFd);
console.log(`written: ${OUT}  total=${totalSize} actual=${written}  header ${oldJsonLen} -> ${jsonBuf.length}`);

// ---------- 验证 ----------
{
  const { header: h2, jsonLen: jl2 } = readHeader(OUT);
  const db2 = 16 + jl2;
  let cnt = 0;
  (function cntWalk(n) { if (n.files) { for (const k of Object.keys(n.files)) cntWalk(n.files[k]); return; } if (n.size !== undefined && !n.unpacked) cnt++; })(h2);
  if (cnt !== entries.length) { console.error(`VERIFY FAIL: 文件数 ${cnt} != ${entries.length}`); process.exit(1); }
  // 补丁文件逐字节比对
  const fd2 = fs.openSync(OUT, 'r');
  (function vWalk(node, path) {
    if (node.files) { for (const k of Object.keys(node.files)) vWalk(node.files[k], path + '/' + k); return; }
    if (node.size === undefined || node.unpacked) return;
    const rel = path.slice(1);
    if (!patched.has(rel)) return;
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd2, buf, 0, node.size, db2 + Number(node.offset));
    if (!buf.equals(patched.get(rel))) { console.error(`VERIFY FAIL: ${rel} 内容不一致`); process.exit(1); }
  })(h2, '');
  // 随机抽 5 个未修改文件与原 asar 比对
  let checked = 0;
  for (const e of entries) {
    if (e.patchedBuf || checked >= 5) continue;
    if (e.size < 1024) continue;
    checked++;
    const a = Buffer.alloc(4096), b = Buffer.alloc(4096);
    fs.readSync(oldFd, a, 0, Math.min(4096, e.size), oldDataBase + e.oldOffset);
    fs.readSync(fd2, b, 0, Math.min(4096, e.size), db2 + Number(e.node.offset));
    if (!a.equals(b)) { console.error(`VERIFY FAIL: ${e.rel} 抽样不一致`); process.exit(1); }
  }
  fs.closeSync(fd2);
  fs.closeSync(oldFd);
  console.log(`VERIFY OK: 文件数 ${cnt}, 补丁文件比对一致, 抽样 ${checked} 个原文件一致`);
}
console.log('全部完成 -> ' + OUT);
