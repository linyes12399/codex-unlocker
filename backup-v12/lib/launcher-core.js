// Codex 解锁启动器 —— 平台无关核心
// Windows / macOS 启动器共用这一份：补丁定义、补丁应用、asar 读取与重打包、模型目录生成。
// 平台差异（商店/MSIX、exe 内嵌哈希、Codex.app、重签名）全部留在各自的启动器脚本里。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------- 子进程：输出走临时文件，不用管道 ----------
// 管道 stdio 在部分受限环境（沙箱 / 企业终端防护）会直接 EPERM 失败；
// 文件重定向没有这个限制，同样能拿到退出码与报错文本。
let runSeq = 0;
function runCaptured(file, args, opts = {}) {
  const outFile = path.join(os.tmpdir(), `codex-run-${process.pid}-${(runSeq++).toString(36)}.out`);
  const fd = fs.openSync(outFile, 'w');
  let status = 0, cause = null;
  try {
    execFileSync(file, args, Object.assign({ windowsHide: true }, opts, { stdio: ['ignore', fd, fd] }));
  } catch (e) {
    status = e.status ?? 1;
    cause = e;
  }
  fs.closeSync(fd);
  let out = '';
  try { out = fs.readFileSync(outFile, 'utf8'); } catch (_) {}
  fs.rmSync(outFile, { force: true });
  if (status !== 0) {
    const err = cause instanceof Error ? cause : new Error(`${file} 退出码 ${status}`);
    err.status = status;
    err.stdout = out;
    err.stderr = out;
    throw err;
  }
  return out;
}

// ---------- 补丁定义（针对商店原版 bundle）----------
// initial = 含 gate 536305374 的最大 bundle；shared = 含 show-ultra-in-model-picker-slider；
// primary = 含 FastModeToggle。按内容定位，不依赖文件名哈希。
const FLAT_BODY = 'for(let t of e){if(t.thinkingEffort==null)continue;let n=r.get(t.slug);if(n==null)r.set(t.slug,n={top:t,hasU:!1,hasM:!1});n.top=t;t.thinkingEffort===`ultra`&&(n.hasU=!0);t.thinkingEffort===`max`&&(n.hasM=!0)}for(let t of r.values()){t.hasU||e.push({...t.top,thinkingEffort:`ultra`,title:`Ultra`,selectedLabel:void 0});t.hasM||e.push({...t.top,thinkingEffort:`max`,title:`Max`,selectedLabel:void 0})}return e';
const FLAT_INJ_FN = '(e=>{let r=new Map;' + FLAT_BODY + '})';
const GROUP_INJ_FN = '(e=>{let r;for(let t of e){r=new Map;for(let n of t.options??[]){if(n.thinkingEffort==null)continue;let i=r.get(n.slug);if(i==null)r.set(n.slug,i={top:n,hasU:!1,hasM:!1});i.top=n;n.thinkingEffort===`ultra`&&(i.hasU=!0);n.thinkingEffort===`max`&&(i.hasM=!0)}if(r.size){t.options=t.options??[];for(let n of r.values()){n.hasU||t.options.push({...n.top,thinkingEffort:`ultra`,title:`Ultra`,selectedLabel:void 0});n.hasM||t.options.push({...n.top,thinkingEffort:`max`,title:`Max`,selectedLabel:void 0})}}}return e})';

const PATCHES = [
  {
    file: 'initial',
    // gate 536305374：调用形态 X.get(Y,`ID`) / X(Y,`ID`)，压缩器改名不影响
    regex: /\b\w+(?:\.\w+)?\(\s*\w+\s*,\s*`536305374`\s*\)/g,
    rep: '!0', expect: 5,
    note: 'gate 536305374（ultra 保存/使用开关）-> 永远开启',
  },
  {
    file: 'initial',
    old: '!t&&a.includes(i)&&(o=a.filter(e=>e!==i))',
    rep: '!t&&a.includes(i)&&(o=a)', expect: 1,
    note: 'a8r: 不再把 max/ultra 剔出 enabled 列表',
  },
  {
    file: 'initial',
    // 自动降级调用，函数名每版会变，锚定前后稳定字面量
    regex: /(i===`ultra`\)&&await )\w+\(e,n,r,i\)/,
    repFn: (m, g1) => g1 + '0', expect: 1,
    note: 'o8r 自动降级调用 -> 空操作',
  },
  {
    file: 'initial',
    old: 'let u=[],d=null,f=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),p=o&&c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return c.forEach(',
    rep: 'let u=[],d=null,f=!0,p=!0;c=c.map(e=>{let t=e.supportedReasoningEfforts??[],n=t.some(t=>t.reasoningEffort===`max`),r=t.some(t=>t.reasoningEffort===`ultra`),i=e.serviceTiers??[],a=i.some(t=>t?.id===`fast`||t?.id===`priority`),s=i.some(t=>t?.id===`ultrafast`);return{...e,supportedReasoningEfforts:[...t,...n?[]:[{reasoningEffort:`max`,description:`max effort`}],...r?[]:[{reasoningEffort:`ultra`,description:`Maximum reasoning with automatic task delegation`}]],serviceTiers:[...i,...a?[]:[{id:`fast`,name:`Fast`,description:`1.5x speed, increased usage`}],...s?[]:[{id:`ultrafast`,name:`Ultrafast`,description:`2x speed, increased usage`}]]}});return c.forEach(',
    expect: 1,
    note: 'K6r: 每个模型目录条目补齐 max/ultra 强度档 + serviceTiers 补齐 fast/ultrafast(修复选中态回读)',
  },
  {
    file: 'initial',
    // K6r 内层三重过滤（校验函数名每版会变，用 \w+）
    regex: /let e=o\?r\.supportedReasoningEfforts:r\.supportedReasoningEfforts\.filter\(\(\{reasoningEffort:e\}\)=>e!==`ultra`\),n=\(t===`copilot`\?\[e\.find\(e=>e\.reasoningEffort===`medium`\)\?\?\{reasoningEffort:`medium`,description:`medium effort`\}\]:e\)\.filter\(\(\{reasoningEffort:e\}\)=>\w+\(e\)&&i\.has\(e\)\),a=\{\.\.\.r,supportedReasoningEfforts:n\};/,
    rep: 'let n=r.supportedReasoningEfforts,a={...r,supportedReasoningEfforts:n};',
    expect: 1,
    note: 'K6r: 去掉 includeUltra/U_e/enabled 三重过滤',
  },
  {
    file: 'initial',
    old: 'm=e?.includeUltraReasoningEffort!==!1',
    rep: 'm=!0', expect: 1,
    note: 'd8r: includeUltraReasoningEffort 强制 true',
  },
  { // 原 Fast 解锁补丁 #1
    file: 'initial',
    old: 'd=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1',
    rep: 'd=!0', expect: 1,
    note: 'Fast: isServiceTierAllowed 强制 true',
  },
  // ---- app-shared ----
  { // 函数名每版会变（pgn / Ygn ...），锚定 X(c.length>0?c:l.length>0?l:u) 的形态
    file: 'shared',
    regex: /(?<![\w$])([\w$]+)=([\w$]+\(([\w$]+)\.length>0\?\3:([\w$]+)\.length>0\?\4:[\w$]+\)),/,
    repFn: (m, v, call) => v + '=' + FLAT_INJ_FN + '(' + call + '),',
    expect: 1,
    note: '滑块解析器: options 补 max/ultra 档',
  },
  { // 紧跟在 slider_settings.flatMap 之前的 f=X(s,o,n),p=a,
    file: 'shared',
    regex: /(?<![\w$])([\w$]+)=([\w$]+\([\w$]+,[\w$]+,[\w$]+\)),([\w$]+)=([\w$]+),(?=[\w$]+=t\.slider_settings\.flatMap)/,
    repFn: (m, f, call, p, a) => f + '=' + GROUP_INJ_FN + '(' + call + '),' + p + '=' + FLAT_INJ_FN + '(' + a + '),',
    expect: 1,
    note: '滑块解析器: versionOptions + internalOptions 补 max/ultra 档',
  },
  {
    file: 'shared',
    old: 'return{serviceTiersByModelSlug:_,alphaModelSlugs:',
    rep: '_=((e,r)=>{for(let[t]of r){let i=e[t]??(e[t]=[]);for(const o of [`fast`,`ultrafast`]){i.some(e=>e.id===o)||i.push({id:o,name:o===`fast`?`Fast`:`Ultrafast`,description:``})}}return e})(_,n);return{serviceTiersByModelSlug:_,alphaModelSlugs:',
    expect: 1,
    note: '滑块解析器: 每个模型 speed 档补齐 Fast/Ultrafast（校验+持久化用）',
  },
  { // 原 Fast 解锁补丁 #3 + Ultrafast 档合并（composer ⚡ 菜单的真正数据源）
    // 函数名 / 标准档常量 / 档位归一化函数每版会变（$Kr,sqr,eP -> Iqr,Wqr,eP ...），全部捕获
    file: 'shared',
    regex: /function ([\w$]+)\(e,t\)\{return\[([\w$]+),\.\.\.\(t\?\?\[\]\)\.map\(t=>\{let n=([\w$]+)\(t\.id,t\.name\)/,
    repFn: (m, fn, std, norm) => 'function ' + fn + '(e,t){let _t=(t&&t.length>0?t:[{id:"fast",name:"Fast"}]).concat((t??[]).some(t=>' + norm +
      '(t?.id,t?.name)===`ultrafast`)?[]:[{id:`ultrafast`,name:`Ultrafast`}]);return[' + std + ',..._t.map(t=>{let n=' + norm + '(t.id,t.name)',
    expect: 1,
    note: '速度档菜单: 注入 Ultrafast（保留原 Fast 假档兜底）',
  },
  // ---- app-primary ----
  {
    file: 'primary',
    old: '(t==null||r==null||r.includes(I3[t]))',
    rep: '(t==null||r==null||r.includes(I3[t])||t===`max`||t===`ultra`)',
    expect: 1,
    note: 'Xyt: 强度滑块过滤放行 max/ultra',
  },
  { // 原 Fast 解锁补丁 #2a：Mt=!Le&&!fe&&jt!=null&&wd(it,Et)，紧跟 #2b 那一项（变量名每版会变）
    file: 'primary',
    regex: /(?<![\w$])([\w$]+)=![\w$]+&&!([\w$]+)&&([\w$]+)!=null&&[\w$]+\([\w$]+,[\w$]+\),(?=[\w$]+=!\2&&![\w$]+&&[\w$]+&&[\w$]+\.availableOptions\.length>1)/,
    repFn: (m, v, fe, icon) => v + '=!' + fe + '&&' + icon + '!=null,',
    expect: 1,
    note: 'Fast: 档位图标显示条件放宽',
  },
  { // 原 Fast 解锁补丁 #2b：Nt=!fe&&!ce&&Ve&&Re.availableOptions.length>1
    file: 'primary',
    regex: /(?<![\w$])([\w$]+)=!([\w$]+)&&!([\w$]+)&&[\w$]+&&[\w$]+\.availableOptions\.length>1(?![\w$])/,
    repFn: (m, v, a, b) => v + '=!' + a + '&&!' + b,
    expect: 1,
    note: 'Fast: 模型选择器显示条件放宽',
  },
  { // 强制请求体包含 service_tier（变量名每版会变）
    file: 'initial',
    regex: /service_tier:([\w$]+)\?\?void 0,(?=system_hints:)/,
    repFn: (m, v) => 'service_tier:' + v + '||"ultrafast",',
    expect: 1,
    note: '强制请求体包含 service_tier（默认 ultrafast）',
  },
];

// bundle 定位标记（按内容定位，不依赖文件名哈希）
const BUNDLE_MARKERS = {
  initial: '536305374',
  shared: 'show-ultra-in-model-picker-slider',
  primary: 'FastModeToggle',
};
// webview bundle 在 asar 内的路径形态：webview/assets/<name>.js
const BUNDLE_RE = /^webview\/assets\/[^/]+\.js$/;
const BUNDLE_MAX_SIZE = 30 * 1024 * 1024;

// ---------- 通用工具 ----------
function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- asar ----------
// asar 头是两个 Chromium Pickle：[4][headerSize] + [payloadLen][jsonLen][json][补齐到 4 字节]
// 数据区从 8 + headerSize 开始；json 长度不是 4 的倍数时，16 + jsonLen 会偏几个字节
function readAsar(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const headerSize = b.readUInt32LE(4);
  const jsonLen = b.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  fs.closeSync(fd);
  return { header: JSON.parse(jsonBuf.toString('utf8')), jsonLen, jsonBuf, dataBase: 8 + headerSize };
}

// 展平 header 里的文件表（跳过 unpacked 条目）
function listAsarEntries(header) {
  const entries = [];
  (function collect(node, p) {
    if (node.files) { for (const k of Object.keys(node.files)) collect(node.files[k], p + '/' + k); return; }
    if (node.size === undefined || node.unpacked) return;
    entries.push({ node, rel: p.slice(1), offset: Number(node.offset), size: node.size });
  })(header, '');
  return entries;
}

function integrityOf(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += 4194304) blocks.push(sha256Hex(buf.subarray(i, Math.min(buf.length, i + 4194304))));
  return { algorithm: 'SHA256', hash: sha256Hex(buf), blockSize: 4194304, blocks };
}

function readAsarEntry(fd, dataBase, e) {
  const b = Buffer.alloc(e.size);
  fs.readSync(fd, b, 0, e.size, dataBase + e.offset);
  return b;
}

// 按内容标记定位三个 bundle；findBundle 只读候选文件，返回最大命中项
function locateBundles(asarPath) {
  const { header, dataBase } = readAsar(asarPath);
  const fd = fs.openSync(asarPath, 'r');
  try {
    const files = listAsarEntries(header).filter(e => BUNDLE_RE.test(e.rel) && e.size < BUNDLE_MAX_SIZE);
    const cache = new Map();
    const text = e => {
      let s = cache.get(e.rel);
      if (s === undefined) { s = readAsarEntry(fd, dataBase, e).toString('latin1'); cache.set(e.rel, s); }
      return s;
    };
    const role = {};
    for (const [name, marker] of Object.entries(BUNDLE_MARKERS)) {
      let best = null;
      for (const e of files) {
        if (!text(e).includes(marker)) continue;
        if (!best || e.size > best.size) best = e;
      }
      role[name] = best || null;
    }
    return { header, dataBase, fd, files, text, role };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

// 应用整份补丁集；content: Map<rel, latin1 字符串>
// 返回 { failCount, results:[{note, ok, expect, actual}] }
function applyPatchSet(content, role) {
  const results = [];
  let failCount = 0;
  for (const p of PATCHES) {
    const rel = role[p.file].rel;
    let s = content.get(rel);
    let actual;
    if (p.regex) {
      actual = (s.match(new RegExp(p.regex.source, 'g')) || []).length;
      if (actual === p.expect) s = p.repFn ? s.replace(new RegExp(p.regex.source, p.regex.flags), p.repFn) : s.replace(new RegExp(p.regex.source, p.regex.flags), p.rep);
    } else {
      actual = s.split(p.old).length - 1;
      if (actual === p.expect) s = s.split(p.old).join(p.rep);
    }
    if (actual === p.expect) { content.set(rel, s); results.push({ note: p.note, ok: true }); }
    else { failCount++; results.push({ note: p.note, ok: false, expect: p.expect, actual }); }
  }
  return { failCount, results };
}

// 语法校验：把改过的 bundle 写到 dir，用当前 node 逐个 --check。
// 失败时保留 dir 里的文件便于排查（与原实现一致），成功由调用方删除。
function syntaxCheckBundles(content, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, s] of content) {
    const tmp = path.join(dir, path.basename(rel));
    fs.writeFileSync(tmp, Buffer.from(s, 'latin1'));
    try {
      runCaptured(process.execPath, ['--check', tmp]);
    } catch (e) {
      const msg = String(e.stderr || '').trim().split('\n').slice(0, 3).join(' | ');
      throw new Error('语法校验失败: ' + rel + (msg ? ' —— ' + msg : ''));
    }
  }
}

// 重打包 asar：重算 offset/size，被改过的条目重算 integrity，未改动的按字节流式搬运
// opts: { srcPath, dstPath, header, entries, patched, srcDataBase }
// 返回 { jsonBuf, dataBase, bytes }
function writeAsar({ srcPath, dstPath, header, entries, patched, srcDataBase }) {
  for (const e of entries) {
    const b = patched.get(e.rel);
    if (b) { e.newSize = b.length; e.patchedBuf = b; } else { e.newSize = e.size; }
  }
  let cursor = 0;
  for (const e of entries) {
    cursor = Math.ceil(cursor / 8) * 8;
    e.newOffset = cursor;
    e.node.offset = String(e.newOffset);
    e.node.size = e.newSize;
    if (e.patchedBuf) e.node.integrity = integrityOf(e.patchedBuf);
    cursor += e.newSize;
  }
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const payloadLen = Math.ceil((4 + jsonBuf.length) / 4) * 4;
  const headerSize = 4 + payloadLen;
  const dataBase = 8 + headerSize;
  const srcFd = fs.openSync(srcPath, 'r');
  let outFd;
  try {
    outFd = fs.openSync(dstPath, 'w');
  } catch (e) {
    fs.closeSync(srcFd); // 目标打不开时别把源句柄漏掉（ENOSPC/EACCES）
    throw e;
  }
  try {
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerSize, 4);
    prefix.writeUInt32LE(payloadLen, 8);
    prefix.writeUInt32LE(jsonBuf.length, 12);
    fs.writeSync(outFd, prefix);
    fs.writeSync(outFd, jsonBuf);
    const pad = dataBase - 16 - jsonBuf.length;
    if (pad) fs.writeSync(outFd, Buffer.alloc(pad));
    let written = dataBase;
    const CHUNK = 8 * 1024 * 1024, zero = Buffer.alloc(8);
    for (const e of entries) {
      while (written < dataBase + e.newOffset) { const n = Math.min(8, dataBase + e.newOffset - written); fs.writeSync(outFd, zero, 0, n); written += n; }
      if (e.patchedBuf) { fs.writeSync(outFd, e.patchedBuf); written += e.patchedBuf.length; }
      else {
        let pos = 0;
        while (pos < e.size) {
          const n = Math.min(CHUNK, e.size - pos);
          const b = Buffer.alloc(n);
          fs.readSync(srcFd, b, 0, n, srcDataBase + e.offset + pos);
          fs.writeSync(outFd, b); written += n; pos += n;
        }
      }
    }
    return { jsonBuf, dataBase, bytes: written };
  } finally {
    try { fs.closeSync(srcFd); } catch (e) {}
    try { fs.closeSync(outFd); } catch (e) {}
  }
}

module.exports = {
  PATCHES, BUNDLE_MARKERS, BUNDLE_RE, BUNDLE_MAX_SIZE,
  FLAT_INJ_FN, GROUP_INJ_FN,
  runCaptured, sha256File, sha256Hex,
  readAsar, listAsarEntries, integrityOf, readAsarEntry, locateBundles,
  applyPatchSet, syntaxCheckBundles, writeAsar,
};
