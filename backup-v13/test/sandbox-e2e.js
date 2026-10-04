// 黑盒端到端测试（规格 §8 用例 1~6，慢，几分钟、真实 2GB 拷贝；由主控门禁运行）
//   node test/sandbox-e2e.js
//
// 与启动器只通过 bat / 命令行参数 / 环境变量 / CODEX_LAUNCHER_REPORT JSON 报告交互：
// 不 require 启动器内部，不解析中文日志。依赖的启动器接口（规格 §9 + §10.6/§10.7，冻结）：
//   - 参数: --dry-run（完整重建到 staging 后删除，不落地镜像）、--create-shortcut、--self-test（严格只读）
//   - 环境变量: USERPROFILE/HOME/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/APPDATA/CODEX_HOME 指向沙箱（TEMP/TMP 用沙箱内的
//     AppData\Local\Temp 子目录，避开 §6 的临时目录规则）、CODEX_ELECTRON_RESOURCES_PATH 置空、
//     CODEX_LAUNCHER_SHORTCUT_DIR 指向沙箱、CODEX_LAUNCHER_NO_PAUSE=1、
//     CODEX_LAUNCHER_NO_STORE=1 / CODEX_LAUNCHER_NO_EXTERNAL=1（测试钩子）、CODEX_LAUNCHER_REPORT
//   - bat: 用 cmd.exe /d /c ""<bat>"" <参数> 调用（windowsVerbatimArguments、stdin 忽略），退出码原样传回
//   - 报告: reportVersion/mode/exitCode/selected{source,appDir,mainExe,version}/candidates/
//     patch{total,ok,failCount,partial,skippedGroups,variants}/dryRunOk/shortcuts/errors
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
function sandboxEnv(step, o = {}) {
  const env = { ...process.env };
  for (const k of ['CODEX_APP_DIR', 'CODEX_LAUNCHER_BAT', 'CODEX_LAUNCHER_REPORT', 'CODEX_LAUNCHER_SHORTCUT_DIR',
    'CODEX_LAUNCHER_NO_STORE', 'CODEX_LAUNCHER_NO_EXTERNAL', 'CODEX_ELECTRON_RESOURCES_PATH']) delete env[k];
  const root = path.parse(SANDBOX).root; // 'F:\'
  Object.assign(env, {
    USERPROFILE: SANDBOX, HOME: SANDBOX,
    HOMEDRIVE: root.replace(/\\$/, ''), HOMEPATH: SANDBOX.slice(root.length - 1),
    LOCALAPPDATA: SANDBOX_LOCAL, APPDATA: SANDBOX_ROAMING,
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

  // 读回 .lnk（WScript.Shell）
  const rl = psRun('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
    + ' $sh=New-Object -ComObject WScript.Shell; $l=$sh.CreateShortcut($env:CODEX_E2E_LNK);'
    + ' [pscustomobject]@{TargetPath=$l.TargetPath;Arguments=$l.Arguments;WorkingDirectory=$l.WorkingDirectory;IconLocation=$l.IconLocation} | ConvertTo-Json -Compress',
    { ...process.env, CODEX_E2E_LNK: lnk });
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
  const t0 = Date.now();
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
  console.log('\n检查 ' + checks + ' 项，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's，日志: ' + LOG_DIR);
  console.log(failures === 0 ? 'all passed' : failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})();
