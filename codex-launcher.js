// Codex 解锁启动器：自动同步商店版/官网安装版 Codex + 重打包补丁 + 回填 asar 哈希 + 启动
// 用法: node codex-launcher.js [--no-launch] [--force] [--dry-run] [--self-test] [--create-shortcut] [--no-shortcut] [--app-dir=目录]
//       （也可用 pack-exe.js 打包成单文件 exe（Codex解锁版.exe）直接双击运行，参数相同，快捷方式直接指向 exe）
//   --force           忽略"该版本补丁失败"记录，强制重试重建
//   --dry-run         完整走一遍重建（拷贝/打补丁/重打包/哈希回填）但不替换镜像、不写配置、不启动、不碰快捷方式
//   --self-test       严格只读自检：打印环境、所有候选安装、镜像/快捷方式状态、补丁试跑命中数、
//                     网络诊断（供应商/Key/覆盖会怎么写/镜像有没有 v14 修复）；全中或可部分解锁退出码 0，否则 1
//   --create-shortcut 只创建/刷新桌面与开始菜单的"Codex 解锁版"快捷方式，然后退出（不重建、不启动）
//   --no-shortcut     本次运行不碰快捷方式
//   --app-dir=目录    手动指定 Codex 安装目录（成功后记入状态，以后自动使用；--app-dir= 空值清除）
// 支持的安装来源：微软商店版、官网 exe 安装版（通用扫描：卸载注册表 / 开始菜单与桌面 .lnk / 运行中的进程 /
//   %LOCALAPPDATA%\Programs 等目录）、手动指定（--app-dir 或环境变量 CODEX_APP_DIR）。
// 原理:
//   1. 发现并校验 Codex 安装（asar 里 package.json 的 name 必须是 openai-codex-electron）
//   2. 镜像（%USERPROFILE%\ChatGPT-Patched\app）缺失或安装版本变化 -> 重新同步并重建解锁镜像
//      重建失败则保留并启动旧镜像；补丁失配会记下该版本，之后不再重复拷贝（--force 重试）
//   3. 解锁 = 对 webview 三个 bundle 应用补丁后重打包 app.asar，
//      并把主程序内嵌的 asar SHA256 校验值原位替换为新文件哈希
//      补丁按组应用：某组整体失配（版本差异）时跳过该组、其余照常，即"部分解锁"
//   4. 从镜像 codex.exe 导出内置模型目录、给内置模型补 priority/ultrafast 档，合并 config.toml 指定目录与
//      cc-switch 的自定义模型 -> 只写到镜像根目录 model-catalog-merged.json（v14 起绝不写 config.toml，
//      也绝不写 config.toml 指向的文件——那是 cc-switch 自己的数据）
//   5. 写镜像根目录 codex-launcher-overrides.json（不含任何 key）：主进程 bundle 里的补丁在每次拉起
//      app-server 时读它，决定"用哪个模型目录"与"该供应商没有凭据时改用 auth.json 里的 Key"（修 401）
//   6. 设置了 CODEX_ELECTRON_RESOURCES_PATH 时，让该目录与镜像 resources 一致（文件硬链接、目录 junction）
//   7. 首次成功启动后自动创建桌面/开始菜单快捷方式（文件夹搬家后自动更新；用户删掉的不再加回）；
//      结果记进状态，之后每次启动不再为"快捷方式还在不在"去跑 PowerShell
//   8. 启动镜像中的主程序（原版保持不动）
// 状态文件: %USERPROFILE%\ChatGPT-Patched\launcher-state.json（脚本目录可随意移动）
// 退出码: 0=成功；1=失败（bat 会暂停并提示求助）；2=需要用户看一眼的提示（bat 会暂停，不打印求助文案）
//
// 补丁定义与 asar/重打包逻辑在 lib/launcher-core.js，与 macOS 版共用同一份；
// 网络修复（model_catalog_json / requires_openai_auth 两条 -c 覆盖）在主进程 bundle 的补丁里，
// 由 core.locateNetBundle / core.applyNetPatch 实现（规格 §4）。
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
const LOCK_FILE = MIRROR_ROOT + '/launcher.lock'; // 单实例锁
const PATCH_SET_VERSION = 'v14'; // 补丁集版本：变更会强制重建（v14 = webview 15 条 + 主进程 net 补丁）
// 设置了 CODEX_ELECTRON_RESOURCES_PATH 时应用从这里读 resources，里面的文件必须与镜像保持一致；没设置就不需要
const RES_LINK = (process.env.CODEX_ELECTRON_RESOURCES_PATH || '').trim();
const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const ULTRAFAST_TIER = { id: 'ultrafast', name: 'Ultrafast', description: '2x speed, increased usage' };
// 同一供应商的 Fast 档：内置目录里的档位 id 是 priority（旧版可能没有这个档），补齐时按 id 去重
const PRIORITY_TIER = { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' };
// 覆盖文件与合并目录都放在镜像根目录（= ChatGPT.exe 所在 app 目录的上一级，主进程补丁按此路径读）
const OVERRIDES_FILE = MIRROR_ROOT + '/' + core.NET_OVERRIDES_FILE;
const MERGED_CATALOG = MIRROR_ROOT + '/model-catalog-merged.json';
const OVERRIDES_WRITER = 'codex-launcher v14';
// 入口 bat 路径（bat 用 CODEX_LAUNCHER_BAT=%~f0 传进来；直接跑 js 时用脚本目录下的默认名）
const BAT_PATH = (process.env.CODEX_LAUNCHER_BAT || '').trim() || path.join(__dirname, '启动Codex解锁版.bat');
// 单文件 exe 模式（Node SEA，pack-exe.js 打包）：运行时嵌在 exe 里，快捷方式直接指向 exe 本身，
// 不再经过 cmd/bat，用户机器也不需要装 node。__dirname 在 SEA 下是 exe 所在目录，与 bat 同目录语义一致
const SEA_MODE = (() => { try { return require('node:sea').isSea(); } catch (e) { return false; } })();
const APP_DIR_ENV = (process.env.CODEX_APP_DIR || '').trim();
// 快捷方式目标目录（测试用钩子：桌面和开始菜单都建到这里；正式使用不设置）
const SHORTCUT_DIR = (process.env.CODEX_LAUNCHER_SHORTCUT_DIR || '').trim();
// §9 机器可读报告输出文件（测试用；正式使用不设置）
const REPORT_FILE = (process.env.CODEX_LAUNCHER_REPORT || '').trim();
// 测试钩子：跳过商店版候选（不写进使用说明）
const NO_STORE = process.env.CODEX_LAUNCHER_NO_STORE === '1';
// 测试钩子：跳过开始菜单/桌面 .lnk、卸载注册表、运行中的进程三类"系统级"来源（不写进使用说明）
const NO_EXTERNAL = process.env.CODEX_LAUNCHER_NO_EXTERNAL === '1';
const SHORTCUT_NAME = 'Codex 解锁版.lnk';
const ICON_NAME = 'Codex解锁版.ico';
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 重建前要求镜像所在盘至少剩余 5GB
const GROUP_ZH = { effort: 'effort（Max/Ultra 思考强度）', speed: 'speed（Fast/Ultrafast 速度档）' };
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

const log = (...a) => console.log('[launcher]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256File = core.sha256File;

// ---------- 小工具 ----------
// 路径比较用规范形式：绝对路径 + 小写 + 正斜杠（Windows 路径大小写不敏感）
const N = p => path.resolve(p).toLowerCase().replace(/\\/g, '/');
const win = p => String(p).replace(/\//g, '\\'); // 对外（报告/状态/.lnk）用反斜杠原生形式
// 快捷方式指向的入口（必须在 win 定义之后）：bat 模式 = 启动Codex解锁版.bat（配合 cmd 包装）；exe 模式 = exe 自己（无参数）
const ENTRY_PATH = SEA_MODE ? win(process.execPath) : win(BAT_PATH);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const underDir = (p, dir) => p === dir || p.startsWith(dir + '/');

// 解码子进程输出：先按 UTF-8；出现替换字符（中文系统上 reg.exe 输出 GBK/OEM）再按 GBK 重解。
// Node 自带全量 ICU，TextDecoder('gbk') 可用。
function decodeConsoleOutput(buf) {
  const s = buf.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return s; }
}
// 把命令输出重定向到临时文件再读取（管道 stdio 在受限环境可能 EPERM 失败），返回原始 Buffer
let runSeq = 0;
function runCaptureBytes(file, args, opts = {}) {
  const outDir = os.tmpdir();
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {} // TEMP 目录被清掉/不存在时兜底（沙箱测试里会发生）
  const outFile = path.join(outDir, `codex-run-${process.pid}-${(runSeq++).toString(36)}.out`);
  const fd = fs.openSync(outFile, 'w');
  let status = 0, cause = null;
  try {
    execFileSync(file, args, Object.assign({ windowsHide: true }, opts, { stdio: ['ignore', fd, fd] }));
  } catch (e) {
    status = e.status == null ? 1 : e.status;
    cause = e;
  }
  fs.closeSync(fd);
  let buf = Buffer.alloc(0);
  try { buf = fs.readFileSync(outFile); } catch (e) {}
  fs.rmSync(outFile, { force: true });
  if (status !== 0) {
    const err = cause instanceof Error ? cause : new Error(`${file} 退出码 ${status}`);
    err.status = status;
    err.stdout = decodeConsoleOutput(buf);
    err.stderr = err.stdout;
    throw err;
  }
  return buf;
}
// PowerShell 调用：一律 -NoProfile -NonInteractive -ExecutionPolicy Bypass，脚本开头自己把输出设成 UTF-8
const runPowershell = script => decodeConsoleOutput(runCaptureBytes('powershell', [...PS_ARGS, '-Command', script])).trim();
// reg.exe 输出按 GBK 兜底解码
const runReg = args => decodeConsoleOutput(runCaptureBytes('reg', args));

// ---------- 参数解析（纯函数，测试直接调用；未知参数一律抛错，绝不落入普通模式） ----------
// 模式互斥时的优先级：--self-test > --create-shortcut > --dry-run（自检最保守，只读）
const MODE_RANK = { '--self-test': 0, '--create-shortcut': 1, '--dry-run': 2 };
function parseArgs(argv = []) {
  const o = { mode: 'normal', noLaunch: false, force: false, noShortcut: false, appDir: undefined };
  let modeArg = null;
  for (const a of argv) {
    if (a === '--no-launch') { o.noLaunch = true; continue; }
    if (a === '--force') { o.force = true; continue; }
    if (a === '--no-shortcut') { o.noShortcut = true; continue; }
    if (a in MODE_RANK) {
      if (modeArg === null || MODE_RANK[a] < MODE_RANK[modeArg]) modeArg = a;
      continue;
    }
    if (a.startsWith('--app-dir=')) {
      let v = a.slice('--app-dir='.length);
      // 某些 shell（PowerShell / 从命令行手输）会把外层引号原样带进来，剥掉；Windows 路径本身不可能以引号开头结尾
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      o.appDir = v;
      continue;
    }
    throw new Error(`未知参数: ${a}（可用参数: --no-launch --force --dry-run --self-test --create-shortcut --no-shortcut --app-dir=目录）`);
  }
  if (modeArg) o.mode = { '--self-test': 'self-test', '--create-shortcut': 'create-shortcut', '--dry-run': 'dry-run' }[modeArg];
  return o;
}

// 快捷方式参数：外层双引号是 cmd 硬性要求——单层引号/不加引号遇到空格或 & 都会断裂（实测）
function buildShortcutArgs(batPath) { return '/d /c ""' + batPath + '""'; }

// ---------- 状态文件 ----------
let STATE = {}; // 由 loadState() 填充；mirrorUsable() 等都会读它
function loadState() {
  for (const f of [STATE_FILE, LEGACY_STATE_FILE]) {
    try { STATE = JSON.parse(fs.readFileSync(f, 'utf8')); return; } catch (e) {}
  }
  STATE = {};
}
function writeState(s) {
  STATE = s;
  const text = JSON.stringify(s, null, 1);
  // 内容没变就不重写：普通模式每次启动都会刷新 catalogKey/installCache 等字段，无变化时不该动 mtime
  try { if (fs.readFileSync(STATE_FILE, 'utf8') === text) { try { fs.unlinkSync(LEGACY_STATE_FILE); } catch (e) {} return; } } catch (e) {}
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  fs.writeFileSync(STATE_FILE, text);
  try { fs.unlinkSync(LEGACY_STATE_FILE); } catch (e) {} // 已迁移到镜像目录
}
function mirrorUsable() {
  const exe = STATE.mainExe || 'ChatGPT.exe';
  return fs.existsSync(MIRROR + '/resources/app.asar') && fs.existsSync(MIRROR + '/' + exe);
}
// 快速指纹：asar 路径|大小|mtime；一致就复用旧 sha256，省掉每次启动约 2.5 秒的全量哈希
function fastKeyOf(asarPath) {
  const st = fs.statSync(asarPath);
  return asarPath + '|' + st.size + '|' + Math.round(st.mtimeMs);
}
// 指纹解析（纯函数，便于测试）：fastKey 命中且记录里有与之配对的 fastFingerprint 时才复用，
// 否则老老实实重算哈希。为什么不拿 storeFingerprint 兜底：失败记账会把 storeFingerprint 留在
// 上次成功的哈希上，拿它复用会让 knownBad（failedFingerprint === fp）永远对不上，用户每次启动
// 都白拷约 2GB 再失败；旧状态（只有 fastKey / 没有 fastFingerprint）就多花一次哈希，之后即修好
function resolveFingerprint(state, fk, computeHash) {
  const reuse = state.fastKey === fk && !!state.fastFingerprint;
  return { fp: reuse ? state.fastFingerprint : computeHash(), reused: reuse };
}

// ---------- asar：只读 package.json 做身份校验 ----------
function readAsarPackageJson(asarPath) {
  const st = fs.statSync(asarPath);
  if (st.size < 32) throw new Error('文件太小，不是 asar');
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > 64 * 1024 * 1024 || jsonLen > headerSize || 16 + jsonLen > st.size) throw new Error('asar 头格式异常');
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const entry = header && header.files && header.files['package.json'];
    if (!entry || typeof entry.size !== 'number' || entry.unpacked || entry.size > 4 * 1024 * 1024) throw new Error('asar 里没有可读的 package.json');
    const b = Buffer.alloc(entry.size);
    fs.readSync(fd, b, 0, entry.size, 8 + headerSize + Number(entry.offset));
    const pkg = JSON.parse(b.toString('utf8'));
    return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : null };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 候选排除 ----------
// 1) 镜像目录（当前 HOME 下的）2) 资源目录 3) 启动器镜像的应用目录
//    （那是某个用户 HOME 下的启动器镜像；沙箱测试改了 USERPROFILE 时，正在运行的真实镜像会从进程 /
//     .lnk 等渠道冒出来，版本还比沙箱假样本高，必须排掉）
//    判定只认"自己"或"父目录"：目录自己带 launcher-state.json（镜像根），或目录名为 app / app.staging /
//    app.old 且父目录带 launcher-state.json（镜像的 app 目录——规格 §10.3 的原话）。
//    不能沿祖先链上探：state 文件落在 HOME 根 / %LOCALAPPDATA% 时，会把其下正常的安装目录
//    （如 %LOCALAPPDATA%\Programs\Codex）全部误伤，且 --app-dir 也救不回来
const MIRROR_APP_RE = /^app(\.staging|\.old)?$/i;
function excludedReason(dir) {
  const d = N(dir);
  if (underDir(d, N(MIRROR_ROOT))) return '位于解锁镜像目录 %USERPROFILE%\\ChatGPT-Patched';
  if (RES_LINK && underDir(d, N(RES_LINK))) return '位于 CODEX_ELECTRON_RESOURCES_PATH 资源目录';
  const abs = path.resolve(dir);
  try { if (fs.existsSync(path.join(abs, 'launcher-state.json'))) return '看起来是启动器镜像目录（目录里有 launcher-state.json）'; } catch (e) {}
  if (MIRROR_APP_RE.test(path.basename(abs))) {
    const up = path.dirname(abs);
    try { if (fs.existsSync(path.join(up, 'launcher-state.json'))) return '看起来是启动器镜像目录（父目录含 launcher-state.json）'; } catch (e) {}
  }
  return null;
}

// ---------- 安装身份校验 ----------
// dir 可以是安装根目录（dir\app\resources\app.asar，商店布局）或应用目录（dir\resources\app.asar）
function inspectInstall(dir, source = 'exe') {
  const abs = path.resolve(dir);
  const why = excludedReason(abs);
  if (why) return { source, path: win(abs), ok: false, excluded: true, reason: why };
  let appDir = null;
  if (fs.existsSync(path.join(abs, 'app', 'resources', 'app.asar'))) appDir = path.join(abs, 'app');
  else if (fs.existsSync(path.join(abs, 'resources', 'app.asar'))) appDir = abs;
  if (!appDir) return { source, path: win(abs), ok: false, reason: '没有 resources\\app.asar' };
  // 主程序：ChatGPT.exe / Codex.exe 中体积最大的那个（商店里 Codex.exe 只有 20KB）
  const exes = ['ChatGPT.exe', 'Codex.exe'].map(n => path.join(appDir, n))
    .filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  if (!exes.length) return { source, path: win(abs), ok: false, reason: '未找到主程序（ChatGPT.exe / Codex.exe）' };
  let mainExe = exes[0];
  for (const e of exes) if (fs.statSync(e).size > fs.statSync(mainExe).size) mainExe = e;
  let pkg;
  try { pkg = readAsarPackageJson(path.join(appDir, 'resources', 'app.asar')); }
  catch (e) { return { source, path: win(abs), ok: false, reason: 'app.asar 无法读取: ' + e.message }; }
  if (pkg.name !== 'openai-codex-electron') {
    return { source, path: win(abs), ok: false, reason: '不是 Codex（package.json name=' + JSON.stringify(pkg.name) + '）' };
  }
  const root = path.basename(appDir).toLowerCase() === 'app' ? path.dirname(appDir) : appDir;
  const rec = {
    source, ok: true, appDir: win(appDir), path: win(appDir),
    mainExe: path.basename(mainExe), version: pkg.version, root: win(root),
    label: (source === 'store' ? '商店版 ' : '安装版 ') + (pkg.version || '未知版本'),
  };
  if (source === 'store') rec.aumid = aumidFromPkgDir(path.basename(root));
  return rec;
}
// 包全名 Name_Version_Arch__PublisherId -> AUMID Name_PublisherId!App
function aumidFromPkgDir(pkgName) {
  const parts = String(pkgName).split('_');
  if (parts.length < 3) return null;
  return parts[0] + '_' + parts[parts.length - 1] + '!App';
}

// ---------- 版本比较与选择 ----------
function cmpVersion(a, b) {
  const pa = String(a || '').split('.'), pb = String(b || '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10), y = parseInt(pb[i], 10);
    const xv = Number.isFinite(x) ? x : -1, yv = Number.isFinite(y) ? y : -1;
    if (xv !== yv) return xv - yv;
  }
  return 0;
}
// 手动指定优先；否则选版本最高的；同版本商店版优先
function pickInstall(cands) {
  const okList = (cands || []).filter(c => c && c.ok);
  const manual = okList.find(c => c.source === 'manual');
  if (manual) return manual;
  let best = null;
  for (const c of okList) {
    if (!best) { best = c; continue; }
    const d = cmpVersion(c.version, best.version);
    if (d > 0 || (d === 0 && c.source === 'store' && best.source !== 'store')) best = c;
  }
  return best;
}

// ---------- 安装发现 ----------
// 最近一次发现是否以管理员身份运行（null=未知）；只用于告警
let PS_ADMIN = null;

// 商店版（权威）：Get-AppxPackage；这个脚本同时捎带卸载注册表、开始菜单/桌面 .lnk、运行中进程，
// 一次 PowerShell 调用拿全，避免每次启动多花几秒。输出 UTF-8 JSON。
function discoveryScript(wantStore, wantExternal) {
  const parts = [];
  parts.push('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)');
  parts.push('$r=[ordered]@{admin=$false;store=@();uninstall=@();lnk=@();procs=@()}');
  parts.push('try{$r.admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}catch{}');
  if (wantStore) {
    parts.push('try{foreach($p in @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue)){if($p.InstallLocation){$r.store+=[ordered]@{path=$p.InstallLocation}}}}catch{}');
  }
  if (wantExternal) {
    // 卸载注册表：DisplayName 或 Publisher 匹配 codex|chatgpt|openai 的 InstallLocation / DisplayIcon / UninstallString
    parts.push('try{$keys=@("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*");' +
      'foreach($k in $keys){foreach($p in @(Get-ItemProperty $k -ErrorAction SilentlyContinue)){' +
      '$dn="$($p.DisplayName) $($p.Publisher)";if($dn -match \'codex|chatgpt|openai\'){' +
      'if($p.InstallLocation){$r.uninstall+=$p.InstallLocation};' +
      'if($p.DisplayIcon){$r.uninstall+=($p.DisplayIcon -replace \',\\d+$\',\'\')};' +
      'if($p.UninstallString){$u="$($p.UninstallString)";if($u -match \'^\\s*"([^"]+)"\'){$r.uninstall+=$Matches[1]}else{$r.uninstall+=($u -split \' \')[0]}}}}}}catch{}');
    // 开始菜单（用户+公共）与桌面：名字匹配 codex|chatgpt 的 .lnk 的目标。
    // 开始菜单递归（很小）；桌面只看顶层——某些用户的桌面目录里挂了几十万个文件（实测 9s+），递归不可接受
    parts.push('try{$pairs=@(@([Environment]::GetFolderPath(\'Programs\'),$true),@([Environment]::GetFolderPath(\'CommonPrograms\'),$true),@([Environment]::GetFolderPath(\'Desktop\'),$false),@([Environment]::GetFolderPath(\'CommonDesktopDirectory\'),$false));' +
      '$ws=New-Object -ComObject WScript.Shell;' +
      'foreach($pair in $pairs){try{$d=$pair[0];if(-not $d){continue};if(-not [IO.Directory]::Exists($d)){continue};' +
      '$opt=if($pair[1]){[IO.SearchOption]::AllDirectories}else{[IO.SearchOption]::TopDirectoryOnly};' +
      'foreach($f in [IO.Directory]::EnumerateFiles($d,\'*.lnk\',$opt)){' +
      'if([IO.Path]::GetFileName($f) -notmatch \'codex|chatgpt\'){continue};' +
      '$t=\'\';try{$t=$ws.CreateShortcut($f).TargetPath}catch{};' +
      'if($t){$r.lnk+=[ordered]@{name=[IO.Path]::GetFileName($f);target=$t}}}}catch{}}}catch{}');
    // 正在运行的 ChatGPT.exe / Codex.exe
    parts.push('try{$r.procs=@(Get-Process -ErrorAction SilentlyContinue | Where-Object{$_.Path -and $_.Path -match \'(?i)[\\\\/](ChatGPT|Codex)\\.exe$\'} | ForEach-Object{$_.Path})}catch{}');
  }
  parts.push('ConvertTo-Json -InputObject $r -Depth 6 -Compress');
  return parts.join(';');
}
const asArray = x => Array.isArray(x) ? x : (x == null ? [] : [x]);

// PowerShell 不可用时的商店版回退：读 AppModel 仓库注册表（路径在 REG_SZ 之后）。
// 组合过滤：行里同时含 OpenAI.Codex_ 与 PackageRootFolder（只滤 PackageRootFolder 会命中所有包，
// 只滤 OpenAI.Codex_ 会连键名行一起命中）；随后必须校验 <path>\app\resources\app.asar 存在（多版本残留逐个试）
function regStoreDirs() {
  const KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
  let text;
  try { text = runReg(['query', KEY, '/s', '/v', 'PackageRootFolder']); } catch (e) { return []; }
  const dirs = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('OpenAI.Codex_') || !line.includes('PackageRootFolder')) continue;
    const m = line.match(/REG_SZ\s+(.+?)\s*$/);
    if (!m) continue;
    const p = m[1].trim();
    if (p && fs.existsSync(path.join(p, 'app', 'resources', 'app.asar'))) dirs.push(p);
  }
  return dirs;
}

// PowerShell 不可用时的卸载注册表回退（reg.exe；中文路径靠 GBK 兜底解码）
function regUninstallCandidates() {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const hits = [];
  for (const root of roots) {
    let text;
    try { text = runReg(['query', root, '/s']); } catch (e) { continue; }
    let cur = null;
    const flush = () => {
      if (cur && /codex|chatgpt|openai/i.test((cur.name || '') + ' ' + (cur.publisher || ''))) hits.push(cur);
      cur = null;
    };
    for (const line of text.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) { flush(); cur = {}; continue; }
      if (!cur) continue;
      const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'displayname') cur.name = v;
      else if (k === 'publisher') cur.publisher = v;
      else if (k === 'installlocation') cur.loc = v;
      else if (k === 'displayicon') cur.icon = v.replace(/,\d+$/, '');
      else if (k === 'uninstallstring') cur.uninstall = v;
    }
    flush();
  }
  const paths = [];
  for (const e of hits) {
    for (const v of [e.loc, e.icon]) if (v) paths.push(v);
    if (e.uninstall) {
      const q = e.uninstall.match(/^\s*"([^"]+)"/);
      paths.push(q ? q[1] : e.uninstall.split(' ')[0]);
    }
  }
  return paths.filter(Boolean);
}

// ---------- 启动提速：安装发现缓存（规格 §5.6/§10.7） ----------
// 商店包集合：reg query 不带 /s 只列子键名（实测 48~81ms / 294 行，子键名就是完整包名），
// 取叶子（line.split('\\').pop()）以 OpenAI.Codex_ 开头的排序后 join(',')。reg 不可用返回 null（视为不命中）
const APPX_PACKAGES_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
function pkgSetOf() {
  let text;
  try { text = runReg(['query', APPX_PACKAGES_KEY]); } catch (e) { return null; }
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !/^HKEY_/i.test(t)) continue; // 只有顶层子键行；缩进行是值，不是子键
    const leaf = t.split('\\').pop();
    if (/^OpenAI\.Codex_/.test(leaf)) names.push(leaf);
  }
  return names.sort().join(',');
}
// Squirrel 形态安装：inst.root 下的 app-* 目录名；不是 Squirrel 布局（root 下没有 app-*）返回 null。
// 注意 root 的判定：appDir 名字叫 app 时 root=父目录（商店/MSIX 形态），否则 root=appDir 本身
// （Squirrel 形态下 appDir 就是 ...\SquirrelCodex\app-1.2.3，root 是 ...\SquirrelCodex）
function appSiblingsOf(inst) {
  if (!inst || !inst.root) return null;
  let subs;
  try { subs = fs.readdirSync(inst.root, { withFileTypes: true }); } catch (e) { return null; }
  const apps = subs.filter(s => s.isDirectory() && /^app-[\d.]+$/i.test(s.name)).map(s => s.name).sort();
  return apps.length ? apps.join(',') : null;
}
// 环境键：哪几个"发现来源开关"与手动目录决定候选集合；任一变化都让缓存失效
function envKeyOf(opts) {
  return [NO_STORE ? '1' : '0', NO_EXTERNAL ? '1' : '0', APP_DIR_ENV ? '1' : '0',
    opts && opts.appDir !== undefined ? '1' : '0'].join('');
}
// 快路径缓存记录的字段（写状态时用同一个来源，避免两边漂移）
function installCacheOf(inst) {
  return {
    source: inst.source, appDir: win(inst.appDir), root: win(inst.root), mainExe: inst.mainExe,
    version: inst.version === undefined ? null : inst.version,
    label: inst.label, aumid: inst.aumid || null,
    pkgSet: pkgSetOf(), appSiblings: appSiblingsOf(inst), envKey: envKeyOf(OPTS),
    at: new Date().toISOString(),
  };
}

// 快路径：状态里有缓存且一切未变 -> 直接返回候选，跳过整个 PowerShell 发现段（1.6~2s）。
// deps 全部可注入，便于 install-discovery-test 在不跑 PowerShell 的情况下测命中/不命中矩阵。
// 纯函数语义：不写文件、不 process.exit；返回 { ok, rec, reason }
// opts：本次运行的参数（默认取模块级 OPTS；启动器 main() 一定先设好，测试可直接传）
function tryCachedInstall(state, deps = {}, opts = OPTS) {
  const d = {
    inspectInstall: deps.inspectInstall || inspectInstall,
    pkgSet: deps.pkgSet || pkgSetOf,
    appSiblings: deps.appSiblings || appSiblingsOf,
    fsScanDirs: deps.fsScanDirs || fsScanDirs,
    envKey: deps.envKey || envKeyOf,
  };
  const missing = (reason) => ({ ok: false, rec: null, reason });
  const c = state && state.installCache;
  if (!c || !c.appDir || !c.source) return missing('状态里没有缓存的安装信息');
  if (c.source === 'manual') return missing('manual 不走缓存');
  if (c.envKey !== d.envKey(opts)) return missing('发现来源开关或手动目录发生了变化');
  let rec;
  try { rec = d.inspectInstall(c.appDir, c.source); } catch (e) { return missing('缓存目录无法校验: ' + e.message); }
  if (!rec || !rec.ok) return missing('缓存目录已不可用' + (rec && rec.reason ? '（' + rec.reason + '）' : ''));
  const ver = rec.version === undefined ? null : rec.version;
  if (ver !== (c.version === undefined ? null : c.version)) return missing('版本已变化（缓存 ' + c.version + '，实际 ' + ver + '）');
  if (c.source === 'store') {
    const now = d.pkgSet();
    if (now === null || now === undefined) return missing('reg.exe 不可用，无法核对商店包集合');
    if (now !== c.pkgSet) return missing('商店包集合已变化');
  } else if (c.source === 'exe') {
    const sib = d.appSiblings(rec); // 注入点是给 install-discovery-test 用的，别绕过
    if (sib !== (c.appSiblings === undefined ? null : c.appSiblings)) return missing('安装目录里的 app-* 目录已变化');
    // fsScanDirs 只花 2~15ms，但它列的是"名字里含 codex|chatgpt|openai 的目录"，**从不校验是不是安装**：
    // 实测本机 %LOCALAPPDATA% 下就有 OpenAI、OpenAI\Codex、Codex、codexhost 四个无关目录（应用自己建的
    // 运行时目录，一个都没有 app.asar）。所以不能"只要出现缓存外的目录就不命中"——那样官网 exe 版用户的
    // 缓存永远命不中，"第二次启动变快"对他们直接失效（实测：加一个无关目录即从 ok=true 变成 ok=false）。
    // 正确口径：只有"缓存 root 以外**真的是 Codex 安装**"才算发现了别的安装（这时才该跑完整发现）。
    const rootKey = N(rec.root || rec.appDir);
    for (const p of d.fsScanDirs()) {
      const q = N(p);
      if (q === rootKey || underDir(q, rootKey)) continue; // 缓存自己的 root/app-x.y.z：由 appSiblings 负责
      let other = null;
      try { other = d.inspectInstall(p, 'exe'); } catch (e) { continue; }
      if (other && other.ok) return missing('文件系统里出现了缓存以外的 Codex 安装（' + win(p) + '）');
    }
  } else {
    return missing('未知来源 ' + c.source);
  }
  return { ok: true, rec, reason: null };
}

// 文件系统扫描：%LOCALAPPDATA%\Programs、%ProgramFiles%、%ProgramFiles(x86)%、%LOCALAPPDATA% 下
// 名字匹配 codex|chatgpt|openai 的目录，检查 <d>、<d>\app、<d>\app-*（Squirrel，按版本从高到低）、
// <d>\<子目录>（如 OpenAI\Codex）。深度限制 2~3 层，不做全盘扫描。
function fsScanDirs() {
  const NAME = /codex|chatgpt|openai/i;
  const out = [];
  const seen = new Set();
  const add = d => { const k = N(d); if (seen.has(k)) return; seen.add(k); out.push(d); };
  const addVariants = d => {
    add(d);
    const appDir = path.join(d, 'app');
    if (isDir(appDir)) add(appDir);
    let subs;
    try { subs = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    const apps = subs.filter(s => s.isDirectory() && /^app-[\d.]+$/i.test(s.name)).map(s => s.name)
      .sort((a, b) => cmpVersion(b.slice(4), a.slice(4)));
    for (const s of apps) add(path.join(d, s));
  };
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
  roots.push(process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA);
  for (const root of roots) {
    if (!root) continue;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !NAME.test(e.name)) continue;
      const d1 = path.join(root, e.name);
      addVariants(d1);
      let subs;
      try { subs = fs.readdirSync(d1, { withFileTypes: true }); } catch (e2) { continue; }
      for (const s of subs) if (s.isDirectory() && NAME.test(s.name)) addVariants(path.join(d1, s.name));
    }
  }
  return out;
}

// 显式指定的目录（--app-dir= / 环境变量 CODEX_APP_DIR）优先于状态文件里记住的 installOverride。
// 单独抽出来是因为"显式指定校验失败必须报错退出"要区分这三种来源：
// 命令行与环境变量是本次的明确意图（错了要立刻报错）；状态里的记录是历史值（失效时只提示、不拦启动）
function explicitAppDir(opts) {
  if (opts && opts.appDir !== undefined) {
    return opts.appDir === '' ? { value: null, source: 'clear' } : { value: opts.appDir, source: 'cli' };
  }
  if (APP_DIR_ENV) return { value: APP_DIR_ENV, source: 'env' };
  return { value: null, source: null };
}

// 手动指定的目录：--app-dir= > 环境变量 CODEX_APP_DIR > 状态文件 installOverride
function manualDirFor(opts) {
  const e = explicitAppDir(opts);
  if (e.source === 'clear') return null;
  if (e.value) return e.value;
  return STATE.installOverride || null;
}

// 原始路径 -> 可尝试的目录列表（DisplayIcon/进程路径可能指向 exe，或深一层 resources）
function pathVariants(p) {
  const v = [];
  let dir = p;
  try { if (fs.statSync(p).isFile()) dir = path.dirname(p); } catch (e) {}
  v.push(dir);
  if (/^(app(-[\d.]+)?|resources|current|bin)$/i.test(path.basename(dir))) v.push(path.dirname(dir));
  return [...new Set(v)];
}

// 汇总所有来源：去重 -> 逐个 inspectInstall -> 返回候选列表（含排除原因）。
// manual 候选已 ok 时直接返回它、不跑 PowerShell 发现脚本（实测 1.6~2s，规格 §10.7）；manual 不 ok 才继续完整发现
function discoverInstalls(opts = {}) {
  const raw = [];
  const manual = manualDirFor(opts);
  if (manual) {
    raw.push({ source: 'manual', path: manual });
    const only = finishCandidates(raw);
    if (only.length && only[0].ok) return only; // manual 命中：短路
  }
  const wantStore = !NO_STORE, wantExternal = !NO_EXTERNAL;
  if (wantStore || wantExternal) {
    let j = null;
    try { j = JSON.parse(runCaptureBytes('powershell', [...PS_ARGS, '-Command', discoveryScript(wantStore, wantExternal)]).toString('utf8')); }
    catch (e) { j = null; }
    if (j) {
      PS_ADMIN = !!j.admin;
      if (wantStore) for (const s of asArray(j.store)) if (s && s.path) raw.push({ source: 'store', path: s.path });
      if (wantExternal) {
        for (const p of asArray(j.uninstall)) if (p) raw.push({ source: 'exe', path: p });
        for (const l of asArray(j.lnk)) {
          if (!l || !l.target) continue;
          if (String(l.name || '').startsWith('Codex 解锁版')) continue; // 我们自己的快捷方式
          raw.push({ source: 'exe', path: l.target });
        }
        for (const p of asArray(j.procs)) if (p) raw.push({ source: 'exe', path: p });
      }
    } else {
      // PowerShell 整体失败：商店版退回 reg.exe；卸载注册表也退回 reg.exe
      if (wantStore) for (const d of regStoreDirs()) raw.push({ source: 'store', path: d });
      if (wantExternal) for (const p of regUninstallCandidates()) raw.push({ source: 'exe', path: p });
    }
  }
  for (const d of fsScanDirs()) raw.push({ source: 'exe', path: d });
  return finishCandidates(raw);
}

// 候选组装：去重（按 appDir/路径）-> 逐个 inspectInstall，保留首个 ok / 排除原因 / 失败原因
function finishCandidates(raw) {
  const seen = new Set();
  const out = [];
  const push = rec => {
    const k = N(rec.ok ? rec.appDir : rec.path);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(rec);
  };
  for (const r of raw) {
    const dirs = r.source === 'store' ? [r.path] : pathVariants(r.path);
    let okRec = null, failRec = null, excludedRec = null;
    for (const d of dirs) {
      const res = inspectInstall(d, r.source);
      if (res.ok) { okRec = res; break; }
      if (res.excluded && !excludedRec) excludedRec = res;
      else if (!failRec) failRec = res;
    }
    push(okRec || excludedRec || failRec || { source: r.source, path: win(r.path), ok: false, reason: '不是 Codex 安装' });
  }
  return out;
}

const SOURCE_ZH = { store: '商店版', exe: '安装版', manual: '手动指定' };
function printCandidates(cands) {
  if (!cands.length) { log('没有发现任何 Codex 安装候选'); return; }
  log(`发现 ${cands.length} 个候选:`);
  for (const c of cands) {
    const src = SOURCE_ZH[c.source] || c.source;
    if (c.ok) log(`  [可用] ${src}  ${c.version || '未知版本'}  ${c.appDir}  主程序: ${c.mainExe}`);
    else log(`  [排除] ${src}  ${c.path}  ${c.reason}`);
  }
}

// ---------- 快捷方式 ----------
const lnkPath = dir => path.join(dir, SHORTCUT_NAME);

// 桌面/开始菜单目录用 WScript.Shell SpecialFolders 取（桌面可能被 OneDrive 或用户改到别的盘，
// 不能拼 %USERPROFILE%\Desktop）；测试时 CODEX_LAUNCHER_SHORTCUT_DIR 让两个目标指向同一目录，按一条处理。
// 获取通道按可靠性依次尝试：PowerShell -> Windows 脚本宿主（cscript）-> 常见目录推断。
// 只走 PowerShell 会让 --create-shortcut 在"公司禁用 PowerShell"的机器上永远建不出图标（三处调用都要求
// targets 非空，创建侧的脚本宿主兜底根本走不到），所以后两条通道不是可有可无的优化
function dedupeTargets(list) {
  const targets = [], seen = new Set();
  for (const t of list) {
    if (!t || !t.path) continue;
    const k = N(t.path);
    if (seen.has(k)) continue;
    seen.add(k);
    targets.push(t);
  }
  return targets;
}

function shortcutTargets() {
  if (SHORTCUT_DIR) return [{ path: SHORTCUT_DIR, env: true }];
  const viaPs = shortcutTargetsViaPowerShell();
  if (viaPs && viaPs.length) return viaPs;
  const viaWsh = shortcutTargetsViaWsh();
  if (viaWsh && viaWsh.length) {
    log('PowerShell 不可用，已改用 Windows 脚本宿主获取桌面/开始菜单目录');
    return viaWsh;
  }
  const viaGuess = shortcutTargetsGuess();
  if (viaGuess.length) {
    log('PowerShell 与 Windows 脚本宿主都不可用，按常见位置推断桌面/开始菜单:', viaGuess.map(t => t.path).join('、'));
    return viaGuess;
  }
  log('无法获取桌面/开始菜单目录（PowerShell/脚本宿主都不可用，常见位置也不存在）');
  return [];
}

function shortcutTargetsViaPowerShell() {
  try {
    // 输出编码必须显式设成 UTF-8：桌面/开始菜单路径可能含中文（用户名/OneDrive），
    // 而 GBK 的中文两字节恰好可能是合法 UTF-8（不产生 U+FFFD），兜底重解不会触发
    const out = runPowershell('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' +
      '$ws=New-Object -ComObject WScript.Shell;$ws.SpecialFolders(\'Desktop\');$ws.SpecialFolders(\'Programs\')');
    return dedupeTargets(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(p => ({ path: p })));
  } catch (e) {
    return null;
  }
}

// 第二条通道：cscript + 同一个 WScript.Shell（企业常只禁 PowerShell 而 WSH 还在用）。
// 结果经 UTF-16LE 文件回传，绕开控制台代码页（中文路径在 OEM 页下无法可靠解码）；
// .vbs 本身也写成 UTF-16LE+BOM，任何区域设置下 WSH 都能正确读取
function shortcutTargetsViaWsh() {
  const dir = os.tmpdir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} // TEMP 不存在时兜底（同 runCaptureBytes）
  const vbs = path.join(dir, `codex-dirs-${process.pid}.vbs`);
  const outFile = path.join(dir, `codex-dirs-${process.pid}.txt`);
  const lines = [
    'Option Explicit',
    'Dim sh, fso, f',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set f = fso.CreateTextFile(sh.Environment("Process")("CODEX_DIRS_OUT"), True, True)',
    'f.WriteLine "DESKTOP=" & sh.SpecialFolders("Desktop")',
    'f.WriteLine "PROGRAMS=" & sh.SpecialFolders("Programs")',
    'f.Close',
    '',
  ];
  fs.writeFileSync(vbs, Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf16le'));
  try {
    runCaptureBytes('cscript.exe', ['//Nologo', vbs], { env: { ...process.env, CODEX_DIRS_OUT: outFile } });
    const text = fs.readFileSync(outFile, 'utf16le').replace(/^\uFEFF/, '');
    const targets = [];
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const p = line.slice(i + 1).trim();
      if (p) targets.push({ path: p });
    }
    return dedupeTargets(targets);
  } catch (e) {
    return null;
  } finally {
    fs.rmSync(vbs, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

// 最后一条通道：连脚本宿主都没有时按已知位置推断（OneDrive 重定向的两种目录名都试）。
// 只挑真实存在的目录，宁可少建也不往不存在的位置写
function shortcutTargetsGuess() {
  const cands = [];
  if (process.env.USERPROFILE) {
    cands.push(path.join(process.env.USERPROFILE, 'Desktop'));
    cands.push(path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop'));
    cands.push(path.join(process.env.USERPROFILE, 'OneDrive', '桌面'));
  }
  if (process.env.OneDrive) {
    cands.push(path.join(process.env.OneDrive, 'Desktop'));
    cands.push(path.join(process.env.OneDrive, '桌面'));
  }
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dedupeTargets(cands.filter(isDir).map(p => ({ path: p })));
}

// 图标：把选中安装的 resources\icon-chatgpt.ico 复制到 MIRROR_ROOT\Codex解锁版.ico 并使用
//（固定路径，不受镜像替换影响）；都没有就回退主程序 ,0。返回 IconLocation 字符串或 null
//
// 【重要特性，写测试的人务必知道】图标路径落在用户 profile 之下时，Windows 的 shell 不会把绝对路径原样存进
// .lnk：它把 %USERPROFILE% 那一段抽出来存成环境变量形态（实测本机 .lnk 原始字节里是字面量
// "%USERPROFILE%\ChatGPT-Patched\Codex解锁版.ico"，绝对路径一个字节都没有；实测两种环境创建出来的 .lnk
// 都是这个样子）。读取时再由**读取方自己的环境**展开——实测同一个 .lnk：
//   用真实用户环境读 -> C:\Users\<真实用户>\ChatGPT-Patched\Codex解锁版.ico
//   用沙箱 USERPROFILE 环境读 -> <沙箱>\ChatGPT-Patched\Codex解锁版.ico
// 对真实用户这是**期望行为**（每个用户各自展开到自己的目录，快捷方式跟着文件搬家/换用户名都不失效）。
// 但任何自动化测试读回 .lnk 断言图标路径时，必须用**创建时的那一份环境**去读，否则会读到自己的 profile、
// 误判成"图标路径错了"（e2e 用例 C 就踩过这个坑，根因在测试侧、不在启动器）。
// 注：这条行为有 5 次独立复现（沙箱创建/真实环境创建各一组，读回值都随读取方环境切换）。但"具体哪些环境
// 变量参与展开"没定位到：只改 USERPROFILE（或只改 HOME / 只改 HOMEDRIVE+HOMEPATH）时读回值不切换，
// 换成整套沙箱环境才切换——所以这里只把"读回时必须用创建时的那一份环境"这条结论写死，不写机制细节。
function ensureShortcutIcon(inst) {
  const cands = [];
  if (inst && inst.appDir) {
    cands.push(path.join(inst.appDir, 'resources', 'icon-chatgpt.ico'));
    cands.push(path.join(inst.appDir, 'resources', 'chatgpt-app-light.ico'));
    cands.push(path.join(inst.appDir, 'resources', 'chatgpt-app-dark.ico'));
  }
  cands.push(MIRROR + '/resources/icon-chatgpt.ico');
  cands.push(MIRROR + '/resources/chatgpt-app-light.ico');
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    try {
      const dst = path.join(MIRROR_ROOT, ICON_NAME);
      fs.mkdirSync(MIRROR_ROOT, { recursive: true });
      fs.copyFileSync(c, dst);
      return win(dst);
    } catch (e) { log('图标复制失败:', e.message); }
  }
  const exe = (inst && inst.appDir && inst.mainExe && path.join(inst.appDir, inst.mainExe)) || path.join(MIRROR, STATE.mainExe || 'ChatGPT.exe');
  if (fs.existsSync(exe)) return win(exe) + ',0';
  return null;
}

// 用 PowerShell WScript.Shell 创建 .lnk；所有路径经环境变量传入（防引号/中文问题），输出所建 .lnk 列表
function createShortcuts(inst) {
  const out = [];
  // §6：bat 位于临时目录（os.tmpdir() 之下或路径含 Temp1_，即在压缩包里直接双击）时不建，提示先解压。
  // 自动创建与 --create-shortcut 统一走这里，规则一致
  if (tempDirBat()) {
    const t = shortcutTargets();
    log('启动器看起来在临时目录里运行（可能直接双击了压缩包内的 bat）。请先完整解压，再重新运行以创建快捷方式');
    out.push({ path: t.length ? win(lnkPath(t[0].path)) : null, action: 'skipped', reason: 'bat 位于临时目录（可能未解压）' });
    return out;
  }
  const targets = shortcutTargets();
  if (!targets.length) { out.push({ path: null, action: 'skipped', reason: '未能确定桌面/开始菜单目录' }); return out; }
  if (!fs.existsSync(ENTRY_PATH)) {
    for (const t of targets) out.push({ path: win(lnkPath(t.path)), action: 'skipped', reason: '未找到入口: ' + ENTRY_PATH });
    return out;
  }
  const dirs = [];
  for (const t of targets) {
    if (!fs.existsSync(t.path)) {
      if (t.env) { try { fs.mkdirSync(t.path, { recursive: true }); } catch (e) {} }
      if (!fs.existsSync(t.path)) { out.push({ path: win(lnkPath(t.path)), action: 'skipped', reason: '目录不存在: ' + t.path }); continue; }
    }
    dirs.push(t.path);
  }
  if (!dirs.length) return out;
  const icon = ensureShortcutIcon(inst);
  const script = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' +
    '$ws=New-Object -ComObject WScript.Shell;' +
    'foreach($d in ($env:CODEX_LNK_DIRS -split ([char]10))){' +
    'if(-not $d){continue};' +
    '$lnk=Join-Path $d $env:CODEX_LNK_NAME;' +
    '$s=$ws.CreateShortcut($lnk);' +
    '$s.TargetPath=$env:CODEX_LNK_TARGET;' +
    '$s.Arguments=$env:CODEX_LNK_ARGS;' +
    '$s.WorkingDirectory=$env:CODEX_LNK_CWD;' +
    'if($env:CODEX_LNK_ICON){$s.IconLocation=$env:CODEX_LNK_ICON};' +
    '$s.WindowStyle=1;$s.Description=$env:CODEX_LNK_DESC;$s.Save();Write-Output $lnk}';
  const env = {
    ...process.env,
    CODEX_LNK_DIRS: dirs.join('\n'),
    CODEX_LNK_NAME: SHORTCUT_NAME,
    CODEX_LNK_TARGET: SEA_MODE ? ENTRY_PATH : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    CODEX_LNK_ARGS: SEA_MODE ? '' : buildShortcutArgs(win(BAT_PATH)),
    CODEX_LNK_CWD: win(path.dirname(SEA_MODE ? ENTRY_PATH : BAT_PATH)),
    CODEX_LNK_ICON: icon || '',
    CODEX_LNK_DESC: 'Codex 解锁版（自动同步商店/官网更新并启动）',
  };
  let made = [], psError = null;
  try {
    made = runCaptureBytes('powershell', [...PS_ARGS, '-Command', script], { env }).toString('utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) { psError = e; }
  // PowerShell 被组策略整体禁用时退回 Windows 脚本宿主（cscript + 同一个 WScript.Shell COM 接口、
  // 同一组 CODEX_LNK_* 环境变量），产物与 PowerShell 路径一致；两条通道都不可用才放弃
  if (!made.length && psError) {
    try {
      made = runVbsShortcuts(env);
      log('PowerShell 不可用，已改用 Windows 脚本宿主创建快捷方式' + (made.length ? '' : '（脚本未报告结果，下面按文件是否存在判断）'));
    } catch (e2) { log('脚本宿主创建快捷方式失败:', String(e2.message || e2).split('\n')[0]); }
  }
  // 两条通道都没报告结果时以文件是否存在为准；完全没有才记 skipped（原因优先用 PowerShell 的报错）
  const madeSet = new Set(made.map(p => N(p)));
  for (const d of dirs) {
    const p = lnkPath(d);
    if (madeSet.has(N(p)) || fs.existsSync(p)) out.push({ path: win(p), action: 'created', reason: null });
    else out.push({ path: win(p), action: 'skipped', reason: psError ? '创建失败: ' + String(psError.message || psError).split('\n')[0] : '创建脚本未报告创建结果' });
  }
  return out;
}

// PowerShell 不可用时创建 .lnk 的兜底通道：cscript 跑一段纯 ASCII 的 VBScript（.vbs 用完即删）。
// 注意不要用 //B（它会把 WScript.Echo 的输出也吞掉，导致无法回报创建结果）
function runVbsShortcuts(env) {
  const lines = [
    'Option Explicit',
    'Dim sh, dirs, d, lnk, sc, icon',
    'Set sh = CreateObject("WScript.Shell")',
    'dirs = Split(sh.Environment("Process")("CODEX_LNK_DIRS"), Chr(10))',
    'For Each d In dirs',
    '  If Len(d) > 0 Then',
    '    lnk = d & "\\" & sh.Environment("Process")("CODEX_LNK_NAME")',
    '    Set sc = sh.CreateShortcut(lnk)',
    '    sc.TargetPath = sh.Environment("Process")("CODEX_LNK_TARGET")',
    '    sc.Arguments = sh.Environment("Process")("CODEX_LNK_ARGS")',
    '    sc.WorkingDirectory = sh.Environment("Process")("CODEX_LNK_CWD")',
    '    icon = sh.Environment("Process")("CODEX_LNK_ICON")',
    '    If Len(icon) > 0 Then',
    '      sc.IconLocation = icon',
    '    End If',
    '    sc.WindowStyle = 1',
    '    sc.Description = sh.Environment("Process")("CODEX_LNK_DESC")',
    '    sc.Save',
    '    WScript.Echo lnk',
    '  End If',
    'Next',
    '',
  ];
  const dir = os.tmpdir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} // TEMP 不存在时兜底（同 runCaptureBytes）
  const vbs = path.join(dir, `codex-shortcut-${process.pid}.vbs`);
  fs.writeFileSync(vbs, lines.join('\r\n'));
  try {
    return runCaptureBytes('cscript.exe', ['//Nologo', vbs], { env }).toString('utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } finally {
    fs.rmSync(vbs, { force: true });
  }
}

// bat 在临时目录（os.tmpdir() 之下或路径含 Temp1_）时说明是在压缩包里直接双击，不自动建快捷方式
// exe 模式没有"压缩包里的 bat"问题（单文件、自包含），放哪里都能建快捷方式
function tempDirBat() {
  if (SEA_MODE) return false;
  const bat = N(BAT_PATH);
  if (bat.includes('temp1_')) return true;
  const tmp = N(os.tmpdir());
  return !!tmp && underDir(bat, tmp);
}

// 普通模式：首次成功启动后自动创建；之后快捷方式还在但指向的 bat 变了（文件夹搬家）就更新；
// 用户删掉的不再自动加回（除非 --create-shortcut）。--no-shortcut 本次不碰；
// bat 在临时目录（可能未解压）的检查在 createShortcuts 里统一处理
// 状态里的快捷方式清单（每次真正查/建成功后刷新；老状态没有这个字段就当场补记一次）
function recordShortcutPaths(paths) {
  const list = [...new Set((paths || []).filter(Boolean))];
  STATE.shortcutPaths = list;
}
// 记录"当前存在的 .lnk 完整路径"；.lnk 都还在且指向的 bat 没变时，下次启动不再为它跑 PowerShell
function maybeAutoShortcut(inst) {
  if (OPTS.noShortcut) { REPORT.shortcuts.push({ path: null, action: 'skipped', reason: '--no-shortcut' }); return; }
  const cached = Array.isArray(STATE.shortcutPaths) ? STATE.shortcutPaths : null;
  if (cached && cached.length && STATE.shortcutBat === ENTRY_PATH && cached.every(p => fs.existsSync(p))) {
    // 快路径：不调 shortcutTargets()（那会跑一次 PowerShell，约 1.5s，正是"窗口出现后控制台还多挂"的成因）
    for (const p of cached) REPORT.shortcuts.push({ path: win(p), action: 'kept', reason: null });
    return;
  }
  const targets = shortcutTargets();
  if (!targets.length) { REPORT.shortcuts.push({ path: null, action: 'skipped', reason: '未能确定桌面/开始菜单目录' }); return; }
  const existing = targets.filter(t => fs.existsSync(lnkPath(t.path)));
  if (!existing.length && !STATE.shortcutsCreated) {
    const made = createShortcuts(inst);
    REPORT.shortcuts.push(...made);
    if (made.some(r => r.action === 'created')) {
      STATE.shortcutsCreated = true;
      STATE.shortcutBat = ENTRY_PATH;
      recordShortcutPaths(made.filter(r => r.action === 'created').map(r => r.path));
      writeState(STATE);
      log('已创建桌面/开始菜单快捷方式: Codex 解锁版');
    }
  } else if (existing.length && STATE.shortcutBat && STATE.shortcutBat !== ENTRY_PATH) {
    // 入口搬家/换入口（bat<->exe）：快捷方式还在但指向的入口变了 -> 自动更新。
    // 状态里没有 shortcutBat 说明这个同名 .lnk 不是我们建的（用户手工建的 / 状态文件丢了），不覆盖
    const made = createShortcuts(inst);
    for (const r of made) if (r.action === 'created') r.action = 'updated';
    REPORT.shortcuts.push(...made);
    if (made.some(r => r.action === 'updated')) {
      STATE.shortcutBat = ENTRY_PATH;
      recordShortcutPaths(made.filter(r => r.action === 'updated').map(r => r.path));
      writeState(STATE);
      log('快捷方式指向的入口已变化，已自动更新');
    }
  } else if (existing.length) {
    for (const t of existing) REPORT.shortcuts.push({ path: win(lnkPath(t.path)), action: 'kept', reason: null });
    // 老状态没有 shortcutPaths：这一次仍然查了目录，把找到的 .lnk 补记进状态，下次就能走快路径
    if (!cached || cached.length === 0) {
      recordShortcutPaths(existing.map(t => win(lnkPath(t.path))));
      writeState(STATE);
    }
  } else {
    // shortcutsCreated=true 但文件不存在：用户自己删了，不再自动加回
    REPORT.shortcuts.push({ path: win(lnkPath(targets[0].path)), action: 'skipped', reason: '用户已删除（需要时用 --create-shortcut 重建）' });
  }
}

// ---------- 单实例锁 ----------
let LOCK_OWNED = false;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : true; } // ESRCH=死；EPERM 说明进程存在但没权限
}
// 普通模式与 --dry-run 建锁；已有锁且 pid 存活且不超过 30 分钟 -> 返回 false（另一个启动器在跑）
function acquireLock() {
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, time: Date.now(), start: new Date().toISOString() });
  try {
    fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' }); // wx=原子创建
    LOCK_OWNED = true;
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let info = null;
  try { info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) {}
  if (info && typeof info.pid === 'number' && info.time && pidAlive(info.pid) && Date.now() - info.time < 30 * 60 * 1000) return false;
  try { fs.writeFileSync(LOCK_FILE, payload); LOCK_OWNED = true; } catch (e) {} // 陈旧锁：接管
  return true;
}
function removeLock() {
  if (!LOCK_OWNED) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
  LOCK_OWNED = false;
}

// ---------- 磁盘空间：MIRROR_ROOT 目录不存在（首次运行）时用最近的已存在父目录判断 ----------
function freeBytesNear(dir) {
  let cur = path.resolve(dir);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  try { const st = fs.statfsSync(cur); return st.bavail * st.bsize; }
  catch (e) { return null; } // 拿不到就不检查
}
const fmtGB = n => (n / 1024 / 1024 / 1024).toFixed(1) + 'GB';

// ---------- 清除下载标记（Mark-of-the-Web）：只删启动器自身相关文件的 Zone.Identifier，失败忽略 ----------
function clearZoneIdentifiers() {
  // exe 模式：入口就是自己（下载来的 exe 自带 Zone.Identifier，顺手清掉；运行中的文件删 ADS 一般可行，失败忽略）
  const files = [SEA_MODE ? process.execPath : path.join(__dirname, 'codex-launcher.js')];
  try { for (const f of fs.readdirSync(path.join(__dirname, 'lib'))) files.push(path.join(__dirname, 'lib', f)); } catch (e) {}
  try {
    for (const f of fs.readdirSync(__dirname)) if (/\.(bat|cmd|txt)$/i.test(f)) files.push(path.join(__dirname, f));
  } catch (e) {}
  let n = 0;
  for (const f of files) { try { fs.unlinkSync(f + ':Zone.Identifier'); n++; } catch (e) {} }
  if (n) log(`已清除 ${n} 个文件的下载标记（Zone.Identifier）`);
}

// ---------- 进程 ----------
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

// ---------- 启动前的"原版是否在运行"异步检查（规格 §5.4/§10.6） ----------
// 为什么要异步：pidsUnder 的 Get-Process 全量枚举实测 1.9~2s，阻塞在启动前就是"第二次启动还是慢"的主因。
// 做法：选中安装后立刻 spawn 两个子进程（tasklist 快筛同名进程 + inst.root 版 pidsUnder 区分镜像/原版），
// 都不 await；照常 launch()；launch 之后再等最多 3 秒拿结果。
// tasklist 只看"有没有同名进程"，不能按路径过滤（实测），所以真正的区分靠 pidsUnder。
// 超时必须自己收尾（kill + stdout.destroy + unref），否则 node 会为未退出的子进程/未关闭的管道继续挂着，
// bat 窗口跟着多停留（就是 §1.4 里"窗口出现后控制台还多挂 1.5s"的成因）。
// 注意：不要用 execFile + await 的写法（超时后 node 仍要等子进程真正退出）
// 第 3 轮审查的时序修正（已实测）：tasklist 约 400ms、PowerShell 1.6~1.9s，而只有"tasklist 说同名进程存在"
// 时才需要 PowerShell 的结论（路径过滤区分镜像/原版）。过去 Promise.all 先等两个都结束，等于在根本用不到
// PowerShell 结论的常见路径上也白等约 1.5s —— 双击图标后控制台稳定多挂近 2 秒。现在改成"tasklist 没命中
// 同名进程就立即返回空数组并收尾 PowerShell"，把 2 秒从常见路径上拿掉（tasklist 命中时才等 PowerShell）。
function spawnCapture(file, args, opts = {}) {
  let out = '';
  let child = null;
  const done = new Promise(resolve => {
    try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], ...opts }); }
    catch (e) { resolve({ out: '', ok: false, err: e }); return; }
    if (child.stdout) child.stdout.on('data', d => { out += d.toString('utf8'); });
    // 流上必须有 error 监听：stop() 会在子进程还活着时 destroy 管道，没有监听的话流上的 error
    // 会变成未处理异常直接崩掉进程（timeout 路径一直有这个风险，改成"常见路径也 kill"后风险更实）
    if (child.stdout) child.stdout.on('error', () => {});
    child.on('error', () => resolve({ out, ok: false }));
    child.on('close', code => resolve({ out, ok: code === 0, code }));
  });
  // child 在 spawn 抛错时为 null；stop() 必须容忍
  return { done, stop() {
    try { if (child) child.kill(); } catch (e) {}
    try { if (child && child.stdout) child.stdout.destroy(); } catch (e) {}
    try { if (child) child.unref(); } catch (e) {}
  } };
}
// 发起检查：返回 { done: Promise<string[]|null>, stop() }；done 解析为 pidsUnder 的 pid 数组（null=没拿到结果）
function startOriginalProcessCheck(inst) {
  const t = spawnCapture('tasklist', ['/FI', 'IMAGENAME eq ' + inst.mainExe, '/FO', 'CSV', '/NH']);
  const p = spawnCapture('powershell', [...PS_ARGS, '-Command',
    `$r='${(path.resolve(inst.root) + path.sep).replace(/'/g, "''")}';Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id }`]);
  const done = (async () => {
    const tl = await t.done;
    // tasklist 说"没有同名进程" -> 不需要 PowerShell 结论：立即收尾（kill + destroy + unref）并返回。
    // 只在这里提前收尾，不拖到 awaitOriginalCheck 的超时路径——否则控制台窗口会因为那个还挂着的
    // PowerShell 子进程（未退出、管道未关）继续多停留约 1.5s，正是本次要修的"第二次启动还是慢"
    if (!hasSameNameProcess(tl.out, inst.mainExe)) { p.stop(); return []; }
    const ps = await p.done;
    return ps.ok ? ps.out.split(/\r?\n/).map(s => s.trim()).filter(s => s && s !== String(process.pid)) : null;
  })();
  const stop = () => { t.stop(); p.stop(); };
  return { done, stop };
}
// tasklist 的 CSV 行形如 "ChatGPT.exe","36752",...；没有匹配时输出的是本地化提示文本（不是 CSV，首字符不是引号）
function hasSameNameProcess(tasklistOut, exeName) {
  const want = String(exeName || '').toLowerCase();
  for (const line of String(tasklistOut || '').split(/\r?\n/)) {
    const m = line.trim().match(/^"([^"]+)","(\d+)"/);
    if (m && m[1].toLowerCase() === want) return true;
  }
  return false;
}
// launch 后最多等 3 秒拿检查结果；超时返回 null（当"不知道"：不提示、不因此置退出码 2）
async function awaitOriginalCheck(check, ms = 3000) {
  if (!check) return null;
  let timer = null;
  const timeout = new Promise(r => { timer = setTimeout(() => r(null), ms); });
  const r = await Promise.race([check.done, timeout]);
  clearTimeout(timer);
  if (r === null) check.stop(); // 超时：必须收尾，否则控制台窗口会多挂一会儿
  return r;
}

// ---------- 启动提速：缓存 node 路径给 lib/find-node.cmd（规格 §5.8） ----------
// 路径只允许这些字符时才可以写：cmd 的 for /f 读出来的值会被原样当命令用，含 & | < > ^ % ! " ( ) 或非 ASCII
// 都可能被解析成语法（entry 侧还会再挡一次同样的字符集）
// **跨模块约定（handoff 对象 = entry）**：改这个正则必须同步通知 entry 改 lib/find-node.cmd 的 findstr 白名单行，
// [A-Za-z0-9_. :\\/-] 必须与这里逐字符一致，否则 launcher 写出的路径 entry 读不回、缓存静默失效
// （只是变慢不报错，属于最难发现的退化；实测两侧一致，见 test 备注与 find-node-test）。
// 注意字符类里必须写两个反斜杠才算字面反斜杠：单反斜杠会退化成转义符，把 Windows 路径判 false（实测）。
const NODE_PATH_SAFE_RE = /^[A-Za-z0-9 _.:\\/-]+$/;
const NODE_PATH_FILE = MIRROR_ROOT + '/node-path.txt';
// 普通模式（含 --no-launch）在成功启动/本应启动的位置写；内容没变不重写；不满足安全字符就删掉旧文件
function writeNodePathCache() {
  const exe = String(process.execPath || '');
  if (!NODE_PATH_SAFE_RE.test(exe)) {
    try { fs.rmSync(NODE_PATH_FILE, { force: true }); } catch (e) {}
    return;
  }
  const text = exe + '\r\n'; // ASCII、无 BOM、CRLF 结尾
  let cur = null;
  try { cur = fs.readFileSync(NODE_PATH_FILE, 'utf8'); } catch (e) {}
  if (cur === text) return;
  try {
    fs.mkdirSync(MIRROR_ROOT, { recursive: true });
    fs.writeFileSync(NODE_PATH_FILE + '.tmp', text, 'ascii');
    fs.renameSync(NODE_PATH_FILE + '.tmp', NODE_PATH_FILE);
  } catch (e) { log('警告: 缓存 node 路径失败（不影响启动）:', e.message); }
}
// 把 exe 内嵌的 asar 校验哈希原位替换为新 asar 的 sha256（等长，JSON 结构不变）
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

// ---------- 模型目录 v14：合并目录只写到镜像根目录，绝不写 config.toml 或它指向的文件 ----------
// 目录来源（优先级从高到低）：
//   1) config.toml 顶层 model_catalog_json 指向的文件（cc-switch 自己的目录文件，**只读**）
//   2) CODEX_HOME/cc-switch-model-catalog.json（存在才用）
//   3) 镜像 codex.exe 的 debug models --bundled（底座，"内置 slug"的判定依据）
// v13 遗留的 model-catalog-ultrafast.json 是"内置目录+ultrafast"的旧产物，当 extras 用会把内置 slug 复制一遍，跳过。

// TOML 逐行解析的统一口径（与主进程注入函数逐字一致，规格 §10.2）：
// 先砍 # 注释、再 trim；表头 /^\[\s*model_providers\s*\.\s*(.*?)\s*\]$/ 抓名字并剥引号；
// 表内 env_key|auth|aws|http_headers|env_http_headers|query_params 视为"该供应商自带别种鉴权"。
// 顶层点号键与 inline table 一律不识别（假阴性可接受）；多行字符串里的假表头由覆盖文件的
// requiresOpenaiAuth 标志兜底（注入函数把它当必要条件）。
const TOML_HEADER_RE = /^\[\s*model_providers\s*\.\s*(.*?)\s*\]$/;
const TOML_OTHER_AUTH_RE = /^(env_key|auth|aws|http_headers|env_http_headers|query_params)\s*=/;
const stripComment = line => String(line).split('#')[0];
// TOML 字符串字面量：双引号（处理 \\ 转义）或单引号；不是字符串字面量返回 null
function tomlString(s) {
  const t = String(s).trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\\\/g, '\\');
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return null;
}

// ---------- 多行字符串感知（没有它会产生**致命**假阳性，不是"最坏少推参数"） ----------
// TOML 的多行字符串有两种定界符："""（基本）与 '''（字面量）。字符串内部的行即使长得像表头/键值，
// 也只是普通文本。逐行解析不加这层会出事（第 2 轮审查发现、已实测）：假表头 -> launcher 判"表存在" ->
// 写 auth 覆盖 -> 注入函数推出 -c model_providers.<id>.requires_openai_auth=true，而 config 里其实没有
// 这张表 -> codex 报 `Error: model_providers.custom: provider name must not be empty` 且
// **app-server 进程直接以退出码 1 退出**（实测 61ms；对照：不带 -c 时 app-server 正常应答 initialize，
// stderr 只是 `Invalid configuration; using defaults`）。也就是用户打开解锁版后整块功能不可用。
// 取舍：只做"整行是否处在多行字符串内部"的判断，宁可漏判（少写一条覆盖、用户照常能用）
// 也不误判（推错参数会让功能整块不可用）。不处理行内字符串里出现的定界符（那种写法本身不是合法 TOML）。
function findUnquotedHash(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; } // 基本字符串里的转义
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') return i;
  }
  return -1;
}
// 一行里最早出现的多行字符串定界符位置（只看未注释部分），没有返回 -1
function findMultiStart(body) {
  const d = body.indexOf('"""');
  const q = body.indexOf("'''");
  if (d < 0) return q;
  if (q < 0) return d;
  return Math.min(d, q);
}
// 从 from 起找结束定界符；""" 里 \""" 是转义引号，不算结束（数前面连续反斜杠的个数）
function findMultiEnd(body, delim, from) {
  let i = from;
  for (;;) {
    const at = body.indexOf(delim, i);
    if (at < 0) return -1;
    if (delim === '"""') {
      let bs = 0, k = at - 1;
      while (k >= 0 && body[k] === '\\') { bs++; k--; }
      if (bs % 2 === 1) { i = at + 1; continue; }
    }
    return at;
  }
}
// 返回与行数组等长的布尔数组：true = 该行**起始处**处于结构位置（可以当表头/键值行解析）。
// 起始处已在多行字符串内部的行一律 false（整行跳过，也不参与"当前在哪个表里"的判断）。
function structuralFlags(rawLines) {
  const flags = [];
  let delim = null;
  for (const raw of rawLines) {
    const line = String(raw);
    if (delim !== null) {
      flags.push(false);
      if (findMultiEnd(line, delim, 0) >= 0) delim = null; // 本行可能就把字符串收尾了
      continue;
    }
    flags.push(true);
    const hash = findUnquotedHash(line);
    const body = hash >= 0 ? line.slice(0, hash) : line; // 注释里的 """ 不当定界符
    const at = findMultiStart(body);
    if (at >= 0) {
      delim = body.substr(at, 3);
      if (findMultiEnd(body, delim, at + 3) >= 0) delim = null; // key = """x""" 这种同行开闭
    }
  }
  return flags;
}
// 逐行解析入口：跳过"落在多行字符串内部"的行。fn 返回 false 表示停止遍历（readTopLevel 遇表头即停）
function forEachStructuralLine(tomlText, fn) {
  const raw = String(tomlText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const flags = structuralFlags(raw);
  for (let i = 0; i < raw.length; i++) {
    if (!flags[i]) continue;
    if (fn(raw[i], i) === false) return;
  }
}

// 剥掉表头名字两端的引号（无引号/双引号/单引号都接受）
// 表头名字段的归一化：**去掉所有引号**（不是只剥两端），并把点号两侧的空白也归一掉。
// 必须与主进程注入函数同源（lib/launcher-core.js 里是 `n.split('"').join('').split("'").join('')`）：
// 只剥两端时 [model_providers."custom".http_headers] 会变成 'custom".http_headers'（引号留在中间），
// launcher 判不出子表、注入函数却判得出——两边打架（实测：launcher 报 direct-no-credential/说"已修"，
// 注入函数不加鉴权项；反方向 [model_providers . "custom" . http_headers] 则 launcher 说修、注入函数真加了，
// 把用户自带的 Authorization 头顶掉）。这里比 core 多归一一次点号周围的空白，方向是**更保守**：
// 多认成子表 -> 少写鉴权覆盖 -> 注入函数什么也不推（它只在 launcher 说 OK 时才动），用户自带鉴权不会被顶掉。
// provider id 本身不允许含点号（PROVIDER_ID_RE），所以折叠点号空白不会误伤正常的 [model_providers.<id>]。
const unquoteTomlName = n => String(n).trim().split('"').join('').split("'").join('').replace(/\s*\.\s*/g, '.');

// 只看第一个表头之前的顶层行；没有的字段为 null。
// 多行字符串内部的行不算（否则 developer_instructions = """...""" 里的 model_provider = "x" 会被当真）
function readTopLevel(tomlText) {
  const out = { modelProvider: null, model: null, modelCatalogJson: null };
  forEachStructuralLine(tomlText || '', raw => {
    const t = stripComment(raw).trim();
    if (!t) return;
    if (t.charAt(0) === '[') return false; // 进入第一个表头：顶层结束
    const m = t.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) return;
    const v = tomlString(m[2]);
    if (v === null) return;
    if (m[1] === 'model_provider') out.modelProvider = v;
    else if (m[1] === 'model') out.model = v;
    else if (m[1] === 'model_catalog_json') out.modelCatalogJson = v;
  });
  return out;
}

// 某个供应商表的信息；判定规则与主进程注入函数同源（子表/别种鉴权键都算 hasOtherAuth）。
// 多行字符串里的假表头必须跳过（见 structuralFlags 的注释：那会产生致命假阳性）
function providerTableInfo(tomlText, id) {
  const out = { found: false, requiresOpenaiAuth: null, hasBearer: false, hasEnvKey: false, hasOtherAuth: false, baseUrlHost: null };
  if (typeof id !== 'string' || !id) return out;
  let inTable = false;
  forEachStructuralLine(tomlText || '', raw => {
    const t = stripComment(raw).trim();
    if (!t) return;
    if (t.charAt(0) === '[') {
      const m = t.match(TOML_HEADER_RE);
      const n = m ? unquoteTomlName(m[1]) : '';
      inTable = !!m && n === id;
      if (inTable) out.found = true;
      else if (m && n.startsWith(id + '.')) out.hasOtherAuth = true; // [model_providers.<id>.xxx] 子表
      return;
    }
    if (!inTable) return;
    const kv = t.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) return;
    const key = kv[1], val = tomlString(kv[2]);
    if (key === 'requires_openai_auth') out.requiresOpenaiAuth = /^true$/i.test(String(kv[2]).trim());
    else if (key === 'experimental_bearer_token') out.hasBearer = !!(val && val.trim());
    else if (key === 'base_url' && val) { try { out.baseUrlHost = new URL(val).host || null; } catch (e) {} }
    if (TOML_OTHER_AUTH_RE.test(t)) { out.hasOtherAuth = true; if (key === 'env_key') out.hasEnvKey = true; }
  });
  return out;
}

// 内置（保留）provider id 白名单：只有这 4 个被 codex 接受；给它们加 -c requires_openai_auth 会直接
// 加载失败（"reserved built-in provider IDs"），必须原样放过（规格 §10.1，实测结论）
const BUILTIN_PROVIDER_IDS = ['openai', 'ollama', 'lmstudio', 'amazon-bedrock'];
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 决定要不要写鉴权覆盖；diagnosis 取值固定（规格 §5.3 + §10.1）
// provider 非 null 只有 direct-no-credential / routed-or-bearer / already-true 三种（三种都会写进覆盖文件：
// 路由形态也写，这样会话中途关掉路由后新开的会话仍然带着 auth.json 的 Key，见规格 §1.2 实测）
// authJson 接口：规格写的是"authJson"没规定形态。对象按对象用；JSON **字符串**先 parse 再用
// （probe 的 callDecide 两种都试；若不 parse 就会静默变成 no-api-key，把"已登录"误判成"没 key"）
function decideAuthOverride({ tomlText, authJson }) {
  const top = readTopLevel(tomlText || '');
  const p = top.modelProvider;
  if (!p) return { provider: null, diagnosis: 'no-provider' };
  if (BUILTIN_PROVIDER_IDS.indexOf(p) >= 0) return { provider: null, diagnosis: 'no-provider' };
  if (!PROVIDER_ID_RE.test(p)) return { provider: null, diagnosis: 'invalid-id' };
  let a = authJson && typeof authJson === 'object' ? authJson : null;
  if (typeof authJson === 'string') {
    try { const j = JSON.parse(authJson.replace(/^\uFEFF/, '')); if (j && typeof j === 'object') a = j; }
    catch (e) { a = null; } // 原文不是 JSON：按"没有 auth.json"处理
  }
  if (!a) return { provider: null, diagnosis: 'no-api-key' };
  if (a.tokens) return { provider: null, diagnosis: 'chatgpt-login' };
  const key = typeof a.OPENAI_API_KEY === 'string' ? a.OPENAI_API_KEY : '';
  if (!key.trim()) return { provider: null, diagnosis: 'no-api-key' };
  const info = providerTableInfo(tomlText || '', p);
  if (!info.found) return { provider: null, diagnosis: 'no-table' };
  if (info.hasOtherAuth) return { provider: null, diagnosis: 'other-auth' };
  if (info.hasBearer) return { provider: p, diagnosis: 'routed-or-bearer' };
  if (info.requiresOpenaiAuth === true) return { provider: p, diagnosis: 'already-true' };
  return { provider: p, diagnosis: 'direct-no-credential' };
}

// 覆盖文件对象（规格 §5.3 + §10.2）：不含任何 key/token，只有路径与布尔/标签
// auth.requiresOpenaiAuth 固定 true：它表达"启动器已确认可以对 <id> 加这个覆盖"，
// 主进程注入函数把它当必要条件（多行字符串假表头的最后一道兜底）
function buildOverrides({ catalogPath, auth }) {
  return {
    version: 1,
    writer: OVERRIDES_WRITER,
    catalog: typeof catalogPath === 'string' && catalogPath ? catalogPath.replace(/\\/g, '/') : null,
    auth: auth && auth.provider ? { provider: auth.provider, requiresOpenaiAuth: true } : null,
  };
}

// diagnosis -> 一行中文说明（不含任何 key 值）
function diagnosisText(d, provider) {
  switch (d) {
    case 'no-provider': return 'config.toml 没有指定第三方供应商（或用的是内置供应商），无需修复';
    case 'invalid-id': return '供应商 id 含非法字符，无法为它加鉴权覆盖';
    case 'no-table': return 'config.toml 里没有 [model_providers.' + provider + '] 表（会话中途被 cc-switch 删掉时不能加覆盖，否则 codex 会报 provider name must not be empty）';
    case 'other-auth': return '该供应商自带其它鉴权方式（env_key / auth 命令 / 自定义头 / 子表），不覆盖它的鉴权设置';
    case 'no-api-key': return 'auth.json 里没有可用的 API Key，无法自动补鉴权';
    case 'chatgpt-login': return 'auth.json 是 ChatGPT 官方登录（有 tokens），不能拿官方凭据去访问第三方地址，未启用鉴权修复';
    case 'routed-or-bearer': return '该供应商自带 bearer（cc-switch 路由模式），按原样使用；解锁版仍会写入鉴权覆盖，路由关掉后新开的会话也能直接用 auth.json 里的 Key';
    case 'already-true': return '该供应商已配置 requires_openai_auth = true，无需修改';
    case 'direct-no-credential': return '检测到 cc-switch 当前供应商 requires_openai_auth = false 且没有填 Key（请求会 401 API_KEY_REQUIRED）：'
      + '解锁版已在启动时自动改为使用 auth.json 里的 API Key。根治方法：在 cc-switch 里编辑该供应商，把 config.toml 里的 requires_openai_auth = false 改成 true';
    default: return '诊断结果: ' + d;
  }
}

// 第三方条目的必填字段（第 4 轮审查备案条目，已实测复现）。
// 依据（镜像 codex.exe + 临时 CODEX_HOME，`debug models -c model_catalog_json=<合并目录>`，逐个字段删了试）：
//   缺以下任何一个字段 -> codex 拒绝**整份**合并目录（`failed to parse model_catalog_json path ...:
//   missing field \`X\`` 或 `model \`x\` is missing both ...`），app-server 57ms 退出码 1 ——
//   用户看到的是"解锁版起不来"，不是"少了几个模型"；
//   只留这些字段、删掉全部可选字段 -> 接受（说明清单是完整的）；
//   多带未知字段 -> 接受（所以只查"有没有"，不禁止额外字段）；
//   值写 null -> 拒绝（`invalid type: null, expected string/i32`，所以 null 也算缺失）。
// 覆盖内置 slug 的条目不受这条约束：它们会与内置条目展开合并（{...m, ...ex}），缺失项由内置补齐（实测接受）。
// 局限：清单来自当前版本 codex 的校验；将来 codex 加新必填字段时这里拦不住（但那时 cc-switch 写出的条目
// 也会带新字段，真正需要防的是"用户目录里那条被写坏/被手改残"的情况）。
const CATALOG_REQUIRED_FIELDS = ['display_name', 'experimental_supported_tools', 'priority', 'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'truncation_policy', 'visibility'];
// base_instructions 是**二选一**的条件必填（第 11 轮审查发现，我已用 10 组变体实测复核）：
//   指令正文可以从 base_instructions **或** model_messages.instructions_template 任一处提供。
//   实测（镜像 codex.exe `debug models -c model_catalog_json=<目录>`，探针条目 = cc-switch 真实条目形状改 slug）：
//     删 base_instructions 且无 model_messages -> 拒绝，原文：
//       model `probe-cond` is missing both `base_instructions` and `model_messages.instructions_template`
//     删 base_instructions 但给 instructions_template -> 接受；
//     base_instructions=null 但给 template -> 接受（null 也算"没给"）；
//     删 base_instructions + model_messages={}（无 template 键）/ template=null -> 都拒绝；
//     base_instructions=""（空串）-> 接受（空串算"给了"）；template="" 同理。
//   为什么必须做条件判定：真实第三方目录里只靠 model_messages.instructions_template 提供指令的条目是合法的，
//   把它们当"缺字段"跳过，用户侧表现为"这个模型在解锁版里没了"，而 codex 本来完全能接受它。
const CATALOG_INSTRUCTION_FIELDS = ['base_instructions', 'model_messages.instructions_template'];
const hasField = (m, pathStr) => {
  let v = m;
  for (const k of pathStr.split('.')) {
    if (v === undefined || v === null || typeof v !== 'object') return false;
    v = v[k];
  }
  return v !== undefined && v !== null; // null 算"没给"（与其它字段一致，实测 base_instructions=null 同样不被接受）
};
const missingCatalogFields = m => {
  const miss = CATALOG_REQUIRED_FIELDS.filter(f => m[f] === undefined || m[f] === null);
  if (!CATALOG_INSTRUCTION_FIELDS.some(p => hasField(m, p))) miss.push('base_instructions 或 model_messages.instructions_template');
  return miss;
};

// 合并目录（纯函数，不读文件）：bundled = codex debug models --bundled 的对象；
// extras = [{ path, data }] 按优先级从高到低，data 为已解析的目录对象（null/坏 JSON/旧产物由调用方与这里一起跳过）
// 规则（规格 §5.2）：内置 slug 补 priority+ultrafast（按 id 去重、priority 在前）；同 slug 元数据以 extras 为准；
// 第三方 slug 原样保留、不补档位；models 顺序 = 内置在前，随后按 extras 出现顺序追加新 slug
function mergeCatalogs(bundled, extras) {
  const base = bundled && typeof bundled === 'object' ? bundled : {};
  const baseModels = Array.isArray(base.models) ? base.models : [];
  const list = [];
  for (const x of (Array.isArray(extras) ? extras : [])) {
    if (!x || typeof x !== 'object') continue;
    if (!x.data || !Array.isArray(x.data.models)) continue; // 读失败/坏 JSON 跳过
    if (x.path && path.basename(String(x.path)).toLowerCase() === 'model-catalog-ultrafast.json') continue; // v13 旧产物
    list.push({ path: x.path || null, data: x.data }); // 带上来源路径：跳过坏条目时要能告诉用户是哪个文件
  }
  // slug -> 最高优先级的 extras 条目；并按出现顺序记录新 slug
  const extraBySlug = new Map(), extraOrder = [];
  // 内置 slug 集合：**只有**第三方 slug 需要必填字段校验。覆盖内置 slug 的条目会与内置条目展开合并
  // （下面的 {...m, ...ex}），缺失字段由内置补齐，实测被 codex 接受（把 visibility 改成 null 除外，
  // 但那是"值坏"，不是"字段缺"）；对它们做同样的跳过会把用户正常的档位覆盖一起丢掉
  const baseSlugs = new Set();
  for (const m of baseModels) if (m && typeof m.slug === 'string' && m.slug) baseSlugs.add(m.slug);
  for (const cat of list) {
    for (const m of cat.data.models) {
      if (!m || typeof m.slug !== 'string' || !m.slug) continue;
      if (extraBySlug.has(m.slug)) continue;
      // 第三方 slug 会被原样复制进合并目录：缺必填字段时 codex 拒绝**整份**目录（实测），
      // 这里降级为"跳过这一条"（少几个第三方模型），而不是把解锁版整个搞挂
      if (!baseSlugs.has(m.slug)) {
        const miss = missingCatalogFields(m);
        if (miss.length) {
          log('模型目录条目缺必填字段（会让 codex 拒绝整份目录），已跳过:', m.slug,
            '缺:', miss.join('、'), '来源:', cat.path ? win(cat.path) : '(调用方未提供路径)');
          continue;
        }
      }
      extraBySlug.set(m.slug, m);
      extraOrder.push(m.slug);
    }
  }
  // 档位合并：按 id 去重；digits 判定统一走 String()
  const tierId = t => (t && typeof t === 'object' && typeof t.id === 'string') ? t.id : null;
  const unionTiers = (a, b) => {
    const out = [], seen = new Set();
    for (const t of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      const id = tierId(t);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(t);
    }
    return out;
  };
  const models = [];
  const seen = new Set();
  for (const m of baseModels) {
    if (!m || typeof m !== 'object') continue;
    const slug = typeof m.slug === 'string' ? m.slug : null;
    const ex = slug ? extraBySlug.get(slug) : null;
    const merged = ex ? { ...m, ...ex } : { ...m };
    if (slug) seen.add(slug);
    const tiers = unionTiers(m.service_tiers, ex && ex.service_tiers);
    if (!tiers.some(t => tierId(t) === 'priority')) tiers.unshift({ ...PRIORITY_TIER });
    else tiers.sort((a, b) => (tierId(a) === 'priority' ? -1 : tierId(b) === 'priority' ? 1 : 0)); // priority 放最前
    if (!tiers.some(t => tierId(t) === 'ultrafast')) tiers.push({ ...ULTRAFAST_TIER });
    merged.service_tiers = tiers;
    models.push(merged);
  }
  for (const slug of extraOrder) {
    if (seen.has(slug)) continue; // 内置已有：并入上面处理
    seen.add(slug);
    models.push({ ...extraBySlug.get(slug) }); // 第三方 slug：原样保留，不补任何档位
  }
  return { ...base, models };
}

// 目录文件读取（只读；坏文件/结构不对返回 null，不抛）
function readCatalogFile(p) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { log('模型目录文件不是合法 JSON，已跳过:', win(p)); return null; }
  if (!data || !Array.isArray(data.models)) { log('模型目录文件结构不对（没有 models 数组），已跳过:', win(p)); return null; }
  return data;
}
const CODEX_HOME_DIR = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// 解析 model_catalog_json 的值：支持 ${VAR} 展开（codex 自己的规则），相对路径按 CODEX_HOME 解析
function resolveCatalogRef(ref) {
  if (!ref) return null;
  let v = String(ref).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => process.env[name] || m);
  if (!path.isAbsolute(v)) v = path.join(CODEX_HOME_DIR(), v);
  return v;
}
// 当前 config.toml 指向的目录文件（可能是 cc-switch 自己的文件，只读不写）
function tomlCatalogJsonPath(tomlText) {
  return resolveCatalogRef(readTopLevel(tomlText || '').modelCatalogJson);
}
// model_catalog_json 指向的文件不存在时返回解析后的路径（悬空引用），否则 null。
// 为什么要管（第 3 轮审查发现，已实测复现）：config.toml 里有这行而文件被删掉时，codex app-server 的
// **每个新会话**都会失败——实测 thread/start 返回 {"code":-32600,"message":"failed to load configuration:
// 系统找不到指定的文件。 (os error 2)"}（initialize 正常，所以现象是"对话起不来"）。而 v13 曾把
// model_catalog_json 写进用户 config.toml（指向 ~/.codex/model-catalog-ultrafast.json），使用说明又说
// "删掉也可以"——删掉之后就进入上面这个状态：解锁版自己的 -c model_catalog_json 覆盖在位时能盖住
// （实测带 -c 时 thread/start 正常），覆盖不在位（镜像重建没成功、或用户绕过启动器、或其它 codex 客户端
// 直接读同一份 config）就会起不来。v14 承诺不改 config.toml，所以这里只做只读检测、由上层打印告警，
// 绝不写回（§4.4）。
function danglingCatalogRef(tomlText) {
  const p = tomlCatalogJsonPath(tomlText || '');
  if (!p) return null;
  try { if (fs.statSync(p).isFile()) return null; } catch (e) { return p; }
  return p;
}
// 悬空行的影响分档（纯函数，供 runOnce 与测试用）：
//   protected = 解锁版自己的 -c model_catalog_json 覆盖在位。三个条件缺一即 critical：
//     1) 覆盖文件里 catalog 指向存在的合并目录——注入函数在拉起 app-server 的那一刻还会再 statSync
//        一次（lib/launcher-core.js:520），文件被删就不推这条 -c；
//     2) 镜像的 net 补丁在位——它不在位时注入函数根本不在 bundle 里，-c 推不上去；
//     3) app-server 是从镜像（解锁版副本）拉起的——注入函数住在镜像 bundle 里、按 process.execPath
//        定位覆盖文件（core 的 launcherOverrides），商店/官网原版与 VS Code 扩展直接读同一份
//        config.toml、拿不到这条 -c。
//     所以 protected 只对"通过解锁版启动的 Codex"成立；其它直接读这份 config 的客户端仍然会中招
//     （runOnce 的告警文案已把两种情况分开写明）。
//   critical  = 上面任一条件不成立：读这份 config 的 Codex 新建对话直接失败。
//   为什么条件 1/2 值得单独列（交接复核时双方各自实测过）：临时 CODEX_HOME + 悬空 model_catalog_json
//   时，裸 app-server 的 thread/start 报「failed to load configuration: 系统找不到指定的文件。
//   (os error 2)」；同一配置加 -c model_catalog_json=<有效目录> 后 thread/start 正常——即这条 -c
//   在悬空场景下是**承重**的，不是"只是换个目录用"（core 侧那次实测用的还是 provider=ollama 的内置
//   供应商形态，说明该结论与 provider 形态无关）。
function danglingCatalogSeverity(overrides, patch) {
  const protectedByOverrides = !!(overrides && overrides.catalog && patch && patch.present);
  return protectedByOverrides ? 'protected' : 'critical';
}
// extras 列表（按优先级）：config.toml 指向的文件 -> cc-switch-model-catalog.json
function catalogExtras(tomlText) {
  const cands = [];
  const ref = tomlCatalogJsonPath(tomlText);
  if (ref) cands.push(ref);
  cands.push(path.join(CODEX_HOME_DIR(), 'cc-switch-model-catalog.json'));
  const out = [];
  for (const p of cands) {
    if (out.some(x => N(x.path) === N(p))) continue; // 同一文件不重复
    const data = readCatalogFile(p);
    out.push({ path: p, data });
  }
  return out.filter(x => x.data); // 读失败/坏 JSON/不存在的直接跳过（purity: mergeCatalogs 也会挡）
}

// 从镜像 codex.exe 导出内置目录。临时 CODEX_HOME 必须建在 MIRROR_ROOT 下：建在 %TEMP% 时 codex 会往
// stderr 打 "WARNING: proceeding, even though we could not create PATH aliases"，而 runCaptured 把
// stdout+stderr 写进同一个文件，JSON.parse 必然失败（规格 §10.5 实测）。这里再做一次兜底：
// 丢弃第一个 { 之前的内容；没有 { 或解析失败都抛中文错误（异常必须可见，不能静默变成"没有目录"）
function codexBundledCatalog(codexExe) {
  const home = fs.mkdtempSync(path.join(MIRROR_ROOT, '.tmp-catalog-'));
  let out;
  try {
    out = core.runCaptured(codexExe, ['debug', 'models', '--bundled'], {
      timeout: 120000, env: { ...process.env, CODEX_HOME: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const i = out.indexOf('{');
  if (i < 0) throw new Error('codex.exe 没有输出 JSON（开头是 ' + JSON.stringify(out.slice(0, 60)) + '）');
  let cat;
  try { cat = JSON.parse(out.slice(i)); }
  catch (e) { throw new Error('codex.exe 输出的 JSON 无法解析: ' + e.message); }
  if (!Array.isArray(cat.models) || cat.models.length === 0) throw new Error('导出的目录没有 models');
  return cat;
}

// 生成/更新合并目录。返回 { ok, path, models, ultrafast } —— ok=false 时 path 仍可能是"沿用中的旧文件"
function ensureMergedCatalog(inst) {
  const codexExe = MIRROR + '/resources/codex.exe';
  if (!fs.existsSync(codexExe)) return { ok: false, path: null, models: 0, ultrafast: 0, reason: '镜像里没有 codex.exe' };
  let tomlText = '';
  try { tomlText = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch (e) {}
  const extras = catalogExtras(tomlText);
  // 缓存键：codex.exe 的 size+mtime + 各 extras 文件（含"没有 extras"这个事实）的 路径+size+mtime + 'v14'。
  // config.toml 换成别的目录文件时，extras 的路径列表就变了 -> 键变 -> 重新生成
  const parts = [];
  try { const st = fs.statSync(codexExe); parts.push('codex|' + st.size + '|' + Math.round(st.mtimeMs)); } catch (e) {}
  for (const x of extras) parts.push(x.path.replace(/\\/g, '/'));
  // 注意 extras 里 data 已解析成功（坏文件不会进列表），这里补文件指纹
  for (const x of extras.slice()) {
    try { const st = fs.statSync(x.path); parts.push(st.size + '|' + Math.round(st.mtimeMs)); } catch (e) {}
  }
  parts.push('v14');
  const key = crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  if (STATE.catalogKey === key && fs.existsSync(MERGED_CATALOG)) {
    let n = 0, u = 0;
    try {
      const cur = JSON.parse(fs.readFileSync(MERGED_CATALOG, 'utf8'));
      n = (cur.models || []).length;
      u = (cur.models || []).filter(m => (m.service_tiers || []).some(t => t && t.id === 'ultrafast')).length;
    } catch (e) {}
    STATE.catalogKey = key; // 状态文件由调用方写回
    log('模型目录未变化，复用上次的合并结果（' + n + ' 个模型）');
    return { ok: true, path: MERGED_CATALOG, models: n, ultrafast: u, cached: true };
  }
  try {
    const bundled = codexBundledCatalog(codexExe);
    const merged = mergeCatalogs(bundled, extras);
    const text = JSON.stringify(merged, null, 2);
    let cur = null;
    try { cur = fs.readFileSync(MERGED_CATALOG, 'utf8'); } catch (e) {}
    if (cur !== text) {
      fs.mkdirSync(MIRROR_ROOT, { recursive: true });
      fs.writeFileSync(MERGED_CATALOG + '.tmp', text);
      fs.renameSync(MERGED_CATALOG + '.tmp', MERGED_CATALOG);
    }
    const ultrafast = merged.models.filter(m => (m.service_tiers || []).some(t => t && t.id === 'ultrafast')).length;
    STATE.catalogKey = key;
    return { ok: true, path: MERGED_CATALOG, models: merged.models.length, ultrafast };
  } catch (e) {
    try { fs.rmSync(MERGED_CATALOG + '.tmp', { force: true }); } catch (_) {}
    // 导出失败不阻断启动：已有合并目录就照用（与 v13 同思路）。沿用时要如实报告它的模型数
    if (fs.existsSync(MERGED_CATALOG)) {
      log('警告: 模型目录更新失败，沿用现有文件:', (e.stderr || e.message || '').toString().trim().split('\n').pop());
      let n = 0, u = 0;
      try {
        const cur = JSON.parse(fs.readFileSync(MERGED_CATALOG, 'utf8'));
        n = (cur.models || []).length;
        u = (cur.models || []).filter(m => (m.service_tiers || []).some(t => t && t.id === 'ultrafast')).length;
      } catch (e2) {}
      return { ok: false, path: MERGED_CATALOG, models: n, ultrafast: u, reason: e.message, stale: true };
    }
    log('警告: 模型目录更新失败（本次没有可用的模型目录，Ultrafast 档可能不生效）:', (e.stderr || e.message || '').toString().trim().split('\n').pop());
    return { ok: false, path: null, models: 0, ultrafast: 0, reason: e.message };
  }
}

// 覆盖文件：一个路径 + 一份诊断结论，不含任何 key/token。内容没变不重写
function writeOverrides(over) {
  const text = JSON.stringify(over, null, 2);
  let cur = null;
  try { cur = fs.readFileSync(OVERRIDES_FILE, 'utf8'); } catch (e) {}
  if (cur === text) return false; // 内容没变
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE + '.tmp', text);
  fs.renameSync(OVERRIDES_FILE + '.tmp', OVERRIDES_FILE);
  return true;
}
// 只在镜像根目录下生成/更新覆盖文件（镜像不可用时不写）；diag 由调用方传入（同一次运行只诊断一次）
// catalog.path 非空就写进去（含"本次导出失败、沿用旧文件"的情况——旧文件仍然可用）
function applyOverrides(catalog, diag) {
  const over = buildOverrides({
    catalogPath: catalog && catalog.path ? catalog.path : null,
    auth: diag && diag.provider ? { provider: diag.provider } : null,
  });
  const changed = writeOverrides(over);
  if (changed) log('已更新覆盖文件:', win(OVERRIDES_FILE));
  if (over.catalog) {
    const n = catalog && catalog.ultrafast ? catalog.ultrafast : 0;
    if (n) log(`已为 ${n} 个模型启用 Ultrafast（通过解锁版自己的模型目录，不改 config.toml）`);
    else log('模型目录已由解锁版接管（通过解锁版自己的模型目录，不改 config.toml）');
  } else {
    log('未启用模型目录覆盖（本次没有可用的合并目录）');
  }
  log('网络修复：', diagnosisText(diag.diagnosis, diag.provider));
  return { over, changed };
}
// 读 config.toml / auth.json（严格只读），跑一遍诊断
function readDiagnosis() {
  let tomlText = '', authJson = null;
  try { tomlText = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch (e) {}
  try { authJson = JSON.parse(fs.readFileSync(path.join(CODEX_HOME_DIR(), 'auth.json'), 'utf8')); } catch (e) {}
  return decideAuthOverride({ tomlText, authJson });
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
// 部分解锁（allowPartial）：某个补丁组整组失配（版本差异）时跳过该组、其余照常应用；
//   两组之间没有标识符耦合——15 条补丁的替换产物都是自包含的（内联 IIFE / 局部变量），互不引用；
//   唯一横跨两组的是 K6r 条目（同一替换里既补 max/ultra 强度档、又补 serviceTiers fast/ultrafast），
//   归 effort 组，它注入的 serviceTiers 数据不依赖 speed 组的任何产物。
//   落地前必须对"实际要写入的内容"过 node --check。
function rebuild(inst, { dryRun = false } = {}) {
  const STAGING = MIRROR + '.staging';
  const srcDir = inst.appDir;

  // 1) 同步安装目录 -> staging（robocopy；退出码 0-7 均为成功）
  log('同步安装文件到 staging ...');
  fs.rmSync(STAGING, { recursive: true, force: true });
  try {
    execSync(`robocopy "${win(srcDir)}" "${win(STAGING)}" /E /NFL /NDL /NJH /NJS /NP`, { stdio: 'ignore' });
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

    // 3) 应用补丁（按组原子；allowPartial：失配组整组跳过、其余组全部命中才部分解锁）
    const content = new Map();
    for (const e of Object.values(role)) content.set(e.rel, loc.text(e));
    const r = core.applyPatchSet(content, role, { allowPartial: true });
    const results = r.results;
    const skippedGroups = r.skippedGroups || [];
    const partial = !!r.partial;
    REPORT.patch = patchReportFrom(r);
    for (const x of results) {
      if (x.ok) log(`OK  ${x.note}` + (x.variant ? `（变体 ${x.variant}）` : ''));
      else log('FAIL', x.note, `: 期望 ${x.expect} 处，实际 ${x.actual} 处`);
    }
    // 补丁失配且无法部分解锁则终止，不应用半成品
    if (r.failCount > 0) throw new Error(`${r.failCount} 个补丁未命中，该版本可能不兼容，保留现有镜像`);
    if (partial && skippedGroups.length) {
      log('部分解锁：' + skippedGroups.map(g => GROUP_ZH[g] || g).join('、') + ' 组未命中（对应功能保持未解锁），其余已应用');
    }

    // 3b) 主进程 net 补丁（修 401 / Ultrafast 被丢弃）：与 webview 15 条完全独立，不进 PATCHES 计数。
    //     失配不阻断重建——webview 解锁照常，只是这两条网络修复不可用（报告 net.patch.applied=false）。
    const netDoc = core.locateNetBundle(loc.header, loc.dataBase, loc.fd);
    const netApp = netDoc ? core.applyNetPatch(netDoc.text) : { ok: false, actual: 0, text: null };
    // 形态必须与 netPatchState() 完全一致（含 present/reason）：runOnce 的"没重建"分支会把 NET_STATE.patch
    // 换成 netPatchState() 的结论，两段独立代码只要形状不同，报告消费者就得对两种形态各写一套判断
    NET_STATE.patch = {
      located: !!netDoc, applied: !!netApp.ok, actual: netApp.actual,
      rel: netDoc ? netDoc.rel : null,
      present: !!(netDoc && netApp.ok), // 重建成功后镜像里就是在位的补丁；失败时镜像保持原样
      reason: netDoc ? (netApp.ok ? null : 'app-server 启动参数代码形态与预期不符（命中 ' + netApp.actual + ' 处）') : '找不到 app-server 启动参数代码',
    };
    if (netDoc && netApp.ok) {
      // 注入串必须全是 ASCII（规格 §4.3 的硬约束）。原因：core 的注入函数体会被 toString() 原样拼进 bundle，
      // 而 bundle 是 latin1 读写的 —— 非 ASCII 字符会落成单字节，而 CJK 区里约 492 个字（U+4E00..U+9FFF 中
      // 每 256 个里有 6 个）的低位字节恰好是 0x0A/0x0D/0x22/0x27/0x5C/0x60（如「上」->0x0A、「丢」->0x22）。
      // 实测（node -e 复刻 latin1 落盘 + --check）：行注释里出现这种字，会把注释截断、后续字节变代码，
      // 是否真的语法失败取决于**该位置后面跟着什么字节**（后接合法标识符仍能过，后接其他汉字的乱码字节就报错）——
      // 也就是说这是"看运气"的隐患，不是必然发生，但一旦发生在 rebuild 里代价很大：
      // syntaxCheckBundles 抛错 -> 整个重建作废（连 webview 15 条解锁一起丢），与 §4.1「net 补丁失配不阻断
      // 重建」的意图相反。core 目前是干净的（实测 0 个非 ASCII），但那是靠人记得；这里做一次廉价自检，
      // 把"整轮重建被一个注释里的汉字搞挂"降级成"只跳过 net 补丁、webview 照常"。
      const nonAscii = [...core.NET_INJECT_SRC].filter(c => c.charCodeAt(0) > 127).length;
      if (nonAscii > 0) {
        NET_STATE.patch = {
          located: true, applied: false, actual: netApp.actual, rel: netDoc.rel,
          present: false,
          reason: 'core.NET_INJECT_SRC 含 ' + nonAscii + ' 个非 ASCII 字符（注入函数体里混进了中文注释？）',
        };
        log('警告: 注入函数源码含非 ASCII 字符（' + nonAscii + ' 个），跳过 net 补丁以免整轮重建失败；'
          + '该版本的 401/Ultrafast 修复不可用（webview 解锁不受影响）');
      } else {
        content.set(netDoc.rel, netApp.text);
        log('已为主进程补上 401/Ultrafast 修复补丁:', netDoc.rel);
      }
    } else if (netDoc) {
      log('警告: 主进程 app-server 启动参数代码形态与预期不符（命中 ' + netApp.actual + ' 处），跳过 net 补丁；'
        + '该版本的 401/Ultrafast 修复不可用（webview 解锁不受影响）');
    } else {
      log('警告: 该版本找不到 app-server 启动参数代码，401/Ultrafast 修复不可用（webview 解锁不受影响）');
    }

    // 语法校验（失败时保留 patched-bundles 便于排查，通过后删掉）——"实际要写入的内容"过 node --check 才算数
    // core.runCaptured 的输出临时文件在 os.tmpdir() 下，且不会创建该目录；TEMP 被清掉时先兜底建好
    try { fs.mkdirSync(os.tmpdir(), { recursive: true }); } catch (e) {}
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

  // 5) 回填主程序内嵌的 asar 校验哈希（owl 校验的是 header JSON 的 SHA256）
  const headerHash = core.sha256Hex(jsonBuf);
  const exes = [...new Set([inst.mainExe, 'ChatGPT.exe', 'Codex.exe'])];
  for (const exe of exes) {
    const p = STAGING + '/' + exe;
    if (!fs.existsSync(p)) { log('跳过', exe, '（镜像里不存在）'); continue; }
    const result = patchExeHash(p, headerHash);
    log('校验哈希回填', exe, '->', result);
    if (exe === inst.mainExe) {
      if (result === 'BAD_HEX') throw new Error(exe + ' 内嵌哈希格式异常（BAD_HEX），无法回填');
      if (result === 'NO_PAYLOAD') log('警告: ' + exe + ' 里没有内嵌 asar 校验哈希（该版本未启用完整性校验），跳过回填');
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

// 优先启动解锁镜像；镜像不可用时退回原版，保证总能打开。返回是否启动了解锁版
function launch(inst) {
  if (mirrorUsable()) {
    const exe = MIRROR + '/' + (STATE.mainExe || 'ChatGPT.exe');
    log('启动解锁镜像', (STATE.mainExe || 'ChatGPT.exe'), '...');
    spawn(win(exe), [], { detached: true, stdio: 'ignore', cwd: win(MIRROR) }).unref();
    return true;
  }
  if (!inst) { log('镜像不可用且没有可用的 Codex 安装，无法启动'); return false; }
  if (inst.source === 'store' && inst.aumid) {
    log('解锁镜像不可用，已改为打开商店原版（未解锁）:', inst.aumid);
    spawn('explorer.exe', ['shell:AppsFolder\\' + inst.aumid], { detached: true, stdio: 'ignore' }).unref();
    return false;
  }
  const exe = path.join(inst.appDir, inst.mainExe);
  if (!fs.existsSync(exe)) { log('原版主程序不存在，无法启动:', exe); return false; }
  log('解锁镜像不可用，已改为打开原版（未解锁）:', win(exe));
  spawn(win(exe), [], { detached: true, stdio: 'ignore', cwd: inst.appDir }).unref();
  return false;
}

// ---------- §9 机器可读报告（CODEX_LAUNCHER_REPORT 存在时才写；e2e 断言用） ----------
// 字段名按规格 §10.10 冻结：net = { patch:{located,applied,actual,rel}, overrides, diagnosis }；
// timing = { discovery:'cache'|'full'|'manual', discoveryMs, preLaunchMs, totalMs }
const REPORT = {
  reportVersion: 1, mode: null, exitCode: null, selected: null, candidates: [],
  patch: null, dryRunOk: null, net: null, timing: null, shortcuts: [], errors: [],
};
// 计时起点：--dry-run / --self-test / --create-shortcut 也会记，便于对照
const PROC_START = Date.now();
// 网络修复的原始结论，由 rebuild 与 runOnce 各自写入，writeReport 汇总成 REPORT.net。
// 注意 diagnosis 在报告里只放**判定码字符串**（§5.1 冻结形态 diagnosis: string|null，e2e 按字符串断言）；
// 完整的 {provider,diagnosis} 只在运行内部使用（日志文案与覆盖文件的 auth 字段）
const NET_STATE = { patch: null, overrides: null, diagnosis: null };
const selReport = inst => (inst ? { source: inst.source, appDir: win(inst.appDir), mainExe: inst.mainExe, version: inst.version } : null);
// results 每项 { note, ok, expect, actual, group, variant }；variants 只记命中项（主定义 0）
function patchReportFrom(r) {
  const variants = {};
  for (const x of r.results) if (x.ok) variants[x.note] = typeof x.variant === 'number' ? x.variant : 0;
  return {
    total: r.results.length,
    ok: r.results.filter(x => x.ok).length,
    failCount: r.failCount,
    partial: !!r.partial,
    skippedGroups: r.skippedGroups || [],
    variants,
  };
}
function writeReport(code) {
  if (!REPORT_FILE) return;
  REPORT.exitCode = typeof code === 'number' ? code : (process.exitCode == null ? 0 : process.exitCode);
  if (NET_STATE.patch || NET_STATE.overrides || NET_STATE.diagnosis) {
    // diagnosis 只放判定码字符串（§5.1 冻结形态 string|null；e2e 的用例 D 按字符串断言判定码）。
    // 这里再做一层归一化：任何调用方误把 decideAuthOverride 的整个对象塞进 NET_STATE.diagnosis，
    // 写报告时也只落字符串——e2e 读的是落盘后的报告，它那条 typeof===string 断言因此**看不出**这个漂移
    // （归一化已经把它抹平了），所以漂移只能在源头发现：这里打一行告警 + test/net-override-test.js 的形态断言
    const d = NET_STATE.diagnosis;
    if (d && typeof d === 'object') log('警告: REPORT.net.diagnosis 形态漂移（收到对象，已按 §5.1 只取判定码字符串落盘）；请检查 codex-launcher.js 的两处赋值是否被改回 diag 整体');
    const diagCode = d && typeof d === 'object' ? d.diagnosis : d;
    REPORT.net = { patch: NET_STATE.patch, overrides: NET_STATE.overrides, diagnosis: diagCode == null ? null : diagCode };
  }
  if (REPORT.timing) REPORT.timing.totalMs = Date.now() - PROC_START; // 报告写出前结算总耗时
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(REPORT, null, 2));
}
// 报告里 candidates 用 { source, path, version, ok, reason }（字段缺失用 null，不省略键）
function reportCandidates(cands) {
  REPORT.candidates = cands.map(c => ({
    source: c.source, path: c.ok ? win(c.appDir) : win(c.path),
    version: c.version === undefined ? null : c.version, ok: !!c.ok, reason: c.reason || null,
  }));
}

// ---------- --self-test：严格只读（不建 MIRROR_ROOT、不删 Zone.Identifier、不建锁、不写状态、不碰快捷方式） ----------
// 可写性用 fs.accessSync 判断，不真写；补丁试跑只在内存里做（locateBundles + applyPatchSet）
function selfTest(opts) {
  log('== 自检（只读）==');
  log('node:', process.execPath, process.version);
  const rootParent = (() => { let d = path.resolve(MIRROR_ROOT); while (!fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; } return d; })();
  let writable = false;
  try { fs.accessSync(rootParent, fs.constants.W_OK); writable = true; } catch (e) {}
  log('HOME:', HOME);
  log('MIRROR_ROOT:', win(MIRROR_ROOT), '->', fs.existsSync(MIRROR_ROOT) ? '已存在' : '不存在（首次运行会创建）', '，所在目录可写:', writable ? '是' : '否');
  const free = freeBytesNear(MIRROR_ROOT);
  log('剩余空间:', free == null ? '无法获取' : fmtGB(free));
  let psOk = false;
  try { runPowershell('Write-Output ok'); psOk = true; } catch (e) {}
  log('PowerShell:', psOk ? '可用' : '不可用（将退回 reg.exe + 文件系统扫描）');

  log('检测 Codex 安装 ...');
  const cands = discoverInstalls({ appDir: opts.appDir });
  reportCandidates(cands);
  printCandidates(cands);
  // 与 runOnce 同一规则：显式指定的安装目录（--app-dir= / CODEX_APP_DIR）不可用时
  // 不静默改用其它安装（自检要如实反映"指定的目录有问题"）
  const explicit = explicitAppDir(opts);
  if (explicit.value) {
    const m = cands.find(c => c.source === 'manual');
    if (!m || !m.ok) {
      const srcZh = explicit.source === 'cli' ? '--app-dir' : '环境变量 CODEX_APP_DIR';
      log('指定的安装目录不可用（' + srcZh + '）:', win(explicit.value) + (m && m.reason ? '（' + m.reason + '）' : ''));
      log('请检查路径是否正确；路径里不要包含 & 等 cmd 特殊字符（命令行会把它们拆断），也可以改用环境变量 CODEX_APP_DIR 指定');
      return 1;
    }
  } else if (STATE.installOverride) {
    // 同 runOnce：状态里的历史记录失效只提示、不拦
    const m = cands.find(c => c.source === 'manual');
    if (!m || !m.ok) log('提示: 状态里记住的安装目录已失效（' + win(STATE.installOverride) + (m && m.reason ? '，' + m.reason : '') + '），本次改用其它来源；不再需要时可用 --app-dir= 清除记录');
  }
  const inst = pickInstall(cands);
  REPORT.selected = selReport(inst);
  if (!inst) {
    log('没有可用的 Codex 安装。请安装微软商店版或官网版 Codex；装在自定义位置时用 --app-dir=目录 指定');
    return 1;
  }
  log('选中:', inst.label, '->', inst.appDir, ' 主程序:', inst.mainExe, inst.source === 'store' ? '（AUMID: ' + inst.aumid + '）' : '');

  // 镜像状态摘要
  log('镜像:', fs.existsSync(MIRROR) ? '已存在' : '不存在', win(MIRROR));
  log('镜像可用:', mirrorUsable() ? '是' : '否');
  const keys = Object.keys(STATE);
  log('状态文件:', keys.length ? win(STATE_FILE) + ' -> ' + JSON.stringify(STATE).slice(0, 300) : '（无）');
  log('补丁集版本: 当前代码 ' + PATCH_SET_VERSION + '，状态文件 ' + (STATE.patchSetVersion || '无'));

  // 快捷方式状态（只读检查）
  const targets = shortcutTargets();
  for (const t of targets) log('快捷方式:', win(lnkPath(t.path)), fs.existsSync(lnkPath(t.path)) ? '存在' : '不存在');
  if (!targets.length) log('快捷方式: 无法确定桌面/开始菜单目录（受限环境）');
  log('状态记录 shortcutsCreated:', STATE.shortcutsCreated ? '是' : '否');

  // 镜像里的主进程 net 补丁（只读；镜像不存在时跳过）
  NET_STATE.patch = netPatchState();
  log('网络修复补丁:', netPatchStateText());

  // 网络诊断（只读 config.toml / auth.json，只打印键名与布尔，绝不打印任何 key/token）
  const diag = readDiagnosis();
  NET_STATE.diagnosis = diag.diagnosis; // 报告里只放字符串（§5.1：diagnosis: string|null）
  const top = readTopLevel(readFileSafe(CODEX_CONFIG));
  const info = diag.provider ? providerTableInfo(readFileSafe(CODEX_CONFIG), diag.provider) : null;
  const authJson = readJsonSafe(path.join(CODEX_HOME_DIR(), 'auth.json'));
  log('网络诊断（只读）:');
  log('  config.toml:', win(CODEX_CONFIG), fs.existsSync(CODEX_CONFIG) ? '' : '（不存在）');
  log('  model_provider:', top.modelProvider || '（未设置）', ' model:', top.model || '（未设置）');
  if (info) log('  供应商表 [model_providers.' + diag.provider + ']:', info.found ? '存在' : '不存在',
    ' requires_openai_auth:', String(info.requiresOpenaiAuth), ' 自带 bearer:', info.hasBearer ? '有' : '没有',
    ' base_url 主机:', info.baseUrlHost || '（无法解析）');
  log('  auth.json 有 OPENAI_API_KEY:', authJson && typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY.trim() ? '有' : '没有',
    ' 有 tokens（官方登录）:', authJson && authJson.tokens ? '有' : '没有');
  log('  诊断结果:', diag.diagnosis, '-', diagnosisText(diag.diagnosis, diag.provider));
  // v13 遗留悬空行的只读体检（诊断报告.bat 走 --self-test，用户求助时能看到这一条）
  const stDangling = danglingCatalogRef(readFileSafe(CODEX_CONFIG));
  if (stDangling) {
    log('  警告: config.toml 里的 model_catalog_json 指向的文件不存在:', win(stDangling));
    log('    直接读这份 config 的 codex 新建对话会报「系统找不到指定的文件」(os error 2)；'
      + '解锁版的目录覆盖在位时能盖住，但建议删掉那一行（v14 不再需要）或恢复文件');
  }

  // 合并目录会包含多少个带 ultrafast 的模型：只读地跑一次 codex.exe，临时 CODEX_HOME 建在镜像根下并删除
  const catalog = selfTestCatalog();
  const over = buildOverrides({
    catalogPath: catalog.ok ? MERGED_CATALOG : null,
    auth: diag.provider ? { provider: diag.provider } : null,
  });
  NET_STATE.overrides = over; // 报告里填"会写入的内容"，不实际写
  log('  合并目录（会写入的覆盖）:', over.catalog ? win(over.catalog) + '，含 ' + catalog.ultrafast + ' 个带 Ultrafast 档的模型' : '不启用（' + (catalog.reason || '不可用') + '）');
  log('  覆盖文件:', win(OVERRIDES_FILE), '->', JSON.stringify(over));

  // 补丁试跑（内存内，不写文件）
  log('补丁试跑（内存内，不写文件）...');
  let trial = null;
  try { trial = patchTrial(inst); }
  catch (e) { log('补丁试跑失败:', e.message); return 1; }
  REPORT.patch = patchReportFrom(trial);
  for (const x of trial.results) {
    if (x.ok) log(`  OK   ${x.note}` + (x.variant ? `（变体 ${x.variant}）` : ''));
    else log(`  FAIL ${x.note}: 期望 ${x.expect} 处，实际 ${x.actual} 处`);
  }
  const skipped = (trial.skippedGroups || []).filter(Boolean);
  // 按 §10.2 冻结的 core 语义：partial=true 时 failCount===0（只统计已应用组内的未命中），
  // 失配组整组跳过；所有组都被跳过时 failCount=未命中总数、partial=false。先判失败再判部分解锁。
  if (trial.failCount > 0) {
    log(`补丁试跑失败: ${trial.failCount} 处未命中，该版本可能不兼容`);
    return 1;
  }
  if (trial.partial && skipped.length) {
    const applied = trial.results.filter(x => x.ok && !skipped.includes(x.group)).length;
    log(`补丁试跑: 可部分解锁——${skipped.map(g => GROUP_ZH[g] || g).join('、')} 组未命中（保持未解锁），其余已应用 ${applied}/${trial.results.length} 条`);
    return 0;
  }
  log(`补丁试跑通过: ${REPORT.patch.ok}/${REPORT.patch.total} 全部命中`);
  return 0;
}
// 内存内试跑：定位 bundle -> applyPatchSet(allowPartial)。locateBundles 的 fd 用完即关
function patchTrial(inst) {
  const loc = core.locateBundles(path.join(inst.appDir, 'resources', 'app.asar'));
  try {
    for (const [k, e] of Object.entries(loc.role)) if (!e) throw new Error('无法定位 bundle: ' + k);
    const content = new Map();
    for (const e of Object.values(loc.role)) content.set(e.rel, loc.text(e));
    const r = core.applyPatchSet(content, loc.role, { allowPartial: true });
    return { failCount: r.failCount, results: r.results, partial: !!r.partial, skippedGroups: r.skippedGroups || [] };
  } finally {
    fs.closeSync(loc.fd);
  }
}
const readFileSafe = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const readJsonSafe = p => { try { return JSON.parse(readFileSafe(p)); } catch (e) { return null; } };
// 镜像里有没有 net 补丁（只读：定位 bundle -> hasNetPatch）。返回可读文本，供 self-test 与报告用。
// 用 readAsar + locateNetBundle（实测 57~67ms）而不是 locateBundles（要扫 1.4 万个 webview 文件，实测约 1s）——
// 后者会把第二次启动的 preLaunchMs 顶到 1s 以上，正是要修掉的"第二次启动还是慢"的一部分
function netPatchState() {
  const asar = MIRROR + '/resources/app.asar';
  if (!fs.existsSync(asar)) return { located: false, applied: false, actual: 0, rel: null, present: false, reason: '镜像不存在' };
  let fd = null;
  try {
    const a = core.readAsar(asar);
    fd = fs.openSync(asar, 'r');
    const doc = core.locateNetBundle(a.header, a.dataBase, fd);
    if (!doc) return { located: false, applied: false, actual: 0, rel: null, present: false, reason: '找不到 app-server 启动参数代码' };
    const present = core.hasNetPatch(doc.text);
    return { located: true, applied: present, actual: present ? 1 : 0, rel: doc.rel, present, reason: null };
  } catch (e) {
    return { located: false, applied: false, actual: 0, rel: null, present: false, reason: e.message };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}
function netPatchStateText() {
  const s = netPatchState();
  if (!fs.existsSync(MIRROR + '/resources/app.asar')) return '镜像还没有构建（下次正常启动会生成）';
  if (s.present) return '镜像已包含 401/Ultrafast 修复补丁 (' + s.rel + ')';
  return '镜像还没有 v14 修复（下次正常启动会自动重建）' + (s.reason ? '：' + s.reason : '');
}
// self-test 专用：只读地跑一次 codex.exe 生成合并目录（在内存里），临时 CODEX_HOME 建在镜像根下、结束删除；
// 不写 model-catalog-merged.json、不碰真实 ~/.codex（规格 §10.5：CODEX_HOME 放 %TEMP% 会污染输出）
function selfTestCatalog() {
  const codexExe = MIRROR + '/resources/codex.exe';
  if (!fs.existsSync(codexExe)) return { ok: false, ultrafast: 0, reason: '镜像里没有 codex.exe' };
  try {
    const merged = mergeCatalogs(codexBundledCatalog(codexExe), catalogExtras(readFileSafe(CODEX_CONFIG)));
    const ultrafast = merged.models.filter(m => (m.service_tiers || []).some(t => t && t.id === 'ultrafast')).length;
    return { ok: true, ultrafast, models: merged.models.length, reason: null };
  } catch (e) {
    return { ok: false, ultrafast: 0, reason: (e.stderr || e.message || '').toString().trim().split('\n').pop() };
  }
}

// ---------- --create-shortcut：只创建/刷新快捷方式，然后退出（不重建、不启动、不建锁） ----------
// "bat 在临时目录"（os.tmpdir() 之下或含 Temp1_）的判断统一在 createShortcuts 里做——普通模式的自动创建
// 与 --create-shortcut 共用同一规则（e2e 沙箱让 TEMP 指向不含发行包解压目录的子目录即可避开该规则）；
// 镜像未构建也能工作（图标从选中安装的 resources 复制）
function createShortcutMode(opts) {
  log('创建/刷新快捷方式 ...');
  // 找选中安装只为取图标：--app-dir 有效时 discoverInstalls 会在 manual 候选上短路（不跑 PowerShell，
  // 规格 §10.7）；没给 --app-dir 时退回常规发现（NO_STORE+NO_EXTERNAL 下同样不调 PowerShell）
  const cands = discoverInstalls({ appDir: opts.appDir });
  const inst = pickInstall(cands);
  REPORT.selected = selReport(inst);
  if (inst) log('快捷方式图标来源:', inst.appDir);
  else log('未找到 Codex 安装，快捷方式图标回退使用镜像/主程序');
  const made = createShortcuts(inst);
  REPORT.shortcuts.push(...made);
  for (const r of made) log('快捷方式:', r.path, '->', r.action, r.reason ? '(' + r.reason + ')' : '');
  if (!made.some(r => r.action === 'created')) {
    log('快捷方式未创建（原因见上面一行）');
    return 1;
  }
  STATE.shortcutsCreated = true;
  STATE.shortcutBat = ENTRY_PATH;
  writeState(STATE);
  log('完成。以后双击桌面/开始菜单里的「Codex 解锁版」即可启动');
  return 0;
}

// ---------- 主流程 ----------
let OPTS = null; // parseArgs 结果（exit 钩子判断模式用）
let MODE = null;
let SELECTED = null; // 选中的安装（出错回退启动原版时用）

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) {
    console.error('[launcher] 参数错误:', e.message);
    REPORT.errors.push(e.message);
    process.exitCode = 1;
    return;
  }
  OPTS = opts;
  MODE = opts.mode;
  REPORT.mode = opts.mode;
  loadState();

  if (opts.mode === 'self-test') { process.exitCode = selfTest(opts); return; }
  if (opts.mode === 'create-shortcut') { process.exitCode = createShortcutMode(opts); return; }

  // --create-shortcut 也要计时报告（统一界面；e2e 只读它关心的字段）
  REPORT.timing = { discovery: null, discoveryMs: null, preLaunchMs: null, totalMs: null };

  const dryRun = opts.mode === 'dry-run';
  if (!dryRun) clearZoneIdentifiers(); // 清除启动器自身文件的下载标记（--self-test/--dry-run 不碰；失败忽略）

  // 单实例锁：普通模式与 --dry-run 建锁；--self-test / --create-shortcut 不建锁、不受锁影响
  if (!acquireLock()) {
    log('另一个启动器正在运行（可能正在首次生成解锁版），请等它结束（约 1~2 分钟）后再试');
    process.exitCode = 2;
    return;
  }
  try {
    await runOnce(opts, dryRun);
  } finally {
    removeLock();
  }
}

async function runOnce(opts, dryRun) {
  // 快路径（规格 §5.6）：状态里有缓存、开关没变、目录仍可用且没出现新版本 -> 跳过整个 PowerShell 发现段（1.6~2s）。
  // 只有普通模式、没有手动指定目录（--app-dir / CODEX_APP_DIR / 状态里的 installOverride）时才走快路径；
  // manual 本来就只检查一个目录，走原逻辑（manual 候选 ok 时 discoverInstalls 也会短路掉 PowerShell）
  // 快路径（规格 §5.6）：状态里有缓存、开关没变、目录仍可用且没出现新版本 -> 跳过整个 PowerShell 发现段（1.6~2s）。
  // 只有不带 --app-dir 且状态里没有手动目录记录时才有意义——manual 本来就只检查一个目录，
  // 而且 manual 候选 ok 时 discoverInstalls 内部也会短路掉 PowerShell（规格 §10.7）。
  // 状态里 installOverride 的清理动作在下面（先手动校验再清理），这里照它当时的取值判断
  const tDiscovery0 = Date.now();
  log('检测 Codex 安装 ...');
  let discoveryMode = 'full';
  let cacheRec = null;
  if (!dryRun && opts.appDir === undefined && !APP_DIR_ENV && !STATE.installOverride) {
    const hit = tryCachedInstall(STATE);
    if (hit.ok) { cacheRec = hit.rec; discoveryMode = 'cache'; }
  }
  let cands;
  if (cacheRec) {
    log('使用上次的安装信息（' + cacheRec.label + '），跳过完整检测');
    cands = [cacheRec];
  } else {
    cands = discoverInstalls({ appDir: opts.appDir });
    if (cands.some(c => c.ok && c.source === 'manual')) discoveryMode = 'manual';
  }
  REPORT.timing = { discovery: discoveryMode, discoveryMs: Date.now() - tDiscovery0, preLaunchMs: null, totalMs: null };
  reportCandidates(cands);
  printCandidates(cands);
  // 显式指定的安装目录（--app-dir= / CODEX_APP_DIR）校验失败 -> 直接退出，不静默改用其它安装：
  // cmd 把 bat 行再解析一遍时，未加引号的值会在 & / 空格处被拆断（实测），若静默回退，
  // 用户以为指定生效，实际却用别的安装重建镜像、甚至进入普通模式启动。
  // 状态文件里的 installOverride 是历史记录，失效时只在下面提示、不拦启动
  const explicit = explicitAppDir(opts);
  if (explicit.value) {
    const m = cands.find(c => c.source === 'manual');
    if (!m || !m.ok) {
      const srcZh = explicit.source === 'cli' ? '--app-dir' : '环境变量 CODEX_APP_DIR';
      log('指定的安装目录不可用（' + srcZh + '）:', win(explicit.value) + (m && m.reason ? '（' + m.reason + '）' : ''));
      log('请检查路径是否正确；路径里不要包含 & 等 cmd 特殊字符（命令行会把它们拆断），也可以改用环境变量 CODEX_APP_DIR 指定');
      process.exitCode = 1;
      return;
    }
  } else if (explicit.source !== 'clear' && STATE.installOverride) {
    // 状态里记住的目录失效（被移动/卸载）：提示但照常继续，不拦启动——它不是本次的显式指定
    const m = cands.find(c => c.source === 'manual');
    if (!m || !m.ok) log('提示: 状态里记住的安装目录已失效（' + win(STATE.installOverride) + (m && m.reason ? '，' + m.reason : '') + '），本次改用其它来源；不再需要时可用 --app-dir= 清除记录');
  }
  const inst = pickInstall(cands);
  SELECTED = inst;
  REPORT.selected = selReport(inst);
  if (!inst) {
    log('没有找到可用的 Codex 安装。请先从微软商店安装，或安装官网下载的 Codex；装在自定义位置时用 --app-dir=目录 指定（详见使用说明.txt）');
    process.exitCode = 1;
    return;
  }
  log('选中:', inst.label, '->', inst.appDir, ' 主程序:', inst.mainExe);
  if (PS_ADMIN === true) log('警告: 当前以管理员身份运行。本启动器不需要管理员权限，建议改用普通用户运行（用管理员会把镜像建到管理员的用户目录）');

  // 手动指定成功 -> 记入状态 installOverride，以后自动使用；--app-dir=（空）清除。--self-test 不写状态
  if (MODE === 'normal' && opts.appDir !== undefined) {
    if (opts.appDir === '') {
      if (STATE.installOverride) { delete STATE.installOverride; writeState(STATE); log('已清除手动指定的安装目录记录'); }
    } else if (inst.source === 'manual' && STATE.installOverride !== win(inst.appDir)) {
      STATE.installOverride = win(inst.appDir);
      writeState(STATE);
      log('已记住手动指定的安装目录:', win(inst.appDir));
    }
  }

  // 快速指纹：fastKey 命中才复用旧 sha256，否则重算（复用规则见 resolveFingerprint 注释）
  const asarPath = inst.appDir + '/resources/app.asar';
  const fk = fastKeyOf(asarPath);
  const { fp, reused: reuse } = resolveFingerprint(STATE, fk, () => sha256File(asarPath));
  log('版本指纹:', fp.slice(0, 12) + '...', reuse ? '（未变化，复用缓存）' : '（已重新计算）');

  const needRebuild = !mirrorUsable() || STATE.storeFingerprint !== fp || STATE.patchSetVersion !== PATCH_SET_VERSION;
  // 同一版本 + 同一补丁集已失败过：不再每次启动都重新拷贝几百 MB
  const knownBad = STATE.failedFingerprint === fp && STATE.failedPatchSet === PATCH_SET_VERSION;

  let rebuiltOk = false;
  // 需要重建但没做成（补丁失配/空间不足/正在运行/重建抛错）时置 true：这些情况都有给用户看的
  // 中文提示，但镜像可能仍可用、launch() 会成功，若不给退出码，bat 会以 0 退出、窗口一闪而过，
  // 用户既看不到"重建失败"也看不到原因。按 §5.5 约定用退出码 2（需要用户看一眼的提示）
  let rebuildNotified = false;
  if (!needRebuild && !dryRun) {
    log('解锁镜像已是最新（', inst.version || '未知版本', '），直接启动');
  } else if (knownBad && !opts.force) {
    log('该版本此前重建失败（', STATE.failedReason, '），跳过重建；更新补丁后用 --force 重试');
    rebuildNotified = true;
  } else {
    log('需要重建解锁镜像（安装更新或补丁集变化）...');
    const free = freeBytesNear(MIRROR_ROOT);
    if (free != null && free < MIN_FREE_BYTES) {
      // 空间不足按"偶发错误"处理：不记 knownBad，下次启动照常重试
      log(`磁盘剩余空间不足 5GB（还剩 ${fmtGB(free)}），无法重建镜像，请清理磁盘后重试`);
      rebuildNotified = true;
    } else {
      const mirrorRunning = pidsUnder(MIRROR_ROOT).length > 0;
      // 从资源目录（junction 指向镜像）跑起来的进程会锁住镜像目录，换镜像必然失败
      const resRunning = !!RES_LINK && pidsUnder(RES_LINK).length > 0;

      // 资源目录里的进程可能属于原版，不能替用户结束，--no-launch 也只能跳过
      if (!dryRun && (resRunning || (mirrorRunning && !opts.noLaunch))) {
        log('Codex 正在运行，跳过更新（请完全退出 Codex 后重新运行启动器以应用更新）');
        rebuildNotified = true;
      } else {
        if (mirrorRunning && !dryRun) killApp();
        await sleep(800);
        if (!fs.existsSync(MIRROR)) log('第一次生成解锁版大约需要 1~2 分钟（要拷贝约 2GB 文件），请不要关闭窗口 ...');
        try {
          rebuild(inst, { dryRun });
          rebuiltOk = true;
          if (!dryRun) {
            // 成功才记录新指纹；同时清掉旧的失败记录
            const s = {
              ...STATE,
              storeVersion: inst.source === 'store' ? path.basename(inst.root) : (inst.version || inst.label),
              storeFingerprint: fp,
              patchSetVersion: PATCH_SET_VERSION,
              failedPatches: 0,
              updatedAt: new Date().toISOString(),
              installSource: inst.source,
              installPath: win(inst.appDir),
              appVersion: inst.version,
              mainExe: inst.mainExe,
              fastKey: fk,
              fastFingerprint: fp, // 与 fastKey 配对；失败记账时 storeFingerprint 不变，靠它保证失败版本能被认出来
              partialGroups: REPORT.patch ? REPORT.patch.skippedGroups : [],
              netPatched: !!(NET_STATE.patch && NET_STATE.patch.applied),
            };
            delete s.catalogFingerprint; // v13 的目录指纹字段，v14 用 catalogKey（下次启动重新生成一次即可）
            for (const k of ['failedStoreVersion', 'failedFingerprint', 'failedPatchSet', 'failedReason', 'failedAt']) delete s[k];
            writeState(s);
          }
        } catch (e) {
          try { fs.rmSync(MIRROR + '.staging', { recursive: true, force: true }); } catch (_) {}
          // 文件占用/拷贝出错（带 code 或进程退出码）属于偶发，下次启动照常重试；只有补丁失配这类确定性失败才记账
          const transient = e.code != null || e.status != null;
          log('重建失败' + (transient ? '（偶发错误，下次启动重试）' : '') + ':', e.message);
          REPORT.errors.push('重建失败: ' + e.message);
          rebuildNotified = true; // 有用户要看的失败原因，退出码按"需要看一眼"处理
          if (!transient && !dryRun) {
            // 保留上次成功的指纹，只追加失败记录；fastKey/fastFingerprint 一起更新，
            // 这样下次启动复用到的 fp 就是本次失败版本的新哈希，knownBad 才能命中
            writeState({
              ...STATE, fastKey: fk, fastFingerprint: fp,
              failedStoreVersion: inst.source === 'store' ? path.basename(inst.root) : inst.label,
              failedFingerprint: fp, failedPatchSet: PATCH_SET_VERSION,
              failedReason: e.message, failedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  if (dryRun) {
    REPORT.dryRunOk = rebuiltOk;
    if (!rebuiltOk) process.exitCode = 1;
    return;
  }

  // ---- 启动前的网络修复准备（规格 §5.4 步骤 2）：镜像可用时写合并目录 + 覆盖文件；不可用就不写 ----
  // 顺序：先诊断（只读 config.toml / auth.json，不打印任何 key）-> 合并目录 -> 覆盖文件 -> 资源同步
  let catalog = { ok: false, path: null, models: 0, ultrafast: 0 };
  if (mirrorUsable()) {
    // 只有"本次重建真的把镜像换掉了"才保留 rebuild 里的 net 结论（它描述的就是刚装上的镜像）。
    // 其余情况（镜像已是最新、重建失败保留了旧镜像）都必须重新只读探测当前镜像——重建在写入阶段抛错时
    // （语法校验/重打包/回填哈希失败），rebuild 里记下的结论描述的是那个没装上的 staging，会与真实镜像不符
    if (!rebuiltOk) NET_STATE.patch = netPatchState(); // 只读，约 25ms
    catalog = ensureMergedCatalog(inst);
    const diag = readDiagnosis();
    NET_STATE.diagnosis = diag.diagnosis; // §5.1：report 里只放字符串
    const applied = applyOverrides(catalog, diag);
    NET_STATE.overrides = applied.over;
    writeState(STATE); // catalogKey 由 ensureMergedCatalog 写进 STATE
    // 两条提示各用一个"已提示过"的键（同一 config.toml 只提示一次，避免每次启动刷屏）。
    // 不能用同一个键——否则先出现"换供应商"提示后，后来真的变成 direct-no-credential 时，根治提示就不出来了。
    // 两条都要写状态，所以先判定、统一在末尾写一次（writeState 内部有内容比对，不变就不落盘）
    const cfgKey = win(CODEX_CONFIG);
    const wantRootHint = diag.diagnosis === 'direct-no-credential' && STATE.authWarnedFor !== cfgKey;
    // 换供应商的提示（第 1 轮审查发现）：覆盖参数在"拉起 app-server 的那一刻"按当时的 model_provider 算一次
    // 并固定下来（规格 §1.2 实测），而 codex 每个新会话重读 config.toml。所以启动时是 A（无凭据、被修）、
    // 会话中途在 cc-switch 里换成**另一个同样没填 Key** 的供应商 B 时，新开的会话带的是"为 A 写的那条覆盖"，
    // B 拿不到任何凭据 -> 用户最初那个 401 原样复现（实测：启动 custom -> 中途换 other，注入产物只剩
    // model_providers.custom.requires_openai_auth=true，other 没有覆盖）。这不是 launcher 能修的事
    // （覆盖是启动时定死的），所以明确告诉用户重开一次解锁版让它按新配置重算。
    const wantSwitchHint = !!(applied.over && applied.over.auth) && STATE.switchWarnedFor !== cfgKey;
    if (wantRootHint || wantSwitchHint) {
      if (wantRootHint) { STATE.authWarnedFor = cfgKey; log('根治方法（可选）: 在 cc-switch 里编辑该供应商，把 config.toml 里的 requires_openai_auth = false 改成 true'); }
      if (wantSwitchHint) { STATE.switchWarnedFor = cfgKey; log('提示: 如果在 cc-switch 里换成另一个同样没填 Key 的供应商，新开的对话可能再报 401 —— 重新运行一次解锁版即可（鉴权覆盖在启动时按当时的供应商生成）'); }
      writeState(STATE);
    }
  } else {
    log('解锁镜像不可用，跳过模型目录/覆盖文件（网络修复不生效）');
  }

  // v13 遗留的悬空 model_catalog_json（第 3 轮审查发现，已实测复现）：那一行指向的文件被删掉后，
  // 读这份 config.toml 的 codex 会在**每个新会话**失败（thread/start 返回 failed to load configuration,
  // os error 2）。解锁版自己的 -c model_catalog_json 覆盖在位时能盖住；其它直接读这份 config 的客户端
  // （VS Code 扩展等）盖不住。这里只读检测 + 中文告警，绝不改 config.toml（§4.4 的承诺）。
  // 提示频率分两档：目录覆盖不在位 = 用户的 Codex 每次新建对话都会失败（硬故障），每次启动都要提示；
  // 覆盖在位 = 只影响其它客户端（软故障），同一 config + 同一路径只提示一次，避免每次启动刷屏。
  // 退出码 2 只在硬故障时置位（§5.5：这类提示必须让用户看见，否则 bat 窗口一闪而过）
  const danglingPath = danglingCatalogRef(readFileSafe(CODEX_CONFIG));
  let danglingCritical = false;
  if (danglingPath) {
    // "覆盖在位"的准确含义：本次真的写了覆盖文件、里面指向存在的合并目录，且镜像的 net 补丁在位
    // （注入函数在拉起 app-server 时会读这份覆盖文件把 -c 推上去）
    const severity = danglingCatalogSeverity(NET_STATE.overrides, NET_STATE.patch);
    danglingCritical = severity === 'critical';
    const dk = win(CODEX_CONFIG) + '|' + win(danglingPath) + '|' + severity;
    // 硬故障每次启动都提示（用户每次新建对话都会失败）；软故障同一 config + 同一路径只提示一次，避免刷屏
    if (danglingCritical || STATE.catalogDanglingWarnedFor !== dk) {
      STATE.catalogDanglingWarnedFor = dk;
      writeState(STATE);
      log('警告: config.toml 里的 model_catalog_json 指向的文件不存在:', win(danglingPath));
      if (danglingCritical) {
        log('  目录覆盖当前不在位：Codex 的新建对话会直接失败（报「系统找不到指定的文件」，os error 2）');
      } else {
        log('  通过解锁版启动的 Codex 不受影响（目录覆盖在位）；但其它直接读这份 config 的客户端（如 VS Code 扩展）新建对话时会报同样的错');
      }
      log('  建议删掉 config.toml 里那一行（v14 不再需要它），或把文件恢复回来');
    }
  }
  try { syncResources(); } catch (e) { log('资源目录同步出错:', e.message); }

  // ---- 启动：先发起"原版是否在运行"的异步检查，再立刻 launch（规格 §5.4 步骤 3） ----
  let launched = false, originalRunning = false;
  const check = opts.noLaunch ? null : startOriginalProcessCheck(inst);
  const tPreLaunch = Date.now();
  REPORT.timing.preLaunchMs = tPreLaunch - PROC_START;
  if (!opts.noLaunch) {
    launched = launch(inst);
    if (!launched) process.exitCode = 1;
  }
  // launch 之后再最多等 3 秒拿结果；拿不到就当"不知道"（不提示、不因此置退出码 2）
  const running = await awaitOriginalCheck(check);
  if (running && running.length) {
    originalRunning = true;
    if (mirrorUsable()) {
      log('提示: 原版 Codex 正在运行。如果解锁版窗口没有出现，请先在任务栏右下角托盘里右键彻底退出 Codex，再重新运行启动器');
    }
  }
  if (opts.noLaunch) {
    // --no-launch：没有启动动作，但上面有需要用户看的中文提示，同样让 bat 停住；同时写 node 路径缓存（§10.8 定）
    if (rebuildNotified || danglingCritical) process.exitCode = 2;
  } else if (launched && (originalRunning || rebuildNotified || danglingCritical)) {
    process.exitCode = 2;
  }
  // 快捷方式处理只在真的启动之后（与原顺序一致）；失败不影响退出码
  if (launched) {
    try { maybeAutoShortcut(inst); } catch (e) { log('快捷方式处理失败:', e.message); }
  }
  // node 路径缓存：普通模式成功启动/本应启动的位置都写（e2e 用例 D 走 --no-launch，需要它做断言）
  try { writeNodePathCache(); } catch (e) { log('警告: 缓存 node 路径失败（不影响启动）:', e.message); }
  // 安装发现缓存：本次选中安装且没有重建失败 -> 记下来，下次启动走快路径。
  // manual 不写缓存：tryCachedInstall 明确拒绝 manual 来源，而 runOnce 在有 installOverride 时也不走快路径，
  // 写进去只会把上一次可用的自动发现缓存顶掉（用户下次不带 --app-dir 时反而更慢）
  if (!rebuildNotified && (launched || opts.noLaunch) && inst.source !== 'manual') {
    try {
      const cache = installCacheOf(inst);
      if (JSON.stringify(STATE.installCache || null) !== JSON.stringify(cache)) {
        STATE.installCache = cache;
        writeState(STATE);
      }
    } catch (e) { log('警告: 写安装缓存失败（不影响启动）:', e.message); }
  }
  // 普通模式最后一行：本次启动用时 X.Xs（安装检测：缓存/完整/手动）
  const totalMs = Date.now() - PROC_START;
  REPORT.timing.totalMs = totalMs;
  const modeZh = { cache: '缓存', full: '完整', manual: '手动' }[discoveryMode] || discoveryMode;
  log(`本次启动用时 ${(totalMs / 1000).toFixed(1)}s（安装检测：${modeZh}）`);
}

// 退出钩子：删锁 + 写报告（失败吞掉，不影响退出码）+ 失败求助提示（只在普通模式且 code===1）
function onExit(code) {
  try { removeLock(); } catch (e) {}
  try { writeReport(code); } catch (e) {}
  if (code === 1 && MODE === 'normal') {
    console.log('\n[launcher] 解锁版没有正常启动，请看上面的提示。需要求助时把这个窗口截图发过来。');
  }
}

if (require.main === module) {
  process.on('exit', onExit);
  main().catch(e => {
    console.error('[launcher] 出错:', e.message);
    REPORT.errors.push(String(e.message || e));
    if (MODE === 'normal' && (!OPTS || !OPTS.noLaunch)) { try { launch(SELECTED); } catch (_) {} }
    process.exitCode = 1;
  });
}

// 供 test/install-discovery-test.js 与 test/net-override-test.js require（模块顶层不产生任何文件写入）
// 纯函数（readTopLevel/providerTableInfo/decideAuthOverride/mergeCatalogs/buildOverrides/tryCachedInstall）
// 不读写真实文件、不 process.exit；名字与签名按规格 §5.9/§10.10 冻结
module.exports = {
  inspectInstall, discoverInstalls, pickInstall, buildShortcutArgs, parseArgs, cmpVersion, patchReportFrom,
  fastKeyOf, resolveFingerprint, shortcutTargets,
  readTopLevel, providerTableInfo, decideAuthOverride, mergeCatalogs, buildOverrides, tryCachedInstall,
  danglingCatalogRef, danglingCatalogSeverity,
  NODE_PATH_SAFE_RE,
};
