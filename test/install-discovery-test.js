// 安装发现测试：验证 codex-launcher.js 的 inspectInstall / discoverInstalls / pickInstall /
// buildShortcutArgs / parseArgs / tryCachedInstall（快，不拷大文件；全部在 .tmp-discovery 里造假安装，结束删除临时目录）。
// 环境变量必须在 require 启动器之前设置：启动器在 require 时读它们。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp-discovery');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK   ' : '  FAIL ') + msg); if (!cond) failures++; };
const head = t => console.log('\n== ' + t + ' ==');

// ---------- 沙箱环境（必须在 require 启动器之前设置） ----------
const envBackup = {};
const setEnv = (k, v) => { envBackup[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
setEnv('USERPROFILE', TMP);
setEnv('LOCALAPPDATA', path.join(TMP, 'AppData', 'Local'));
setEnv('APPDATA', path.join(TMP, 'AppData', 'Roaming'));
setEnv('ProgramFiles', path.join(TMP, 'ProgramFiles'));
setEnv('ProgramFiles(x86)', path.join(TMP, 'ProgramFiles86'));
setEnv('TEMP', path.join(TMP, 'temp'));
setEnv('TMP', path.join(TMP, 'temp'));
setEnv('CODEX_HOME', path.join(TMP, 'codex-home'));
setEnv('CODEX_ELECTRON_RESOURCES_PATH', ''); // 本机真实值会指向真实镜像的资源目录，必须清空
setEnv('CODEX_LAUNCHER_NO_STORE', '1');       // 不碰真实商店版
setEnv('CODEX_LAUNCHER_NO_EXTERNAL', '1');    // 不碰注册表/开始菜单/进程
setEnv('CODEX_LAUNCHER_SHORTCUT_DIR', path.join(TMP, 'shortcuts'));
setEnv('CODEX_APP_DIR', undefined);

const L = require('../codex-launcher.js');

// ---------- 工具：极小的合法 asar（header 里只有 package.json） ----------
function writeMiniAsar(file, pkg) {
  const body = Buffer.from(JSON.stringify(pkg), 'utf8');
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: body.length, offset: '0' } } }), 'utf8');
  const payloadLen = Math.ceil((4 + json.length) / 4) * 4;
  const headerSize = 4 + payloadLen;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(payloadLen, 8); head.writeUInt32LE(json.length, 12);
  const buf = Buffer.concat([head, json, Buffer.alloc(8 + headerSize - 16 - json.length), body]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
const CODEX_OK = version => ({ name: 'openai-codex-electron', productName: 'Codex', version });
function writeExe(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 0x4d5a % 256));
}
// 一个"安装"= 目录 + resources/app.asar + 若干 exe。layout: 'flat'（appDir 自身）/ 'store'（<d>\app）
function makeInstall(dir, { pkg, exes, layout = 'flat' }) {
  const appDir = layout === 'store' ? path.join(dir, 'app') : dir;
  writeMiniAsar(path.join(appDir, 'resources', 'app.asar'), pkg);
  for (const [name, size] of Object.entries(exes || { 'ChatGPT.exe': 300, 'Codex.exe': 100 })) writeExe(path.join(appDir, name), size);
  return appDir;
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  const PROGRAMS = path.join(TMP, 'AppData', 'Local', 'Programs');

  // ---------- 造假安装 ----------
  head('准备假安装');
  makeInstall(path.join(PROGRAMS, 'Codex'), { pkg: CODEX_OK('1.2.3') }); // 直接布局；ChatGPT.exe 较大
  makeInstall(path.join(PROGRAMS, 'SquirrelCodex', 'app-1.0.0'), { pkg: CODEX_OK('1.0.0'), exes: { 'ChatGPT.exe': 300 } });
  makeInstall(path.join(PROGRAMS, 'SquirrelCodex', 'app-1.2.3'), { pkg: CODEX_OK('1.2.3'), exes: { 'ChatGPT.exe': 300 } });
  makeInstall(path.join(PROGRAMS, 'CodexStore'), { pkg: CODEX_OK('2.0.0'), layout: 'store', exes: { 'ChatGPT.exe': 100, 'Codex.exe': 200 } });
  makeInstall(path.join(PROGRAMS, 'FakeChatGPT'), { pkg: { name: 'some-other-electron-app', version: '1.0.0' } });
  // 别的 Electron 应用（非 Codex）带着合法 asar 但缺主程序
  makeInstall(path.join(PROGRAMS, 'NoExeCodex'), { pkg: CODEX_OK('9.9.9'), exes: {} });
  // 目录里的 asar 是坏文件（不得抛异常中断整轮发现）
  const broken = path.join(PROGRAMS, 'BrokenCodex', 'resources');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'app.asar'), Buffer.alloc(64, 0x41));
  writeExe(path.join(PROGRAMS, 'BrokenCodex', 'ChatGPT.exe'), 300);
  // 我们自己镜像（父目录含 launcher-state.json）——模拟沙箱里真实 HOME 的镜像也会被排除
  const mirror = makeInstall(path.join(PROGRAMS, 'MyCodexMirror', 'app'), { pkg: CODEX_OK('3.0.0') });
  fs.writeFileSync(path.join(PROGRAMS, 'MyCodexMirror', 'launcher-state.json'), '{}');
  // 手动指定的安装（放到扫描根之外，只能靠 --app-dir 找到；版本最低，用来验证"手动优先"）
  makeInstall(path.join(TMP, 'manual', 'CodexManual'), { pkg: CODEX_OK('0.1.0') });
  // 当前 HOME 的镜像目录（MIRROR_ROOT，同样必须被排除）
  makeInstall(path.join(TMP, 'ChatGPT-Patched', 'app'), { pkg: CODEX_OK('4.0.0') });
  console.log('  done ->', TMP);

  // ---------- inspectInstall ----------
  head('inspectInstall');
  {
    const r = L.inspectInstall(path.join(PROGRAMS, 'Codex'));
    ok(r.ok && r.version === '1.2.3', `直接布局识别（version=${r.version}）`);
    ok(r.mainExe === 'ChatGPT.exe', `主程序取体积最大的 exe（${r.mainExe}）`);
    ok(r.appDir === path.join(PROGRAMS, 'Codex'), 'appDir 归一化为安装目录本身');
    ok(r.root === path.join(PROGRAMS, 'Codex'), 'root 为 appDir（安装版）');
  }
  {
    const r = L.inspectInstall(path.join(PROGRAMS, 'CodexStore'));
    ok(r.ok && r.appDir === path.join(PROGRAMS, 'CodexStore', 'app'), '商店布局 pkg\\app 归一化');
    ok(r.mainExe === 'Codex.exe', `Codex.exe 更大时取 Codex.exe（${r.mainExe}）`);
  }
  {
    const r = L.inspectInstall(path.join(PROGRAMS, 'FakeChatGPT'));
    ok(!r.ok && /不是 Codex/.test(r.reason), 'name 不同的 Electron 应用被排除（' + r.reason + '）');
  }
  {
    const r = L.inspectInstall(path.join(PROGRAMS, 'NoExeCodex'));
    ok(!r.ok && /主程序/.test(r.reason), '没有主程序的目录被排除（' + r.reason + '）');
  }
  {
    const r = L.inspectInstall(path.join(PROGRAMS, 'BrokenCodex'));
    ok(!r.ok && /app\.asar 无法读取/.test(r.reason), '坏 asar 不抛异常、带原因排除（' + r.reason + '）');
  }
  {
    const r = L.inspectInstall(path.join(TMP, 'ChatGPT-Patched', 'app'));
    ok(!r.ok && r.excluded && /镜像/.test(r.reason), '当前 HOME 的镜像目录被排除（' + r.reason + '）');
  }
  {
    const r = L.inspectInstall(mirror);
    ok(!r.ok && r.excluded && /launcher-state\.json/.test(r.reason), '父目录含 launcher-state.json 的镜像被排除（' + r.reason + '）');
  }

  // ---------- discoverInstalls ----------
  head('discoverInstalls（文件系统扫描）');
  const cands = L.discoverInstalls();
  const byApp = new Map(cands.filter(c => c.ok).map(c => [path.resolve(c.appDir).toLowerCase(), c]));
  ok(byApp.has(path.join(PROGRAMS, 'Codex').toLowerCase()), '发现 Programs\\Codex');
  ok(byApp.has(path.join(PROGRAMS, 'SquirrelCodex', 'app-1.2.3').toLowerCase()), '发现 Squirrel app-1.2.3');
  ok(byApp.has(path.join(PROGRAMS, 'SquirrelCodex', 'app-1.0.0').toLowerCase()), '发现 Squirrel app-1.0.0');
  ok(byApp.has(path.join(PROGRAMS, 'CodexStore', 'app').toLowerCase()), '发现商店布局 CodexStore\\app');
  const fake = cands.find(c => c.path && path.resolve(c.path).toLowerCase() === path.join(PROGRAMS, 'FakeChatGPT').toLowerCase());
  ok(fake && !fake.ok && /不是 Codex/.test(fake.reason), 'FakeChatGPT 以排除原因出现在候选里');
  const excl = cands.find(c => c.path && path.resolve(c.path).toLowerCase() === path.join(PROGRAMS, 'MyCodexMirror').toLowerCase());
  ok(excl && !excl.ok && /launcher-state\.json/.test(excl.reason), 'MyCodexMirror 以镜像原因被排除');
  ok(!cands.some(c => c.ok && c.version === '3.0.0'), '镜像内容不会作为可用候选');

  head('pickInstall（版本比较 / 商店优先 / 手动优先）');
  {
    const sel = L.pickInstall(cands);
    ok(sel && sel.version === '2.0.0' && /CodexStore/.test(sel.appDir), `选版本最高的（${sel && sel.version} ${sel && sel.appDir}）`);
  }
  {
    const sel = L.pickInstall([
      { ok: true, source: 'exe', version: '9.9.9', appDir: 'x' },
      { ok: true, source: 'store', version: '9.9.9', appDir: 'y' },
    ]);
    ok(sel && sel.appDir === 'y', '同版本商店版优先');
  }
  {
    const sel = L.pickInstall([
      { ok: true, source: 'store', version: '1.0.0', appDir: 'x' },
      { ok: true, source: 'exe', version: '2.0.0', appDir: 'y' },
    ]);
    ok(sel && sel.appDir === 'y', '版本高者优先（不受来源影响）');
  }
  {
    const manualDir = path.join(TMP, 'manual', 'CodexManual');
    const manualCands = L.discoverInstalls({ appDir: manualDir });
    ok(manualCands.some(c => c.ok && c.source === 'manual' && c.version === '0.1.0'), '--app-dir 手动指定被识别');
    const sel = L.pickInstall(manualCands);
    ok(sel && sel.source === 'manual' && sel.version === '0.1.0', '手动指定优先于更高版本的自动发现');
    const none = L.discoverInstalls({ appDir: '' });
    ok(!none.some(c => c.source === 'manual'), '--app-dir=（空）不产生手动候选');
  }
  {
    // 显式指定（--app-dir= / CODEX_APP_DIR）无效时必须报错退出、不得静默改用别的安装——
    // 使用说明有这条承诺。环境变量在 require 时就固化进模块常量，必须另起子进程验证
    // （沙箱环境变量 + --self-test，只读）
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'codex-launcher.js'), '--self-test'],
      { env: { ...process.env, CODEX_APP_DIR: 'D:\\My Codex Typo' }, encoding: 'utf8', timeout: 120000 });
    ok(r.status === 1, '无效的 CODEX_APP_DIR：--self-test 退出码 1（实际 ' + r.status + '）');
    ok(/指定的安装目录不可用（环境变量 CODEX_APP_DIR）/.test(r.stdout || ''),
      '无效的 CODEX_APP_DIR：提示指明来源并说明不可用');
    ok(!/补丁试跑通过|选中:/.test(r.stdout || ''),
      '无效的 CODEX_APP_DIR：没有静默改用其它安装（不选中、不试跑）');
  }
  {
    const sel = L.pickInstall([{ ok: false, source: 'exe' }, null]);
    ok(sel === null, '没有可用候选时返回 null');
  }

  // ---------- tryCachedInstall：命中/不命中矩阵（规格 §5.6/§5.11，全部注入 deps，不跑 PowerShell） ----------
  head('tryCachedInstall（快路径缓存）');
  {
    // 缓存记录里的 root/appDir 要指向真实存在的目录，才能让 inspectInstall 通过
    const cachedApp = path.join(PROGRAMS, 'Codex');
    const rec0 = L.inspectInstall(cachedApp, 'exe');
    ok(rec0.ok, '前置：缓存用的安装目录可用（' + cachedApp + '）');
    const cache = {
      source: 'exe', appDir: rec0.appDir, root: rec0.root, mainExe: rec0.mainExe, version: rec0.version,
      label: rec0.label, aumid: null, pkgSet: null, appSiblings: null, envKey: '0000', at: '2026-01-01T00:00:00Z',
    };
    const deps = {
      inspectInstall: L.inspectInstall,
      pkgSet: () => null,
      appSiblings: () => null,
      fsScanDirs: () => [cachedApp],
      envKey: () => '0000',
    };
    const hit = L.tryCachedInstall({ installCache: cache }, deps);
    ok(hit.ok && hit.rec && path.resolve(hit.rec.appDir).toLowerCase() === cachedApp.toLowerCase(),
      '命中：目录可用、版本一致、fsScanDirs 里只有它自己（' + (hit.reason || 'ok') + '）');
    // envKey 变化（如 --app-dir 给出、NO_STORE 切换）
    ok(L.tryCachedInstall({ installCache: cache }, { ...deps, envKey: () => '0001' }).ok === false,
      '不命中：envKey 变化');
    // 版本变化
    ok(L.tryCachedInstall({ installCache: { ...cache, version: '0.0.1' } }, deps).ok === false,
      '不命中：缓存的版本与实际不一致');
    // 目录消失
    ok(L.tryCachedInstall({ installCache: { ...cache, appDir: path.join(PROGRAMS, 'NoSuchCodex') } }, deps).ok === false,
      '不命中：缓存目录已不可用');
    // store 形态：pkgSet 相同才命中，变化/为 null 都不命中
    const storeApp = L.inspectInstall(path.join(PROGRAMS, 'CodexStore'), 'store');
    const storeCache = { ...cache, source: 'store', appDir: storeApp.appDir, root: storeApp.root, version: storeApp.version, pkgSet: 'OpenAI.Codex_2.0.0_x64__abc', envKey: '0000' };
    ok(L.tryCachedInstall({ installCache: storeCache }, { ...deps, pkgSet: () => 'OpenAI.Codex_2.0.0_x64__abc' }).ok === true,
      '商店版命中：pkgSet 相同');
    ok(L.tryCachedInstall({ installCache: storeCache }, { ...deps, pkgSet: () => 'OpenAI.Codex_2.0.1_x64__abc' }).ok === false,
      '不命中：商店包集合变化（商店更新/旧包残留）');
    ok(L.tryCachedInstall({ installCache: storeCache }, { ...deps, pkgSet: () => null }).ok === false,
      '不命中：pkgSet 为 null（reg.exe 不可用，视为不命中）');
    ok(L.tryCachedInstall({ installCache: { ...storeCache, pkgSet: null } }, { ...deps, pkgSet: () => null }).ok === false,
      '不命中：缓存里就没有 pkgSet');
    // exe 形态（Squirrel）：appSiblings 相同才命中；出现新 app-* 目录或新扫描目录都不命中
    const sibApp = path.join(PROGRAMS, 'SquirrelCodex', 'app-1.2.3');
    const sibRec = L.inspectInstall(sibApp, 'exe');
    const sibCache = { ...cache, appDir: sibRec.appDir, root: sibRec.root, version: sibRec.version, appSiblings: 'app-1.0.0,app-1.2.3' };
    ok(L.tryCachedInstall({ installCache: sibCache }, { ...deps, appSiblings: () => 'app-1.0.0,app-1.2.3', fsScanDirs: () => [sibApp] }).ok === true,
      '官网版命中：appSiblings 相同');
    ok(L.tryCachedInstall({ installCache: sibCache }, { ...deps, appSiblings: () => 'app-1.0.0,app-1.2.3,app-2.0.0', fsScanDirs: () => [sibApp] }).ok === false,
      '不命中：安装目录里出现了新的 app-*（官网更新）');
    ok(L.tryCachedInstall({ installCache: sibCache }, { ...deps, appSiblings: () => 'app-1.0.0,app-1.2.3', fsScanDirs: () => [sibApp, path.join(PROGRAMS, 'Codex')] }).ok === false,
      '不命中：文件系统扫描发现缓存以外的 **真安装**（Programs\\Codex 有 app.asar）');
    // 关键回归（第 1 轮审查发现）：fsScanDirs 列出的是"名字含 codex|chatgpt|openai 的目录"，其中大量
    // 无关目录（真实机器上实测就有 %LOCALAPPDATA%\OpenAI、\OpenAI\Codex、\Codex、\codexhost 四个，都是应用
    // 自己建的运行时目录、没有 app.asar）。这些**不得**让缓存失效，否则官网 exe 版用户的"第二次启动变快"
    // 直接失效。下面这两个目录都只有名字像、没有 app.asar。
    for (const noiseName of ['OpenAI', 'codexhost']) {
      fs.mkdirSync(path.join(PROGRAMS, noiseName), { recursive: true });
      ok(L.tryCachedInstall({ installCache: sibCache },
        { ...deps, appSiblings: () => 'app-1.0.0,app-1.2.3', fsScanDirs: () => [sibApp, path.join(PROGRAMS, noiseName)] }).ok === true,
        '仍命中：扫描里的无关目录 ' + noiseName + '（无 app.asar）不使缓存失效');
    }
    ok(L.tryCachedInstall({ installCache: sibCache },
      { ...deps, appSiblings: () => 'app-1.0.0,app-1.2.3', fsScanDirs: () => [sibApp, path.join(PROGRAMS, 'FakeChatGPT')] }).ok === true,
      '仍命中：名字像但 name 不是 openai-codex-electron 的目录不算别的安装');
    // manual 永远不走缓存（manual 只检查一个目录，不跑 PowerShell 发现脚本即可）
    ok(L.tryCachedInstall({ installCache: { ...cache, source: 'manual' } }, deps).ok === false,
      '不命中：manual 不走缓存');
    ok(L.tryCachedInstall({}, deps).ok === false, '不命中：状态里没有 installCache');
    ok(L.tryCachedInstall({ installCache: { source: 'exe' } }, deps).ok === false, '不命中：缓存记录不完整（没有 appDir）');
    // 纯函数约束：不得 process.exit、不得写文件（跑一遍后临时目录内容不变）
    const before = fs.readdirSync(TMP).sort().join(',');
    L.tryCachedInstall({ installCache: cache }, deps);
    ok(fs.readdirSync(TMP).sort().join(',') === before, '纯函数：tryCachedInstall 不写任何文件');
  }
  {
    // manual 候选 ok 时 discoverInstalls 必须短路：不跑 PowerShell 发现脚本（规格 §10.7）。
    // 无法直接断言"没跑 PowerShell"，改为断言候选列表里只有 manual 一条（完整发现会带上文件系统扫描的其它候选）
    const manualDir = path.join(TMP, 'manual', 'CodexManual');
    const only = L.discoverInstalls({ appDir: manualDir });
    ok(only.length === 1 && only[0].source === 'manual' && only[0].ok,
      '--app-dir 有效时发现被短路：只返回 manual 一条（' + only.length + ' 条，' + only.map(c => c.source).join(',') + '）');
  }

  // ---------- 快捷方式参数 ----------
  head('buildShortcutArgs');
  ok(L.buildShortcutArgs('C:\\a b\\启动Codex解锁版.bat') === '/d /c ""C:\\a b\\启动Codex解锁版.bat""',
    '含空格路径：双引号包裹（' + L.buildShortcutArgs('C:\\a b\\启动Codex解锁版.bat') + '）');
  ok(L.buildShortcutArgs('F:\\dir with space & 中文 (x)\\启动Codex解锁版.bat') === '/d /c ""F:\\dir with space & 中文 (x)\\启动Codex解锁版.bat""',
    '含空格/&/中文/括号路径不变形');

  // ---------- 快速指纹：fastKey 命中只复用"配对记录的"哈希（防 knownBad 被缓存打穿） ----------
  head('resolveFingerprint（fastKey / fastFingerprint 配对）');
  {
    // 新状态：fastKey 命中 + 配对的 fastFingerprint -> 复用（不重算）
    let r = L.resolveFingerprint({ fastKey: 'k', fastFingerprint: 'NEW', storeFingerprint: 'OLD' }, 'k', () => 'HASH');
    ok(r.fp === 'NEW' && r.reused === true, '命中时复用 fastFingerprint（不是 storeFingerprint 的旧值）');
    // 失败记账场景：storeFingerprint=旧成功哈希、fastFingerprint=本次失败哈希、fastKey 命中
    ok(r.fp === 'NEW', 'knownBad 对比用的 fp 是本次失败版本的新哈希（' + r.fp + '）');
    // 旧状态兼容：只有 fastKey/storeFingerprint、没有 fastFingerprint -> 重算，避免错误复用
    r = L.resolveFingerprint({ fastKey: 'k', storeFingerprint: 'OLD' }, 'k', () => 'HASH');
    ok(r.reused === false && r.fp === 'HASH', '旧状态（无 fastFingerprint）时重算哈希');
    // fastKey 不匹配 -> 重算
    r = L.resolveFingerprint({ fastKey: 'other', fastFingerprint: 'NEW' }, 'k', () => 'HASH2');
    ok(r.reused === false && r.fp === 'HASH2', 'fastKey 变化时重算');
    // 空状态 -> 重算
    r = L.resolveFingerprint({}, 'k', () => 'HASH3');
    ok(r.reused === false && r.fp === 'HASH3', '空状态时重算');
  }

  // ---------- 镜像排除的边界：state 落在 HOME 根 / LOCALAPPDATA 时不得误伤其下正常安装 ----------
  head('excludedReason 边界（state 位置）');
  {
    // 1) 正常的安装目录（名字不是 app/app.staging/app.old，父目录没有 state）-> 不排除
    const plain = path.join(TMP, 'excl', 'Programs', 'Codex');
    writeMiniAsar(path.join(plain, 'resources', 'app.asar'), CODEX_OK('9.0.0'));
    writeExe(path.join(plain, 'ChatGPT.exe'), 100);
    fs.mkdirSync(path.join(TMP, 'excl', 'Programs'), { recursive: true });
    ok(L.inspectInstall(plain).ok === true, '普通安装目录不被误伤（' + path.basename(plain) + '）');
    // 2) state 在祖先（如 HOME 根）也不排除——只有"自己/父目录"算镜像
    fs.mkdirSync(path.join(TMP, 'excl'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'excl', 'launcher-state.json'), '{}');
    ok(L.inspectInstall(plain).ok === true, 'state 落在祖先目录（HOME 根）时安装仍可用');
    // 3) 镜像根目录本身（自己带 state）-> 排除
    const mroot = path.join(TMP, 'excl2');
    writeMiniAsar(path.join(mroot, 'app', 'resources', 'app.asar'), CODEX_OK('9.1.0'));
    writeExe(path.join(mroot, 'app', 'ChatGPT.exe'), 100);
    fs.writeFileSync(path.join(mroot, 'launcher-state.json'), '{}');
    const r1 = L.inspectInstall(mroot);
    ok(r1.ok === false && r1.excluded === true && /镜像/.test(r1.reason), '镜像根目录被排除（' + r1.reason + '）');
    // 4) 镜像的 app 目录（父目录带 state）-> 排除
    const r2 = L.inspectInstall(path.join(mroot, 'app'));
    ok(r2.ok === false && r2.excluded === true && /父目录/.test(r2.reason), '镜像 app 目录被排除（' + r2.reason + '）');
    // 5) app.staging / app.old 同样排除
    ok(L.inspectInstall(path.join(mroot, 'app.staging')).excluded === true, 'app.staging 被排除');
    // 6) 手动 --app-dir 指向被排除目录时同样是 excluded（不能绕过，但也不误伤正常目录）
    const r3 = L.inspectInstall(path.join(mroot, 'app'), 'manual');
    ok(r3.ok === false && r3.excluded === true, '手动指定镜像 app 目录仍被排除');
  }

  // ---------- parseArgs ----------
  head('parseArgs');
  {
    const a = L.parseArgs([]);
    ok(a.mode === 'normal' && !a.noLaunch && !a.force && !a.noShortcut && a.appDir === undefined, '默认普通模式');
  }
  ok(L.parseArgs(['--self-test']).mode === 'self-test', '--self-test');
  ok(L.parseArgs(['--dry-run']).mode === 'dry-run', '--dry-run');
  ok(L.parseArgs(['--create-shortcut']).mode === 'create-shortcut', '--create-shortcut');
  ok(L.parseArgs(['--no-launch', '--force', '--no-shortcut']).noLaunch === true &&
    L.parseArgs(['--force']).force === true && L.parseArgs(['--no-shortcut']).noShortcut === true, '--no-launch/--force/--no-shortcut');
  ok(L.parseArgs(['--app-dir=C:\\x y']).appDir === 'C:\\x y', '--app-dir=目录（含空格）');
  ok(L.parseArgs(['--app-dir=']).appDir === '', '--app-dir=（空）表示清除');
  // 文档推荐的写法：--app-dir="C:\a b"（值带引号）。cmd/PS 会把引号原样带进来，启动器必须剥掉外层引号，
  // 否则校验 ""C:\a b"" 这样的目录必然失败——使用说明里 --app-dir 的示例就是这种写法
  ok(L.parseArgs(['--app-dir="C:\\a b"']).appDir === 'C:\\a b', '--app-dir="目录"（带引号形式剥掉外层引号）');
  ok(L.parseArgs(['--app-dir="C:\\a b"']).mode === 'normal', '--app-dir="目录" 不影响模式判定（仍是普通模式）');
  {
    let threw = false, msg = '';
    try { L.parseArgs(['--bogus']); } catch (e) { threw = true; msg = e.message; }
    ok(threw && /未知参数/.test(msg), '未知 -- 参数抛中文错误（' + msg + '）');
  }
  {
    let threw = false, msg = '';
    try { L.parseArgs(['--app-dir']); } catch (e) { threw = true; msg = e.message; }
    ok(threw, '--app-dir 缺 = 也抛错（' + msg + '）');
  }
  {
    const a = L.parseArgs(['--dry-run', '--self-test']);
    ok(a.mode === 'self-test', '模式冲突时 --self-test 优先（只读最保守）');
  }

  // ---------- cmpVersion ----------
  head('cmpVersion');
  ok(L.cmpVersion('26.928.21956', '26.930.21537') < 0, '按数字段比较：26.928.21956 < 26.930.21537');
  ok(L.cmpVersion('1.2.3', '1.10.0') < 0, '不是字符串比较：1.2.3 < 1.10.0');
  ok(L.cmpVersion('1.0.0', '1.0.0') === 0, '相等');
  ok(L.cmpVersion(null, '1.0.0') < 0, '版本缺失视为最低');

  // ---------- shortcutTargets：中文用户名不因内码歧义乱码 ----------
  // 背景：GBK 的两字节中文恰好可能是合法 UTF-8（不产生 U+FFFD），"UTF-8 解出替换字符才按 GBK 重解"
  // 的兜底不会触发；SpecialFolders 的 PowerShell 调用必须自己设 [Console]::OutputEncoding=UTF-8。
  // 这里需要未沙箱化的真实环境（跳过：本测试整体跑在沙箱 HOME 里，这条用子进程独立验证）
  head('shortcutTargets（编码兜底，子进程）');
  {
    const probeHome = path.join(TMP, 'gbk-home', '郑伟');
    fs.mkdirSync(path.join(probeHome, 'Desktop'), { recursive: true });
    fs.mkdirSync(path.join(probeHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true });
    const code = `process.env.USERPROFILE=${JSON.stringify(probeHome)};process.env.HOME=${JSON.stringify(probeHome)};`
      + `process.env.APPDATA=${JSON.stringify(path.join(probeHome, 'AppData', 'Roaming'))};`
      + `delete process.env.CODEX_LAUNCHER_SHORTCUT_DIR;`
      + `const L=require(${JSON.stringify(path.join(ROOT, 'codex-launcher.js'))});`
      + `const t=L.shortcutTargets().map(x=>x.path);console.log(JSON.stringify(t));`;
    const r = require('child_process').spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, TEMP: path.join(TMP, 'temp'), TMP: path.join(TMP, 'temp') } });
    let targets = [];
    try { targets = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch (e) {}
    const joined = targets.join('|');
    // 乱码特征：GBK 字节被当 UTF-8 解出的两个字符（如「郑伟」-> ֣ΰ）或 U+FFFD
    ok(targets.length === 2 && joined.includes('郑伟') && !joined.includes('\uFFFD') && !joined.includes('֣'),
      '中文用户名下 SpecialFolders 路径不乱码（' + joined + '）');
  }
} finally {
  // 恢复环境变量并清理临时目录
  for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + (failures === 0 ? '全部通过' : `${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);
