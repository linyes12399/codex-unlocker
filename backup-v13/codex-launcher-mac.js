// Codex 解锁启动器 · macOS 版
// 用法: node codex-launcher-mac.js [--no-launch] [--force] [--dry-run] [--doctor] [--app <path>] [--selftest]
//   --no-launch            仅重建镜像，不启动
//   --force                忽略"该版本重建失败"记录，强制重试
//   --dry-run              完整走一遍（拷贝/打补丁/重打包/改 Info.plist/重签名/校验），但不替换现有镜像、不写配置、不启动
//   --doctor               只做诊断并打印报告（不动任何文件），把输出发出来即可判断能不能用
//   --app <path>           指定 Codex.app 路径（默认自动搜索 /Applications）
//   --selftest             不依赖 macOS 的自检（校验补丁集与 asar 读写）
//   --skip-asar-integrity  仅当 Info.plist 里的校验值口径无法反推时使用：删掉该键继续（会留备份）
//
// 与 Windows 版的关系：补丁定义、asar 读写/重打包逻辑在 lib/launcher-core.js，两边共用同一份。
// 差异（macOS 特有）：
//   * 目标是 /Applications/Codex.app（Electron，Contents/Resources/app.asar）
//   * 拷贝用 ditto（保留符号链接/权限/扩展属性），不用 robocopy
//   * asar 完整性校验值在 Contents/Info.plist 的 ElectronAsarIntegrity（Windows 在 exe 内嵌资源）
//   * 改了 app.asar 会让代码签名失效 => 必须去掉 quarantine 并 ad-hoc 重新签名
//   * 结束后直接执行 Contents/MacOS/<CFBundleExecutable>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/launcher-core.js');

const HOME = os.homedir();
const MIRROR_ROOT = process.env.CODEX_MIRROR_ROOT || path.join(HOME, 'Codex-Patched');
const MIRROR_APP = path.join(MIRROR_ROOT, 'Codex.app');
const STAGING_ROOT = path.join(MIRROR_ROOT, '.staging');
const STAGING_APP = path.join(STAGING_ROOT, 'Codex.app');
const STATE_FILE = path.join(MIRROR_ROOT, 'launcher-state.json');
const PATCH_SET_VERSION = 'mac-v1'; // 补丁集版本：变更会强制重建
const RES_LINK = (process.env.CODEX_ELECTRON_RESOURCES_PATH || '').trim();
const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml');
const ULTRAFAST_TIER = { id: 'ultrafast', name: 'Ultrafast', description: '2x speed, increased usage' };

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY_RUN = flag('--dry-run');
const NO_LAUNCH = flag('--no-launch');
const FORCE = flag('--force');
const DOCTOR = flag('--doctor');
const SELFTEST = flag('--selftest');
const SKIP_ASAR_INTEGRITY = flag('--skip-asar-integrity');
const APP_OVERRIDE = opt('--app');

const log = (...a) => console.log('[launcher]', ...a);
const warn = (...a) => console.log('[launcher][警告]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (file, args, opts) => core.runCaptured(file, args, opts);

// 子进程失败的文本：优先取输出的最后两行；命令本身没跑起来（ENOENT/超时）时只有 message 有信息，
// 所以不能一律只留"最后一行"。
function errText(e) {
  const out = String((e && (e.stderr || e.stdout)) || '').trim();
  const tail = out.split('\n').map(s => s.trim()).filter(Boolean).slice(-2).join(' | ');
  return tail || (e && e.message) || String(e);
}

// ================= macOS 应用定位 =================

function readPlist(plistPath, keyPath) {
  const args = keyPath ? ['-extract', keyPath, 'raw', '-o', '-', plistPath] : ['-convert', 'json', '-o', '-', plistPath];
  return sh('plutil', args).trim();
}
function readPlistJSON(plistPath, keyPath) {
  const args = keyPath ? ['-extract', keyPath, 'json', '-o', '-', plistPath] : ['-convert', 'json', '-o', '-', plistPath];
  return JSON.parse(sh('plutil', args));
}

// 从 asar 头部读 package.json（用于确认"这确实是 Codex.app"以及版本号）
function asarPackageJson(asarPath) {
  const { header, dataBase } = core.readAsar(asarPath);
  const entry = core.listAsarEntries(header).find(e => e.rel === 'package.json');
  if (!entry) return null;
  const fd = fs.openSync(asarPath, 'r');
  try { return JSON.parse(core.readAsarEntry(fd, dataBase, entry).toString('utf8')); } finally { fs.closeSync(fd); }
}

// 校验候选目录确实是 Codex 桌面端（Electron）
function inspectApp(appPath) {
  if (!appPath || !fs.existsSync(appPath)) return null;
  const contents = path.join(appPath, 'Contents');
  const asarPath = path.join(contents, 'Resources', 'app.asar');
  const plistPath = path.join(contents, 'Info.plist');
  if (!fs.existsSync(asarPath) || !fs.existsSync(plistPath)) return null;
  let pkg;
  try { pkg = asarPackageJson(asarPath); } catch (e) { return null; }
  if (!pkg || (pkg.name !== 'openai-codex-electron' && pkg.productName !== 'Codex')) return null;
  const info = {
    appPath, contents, asarPath, plistPath,
    bundleId: (() => { try { return readPlist(plistPath, 'CFBundleIdentifier'); } catch (e) { return null; } })(),
    shortVersion: (() => { try { return readPlist(plistPath, 'CFBundleShortVersionString'); } catch (e) { return null; } })(),
    executable: (() => { try { return readPlist(plistPath, 'CFBundleExecutable'); } catch (e) { return 'Codex'; } })(),
    asarVersion: pkg.version,
    buildFlavor: pkg.codexBuildFlavor,
  };
  info.binary = path.join(contents, 'MacOS', info.executable || 'Codex');
  return info;
}

function findApp() {
  const tried = [];
  const consider = p => {
    if (!p) return null;
    tried.push(p);
    const a = inspectApp(p);
    return a;
  };
  if (APP_OVERRIDE) {
    // 允许写 ~/xxx（path.resolve 不会展开 ~）
    const expanded = APP_OVERRIDE.startsWith('~/') ? path.join(HOME, APP_OVERRIDE.slice(2)) : APP_OVERRIDE;
    const p = path.resolve(expanded);
    // 指着镜像目录自己会导致"把镜像拷到镜像上"，直接拒绝
    if (normLink(p).startsWith(normLink(MIRROR_ROOT) + path.sep)) {
      throw new Error('--app 指向的是解锁镜像自己的目录，不能作为源：' + p);
    }
    const a = consider(p);
    if (a) return a;
    const why = inspectAppFailure(p);
    throw new Error('--app 指定的路径不是可用的 Codex.app: ' + p + (why ? '（' + why + '）' : ''));
  }
  for (const name of ['Codex.app', 'OpenAI Codex.app', 'Codex Beta.app']) {
    for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
      const a = consider(path.join(dir, name));
      if (a) return a;
    }
  }
  // Spotlight 兜底（用户把应用放到别处的情况）
  if (process.platform === 'darwin') {
    for (const q of ['kMDItemCFBundleIdentifier == "com.openai.codex"',
                     'kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "Codex"cd']) {
      let out = '';
      try { out = sh('mdfind', [q]); } catch (e) { continue; }
      for (const line of out.split('\n').map(s => s.trim()).filter(Boolean)) {
        const a = consider(line);
        if (a) return a;
      }
    }
  }
  const e = new Error('没有找到 Codex.app（已查找: ' + Array.from(new Set(tried)).join(', ') + '）');
  e.hint = '请先从 https://openai.com/codex 下载并安装 Codex（macOS 版），或用 --app 指定路径';
  throw e;
}

// inspectApp 失败的具体原因（用于把"不是 Codex.app"这种含糊报错说清楚）
function inspectAppFailure(appPath) {
  if (!fs.existsSync(appPath)) return '路径不存在';
  const contents = path.join(appPath, 'Contents');
  if (!fs.existsSync(contents)) return '不是 .app 结构（没有 Contents）';
  if (!fs.existsSync(path.join(contents, 'Info.plist'))) return '缺少 Contents/Info.plist';
  const asarPath = path.join(contents, 'Resources', 'app.asar');
  if (!fs.existsSync(asarPath)) return '缺少 Contents/Resources/app.asar（不是 Electron 应用？）';
  try {
    const pkg = asarPackageJson(asarPath);
    if (!pkg) return 'app.asar 里没有 package.json';
    return 'asar 内 package.json 的 name/productName 不是 Codex（' + (pkg.name || pkg.productName || '空') + '）';
  } catch (e) { return '读 app.asar 头部失败：' + errText(e); }
}

// ================= 进程 =================

// 命令行里正在运行 dir 之下可执行文件的进程。
// 收紧过：只认「命令行里出现 dir 内的可执行文件路径」，而不是「命令行里出现过这个字符串」——
// 否则一个恰好打开了 ~/Codex-Patched 下某个文件的编辑器/脚本也会被算进来，而 killApp 会把它杀掉。
// 注意 ps 默认按终端宽度截断 command，所以加 -ww 取完整命令行。
function pidsUnder(dir) {
  let out;
  try { out = sh('ps', ['-Aww', '-o', 'pid=,command=']); } catch (e) { return []; }
  const root = path.resolve(dir).replace(/\/+$/, '');
  // .app 只认包内路径（Contents/MacOS 主程序、Contents/Frameworks 里的 Helper 等）
  const prefix = root + (root.endsWith('.app') ? '/Contents/' : '/');
  const pids = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pid === process.ppid) continue;
    for (const raw of m[2].split(/\s+/)) {
      const token = raw.replace(/^['"]+|['"]+$/g, '');
      if (!token.startsWith('/')) continue;
      if (token.startsWith(prefix)) { pids.push(pid); break; }
    }
  }
  return pids;
}

async function killApp() {
  const pids = pidsUnder(MIRROR_APP);
  if (!pids.length) return;
  const alive = p => { try { process.kill(p, 0); return true; } catch (e) { return false; } };
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
  for (let i = 0; i < 50; i++) { // 先给 10 秒让它自己退出（Codex 要落盘状态）
    await sleep(200);
    if (!pids.some(alive)) { log('已停止运行中的镜像应用'); return; }
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (e) {} }
  log('已强制停止运行中的镜像应用');
}

// ================= 代码签名 / 隔离属性 =================

function codesignInfo(appPath) {
  const info = { verify: null, verifyOut: '', entitlements: null, authority: null, isAdhoc: false };
  try { info.verifyOut = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]); info.verify = true; }
  catch (e) { info.verifyOut = String(e.stderr || e.message || '').trim(); info.verify = false; }
  try {
    const d = sh('codesign', ['-d', '--verbose=4', appPath]);
    info.authority = (d.split('\n').find(l => /Authority=|Signature=/.test(l)) || '').trim();
    info.isAdhoc = /Signature=adhoc/.test(d);
  } catch (e) { /* codesign -d 把信息写到 stderr，runCaptured 已合并，忽略 */ }
  try { info.entitlements = sh('codesign', ['-d', '--entitlements', ':-', appPath]).trim() || null; } catch (e) {}
  return info;
}

function clearQuarantine(p) {
  try { sh('xattr', ['-dr', 'com.apple.quarantine', p]); return true; } catch (e) { return false; }
}
function quarantineAttrs(p) {
  try { return sh('xattr', ['-r', '-l', p]).split('\n').filter(l => /com\.apple\.quarantine/.test(l)).length; }
  catch (e) { return null; } // null = 读不出来（和"确实没有隔离属性"区分开）
}

// 读取签名里的 entitlements（codesign 把 XML plist 打到 stdout）；没有则返回 ''
function readEntitlements(appPath) {
  try { return sh('codesign', ['-d', '--entitlements', ':-', appPath]).trim(); } catch (e) { return ''; }
}
// Electron 需要的 JIT / 可执行内存等权限都在这一组前缀里
const hasSecurityEntitlements = xml => /<key>\s*com\.apple\.security\./.test(xml);

// ad-hoc 重新签名：改了 app.asar 之后原签名必然失效，不重签 macOS 会拒绝启动。
// 依次尝试更保守的方案；每次都做 codesign --verify 确认签好了。
// 另外单独校验 entitlements 有没有丢：--verify 只查封印结构，查不出权限丢失，
// 而 Electron 在 Apple 芯片上依赖 JIT 相关权限，静默丢掉会得到一个"看着成功、启动就崩"的镜像。
function resign(appPath) {
  const origEnt = readEntitlements(appPath);
  const origHas = hasSecurityEntitlements(origEnt);
  let entFile = null;
  if (origHas) {
    try {
      entFile = path.join(os.tmpdir(), `codex-entitlements-${process.pid}.plist`);
      fs.writeFileSync(entFile, origEnt);
    } catch (e) { entFile = null; }
  }
  const attempts = [
    { desc: 'ad-hoc + 保留原 entitlements', args: ['--force', '--sign', '-', '--preserve-metadata=entitlements', appPath] },
  ];
  if (entFile) attempts.push({ desc: 'ad-hoc + 显式传入原 entitlements', args: ['--force', '--sign', '-', '--entitlements', entFile, appPath] });
  attempts.push({ desc: 'ad-hoc --deep + 保留原 entitlements', args: ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', appPath] });
  attempts.push({ desc: 'ad-hoc（不带 entitlements）', args: ['--force', '--sign', '-', appPath] });

  const tried = [];
  let fallback = null;
  try {
    for (const a of attempts) {
      try { sh('codesign', a.args); }
      catch (e) { tried.push(`${a.desc}: codesign 失败（${errText(e)}）`); continue; }
      try { sh('codesign', ['--verify', '--strict', '--verbose=2', appPath]); }
      catch (e) { tried.push(`${a.desc}: 已签名但 --verify 未通过（${errText(e)}）`); continue; }
      const kept = !origHas || hasSecurityEntitlements(readEntitlements(appPath));
      if (!kept) {
        tried.push(`${a.desc}: 签名有效，但原 entitlements 丢了`);
        if (!fallback) fallback = { ok: true, mode: a.desc, tried, lostEntitlements: true };
        continue;
      }
      return { ok: true, mode: a.desc, tried, lostEntitlements: false };
    }
    if (fallback) return fallback;
    return { ok: false, mode: null, tried, lostEntitlements: false };
  } finally {
    if (entFile) fs.rmSync(entFile, { force: true });
  }
}

// ================= Info.plist 的 asar 完整性 =================
// Electron 在 macOS 上从 Contents/Info.plist 的 ElectronAsarIntegrity 读 asar 校验值：
//   ElectronAsarIntegrity = { "Resources/app.asar" = { algorithm = "SHA256"; hash = "<hex>" } }
// 我们改了 app.asar，这个值必须同步更新，否则应用启动即崩。
// hash 具体对哪段字节取摘要，各版本实现细节不同 —— 这里不猜：用"原版 asar + plist 里记着的旧值"
// 反推出究竟用的是哪种口径，再用同样的口径写回新值。反推不出来就宁可不动并明确告警。

function asarHeaderCandidates(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const wholeHeader = Buffer.alloc(8 + headerSize);
    fs.readSync(fd, wholeHeader, 0, wholeHeader.length, 0);
    const jsonBuf = wholeHeader.subarray(16, 16 + jsonLen);
    const payload = wholeHeader.subarray(8);                         // [payloadLen][jsonLen][json][pad]
    const pickle = wholeHeader.subarray(4);                          // [headerSize][payload]
    return {
      // 顺序就是探测顺序；name 会写进日志，便于人工核对
      list: [
        { name: 'json(header JSON 字节)', buf: jsonBuf },
        { name: 'payload(8..8+headerSize)', buf: payload },
        { name: 'pickle(4..8+headerSize)', buf: pickle },
        { name: 'whole(0..8+headerSize)', buf: wholeHeader },
      ],
      jsonBuf, headerSize, jsonLen,
    };
  } finally { fs.closeSync(fd); }
}

// 把 plist 里记录的 hash 规范成小写 hex 便于比较（容忍 hex / base64 / sha256-<b64> 等写法）
function normalizeHash(s) {
  const t = String(s).trim().replace(/^sha256[-:/]/i, '');
  if (/^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  try {
    const b = Buffer.from(t, 'base64');
    if (b.length === 32) return b.toString('hex');
  } catch (e) {}
  return null;
}

function readAsarIntegrity(plistPath) {
  let dict;
  try { dict = readPlistJSON(plistPath, 'ElectronAsarIntegrity'); } catch (e) { return { present: false, entries: [] }; }
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return { present: false, entries: [] };
  const entries = Object.keys(dict).map(k => ({
    key: k,
    value: dict[k] || {},
    hash: (dict[k] || {}).hash ?? null,
    algorithm: (dict[k] || {}).algorithm ?? null,
  }));
  // 仅供展示：优先挑名字像 app.asar 的那条
  const pref = entries.find(e => /app\.asar$/.test(e.key)) || entries[0] || { key: null, hash: null, algorithm: null };
  return { present: true, dict, entries, key: pref.key, hash: pref.hash, algorithm: pref.algorithm };
}

// 返回 { status, mode, note }，status ∈ ok | absent | unknown | failed | patched | removed
// skipOnUnknown: 口径完全无法反推时，是否允许"删掉整个键"继续（--skip-asar-integrity）。
//   这是一条**未经真机验证**的假设**：Electron 对"plist 里没有该 asar 的条目"按"无需校验"处理。
//   所以它只是最后手段：会先备份 Info.plist，并且只在"按原值反推口径"这条路彻底走不通时才用。
function syncAsarIntegrity(appPath, origAsarPath, newAsarPath, { skipOnUnknown = false } = {}) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const integ = readAsarIntegrity(plistPath);
  if (!integ.present) {
    return { status: 'absent', note: 'Info.plist 里没有 ElectronAsarIntegrity（该构建没开 asar 完整性校验，无需处理）' };
  }
  const backup = plistPath + '.before-codex-launcher';
  const doBackup = () => { try { fs.copyFileSync(plistPath, backup); } catch (e) {} };
  const doRestore = () => { try { if (fs.existsSync(backup)) fs.copyFileSync(backup, plistPath); } catch (e) {} };

  // 候选口径只算一次（header 有 5 MB 量级，重复算会白读几十 MB）
  const orig = asarHeaderCandidates(origAsarPath);
  const origHash = orig.list.map(c => core.sha256Hex(c.buf));
  const describeCandidates = () => orig.list.map((c, i) => `${c.name}=${origHash[i]}`).join('\n      ');

  // 不靠键名猜：拿 plist 里各条记录的值去和"原版 asar 的候选口径"比对，谁对得上就是它。
  // 这样即使键名写法不同（Resources/app.asar / Contents/Resources/app.asar / 别的），也不会写错条目。
  const matches = [];
  for (const e of integ.entries) {
    const h = normalizeHash(e.hash);
    if (!h) continue;
    const idx = origHash.indexOf(h);
    if (idx >= 0) matches.push({ key: e.key, idx });
  }
  const chosen = matches.find(m => /app\.asar$/.test(m.key)) || matches[0] || null;

  if (!chosen) {
    const detail = `无法把 Info.plist 里的记录对上原版 asar header 的任何一种口径。\n`
      + `      plist 里的条目: ${integ.entries.map(e => `${e.key}=${e.hash}`).join(' , ') || '(无)'}\n`
      + `      四种候选口径算出来分别是:\n      ` + describeCandidates();
    if (!skipOnUnknown) {
      return {
        status: 'unknown',
        note: detail + `\n      => 为避免写进错误的校验值把应用搞崩，已中止（没有改动任何东西）。`
          + `若你确认可以接受，加 --skip-asar-integrity 重跑：它会删掉 ElectronAsarIntegrity（先备份原 Info.plist），`
          + `赌 Electron 找不到条目就跳过校验——这一条没有在真机上验证过。`,
      };
    }
    doBackup();
    try { sh('plutil', ['-remove', 'ElectronAsarIntegrity', plistPath]); }
    catch (e) { doRestore(); return { status: 'failed', note: 'plutil -remove 失败: ' + errText(e) }; }
    const after = readAsarIntegrity(plistPath);
    if (after.present) { doRestore(); return { status: 'failed', note: '删除 ElectronAsarIntegrity 后回读仍然存在，已回滚' }; }
    return {
      status: 'removed', mode: 'removed',
      note: `已删除 ElectronAsarIntegrity（原 Info.plist 备份在 ${backup}）。\n      ${detail}`,
    };
  }

  const mode = orig.list[chosen.idx].name;
  const nb = asarHeaderCandidates(newAsarPath);
  const newHex = core.sha256Hex(nb.list[chosen.idx].buf);
  const oldHex = origHash[chosen.idx];
  if (newHex === oldHex) return { status: 'ok', mode, note: 'Info.plist 里的校验值本来就是新 asar 的（无需改动）', hex: newHex };

  doBackup();
  // 键路径里的 "." 需要转义（例如 Resources/app.asar 里的那个点）
  const keyPath = 'ElectronAsarIntegrity.' + chosen.key.replace(/\\/g, '\\\\').replace(/\./g, '\\.') + '.hash';
  try {
    sh('plutil', ['-replace', keyPath, '-string', newHex, plistPath]);
  } catch (e) {
    doRestore();
    return { status: 'failed', note: `plutil -replace 失败（${keyPath}）: ` + errText(e) };
  }
  // 写完必须复核：值对不对、plist 还能不能被解析
  try {
    const back = readAsarIntegrity(plistPath);
    const got = (back.entries.find(e => e.key === chosen.key) || {}).hash;
    if (normalizeHash(got) !== newHex) throw new Error('回读值不一致: ' + got);
    readPlistJSON(plistPath, null); // 整份 plist 仍可解析
  } catch (e) {
    doRestore();
    return { status: 'failed', note: '更新后复核失败，已回滚 Info.plist: ' + e.message };
  }
  return { status: 'patched', mode, hex: newHex, note: `已按「${mode}」口径更新 Info.plist 里 ${chosen.key} 的校验值` };
}

// ================= 模型目录（与 Windows 版逻辑相同） =================

function findCodexCLI(appPath) {
  const res = path.join(appPath, 'Contents', 'Resources');
  const cands = [
    path.join(res, 'codex'),
    path.join(res, 'codex.exe'),
    path.join(res, 'bin', 'codex'),
    path.join(res, 'app.asar.unpacked', 'codex'),
    path.join(res, 'app.asar.unpacked', 'bin', 'codex'),
  ];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  try {
    for (const f of fs.readdirSync(res)) {
      if (f === 'codex' || f === 'codex.exe') { const p = path.join(res, f); if (fs.statSync(p).isFile()) return p; }
    }
  } catch (e) {}
  return null;
}

function catalogPath() {
  let toml;
  try { toml = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch (e) { return null; }
  const m = toml.match(/^\s*model_catalog_json\s*=\s*(["'])(.*?)\1/m);
  if (!m) return null;
  return m[1] === '"' ? m[2].replace(/\\\\/g, '\\') : m[2];
}

function buildCatalogJson(codexBin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
  let out;
  try {
    out = sh(codexBin, ['debug', 'models', '--bundled'], { timeout: 120000, env: { ...process.env, CODEX_HOME: home } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const cat = JSON.parse(out);
  if (!Array.isArray(cat.models) || cat.models.length === 0) throw new Error('导出的目录没有 models');
  for (const m of cat.models) {
    if (!Array.isArray(m.service_tiers)) m.service_tiers = [];
    if (!m.service_tiers.some(t => t && t.id === 'ultrafast')) m.service_tiers.push({ ...ULTRAFAST_TIER });
  }
  return { text: JSON.stringify(cat, null, 2), count: cat.models.length };
}

function addCatalogToConfig(target) {
  let toml = '';
  try { toml = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bom = toml.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const next = bom + `model_catalog_json = "${target}"` + eol + toml.slice(bom.length);
  const bak = CODEX_CONFIG + '.before-codex-launcher';
  if (toml && !fs.existsSync(bak)) fs.copyFileSync(CODEX_CONFIG, bak);
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG + '.tmp', next);
  fs.renameSync(CODEX_CONFIG + '.tmp', CODEX_CONFIG);
  log('已在', CODEX_CONFIG, '开头加入 model_catalog_json', toml ? '（原文件备份为 config.toml.before-codex-launcher）' : '（新建）');
}

function regenCatalog(allowSetup) {
  let target = catalogPath();
  const needConfig = !target;
  if (needConfig && !allowSetup) { log('config.toml 未配置 model_catalog_json，跳过模型目录更新'); return true; }
  if (needConfig) target = path.join(path.dirname(CODEX_CONFIG), 'model-catalog-ultrafast.json');
  const codexBin = findCodexCLI(MIRROR_APP);
  if (!codexBin) { warn('镜像里没找到 codex 命令行（Contents/Resources/codex），跳过模型目录更新'); return false; }
  try {
    const { text, count } = buildCatalogJson(codexBin);
    let cur = null;
    try { cur = fs.readFileSync(target, 'utf8'); } catch (e) {}
    if (cur === text) log('模型目录已是最新（', count, '个模型）');
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (cur !== null) fs.copyFileSync(target, target + '.bak');
      fs.writeFileSync(target + '.tmp', text);
      fs.renameSync(target + '.tmp', target);
      log('模型目录已更新:', count, '个模型（已补 ultrafast）->', target, cur !== null ? '（旧文件备份为 .bak）' : '');
    }
    if (needConfig) addCatalogToConfig(target);
    return true;
  } catch (e) {
    try { fs.rmSync(target + '.tmp', { force: true }); } catch (_) {}
    warn('模型目录更新失败，保留现有文件:', errText(e));
    return false;
  }
}

// ================= 资源目录同步（CODEX_ELECTRON_RESOURCES_PATH） =================

const normLink = p => path.resolve(p).toLowerCase();

function removeEntry(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

function replaceFile(src, dst) {
  const tmp = dst + '.new-' + process.pid;
  fs.rmSync(tmp, { force: true });
  try { fs.linkSync(src, tmp); } catch (e) { fs.copyFileSync(src, tmp); }
  try { fs.renameSync(tmp, dst); }
  catch (e) {
    try {
      fs.renameSync(dst, path.join(path.dirname(dst), '.stale-' + Date.now() + '-' + path.basename(dst)));
      fs.renameSync(tmp, dst);
    } catch (e2) { fs.rmSync(tmp, { force: true }); throw e2; }
  }
}

function resLinkSafe() {
  // 先规范化到真实路径：否则一个指向 /Applications 的符号链接能绕过下面的黑名单
  let r = normLink(RES_LINK);
  try { r = normLink(fs.realpathSync(RES_LINK)); } catch (e) { /* 还不存在就用 resolve 的结果 */ }
  const root = normLink(MIRROR_ROOT);
  if (r === root || r.startsWith(root + path.sep) || root.startsWith(r + path.sep)) return '指向了镜像目录本身';
  if (r === path.parse(r).root || r === normLink(HOME)) return '指向了根目录或用户目录';
  for (const d of ['/system', '/library', '/applications', '/usr', '/bin', '/sbin', '/volumes']) {
    if (r === d || r.startsWith(d + '/')) return '指向了系统目录 ' + d;
  }
  let names;
  try { names = fs.readdirSync(RES_LINK); } catch (e) { return null; }
  if (names.length && !names.includes('app.asar')) return '目录非空且不像 resources 目录（没有 app.asar）';
  return null;
}

function syncResources() {
  const src = path.join(MIRROR_APP, 'Contents', 'Resources');
  if (!RES_LINK || !mirrorUsable()) return;
  const unsafe = resLinkSafe();
  if (unsafe) { warn('跳过资源目录同步: CODEX_ELECTRON_RESOURCES_PATH', unsafe, '->', RES_LINK); return; }
  fs.mkdirSync(RES_LINK, { recursive: true });
  const want = new Set(fs.readdirSync(src));
  let changed = 0, failed = 0;
  for (const name of want) {
    const s = path.join(src, name), d = path.join(RES_LINK, name);
    const sst = fs.statSync(s, { bigint: true });
    let dst = null;
    try { dst = fs.lstatSync(d, { bigint: true }); } catch (e) {}
    try {
      if (sst.isDirectory()) {
        if (dst && dst.isSymbolicLink() && normLink(fs.readlinkSync(d)) === normLink(s)) continue;
        if (dst) removeEntry(d);
        fs.symlinkSync(s, d, 'dir'); // macOS 用普通符号链接（junction 是 Windows 专有）
      } else {
        if (dst && dst.isFile() && ((dst.ino === sst.ino && dst.dev === sst.dev) ||
            (dst.size === sst.size && dst.mtimeNs === sst.mtimeNs))) continue;
        if (dst && !dst.isFile()) removeEntry(d);
        replaceFile(s, d);
      }
      changed++;
    } catch (e) { failed++; warn('资源同步失败:', name, '-', e.code || e.message); }
  }
  for (const name of fs.readdirSync(RES_LINK)) {
    if (want.has(name)) continue;
    try { removeEntry(path.join(RES_LINK, name)); if (!name.startsWith('.stale-')) { changed++; log('资源目录移除多余项:', name); } }
    catch (e) { if (!name.startsWith('.stale-')) warn('资源目录无法移除:', name, '-', e.code || e.message); }
  }
  if (changed || failed) log(`资源目录同步: 更新 ${changed} 项` + (failed ? `，失败 ${failed} 项` : ''), '->', RES_LINK);
}

// ================= 重建镜像 =================

// 拷贝 .app：ditto 会保留符号链接、权限、扩展属性（cp -R 在某些情况下会丢）
function copyApp(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  sh('ditto', [src, dst]);
}

// 拷贝保真度检查：Electron 的 .app 里有大量符号链接（Framework 的 Versions/Current 等），
// 万一拷贝工具把符号链接展开成实体副本，签名和动态库加载都会出问题 —— 早点发现比事后猜好。
function verifyCopy(srcApp, dstApp, executable) {
  const problems = [];
  let want = null;
  try { want = fs.statSync(path.join(srcApp, 'Contents', 'Resources', 'app.asar')).size; } catch (e) {}
  let got = null;
  try { got = fs.statSync(path.join(dstApp, 'Contents', 'Resources', 'app.asar')).size; } catch (e) {}
  if (want === null || got === null) problems.push('拷贝后 app.asar 不存在');
  else if (want !== got) problems.push(`拷贝后 app.asar 大小不一致（${got} != ${want}）`);
  const bin = path.join(dstApp, 'Contents', 'MacOS', executable || 'Codex');
  if (!fs.existsSync(bin)) problems.push('拷贝后找不到可执行文件 ' + bin);
  if (!fs.existsSync(path.join(dstApp, 'Contents', 'Info.plist'))) problems.push('拷贝后 Info.plist 不存在');

  let links = 0, files = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (st.isSymbolicLink()) { links++; continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else files++;
    }
  };
  walk(path.join(dstApp, 'Contents', 'Frameworks'), 0);
  if (files > 0 && links === 0) problems.push('Frameworks 里一个符号链接都没有，拷贝可能把链接展开了');
  return { problems, links, files };
}

// dryRun: 全部做完（含签名）但不替换现有镜像
function rebuild(app, { dryRun = false } = {}) {
  log('拷贝 Codex.app 到 staging（ditto，首次约需十几秒）...');
  copyApp(app.appPath, STAGING_APP);
  const copy = verifyCopy(app.appPath, STAGING_APP, app.executable);
  if (copy.problems.length) {
    for (const p of copy.problems) warn('拷贝检查: ' + p);
    throw new Error('拷贝出来的副本不完整，已终止（没有动现有镜像）');
  }
  log(`拷贝检查通过（Frameworks 内符号链接 ${copy.links} 个）`);
  const stagedAsar = path.join(STAGING_APP, 'Contents', 'Resources', 'app.asar');

  // 1) 定位三个 bundle
  const loc = core.locateBundles(stagedAsar);
  const role = loc.role;
  let stagedTmp = null;
  try {
    for (const [k, e] of Object.entries(role)) {
      if (!e) {
        const missing = Object.entries(core.BUNDLE_MARKERS).filter(([n]) => !role[n]).map(([n, m]) => `${n}(${m})`).join(', ');
        throw new Error('无法定位 bundle: ' + missing + '（Codex 可能大版本更新了，需要更新补丁集）');
      }
      log('定位', k, '->', e.rel);
    }

    // 2) 应用补丁
    const content = new Map();
    for (const e of Object.values(role)) content.set(e.rel, loc.text(e));
    const { failCount, results } = core.applyPatchSet(content, role);
    for (const r of results) {
      if (r.ok) log('OK  ', r.note);
      else log('FAIL', r.note, `: 期望 ${r.expect} 处，实际 ${r.actual} 处`);
    }
    if (failCount > 0) throw new Error(`${failCount} 个补丁未命中，Codex 版本可能不兼容，保留现有镜像`);

    // 3) 语法校验（失败时保留 patched-bundles 便于排查）
    const CHECK_DIR = path.join(MIRROR_ROOT, 'patched-bundles');
    core.syntaxCheckBundles(content, CHECK_DIR);
    fs.rmSync(CHECK_DIR, { recursive: true, force: true });
    const patched = new Map([...content].map(([rel, s]) => [rel, Buffer.from(s, 'latin1')]));

    // 4) 重打包 asar
    const entries = core.listAsarEntries(loc.header);
    stagedTmp = stagedAsar + '.new';
    const out = core.writeAsar({
      srcPath: stagedAsar, dstPath: stagedTmp, header: loc.header,
      entries, patched, srcDataBase: loc.dataBase,
    });
    log(`重打包完成: ${out.bytes} 字节`);
  } finally {
    try { fs.closeSync(loc.fd); } catch (e) {} // 别让关闭句柄的异常盖住真正的报错
  }
  // 等源 asar 句柄关闭后再覆盖，避免"覆盖正在打开的文件"这类平台差异
  fs.renameSync(stagedTmp, stagedAsar);

  // 5) Info.plist 的 asar 完整性校验值（macOS 版的"回填 exe 哈希"）
  const integ = syncAsarIntegrity(STAGING_APP, app.asarPath, stagedAsar, { skipOnUnknown: SKIP_ASAR_INTEGRITY });
  if (integ.status === 'patched') log('asar 完整性:', integ.note);
  else if (integ.status === 'ok' || integ.status === 'absent') log('asar 完整性:', integ.note);
  else if (integ.status === 'removed') { warn('asar 完整性:', integ.note); }
  else if (integ.status === 'unknown') throw new Error('asar 完整性校验值无法更新：' + integ.note);
  else throw new Error('asar 完整性校验值更新失败：' + integ.note);

  // 6) 去掉隔离属性 + ad-hoc 重新签名（改了 app.asar 之后原签名必然失效）
  clearQuarantine(STAGING_APP);
  log('重新签名（ad-hoc）...');
  const sign = resign(STAGING_APP);
  for (const t of sign.tried) warn(t);
  if (!sign.ok) throw new Error('重新签名失败：macOS 会因代码签名无效而拒绝启动。可手动尝试: codesign --force --deep --sign - "' + STAGING_APP + '"');
  if (sign.lostEntitlements) {
    warn('重新签名没能保留原 entitlements（JIT 等权限）。这种镜像通常仍能启动，但如果它一启动就崩，请把这一行发出来。');
  }
  log('签名完成（' + sign.mode + '）');

  if (dryRun) {
    log('[dry-run] 构建/校验/签名全部通过。staging 保留在:', STAGING_APP, '（不替换现有镜像）');
    return { dryRun: true, stagedApp: STAGING_APP };
  }

  // 7) 安装
  log('验证通过，安装到镜像 ...');
  if (fs.existsSync(MIRROR_APP)) {
    const backup = path.join(MIRROR_ROOT, 'Codex.app.old');
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(MIRROR_APP, backup);
  }
  try { fs.renameSync(STAGING_APP, MIRROR_APP); }
  catch (e) {
    const backup = path.join(MIRROR_ROOT, 'Codex.app.old');
    if (!fs.existsSync(MIRROR_APP) && fs.existsSync(backup)) fs.renameSync(backup, MIRROR_APP);
    throw e;
  }
  fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  clearQuarantine(MIRROR_ROOT);
  markNoIndex();
  log('安装完成 ->', MIRROR_APP);
  return { dryRun: false };
}

function mirrorUsable() {
  return fs.existsSync(path.join(MIRROR_APP, 'Contents', 'Resources', 'app.asar'))
    && fs.existsSync(path.join(MIRROR_APP, 'Contents', 'Info.plist'));
}

function writeState(s) {
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

// 让 Spotlight 跳过镜像目录：否则镜像里的 Codex.app 会被索引，
// Launchpad / 聚焦搜索里会出现第二个"Codex"，用户分不清哪个是解锁版。
// .metadata_never_index 是 Spotlight 的官方约定，放一个空文件即可（删除它就能恢复索引）。
function markNoIndex() {
  try {
    fs.mkdirSync(MIRROR_ROOT, { recursive: true });
    const p = path.join(MIRROR_ROOT, '.metadata_never_index');
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  } catch (e) {}
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

// ================= 启动 =================

// 进程状态：alive / zombie（已退出但还没被回收）/ gone
function processState(pid) {
  try { process.kill(pid, 0); } catch (e) { return 'gone'; }
  try {
    const st = sh('ps', ['-o', 'state=', '-p', String(pid)]).trim();
    if (/^Z/i.test(st)) return 'zombie';
  } catch (e) {}
  return 'alive';
}

async function launch(app) {
  const bin = path.join(MIRROR_APP, 'Contents', 'MacOS', app.executable || 'Codex');
  if (!fs.existsSync(bin)) { warn('镜像里没有可执行文件:', bin); return false; }
  log('启动解锁镜像 Codex ...');
  const child = spawn(bin, [], { detached: true, stdio: 'ignore', cwd: MIRROR_APP });
  child.unref();
  // 起不来时要给提示：崩溃大多来自代码签名/完整性校验。
  // 存活判定用 process.kill(pid,0) 而不是 child.exitCode：detached+unref 之后子进程的退出状态
  // 在 POSIX 上不一定能被拿回来（真机行为待确认），exitCode/signalCode 只当补充信息用。
  await sleep(3000);
  const state = processState(child.pid);
  const detail = `（exitCode=${child.exitCode} signal=${child.signalCode}）`;
  if (state === 'gone' || state === 'zombie') {
    warn(`解锁镜像启动后立刻退出了${detail}。最常见的原因和处理：`);
    warn('  1) 代码签名无效 —— xattr -dr com.apple.quarantine "' + MIRROR_APP + '" 之后');
    warn('     codesign --force --deep --sign - "' + MIRROR_APP + '"');
    warn('  2) Info.plist 的 asar 完整性校验值不对 —— 双击"诊断报告.command" 看报告');
    warn('  3) 单实例锁：原版 Codex 正开着 —— 先在菜单栏彻底退出原版再试');
    return false;
  }
  return true;
}

// ================= 诊断报告 =================

function doctorReport() {
  const line = (k, v) => console.log('  ' + k.padEnd(26, ' ') + (v === undefined || v === null || v === '' ? '(无)' : v));
  console.log('\n=== Codex 解锁启动器 · macOS 诊断报告 ===');
  console.log('\n[环境]');
  let osver = '';
  try { osver = sh('sw_vers', ['-productVersion']).trim(); } catch (e) {}
  line('平台', process.platform + '/' + process.arch);
  line('macOS 版本', osver);
  line('Node', process.version + ' (' + process.execPath + ')');
  line('CPU 架构', process.arch === 'arm64' ? 'Apple Silicon' : process.arch);
  line('镜像目录', MIRROR_ROOT + (fs.existsSync(MIRROR_ROOT) ? ' (存在)' : ' (不存在)'));

  console.log('\n[工具]');
  for (const t of ['plutil', 'codesign', 'xattr', 'ditto', 'mdfind', 'ps', 'sw_vers']) {
    let where = '';
    try { where = sh('/usr/bin/which', [t]).trim(); } catch (e) { /* which 对内置/缺失项会非 0 退出 */ }
    line(t, where || '缺失');
  }

  console.log('\n[应用]');
  let app = null;
  try { app = findApp(); } catch (e) { line('Codex.app', e.message); }
  if (app) {
    line('路径', app.appPath);
    line('Bundle ID', app.bundleId);
    line('CFBundleShortVersion', app.shortVersion);
    line('asar package.json 版本', app.asarVersion + (app.buildFlavor ? ' (flavor=' + app.buildFlavor + ')' : ''));
    line('可执行文件', app.binary + (fs.existsSync(app.binary) ? '' : '  <== 不存在!'));
    const st = fs.statSync(app.asarPath);
    line('app.asar 大小', st.size + ' 字节');
    line('app.asar sha256', core.sha256File(app.asarPath));
    line('quarantine 条目', quarantineAttrs(app.appPath));

    console.log('\n[asar 完整性 (Info.plist)]');
    const integ = readAsarIntegrity(app.plistPath);
    if (!integ.present) line('ElectronAsarIntegrity', '不存在（该构建未开启 asar 完整性校验）');
    else {
      line('键', integ.key + '  algorithm=' + integ.algorithm);
      line('记录的 hash', integ.hash);
      const want = normalizeHash(integ.hash);
      const cs = asarHeaderCandidates(app.asarPath);
      if (!want) line('hash 口径', '无法识别（不是 SHA256 hex/base64）');
      else {
        const hit = cs.list.map(c => ({ n: c.name, h: core.sha256Hex(c.buf) })).find(m => m.h === want);
        line('口径判定', hit ? '匹配「' + hit.n + '」' : '不匹配任何候选 <== 需要人工确认');
        if (!hit) for (const c of cs.list) line('  候选 ' + c.name, core.sha256Hex(c.buf));
      }
    }

    console.log('\n[代码签名]');
    const sig = codesignInfo(app.appPath);
    line('签名授权', sig.authority || (sig.isAdhoc ? 'adhoc' : '(未知)'));
    line('codesign --verify', sig.verify ? '通过' : ('未通过: ' + sig.verifyOut.split('\n').slice(-2).join(' | ')));
    if (sig.entitlements) line('entitlements', sig.entitlements.replace(/\s+/g, ' ').slice(0, 400));

    console.log('\n[bundle 定位与补丁预检]');
    try {
      const loc = core.locateBundles(app.asarPath);
      try {
        const role = loc.role;
        for (const [k, e] of Object.entries(role)) line('角色 ' + k, e ? e.rel + ' (' + e.size + 'B)' : '未定位 <== 补丁无法应用');
        const content = new Map();
        for (const e of Object.values(role)) if (e) content.set(e.rel, loc.text(e));
        const { results } = core.applyPatchSet(content, role);
        const bad = results.filter(r => !r.ok);
        line('补丁命中', (results.length - bad.length) + '/' + results.length + (bad.length ? ' <== 该版本需要更新补丁集' : ' ✓'));
        for (const b of bad) line('  MISS ' + b.note, `期望 ${b.expect} 实际 ${b.actual}`);
      } finally { fs.closeSync(loc.fd); }
    } catch (e) { line('补丁预检', '失败: ' + e.message); }

    console.log('\n[codex 命令行]');
    line('codex', findCodexCLI(app.appPath) || '未在 Contents/Resources 找到（模型目录功能会不可用）');
  }

  console.log('\n[镜像状态]');
  line('镜像可用', mirrorUsable() ? '是' : '否');
  try { console.log('  状态文件: ' + JSON.stringify(readState())); } catch (e) {}
  console.log('\n=== 报告结束 ===\n');
}

// ================= 自带自检（任何平台都能跑） =================

function selftest() {
  const samples = opt('--samples');
  console.log('=== 自检：补丁集与 asar 读写 ===');
  let bad = 0;
  if (samples) {
    const files = { initial: 'app-initial.js', shared: 'app-shared.js', primary: 'app-primary.js' };
    const role = {}, content = new Map();
    for (const [name, f] of Object.entries(files)) {
      const p = path.join(samples, f);
      if (!fs.existsSync(p)) { console.log('  缺少样本: ' + p); bad++; continue; }
      role[name] = { rel: f };
      content.set(f, fs.readFileSync(p).toString('latin1'));
    }
    if (!bad) {
      const { failCount, results } = core.applyPatchSet(content, role);
      bad += failCount;
      console.log(`  补丁命中 ${results.length - failCount}/${results.length}`);
      for (const r of results) if (!r.ok) console.log(`    MISS ${r.note}: 期望 ${r.expect} 实际 ${r.actual}`);
      const dir = path.join(os.tmpdir(), 'codex-selftest-check');
      try { core.syntaxCheckBundles(content, dir); console.log('  语法校验通过'); }
      catch (e) { bad++; console.log('  语法校验失败: ' + e.message); }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log('  （未给 --samples，跳过补丁集验证）');
  }
  // asar 读写往返：构造一个最小 asar 再读回来
  try {
    const tmp = path.join(os.tmpdir(), 'codex-selftest.asar');
    const json = Buffer.from(JSON.stringify({ files: { 'webview': { files: { 'assets': { files: { 'x.js': { size: 3, offset: '0' } } } } } } }), 'utf8');
    const payloadLen = Math.ceil((4 + json.length) / 4) * 4;
    const headerSize = 4 + payloadLen;
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0); head.writeUInt32LE(headerSize, 4); head.writeUInt32LE(payloadLen, 8); head.writeUInt32LE(json.length, 12);
    fs.writeFileSync(tmp, Buffer.concat([head, json, Buffer.alloc(8 + headerSize - 16 - json.length), Buffer.from('abc', 'latin1')]));
    const a = core.readAsar(tmp);
    const ents = core.listAsarEntries(a.header);
    const fd = fs.openSync(tmp, 'r');
    const got = core.readAsarEntry(fd, a.dataBase, ents[0]).toString('latin1');
    fs.closeSync(fd);
    if (got !== 'abc') { bad++; console.log('  asar 往返失败: 读到 ' + JSON.stringify(got)); }
    else console.log('  asar 读写往返通过');
    fs.rmSync(tmp, { force: true });
  } catch (e) { bad++; console.log('  asar 自检异常: ' + e.message); }
  console.log(bad === 0 ? '自检通过' : `自检失败 ${bad} 项`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ================= 主流程 =================

let PLATFORM_OK = true; // 平台不符 / 自检 / 诊断时不打印"启动失败"的收尾提示
let LAUNCH_ATTEMPTED = false; // 只有真的尝试过启动，收尾提示才有意义

async function main() {
  if (SELFTEST) return selftest();
  if (process.platform !== 'darwin') {
    PLATFORM_OK = false;
    console.log('[launcher] 这个脚本只能在 macOS 上运行（当前平台: ' + process.platform + '）。');
    console.log('[launcher] 想在不依赖 macOS 的情况下自检补丁集，可以跑: node codex-launcher-mac.js --selftest');
    process.exitCode = 2;
    return;
  }
  if (DOCTOR) return doctorReport();

  log('查找 Codex.app ...');
  const app = findApp();
  log('找到:', app.appPath, '(版本', app.shortVersion || app.asarVersion, ')');
  markNoIndex(); // 镜像目录不进 Spotlight（否则 Launchpad 里会出现第二个 Codex）
  const fp = core.sha256File(app.asarPath);

  let state = readState();
  const needRebuild = !mirrorUsable() || state.appFingerprint !== fp || state.patchSetVersion !== PATCH_SET_VERSION;
  const knownBad = state.failedFingerprint === fp && state.failedPatchSet === PATCH_SET_VERSION;

  if (!needRebuild && !DRY_RUN) {
    log('解锁镜像已是最新，直接启动');
  } else if (knownBad && !FORCE) {
    log('该版本此前重建失败（', state.failedReason, '），跳过重建；更新补丁后用 --force 重试');
  } else {
    log('需要重建解锁镜像（Codex 更新或补丁集变化）...');
    const mirrorRunning = pidsUnder(MIRROR_APP).length > 0;
    const resRunning = !!RES_LINK && pidsUnder(RES_LINK).length > 0;
    if (!DRY_RUN && (resRunning || (mirrorRunning && !NO_LAUNCH))) {
      log('Codex 正在运行，跳过更新（请完全退出 Codex 后重新运行启动器）');
    } else {
      if (mirrorRunning && !DRY_RUN) await killApp();
      await sleep(500);
      try {
        rebuild(app, { dryRun: DRY_RUN });
        if (DRY_RUN) return;
        state = {
          appVersion: app.shortVersion, bundleId: app.bundleId, appPath: app.appPath,
          appFingerprint: fp, patchSetVersion: PATCH_SET_VERSION,
          failedPatches: 0, updatedAt: new Date().toISOString(),
          catalogFingerprint: state.catalogFingerprint,
        };
        writeState(state);
      } catch (e) {
        try { fs.rmSync(STAGING_ROOT, { recursive: true, force: true }); } catch (_) {}
        const transient = e.code != null || e.status != null;
        log('重建失败' + (transient ? '（偶发错误，下次启动重试）' : '') + ':', e.message);
        if (!transient && !DRY_RUN) {
          state = {
            ...state, failedAppVersion: app.shortVersion, failedFingerprint: fp,
            failedPatchSet: PATCH_SET_VERSION, failedReason: e.message, failedAt: new Date().toISOString(),
          };
          writeState(state);
        }
        if (DRY_RUN) process.exitCode = 1;
        return;
      }
    }
  }
  if (DRY_RUN) return;

  if (mirrorUsable() && state.appFingerprint && state.catalogFingerprint !== state.appFingerprint) {
    if (regenCatalog(!state.catalogFingerprint)) { state.catalogFingerprint = state.appFingerprint; writeState(state); }
  }
  try { syncResources(); } catch (e) { warn('资源目录同步出错:', e.message); }

  if (!NO_LAUNCH) {
    // Codex 有单实例锁：原版开着时解锁版可能一启动就退出（只把原版窗口切到前台）
    const origRunning = pidsUnder(app.appPath).length > 0;
    if (origRunning && mirrorUsable()) {
      log('提示: 原版 Codex 正在运行。Codex 有单实例锁，解锁版窗口可能不会出现；请先彻底退出原版再试');
    }
    LAUNCH_ATTEMPTED = true;
    if (!(await launch(app)) || origRunning) process.exitCode = 1;
  }
}

process.on('exit', code => {
  if (code && PLATFORM_OK && LAUNCH_ATTEMPTED && !NO_LAUNCH && !DOCTOR && !SELFTEST) {
    console.log('\n[launcher] 解锁版没有正常启动，请看上面的提示。需要求助时把这个窗口截图发过来。');
  }
});

main().catch(e => {
  console.error('[launcher] 出错:', e.message);
  if (e.hint) console.error('[launcher]', e.hint);
  process.exitCode = 1;
});
