// Codex 解锁启动器：自动同步商店最新版 + 重打包补丁 + 回填 asar 哈希 + 启动
// 用法: node codex-launcher.js [--no-launch]
// 原理:
//   1. 检测商店安装的 OpenAI.Codex 当前版本（更新后自动跟随）
//   2. 镜像缺失或商店版本变化 -> 重新同步并重建解锁镜像
//   3. 解锁 = 对 webview 三个 bundle 应用 14 处补丁后重打包 app.asar，
//      并把 ChatGPT.exe 内嵌的 asar SHA256 校验值原位替换为新文件哈希
//   4. 启动镜像中的 ChatGPT.exe（商店原版保持不动）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const WORK = 'F:/test/AI项目/codex修复';
const MIRROR = 'C:/Users/86176/ChatGPT-Patched/app';
const STATE_FILE = WORK + '/launcher-state.json';
const PATCH_SET_VERSION = 'v10'; // 补丁集版本：变更会强制重建

const log = (...a) => console.log('[launcher]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  {
    file: 'shared',
    old: 'd=pgn(c.length>0?c:l.length>0?l:u),',
    rep: 'd=' + FLAT_INJ_FN + '(pgn(c.length>0?c:l.length>0?l:u)),',
    expect: 1,
    note: '滑块解析器: options 补 max/ultra 档',
  },
  {
    file: 'shared',
    old: 'f=ugn(s,o,n),p=a,',
    rep: 'f=' + GROUP_INJ_FN + '(ugn(s,o,n)),p=' + FLAT_INJ_FN + '(a),',
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
    file: 'shared',
    old: 'function $Kr(e,t){return[sqr,...(t??[]).map(',
    rep: 'function $Kr(e,t){let _t=(t&&t.length>0?t:[{id:"fast",name:"Fast"}]).concat((t??[]).some(t=>eP(t?.id,t?.name)===`ultrafast`)?[]:[{id:`ultrafast`,name:`Ultrafast`}]);return[sqr,..._t.map(',
    expect: 1,
    note: '$Kr: 档位菜单并注入 Ultrafast（保留原 Fast 假档兜底）',
  },
  // ---- app-primary ----
  {
    file: 'primary',
    old: '(t==null||r==null||r.includes(I3[t]))',
    rep: '(t==null||r==null||r.includes(I3[t])||t===`max`||t===`ultra`)',
    expect: 1,
    note: 'Xyt: 强度滑块过滤放行 max/ultra',
  },
  { // 原 Fast 解锁补丁 #2a
    file: 'primary',
    old: 'Mt=!Le&&!fe&&jt!=null&&wd(it,Et)',
    rep: 'Mt=!fe&&jt!=null', expect: 1,
    note: 'Fast: 档位图标显示条件放宽',
  },
  { // 原 Fast 解锁补丁 #2b
    file: 'primary',
    old: 'Nt=!fe&&!ce&&Ve&&Re.availableOptions.length>1',
    rep: 'Nt=!fe&&!ce', expect: 1,
    note: 'Fast: 模型选择器显示条件放宽',
  },
];

// ---------- 工具 ----------
function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
function findStoreInstall() {
  const out = execSync('powershell -NoProfile -c "(Get-AppxPackage OpenAI.Codex).InstallLocation"', { encoding: 'utf8' }).trim();
  if (!out) throw new Error('未找到商店版 OpenAI.Codex，请先从微软商店安装');
  return out.replace(/\\/g, '/') + '/app';
}
function readAsar(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const jsonLen = b.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  fs.closeSync(fd);
  return { header: JSON.parse(jb.toString('utf8')), jsonLen, headerBuf: jb };
}
function integrityOf(buf) {
  const hex = b => crypto.createHash('sha256').update(b).digest('hex');
  const blocks = [];
  for (let i = 0; i < buf.length; i += 4194304) blocks.push(hex(buf.subarray(i, Math.min(buf.length, i + 4194304))));
  return { algorithm: 'SHA256', hash: hex(buf), blockSize: 4194304, blocks };
}
function killApp() {
  try { execSync('taskkill /F /IM ChatGPT.exe', { stdio: 'pipe' }); log('已停止运行中的 ChatGPT'); sleep(1500); } catch (e) {}
  try { execSync('taskkill /F /IM Codex.exe', { stdio: 'pipe' }); } catch (e) {}
}
// 把镜像 exe 内嵌的 asar 校验哈希原位替换为新 asar 的 sha256（等长，JSON 结构不变）
function patchExeHash(exePath, newHash) {
  const buf = fs.readFileSync(exePath);
  const needle = Buffer.from('[{"file":"resources\\\\app.asar","alg":"SHA256","value":"', 'latin1');
  let pos = buf.indexOf(needle);
  if (pos < 0) return 'NO_PAYLOAD';
  const hexStart = pos + '[{"file":"resources\\\\app.asar","alg":"SHA256","value":"'.length;
  const oldHex = buf.subarray(hexStart, hexStart + 64).toString('latin1');
  if (!/^[0-9a-f]{64}$/.test(oldHex)) return 'BAD_HEX';
  if (oldHex === newHash) return 'ALREADY_OK';
  buf.subarray(hexStart, hexStart + 64).write(newHash, 'latin1');
  fs.writeFileSync(exePath, buf);
  return 'PATCHED ' + oldHex.slice(0, 8) + '->' + newHash.slice(0, 8);
}

// ---------- 重建解锁镜像 ----------
function rebuild(storeDir) {
  const storeAsar = storeDir + '/resources/app.asar';

  // 1) 同步商店目录 -> 镜像（robocopy；退出码 0-7 均为成功）
  log('同步商店文件 ...');
  fs.rmSync(MIRROR, { recursive: true, force: true });
  try {
    execSync(`robocopy "${storeDir.replace(/\//g, '\\')}" "${MIRROR.replace(/\//g, '\\')}" /E /NFL /NDL /NJH /NJS /NP`, { stdio: 'pipe' });
  } catch (e) {
    if (e.status == null || e.status >= 8) throw e;
  }

  // 2) 从镜像原版 asar 定位三个目标 bundle 并读出
  const { header, jsonLen, headerBuf } = readAsar(MIRROR + '/resources/app.asar');
  const srcDataBase = 16 + jsonLen;
  const srcFd = fs.openSync(MIRROR + '/resources/app.asar', 'r');
  const entries = [];
  (function collect(node, p) {
    if (node.files) { for (const k of Object.keys(node.files)) collect(node.files[k], p + '/' + k); return; }
    if (node.size === undefined || node.unpacked) return;
    entries.push({ node, rel: p.slice(1), offset: Number(node.offset), size: node.size });
  })(header, '');
  const bundleFiles = entries.filter(e => /^webview\/assets\/[^/]+\.js$/.test(e.rel) && e.size < 30 * 1024 * 1024);
  const readBundle = e => { const b = Buffer.alloc(e.size); fs.readSync(srcFd, b, 0, e.size, srcDataBase + e.offset); return b.toString('latin1'); };
  const findBundle = (marker, extra) => {
    let best = null;
    for (const e of bundleFiles) {
      const s = readBundle(e);
      if (!s.includes(marker)) continue;
      if (extra && !s.includes(extra)) continue;
      if (!best || e.size > best.size) best = e;
    }
    return best;
  };
  const role = {
    initial: findBundle('536305374'),
    shared: findBundle('show-ultra-in-model-picker-slider'),
    primary: findBundle('FastModeToggle'),
  };
  for (const [k, e] of Object.entries(role)) {
    if (!e) throw new Error('无法定位 ' + k + ' bundle');
    log('定位', k, '->', e.rel);
  }

  // 3) 应用补丁
  const content = new Map();
  for (const e of Object.values(role)) content.set(e.rel, readBundle(e));
  let failCount = 0;
  for (const p of PATCHES) {
    const rel = role[p.file].rel;
    let s = content.get(rel);
    let count2;
    if (p.regex) {
      count2 = (s.match(new RegExp(p.regex.source, 'g')) || []).length;
      if (count2 === p.expect) s = p.repFn ? s.replace(new RegExp(p.regex.source, p.regex.flags), p.repFn) : s.replace(new RegExp(p.regex.source, p.regex.flags), p.rep);
    } else {
      count2 = s.split(p.old).length - 1;
      if (count2 === p.expect) s = s.split(p.old).join(p.rep);
    }
    if (count2 === p.expect) {
      content.set(rel, s);
      log('OK  ', p.note);
    } else {
      failCount++;
      log('FAIL', p.note, `: 期望 ${p.expect} 处，实际 ${count2} 处（该功能未生效，其余不受影响）`);
    }
  }
  // 语法校验
  for (const [rel, s] of content) {
    const tmp = WORK + '/patched-bundles/' + path.basename(rel);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(s, 'latin1'));
    try { execSync(`node --check "${tmp}"`, { stdio: 'pipe' }); } catch (e) {
      log('FAIL 语法校验:', rel); process.exit(1);
    }
  }
  const patched = new Map([...content].map(([rel, s]) => [rel, Buffer.from(s, 'latin1')])); // latin1 读 latin1 写，字节级 1:1

  // 4) 重打包 asar（重算每个文件的 integrity）
  for (const e of entries) { const b = patched.get(e.rel); if (b) { e.newSize = b.length; e.patchedBuf = b; } else { e.newSize = e.size; } }
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
  const outDataBase = 16 + jsonBuf.length;
  const tmpAsar = MIRROR + '/resources/app.asar.new';
  const outFd = fs.openSync(tmpAsar, 'w');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(jsonBuf.length + 8, 4);
  prefix.writeUInt32LE(jsonBuf.length + 4, 8);
  prefix.writeUInt32LE(jsonBuf.length, 12);
  fs.writeSync(outFd, prefix);
  fs.writeSync(outFd, jsonBuf);
  let written = outDataBase;
  const CHUNK = 8 * 1024 * 1024, zero = Buffer.alloc(8);
  for (const e of entries) {
    while (written < outDataBase + e.newOffset) { const n = Math.min(8, outDataBase + e.newOffset - written); fs.writeSync(outFd, zero, 0, n); written += n; }
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
  fs.closeSync(outFd);
  fs.closeSync(srcFd);
  fs.renameSync(tmpAsar, MIRROR + '/resources/app.asar');
  log(`重打包完成: ${written} 字节`);

  // 5) 回填 ChatGPT.exe 内嵌的 asar 校验哈希（owl 校验的是 header JSON 的 SHA256）
  const headerHash = crypto.createHash('sha256').update(jsonBuf).digest('hex');
  for (const exe of ['ChatGPT.exe', 'Codex.exe']) {
    log('校验哈希回填', exe, '->', patchExeHash(MIRROR + '/' + exe, headerHash));
  }
  log('补丁应用完成' + (failCount ? `（${failCount} 个未命中）` : '（全部命中）'));
  return failCount;
}

async function main() {
  const noLaunch = process.argv.includes('--no-launch');
  log('检测商店版 OpenAI.Codex ...');
  const storeDir = findStoreInstall();
  const pkg = path.basename(path.dirname(storeDir));
  const fp = sha256File(storeDir + '/resources/app.asar');
  log('商店版本目录:', pkg);

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  const needRebuild = !fs.existsSync(MIRROR + '/resources/app.asar') || state.storeFingerprint !== fp || state.patchSetVersion !== PATCH_SET_VERSION;

  if (!needRebuild) {
    log('解锁镜像已是最新（', pkg, '），直接启动');
  } else {
    log('需要重建解锁镜像（商店更新或补丁集变化）...');
    killApp();
    await sleep(800);
    const failCount = rebuild(storeDir);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      storeVersion: pkg, storeFingerprint: fp, patchSetVersion: PATCH_SET_VERSION,
      failedPatches: failCount, updatedAt: new Date().toISOString(),
    }, null, 1));
  }

  if (!noLaunch) {
    log('启动 ChatGPT ...');
    spawn(MIRROR.replace(/\//g, '\\') + '\\ChatGPT.exe', [], { detached: true, stdio: 'ignore', cwd: MIRROR }).unref();
  }
}

main().catch(e => { console.error('[launcher] 出错:', e.message); process.exit(1); });
