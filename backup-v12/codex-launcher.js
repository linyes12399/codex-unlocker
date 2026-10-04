// Codex 解锁启动器：自动同步商店最新版 + 重打包补丁 + 回填 asar 哈希 + 启动
// 用法: node codex-launcher.js [--no-launch] [--force] [--dry-run]
//   --force    忽略"该商店版本补丁失败"记录，强制重试重建
//   --dry-run  完整走一遍重建（拷贝/打补丁/重打包/哈希回填）但不替换镜像、不写配置、不启动
// 原理:
//   1. 检测商店安装的 OpenAI.Codex 当前版本（更新后自动跟随）
//   2. 镜像（%USERPROFILE%\ChatGPT-Patched\app）缺失或商店版本变化 -> 重新同步并重建解锁镜像
//      重建失败则保留并启动旧镜像；补丁失配会记下该版本，之后不再重复拷贝（--force 重试）
//   3. 解锁 = 对 webview 三个 bundle 应用补丁后重打包 app.asar，
//      并把 ChatGPT.exe 内嵌的 asar SHA256 校验值原位替换为新文件哈希
//   4. 镜像版本变化 -> 用镜像 codex.exe 导出内置模型目录、补 ultrafast，写入 config.toml 的 model_catalog_json
//      （首次使用且没配这一项时自动加上，原 config.toml 先备份）
//   5. 设置了 CODEX_ELECTRON_RESOURCES_PATH 时，让该目录与镜像 resources 一致（文件硬链接、目录 junction）
//   6. 启动镜像中的 ChatGPT.exe（商店原版保持不动）
// 状态文件: %USERPROFILE%\ChatGPT-Patched\launcher-state.json（脚本目录可随意移动）
//
// 补丁定义与 asar/重打包逻辑在 lib/launcher-core.js，与 macOS 版共用同一份。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');
const core = require('./lib/launcher-core.js');

const HOME = os.homedir().replace(/\\/g, '/');
const MIRROR_ROOT = HOME + '/ChatGPT-Patched';
const MIRROR = MIRROR_ROOT + '/app';
const STATE_FILE = MIRROR_ROOT + '/launcher-state.json';
const LEGACY_STATE_FILE = path.join(__dirname, 'launcher-state.json'); // 旧版放在脚本目录
const PATCH_SET_VERSION = 'v12'; // 补丁集版本：变更会强制重建
// 设置了 CODEX_ELECTRON_RESOURCES_PATH 时应用从这里读 resources，里面的文件必须与镜像保持一致；没设置就不需要
const RES_LINK = (process.env.CODEX_ELECTRON_RESOURCES_PATH || '').trim();
const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const ULTRAFAST_TIER = { id: 'ultrafast', name: 'Ultrafast', description: '2x speed, increased usage' };

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...a) => console.log('[launcher]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 工具 ----------
const sha256File = core.sha256File;

function findStoreInstall() {
  const out = core.runCaptured('powershell', ['-NoProfile', '-c', '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation']).trim();
  if (!out) throw new Error('未找到商店版 OpenAI.Codex，请先从微软商店安装');
  return out.replace(/\\/g, '/') + '/app';
}
// 可执行文件位于 dir 之下的进程（按路径前缀匹配，不会误伤商店原版或其它程序）
function pidsUnder(dir) {
  const root = path.resolve(dir) + path.sep;
  const ps = `$r='${root.replace(/'/g, "''")}';Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id }`;
  try {
    // 排除自己：bat 可能直接用商店版自带的 node.exe 跑本脚本
    return core.runCaptured('powershell', ['-NoProfile', '-Command', ps])
      .split(/\r?\n/).map(s => s.trim()).filter(s => s && s !== String(process.pid));
  } catch (e) { return []; }
}
function killApp() {
  const pids = pidsUnder(MIRROR_ROOT);
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'pipe', windowsHide: true }); } catch (e) {}
  }
  if (pids.length) log('已停止运行中的镜像应用');
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

// ---------- 模型目录：从镜像 codex.exe 导出内置目录 + 补 ultrafast ----------
function catalogPath() {
  let toml;
  try { toml = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch (e) { return null; }
  const m = toml.match(/^\s*model_catalog_json\s*=\s*(["'])(.*?)\1/m);
  if (!m) return null;
  return m[1] === '"' ? m[2].replace(/\\\\/g, '\\') : m[2];
}

function buildCatalogJson(codexExe) {
  // 独立 CODEX_HOME：不读用户配置、不在 ~/.codex 留下任何文件
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
  let out;
  try {
    out = core.runCaptured(codexExe, ['debug', 'models', '--bundled'], {
      timeout: 120000, env: { ...process.env, CODEX_HOME: home },
    });
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

// 首次使用（多半是别人的电脑）时 config.toml 里没有 model_catalog_json：目录写好之后再加这一行
function addCatalogToConfig(target) {
  let toml = '';
  try { toml = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bom = toml.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  // 文件开头一定处在顶层表，插在这里不会落进某个 [表] 或多行值里
  const next = bom + `model_catalog_json = "${target}"` + eol + toml.slice(bom.length);
  const bak = CODEX_CONFIG + '.before-codex-launcher';
  if (toml && !fs.existsSync(bak)) fs.copyFileSync(CODEX_CONFIG, bak);
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG + '.tmp', next);
  fs.renameSync(CODEX_CONFIG + '.tmp', CODEX_CONFIG);
  log('已在', CODEX_CONFIG, '开头加入 model_catalog_json', toml ? '（原文件备份为 config.toml.before-codex-launcher）' : '（新建）');
}

// 成功（含无需更新）返回 true；失败只告警，不阻断启动
// allowSetup: 只在从未生成过目录时自动加配置；之后用户自己删掉那行就尊重，不再加回去
function regenCatalog(allowSetup) {
  let target = catalogPath();
  const needConfig = !target;
  if (needConfig && !allowSetup) { log('config.toml 未配置 model_catalog_json，跳过模型目录更新'); return true; }
  if (needConfig) target = path.join(path.dirname(CODEX_CONFIG), 'model-catalog-ultrafast.json').replace(/\\/g, '/');
  try {
    const { text, count } = buildCatalogJson(MIRROR + '/resources/codex.exe');
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
    log('警告: 模型目录更新失败，保留现有文件:', (e.stderr || e.message || '').toString().trim().split('\n').pop());
    return false;
  }
}

// ---------- 资源目录：RES_LINK 与镜像 resources 保持一致 ----------
// 目录 -> junction 指向镜像；文件 -> 硬链接到镜像（同卷零拷贝，inode 相同即一致；失败退回复制）
const normLink = p => path.resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase();

function removeEntry(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch (e) { fs.rmdirSync(p); } }
  else fs.rmSync(p, { recursive: true, force: true });
}

// 先建好新文件再换名；目标正被运行（exe 不可删但可改名）时先把旧文件挪开
function replaceFile(src, dst) {
  const tmp = dst + '.new-' + process.pid;
  fs.rmSync(tmp, { force: true });
  try { fs.linkSync(src, tmp); } catch (e) { fs.copyFileSync(src, tmp); }
  try {
    fs.renameSync(tmp, dst);
  } catch (e) {
    try {
      fs.renameSync(dst, path.join(path.dirname(dst), '.stale-' + Date.now() + '-' + path.basename(dst)));
      fs.renameSync(tmp, dst);
    } catch (e2) { fs.rmSync(tmp, { force: true }); throw e2; }
  }
}

// 会删除 RES_LINK 里的多余项，所以只接受空目录或看起来就是 resources 的目录
function resLinkSafe() {
  const r = normLink(RES_LINK), root = normLink(MIRROR_ROOT);
  if (r === root || r.startsWith(root + path.sep) || root.startsWith(r + path.sep)) return '指向了镜像目录本身';
  if (r === path.parse(r).root || r === normLink(HOME)) return '指向了盘符根目录或用户目录';
  if (r.includes(path.sep + 'windowsapps' + path.sep)) return '指向了商店安装目录';
  let names;
  try { names = fs.readdirSync(RES_LINK); } catch (e) { return null; }
  if (names.length && !names.includes('app.asar')) return '目录非空且不像 resources 目录（没有 app.asar）';
  return null;
}

function syncResources() {
  const src = MIRROR + '/resources';
  if (!RES_LINK || !mirrorUsable()) return;
  const unsafe = resLinkSafe();
  if (unsafe) { log('跳过资源目录同步: CODEX_ELECTRON_RESOURCES_PATH', unsafe, '->', RES_LINK); return; }
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
        fs.symlinkSync(s, d, 'junction');
      } else {
        if (dst && dst.isFile() && ((dst.ino === sst.ino && dst.dev === sst.dev) ||
            (dst.size === sst.size && dst.mtimeNs === sst.mtimeNs))) continue;
        if (dst && !dst.isFile()) removeEntry(d);
        replaceFile(s, d);
      }
      changed++;
    } catch (e) {
      failed++;
      log('资源同步失败:', name, '-', e.code || e.message);
    }
  }
  // 镜像里已不存在的条目（含上次挪开的 .stale-*）；仍被占用的留到下次
  for (const name of fs.readdirSync(RES_LINK)) {
    if (want.has(name)) continue;
    try { removeEntry(path.join(RES_LINK, name)); if (!name.startsWith('.stale-')) { changed++; log('资源目录移除多余项:', name); } }
    catch (e) { if (!name.startsWith('.stale-')) log('资源目录无法移除:', name, '-', e.code || e.message); }
  }
  if (changed || failed) log(`资源目录同步: 更新 ${changed} 项` + (failed ? `，失败 ${failed} 项` : ''), '->', RES_LINK);
}

// ---------- 重建解锁镜像 ----------
// dryRun: 完整构建到 staging 并验证，随后删除 staging，不触碰现有镜像/状态文件
function rebuild(storeDir, { dryRun = false } = {}) {
  const STAGING = MIRROR + '.staging';

  // 1) 同步商店目录 -> staging（robocopy；退出码 0-7 均为成功）
  log('同步商店文件到 staging ...');
  fs.rmSync(STAGING, { recursive: true, force: true });
  try {
    execSync(`robocopy "${storeDir.replace(/\//g, '\\')}" "${STAGING.replace(/\//g, '\\')}" /E /NFL /NDL /NJH /NJS /NP`, { stdio: 'ignore' });
  } catch (e) {
    if (e.status == null || e.status >= 8) throw e;
  }

  // 2) 从 staging 原版 asar 定位三个目标 bundle（按内容标记，不依赖文件名哈希）
  const asarPath = STAGING + '/resources/app.asar';
  const loc = core.locateBundles(asarPath);
  const role = loc.role;
  let jsonBuf; // 新 asar 的 header JSON：owl 校验的就是它的 SHA256
  let tmpAsar = null, outBytes = 0;
  try {
    for (const [k, e] of Object.entries(role)) {
      if (!e) {
        const missing = Object.entries(core.BUNDLE_MARKERS).filter(([n]) => !role[n]).map(([n, m]) => `${n}(${m})`).join(', ');
        throw new Error('无法定位 bundle: ' + missing);
      }
      log('定位', k, '->', e.rel);
    }

    // 3) 应用补丁
    const content = new Map();
    for (const e of Object.values(role)) content.set(e.rel, loc.text(e));
    const { failCount, results } = core.applyPatchSet(content, role);
    for (const r of results) {
      if (r.ok) log('OK  ', r.note);
      else log('FAIL', r.note, `: 期望 ${r.expect} 处，实际 ${r.actual} 处`);
    }
    // 补丁失配则终止，不应用半成品
    if (failCount > 0) throw new Error(`${failCount} 个补丁未命中，商店版本可能不兼容，保留现有镜像`);

    // 语法校验（失败时保留 patched-bundles 便于排查，通过后删掉）
    const CHECK_DIR = MIRROR_ROOT + '/patched-bundles';
    core.syntaxCheckBundles(content, CHECK_DIR);
    fs.rmSync(CHECK_DIR, { recursive: true, force: true });
    const patched = new Map([...content].map(([rel, s]) => [rel, Buffer.from(s, 'latin1')])); // latin1 读 latin1 写，字节级 1:1

    // 4) 重打包 asar（重算每个文件的 integrity）
    const entries = core.listAsarEntries(loc.header);
    tmpAsar = STAGING + '/resources/app.asar.new';
    const out = core.writeAsar({
      srcPath: asarPath, dstPath: tmpAsar, header: loc.header, entries, patched, srcDataBase: loc.dataBase,
    });
    jsonBuf = out.jsonBuf;
    outBytes = out.bytes;
  } finally {
    fs.closeSync(loc.fd);
  }
  // 必须等源 asar 的句柄关闭后再覆盖（Windows 上覆盖仍被打开的文件会 EPERM）
  fs.renameSync(tmpAsar, asarPath);
  log(`重打包完成: ${outBytes} 字节`);

  // 5) 回填 ChatGPT.exe 内嵌的 asar 校验哈希（owl 校验的是 header JSON 的 SHA256）
  const headerHash = core.sha256Hex(jsonBuf);
  for (const exe of ['ChatGPT.exe', 'Codex.exe']) {
    if (!fs.existsSync(STAGING + '/' + exe)) { log('跳过', exe, '（镜像里不存在）'); continue; }
    const result = patchExeHash(STAGING + '/' + exe, headerHash);
    log('校验哈希回填', exe, '->', result);
    if (exe === 'ChatGPT.exe' && !result.startsWith('PATCHED') && result !== 'ALREADY_OK') {
      throw new Error('ChatGPT.exe 哈希回填失败: ' + result);
    }
  }

  // 6) 全部验证通过，替换现有镜像
  if (dryRun) {
    log('[dry-run] 构建与校验全部通过，删除 staging，不替换现有镜像');
    fs.rmSync(STAGING, { recursive: true, force: true });
    return 0;
  }
  log('验证通过，安装到镜像 ...');
  if (fs.existsSync(MIRROR)) {
    const backup = MIRROR + '.old';
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(MIRROR, backup);
  }
  try { fs.renameSync(STAGING, MIRROR); }
  catch (e) {
    if (!fs.existsSync(MIRROR) && fs.existsSync(MIRROR + '.old')) fs.renameSync(MIRROR + '.old', MIRROR);
    throw e;
  }
  log('安装完成');
  return 0;
}

async function main() {
  const noLaunch = process.argv.includes('--no-launch');
  const force = process.argv.includes('--force');
  log('检测商店版 OpenAI.Codex ...');
  const storeDir = findStoreInstall();
  const pkg = path.basename(path.dirname(storeDir));
  const fp = sha256File(storeDir + '/resources/app.asar');
  log('商店版本目录:', pkg);

  let state = {};
  for (const f of [STATE_FILE, LEGACY_STATE_FILE]) {
    try { state = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (e) {}
  }
  const needRebuild = !mirrorUsable() || state.storeFingerprint !== fp || state.patchSetVersion !== PATCH_SET_VERSION;
  // 同一商店版本 + 同一补丁集已失败过：不再每次启动都重新拷贝几百 MB
  const knownBad = state.failedFingerprint === fp && state.failedPatchSet === PATCH_SET_VERSION;

  if (!needRebuild && !DRY_RUN) {
    log('解锁镜像已是最新（', pkg, '），直接启动');
  } else if (knownBad && !force) {
    log('该商店版本此前重建失败（', state.failedReason, '），跳过重建；更新补丁后用 --force 重试');
  } else {
    log('需要重建解锁镜像（商店更新或补丁集变化）...');

    const mirrorRunning = pidsUnder(MIRROR_ROOT).length > 0;
    // 从资源目录（junction 指向镜像）跑起来的进程会锁住镜像目录，换镜像必然失败
    const resRunning = !!RES_LINK && pidsUnder(RES_LINK).length > 0;

    // 资源目录里的进程可能属于商店原版，不能替用户结束，--no-launch 也只能跳过
    if (DRY_RUN ? false : (resRunning || (mirrorRunning && !noLaunch))) {
      log('Codex 正在运行，跳过更新（请完全退出 Codex 后重新运行启动器以应用更新）');
    } else {
      if (mirrorRunning && !DRY_RUN) killApp();
      await sleep(800);
      try {
        rebuild(storeDir, { dryRun: DRY_RUN });
        if (DRY_RUN) return;
        // 成功才记录新指纹；同时清掉旧的失败记录
        state = {
          storeVersion: pkg, storeFingerprint: fp, patchSetVersion: PATCH_SET_VERSION,
          failedPatches: 0, updatedAt: new Date().toISOString(),
          // 保留旧值：与新指纹不同照样触发目录更新，同时表明已经做过首次配置
          catalogFingerprint: state.catalogFingerprint,
        };
        writeState(state);
      } catch (e) {
        try { fs.rmSync(MIRROR + '.staging', { recursive: true, force: true }); } catch (_) {}
        // 文件占用/拷贝出错（带 code 或进程退出码）属于偶发，下次启动照常重试；只有补丁失配这类确定性失败才记账
        const transient = e.code != null || e.status != null;
        log('重建失败' + (transient ? '（偶发错误，下次启动重试）' : '') + ':', e.message);
        if (!transient && !DRY_RUN) {
          // 保留上次成功的指纹，只追加失败记录
          state = {
            ...state, failedStoreVersion: pkg, failedFingerprint: fp, failedPatchSet: PATCH_SET_VERSION,
            failedReason: e.message, failedAt: new Date().toISOString(),
          };
          writeState(state);
        }
        if (DRY_RUN) process.exitCode = 1;
      }
    }
  }
  if (DRY_RUN) return;

  // 模型目录跟随镜像实际所用的版本（重建失败回退旧镜像时也一致）；失败只告警，下次启动重试
  if (mirrorUsable() && state.storeFingerprint && state.catalogFingerprint !== state.storeFingerprint) {
    if (regenCatalog(!state.catalogFingerprint)) { state.catalogFingerprint = state.storeFingerprint; writeState(state); }
  }
  try { syncResources(); } catch (e) { log('资源目录同步出错:', e.message); }

  if (!noLaunch) {
    // Codex 有单实例锁：商店原版开着时，解锁版可能一启动就退出（只把原版窗口切到前台）
    const storeRunning = pidsUnder(path.dirname(storeDir)).length > 0;
    if (storeRunning && mirrorUsable()) {
      log('提示: 商店原版 Codex 正在运行。如果解锁版窗口没有出现，请先在任务栏右下角托盘里右键彻底退出 Codex，再重新运行启动器');
    }
    // 没能启动解锁版、或需要用户看提示时返回非 0，让 bat 窗口停住
    if (!launch(pkg) || storeRunning) process.exitCode = 1;
  }
}

function mirrorUsable() {
  return fs.existsSync(MIRROR + '/resources/app.asar') && fs.existsSync(MIRROR + '/ChatGPT.exe');
}
function writeState(s) {
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
  try { fs.unlinkSync(LEGACY_STATE_FILE); } catch (e) {} // 已迁移到镜像目录
}

// 优先启动解锁镜像；镜像不可用时退回商店原版，保证总能打开。返回是否启动了解锁版
function launch(pkg) {
  if (mirrorUsable()) {
    log('启动解锁镜像 ChatGPT ...');
    spawn(MIRROR.replace(/\//g, '\\') + '\\ChatGPT.exe', [], { detached: true, stdio: 'ignore', cwd: MIRROR }).unref();
    return true;
  }
  if (!pkg) { log('镜像不可用且未找到商店版，无法启动'); return false; }
  // 包全名 Name_Version_Arch__PublisherId -> AUMID Name_PublisherId!App
  const parts = pkg.split('_');
  const aumid = parts[0] + '_' + parts[parts.length - 1] + '!App';
  log('解锁镜像不可用，已改为打开商店原版（未解锁）:', aumid);
  spawn('explorer.exe', ['shell:AppsFolder\\' + aumid], { detached: true, stdio: 'ignore' }).unref();
  return false;
}

process.on('exit', code => {
  if (code && !process.argv.includes('--no-launch')) {
    console.log('\n[launcher] 解锁版没有正常启动，请看上面的提示。需要求助时把这个窗口截图发过来。');
  }
});

main().catch(e => {
  console.error('[launcher] 出错:', e.message);
  if (!process.argv.includes('--no-launch') && !DRY_RUN) launch(null);
  process.exitCode = 1;
});
