// 黑盒端到端测试（规格 §8 用例 1~6，慢，几分钟、真实 2GB 拷贝；由主控门禁运行）
//   node test/sandbox-e2e.js
//
// 与启动器只通过 bat / 命令行参数 / 环境变量 / CODEX_LAUNCHER_REPORT JSON 报告交互：
// 不 require 启动器本体（codex-launcher.js），不解析中文日志——唯一例外是 lib/launcher-core.js 的只读接口
// （locateNetBundle/hasNetPatch/evalNetArgs/applyNetPatch/readAsar/readAsarEntry；规格 §4.2/§10.10 冻结签名），
// 用例 D 用它独立核对镜像 asar 里的 net 补丁与参数，而不是只相信启动器的报告。依赖的启动器接口（规格 §9 + §10.6/§10.7，冻结）：
//   - 参数: --dry-run（完整重建到 staging 后删除，不落地镜像）、--create-shortcut、--self-test（严格只读）
//   - 环境变量: USERPROFILE/HOME/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/APPDATA/CODEX_HOME 指向沙箱（TEMP/TMP 用沙箱内的
//     AppData\Local\Temp 子目录，避开 §6 的临时目录规则）、CODEX_ELECTRON_RESOURCES_PATH 置空、
//     CODEX_LAUNCHER_SHORTCUT_DIR 指向沙箱、CODEX_LAUNCHER_NO_PAUSE=1、
//     CODEX_LAUNCHER_NO_STORE=1 / CODEX_LAUNCHER_NO_EXTERNAL=1（测试钩子）、CODEX_LAUNCHER_REPORT
//   - bat: 用 cmd.exe /d /c ""<bat>"" <参数> 调用（windowsVerbatimArguments、stdin 忽略），退出码原样传回
//   - 报告: reportVersion/mode/exitCode/selected{source,appDir,mainExe,version}/candidates/
//     patch{total,ok,failCount,partial,skippedGroups,variants}/dryRunOk/shortcuts/errors/
//     net{patch{located,applied,actual,rel},overrides,diagnosis}/timing{discovery,discoveryMs,preLaunchMs,totalMs}
//     （net/timing 字段名见规格 §10.10，冻结）
//   - core (lib/launcher-core.js) 只读接口: readAsar/locateNetBundle/readAsarEntry/applyNetPatch/hasNetPatch/evalNetArgs
//     （规格 §4.2/§10.10 冻结签名；applyNetPatch 用作"报告结论 vs core 结论"一致性断言的基真值）
// 用例:
//   1) 准备：robocopy 商店 app 目录 -> 沙箱\AppData\Local\Programs\Codex（假"官网安装版"），
//      再用旧版样本 app.asar.backup-20261001 覆盖它的 resources\app.asar -> "官网安装版 + 旧版本"
//   A) 通过 bat 跑 --dry-run（NO_STORE + NO_EXTERNAL；TEMP 目录先删除）：选中沙箱安装版、15/15 命中（旧版走变体）
//   B) 去掉 NO_STORE，用 node 直接跑 --dry-run：选中真实商店版（新版）
//   C) 解压发行 zip 到 "沙箱\dir with space & 中文\" -> 从该目录 --create-shortcut -> 读回 .lnk 断言
//      -> 按 .lnk 的 Arguments 追加 " --self-test" 用 cmd 执行，断言退出码 0
//      用例 A/B/C 都从"TEMP 目录不存在"开始（启动器/核心有 mkdir 兜底；缺失时若回归会在日志里看到 ENOENT）
//   6) 真实 launcher-state.json / config.toml 的 mtime 与真实桌面清单不变；无论成败清理沙箱大文件
// 退出码: 0=全部通过；1=有失败。完整日志写 .tmp-sandbox-logs\，stdout 最后一行 all passed / N failed。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// ---------- 路径与常量 ----------
const ROOT = path.join(__dirname, '..');
// 沙箱根：子进程眼中的整个"用户目录"。名字带 PID：同一工作区可能同时跑多个沙箱测试（多主控/重跑），
// 固定名字会互相 rmSync 掉对方的拷贝与临时文件（实测：并发的一次跑里 ChatGPT.exe 刚拷好就被清、
// 启动器创建临时文件 ENOENT）；带 PID 后各跑各的，互不干扰
const SANDBOX = path.join(ROOT, '.tmp-sandbox-' + process.pid);
const LOG_DIR = path.join(ROOT, '.tmp-sandbox-logs');             // 完整日志目录（保留，便于排查）
const RUN_LOGS = path.join(LOG_DIR, 'p' + process.pid);           // 本次运行的日志（并发运行各写各的，互不覆盖）
const SANDBOX_LOCAL = path.join(SANDBOX, 'AppData', 'Local');
const SANDBOX_ROAMING = path.join(SANDBOX, 'AppData', 'Roaming');
// TEMP/TMP 用沙箱内的专门子目录（不放沙箱根）：临时文件仍全部留在沙箱内，同时保证用例 C 的发行包解压目录
// 不在 os.tmpdir() 之下——启动器的"bat 位于临时目录不建快捷方式"规则（§6）对普通模式与 --create-shortcut
// 统一生效（codex-launcher.js 的 createShortcuts 里判断），解压目录若落在 os.tmpdir() 里会被正确跳过
const SANDBOX_TEMP = path.join(SANDBOX_LOCAL, 'Temp');
const INSTALL_DIR = path.join(SANDBOX_LOCAL, 'Programs', 'Codex'); // 用例 1 的假"官网安装版"
const SHORTCUT_DIR = path.join(SANDBOX, 'shortcuts');              // 用例 C 的快捷方式落点
const SPACE_DIR = path.join(SANDBOX, 'dir with space & 中文');      // 用例 C：含空格、&、中文
const EXTRACT_ROOT = path.join(SPACE_DIR, 'Codex解锁启动器');       // 发行 zip 的顶层目录
const MIRROR_SB = path.join(SANDBOX, 'ChatGPT-Patched');           // 沙箱里的 MIRROR_ROOT
const BAT = path.join(ROOT, '启动Codex解锁版.bat');                 // 门禁里 entry 提供
const LAUNCHER = path.join(ROOT, 'codex-launcher.js');
const OLD_ASAR = path.join(ROOT, 'app.asar.backup-20261001');      // 未打补丁的旧版样本（只读素材）
const OLD_VERSION = '26.928.21956';                                // 旧版样本的 asar 版本（规格 §1）
const DIST_ZIP = path.join(ROOT, 'dist', 'Codex解锁启动器.zip');    // 门禁里 pack.py 先于本测试运行

const TIMEOUT_LAUNCHER = 8 * 60 * 1000;   // 单次启动器调用最多 8 分钟
const TIMEOUT_ROBOCOPY = 10 * 60 * 1000;  // robocopy 最多 10 分钟
const TIMEOUT_QUICK = 120 * 1000;
const TIMEOUT_REBUILD = 20 * 60 * 1000;   // 用例 D 第一次冷启动重建（约 2GB 拷贝）最多 20 分钟
// 整轮总预算：门禁按 60 分钟超时跑本测试（规格 §8）。超预算时不再开始新用例，直接给出失败并照常清理，
// 这样 60 分钟上限内一定能走到"清理 + 打印 all passed/N failed"，而不是被外部杀掉、留下几十 GB 沙箱
const BUDGET_MS = 60 * 60 * 1000;
// 本次运行的起点：预算守卫（用例 D）与结尾的耗时统计共用；放在模块顶层，避免依赖下面的 IIFE 求值顺序
const T0 = Date.now();

// 真实环境（本进程的环境变量没有被改动，用于 §8.5 的只读断言）
const REAL_HOME = process.env.USERPROFILE || os.homedir();
const REAL_MIRROR_ROOT = path.join(REAL_HOME, 'ChatGPT-Patched');
const REAL_STATE = path.join(REAL_MIRROR_ROOT, 'launcher-state.json');
const REAL_CONFIG = path.join(process.env.CODEX_HOME || path.join(REAL_HOME, '.codex'), 'config.toml');

// ---------- 断言与输出 ----------
let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; console.log((cond ? '  OK   ' : '  FAIL ') + msg); if (!cond) failures++; return !!cond; };
const head = t => console.log('\n== ' + t + ' ==');
const info = msg => console.log('       ' + msg);

// ---------- 小工具 ----------
// 路径归一化（比较用）：绝对路径、去尾部斜杠、小写（Windows 不区分大小写）
const nm = p => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const inSandbox = p => { try { return nm(p).startsWith(nm(SANDBOX) + '\\'); } catch (e) { return false; } };
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 文件快照（存在性 + mtime + 内容哈希），用于"真实文件没被动过"的断言
function snap(p) {
  try { const st = fs.statSync(p); return { exists: true, mtimeMs: st.mtimeMs, size: st.size, sha: st.size < 4 * 1024 * 1024 ? hashFile(p) : null }; }
  catch (e) { return { exists: false }; }
}
const sameSnap = (a, b) => a.exists === b.exists && (!a.exists || (a.mtimeMs === b.mtimeMs && a.size === b.size && a.sha === b.sha));

// 同步跑一次 PowerShell（只用于读 .lnk / 找桌面，快）
function psRun(script, env, timeoutMs) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env: env || process.env, encoding: 'utf8', timeout: timeoutMs || TIMEOUT_QUICK, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error && r.error.message };
}

// 真实桌面清单（GetFolderPath 正确处理 OneDrive 重定向）
function desktopListing() {
  const r = psRun("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('Desktop')");
  if (r.code !== 0 || !r.out) return { ok: false, err: r.err || r.error || 'PowerShell 未返回桌面路径' };
  try { return { ok: true, path: r.out, names: fs.readdirSync(r.out).sort() }; }
  catch (e) { return { ok: false, err: e.message }; }
}

// 读取 asar header 里的 package.json 版本（本地实现：测试不 require 启动器内部）
function readAsarPkgVersion(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    const jsonLen = b.readUInt32LE(12);
    const jb = Buffer.alloc(jsonLen);
    fs.readSync(fd, jb, 0, jsonLen, 16);
    const header = JSON.parse(jb.toString('utf8'));
    const e = header.files && header.files['package.json'];
    if (!e || e.size === undefined || e.unpacked) return null;
    const dataBase = 8 + b.readUInt32LE(4);
    const cb = Buffer.alloc(e.size);
    fs.readSync(fd, cb, 0, e.size, dataBase + Number(e.offset));
    const pkg = JSON.parse(cb.toString('utf8'));
    return { name: pkg.name, version: pkg.version };
  } finally { fs.closeSync(fd); }
}

// 异步执行子进程：超时后用 taskkill /T 把整棵进程树杀掉（bat->node 链不能只杀 cmd.exe），stdin 一律忽略
function run(exe, args, o = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let out = '', err = '', done = false, timedOut = false;
    const child = spawn(exe, args, {
      cwd: o.cwd, env: o.env, windowsHide: true,
      windowsVerbatimArguments: !!o.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = code => {
      if (done) return; done = true;
      clearTimeout(timer);
      const res = { code, out, err, timedOut, ms: Date.now() - started };
      if (o.log) saveLog(o.log, exe, args, res);
      resolve(res);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
      try { child.kill(); } catch (e) {}
    }, o.timeoutMs || TIMEOUT_QUICK);
    if (child.stdout) child.stdout.on('data', d => { out += d.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { err += '\n[spawn 失败] ' + e.message; finish(-1); });
    child.on('close', code => finish(code === null ? -2 : code));
  });
}

// 完整日志：每次子进程调用一份，含命令、退出码与两个输出流（写到本次运行的专属子目录）
function saveLog(name, exe, args, res) {
  try {
    fs.mkdirSync(RUN_LOGS, { recursive: true });
    const headTxt = '$ ' + exe + ' ' + args.join(' ') + '\n[exit=' + res.code + (res.timedOut ? ' TIMEOUT' : '') + ' ' + res.ms + 'ms]\n';
    fs.writeFileSync(path.join(RUN_LOGS, name + '.log'), headTxt + '--- stdout ---\n' + res.out + '\n--- stderr ---\n' + res.err);
  } catch (e) { /* 日志写失败不影响测试结果 */ }
}

// 读取 §9 报告（不存在/解析失败都返回可诊断的对象，并把原文件复制到本次运行的日志目录）
function readReport(step) {
  const p = path.join(SANDBOX, 'report-' + step + '.json');
  if (!fs.existsSync(p)) return { __missing: true, __path: p };
  let text;
  try { fs.mkdirSync(RUN_LOGS, { recursive: true }); fs.copyFileSync(p, path.join(RUN_LOGS, 'report-' + step + '.json')); } catch (e) {}
  try { text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return { __missing: true, __path: p, __err: e.message }; }
  try { return JSON.parse(text); } catch (e) { return { __missing: true, __path: p, __err: 'JSON 解析失败: ' + e.message }; }
}
const reportReady = r => !!r && !r.__missing;

// 沙箱子进程环境：所有"用户目录"指向沙箱；真实镜像/快捷方式/报告/测试钩子一律不继承
// ProgramFiles 相关：fsScanDirs 扫 %ProgramFiles% / %ProgramFiles(x86)% / %LOCALAPPDATA%（不跟随 USERPROFILE），
// 真实盘上若有名字匹配的 Codex 安装会被当成候选、版本可能高于沙箱旧样本从而被选中（LOCALAPPDATA 已沙箱化，
// 前两个没有）。这里先删除原始键（本机键名是 PROGRAMFILES 与大写混合，直接赋混合大小写会造出只差大小写的
// 重复键，Windows 环境块里行为未定义），再指向沙箱下不存在的目录，保证候选集合只来自沙箱。
function sandboxEnv(step, o = {}) {
  const env = { ...process.env };
  for (const k of ['CODEX_APP_DIR', 'CODEX_LAUNCHER_BAT', 'CODEX_LAUNCHER_REPORT', 'CODEX_LAUNCHER_SHORTCUT_DIR',
    'CODEX_LAUNCHER_NO_STORE', 'CODEX_LAUNCHER_NO_EXTERNAL', 'CODEX_ELECTRON_RESOURCES_PATH']) delete env[k];
  for (const k of Object.keys(env)) {
    const lk = k.toLowerCase();
    if (lk === 'programfiles' || lk === 'programfiles(x86)') delete env[k];
  }
  const root = path.parse(SANDBOX).root; // 'F:\'
  Object.assign(env, {
    USERPROFILE: SANDBOX, HOME: SANDBOX,
    HOMEDRIVE: root.replace(/\\$/, ''), HOMEPATH: SANDBOX.slice(root.length - 1),
    LOCALAPPDATA: SANDBOX_LOCAL, APPDATA: SANDBOX_ROAMING,
    ProgramFiles: path.join(SANDBOX, 'no-program-files'),
    'ProgramFiles(x86)': path.join(SANDBOX, 'no-program-files-x86'),
    TEMP: SANDBOX_TEMP, TMP: SANDBOX_TEMP,     // os.tmpdir() 不跟随 USERPROFILE（实测），必须单独指；位置见 SANDBOX_TEMP 注释
    CODEX_HOME: SANDBOX,                        // 真实 ~/.codex/config.toml 绝不能被读/写
    CODEX_ELECTRON_RESOURCES_PATH: '',          // 置空：真实环境里这个变量指到真实镜像的资源目录
    CODEX_LAUNCHER_SHORTCUT_DIR: SHORTCUT_DIR,  // 快捷方式一律落在沙箱
    CODEX_LAUNCHER_NO_PAUSE: '1',               // 入口 bat 的测试钩子：非 0 退出也不 pause（stdin 已 ignore，双保险）
    CODEX_LAUNCHER_REPORT: path.join(SANDBOX, 'report-' + step + '.json'),
  });
  if (o.noStore) env.CODEX_LAUNCHER_NO_STORE = '1';
  if (o.noExternal) env.CODEX_LAUNCHER_NO_EXTERNAL = '1';
  return env;
}

// 沙箱镜像根下的残留检查（dry-run 不留 staging；所有模式退出后不留锁）
function noLeftovers(tag) {
  ok(!fs.existsSync(path.join(MIRROR_SB, 'app.staging')), tag + '：没有残留 app.staging');
  ok(!fs.existsSync(path.join(MIRROR_SB, 'launcher.lock')), tag + '：没有残留 launcher.lock');
}

// 找真实商店版 app 目录（只读）：Get-AppxPackage 权威，失败退回 reg.exe（规格 §10.3 配方）
function findStoreAppDir() {
  const r = psRun("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation");
  const loc = r.out;
  if (loc && fs.existsSync(path.join(loc, 'app', 'resources', 'app.asar'))) return path.join(loc, 'app');
  const rr = spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages', '/s', '/v', 'PackageRootFolder'],
    { encoding: 'latin1', timeout: TIMEOUT_QUICK, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  for (const line of (rr.stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/^PackageRootFolder\s+REG_SZ\s+(.+)$/);
    if (!m) continue;
    const root = m[1].trim();
    if (path.basename(root).startsWith('OpenAI.Codex_') && fs.existsSync(path.join(root, 'app', 'resources', 'app.asar'))) return path.join(root, 'app');
  }
  return null;
}

// ---------- 主流程 ----------
async function main() {
  console.log('[sandbox-e2e] 沙箱: ' + SANDBOX);
  console.log('[sandbox-e2e] 日志: ' + LOG_DIR);

  // 0) 真实环境快照（覆盖前的原始 USERPROFILE；§8.5/§10.6 断言用）
  head('真实环境快照（只读断言用）');
  const beforeState = snap(REAL_STATE);
  const beforeConfig = snap(REAL_CONFIG);
  const beforeDesktop = desktopListing();
  ok(beforeDesktop.ok, '真实桌面清单可读（' + (beforeDesktop.ok ? beforeDesktop.path + '，' + beforeDesktop.names.length + ' 项' : beforeDesktop.err) + '）');

  // 1) 清理旧沙箱与本次运行的日志目录，重建沙箱目录结构（GetFolderPath 对不存在的目录返回空串，必须预创建）
  //    只清自己的 RUN_LOGS：LOG_DIR 可能还有其它并发运行（不同 PID）的日志，不能整个删掉
  head('用例 1：准备沙箱（假"官网安装版 + 旧版本"）');
  rmBig(SANDBOX);
  fs.rmSync(RUN_LOGS, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  fs.mkdirSync(RUN_LOGS, { recursive: true });
  for (const d of [SANDBOX, SANDBOX_LOCAL, SANDBOX_ROAMING, SANDBOX_TEMP, SHORTCUT_DIR,
    path.join(SANDBOX, 'Desktop'),
    path.join(SANDBOX_ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs')]) fs.mkdirSync(d, { recursive: true });
  const envProbe = sandboxEnv('probe');
  ok(inSandbox(SANDBOX_TEMP) && nm(envProbe.TEMP) === nm(SANDBOX_TEMP) && !nm(SPACE_DIR).startsWith(nm(SANDBOX_TEMP) + '\\'),
    'TEMP/TMP 指向沙箱内的子目录、且不包含发行包解压目录（否则 §6 的临时目录规则会把用例 C 的快捷方式跳过）');

  const storeApp = findStoreAppDir();
  if (!ok(!!storeApp, '找到真实商店版 app 目录（只读素材）' + (storeApp ? '：' + storeApp : '：Get-AppxPackage 与注册表都没找到'))) return;
  // 商店目录的来源先做完整性检查：应用正在更新/被清理时会缺主程序，此时报清楚而不是让后面的断言连环失败
  ok(fs.existsSync(path.join(storeApp, 'ChatGPT.exe')) && fs.existsSync(path.join(storeApp, 'resources', 'app.asar')),
    '商店 app 目录含 ChatGPT.exe 与 resources\\app.asar（拷贝来源完整）');
  const storePkg = readAsarPkgVersion(path.join(storeApp, 'resources', 'app.asar'));
  info('商店版 asar 版本: ' + (storePkg && storePkg.version));

  // robocopy 商店 app 目录 -> 沙箱安装版（0~7 都是成功）；拷完必须确认主程序真的在，
  // 不在就重试一次并在断言里带上诊断（历史上这一条失败过：并发运行互相清沙箱/来源被占用）
  let rc = await run('robocopy', [storeApp, INSTALL_DIR, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { timeoutMs: TIMEOUT_ROBOCOPY, log: 'case1-robocopy' });
  const copied = () => fs.existsSync(path.join(INSTALL_DIR, 'ChatGPT.exe')) && fs.existsSync(path.join(INSTALL_DIR, 'resources', 'app.asar'));
  if (!(rc.code >= 0 && rc.code < 8) || !copied()) {
    info('首次 robocopy 退出码 ' + rc.code + '、主程序在: ' + copied() + '，立即重试一次');
    rc = await run('robocopy', [storeApp, INSTALL_DIR, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
      { timeoutMs: TIMEOUT_ROBOCOPY, log: 'case1-robocopy-retry' });
  }
  ok(rc.code >= 0 && rc.code < 8, 'robocopy 商店 app -> 沙箱安装版（退出码 ' + rc.code + (rc.timedOut ? '，超时' : '') + '，' + Math.round(rc.ms / 1000) + 's）');

  // 用旧版样本覆盖 app.asar -> "官网安装版 + 旧版本"（旧版样本是只读素材，只拷不写）
  let oldOk = false;
  if (ok(fs.existsSync(OLD_ASAR), '旧版样本 app.asar.backup-20261001 存在')) {
    fs.copyFileSync(OLD_ASAR, path.join(INSTALL_DIR, 'resources', 'app.asar'));
    const v = readAsarPkgVersion(path.join(INSTALL_DIR, 'resources', 'app.asar'));
    oldOk = ok(!!v && v.version === OLD_VERSION, '沙箱安装版的 app.asar 已换成旧版样本（版本 ' + (v && v.version) + '）');
  }
  const exeOk = fs.existsSync(path.join(INSTALL_DIR, 'ChatGPT.exe'));
  ok(exeOk, '沙箱安装版有 ChatGPT.exe（主程序）'
    + (exeOk ? '' : '；robocopy 退出码 ' + rc.code + '，目录内容 ' + JSON.stringify(fs.existsSync(INSTALL_DIR) ? fs.readdirSync(INSTALL_DIR).slice(0, 12) : null)));
  ok(fs.existsSync(path.join(INSTALL_DIR, 'resources', 'icon-chatgpt.ico')), '沙箱安装版有 resources\\icon-chatgpt.ico（用例 C 用）');
  if (!oldOk) return; // 旧版样本没到位，后续用例的断言没有意义
  const installAsarBefore = snap(path.join(INSTALL_DIR, 'resources', 'app.asar'));
  ok(fs.existsSync(BAT) && fs.existsSync(LAUNCHER), '工作区的 启动Codex解锁版.bat 与 codex-launcher.js 存在');

  // ---- 用例 A：通过 bat 跑 --dry-run（沙箱里的旧版安装版，15/15 走变体）----
  // 先删掉 TEMP 目录：模拟被清理工具清空 / 从未存在的临时目录。
  // 00:59 的真实失败日志就是这一类（core 的输出临时文件 ENOENT ...\AppData\Local\Temp\codex-run-*.out），
  // 启动器与核心现在都在用临时文件前兜底 mkdir（codex-launcher.js 的 runCaptureBytes 与语法校验前；
  // lib/launcher-core.js 的 runCaptured）；若回归，rA.code===0 与下面的 15/15 断言会失败，日志里能看到 ENOENT。
  head('用例 A：bat --dry-run（旧版安装版，NO_STORE + NO_EXTERNAL，TEMP 目录不存在）');
  const envA = sandboxEnv('a', { noStore: true, noExternal: true });
  fs.rmSync(SANDBOX_TEMP, { recursive: true, force: true });
  ok(!fs.existsSync(SANDBOX_TEMP), '前置：TEMP 目录已删除（模拟被清空/从未存在）');
  const rA = await run('cmd.exe', ['/d /c ""' + BAT + '"" --dry-run'],
    { verbatim: true, env: envA, cwd: ROOT, timeoutMs: TIMEOUT_LAUNCHER, log: 'caseA-bat-dry-run' });
  ok(rA.code === 0, 'bat --dry-run 退出码 0（实际 ' + rA.code + (rA.timedOut ? '，超时' : '') + '，' + Math.round(rA.ms / 1000) + 's）');
  const repA = readReport('a');
  if (ok(reportReady(repA), 'CODEX_LAUNCHER_REPORT 报告已写出且可解析' + (repA.__missing ? '（' + (repA.__err || '文件不存在') + '）' : ''))) {
    ok(repA.reportVersion === 1, '报告 reportVersion === 1');
    ok(repA.mode === 'dry-run' && repA.exitCode === 0, '报告 mode === dry-run 且 exitCode === 0');
    const sel = repA.selected || {};
    ok(sel.source === 'exe', '选中来源是安装版 source === "exe"（实际 ' + JSON.stringify(sel.source) + '）');
    ok(sel.appDir && nm(sel.appDir) === nm(INSTALL_DIR), '选中的就是沙箱安装版 ' + INSTALL_DIR);
    ok(!!sel.appDir && inSandbox(sel.appDir) && !nm(sel.appDir).startsWith(nm(REAL_MIRROR_ROOT) + '\\'), '选中路径在沙箱内且不是真实镜像');
    ok(typeof sel.mainExe === 'string' && /chatgpt\.exe$/i.test(sel.mainExe), '主程序取体积最大的 ChatGPT.exe（实际 ' + JSON.stringify(sel.mainExe) + '）');
    ok(sel.version === OLD_VERSION, '选中版本是旧版样本 ' + OLD_VERSION + '（实际 ' + JSON.stringify(sel.version) + '）');
    const pa = repA.patch || {};
    ok(pa.total === 15 && pa.ok === 15 && pa.failCount === 0, '15 条补丁全部命中（total=' + pa.total + ' ok=' + pa.ok + ' failCount=' + pa.failCount + '）');
    ok(pa.partial === false, '完整解锁，partial === false');
    ok(Array.isArray(pa.skippedGroups) && pa.skippedGroups.length === 0, 'skippedGroups 为 []（实际 ' + JSON.stringify(pa.skippedGroups) + '）');
    const variants = pa.variants && typeof pa.variants === 'object' ? pa.variants : {};
    const viaVariant = Object.values(variants).filter(v => typeof v === 'number' && v !== 0).length;
    ok(Object.keys(variants).length === 15, 'variants 覆盖全部 15 条命中（实际 ' + Object.keys(variants).length + ' 条）');
    ok(viaVariant === 4 && Object.values(variants).every(v => typeof v === 'number' && (v === 0 || v === 1)),
      '旧版恰 4 条 speed 补丁经变体 1 命中（非主定义 ' + viaVariant + ' 条，规格 §10.1）');
    ok(repA.dryRunOk === true, 'dryRunOk === true');
    const okCands = (repA.candidates || []).filter(c => c && c.ok === true);
    ok(okCands.length >= 1 && okCands.every(c => inSandbox(c.path || c.appDir || '') && typeof c.version === 'string' && c.version),
      '所有通过校验的候选都在沙箱内且带版本号（' + okCands.length + ' 个，真实环境没有串入）');
  }
  ok(/dry-?run/i.test(rA.out), 'stdout 出现 dry-run 日志');
  noLeftovers('用例 A');

  // ---- 用例 B：去掉 NO_STORE，用 node 直接跑 --dry-run（选中真实商店版新版）----
  // 再删一次 TEMP 目录（用例 A 里启动器的兜底可能已把它建回来）：本轮同样从"TEMP 不存在"开始
  head('用例 B：node --dry-run（去掉 NO_STORE，选中真实商店版）');
  fs.rmSync(SANDBOX_TEMP, { recursive: true, force: true });
  const envB = sandboxEnv('b', { noExternal: true });
  const rB = await run(process.execPath, [LAUNCHER, '--dry-run'],
    { env: envB, cwd: ROOT, timeoutMs: TIMEOUT_LAUNCHER, log: 'caseB-node-dry-run' });
  ok(rB.code === 0, 'node --dry-run 退出码 0（实际 ' + rB.code + (rB.timedOut ? '，超时' : '') + '，' + Math.round(rB.ms / 1000) + 's）');
  const repB = readReport('b');
  if (ok(reportReady(repB), 'CODEX_LAUNCHER_REPORT 报告已写出且可解析')) {
    ok(repB.mode === 'dry-run' && repB.exitCode === 0, '报告 mode === dry-run 且 exitCode === 0');
    const sel = repB.selected || {};
    ok(sel.source === 'store', '选中来源是商店版 source === "store"（实际 ' + JSON.stringify(sel.source) + '）');
    ok(!!sel.appDir && nm(sel.appDir).includes('\\windowsapps\\'), '选中的是 WindowsApps 下的商店版（' + String(sel.appDir) + '）');
    ok(!!storePkg && sel.version === storePkg.version, '选中版本与商店 asar 一致（' + String(sel.version) + '，旧版样本 ' + OLD_VERSION + ' 应落选）');
    const pb = repB.patch || {};
    ok(pb.total === 15 && pb.ok === 15 && pb.failCount === 0, '商店新版 15/15 命中（total=' + pb.total + ' ok=' + pb.ok + ' failCount=' + pb.failCount + '）');
    ok(pb.partial === false && Array.isArray(pb.skippedGroups) && pb.skippedGroups.length === 0, '完整解锁、无跳过组');
    ok(repB.dryRunOk === true, 'dryRunOk === true');
  }
  noLeftovers('用例 B');
  ok(sameSnap(installAsarBefore, snap(path.join(INSTALL_DIR, 'resources', 'app.asar'))),
    '两次 dry-run 都没有改动沙箱里的"原版"安装（app.asar 未变）');

  // ---- 用例 C：发行包 -> --create-shortcut -> 读回 .lnk -> 按 .lnk 执行 --self-test ----
  await caseC();

  // ---- 用例 D：沙箱普通模式 + --no-launch 连续两次（第一次重建 / 第二次安装缓存快路径，规格 §8） ----
  // 放在"真实环境只读断言"之前：它是唯一会走普通模式的用例，clearZoneIdentifiers 会删真实工作区启动器文件的
  // :Zone.Identifier ADS（§10.8，只删 ADS、不改内容，用例内已显式接受），要跑完再看桌面/状态有无变化。
  // 总预算守卫：用例 D 是整轮最重的一段（2GB 拷贝 + 两次启动），剩余时间不够就不开始，
  // 让 60 分钟上限内一定能走到清理与结果输出（而不是被外部杀掉、留下几十 GB 沙箱）
  const remainMs = BUDGET_MS - (Date.now() - T0);
  if (remainMs < 5 * 60 * 1000) {
    ok(false, '总预算不足，跳过用例 D（剩余 ' + Math.round(remainMs / 1000) + 's；用例 D 需要约 5~20 分钟。'
      + '前面用例耗时异常时请查看本行上方的各项耗时）');
  } else {
    await caseD();
  }

  // ---- §8.5/§10.6：真实环境只读断言 ----
  head('真实环境只读断言');
  ok(sameSnap(beforeState, snap(REAL_STATE)), '真实 launcher-state.json 未被动过（' + REAL_STATE + '）');
  ok(sameSnap(beforeConfig, snap(REAL_CONFIG)), '真实 config.toml 未被动过（' + REAL_CONFIG + '）');
  if (beforeDesktop.ok) {
    const afterDesktop = desktopListing();
    ok(afterDesktop.ok && JSON.stringify(afterDesktop.names) === JSON.stringify(beforeDesktop.names),
      '真实桌面没有多出/少掉文件（' + (afterDesktop.ok ? afterDesktop.names.length + ' 项' : afterDesktop.err) + '）');
  } else {
    ok(false, '真实桌面清单复核失败：' + beforeDesktop.err);
  }
}

// 用例 D：沙箱普通模式 + --no-launch 连跑两次（第一次完整重建、第二次走安装缓存快路径）。
// 只通过命令行参数/环境变量/报告/沙箱文件与启动器交互；core 的 net 接口按 §4.2/§10.10 冻结签名直接 require 使用（只读）。
// 报告字段（§10.10 冻结）：net = {patch:{located,applied,actual,rel}, overrides, diagnosis}；
//                          timing = {discovery:'cache'|'full'|'manual', discoveryMs, preLaunchMs, totalMs}
// 副作用的落点（§10.8，逐条接受）：killApp/pidsUnder -> 沙箱镜像；acquireLock -> 沙箱 launcher.lock；
//   syncResources -> RES_LINK 置空直接 return；maybeAutoShortcut -> CODEX_LAUNCHER_SHORTCUT_DIR（沙箱）；
//   clearZoneIdentifiers -> **真实工作区**的启动器文件（只删 :Zone.Identifier ADS、不改内容，故只断言内容 sha256 不变）
async function caseD() {
  head('用例 D：沙箱普通模式 --no-launch 连续两次（第一次重建 + 第二次缓存快路径）');
  // core 的 net 接口：按 §4.2/§10.10 冻结签名 require；缺任何一个就明确失败并跳过，
  // 不静默当成"补丁缺失"（applyNetPatch 也要——它是"报告结论 vs core 结论"一致性断言的基真值来源，
  // 少了它就会悄悄退化到宽松分支）
  let coreNet = null;
  try {
    const c = require(path.join(ROOT, 'lib', 'launcher-core.js'));
    coreNet = ['locateNetBundle', 'hasNetPatch', 'applyNetPatch', 'evalNetArgs'].every(k => typeof c[k] === 'function') ? c : null;
  } catch (e) { coreNet = null; }
  ok(!!coreNet, 'core 已导出 locateNetBundle/hasNetPatch/applyNetPatch/evalNetArgs（§10.10 冻结签名；缺了用例 D 无法独立核对 asar 里的 net 补丁）');
  if (!coreNet) return;

  const MIRROR_D = path.join(MIRROR_SB, 'app');                            // 沙箱镜像的 app 目录
  const ASAR_D = path.join(MIRROR_D, 'resources', 'app.asar');
  const CODEX_HOME_D = path.join(SANDBOX, '.codex');                       // 沙箱 CODEX_HOME（config.toml/auth.json 夹具）
  const OVERRIDES_D = path.join(MIRROR_SB, 'codex-launcher-overrides.json');
  const MERGED_D = path.join(MIRROR_SB, 'model-catalog-merged.json');
  const NODE_PATH_D = path.join(MIRROR_SB, 'node-path.txt');
  const FAKE_KEY_D = 'sk-probe-e2e-0000';
  const G6_D = 'gpt-6-astra';

  // --- 夹具：沙箱 CODEX_HOME = 用户现状形态（requires_openai_auth=false、key 在 auth.json） ---
  fs.rmSync(CODEX_HOME_D, { recursive: true, force: true });
  fs.mkdirSync(CODEX_HOME_D, { recursive: true });
  const fixtureToml = [
    'model_provider = "custom"',
    'model = "gpt-6-astra"',
    '',
    '[model_providers.custom]',
    'name = "relay"',
    'base_url = "https://relay.invalid/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(CODEX_HOME_D, 'config.toml'), fixtureToml);
  fs.writeFileSync(path.join(CODEX_HOME_D, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: FAKE_KEY_D }));
  const cfgSha = hashFile(path.join(CODEX_HOME_D, 'config.toml'));
  const authSha = hashFile(path.join(CODEX_HOME_D, 'auth.json'));

  // 工作区启动器文件的内容快照：clearZoneIdentifiers 会删它们的 :Zone.Identifier（§10.8），内容绝不能变。
  // 范围与 launcher 的 clearZoneIdentifiers 一致（__dirname 下的 codex-launcher.js、lib/*、*.bat|cmd|txt）。
  // 排除 .tmp-* 临时文件：它们是开发/其它测试的草稿，归属别的进程，被谁删掉都不该算本测试的失败（§10.8 要守的是
  // 发行用的启动器文件），否则并发跑或临时文件被清理时会误报。
  const wsFiles = [path.join(ROOT, 'codex-launcher.js')];
  for (const d of ['lib']) { try { for (const f of fs.readdirSync(path.join(ROOT, d))) wsFiles.push(path.join(ROOT, d, f)); } catch (e) {} }
  try {
    for (const f of fs.readdirSync(ROOT)) {
      if (!/\.(bat|cmd|txt)$/i.test(f)) continue;
      if (/^\.tmp-/i.test(f)) continue;
      wsFiles.push(path.join(ROOT, f));
    }
  } catch (e) {}
  const wsBefore = new Map();
  for (const f of wsFiles) { try { wsBefore.set(f, hashFile(f)); } catch (e) {} }

  // 沙箱快捷方式目录的初始清单（用例 C 已在那里建过一个 .lnk）：两次普通模式运行前后必须一致
  let lnkBeforeD = [];
  try { lnkBeforeD = fs.readdirSync(SHORTCUT_DIR).filter(f => /\.lnk$/i.test(f)).sort(); } catch (e) {}

  // --- 第一次：完整重建（沙箱约 2GB 拷贝） ---
  // 环境变量与用例 A/B 相同的沙箱隔离。**不使用 CODEX_APP_DIR/--app-dir**（与 §8 原文的差异，故意为之）：
  //   §5.6/§10.7 与已实现的 tryCachedInstall（其中 `if (c.source === 'manual') return missing('manual 不走缓存')`）都明确"manual 不走缓存"，
  //   一旦指定 app-dir，两次运行都会走 manual 短路、discovery 永远不可能是 'cache'，
  //   §8 自己的"第二次 discovery==='cache'"断言就不可能成立。改为 NO_STORE+NO_EXTERNAL：
  //   只剩 fsScanDirs 一个来源（沙箱 %LOCALAPPDATA%\Programs\Codex），source='exe'，可走缓存。
  //   两次运行的 envKey 完全一致（NO_STORE/NO_EXTERNAL 相同、APP_DIR_ENV 为空、都不带 app-dir），缓存才可能命中。
  const envD1 = sandboxEnv('d1', { noStore: true, noExternal: true });
  envD1.CODEX_HOME = CODEX_HOME_D;
  // 第一次是冷启动完整重建（约 2GB 拷贝 + 重建），单次给足 20 分钟
  const rD1 = await run(process.execPath, [LAUNCHER, '--no-launch'],
    { env: envD1, cwd: ROOT, timeoutMs: TIMEOUT_REBUILD, log: 'caseD1-node-no-launch' });
  ok(rD1.code === 0, '第一次 node --no-launch 退出码 0（实际 ' + rD1.code + (rD1.timedOut ? '，超时' : '') + '，' + Math.round(rD1.ms / 1000) + 's）');
  const repD1 = readReport('d1');
  let overridesSha = null; // 第二次要断言覆盖文件内容不变
  const asarSnapD = snap(ASAR_D); // 第二次断言"没有重建"用（重建必然重写 app.asar -> mtime/size/哈希变化）
  const asarHashD = fs.existsSync(ASAR_D) ? hashFile(ASAR_D) : null; // 全量哈希，杜绝"同尺寸不同内容"的漏判
  if (ok(reportReady(repD1), '第一次报告已写出且可解析' + (repD1.__missing ? '（' + (repD1.__err || '文件不存在') + '）' : ''))) {
    ok(repD1.mode === 'normal' && repD1.exitCode === 0, '报告 mode === normal 且 exitCode === 0');
    const sel = repD1.selected || {};
    ok(sel.source === 'exe' && !!sel.appDir && nm(sel.appDir) === nm(INSTALL_DIR),
      '选中的是用例 1 的沙箱安装版且来源是文件系统扫描的 exe（source=' + JSON.stringify(sel.source) + ' appDir=' + String(sel.appDir) + '）');
    ok(!!sel.appDir && inSandbox(sel.appDir) && !nm(sel.appDir).startsWith(nm(REAL_MIRROR_ROOT) + '\\'), '选中路径在沙箱内且不是真实镜像');
    ok(sel.version === OLD_VERSION, '选中版本是旧版样本 ' + OLD_VERSION + '（实际 ' + JSON.stringify(sel.version) + '）');

    // --- 报告：timing（§5.6） ---
    const t1 = repD1.timing || {};
    ok(t1.discovery === 'full' || t1.discovery === 'manual',
      'REPORT.timing.discovery 为 full 或 manual（实际 ' + JSON.stringify(t1.discovery) + '）');
    info('第一次 timing: discovery=' + t1.discovery + ' discoveryMs=' + t1.discoveryMs + ' preLaunchMs=' + t1.preLaunchMs + ' totalMs=' + t1.totalMs);

    // --- 报告：net（§5.1） ---
    const net1 = repD1.net || {};
    const np1 = net1.patch || {};
    ok(np1.located === true, 'REPORT.net.patch.located === true（旧版样本里定位到 net bundle，规格 §1.3 实测命中 1）');
    if (np1.applied === true) {
      ok(np1.actual === 1 && typeof np1.rel === 'string' && np1.rel,
        'REPORT.net.patch.applied 且 actual===1、rel 非空（rel=' + JSON.stringify(np1.rel) + ' actual=' + np1.actual + '）');
    } else {
      // 规格 §8：形态不匹配时允许不 applied，但必须与 core.applyNetPatch 对同一 asar 的结果一致（在下面 asar 断言里核对）
      info('REPORT.net.patch.applied !== true（' + JSON.stringify(np1) + '）：按规格 §8 改为断言"与 core 对同一 asar 的结果一致"');
    }

    // --- 报告：覆盖文件内容（overrides）与诊断 ---
    // §5.1 把 overrides 定义为 null | 对象（普通模式的取值口径由 launcher 定），§8 真正要求的是"沙箱镜像根下
    // 存在覆盖文件"，所以这里只做兼容断言：是对象就逐字段核对，是 null 则跳过（下面文件级断言是硬要求）
    const ovr = net1.overrides;
    if (ovr === null || ovr === undefined) {
      info('REPORT.net.overrides 为 null：按 §5.1 允许（文件级断言在下面，§8 要求的是文件存在）');
    } else if (ok(typeof ovr === 'object', 'REPORT.net.overrides 是对象（' + JSON.stringify(ovr) + '）')) {
      ok(ovr.version === 1, 'REPORT.net.overrides.version === 1');
      ok(typeof ovr.writer === 'string' && /v14/.test(ovr.writer), 'REPORT.net.overrides.writer 含 v14（实际 ' + JSON.stringify(ovr.writer) + '）');
      ok(!!ovr.catalog && fs.existsSync(String(ovr.catalog)), 'REPORT.net.overrides.catalog 指向存在的文件（' + String(ovr.catalog) + '）');
      ok(nm(String(ovr.catalog)) === nm(MERGED_D), 'overrides.catalog 就是沙箱镜像根下的 model-catalog-merged.json');
      ok(!!ovr.auth && ovr.auth.provider === 'custom', 'overrides.auth.provider === "custom"（实际 ' + JSON.stringify(ovr.auth) + '）');
      ok(ovr.auth && ovr.auth.requiresOpenaiAuth === true, 'overrides.auth.requiresOpenaiAuth === true（§10.2 假阳性防线：注入函数的必要条件）');
      ok(!JSON.stringify(ovr).includes(FAKE_KEY_D), '报告里的 overrides 不含夹具假 key');
    }
    // diagnosis 的形态：§5.1（规格 :152）冻结报告字段为 `diagnosis: string|null`（判定码）。
    // 注意别和 §5.3 的 `decideAuthOverride → { provider, diagnosis }` 混淆——那是**纯函数**的返回值，
    // 报告里只该落字符串。这个字段在开发中漂移过两次（先整个人对象、后只留判定码），launcher 现在两处赋值
    // 都取 diag.diagnosis，并在 writeReport 里加了"对象→字符串"归一化（对象形态已不可达）。
    // 所以这里**收紧成字符串断言**：形态再漂移就直接失败并指出口径问题，而不是被兼容分支静默放过。
    const diag1 = net1.diagnosis;
    ok(typeof diag1 === 'string' && !!diag1,
      'REPORT.net.diagnosis 是字符串判定码（§5.1/§10.10 冻结 string|null；实际 ' + JSON.stringify(diag1) + '，type=' + typeof diag1 + '）');
    // 取判定码：形态若漂移成对象，仍把里面的值取出来继续核对下面的值断言（失败信息更有指向性）
    const diagCode = diag1 && typeof diag1 === 'object' ? diag1.diagnosis : diag1;
    ok(diagCode === 'direct-no-credential', 'REPORT.net.diagnosis 的判定码是 "direct-no-credential"（用户现状，实际 ' + JSON.stringify(diagCode) + '）');
    ok(!JSON.stringify(diag1).includes(FAKE_KEY_D), '报告里的 diagnosis 不含夹具假 key');
  }

  // --- 沙箱镜像产物 1：镜像 asar 里的 net 补丁（§8 核心断言） ---
  // 用 core 的只读接口按 §4.2 冻结签名 locateNetBundle(header, dataBase, fd) -> { rel, offset, size, node, text } | null
  const readNetText = asarPath => {
    const { header, dataBase } = coreNet.readAsar(asarPath);
    const fd = fs.openSync(asarPath, 'r');
    try {
      const e = coreNet.locateNetBundle(header, dataBase, fd);
      if (!e) return { entry: null, text: null };
      // core 的返回里自带 text（latin1 原文）；缺失时按 offset/size 回读兜底
      const text = typeof e.text === 'string' ? e.text
        : coreNet.readAsarEntry(fd, dataBase, { offset: Number(e.offset), size: Number(e.size) }).toString('latin1');
      return { entry: { rel: e.rel, offset: Number(e.offset), size: Number(e.size) }, text };
    } finally { fs.closeSync(fd); }
  };

  // 独立基真值（对"启动器重建用的同一份源 asar"跑 core.applyNetPatch）：先算出来，再决定"applied===true"是不是必断言
  let srcPatch = null; // { ok, actual }
  const INSTALL_ASAR_D = path.join(INSTALL_DIR, 'resources', 'app.asar');
  if (fs.existsSync(INSTALL_ASAR_D)) {
    try {
      const st = readNetText(INSTALL_ASAR_D);
      if (st.text) srcPatch = { entry: st.entry, res: coreNet.applyNetPatch(st.text) };
    } catch (e) { info('对源 asar 跑 applyNetPatch 失败: ' + e.message); }
  }
  if (srcPatch) {
    const r = srcPatch.res || {};
    info('源 asar（沙箱安装版，旧样本）net bundle: rel=' + (srcPatch.entry && srcPatch.entry.rel)
      + ' applyNetPatch -> ok=' + r.ok + ' actual=' + r.actual + '（injected text 长度 ' + (r.text ? r.text.length : 0) + '）');
  } else {
    info('未能对源 asar 得出 applyNetPatch 基真值（asar 不存在或 core 接口抛错），下面只做镜像侧断言');
  }

  if (ok(fs.existsSync(ASAR_D), '沙箱镜像已生成（' + ASAR_D + '）')) {
    let mirrorNet = null;
    try { mirrorNet = readNetText(ASAR_D); } catch (e) { info('读镜像 asar 的 net bundle 失败: ' + e.message); }
    const entry = mirrorNet && mirrorNet.entry, text = mirrorNet && mirrorNet.text;
    if (ok(!!entry && !!entry.rel, 'core.locateNetBundle 在沙箱镜像 asar 里找到含 CODEX_APP_SERVER_OPENAI_BASE_URL 的 bundle'
      + (entry ? '（' + entry.rel + '）' : ''))) {
      if (ok(typeof text === 'string' && text.length > 0, '读到 net bundle 文本（' + (text ? text.length : 0) + ' 字符）')) {
        const hasCore = coreNet.hasNetPatch(text);
        ok(hasCore === true, 'core.hasNetPatch(镜像 asar 里的 net bundle) === true（§10.3 修正后的判据：function launcherOverrides + 覆盖文件名）');
        const repNP = (repD1.net || {}).patch || {};
        if (srcPatch && srcPatch.res && srcPatch.res.ok === true) {
          // 形态匹配（源样本 NET_RE 命中 1）：必须真的 applied，且 actual===1
          ok(repNP.applied === true && repNP.actual === 1,
            'REPORT.net.patch.applied === true 且 actual === 1（源 asar 形态匹配时必断言；实际 applied=' + JSON.stringify(repNP.applied) + ' actual=' + JSON.stringify(repNP.actual) + '）');
        } else {
          // 形态不匹配（规格 §8 的兜底口径）：断言报告结论与 core.applyNetPatch 对同一 asar 的结果一致，并在输出里写明
          const same = !!repNP.applied === !!(srcPatch && srcPatch.res && srcPatch.res.ok);
          ok(same, '源 asar 形态不匹配，改为断言一致性：报告 applied=' + JSON.stringify(repNP.applied)
            + '、core.applyNetPatch.ok=' + JSON.stringify(srcPatch && srcPatch.res && srcPatch.res.ok) + '（两者一致=' + same + '）');
          info('注意：源 asar 上 applyNetPatch 未命中，本轮的 401/Ultrafast 修复在该版本不可用（报告 located=' + JSON.stringify(repNP.located) + '）');
        }
        // 追加断言（§10.8 第 1 条）：evalNetArgs 跑出的参数里 model_catalog_json= 与 requires_openai_auth= 两项都在。
        // 假 process：execPath 指向沙箱镜像的 ChatGPT.exe、CODEX_HOME 指向沙箱 CODEX_HOME —— 与真实运行形态一致。
        // 走隔离子进程（见 evalNetArgsGuarded 注释）：同步死循环回归时本测试必须失败，而不是挂死门禁
        const fakeProc = { execPath: path.join(MIRROR_D, 'ChatGPT.exe'), env: { CODEX_HOME: CODEX_HOME_D } };
        const ev = evalNetArgsGuarded(text, fakeProc, 60 * 1000);
        if (!ev.ok) info('evalNetArgs 未取得参数: ' + ev.error);
        const args = ev.args;
        if (ok(Array.isArray(args), 'core.evalNetArgs 返回参数数组（' + JSON.stringify(args) + '）' + (ev.error ? '；错误: ' + ev.error : ''))) {
          const catArg = args.find(a => typeof a === 'string' && a.startsWith('model_catalog_json='));
          ok(!!catArg, '参数里有 model_catalog_json=（' + String(catArg) + '）');
          const authArg = args.find(a => typeof a === 'string' && /^model_providers\..*\.requires_openai_auth=true$/.test(a));
          ok(!!authArg, '参数里有 model_providers.<id>.requires_openai_auth=true（' + String(authArg) + '）');
          const iApp = args.indexOf('app-server');
          ok(iApp >= 0, '参数里含 app-server 子命令');
          ok(iApp >= 0 && args.indexOf(authArg) > iApp, '鉴权覆盖位于 app-server 之后（§10.4：放前面不生效）');
          if (catArg) {
            let catPath = null;
            try { catPath = JSON.parse(catArg.slice('model_catalog_json='.length)); } catch (e) {}
            ok(!!catPath && fs.existsSync(catPath), '参数里的 model_catalog_json 指向存在的合并目录（' + String(catPath) + '）');
          }
          ok(!JSON.stringify(args).includes(FAKE_KEY_D), '参数里不含夹具假 key（key 只在 auth.json 里）');
        }
      }
    }
  }

  if (ok(fs.existsSync(OVERRIDES_D), '沙箱镜像根下有覆盖文件 ' + OVERRIDES_D)) {
    let ovr = null;
    try { ovr = JSON.parse(fs.readFileSync(OVERRIDES_D, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
    if (ok(!!ovr, '覆盖文件可解析')) {
      ok(ovr.version === 1, '覆盖文件 version === 1');
      ok(!!ovr.catalog && fs.existsSync(String(ovr.catalog)), '覆盖文件 catalog 指向存在的文件');
      ok(nm(String(ovr.catalog)) === nm(MERGED_D), '覆盖文件 catalog === ' + MERGED_D);
      ok(!!ovr.auth && ovr.auth.provider === 'custom' && ovr.auth.requiresOpenaiAuth === true,
        '覆盖文件 auth = {provider:"custom", requiresOpenaiAuth:true}（实际 ' + JSON.stringify(ovr.auth) + '）');
      ok(!JSON.stringify(ovr).includes(FAKE_KEY_D), '覆盖文件里找不到夹具假 key');
    }
    try { overridesSha = hashFile(OVERRIDES_D); } catch (e) {}
  }
  if (ok(fs.existsSync(MERGED_D), '沙箱镜像根下有合并目录 ' + MERGED_D)) {
    let cat = null;
    try { cat = JSON.parse(fs.readFileSync(MERGED_D, 'utf8')); } catch (e) {}
    if (ok(!!cat && Array.isArray(cat.models), '合并目录可解析且含 models 数组')) {
      const g6 = cat.models.find(m => m && m.slug === G6_D);
      if (ok(!!g6, '合并目录里有内置 slug ' + G6_D)) {
        const tiers = (g6.service_tiers || []).map(t => t && t.id);
        ok(tiers.includes('priority'), G6_D + ' 的 service_tiers 含 priority（实际 ' + JSON.stringify(tiers) + '）');
        ok(tiers.includes('ultrafast'), G6_D + ' 的 service_tiers 含 ultrafast（Ultrafast 生效的前提，§1.1）');
      }
      // §8 原话：所有内置 gpt-* slug 的 service_tiers 含 priority 与 ultrafast。
      // §10.5 实测内置目录 11 个模型里 8 个 gpt-* 原本只有 priority（gpt-daybreak-* 为空）；
      // §5.2 规则 3 对**每个内置 slug** 都补 priority + ultrafast，这里按"全部 gpt-* 都要有"断言
      const gpts = cat.models.filter(m => m && typeof m.slug === 'string' && /^gpt-/.test(m.slug));
      const gptBoth = gpts.filter(m => (m.service_tiers || []).some(t => t && t.id === 'priority')
        && (m.service_tiers || []).some(t => t && t.id === 'ultrafast'));
      ok(gpts.length >= 8 && gptBoth.length === gpts.length,
        '所有内置 gpt-* slug（' + gpts.length + ' 个，§10.5 实测应 ≥8）的 service_tiers 都含 priority 与 ultrafast（实际齐全 ' + gptBoth.length + ' 个）');
    }
  }
  // §5.8：process.execPath 含不安全字符时启动器**故意**不写（并删掉旧的）。node 装在
  // "C:\Program Files (x86)\..." 这类带括号的路径时就会这样，此时"文件存在"不是必须的，
  // 硬断言会误报。这里按同一字符集自查（与 launcher 的 NODE_PATH_SAFE_RE、entry 的 findstr 白名单同源），
  // 只在不安全时才要求节点不存在。
  const NODE_SAFE_RE = /^[A-Za-z0-9 _.:\\/-]+$/;
  const exeSafe = NODE_SAFE_RE.test(String(process.execPath));
  if (!exeSafe) {
    ok(!fs.existsSync(NODE_PATH_D), 'node 路径含不安全字符（' + process.execPath + '），按 §5.8 启动器不写 node-path.txt（当前确实没有）');
  } else if (ok(fs.existsSync(NODE_PATH_D), '沙箱镜像根下有 node-path.txt（§5.8；§10.8 定：--no-launch 也写）')) {
    const np = fs.readFileSync(NODE_PATH_D, 'utf8');
    ok(!np.startsWith('\uFEFF'), 'node-path.txt 无 BOM');
    ok(np.includes('\r\n') || np.endsWith('\n'), 'node-path.txt 以换行结尾（CRLF）');
    ok(nm(np.split(/\r?\n/)[0]) === nm(process.execPath), 'node-path.txt 第一行是当前 node（' + np.split(/\r?\n/)[0] + '）');
    // 端到端核对 §5.8 ↔ §7.1：让 lib/find-node.cmd 真的去读启动器刚写下的这个文件（entry 的 `:trycache` 要求
    // 文件名是 node.exe、且整份文件过 findstr 白名单）。这一条覆盖 entry 明确说"本轮未验证"的联调：
    // 启动器写 node-path.txt -> bat 的 find-node 读回。cwd=工作区（命令行里全是 ASCII，无中文路径问题），
    // 环境用沙箱（USERPROFILE 必须指向沙箱，缓存才是启动器写的那份）；清掉 CODEX_NODE 免得它抢占候选 1。
    //
    // 关键：把 PATH 收窄到 System32（保留 findstr/reg 这些系统命令，但拿掉 PATH 上的 node.exe），
    // 否则"返回了 process.execPath"可能来自候选 7（where node.exe 命中 PATH 上同一个 node），
    // 那条断言就变成恒真、读不到缓存也照样通过。收窄后候选 7 失效，返回 process.execPath 只可能来自缓存。
    // （实测反向对照：把缓存内容改坏 -> 返回的是商店包里的 node，证明该断言确以缓存命中为前提。）
    const fnEnv = sandboxEnv('d-findnode', { noStore: true, noExternal: true });
    delete fnEnv.CODEX_NODE;
    fnEnv.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    // 注意用 `set NODE` 而不是 `echo %NODE%`：cmd 在解析整行时就展开了 %NODE%，那样只会打印字面量
    // （实测对照：`call ... & echo NODE=%NODE%` -> "NODE=%NODE%"；`call ... & set NODE` -> 真实值）。
    // 成功路径 stdout 实测全 ASCII（0 个非 ASCII 字符），所以 encoding:'utf8' 解码不会出乱码；
    // 若将来放宽 NODE_PATH_SAFE_RE，这里会以"找不到 NODE="的形式失败，而不是乱码比对失败。
    const fn = spawnSync('cmd.exe', ['/d /c call lib\\find-node.cmd & set NODE'],
      { cwd: ROOT, env: fnEnv, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 120000 });
    const fnOut = (fn.stdout || '').trim();
    const mNode = fnOut.match(/^NODE=(.*)$/m);
    const gotNode = mNode ? mNode[1].trim() : '';
    ok(!!gotNode, 'find-node.cmd 在沙箱环境里找到了 node（NODE=' + JSON.stringify(gotNode) + '；输出 ' + JSON.stringify(fnOut.slice(0, 200)) + '）');
    ok(!!gotNode && nm(gotNode) === nm(process.execPath),
      'find-node.cmd 命中的正是启动器写进 node-path.txt 的那个 node（' + JSON.stringify(gotNode) + '，期望 ' + JSON.stringify(process.execPath) + '）');
  }

  // --- 夹具没被动过 + 假 key 没有泄漏到沙箱里 ---
  ok(hashFile(path.join(CODEX_HOME_D, 'config.toml')) === cfgSha, '沙箱 config.toml 的 sha256 未变');
  ok(hashFile(path.join(CODEX_HOME_D, 'auth.json')) === authSha, '沙箱 auth.json 的 sha256 未变');
  const repD1Text = safeRead(path.join(SANDBOX, 'report-d1.json'));
  ok(!repD1Text.includes(FAKE_KEY_D), '第一次报告文件里找不到夹具假 key');
  const ovrText = safeRead(OVERRIDES_D);
  ok(!ovrText.includes(FAKE_KEY_D), '覆盖文件里找不到夹具假 key（逐字节）');
  ok(!safeRead(MERGED_D).includes(FAKE_KEY_D), '合并目录里找不到夹具假 key');

  // --- 第二次：不改任何东西，应走安装缓存快路径 ---
  // 与第一次完全相同的环境（envKey 必须一致，否则缓存恒不命中）
  const envD2 = sandboxEnv('d2', { noStore: true, noExternal: true });
  envD2.CODEX_HOME = CODEX_HOME_D;
  const rD2 = await run(process.execPath, [LAUNCHER, '--no-launch'],
    { env: envD2, cwd: ROOT, timeoutMs: TIMEOUT_LAUNCHER, log: 'caseD2-node-no-launch' });
  ok(rD2.code === 0, '第二次 node --no-launch 退出码 0（实际 ' + rD2.code + (rD2.timedOut ? '，超时' : '') + '，' + Math.round(rD2.ms / 1000) + 's）');
  const repD2 = readReport('d2');
  if (ok(reportReady(repD2), '第二次报告已写出且可解析')) {
    const t2 = repD2.timing || {};
    ok(t2.discovery === 'cache', 'REPORT.timing.discovery === "cache"（第二次应命中安装缓存，实际 ' + JSON.stringify(t2.discovery) + '）');
    ok(typeof t2.preLaunchMs === 'number' && t2.preLaunchMs < 3000,
      'REPORT.timing.preLaunchMs < 3000（实际 ' + JSON.stringify(t2.preLaunchMs) + 'ms；§10.7 实测预算约 250ms。若门禁机器磁盘极慢可能抖动，此值即诊断用）');
    info('第二次 timing: discovery=' + t2.discovery + ' discoveryMs=' + t2.discoveryMs + ' preLaunchMs=' + t2.preLaunchMs + ' totalMs=' + t2.totalMs);
    // "没有重建"用镜像 asar 的全量 sha256 判定（541MB 读一次约 1~2s，可接受），不看报告字段名——
    // 重建必然重写 app.asar，哈希变化即证明真的重建了；比"REPORT.patch === null"更贴近"没有重建"的语义
    ok(asarHashD !== null && fs.existsSync(ASAR_D) && hashFile(ASAR_D) === asarHashD,
      '第二次没有重建（沙箱镜像 app.asar 的 sha256 未变）');
    ok(sameSnap(asarSnapD, snap(ASAR_D)), '第二次没有重建（app.asar 的 size/mtime 也未变）');
    ok(fs.existsSync(ASAR_D) && nm((repD2.selected || {}).appDir || '') === nm(INSTALL_DIR), '第二次仍选中同一个沙箱安装版');
    // 第二次走的是"没重建"分支：launcher 用 netPatchState() 只读镜像 asar 得出结论（runOnce 里
    // `if (!NET_STATE.patch) NET_STATE.patch = netPatchState()`），与第一次（rebuild 里写 NET_STATE.patch）
    // 是两段独立代码，历史上键集不一致过，所以即使是同一次运行的第二次也要单独核对结论。
    // 现在两侧已同构，都返回 { located, applied, actual, rel, present, reason }。
    // 断言只压在 §10.10 冻结的 located/applied/actual/rel 上（present/reason 是未冻结的附加键，
    // 见下面那行只做交叉核对）——这样将来它们即使被去掉也不会误伤 e2e。
    const np2 = (repD2.net || {}).patch || {};
    ok(np2.applied === true && np2.actual === 1 && !!np2.rel,
      '第二次报告的 net.patch 也认为补丁在位（applied=' + JSON.stringify(np2.applied)
      + ' actual=' + JSON.stringify(np2.actual) + ' rel=' + JSON.stringify(np2.rel) + '）');
    // present 是附加键（§10.10 只冻结 located/applied/actual/rel），且在两侧实现里都恒等于 applied
    // （netPatchState: applied=present；rebuild: present=!!(netDoc&&netApp.ok)=applied），所以只做交叉核对：
    // 存在就必须为 true，不存在不判失败——不把 e2e 绑到未冻结的键上
    if (np2.present !== undefined) ok(np2.present === true, 'net.patch.present 与 applied 同义（存在则应为 true）');
  }
  ok(!fs.existsSync(path.join(MIRROR_SB, 'launcher.lock')), '第二次结束后没有残留 launcher.lock');
  ok(!safeRead(path.join(SANDBOX, 'report-d2.json')).includes(FAKE_KEY_D), '第二次报告文件里找不到夹具假 key');
  if (overridesSha) ok(fs.existsSync(OVERRIDES_D) && hashFile(OVERRIDES_D) === overridesSha, '第二次没有改写覆盖文件（内容 sha256 不变，§5.3 内容没变不重写）');
  ok(hashFile(path.join(CODEX_HOME_D, 'config.toml')) === cfgSha && hashFile(path.join(CODEX_HOME_D, 'auth.json')) === authSha,
    '两次运行后沙箱 config.toml / auth.json 的 sha256 仍未变');

  // --- §10.8：clearZoneIdentifiers 删的是真实工作区文件的 ADS，不是沙箱——显式接受，只断言内容没变 ---
  let wsChanged = 0, wsMissing = 0;
  for (const [f, h] of wsBefore) {
    try { if (hashFile(f) !== h) wsChanged++; } catch (e) { wsMissing++; }
  }
  ok(wsChanged === 0 && wsMissing === 0, '真实工作区的启动器文件内容未被改动（' + wsBefore.size + ' 个文件，变更 ' + wsChanged + '、缺失 ' + wsMissing
    + '；clearZoneIdentifiers 只删这些文件的 :Zone.Identifier ADS，§10.8——不对 ADS 的存在性做断言）');

  // --- §10.8 第 2 条：沙箱 codex.exe 的 debug models 输出必须真的能 JSON.parse（直接覆盖 §10.5 的坑） ---
  // §10.5：CODEX_HOME 在 %TEMP% 下时 codex 会往 stderr 打 WARNING，而启动器把 stdout+stderr 写进同一文件，
  // 于是 JSON.parse 失败（v13 正是这样在用户 %TEMP% 下一直失败）。这里复刻同一口径：临时 CODEX_HOME 放在
  // 沙箱镜像根下（不是 %TEMP%）、合并两个流、按规格的兜底"丢弃第一个 { 之前的内容"后再 parse。
  const CODEX_EXE_D = path.join(MIRROR_D, 'resources', 'codex.exe');
  const CAT_HOME_D = path.join(MIRROR_SB, '.tmp-catalog-e2e'); // 放 MIRROR_ROOT 下：不在 %TEMP%，避开 §10.5 的警告
  if (ok(fs.existsSync(CODEX_EXE_D), '沙箱镜像里有 codex.exe（' + CODEX_EXE_D + '）')) {
    fs.rmSync(CAT_HOME_D, { recursive: true, force: true });
    fs.mkdirSync(CAT_HOME_D, { recursive: true });
    let out = '', err = '', status = null;
    try {
      const r = spawnSync(CODEX_EXE_D, ['debug', 'models', '--bundled'],
        { env: { ...envD2, CODEX_HOME: CAT_HOME_D }, encoding: 'utf8', timeout: TIMEOUT_QUICK, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      out = r.stdout || ''; err = r.stderr || ''; status = r.status;
    } catch (e) { info('运行沙箱 codex.exe 失败: ' + e.message); }
    const combined = out + err; // 与 launcher 的 runCaptured 同口径：stdout+stderr 进同一个文件
    const iBrace = combined.indexOf('{');
    let cat = null;
    if (iBrace >= 0) { try { cat = JSON.parse(combined.slice(iBrace)); } catch (e) { info('JSON.parse 失败: ' + e.message); } }
    ok(status === 0, '沙箱 codex.exe debug models --bundled 退出码 0（实际 ' + JSON.stringify(status) + '）');
    ok(!!cat && Array.isArray(cat.models) && cat.models.length > 0,
      '沙箱 codex.exe 的输出（合并 stdout+stderr、丢弃第一个 { 之前的内容）JSON.parse 成功且含 models（'
      + (cat ? cat.models.length + ' 个模型' : '解析失败') + '）');
    // 直接证据：CODEX_HOME 不在 %TEMP% 时合并输出应"干净"（首字符即 {）——异常时打印出来便于诊断，但不作为硬断言
    info('codex.exe 合并输出首字符: ' + JSON.stringify(combined.trimStart().slice(0, 40)) + (err ? ('；stderr=' + JSON.stringify(err.trim().slice(0, 120))) : ''));
    const g6sb = cat && cat.models.find(m => m && m.slug === G6_D);
    ok(!!g6sb, '沙箱 codex.exe 的内置目录里有 ' + G6_D + '（合并目录的底座）');
    fs.rmSync(CAT_HOME_D, { recursive: true, force: true });
  }

  // --- 沙箱里的启动器镜像绝不可能是真实镜像（防御性核对） ---
  ok(nm(MIRROR_SB) !== nm(REAL_MIRROR_ROOT) && !nm(MIRROR_SB).startsWith(nm(REAL_MIRROR_ROOT) + '\\'),
    '沙箱镜像目录与真实镜像目录不同（' + MIRROR_SB + ' vs ' + REAL_MIRROR_ROOT + '）');
  // 快捷方式一律只在沙箱目录里（§10.8）。--no-launch 时启动器不会走 maybeAutoShortcut（没有 launched），
  // 所以这里断言的是"第二次运行没有改动/新增快捷方式"，而不是"新建了快捷方式"
  let lnkD = [];
  try { lnkD = fs.readdirSync(SHORTCUT_DIR).filter(f => /\.lnk$/i.test(f)).sort(); } catch (e) {}
  ok(lnkD.every(f => inSandbox(path.join(SHORTCUT_DIR, f))), '快捷方式目录在沙箱内（' + SHORTCUT_DIR + '）');
  ok(JSON.stringify(lnkD) === JSON.stringify(lnkBeforeD), '两次普通模式运行没有新增/删改沙箱快捷方式（' + JSON.stringify(lnkD) + '）');
  noLeftovers('用例 D');

  // --- 用例 D 结束：清理沙箱镜像大文件（约 2GB） ---
  head('用例 D 清理：删除沙箱镜像大文件');
  rmBig(MIRROR_SB);
  ok(!fs.existsSync(MIRROR_SB), '沙箱镜像大文件已删除（' + MIRROR_SB + '）');
}

// 读文件为字符串（失败返回空串；只用于"不该出现某字符串"的断言）
function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

// 用例 C：发行 zip（门禁里 pack.py 先生成）解压到含空格/&/中文的目录，从该目录建快捷方式，
// 读回 .lnk 断言 TargetPath/Arguments/WorkingDirectory/IconLocation，再按 .lnk 的 Arguments 执行 --self-test
async function caseC() {
  head('用例 C：发行包 --create-shortcut + 按 .lnk Arguments 执行 --self-test');
  if (!ok(fs.existsSync(DIST_ZIP), '发行包 dist\\Codex解锁启动器.zip 存在（门禁里 pack.py 先生成）')) return;
  // 用例 C 的 TEMP 位置同前：沙箱内的 AppData\Local\Temp 子目录（不在解压目录之上）。
  // 再删一次（A/B 里启动器的兜底已把它建回来），同样从"TEMP 目录不存在"开始跑
  fs.rmSync(SANDBOX_TEMP, { recursive: true, force: true });
  fs.mkdirSync(SPACE_DIR, { recursive: true });
  const rx = await run('python', ['-X', 'utf8', '-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', DIST_ZIP, SPACE_DIR],
    { timeoutMs: TIMEOUT_QUICK, log: 'caseC-unzip' });
  // bat 靠 lib\find-node.cmd 找 node；缺了它 --self-test 会以 [E2] 退出 1（pack.py 应已把它打进 zip）
  const filesOk = rx.code === 0 && fs.existsSync(path.join(EXTRACT_ROOT, 'codex-launcher.js'))
    && fs.existsSync(path.join(EXTRACT_ROOT, 'lib', 'launcher-core.js'))
    && fs.existsSync(path.join(EXTRACT_ROOT, 'lib', 'find-node.cmd'))
    && fs.existsSync(path.join(EXTRACT_ROOT, '启动Codex解锁版.bat'));
  if (!ok(filesOk, '解压发行包到 "dir with space & 中文"（codex-launcher.js / lib / find-node.cmd / bat 齐全）')) return;

  // 从该目录建快捷方式（不带 CODEX_LAUNCHER_BAT：走 __dirname\启动Codex解锁版.bat 回退，§6）。
  // 注意：启动器的"bat 位于临时目录不建快捷方式"规则对普通模式与 --create-shortcut 统一生效
  // （codex-launcher.js 的 createShortcuts 里判断），所以 TEMP 指到沙箱内的 AppData\Local\Temp 子目录，
  // 让解压目录（沙箱\dir with space & 中文\）不在 os.tmpdir() 之下，这里才能正常建出 .lnk
  const envC = sandboxEnv('c1', { noStore: true, noExternal: true });
  const rC = await run(process.execPath, [path.join(EXTRACT_ROOT, 'codex-launcher.js'), '--create-shortcut'],
    { env: envC, cwd: EXTRACT_ROOT, timeoutMs: TIMEOUT_LAUNCHER, log: 'caseC-create-shortcut' });
  ok(rC.code === 0, '--create-shortcut 退出码 0（实际 ' + rC.code + '）');
  const repC = readReport('c1');
  const lnkPath = path.join(SHORTCUT_DIR, 'Codex 解锁版.lnk');
  if (ok(reportReady(repC), 'create-shortcut 报告已写出且可解析')) {
    ok(repC.mode === 'create-shortcut' && repC.exitCode === 0, '报告 mode === create-shortcut 且 exitCode === 0');
    const sc = Array.isArray(repC.shortcuts) ? repC.shortcuts : [];
    ok(sc.length === 1 && inSandbox((sc[0] || {}).path || ''),
      '报告里恰好一条快捷方式且落在沙箱目录（' + JSON.stringify(sc.map(s => (s.path || 'null') + ' ' + s.action + (s.reason ? ' ' + s.reason : ''))) + '）');
  }
  let lnks = [];
  try { lnks = fs.readdirSync(SHORTCUT_DIR).filter(f => /\.lnk$/i.test(f)); } catch (e) {}
  ok(lnks.length === 1, '快捷方式目录恰好一个 .lnk（实际 ' + JSON.stringify(lnks) + '；0 个时常见原因是解压目录落在 os.tmpdir() 之下被 §6 规则跳过）');
  if (!lnks.length) return;
  const lnk = path.join(SHORTCUT_DIR, lnks[0]);
  ok(nm(lnk) === nm(lnkPath), '快捷方式名字是 "Codex 解锁版.lnk"（实际 ' + lnks[0] + '）');
  ok(!fs.existsSync(path.join(MIRROR_SB, 'app', 'resources', 'app.asar')), '--create-shortcut 没有构建镜像');
  ok(!fs.existsSync(path.join(MIRROR_SB, 'launcher.lock')), '--create-shortcut 没有留锁');

  // 读回 .lnk（WScript.Shell）。
  // 必须用**沙箱环境**读，不能用 process.env：IconLocation 指向 MIRROR_ROOT 下的图标，而该路径在
  // 沙箱用户的 profile 里，Windows 的 shell 会把它存成环境变量形态的 `%USERPROFILE%\ChatGPT-Patched\
  // Codex解锁版.ico`（.lnk 的标准 EnvironmentVariableDataBlock；实测原始字节就是这串字面量），
  // **读取时才用读取方的环境展开**。用真实环境读会展开成真实镜像路径（实测：同一个 .lnk 用真实环境读是
  // C:\Users\<真实用户>\ChatGPT-Patched\...，用沙箱环境读才是沙箱路径），断言就会误判成"图标指向真实镜像"。
  // 用创建时的同一份沙箱环境读，等价于"沙箱用户双击这个快捷方式"，才是忠实口径。
  const rl = psRun('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
    + ' $sh=New-Object -ComObject WScript.Shell; $l=$sh.CreateShortcut($env:CODEX_E2E_LNK);'
    + ' [pscustomobject]@{TargetPath=$l.TargetPath;Arguments=$l.Arguments;WorkingDirectory=$l.WorkingDirectory;IconLocation=$l.IconLocation} | ConvertTo-Json -Compress',
    { ...envC, CODEX_E2E_LNK: lnk });
  let li = null;
  try { li = JSON.parse(rl.out); } catch (e) {}
  if (ok(!!li, '读回 .lnk 成功' + (li ? '' : '（' + (rl.err || rl.out || rl.error || 'ConvertTo-Json 无输出') + '）'))) {
    info('TargetPath=' + li.TargetPath + ' Arguments=' + li.Arguments);
    info('WorkingDirectory=' + li.WorkingDirectory + ' IconLocation=' + li.IconLocation);
    ok(/system32\\cmd\.exe$/i.test(String(li.TargetPath || '')), 'TargetPath 指向 System32\\cmd.exe（绕开 bat 的 MOTW 提示）');
    const expectArgs = '/d /c ""' + path.join(EXTRACT_ROOT, '启动Codex解锁版.bat') + '""';
    ok(String(li.Arguments || '').trim() === expectArgs, 'Arguments === /d /c ""<bat>""（实际 ' + JSON.stringify(li.Arguments) + '）');
    ok(nm(li.WorkingDirectory || '\\') === nm(EXTRACT_ROOT), 'WorkingDirectory 是发行包所在目录');
    const iconPath = String(li.IconLocation || '').replace(/,\s*\d+$/, '');
    let iconBytesOk = false;
    try {
      const want = fs.readFileSync(path.join(INSTALL_DIR, 'resources', 'icon-chatgpt.ico'));
      const got = fs.readFileSync(iconPath);
      iconBytesOk = got.equals(want) || got.equals(fs.readFileSync(path.join(INSTALL_DIR, 'resources', 'chatgpt-app-light.ico')));
    } catch (e) {}
    ok(nm(iconPath) === nm(path.join(MIRROR_SB, 'Codex解锁版.ico')) && fs.existsSync(iconPath),
      'IconLocation 指向镜像目录里的 Codex解锁版.ico（' + iconPath + '）');
    ok(iconBytesOk, '图标是从选中安装的 resources 复制来的（与 icon-chatgpt.ico 字节一致）');
  }
  if (!li) { ok(false, '读回 .lnk 失败，跳过"按 .lnk 的 Arguments 执行 --self-test"'); return; }

  // 按 .lnk 里的 Arguments 原样 + " --self-test" 用 cmd 执行（windowsVerbatimArguments、stdin 忽略）
  // 先给 bat 打上 :Zone.Identifier，验证 --self-test 严格只读、不会删标记（§10.6）
  const ads = path.join(EXTRACT_ROOT, '启动Codex解锁版.bat') + ':Zone.Identifier';
  let adsOk = false;
  try { fs.writeFileSync(ads, '[ZoneTransfer]\r\nZoneId=3\r\n'); adsOk = fs.existsSync(ads); } catch (e) {}
  ok(adsOk, '前置：已给发行包里的 bat 打上 :Zone.Identifier 标记');
  const rS = await run('cmd.exe', [String(li.Arguments).replace(/\s+$/, '') + ' --self-test'],
    { verbatim: true, env: sandboxEnv('c2', { noStore: true, noExternal: true }), cwd: EXTRACT_ROOT, timeoutMs: TIMEOUT_LAUNCHER, log: 'caseC-selftest' });
  ok(rS.code === 0, '按 .lnk 的 Arguments 执行 --self-test 退出码 0（实际 ' + rS.code + (rS.timedOut ? '，超时' : '') + '）');
  const repS = readReport('c2');
  if (ok(reportReady(repS), 'self-test 报告已写出且可解析')) {
    ok(repS.mode === 'self-test' && repS.exitCode === 0, '报告 mode === self-test 且 exitCode === 0');
    const sel = repS.selected || {};
    ok(sel.source === 'exe' && sel.version === OLD_VERSION, 'self-test 选中的是沙箱旧版安装版（' + String(sel.source) + ' / ' + String(sel.version) + '）');
    const ps = repS.patch || {};
    ok(ps.total === 15 && ps.ok === 15, 'self-test 内存试跑 15/15 命中（total=' + ps.total + ' ok=' + ps.ok + '）');
  }
  if (adsOk) ok(fs.existsSync(ads), '--self-test 没有删除 :Zone.Identifier（严格只读，§10.6）');
  ok(!fs.existsSync(path.join(MIRROR_SB, 'app', 'resources', 'app.asar')), '--self-test 没有构建镜像');
  ok(!fs.existsSync(path.join(MIRROR_SB, 'launcher.lock')), '--self-test 没有建锁');
  let lnks2 = [];
  try { lnks2 = fs.readdirSync(SHORTCUT_DIR).filter(f => /\.lnk$/i.test(f)); } catch (e) {}
  ok(lnks2.length === 1, '--self-test 没有碰快捷方式（仍然只有一个 .lnk）');
}

// evalNetArgs 隔离执行：evalNetArgs 是**同步**函数，历史上出现过 while(exec) 漏 g 导致的同步死循环：
// 那会把本进程的事件循环占死，e2e 自己的 run() 超时与 60 分钟总预算全部失效，门禁永久挂住。
// 故不在本进程调用它，改用一个隔离子进程跑（spawnSync 的 timeout 能杀掉同步死循环，实测 3024ms / SIGTERM / ETIMEDOUT）。
// 返回 { ok, args, error }：正常时 ok=true、args 为参数数组；抛错/超时/输出不可解析时 ok=false 并带中文原因。
// 子进程用 -e 执行内联脚本，参数经 process.argv 传入（实测 `node -e <code> A B C` 时 argv=[execPath,'A','B','C']）。
function evalNetArgsGuarded(bundleText, fakeProcess, timeoutMs) {
  const script = [
    "const core=require(process.argv[1]);",
    // 按 latin1 回读：bundle 是 latin1 写出去的，用 utf8 读会把 0x80~0xFF 变成 U+FFFD 替换字符，
    // 参数抽取/补丁判据就废了（当前样本实测全 ASCII，但别把这条依赖留在代码里）
    "const text=require('fs').readFileSync(process.argv[2],'latin1');",
    "const fake=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8'));",
    "process.stdout.write(JSON.stringify({ok:true,args:core.evalNetArgs(text,fake)}));",
  ].join('');
  const tmpDir = path.join(SANDBOX, '.tmp-evalargs-' + process.pid);
  let bundleFile = null, fakeFile = null;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    bundleFile = path.join(tmpDir, 'bundle.js');
    fakeFile = path.join(tmpDir, 'fake.json');
    fs.writeFileSync(bundleFile, Buffer.from(bundleText, 'latin1'));
    fs.writeFileSync(fakeFile, JSON.stringify(fakeProcess));
    // 子进程环境显式把 CODEX_HOME 钉在沙箱：evalNetArgs 只经 fakeProcess.env 看 home，正常路径已隔离；
    // 这是纵深防御——万一 core 将来改成读真实 process.env，也仍然读不到真实 ~/.codex（安全红线）
    const childEnv = { ...process.env, CODEX_HOME: String(fakeProcess && fakeProcess.env && fakeProcess.env.CODEX_HOME || SANDBOX) };
    const r = spawnSync(process.execPath, ['-e', script, path.join(ROOT, 'lib', 'launcher-core.js'), bundleFile, fakeFile],
      { encoding: 'utf8', timeout: timeoutMs || 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: childEnv });
    if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, args: null, error: 'evalNetArgs 超时（被隔离进程杀掉，可能是同步死循环回归）' };
    if (r.status !== 0) {
      const msg = String((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(0, 3).join(' | ');
      return { ok: false, args: null, error: 'evalNetArgs 子进程退出码 ' + r.status + (msg ? '：' + msg : '') };
    }
    let parsed = null;
    try { parsed = JSON.parse((r.stdout || '').trim()); } catch (e) {}
    if (!parsed || !Array.isArray(parsed.args)) return { ok: false, args: null, error: 'evalNetArgs 子进程输出无法解析: ' + JSON.stringify((r.stdout || '').slice(0, 200)) };
    return { ok: true, args: parsed.args, error: null };
  } catch (e) {
    return { ok: false, args: null, error: e.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) {}
  }
}

// 删除大目录（失败重试；仍失败算测试失败，避免留下几个 GB 的沙箱）
function rmBig(p) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch (e) {}
    if (!fs.existsSync(p)) return;
    // Windows 上被占用的句柄可能延迟释放，等 1 秒再试
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  }
}

// ---------- 收尾 ----------
(async () => {
  try {
    await main();
  } catch (e) {
    ok(false, '未捕获异常: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  } finally {
    // 无论成败都清理沙箱里的大文件（2~4GB），日志保留在 .tmp-sandbox-logs\
    head('清理');
    rmBig(SANDBOX);
    ok(!fs.existsSync(SANDBOX), '沙箱已删除（' + SANDBOX + '）');
  }
  const elapsed = Math.round((Date.now() - T0) / 1000);
  console.log('\n检查 ' + checks + ' 项，耗时 ' + elapsed + 's（总预算 ' + Math.round(BUDGET_MS / 1000) + 's），日志: ' + LOG_DIR);
  console.log(failures === 0 ? 'all passed' : failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})();
