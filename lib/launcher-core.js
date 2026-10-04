// Codex 解锁启动器 —— 平台无关核心
// Windows / macOS 启动器共用这一份：补丁定义、补丁应用、asar 读取与重打包、模型目录生成。
// 平台差异（商店/MSIX、exe 内嵌哈希、Codex.app、重签名）全部留在各自的启动器脚本里。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { execFileSync } = require('child_process');

// ---------- 子进程：输出走临时文件，不用管道 ----------
// 管道 stdio 在部分受限环境（沙箱 / 企业终端防护）会直接 EPERM 失败；
// 文件重定向没有这个限制，同样能拿到退出码与报错文本。
let runSeq = 0;
function runCaptured(file, args, opts = {}) {
  const outDir = os.tmpdir();
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {} // TEMP 目录被清掉/不存在时兜底（沙箱测试里会发生）
  const outFile = path.join(outDir, `codex-run-${process.pid}-${(runSeq++).toString(36)}.out`);
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

// 条目字段：file = 作用角色；note = 中文说明；group = effort/speed（见 applyPatchSet 上方说明）；
// expect = 期望命中数；regex+rep/repFn 或 old+rep = 主定义；
// variants = 旧版本变体写法（可选）：先试主定义，再按声明顺序试变体，第一个"命中数 === expect"的生效。
const PATCHES = [
  {
    file: 'initial',
    // gate 536305374：调用形态 X.get(Y,`ID`) / X(Y,`ID`)，压缩器改名不影响
    regex: /\b\w+(?:\.\w+)?\(\s*\w+\s*,\s*`536305374`\s*\)/g,
    rep: '!0', expect: 5,
    note: 'gate 536305374（ultra 保存/使用开关）-> 永远开启',
    group: 'effort',
  },
  {
    file: 'initial',
    old: '!t&&a.includes(i)&&(o=a.filter(e=>e!==i))',
    rep: '!t&&a.includes(i)&&(o=a)', expect: 1,
    note: 'a8r: 不再把 max/ultra 剔出 enabled 列表',
    group: 'effort',
  },
  {
    file: 'initial',
    // 自动降级调用，函数名每版会变，锚定前后稳定字面量
    regex: /(i===`ultra`\)&&await )\w+\(e,n,r,i\)/,
    repFn: (m, g1) => g1 + '0', expect: 1,
    note: 'o8r 自动降级调用 -> 空操作',
    group: 'effort',
  },
  {
    file: 'initial',
    old: 'let u=[],d=null,f=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),p=o&&c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return c.forEach(',
    rep: 'let u=[],d=null,f=!0,p=!0;c=c.map(e=>{let t=e.supportedReasoningEfforts??[],n=t.some(t=>t.reasoningEffort===`max`),r=t.some(t=>t.reasoningEffort===`ultra`),i=e.serviceTiers??[],a=i.some(t=>t?.id===`fast`||t?.id===`priority`),s=i.some(t=>t?.id===`ultrafast`);return{...e,supportedReasoningEfforts:[...t,...n?[]:[{reasoningEffort:`max`,description:`max effort`}],...r?[]:[{reasoningEffort:`ultra`,description:`Maximum reasoning with automatic task delegation`}]],serviceTiers:[...i,...a?[]:[{id:`fast`,name:`Fast`,description:`1.5x speed, increased usage`}],...s?[]:[{id:`ultrafast`,name:`Ultrafast`,description:`2x speed, increased usage`}]]}});return c.forEach(',
    expect: 1,
    note: 'K6r: 每个模型目录条目补齐 max/ultra 强度档 + serviceTiers 补齐 fast/ultrafast(修复选中态回读)',
    // 这条同时含 effort（max/ultra 档）与 speed（serviceTiers）内容，按约定归 effort 组：
    // 其 serviceTiers 段为纯内联数组合并、不引用任何其它补丁产物，speed 组被跳过时只是多出一段档位数据。
    group: 'effort',
  },
  {
    file: 'initial',
    // K6r 内层三重过滤（校验函数名每版会变，用 \w+）
    regex: /let e=o\?r\.supportedReasoningEfforts:r\.supportedReasoningEfforts\.filter\(\(\{reasoningEffort:e\}\)=>e!==`ultra`\),n=\(t===`copilot`\?\[e\.find\(e=>e\.reasoningEffort===`medium`\)\?\?\{reasoningEffort:`medium`,description:`medium effort`\}\]:e\)\.filter\(\(\{reasoningEffort:e\}\)=>\w+\(e\)&&i\.has\(e\)\),a=\{\.\.\.r,supportedReasoningEfforts:n\};/,
    rep: 'let n=r.supportedReasoningEfforts,a={...r,supportedReasoningEfforts:n};',
    expect: 1,
    note: 'K6r: 去掉 includeUltra/U_e/enabled 三重过滤',
    group: 'effort',
  },
  {
    file: 'initial',
    old: 'm=e?.includeUltraReasoningEffort!==!1',
    rep: 'm=!0', expect: 1,
    note: 'd8r: includeUltraReasoningEffort 强制 true',
    group: 'effort',
  },
  { // 原 Fast 解锁补丁 #1
    file: 'initial',
    old: 'd=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1',
    rep: 'd=!0', expect: 1,
    note: 'Fast: isServiceTierAllowed 强制 true',
    group: 'speed',
    // 旧版（26.928.x）此处本身就恒为 d=!0（门槛表达式是后来的版本才引入的，实测旧写法命中 0）；
    // identity 变体只用于确认"该条在旧版已等效生效"，不改变内容。
    variants: [{ old: 'u=!!i?.isLoading||a&&l,d=!0,f;', rep: 'u=!!i?.isLoading||a&&l,d=!0,f;', expect: 1 }],
  },
  // ---- app-shared ----
  { // 函数名每版会变（pgn / Ygn ...），锚定 X(c.length>0?c:l.length>0?l:u) 的形态
    file: 'shared',
    regex: /(?<![\w$])([\w$]+)=([\w$]+\(([\w$]+)\.length>0\?\3:([\w$]+)\.length>0\?\4:[\w$]+\)),/,
    repFn: (m, v, call) => v + '=' + FLAT_INJ_FN + '(' + call + '),',
    expect: 1,
    note: '滑块解析器: options 补 max/ultra 档',
    group: 'effort',
  },
  { // 紧跟在 slider_settings.flatMap 之前的 f=X(s,o,n),p=a,
    file: 'shared',
    regex: /(?<![\w$])([\w$]+)=([\w$]+\([\w$]+,[\w$]+,[\w$]+\)),([\w$]+)=([\w$]+),(?=[\w$]+=t\.slider_settings\.flatMap)/,
    repFn: (m, f, call, p, a) => f + '=' + GROUP_INJ_FN + '(' + call + '),' + p + '=' + FLAT_INJ_FN + '(' + a + '),',
    expect: 1,
    note: '滑块解析器: versionOptions + internalOptions 补 max/ultra 档',
    group: 'effort',
  },
  {
    file: 'shared',
    old: 'return{serviceTiersByModelSlug:_,alphaModelSlugs:',
    rep: '_=((e,r)=>{for(let[t]of r){let i=e[t]??(e[t]=[]);for(const o of [`fast`,`ultrafast`]){i.some(e=>e.id===o)||i.push({id:o,name:o===`fast`?`Fast`:`Ultrafast`,description:``})}}return e})(_,n);return{serviceTiersByModelSlug:_,alphaModelSlugs:',
    expect: 1,
    note: '滑块解析器: 每个模型 speed 档补齐 Fast/Ultrafast（校验+持久化用）',
    group: 'speed',
  },
  { // 原 Fast 解锁补丁 #3 + Ultrafast 档合并（composer ⚡ 菜单的真正数据源）
    // 函数名 / 标准档常量 / 档位归一化函数每版会变（$Kr,sqr,eP -> Iqr,Wqr,eP ...），全部捕获
    file: 'shared',
    regex: /function ([\w$]+)\(e,t\)\{return\[([\w$]+),\.\.\.\(t\?\?\[\]\)\.map\(t=>\{let n=([\w$]+)\(t\.id,t\.name\)/,
    repFn: (m, fn, std, norm) => 'function ' + fn + '(e,t){let _t=(t&&t.length>0?t:[{id:"fast",name:"Fast"}]).concat((t??[]).some(t=>' + norm +
      '(t?.id,t?.name)===`ultrafast`)?[]:[{id:`ultrafast`,name:`Ultrafast`}]);return[' + std + ',..._t.map(t=>{let n=' + norm + '(t.id,t.name)',
    expect: 1,
    note: '速度档菜单: 注入 Ultrafast（保留原 Fast 假档兜底）',
    group: 'speed',
    // 旧版形态是 `let _t=t&&t.length>0?t:[{id:"fast",name:"Fast"}];return[sqr,..._t.map(`（没有主定义里直接 concat 的形态），
    // 变体针对旧形态做等价的 Ultrafast 注入。
    // 注意：正则的 4 个捕获组顺序是 fn、prm、std、norm，repFn 必须严格对应；
    // 若给 (t&&t.length>0?...) 再包一层捕获括号会使 std/norm 错位（产物仍能通过 node --check，但注入的调用是错的）。
    variants: [{
      regex: /function ([\w$]+)\(e,t\)\{let ([\w$]+)=t&&t\.length>0\?t:\[\{id:"fast",name:"Fast"\}\];return\[([\w$]+),\.\.\.\2\.map\(t=>\{let n=([\w$]+)\(t\.id,t\.name\)/,
      repFn: (m, fn, prm, std, norm) => 'function ' + fn + '(e,t){let ' + prm + '=(t&&t.length>0?t:[{id:"fast",name:"Fast"}]).concat((t??[]).some(t=>' + norm +
        '(t?.id,t?.name)===`ultrafast`)?[]:[{id:`ultrafast`,name:`Ultrafast`}]);return[' + std + ',...' + prm + '.map(t=>{let n=' + norm + '(t.id,t.name)',
      expect: 1,
    }],
  },
  // ---- app-primary ----
  {
    file: 'primary',
    old: '(t==null||r==null||r.includes(I3[t]))',
    rep: '(t==null||r==null||r.includes(I3[t])||t===`max`||t===`ultra`)',
    expect: 1,
    note: 'Xyt: 强度滑块过滤放行 max/ultra',
    group: 'effort',
  },
  { // 原 Fast 解锁补丁 #2a：Mt=!Le&&!fe&&jt!=null&&wd(it,Et)，紧跟 #2b 那一项（变量名每版会变）
    file: 'primary',
    regex: /(?<![\w$])([\w$]+)=![\w$]+&&!([\w$]+)&&([\w$]+)!=null&&[\w$]+\([\w$]+,[\w$]+\),(?=[\w$]+=!\2&&![\w$]+&&[\w$]+&&[\w$]+\.availableOptions\.length>1)/,
    repFn: (m, v, fe, icon) => v + '=!' + fe + '&&' + icon + '!=null,',
    expect: 1,
    note: 'Fast: 档位图标显示条件放宽',
    group: 'speed',
    // 旧版没有 !Le / wd(it,Et) 门槛，形态即主定义替换后的结果；identity 变体确认已等效生效。
    variants: [{ old: 'Mt=!fe&&jt!=null,', rep: 'Mt=!fe&&jt!=null,', expect: 1 }],
  },
  { // 原 Fast 解锁补丁 #2b：Nt=!fe&&!ce&&Ve&&Re.availableOptions.length>1
    file: 'primary',
    regex: /(?<![\w$])([\w$]+)=!([\w$]+)&&!([\w$]+)&&[\w$]+&&[\w$]+\.availableOptions\.length>1(?![\w$])/,
    repFn: (m, v, a, b) => v + '=!' + a + '&&!' + b,
    expect: 1,
    note: 'Fast: 模型选择器显示条件放宽',
    group: 'speed',
    // 旧版没有 &&Ve&&Re.availableOptions.length>1 门槛；identity 变体确认已等效生效。
    variants: [{ old: 'Nt=!fe&&!ce,', rep: 'Nt=!fe&&!ce,', expect: 1 }],
  },
  { // 强制请求体包含 service_tier（变量名每版会变）
    file: 'initial',
    regex: /service_tier:([\w$]+)\?\?void 0,(?=system_hints:)/,
    repFn: (m, v) => 'service_tier:' + v + '||"ultrafast",',
    expect: 1,
    note: '强制请求体包含 service_tier（默认 ultrafast）',
    group: 'speed',
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

// ---------- 补丁应用 ----------
// 分组（group）：effort = Max/Ultra 思考强度相关（9 条）；speed = Fast/Ultrafast 速度档 / service_tier 相关（6 条）。
// 两组之间**不存在代码耦合**，依据（逐条核对 15 条补丁的替换产物，实测）：
//   - 15 条替换产物全部是自包含的（内联 IIFE 或只引用当前作用域已有的局部变量），
//     没有任何"一组注入的标识符被另一组引用"的形态，因此任一组被整体跳过时另一组仍可独立应用；
//   - 唯一横跨两组内容的是 K6r 条目（同一处替换里既补 max/ultra 强度档、又补 serviceTiers 的 fast/ultrafast），
//     归 effort 组：其 serviceTiers 段是纯内联数组合并、不引用任何其他补丁产物，
//     speed 组被跳过时只是保留了一段多出的档位数据，不影响 effort 组自身；
//   - 独立验证：旧版样本上单独应用 effort 组（9/9）、单独应用 speed 组（6/6），两者都通过 node --check。
// 各补丁作用区域互不重叠：原文上的命中数与顺序应用后的命中数一致（新旧样本 15/15 实测，
// 且 patch-test 断言"按组应用"与"逐条默认应用"的产物逐字节相同）。

// 试一条"候选写法"在文本上的命中数
function countCand(cand, s) {
  return cand.regex ? (s.match(new RegExp(cand.regex.source, 'g')) || []).length
                    : s.split(cand.old).length - 1;
}
// 执行一条"候选写法"的替换（只在命中数 === expect 后调用）
function runCand(cand, s) {
  if (cand.regex) {
    return cand.repFn ? s.replace(new RegExp(cand.regex.source, cand.regex.flags), cand.repFn)
                      : s.replace(new RegExp(cand.regex.source, cand.regex.flags), cand.rep);
  }
  return s.split(cand.old).join(cand.rep);
}
// 主定义在前、变体按声明顺序在后
function candidatesOf(p) {
  return [p].concat(p.variants || []);
}

// 应用整份补丁集；content: Map<rel, latin1 字符串>；role: {initial|shared|primary -> {rel}}
// opts.allowPartial === true 时按 group 原子应用：
//   某组有任何一条（主定义与全部变体都）找不到 -> 整组跳过，被跳过组的改动不留在 content 里；
//   至少一组完整命中 -> 只应用完整命中的组，failCount 只统计已应用组内的未命中（此时应为 0），partial=true；
//   所有组都被跳过 -> 不进入 partial 成功路径（content 不改动），failCount=未命中总数，partial=false。
// 不传 opts 时与旧版行为完全一致（macOS 版按 2 参调用依赖这条路径）。
// 返回 { failCount, results, skippedGroups, partial }；
// results 每项固定 { note, ok, expect, actual, group, variant }（variant: 0=主定义，1..n=变体序号，-1=未命中）。
// ok 表示该条是否解析出可生效的写法（不是"是否已写入 content"）：被跳过组里已解析的条目仍为 ok:true，
// 其改动不落 content；组级是否应用由 skippedGroups / partial 表达（§10.2 的冻结语义，消费方据此换算报告）。
function applyPatchSet(content, role, opts = {}) {
  const allowPartial = opts.allowPartial === true;

  if (!allowPartial) {
    // ---- 默认路径：逐条独立应用（旧行为）----
    const results = [];
    let failCount = 0;
    for (const p of PATCHES) {
      const rel = role[p.file].rel;
      const s = content.get(rel);
      const cands = candidatesOf(p);
      let variant = -1, actual = 0, cur = s;
      for (let i = 0; i < cands.length; i++) {
        const n = countCand(cands[i], cur);
        if (i === 0) actual = n; // 未命中时报"主定义命中数"（与旧版对外语义一致）
        if (n === cands[i].expect) { variant = i; actual = n; cur = runCand(cands[i], cur); break; }
      }
      if (variant >= 0) { content.set(rel, cur); results.push({ note: p.note, ok: true, expect: p.expect, actual, group: p.group, variant }); }
      else { failCount++; results.push({ note: p.note, ok: false, expect: p.expect, actual, group: p.group, variant: -1 }); }
    }
    return { failCount, results, skippedGroups: [], partial: false };
  }

  // ---- allowPartial：按 group 原子应用 ----
  // 第一轮（只读）：在原文上解析每条补丁能生效的写法（主定义 -> 变体）
  const resolved = PATCHES.map(p => {
    const s = content.get(role[p.file].rel);
    const cands = candidatesOf(p);
    const mainCount = countCand(cands[0], s);
    for (let i = 0; i < cands.length; i++) {
      const n = i === 0 ? mainCount : countCand(cands[i], s);
      if (n === cands[i].expect) return { p, cand: cands[i], variant: i, actual: n };
    }
    return { p, cand: null, variant: -1, actual: mainCount }; // 未命中：variant=-1、actual=主定义命中数
  });

  // 组完整性：组内每条都能解析出写法才算完整；组名固定 effort/speed，输出顺序固定
  const GROUP_NAMES = ['effort', 'speed'];
  const complete = { effort: true, speed: true };
  for (const r of resolved) if (r.variant < 0) complete[r.p.group] = false;
  const skippedGroups = GROUP_NAMES.filter(g => !complete[g]);
  const appliedGroups = GROUP_NAMES.filter(g => complete[g]);

  // 第二轮：只把完整命中的组的改动写回 content（顺序与 PATCHES 一致）；
  // 所有组都被跳过时这里有一步都不执行，content 保持原文。
  for (const r of resolved) {
    if (r.variant < 0 || !complete[r.p.group]) continue;
    const rel = role[r.p.file].rel;
    content.set(rel, runCand(r.cand, content.get(rel)));
  }

  const results = resolved.map(r => ({
    note: r.p.note, ok: r.variant >= 0, expect: r.p.expect, actual: r.actual, group: r.p.group, variant: r.variant,
  }));
  // failCount：至少一组完整命中时只统计"已应用组内"的未命中（按构造为 0）；
  // 所有组都被跳过时=未命中总数（照旧整体失败）。
  const failCount = appliedGroups.length
    ? resolved.filter(r => r.variant < 0 && complete[r.p.group]).length
    : resolved.filter(r => r.variant < 0).length;
  // partial 仅在"有组被跳过、且有组被应用"时为 true
  const partial = skippedGroups.length > 0 && appliedGroups.length > 0;
  return { failCount, results, skippedGroups, partial };
}

// 语法校验：把改过的 bundle 写到 dir，用当前 node 逐个 --check。
// 失败时保留 dir 里的文件便于排查（与原实现一致），成功由调用方删除。
// 临时文件名由 rel 整体转换而来（不是 basename）：镜像 asar 里 basename 目前恰好不重复，
// 但那是巧合（webview/assets 上万条），去撞名是结构性的——不同 rel 必须落到不同临时文件，
// 否则后写的覆盖先写的，校验就成了"只校验了最后一个"。mac 侧只是临时文件名变化，返回结构不变。
function syntaxCheckBundles(content, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, s] of content) {
    const tmp = path.join(dir, rel.replace(/[\\/]/g, '__'));
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

// ================= 主进程补丁（net）：app-server 启动参数注入 =================
// 背景（规格 §1）：桌面端通过 app-server 的 turn/start 参数 serviceTier 传档位，而 codex 只在
// "当前模型的目录条目里确实有这个档位"时才把 service_tier 写进请求（内置目录只有 priority，没有 ultrafast）；
// cc-switch 每次切换供应商/路由都会重写 config.toml，v13 往里写的 model_catalog_json 因此被抹掉 → Ultrafast 失效。
// 直连（requires_openai_auth = false、表里没有 bearer）时请求不发 Authorization 头 → 401 API_KEY_REQUIRED。
// 解决办法：在拉起 app-server 的那一刻（ec() 拼接参数时）读镜像根目录下的覆盖文件，动态追加两条 -c 覆盖：
//   model_catalog_json=<合并目录>                    -> 补上 Ultrafast 档位，且不信 config.toml（cc-switch 改不掉）
//   model_providers.<id>.requires_openai_auth=true   -> 强制使用 auth.json 里的 API Key（路由模式下带 bearer 也无害）
// 覆盖文件里不含任何 key/token；注入的函数每次拉起 app-server 都会重读一遍，任何异常都只是"少推参数"。

// 镜像根目录（ChatGPT.exe 所在 app 目录的上一级）下的覆盖文件名
const NET_OVERRIDES_FILE = 'codex-launcher-overrides.json';
// 主进程 bundle 的定位标记（按内容定位，不依赖文件名哈希：实测 26.930 / 26.928 两版各命中 1 个 bundle）
const NET_MARKER = 'CODEX_APP_SERVER_OPENAI_BASE_URL';
// net bundle 在 asar 内的路径形态；实测命中文件为 .vite/build/application-network-startup-<hash>.js（~289KB）
const NET_BUNDLE_RE = /^\.vite\/build\/[^/]+\.js$/;
const NET_BUNDLE_MAX_SIZE = 30 * 1024 * 1024;
// 注入点：ec() 的三元表达式。捕获 1 = Es.flatMap 的结果变量名（如 e），2 = 三元表达式剩余部分（原样保留）
const NET_RE = /return ([\w$]+)\.length===0\?(\[\.\.\.[\w$]+,`app-server`,`--analytics-default-enabled`\]:\[`app-server`,\.\.\.[\w$]+,\.\.\.\1,`--analytics-default-enabled`\])/;

// 注入到 bundle 里的函数（规格 §4.3 逐字采用 + §10.1 / §10.2 的实测修订）。
// 硬约束：函数体只能是 ASCII、不引用任何外部变量、不能依赖闭包——它会被 toString() 原样写进 bundle，
// 在 Electron 主进程里独立执行；中文说明一律写在本函数外面（写进去会让产物不是 ASCII，bundle 直接语法错误）。
// 逻辑要点：版本不对/文件缺失/解析失败/条件不满足，一律只是"少推参数"，绝不抛异常（最坏等于没打补丁）。
// 与 §4.3 原文的差异只在这几处（都是 §10 的实测修订）：
//   1) `o.auth.requiresOpenaiAuth === true` 成为必要条件（§10.2 的假阳性防线：launcher 已确认表存在才写它）；
//   2) 内置 provider id 白名单挡板（§10.1 的运行时第二道防线：会话中途切成内置 id 时不推致命 -c）；
//   3) 表头判定改用 §10.2 的统一规则（正则抓表头、先砍 # 注释）与首行去 BOM；
//   4) 表头名里的引号一律剥离后再比较——这样 [model_providers."custom"]（存在）与
//      [model_providers."custom".http_headers]（子表，bad）两边都覆盖到，与 §4.3 原文的两种判定等价；
//   5) TOML 解析加**多行字符串感知**（口径与 launcher 的 forEachStructuralLine/structuralFlags 同源）：
//      落在 """ / ''' 内部的行整行跳过，不再参与表判定。不加这层会产生**致命**假阳性（实测：
//      只出现在多行字符串里的假表头被当真表 -> 推出 -c model_providers.<id>.requires_openai_auth=true ->
//      而 config 里其实没有那张表 -> codex app-server 50~61ms 后以退出码 1 退出，报
//      `model_providers.custom: provider name must not be empty`，用户整块功能不可用）。
//      同时修掉反向的假阴性：真表存在、但多行字符串里出现子表名或 env_key 行时，过去会被误判成 bad
//      而**不推** -c（用户仍 401、但启动器日志说"已修"）。两端同源后这两个方向都消失。
//   6) 多行字符串的**转义语义**也要同源（函数体内 endAt 那段，等价于 launcher 的 findMultiEnd）：
//      `"""` 是基本字符串，"\"\"\"" 里的引号被反斜杠转义、**不算收尾**（数前面连续反斜杠的个数，
//      奇数=转义）；`'''` 是字面量字符串、没有转义，直接找。不看转义会把这一行当成收尾、
//      字符串提前结束，导致后面一张真表被当成"在字符串里"而漏掉（实测分歧：launcher 判
//      direct-no-credential 会写覆盖，我却不推 -c —— 危害是"少推参数"、用户仍 401 但日志说已修）。
function launcherOverrides() {
  var fs = require("fs"), path = require("path"), os = require("os"), out = [];
  var o;
  try { o = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(process.execPath)), "codex-launcher-overrides.json"), "utf8")); } catch (e) { return out; }
  if (!o || o.version !== 1) return out;
  try {
    var c = o.catalog;
    if (typeof c === "string" && path.isAbsolute(c) && fs.statSync(c).isFile()) out.push("-c", "model_catalog_json=" + JSON.stringify(c));
  } catch (e) {}
  try {
    var p = o.auth && o.auth.requiresOpenaiAuth === true ? o.auth.provider : null;
    if (typeof p !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p)) return out;
    if (['openai', 'ollama', 'lmstudio', 'amazon-bedrock'].indexOf(p) >= 0) return out;
    var h = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    var a = JSON.parse(fs.readFileSync(path.join(h, "auth.json"), "utf8"));
    var k = a && a.OPENAI_API_KEY;
    if (typeof k !== "string" || !k.trim() || a.tokens) return out;
    var raw = fs.readFileSync(path.join(h, "config.toml"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    var structural = (function () {
      var flags = [], delim = null;
      function endAt(body, from) {
        var i = from;
        for (;;) {
          var at = body.indexOf(delim, i);
          if (at < 0) return -1;
          if (delim === '"""') {
            var bs = 0, bsk = at - 1;
            while (bsk >= 0 && body.charAt(bsk) === "\\") { bs++; bsk--; }
            if (bs % 2 === 1) { i = at + 1; continue; }
          }
          return at;
        }
      }
      for (var i = 0; i < raw.length; i++) {
        var line = String(raw[i]);
        if (delim !== null) {
          flags.push(false);
          if (endAt(line, 0) >= 0) delim = null;
          continue;
        }
        flags.push(true);
        var hashAt = -1, q = null;
        for (var j = 0; j < line.length; j++) {
          var c = line.charAt(j);
          if (q) { if (q === '"' && c === "\\") { j++; continue; } if (c === q) q = null; continue; }
          if (c === '"' || c === "'") { q = c; continue; }
          if (c === "#") { hashAt = j; break; }
        }
        var body = hashAt >= 0 ? line.slice(0, hashAt) : line;
        var d3 = body.indexOf('"""'), q3 = body.indexOf("'''");
        var at = d3 < 0 ? q3 : (q3 < 0 ? d3 : Math.min(d3, q3));
        if (at >= 0) {
          delim = body.substr(at, 3);
          if (endAt(body, at + 3) >= 0) delim = null;
        }
      }
      return flags;
    })();
    var inT = false, found = false, bad = false;
    for (var i = 0; i < raw.length; i++) {
      if (!structural[i]) continue;
      var t = raw[i].split("#")[0].trim();
      if (!t) continue;
      if (t.charAt(0) === "[") {
        var n = "", mm = /^\[\s*model_providers\s*\.\s*(.*?)\s*\]$/.exec(t);
        if (mm) n = mm[1];
        n = n.split("\"").join("").split("'").join("");
        inT = n === p;
        if (inT) found = true;
        else if (n.indexOf(p + ".") === 0) bad = true;
        continue;
      }
      if (inT && /^(env_key|auth|aws|http_headers|env_http_headers|query_params)\s*=/.test(t)) bad = true;
    }
    if (found && !bad) out.push("-c", "model_providers." + p + ".requires_openai_auth=true");
  } catch (e) {}
  return out;
}
// 注入源码：整体包一层括号再立即调用（ECMAScript 逗号表达式里不能直接出现 function 声明）
const NET_INJECT_SRC = '(' + launcherOverrides.toString() + ')()';

// 在 asar 里找含 NET_MARKER 的主进程 bundle；返回 { rel, offset, size, node, text }（text 为 latin1 原文），
// 找不到返回 null；只读，不写。命中多个时取最大的那个（与 locateBundles 同一取舍：最大 = 主进程主 bundle）
function locateNetBundle(header, dataBase, fd) {
  const files = listAsarEntries(header).filter(e => NET_BUNDLE_RE.test(e.rel) && e.size < NET_BUNDLE_MAX_SIZE);
  let best = null, bestText = null;
  for (const e of files) {
    const s = readAsarEntry(fd, dataBase, e).toString('latin1');
    if (!s.includes(NET_MARKER)) continue;
    if (!best || e.size > best.size) { best = e; bestText = s; }
  }
  if (!best) return null;
  return { rel: best.rel, offset: best.offset, size: best.size, node: best.node, text: bestText };
}

// 对 bundle 文本（latin1 字符串）应用 net 补丁。返回 { ok, actual, text }：
// actual = NET_RE 的命中数；只有 actual === 1 时 ok=true 且 text 为注入后的文本，否则 ok=false、text=原文。
// 替换必须用函数式 replace：替换串里含 $（注入的代码里有正则字面量）会被当成替换模式。
// 幂等：注入后的文本不再含原文三元形态（中间插了 push），二次调用 actual=0 -> ok=false、text=原文（不重复注入）。
function applyNetPatch(s) {
  const actual = (s.match(new RegExp(NET_RE.source, 'g')) || []).length;
  if (actual !== 1) return { ok: false, actual, text: s };
  const text = s.replace(NET_RE, (m, v, rest) =>
    'return ' + v + '.push(...' + NET_INJECT_SRC + '),' + v + '.length===0?' + rest);
  return { ok: true, actual, text };
}

// 已打过 net 补丁的判断（自检/报告用）。标记串是一个左括号的形态：NET_INJECT_SRC 自带一层括号，
// 规格早期写的两个左括号形态永远匹配不上（实测产物是 .push(...(function launcherOverrides()）。
function hasNetPatch(s) {
  return s.includes('function launcherOverrides') && s.includes(NET_OVERRIDES_FILE);
}

// 测试 / probe 辅助：从（已打补丁的）bundle 文本里抽出 ec() 函数体与它引用的 Ts、Es 常量，
// 在 vm 里用给定的假 process（execPath / env）执行，返回 app-server 参数数组。
// 抽取方式按结构定位（"含 flatMap 的 ec 函数 + Ts/Es 常量"），不写死变量名（实测两版变量名不同：
// ec/e/Es/Ts 与 $s/e/Ts/ws）；找不到或结果不是数组时 throw Error（中文）。
function evalNetArgs(patchedText, fakeProcess) {
  if (typeof patchedText !== 'string' || !patchedText.length) throw new Error('evalNetArgs: bundle 文本为空');
  // 先收集所有 function X(){ 声明起点（两版实测变量名不同，不能写死；\s* 容忍 `function ec() {` 的写法）。
  const starts = [];
  {
    const fnStartRe = new RegExp('function ([\\w$]+)\\(\\s*\\)\\s*\\{', 'g');
    let m;
    while ((m = fnStartRe.exec(patchedText))) starts.push({ name: m[1], at: m.index });
  }
  // 候选 = 每个"以 `--analytics-default-enabled`]} 结尾"的位置，向前找最近的、其函数体含 .flatMap( 的 function 声明。
  // 从近到远逐个试（而不是"取最后一个"或"取最近一个"）：补丁后的文本里，ec 内部还嵌着注入的
  // function launcherOverrides()，它比 ec 更靠近尾部，但体内没有 .flatMap(，会被跳过——ec 才是候选。
  // 只接受含 .flatMap( 的候选（ec 独有的结构特征）。
  // 注意：两个 while 用的正则必须带 g，否则 exec 的 lastIndex 不前进会死循环。
  const candidates = [];
  {
    const tailRe = new RegExp('`--analytics-default-enabled`\\]\\}', 'g');
    let m;
    while ((m = tailRe.exec(patchedText))) {
      const end = m.index + m[0].length;
      for (let i = starts.length - 1; i >= 0; i--) {
        const st = starts[i];
        if (st.at >= m.index) continue;
        const src = patchedText.slice(st.at, end);
        if (!src.includes('.flatMap(')) continue;   // 注入的 launcherOverrides 在这里被排除
        candidates.push({ name: st.name, src });
        break;
      }
    }
  }
  const ec = candidates[0];
  if (!ec) throw new Error('evalNetArgs: 找不到含 flatMap 的 app-server 参数函数（ec）');
  const ecName = ec.name, ecSrc = ec.src;
  // 原版形态：let V=Ts.flatMap(...)；补丁后：let V=Es.flatMap(...)（逗号表达式里插了 push）——只找"名字 + ="
  const baseRe = new RegExp('([\\w$]+)\\s*=\\s*([\\w$]+)\\.flatMap\\(');
  const base = baseRe.exec(ecSrc);
  if (!base) throw new Error('evalNetArgs: ec() 里找不到 <变量>=<常量>.flatMap( 形态');
  const constName = base[2];
  const ts = /([\w$]+)\s*=\s*\[`-c`,`features\.code_mode_host=true`\]/.exec(patchedText);
  if (!ts) throw new Error('evalNetArgs: 找不到 Ts 形态常量（[`-c`,`features.code_mode_host=true`]）');
  let es = null;
  const esRe = new RegExp('([\\w$]+)\\s*=\\s*(\\[\\{configKey:`chatgpt_base_url`[\\s\\S]*?\\}\\])', 'g');
  let em;
  while ((em = esRe.exec(patchedText))) if (em[1] === constName) es = em;
  if (!es) throw new Error('evalNetArgs: 找不到 ' + constName + ' 常量（[{configKey:`chatgpt_base_url`...}]）');
  const code = 'var ' + ts[1] + '=[`-c`,`features.code_mode_host=true`],' + es[1] + '=' + es[2] + ';'
    + ecSrc + '; ' + ecName + '()';
  const sandbox = {
    process: fakeProcess || { execPath: process.execPath, env: {} },
    require: require,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  let out;
  try {
    out = vm.runInNewContext(code, sandbox);
  } catch (e) {
    throw new Error('evalNetArgs: 执行 ec() 失败 —— ' + (e && e.message ? e.message : String(e)));
  }
  if (!Array.isArray(out)) throw new Error('evalNetArgs: 执行 ec() 的结果不是数组（实际 ' + typeof out + '）');
  return out;
}

module.exports = {
  PATCHES, BUNDLE_MARKERS, BUNDLE_RE, BUNDLE_MAX_SIZE,
  FLAT_INJ_FN, GROUP_INJ_FN,
  runCaptured, sha256File, sha256Hex,
  readAsar, listAsarEntries, integrityOf, readAsarEntry, locateBundles,
  applyPatchSet, syntaxCheckBundles, writeAsar,
  // net 补丁（主进程 app-server 参数注入）：名字与签名冻结，launcher / probe / patch-test 按此使用
  NET_OVERRIDES_FILE, NET_MARKER, NET_BUNDLE_RE, NET_RE, NET_INJECT_SRC,
  launcherOverrides, locateNetBundle, applyNetPatch, hasNetPatch, evalNetArgs,
};
