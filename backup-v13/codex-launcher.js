// Codex 解锁启动器：自动同步商店版/官网安装版 Codex + 重打包补丁 + 回填 asar 哈希 + 启动
// 用法: node codex-launcher.js [--no-launch] [--force] [--dry-run] [--self-test] [--create-shortcut] [--no-shortcut] [--app-dir=目录]
//   --force           忽略"该版本补丁失败"记录，强制重试重建
//   --dry-run         完整走一遍重建（拷贝/打补丁/重打包/哈希回填）但不替换镜像、不写配置、不启动、不碰快捷方式
//   --self-test       严格只读自检：打印环境、所有候选安装、镜像/快捷方式状态、补丁试跑命中数；全中或可部分解锁退出码 0，否则 1
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
//   4. 镜像版本变化 -> 用镜像 codex.exe 导出内置模型目录、补 ultrafast，写入 config.toml 的 model_catalog_json
//      （首次使用且没配这一项时自动加上，原 config.toml 先备份）
//   5. 设置了 CODEX_ELECTRON_RESOURCES_PATH 时，让该目录与镜像 resources 一致（文件硬链接、目录 junction）
//   6. 首次成功启动后自动创建桌面/开始菜单快捷方式（文件夹搬家后自动更新；用户删掉的不再加回）
//   7. 启动镜像中的主程序（原版保持不动）
// 状态文件: %USERPROFILE%\ChatGPT-Patched\launcher-state.json（脚本目录可随意移动）
// 退出码: 0=成功；1=失败（bat 会暂停并提示求助）；2=需要用户看一眼的提示（bat 会暂停，不打印求助文案）
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
const LOCK_FILE = MIRROR_ROOT + '/launcher.lock'; // 单实例锁
const PATCH_SET_VERSION = 'v13'; // 补丁集版本：变更会强制重建
// 设置了 CODEX_ELECTRON_RESOURCES_PATH 时应用从这里读 resources，里面的文件必须与镜像保持一致；没设置就不需要
const RES_LINK = (process.env.CODEX_ELECTRON_RESOURCES_PATH || '').trim();
const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const ULTRAFAST_TIER = { id: 'ultrafast', name: 'Ultrafast', description: '2x speed, increased usage' };
// 入口 bat 路径（bat 用 CODEX_LAUNCHER_BAT=%~f0 传进来；直接跑 js 时用脚本目录下的默认名）
const BAT_PATH = (process.env.CODEX_LAUNCHER_BAT || '').trim() || path.join(__dirname, '启动Codex解锁版.bat');
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
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
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

// 汇总所有来源：去重 -> 逐个 inspectInstall -> 返回候选列表（含排除原因）
function discoverInstalls(opts = {}) {
  const raw = [];
  const manual = manualDirFor(opts);
  if (manual) raw.push({ source: 'manual', path: manual });
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
  if (!fs.existsSync(BAT_PATH)) {
    for (const t of targets) out.push({ path: win(lnkPath(t.path)), action: 'skipped', reason: '未找到入口脚本: ' + BAT_PATH });
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
    CODEX_LNK_TARGET: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    CODEX_LNK_ARGS: buildShortcutArgs(win(BAT_PATH)),
    CODEX_LNK_CWD: win(path.dirname(BAT_PATH)),
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
function tempDirBat() {
  const bat = N(BAT_PATH);
  if (bat.includes('temp1_')) return true;
  const tmp = N(os.tmpdir());
  return !!tmp && underDir(bat, tmp);
}

// 普通模式：首次成功启动后自动创建；之后快捷方式还在但指向的 bat 变了（文件夹搬家）就更新；
// 用户删掉的不再自动加回（除非 --create-shortcut）。--no-shortcut 本次不碰；
// bat 在临时目录（可能未解压）的检查在 createShortcuts 里统一处理
function maybeAutoShortcut(inst) {
  if (OPTS.noShortcut) { REPORT.shortcuts.push({ path: null, action: 'skipped', reason: '--no-shortcut' }); return; }
  const targets = shortcutTargets();
  if (!targets.length) { REPORT.shortcuts.push({ path: null, action: 'skipped', reason: '未能确定桌面/开始菜单目录' }); return; }
  const existing = targets.filter(t => fs.existsSync(lnkPath(t.path)));
  if (!existing.length && !STATE.shortcutsCreated) {
    const made = createShortcuts(inst);
    REPORT.shortcuts.push(...made);
    if (made.some(r => r.action === 'created')) {
      STATE.shortcutsCreated = true;
      STATE.shortcutBat = win(BAT_PATH);
      writeState(STATE);
      log('已创建桌面/开始菜单快捷方式: Codex 解锁版');
    }
  } else if (existing.length && STATE.shortcutBat && STATE.shortcutBat !== win(BAT_PATH)) {
    // 文件夹搬家：快捷方式还在但指向的 bat 变了 -> 自动更新。
    // 状态里没有 shortcutBat 说明这个同名 .lnk 不是我们建的（用户手工建的 / 状态文件丢了），不覆盖
    const made = createShortcuts(inst);
    for (const r of made) if (r.action === 'created') r.action = 'updated';
    REPORT.shortcuts.push(...made);
    if (made.some(r => r.action === 'updated')) {
      STATE.shortcutBat = win(BAT_PATH);
      writeState(STATE);
      log('快捷方式指向的入口脚本已变化，已自动更新');
    }
  } else if (existing.length) {
    for (const t of existing) REPORT.shortcuts.push({ path: win(lnkPath(t.path)), action: 'kept', reason: null });
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
  const files = [path.join(__dirname, 'codex-launcher.js')];
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
const REPORT = {
  reportVersion: 1, mode: null, exitCode: null, selected: null, candidates: [],
  patch: null, dryRunOk: null, shortcuts: [], errors: [],
};
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

// ---------- --create-shortcut：只创建/刷新快捷方式，然后退出（不重建、不启动、不建锁） ----------
// "bat 在临时目录"（os.tmpdir() 之下或含 Temp1_）的判断统一在 createShortcuts 里做——普通模式的自动创建
// 与 --create-shortcut 共用同一规则（e2e 沙箱让 TEMP 指向不含发行包解压目录的子目录即可避开该规则）；
// 镜像未构建也能工作（图标从选中安装的 resources 复制）
function createShortcutMode(opts) {
  log('创建/刷新快捷方式 ...');
  // 找选中安装只为取图标；测试钩子下这里只会做 手动/app-dir + 文件系统扫描（不调 PowerShell）
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
  STATE.shortcutBat = win(BAT_PATH);
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
  log('检测 Codex 安装 ...');
  const cands = discoverInstalls({ appDir: opts.appDir });
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
            // 成功才记录新指纹；同时清掉旧的失败记录。保留 storeVersion/storeFingerprint/patchSetVersion/
            // catalogFingerprint 等旧字段名，兼容老状态文件
            const s = {
              ...STATE,
              storeVersion: inst.source === 'store' ? path.basename(inst.root) : (inst.version || inst.label),
              storeFingerprint: fp,
              patchSetVersion: PATCH_SET_VERSION,
              failedPatches: 0,
              updatedAt: new Date().toISOString(),
              catalogFingerprint: STATE.catalogFingerprint, // 保留旧值：与新指纹不同照样触发目录更新
              installSource: inst.source,
              installPath: win(inst.appDir),
              appVersion: inst.version,
              mainExe: inst.mainExe,
              fastKey: fk,
              fastFingerprint: fp, // 与 fastKey 配对；失败记账时 storeFingerprint 不变，靠它保证失败版本能被认出来
              partialGroups: REPORT.patch ? REPORT.patch.skippedGroups : [],
            };
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

  // 模型目录跟随镜像实际所用的版本（重建失败回退旧镜像时也一致）；失败只告警，下次启动重试
  if (mirrorUsable() && STATE.storeFingerprint && STATE.catalogFingerprint !== STATE.storeFingerprint) {
    if (regenCatalog(!STATE.catalogFingerprint)) { STATE.catalogFingerprint = STATE.storeFingerprint; writeState(STATE); }
  }
  try { syncResources(); } catch (e) { log('资源目录同步出错:', e.message); }

  let launched = false, originalRunning = false;
  if (!opts.noLaunch) {
    // Codex 有单实例锁：原版开着时，解锁版可能一启动就退出（只把原版窗口切到前台）
    originalRunning = pidsUnder(inst.root).length > 0;
    if (originalRunning && mirrorUsable()) {
      log('提示: 原版 Codex 正在运行。如果解锁版窗口没有出现，请先在任务栏右下角托盘里右键彻底退出 Codex，再重新运行启动器');
    }
    // 没能启动解锁版 -> 1；解锁版启动了但原版在运行（需要用户看一眼）-> 2
    launched = launch(inst);
    if (!launched) process.exitCode = 1;
    else if (originalRunning || rebuildNotified) process.exitCode = 2;
  } else if (rebuildNotified) {
    // --no-launch：没有启动动作，但上面有需要用户看的中文提示，同样让 bat 停住
    process.exitCode = 2;
  }
  if (launched) {
    try { maybeAutoShortcut(inst); } catch (e) { log('快捷方式处理失败:', e.message); }
  }
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

// 供 test/install-discovery-test.js require（模块顶层不产生任何文件写入）
module.exports = {
  inspectInstall, discoverInstalls, pickInstall, buildShortcutArgs, parseArgs, cmpVersion, patchReportFrom,
  fastKeyOf, resolveFingerprint, shortcutTargets,
};
