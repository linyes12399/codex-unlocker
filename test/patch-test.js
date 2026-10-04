// 离线回归测试：验证平台无关核心（lib/launcher-core.js）
//   node test/patch-test.js            补丁集 + 变体/分组/部分解锁语义 + net 补丁（主进程 app-server 注入）（快）
//   node test/patch-test.js --asar     额外做真实 asar 的定位+补丁+重打包往返（慢，需要 app.asar 备份）
//   node test/patch-test.js --asar=<path>
//   node test/patch-test.js --strict   黄金样本比对失败时计为 FAIL（默认只 WARN）
'use strict';

// ---------- 自测看门狗（防止本脚本无声挂死整条快检查） ----------
// 起因（实测）：core.evalNetArgs 的早期修订版里 `while ((m = re.exec(s)))` 的正则漏了 g，exec 的
// lastIndex 不前进 -> 主线程被同步占死，事件循环停转，连 setTimeout 都不会触发（probe 侧实测被挂住）。
// 本脚本直接调 evalNetArgs，若它哪天回归成死循环形态，node test/patch-test.js 会无声挂死整轮门禁。
// 做法与 test/app-server-probe.js 同款：worker 线程用 SharedArrayBuffer + Atomics 看主线程心跳，
// 主线程停滞太久就 process.kill(process.pid,'SIGKILL') 立即结束（SIGKILL 瞬时，必须 writeSync 同步写消息）。
// 阈值按模式区分（实测依据）：
//   快速模式最长合法同步阻塞 ~1.2s（locateBundles 扫 1.4 万个 webview 条目）-> 20s（15 倍余量）；
//   --asar 模式要多做一次 541MB 的 writeAsar（本机 SSD 实测约 1.1s，但它是同步读+同步写 541MB，
//   门禁机器磁盘慢 10 倍就是 ~11s）-> 给 120s（约 10 倍余量），避免在慢盘上误杀正常往返。
// watchdog 的目的是"死循环时 fail fast 而不是挂死"，不是性能门禁，所以阈值一律取宽松侧。
// 位置：必须放在**所有 require 之前**——否则依赖模块在加载期就死循环时（实测：require 卡住）
// 看门狗还没起来，整个脚本照样挂死。worker 是 unref 的，正常跑完不会让本进程多停留。
// 自证有效：worker 跑起来后会往 ctr[1] 写一个"我活着"的确认值，主线程在开跑前同步校验它 ——
// 光看"worker 建好了"不算数（本轮踩过：worker 静默 ReferenceError 死掉时，看门狗看起来装着、实际没看）。
const WD_STALL_SEC = process.argv.some(a => a.startsWith('--asar')) ? 120 : 20;
const WD_ALIVE = 20261003;
let wdHandle = null, wdBeat = null, wdSab = null;
(function startWatchdog() {
  let Worker;
  try { Worker = require('worker_threads').Worker; } catch (e) { return; } // 极老 node 没有 worker_threads：放弃看门狗，不影响测试本身
  if (typeof Worker !== 'function' || typeof SharedArrayBuffer !== 'function') return;
  const SAB = new SharedArrayBuffer(8);
  const ctr = new Int32Array(SAB);
  wdSab = SAB;
  wdBeat = setInterval(() => { Atomics.add(ctr, 0, 1); }, 250);
  wdBeat.unref();
  const SRC = [
    'const { workerData } = require("worker_threads");',   // workerData 不是全局，必须自己取（漏了会 ReferenceError -> worker 静默退出 -> 看门狗形同不存在）
    'const ctr = new Int32Array(workerData.ctrl);',
    'Atomics.store(ctr, 1, workerData.alive);',            // 给主线程的"看门狗活着"确认
    'try { Atomics.notify(ctr, 1); } catch (e) {}',        // 唤醒正在 Atomics.wait 的主线程
    'let last = Atomics.load(ctr, 0), stale = 0;',
    'setInterval(() => {',
    '  const cur = Atomics.load(ctr, 0);',
    '  if (cur !== last) { last = cur; stale = 0; return; }',
    '  if (++stale >= workerData.limit) {',
    '    try { require("fs").writeSync(2, "[patch-test] 看门狗：主线程 " + workerData.limit + "s 没有进展（疑似 evalNetArgs 等依赖同步死循环），强制结束\\n"); } catch (e) {}',
    '    process.kill(process.pid, "SIGKILL");',
    '  }',
    '}, 1000);',
  ].join('\n');
  try {
    wdHandle = new Worker(SRC, { eval: true, workerData: { ctrl: SAB, limit: WD_STALL_SEC, alive: WD_ALIVE } });
    wdHandle.unref();
    // 看门狗自身出错不该拖垮测试，但绝不能静默——本轮就踩过：worker 源码漏了取 workerData，
    // worker 以 ReferenceError 静默死掉，看门狗"看起来装了"，实际什么都没看。这里打一行提示，
    // 便于门禁日志里一眼看出"这次保护没生效"。
    wdHandle.on('error', e => { try { console.log('  WARN 看门狗线程出错（保护未生效，测试本身不受影响）: ' + (e && e.message)); } catch (_) {} });
  } catch (e) { wdHandle = null; }
})();
// 开跑前的同步确认：worker 已写回确认值才能相信这道保护真的生效（实测约 30ms，用 Atomics.wait 阻塞等待，
// 不空转 CPU；正常路径也会打出这一行，门禁日志里就能直接看到"看门狗已生效"）。
(function confirmWatchdog() {
  if (!wdHandle || !wdSab) { console.log('  注意: 本环境没有 worker_threads，跳过自测看门狗（不影响测试本身，只是依赖死循环时会挂住）'); return; }
  const t0 = Date.now();
  const ctr = new Int32Array(wdSab);
  while (ctr[1] !== WD_ALIVE) {
    // Atomics.wait 在 node 主线程可用（实测 33ms 拿到确认值）；万一某环境不允许，退化成空转，
    // 但下面的 3s 上限保证不会因为等待本身把测试卡死。
    try { Atomics.wait(ctr, 1, 0, 250); } catch (e) { /* 不允许 wait：空转兜底 */ }
    if (Date.now() - t0 > 3000) {
      console.log('  WARN 看门狗确认失败（3s 内没收到存活信号），本次运行没有死循环保护；请查看上面是否有 worker 报错');
      return;
    }
  }
  console.log('  看门狗已生效（主线程停滞 ' + WD_STALL_SEC + 's 会强制结束本进程）');
})();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../lib/launcher-core.js');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK   ' : '  FAIL ') + msg); if (!cond) failures++; };
const head = t => console.log('\n== ' + t + ' ==');
const vlabel = v => (v === 0 ? '主定义' : (v > 0 ? '变体 ' + v : '未命中'));

// results 每项固定为 { note, ok, expect, actual, group, variant } 六个键（对外冻结接口）
const RESULT_KEYS = 'actual,expect,group,note,ok,variant';
const resultShapeOk = r => typeof r.note === 'string' && typeof r.ok === 'boolean' && Number.isInteger(r.expect)
  && Number.isInteger(r.actual) && (r.group === 'effort' || r.group === 'speed') && Number.isInteger(r.variant)
  && Object.keys(r).sort().join(',') === RESULT_KEYS;

// 载入一个 bundle 样本目录（三个文件；orig 保留原文用于对比）
const SAMPLE_FILES = { initial: 'app-initial.js', shared: 'app-shared.js', primary: 'app-primary.js' };
function loadSample(dir) {
  const role = {}, content = new Map(), orig = new Map();
  for (const [name, file] of Object.entries(SAMPLE_FILES)) {
    const s = fs.readFileSync(path.join(dir, file)).toString('latin1');
    role[name] = { rel: 'webview/assets/' + file, size: s.length };
    content.set(role[name].rel, s);
    orig.set(role[name].rel, s);
  }
  return { role, content, orig };
}
const countIn = (s, sub) => s.split(sub).length - 1;
// 标记唯一性：每个 BUNDLE_MARKERS 只应命中它自己的那份 bundle
function checkMarkersUnique(dir, label) {
  for (const [name, marker] of Object.entries(core.BUNDLE_MARKERS)) {
    const hits = Object.entries(SAMPLE_FILES).filter(([, f]) => fs.readFileSync(path.join(dir, f), 'latin1').includes(marker)).map(([n]) => n);
    ok(hits.length === 1 && hits[0] === name, `${label} 标记 ${marker} 只出现在 ${name}（实际: ${hits.join(',') || '无'}）`);
  }
}
// 把 content 写到临时目录做 node --check，无论成败都清理
function checkSyntax(content, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-patch-check-'));
  try {
    core.syntaxCheckBundles(content, dir);
    ok(true, label + '：改写后的 bundle 均通过 node --check');
    return true;
  } catch (e) {
    ok(false, label + '：语法校验失败: ' + e.message);
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function printResults(results) {
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK  ' : 'MISS'} [${r.group}/${vlabel(r.variant)}] ${r.note}`
      + (r.ok ? '' : `：期望 ${r.expect} 处，实际 ${r.actual} 处`));
  }
}

// ---------- 1. 新版样本：主定义全中 + 与黄金样本逐字节一致 ----------
head('补丁集命中（新版样本 newstore-bundles）');
const NEW_DIR = path.join(ROOT, 'newstore-bundles');
const OLD_DIR = path.join(ROOT, 'oldstore-bundles');
checkMarkersUnique(NEW_DIR, '新版');
const newSample = loadSample(NEW_DIR);
const full = core.applyPatchSet(newSample.content, newSample.role);
printResults(full.results);
ok(full.failCount === 0, `全部 ${full.results.length} 处补丁命中`);
ok(full.results.every(resultShapeOk), 'results 每项固定 { note, ok, expect, actual, group, variant }');
ok(full.results.every(r => r.variant === 0), '新版样本全部命中主定义（variant=0）');
ok(full.skippedGroups.length === 0 && full.partial === false, '不传 opts：skippedGroups=[]、partial=false（与旧返回结构兼容）');
for (const [rel, s] of newSample.orig) ok(newSample.content.get(rel) !== s, `bundle 确实被改写: ${path.basename(rel)}`);
checkSyntax(newSample.content, '新版');

// ---------- 1a. 补丁集元数据：分组与变体声明 ----------
head('补丁集元数据（分组 effort/speed 与变体）');
ok(core.PATCHES.every(p => p.group === 'effort' || p.group === 'speed'), '每条补丁都有合法 group');
const effortN = core.PATCHES.filter(p => p.group === 'effort').length;
const speedN = core.PATCHES.filter(p => p.group === 'speed').length;
ok(effortN === 9 && speedN === 6, `分组数量 effort=9 speed=6（实际 effort=${effortN} speed=${speedN}）`);
const withVariants = core.PATCHES.filter(p => p.variants && p.variants.length);
ok(withVariants.length === 4, `恰有 4 条补丁带旧版变体（实际 ${withVariants.length}）`);
ok(withVariants.every(p => p.group === 'speed' && p.variants.every(v => v.expect === 1 && (v.regex || v.old))), '变体声明形态合法且都属于 speed 组');

// ---------- 2. 旧版样本：主定义 11 + 变体 4 = 15/15 ----------
head('补丁集命中（旧版样本 oldstore-bundles，允许走变体）');
checkMarkersUnique(OLD_DIR, '旧版');
const oldSample = loadSample(OLD_DIR);
const oldFull = core.applyPatchSet(oldSample.content, oldSample.role);
printResults(oldFull.results);
ok(oldFull.failCount === 0, `全部 ${oldFull.results.length} 处补丁命中（旧版允许走变体）`);
ok(oldFull.results.every(resultShapeOk), '旧版 results 每项字段固定');
const viaVariant = oldFull.results.filter(r => r.variant > 0);
const EXPECTED_VARIANT_NOTES = [
  'Fast: isServiceTierAllowed 强制 true',
  '速度档菜单: 注入 Ultrafast（保留原 Fast 假档兜底）',
  'Fast: 档位图标显示条件放宽',
  'Fast: 模型选择器显示条件放宽',
].sort();
ok(viaVariant.length === 4 && viaVariant.every(r => r.variant === 1 && r.group === 'speed'),
  `恰有 4 条走第 1 个变体且都属于 speed 组（实际 ${viaVariant.map(r => r.note + '->v' + r.variant).join('; ') || '无'}）`);
ok(JSON.stringify(viaVariant.map(r => r.note).sort()) === JSON.stringify(EXPECTED_VARIANT_NOTES), '走变体的恰好是 4 条已知旧版条目');
ok(oldFull.results.filter(r => r.variant === 0).length === 11, '其余 11 条走主定义');
for (const [rel, s] of oldSample.orig) ok(oldSample.content.get(rel) !== s, `旧版 bundle 确实被改写: ${path.basename(rel)}`);
checkSyntax(oldSample.content, '旧版');

// ---------- 3. 黄金样本：补丁集必须逐字节重现"已知可用"的 patched bundle ----------
// newstore-bundles = 当前商店版本的原版 bundle；extracted-asar/patched-bundles = 由它生成的
// 已验证可用产物。两者必须逐字节一致，否则说明补丁定义被改动过。
head('黄金样本比对（逐字节）');
function goldenCandidates(prefix) {
  const out = [];
  for (const dir of [path.join(ROOT, 'extracted-asar', 'webview', 'assets'), path.join(ROOT, 'patched-bundles')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix + '-') && f.endsWith('.js')) out.push(path.join(dir, f));
  }
  return out;
}
const STRICT = process.argv.includes('--strict');
for (const [name, prefix] of Object.entries({ initial: 'app-initial', shared: 'app-shared', primary: 'app-primary' })) {
  const mine = newSample.content.get(newSample.role[name].rel);
  const cands = goldenCandidates(prefix);
  const same = cands.filter(p => fs.readFileSync(p).toString('latin1') === mine);
  if (same.length) ok(true, `${name} 与黄金样本逐字节一致（${path.basename(same[0])}, ${mine.length}B）`);
  else if (STRICT) ok(false, `${name} 与任何黄金样本都不一致`);
  else console.log(`  WARN ${name}: 未与现有黄金样本匹配（黄金样本可能来自更早的商店版本；不是失败）`);
}

// ---------- 4. allowPartial：按 group 原子应用 ----------
head('allowPartial：全命中时与默认路径逐字节一致');
{
  const eqNew = loadSample(NEW_DIR);
  const eqRes = core.applyPatchSet(eqNew.content, eqNew.role, { allowPartial: true });
  ok(eqRes.failCount === 0 && eqRes.partial === false && eqRes.skippedGroups.length === 0,
    `新版全命中：failCount=0 partial=false skippedGroups=[]（实际 ${eqRes.failCount}/${eqRes.partial}/${JSON.stringify(eqRes.skippedGroups)}）`);
  ok([...newSample.orig.keys()].every(rel => eqNew.content.get(rel) === newSample.content.get(rel)),
    '新版：按组应用与默认路径产物逐字节一致');
  const eqOld = loadSample(OLD_DIR);
  core.applyPatchSet(eqOld.content, eqOld.role, { allowPartial: true });
  ok([...oldSample.orig.keys()].every(rel => eqOld.content.get(rel) === oldSample.content.get(rel)),
    '旧版：按组应用与默认路径产物逐字节一致（都走变体）');
}

head('allowPartial：speed 组失配 -> 只应用 effort 组');
{
  // 构造：在新版 initial 里把 Fast 条目（speed 组）的主定义目标串轻改一名，使其主定义与变体都无法命中。
  // 其余补丁不受影响（各补丁作用区域互不重叠）。
  const p = loadSample(NEW_DIR);
  const rel = p.role.initial.rel;
  const target = 'd=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1';
  const broken = 'd=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!0';
  p.content.set(rel, p.content.get(rel).split(target).join(broken));
  ok(countIn(p.content.get(rel), target) === 0, '构造前提：该条主定义目标串已被改写（命中 0）');

  const res = core.applyPatchSet(p.content, p.role, { allowPartial: true });
  printResults(res.results);
  const miss = res.results.filter(r => !r.ok);
  ok(res.failCount === 0, `failCount=0（只统计已应用组内的未命中，实际 ${res.failCount}）`);
  ok(res.partial === true, 'partial=true');
  ok(JSON.stringify(res.skippedGroups) === JSON.stringify(['speed']), `skippedGroups=['speed']（实际 ${JSON.stringify(res.skippedGroups)}）`);
  ok(miss.length === 1 && miss[0].variant === -1 && miss[0].group === 'speed' && miss[0].expect === 1 && miss[0].actual === 0,
    `唯一失配条目：speed 组、variant=-1、actual=0（实际 ${miss.length} 条：${miss.map(r => r.note).join('; ') || '无'}）`);
  // 其余 14 条照常命中（含被跳过组里能命中的 5 条），只有 content 里不含被跳过的改动
  ok(res.results.filter(r => r.ok).length === 14, `14 条 ok（实际 ${res.results.filter(r => r.ok).length}）`);
  // effort 组照常应用
  const ini = p.content.get(rel);
  ok(countIn(p.orig.get(rel), '536305374') === 5 && countIn(ini, '536305374') === 0, 'effort 生效：gate 标记已全部替换');
  ok(countIn(p.orig.get(rel), 'c=c.map(e=>{') === 0 && countIn(ini, 'c=c.map(e=>{') === 1, 'effort 生效：K6r 目录补齐已注入');
  // speed 组整体未应用
  ok(countIn(ini, broken) === 1 && !/service_tier:[\w$]+\|\|"ultrafast"/.test(ini), 'speed 未应用：Fast 条目与 service_tier 均未改写');
  const sh = p.content.get(p.role.shared.rel);
  ok(countIn(p.orig.get(p.role.shared.rel), 'if(t.thinkingEffort==null)continue;') === 0 && countIn(sh, 'if(t.thinkingEffort==null)continue;') === 2, 'effort 生效：滑块解析器两处 max/ultra 注入在');
  ok(countIn(sh, '((e,r)=>{for(let[t]of r)') === 0 && countIn(sh, '_t=(t&&t.length>0?t:[{id:"fast",name:"Fast"}]).concat(') === 0, 'speed 未应用：serviceTiers 补齐与 Ultrafast 注入均不在');
  const pr = p.content.get(p.role.primary.rel);
  ok(countIn(p.orig.get(p.role.primary.rel), '||t===`max`||t===`ultra`)') === 0 && countIn(pr, '||t===`max`||t===`ultra`)') === 1, 'effort 生效：Xyt 过滤已放行');
  ok(countIn(pr, 'Mt=!Le&&!fe&&jt!=null&&wd(it,Et),') === 1 && countIn(pr, 'Nt=!fe&&!ce&&Ve&&Re.availableOptions.length>1') === 1, 'speed 未应用：两条显示条件均未放宽');
  checkSyntax(p.content, '部分解锁产物');
}

head('allowPartial：两组都失配 -> 整体失败（不进入 partial 成功路径）');
{
  const p = loadSample(NEW_DIR);
  const rel = p.role.initial.rel;
  let t = p.content.get(rel);
  t = t.split('d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1').join('d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!0'); // speed
  t = t.split('m=e?.includeUltraReasoningEffort!==!1').join('m=e?.includeUltraReasoningEffort!==!0'); // effort
  p.content.set(rel, t);
  const snapshot = new Map([...p.content]);
  const res = core.applyPatchSet(p.content, p.role, { allowPartial: true });
  ok(res.failCount === 2, `failCount=未命中总数 2（实际 ${res.failCount}）`);
  ok(res.partial === false, 'partial=false（照旧整体失败）');
  ok(JSON.stringify(res.skippedGroups) === JSON.stringify(['effort', 'speed']), `skippedGroups 含两组（实际 ${JSON.stringify(res.skippedGroups)}）`);
  ok([...snapshot].every(([k, v]) => p.content.get(k) === v), '所有组都被跳过时 content 未被改动');
  ok(res.results.filter(r => r.ok).length === 13, '13 条命中（ok:true）+ 2 条未命中');
  ok(res.results.find(r => r.note.startsWith('d8r')).variant === -1 && res.results.find(r => r.note.startsWith('d8r')).actual === 0, 'effort 失配条记录为 variant=-1、actual=0');
}

// ---------- 5. net 补丁（主进程 app-server 参数注入）----------
// 覆盖规格 §4.4：真实 asar（镜像 + app.asar.backup-20261001，都只读）上的定位/注入/幂等，
// 以及 evalNetArgs 的 8 组场景。所有临时文件都在 .tmp-patch-test-* 下，结束删除。
head('net 补丁：导出接口');
for (const [k, t] of Object.entries({
  NET_OVERRIDES_FILE: 'string', NET_MARKER: 'string', NET_BUNDLE_RE: 'object', NET_RE: 'object',
  NET_INJECT_SRC: 'string', launcherOverrides: 'function', locateNetBundle: 'function',
  applyNetPatch: 'function', hasNetPatch: 'function', evalNetArgs: 'function',
})) {
  ok(typeof core[k] === t, `core.${k} 已导出且类型为 ${t}（实际 ${typeof core[k]}）`);
}
ok(core.NET_OVERRIDES_FILE === 'codex-launcher-overrides.json', 'NET_OVERRIDES_FILE 名字固定');
ok(core.NET_INJECT_SRC === '(' + core.launcherOverrides.toString() + ')()', 'NET_INJECT_SRC 由注入函数 toString 拼出');
ok(/^[\x20-\x7E\r\n\t]*$/.test(core.NET_INJECT_SRC), 'NET_INJECT_SRC 只含 ASCII（注入到 bundle 里的硬约束）');
// 注入函数不引用任何外部变量：函数体里不能出现模块内部的标识符（PATCHES/FLAT_BODY/…）
{
  const body = core.launcherOverrides.toString();
  const leaked = ['PATCHES', 'FLAT_BODY', 'FLAT_INJ_FN', 'GROUP_INJ_FN', 'BUNDLE', 'sha256', 'runCaptured']
    .filter(n => new RegExp('(?<![\\w$])' + n + '(?![\\w$])').test(body));
  ok(leaked.length === 0, `注入函数不引用模块内部标识符（实际引用: ${leaked.join(',') || '无'}）`);
}

const NET_TMP = path.join(ROOT, '.tmp-patch-test-' + process.pid);
fs.rmSync(NET_TMP, { recursive: true, force: true });
fs.mkdirSync(NET_TMP, { recursive: true });
const showArgs = a => JSON.stringify(a).replace(/"/g, '').replace(/,/g, ', ');

try {
  // ---- 5a. 真实 asar：定位 + 注入 + 语法 + 幂等（只读）----
  head('net 补丁：真实 asar 定位 + 注入 + node --check + 幂等（只读）');
  const NET_SAMPLES = [
    ['镜像', path.join(os.homedir(), 'ChatGPT-Patched', 'app', 'resources', 'app.asar')],
    ['旧版备份', path.join(ROOT, 'app.asar.backup-20261001')],
  ];
  let patchedText = null, origText = null; // 供下面的 evalNetArgs 场景使用（取第一个可用样本）
  for (const [label, asar] of NET_SAMPLES) {
    if (!fs.existsSync(asar)) { console.log(`  跳过 ${label}（文件不存在: ${asar}）`); continue; }
    const t0 = Date.now();
    const a = core.readAsar(asar);
    const fd = fs.openSync(asar, 'r');
    let entry = null;
    try { entry = core.locateNetBundle(a.header, a.dataBase, fd); } finally { fs.closeSync(fd); }
    ok(!!entry, `${label} locateNetBundle 找到 bundle（${entry ? entry.rel + ' ' + entry.size + 'B' : '未找到'}）`);
    if (!entry) continue;
    if (!origText) { origText = entry.text; }
    // 旧版备份是未打补丁样本；镜像在 v14 重建后会变成已打补丁样本，两种情况都要覆盖
    let injected = entry.text;
    if (core.hasNetPatch(entry.text)) {
      console.log(`  （${label} 已包含 net 补丁：跳过"注入命中 1"断言，按幂等路径校验）`);
      const again = core.applyNetPatch(entry.text);
      ok(again.ok === false && again.actual === 0 && again.text === entry.text,
        `${label} 已打补丁样本二次套用命中 0、文本原样（幂等）`);
      if (!patchedText) patchedText = entry.text;
    } else {
      ok(core.hasNetPatch(entry.text) === false, `${label} 原文 hasNetPatch=false`);
      const r = core.applyNetPatch(entry.text);
      ok(r.ok === true && r.actual === 1, `${label} applyNetPatch ok=true、actual=1（actual=${r.actual}）`);
      ok(r.text !== entry.text && r.text.includes('function launcherOverrides'), `${label} 注入后文本含注入函数`);
      ok(core.hasNetPatch(r.text) === true, `${label} 注入后 hasNetPatch=true`);
      const again = core.applyNetPatch(r.text);
      ok(again.ok === false && again.actual === 0 && again.text === r.text, `${label} 二次套用 actual=0、文本原样（幂等）`);
      injected = r.text;
      if (!patchedText) patchedText = r.text;
    }
    // 原文与注入后文本各写盘做 node --check（走 syntaxCheckBundles 的同一条路径）
    for (const [what, txt] of [['原文', entry.text], ['注入后', injected]]) {
      try {
        core.syntaxCheckBundles(new Map([[entry.rel, txt]]), path.join(NET_TMP, 'check-' + label));
        ok(true, `${label} ${what} node --check 通过（${entry.rel}/${txt.length}B）`);
      } catch (e) {
        ok(false, `${label} ${what} node --check 失败: ${e.message}`);
      }
    }
    console.log(`  （${label} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }

  // ---- 5b. evalNetArgs：假镜像根 + 假 CODEX_HOME 的 8 组场景 ----
  head('net 补丁：evalNetArgs 场景（假镜像根 + 假 CODEX_HOME）');
  if (!patchedText) {
    console.log('  跳过（没有可用的真实 bundle 样本）');
  } else {
    // 假镜像根布局：<root>/app/ChatGPT.exe（假 process.execPath）、<root>/codex-launcher-overrides.json、
    // <root>/home/{auth.json,config.toml}（假 CODEX_HOME）。绝不用真实 ~/.codex，也不用真实镜像目录。
    // 夹具 TOML 就是用户现状形态（cc-switch 的第三方供应商：requires_openai_auth = false、key 在 auth.json）。
    const TOML_USER = 'model_provider = "custom"\nmodel = "gpt-6-astra"\n\n[model_providers.custom]\n'
      + 'name = "custom"\nbase_url = "https://vulcanapi.com/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n';
    const AUTH_OK = { OPENAI_API_KEY: 'sk-probe-patchtest-0000' };
    let seq = 0;
    function makeEnv(opts = {}) {
      const root = path.join(NET_TMP, 'env' + (seq++));
      const home = path.join(root, 'home');
      fs.mkdirSync(path.join(root, 'app'), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      if (opts.authJson !== undefined) fs.writeFileSync(path.join(home, 'auth.json'), typeof opts.authJson === 'string' ? opts.authJson : JSON.stringify(opts.authJson));
      if (opts.toml !== undefined) fs.writeFileSync(path.join(home, 'config.toml'), opts.toml);
      return { root, home, fakeProcess: { execPath: path.join(root, 'app', 'ChatGPT.exe'), env: { CODEX_HOME: home } } };
    }
    // 写覆盖文件（规格 §5.3 固定格式 + §10.2 的 requiresOpenaiAuth 标志）
    const putOverrides = (env, ov) => fs.writeFileSync(path.join(env.root, core.NET_OVERRIDES_FILE), ov);
    const ovr = (catalogPath, provider, requiresOpenaiAuth = true) => JSON.stringify({
      version: 1, writer: 'patch-test', catalog: catalogPath,
      auth: provider === null ? null : { provider, requiresOpenaiAuth },
    });
    // 造一个真实存在的目录文件（在假镜像根下），返回写进覆盖文件的正斜杠绝对路径
    const putCatalog = env => {
      const c = path.join(env.root, 'merged.json').replace(/\\/g, '/');
      fs.writeFileSync(c, '{"models":[]}');
      return c;
    };
    const argsOf = env => core.evalNetArgs(patchedText, env.fakeProcess);
    const has = (args, v) => args.includes(v);

    // 场景 1：catalog 存在 + auth 有 key + config 有 custom 表 -> 两条覆盖都推
    {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      const cat = putCatalog(env);
      putOverrides(env, ovr(cat, 'custom'));
      const a = argsOf(env);
      const want = ['app-server', '-c', 'features.code_mode_host=true', '-c',
        'model_catalog_json=' + JSON.stringify(cat), '-c',
        'model_providers.custom.requires_openai_auth=true', '--analytics-default-enabled'];
      ok(JSON.stringify(a) === JSON.stringify(want), `场景 1 完整产物 = ${showArgs(want)}\n         实际 = ${showArgs(a)}`);
    }
    // 场景 1b：auth 少了 requiresOpenaiAuth=true（§10.2 的决定）-> 运行时必须不加鉴权项
    {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom', false));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 1b auth 缺 requiresOpenaiAuth 时不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 1c：内置 provider id 白名单（§10.1 运行时第二道防线）-> 即使 requiresOpenaiAuth=true 也不加
    for (const id of ['openai', 'ollama', 'lmstudio', 'amazon-bedrock']) {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      // 表名用 custom，但覆盖文件里的 provider 是内置 id（模拟"会话中途把 model_provider 改成内置 id"）
      putOverrides(env, ovr(null, id));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 1c 内置 id ${id} 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 2：config.toml 里没有 custom 表 -> 没有鉴权项（catalog 项照旧）
    {
      const env = makeEnv({ toml: 'model_provider = "other"\n[model_providers.other]\nname = "o"\nbase_url = "https://o/v1"\n', authJson: AUTH_OK });
      const cat = putCatalog(env);
      putOverrides(env, ovr(cat, 'custom'));
      const a = argsOf(env);
      ok(has(a, 'model_catalog_json=' + JSON.stringify(cat)) && !a.some(x => x.includes('requires_openai_auth')),
        `场景 2 没有 custom 表 -> 只有目录项（实际 ${showArgs(a)}）`);
    }
    // 场景 3：auth.json 是官方登录（有 tokens）-> 没有鉴权项
    {
      const env = makeEnv({ toml: TOML_USER, authJson: { tokens: { access_token: 'probe-not-a-real-token' } } });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 3 auth.json 有 tokens -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 3b：auth.json 里 OPENAI_API_KEY 为空/缺失 -> 没有鉴权项
    for (const [label, aj] of [['空字符串', { OPENAI_API_KEY: '   ' }], ['缺字段', {}]]) {
      const env = makeEnv({ toml: TOML_USER, authJson: aj });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 3b auth.json KEY ${label} -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 4：custom 表自带别的鉴权方式 -> 没有鉴权项
    {
      const env = makeEnv({ toml: TOML_USER.replace('requires_openai_auth = false', 'requires_openai_auth = false\nenv_key = "MY_KEY"'), authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 4a custom 表有 env_key -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    {
      const env = makeEnv({ toml: TOML_USER + '\n[model_providers.custom.http_headers]\n"X-Api-Key" = "x"\n', authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 4b custom 子表 http_headers -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 4b-2：带引号的表头 + 带引号的子表（§4.3 原文对 [model_providers."<id>". 有专门判定，
    // 两边都必须挡住：表名剥引号后是同一个供应商）
    for (const [label, toml] of [
      ['双引号表头+子表', 'model_provider = "custom"\n[model_providers."custom"]\nname = "c"\n[model_providers."custom".http_headers]\n"X-Api-Key" = "x"\n'],
      ['单引号表头+子表', "model_provider = \"custom\"\n[model_providers.'custom']\nname = \"c\"\n[model_providers.'custom'.http_headers]\n\"X-Api-Key\" = \"x\"\n"],
      ['无引号表头+引号子表', 'model_provider = "custom"\n[model_providers.custom]\nname = "c"\n[model_providers."custom".http_headers]\n"X-Api-Key" = "x"\n'],
    ]) {
      const env = makeEnv({ toml, authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 4b-2 ${label} -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 4c：自定义 Authorization 头 / query_params / aws / auth 命令（同一份 bad 名单）
    for (const line of ['http_headers = { "X-Api-Key" = "x" }', 'query_params = { k = "v" }', 'aws = { region = "us-east-1" }', 'auth = "command"']) {
      const env = makeEnv({ toml: TOML_USER.replace('requires_openai_auth = false', 'requires_openai_auth = false\n' + line), authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 4c custom 表有 ${line.split(' ')[0]} -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 5：catalog 指向不存在的文件 / 相对路径 / 非字符串 -> 没有目录项（鉴权项照旧）
    for (const [label, c] of [['不存在的文件', 'ABS'], ['相对路径', 'merged.json'], ['null', null], ['数字', 42]]) {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      const cp = c === 'ABS' ? path.join(env.root, 'nope.json').replace(/\\/g, '/') : c;
      putOverrides(env, ovr(cp, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('model_catalog_json')) && a.includes('model_providers.custom.requires_openai_auth=true'),
        `场景 5 catalog=${label} -> 只有鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 6：没有覆盖文件 / 坏 JSON / version≠1 -> 与未打补丁的产物完全相同
    for (const [label, ov] of [
      ['没有覆盖文件', ''],
      ['坏 JSON', '{oops'],
      ['version=2', JSON.stringify({ version: 2, catalog: null, auth: { provider: 'custom', requiresOpenaiAuth: true } })],
      ['不是对象', '[1,2,3]'],
    ]) {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      if (ov) putOverrides(env, ov);
      const a = argsOf(env);
      ok(!a.some(x => x.includes('model_catalog_json')) && !a.some(x => x.includes('requires_openai_auth')),
        `场景 6 ${label} -> 不加任何覆盖（实际 ${showArgs(a)}）`);
      if (!core.hasNetPatch(origText)) {
        // 与"未打补丁"的产物比对（无覆盖文件时补丁必须完全透明）
        const a0 = core.evalNetArgs(origText, env.fakeProcess);
        ok(JSON.stringify(a) === JSON.stringify(a0), `场景 6 ${label}：注入后产物与原文一致（原文 ${showArgs(a0)}）`);
      }
      const want = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
      ok(JSON.stringify(a) === JSON.stringify(want), `场景 6 ${label} 产物 = ${showArgs(want)}（实际 ${showArgs(a)}）`);
    }
    // 场景 7：provider 名含非法字符 -> 没有鉴权项
    for (const bad of ['a"b', 'x]', 'a b', 'a.b', '', 'x'.repeat(65)]) {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      putOverrides(env, JSON.stringify({ version: 1, catalog: null, auth: { provider: bad, requiresOpenaiAuth: true } }));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `场景 7 provider=${JSON.stringify(bad)} -> 不加鉴权项（实际 ${showArgs(a)}）`);
    }
    // 场景 8：设了环境变量时原有映射仍然生效，且与覆盖并存（覆盖在后，顺序 = app-server 之后）
    {
      const env = makeEnv({ toml: TOML_USER, authJson: AUTH_OK });
      const cat = putCatalog(env);
      putOverrides(env, ovr(cat, 'custom'));
      const fp = { execPath: env.fakeProcess.execPath, env: Object.assign({}, env.fakeProcess.env, { CODEX_APP_SERVER_OPENAI_BASE_URL: 'https://echo.invalid/v1' }) };
      const a = core.evalNetArgs(patchedText, fp);
      const want = ['app-server', '-c', 'features.code_mode_host=true', '-c', 'openai_base_url="https://echo.invalid/v1"', '-c',
        'model_catalog_json=' + JSON.stringify(cat), '-c', 'model_providers.custom.requires_openai_auth=true', '--analytics-default-enabled'];
      ok(JSON.stringify(a) === JSON.stringify(want), `场景 8 环境变量映射与覆盖并存（顺序：app-server 之后）\n         期望 = ${showArgs(want)}\n         实际 = ${showArgs(a)}`);
      ok(a.indexOf('app-server') === 0, '场景 8 覆盖参数都在 app-server 之后（§10.4 的位置语义）');
    }
    // 额外：§10.2 的 TOML 边界写法都必须识别出 custom 表（否则用户会被少推参数）
    for (const [label, hdr] of [
      ['无引号', '[model_providers.custom]'],
      ['双引号', '[model_providers."custom"]'],
      ['单引号', "[model_providers.'custom']"],
      ['表头内空格', '[ model_providers.custom ]'],
      ['尾随注释', '[model_providers.custom] # 供应商'],
    ]) {
      const env = makeEnv({ toml: 'model_provider = "custom"\n' + hdr + '\nname = "custom"\nbase_url = "https://x/v1"\nrequires_openai_auth = false\n', authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(a.includes('model_providers.custom.requires_openai_auth=true'), `TOML 边界 ${label} 识别出 custom 表（实际 ${showArgs(a)}）`);
    }
    // CRLF 与 BOM（实测 codex 两者都接受，判定必须容忍）
    for (const [label, toml] of [['CRLF', TOML_USER.replace(/\n/g, '\r\n')], ['BOM', '\uFEFF' + TOML_USER], ['CRLF+BOM', '\uFEFF' + TOML_USER.replace(/\n/g, '\r\n')]]) {
      const env = makeEnv({ toml, authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(a.includes('model_providers.custom.requires_openai_auth=true'), `TOML 边界 ${label} 仍识别出 custom 表（实际 ${showArgs(a)}）`);
    }
    // 已知边界（§10.2）：顶层点号键 / inline table 按"不识别"处理（假阴性可接受，宁少推不错推）
    for (const [label, toml] of [
      ['顶层点号键', 'model_provider = "custom"\nmodel_providers.custom.name = "custom"\n'],
      ['inline table', 'model_provider = "custom"\nmodel_providers.custom = { name = "custom", base_url = "https://x/v1" }\n'],
    ]) {
      const env = makeEnv({ toml, authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `TOML 边界 ${label} 按不识别处理（假阴性可接受，实际 ${showArgs(a)}）`);
    }
    // 多行字符串里的表头：**必须判失败**（不是 INFO）。
    // 原因（实测，第 2 轮审查发现）：假表头会让 launcher 判"表存在" -> 写 auth 覆盖 ->
    // 注入函数推 `-c model_providers.<id>.requires_openai_auth=true`，而 config 里其实没有那张表 ->
    // 真实 codex.exe 实测 app-server **39~61ms 后以退出码 1 退出**（stderr
    // `Error: model_providers.custom: provider name must not be empty`），不是"最坏少推参数"，
    // 而是用户打开解锁版后整块功能不可用。所以这里按"必须不推出鉴权项"硬断言。
    // 对照：不带该 -c 时 app-server 正常应答（只打 `Invalid configuration; using defaults`）。
    for (const [label, toml] of [
      ['三引号 """', 'model_provider = "custom"\nnote = """\n[model_providers.custom]\nname = "custom"\nbase_url = "https://relay.invalid/v1"\n"""\n'],
      ["字面量三引号 '''", "model_provider = \"custom\"\nnote = '''\n[model_providers.custom]\nname = 'custom'\nbase_url = 'https://relay.invalid/v1'\n'''\n"],
      ['假表头在 """ 内且带引号', 'model_provider = "custom"\ndoc = """\n[model_providers."custom"]\n"""\n'],
    ]) {
      const env = makeEnv({ toml, authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')),
        `多行字符串里的假表头（${label}）不识别为真表 -> 不推致命 -c（实际 ${showArgs(a)}）`);
    }
    // 反向：真表存在时，多行字符串里的**干扰行**不能把真表吃掉（否则用户仍 401、但日志说"已修"）
    for (const [label, toml] of [
      ['真表 + """ 里的子表名', TOML_USER + '\nnote = """\n[model_providers.custom.http_headers]\n"""\n'],
      ['真表 + """ 里的 env_key 行', TOML_USER + '\nnote = """\nenv_key = "X"\n"""\n'],
      ["真表 + ''' 里的 auth 行", TOML_USER + "\ndoc = '''\nauth = \"cmd\"\n'''\n"],
      ['真表 + 同行开闭 """x""" 干扰', 'model_provider = "custom"\nnote = """[model_providers.custom.http_headers]"""\n' + TOML_USER.replace(/^model_provider = "custom"\n/, '')],
    ]) {
      const env = makeEnv({ toml, authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(a.includes('model_providers.custom.requires_openai_auth=true'),
        `真表 + 多行字符串干扰（${label}）仍推鉴权项（实际 ${showArgs(a)}）`);
    }
    // 真表**被**多行字符串包住 -> 该表实际不存在 -> 不推（与 launcher 侧 providerTableInfo 同源）
    {
      const env = makeEnv({ toml: 'model_provider = "custom"\nnote = """\n' + TOML_USER.replace(/^model_provider = "custom"\n/, '') + '"""\n', authJson: AUTH_OK });
      putOverrides(env, ovr(null, 'custom'));
      const a = argsOf(env);
      ok(!a.some(x => x.includes('requires_openai_auth')), `真表被 """ 包住（实际不存在）-> 不推鉴权项（实际 ${showArgs(a)}）`);
    }
    // 多行字符串的**转义语义**必须与 launcher 的 findMultiEnd 同源（第 3 轮审查指出的残留分歧）。
    // `"""` 是基本字符串："\"""" 里的引号被反斜杠转义、**不算收尾**（数前面连续反斜杠个数，奇数=转义）；
    // `'''` 是字面量字符串、没有转义。不看转义会把该行当收尾 -> 字符串提前结束 -> 后面一张真表被漏掉
    // （实测分歧形态：launcher 判 direct-no-credential 会写覆盖，而这里不推 -c -> 用户仍 401 但日志说"已修"）。
    {
      const TBL = '[model_providers.custom]\nname = "c"\nbase_url = "https://x/v1"\nrequires_openai_auth = false\n';
      const cases = [
        ['转义引号行（奇数反斜杠）不算收尾 -> 后面的真表仍被识别', 'model_provider = "custom"\ndoc = """\na \\"""\n"""\n' + TBL, true],
        ['转义引号在同行开头 -> 同理', 'model_provider = "custom"\ndoc = """a\\"""\n"""\n' + TBL, true],
        ['偶数反斜杠（\\\\"""）不是转义 -> 该行确实收尾', 'model_provider = "custom"\ndoc = """\na \\\\"""\n' + TBL, true],
        ['假表在转义引号之后的字符串内部 -> 仍不识别', 'model_provider = "custom"\ndoc = """\na \\"""\n[model_providers.custom]\nname = "c"\n', false],
        ['字面量串 \'\'\' 里的 a 加上反斜杠+三引号同样算收尾（无转义语义，与 launcher 一致）', 'model_provider = "custom"\ndoc = \'\'\'\na \\\'\'\'\n' + TBL, true],
        ["字面量串里含 \"\"\" 文本（不该被当定界符，真表仍可见）", "model_provider = \"custom\"\ndoc = '''\ntext with \"\"\" inside\n'''\n" + TBL, true],
        ["基本串里含 ''' 文本（不影响后面的真表）", "model_provider = \"custom\"\ndoc = \"\"\"\ntext with ''' inside\n\"\"\"\n" + TBL, true],
      ];
      for (const [label, toml, expect] of cases) {
        const env = makeEnv({ toml, authJson: AUTH_OK });
        putOverrides(env, ovr(null, 'custom'));
        const a = argsOf(env);
        const got = a.includes('model_providers.custom.requires_openai_auth=true');
        ok(got === expect, `多行字符串转义：${label}（期望推=${expect} 实际=${got}，${showArgs(a)}）`);
      }
    }
    // evalNetArgs 的异常路径：给垃圾文本必须抛中文错误，不能静默返回
    for (const [label, txt] of [['空文本', ''], ['无关文本', 'var a=1;'], ['没有 flatMap 的 ec', 'function ec(){return[`app-server`,`--analytics-default-enabled`]}']]) {
      let threw = null;
      try { core.evalNetArgs(txt, { execPath: 'C:/x/app/ChatGPT.exe', env: {} }); } catch (e) { threw = e; }
      ok(!!threw && /[\u4e00-\u9fa5]/.test(threw.message), `evalNetArgs ${label} -> 抛中文错误（${threw ? threw.message.slice(0, 60) : '没有抛错'}）`);
    }
    // evalNetArgs 的抽取必须认结构不认位置：同尾函数（不含 flatMap）在 ec 之前或之后都不能抢走它。
    // 这条尤其防"注入的 launcherOverrides 就在 ec 尾部之后"的形态（补丁后的文本正是这样）。
    {
      const ecBody = 'function ec(){let e=Es.flatMap(({configKey:e,envVar:t})=>{let n=process.env[t]?.trim();'
        + 'return n==null||n===``?[]:[`-c`,`${e}=${JSON.stringify(n)}`]});'
        + 'return e.length===0?[...Ts,`app-server`,`--analytics-default-enabled`]:[`app-server`,...Ts,...e,`--analytics-default-enabled`]}';
      const consts = 'var Ts=[`-c`,`features.code_mode_host=true`],'
        + 'Es=[{configKey:`chatgpt_base_url`,envVar:`CODEX_APP_SERVER_CHATGPT_BASE_URL`},{configKey:`openai_base_url`,envVar:`CODEX_APP_SERVER_OPENAI_BASE_URL`}];';
      const decoyTail = 'function decoy(){return[`app-server`,`--analytics-default-enabled`]}';
      const decoyFn = 'function other() { var q=require("fs"); return []; }';
      // 尾巴形状的串在别处（前面没有 function 声明与之配对）
      const strayTail = 'var zz=`x`;zz+=\'`--analytics-default-enabled`]}\'';
      for (const [label, txt] of [
        ['诱饵在同尾之前', consts + ecBody + ecBody + decoyTail],
        ['诱饵（带空格函数头）在同尾之后', consts + ecBody + decoyFn],
        ['尾巴形状的串在别处', consts + ecBody + strayTail],
      ]) {
        let args = null, threw = null;
        try { args = core.evalNetArgs(txt, { execPath: 'C:/x/app/ChatGPT.exe', env: {} }); } catch (e) { threw = e; }
        ok(!!threw || (Array.isArray(args) && args[0] === '-c' && args[2] === 'app-server'),
          `evalNetArgs 抽取认结构不认位置（${label}）：${threw ? '抛错 ' + threw.message.slice(0, 50) : JSON.stringify(args)}`);
      }
    }
  }
} finally {
  fs.rmSync(NET_TMP, { recursive: true, force: true });
}

// ---------- 6. 真实 asar：定位 + 补丁 + 重打包往返 ----------
const asarArg = process.argv.find(a => a.startsWith('--asar'));
if (asarArg) {
  const explicit = asarArg.includes('=') ? asarArg.slice(asarArg.indexOf('=') + 1) : null;
  // 结构往返测试对任意 asar 都成立，但"补丁命中"必须在**未打补丁**的样本上有意义：
  // app.asar.backup-20261001 是旧版（26.928.21956）未打补丁样本，补丁集必须 failCount===0（允许走变体）；
  // 镜像目录里那份是已经打过补丁的（gate 标记已被改写掉），只作最后的兜底。
  const candidates = explicit ? [explicit] : [
    path.join(ROOT, 'app.asar.backup-20261001'),
    path.join(os.homedir(), 'ChatGPT-Patched', 'app', 'resources', 'app.asar'),
  ];
  const src = candidates.find(p => fs.existsSync(p));
  head('真实 asar 往返: ' + (src || '(未找到，跳过)'));
  if (!src) {
    console.log('  跳过（没有可用的 asar 样本）');
  } else {
    const t0 = Date.now();
    const loc = core.locateBundles(src);
    try {
      const found = Object.entries(loc.role).filter(([, e]) => e);
      if (!found.length) {
        console.log('  跳过：这个 asar 里找不到任何原始 bundle 标记（多半是已打过补丁的镜像），结构往返改用最小样本');
        const tmp = path.join(os.tmpdir(), 'codex-mini.asar');
        const json = Buffer.from(JSON.stringify({ files: { 'a.txt': { size: 3, offset: '0' } } }), 'utf8');
        const payloadLen = Math.ceil((4 + json.length) / 4) * 4, headerSize = 4 + payloadLen;
        const buff = Buffer.alloc(16);
        buff.writeUInt32LE(4, 0); buff.writeUInt32LE(headerSize, 4); buff.writeUInt32LE(payloadLen, 8); buff.writeUInt32LE(json.length, 12);
        fs.writeFileSync(tmp, Buffer.concat([buff, json, Buffer.alloc(8 + headerSize - 16 - json.length), Buffer.from('abc', 'latin1')]));
        const a = core.readAsar(tmp);
        const ents = core.listAsarEntries(a.header);
        const fd = fs.openSync(tmp, 'r');
        const got = core.readAsarEntry(fd, a.dataBase, ents[0]).toString('latin1');
        fs.closeSync(fd);
        ok(got === 'abc', '最小 asar 读写往返');
        fs.rmSync(tmp, { force: true });
      } else {
        for (const [name, e] of Object.entries(loc.role)) ok(!!e, `定位 ${name} -> ${e ? e.rel + ' (' + e.size + 'B)' : '未命中'}`);
        const rels = new Set(found.map(([, e]) => e.rel));
        ok(rels.size === found.length, `${found.length} 个已定位角色落在不同 bundle 上；其余角色缺失`);

        // 真实数据上应用整份补丁集：未打补丁样本必须全部命中（旧版走变体）——failCount 必须为 0
        const c2 = new Map();
        for (const [, e] of found) c2.set(e.rel, loc.text(e));
        const role2 = Object.fromEntries(found);
        const r2 = core.applyPatchSet(c2, role2);
        printResults(r2.results);
        ok(r2.failCount === 0, `补丁全部命中 ${r2.results.length - r2.failCount}/${r2.results.length}（允许走变体，failCount 必须为 0）`);
        checkSyntax(c2, '该 asar 的补丁产物');

        // 重打包到临时文件并回读校验（541MB 级文件，用 finally 保证删除）
        const entries = core.listAsarEntries(loc.header);
        const patched = new Map([...c2].map(([rel, s]) => [rel, Buffer.from(s, 'latin1')]));
        const out = path.join(os.tmpdir(), 'codex-asar-roundtrip.asar');
        try {
          const { jsonBuf, bytes } = core.writeAsar({
            srcPath: src, dstPath: out, header: loc.header, entries, patched, srcDataBase: loc.dataBase,
          });
          const re = core.readAsar(out);
          ok(re.jsonBuf.equals(jsonBuf), '回读的 header JSON 与写出的一致');
          const reEntries = core.listAsarEntries(re.header);
          ok(reEntries.length === entries.length, `条目数一致 (${reEntries.length})`);
          let mismatch = 0, checked = 0;
          for (const e of reEntries) {
            const want = patched.get(e.rel);
            if (!want) continue;
            const got = core.readAsarEntry(fs.openSync(out, 'r'), re.dataBase, e);
            checked++;
            if (!got.equals(want)) mismatch++;
            const integ = e.node.integrity;
            if (integ && integ.hash !== core.sha256Hex(want)) mismatch++;
          }
          ok(mismatch === 0, `被改写的 ${checked} 个条目内容与 integrity 全部正确`);
          // 未改写的条目应当逐字节相同
          const orig64 = fs.openSync(src, 'r'), new64 = fs.openSync(out, 'r');
          let same = true;
          for (const e0 of entries.slice(0, 40)) {
            const m = reEntries.find(x => x.rel === e0.rel);
            if (!m || patched.has(e0.rel)) continue;
            const a = Buffer.alloc(Math.min(e0.size, 4096));
            const b = Buffer.alloc(Math.min(e0.size, 4096));
            fs.readSync(orig64, a, 0, a.length, loc.dataBase + e0.offset);
            fs.readSync(new64, b, 0, b.length, re.dataBase + m.offset);
            if (!a.equals(b)) same = false;
          }
          fs.closeSync(orig64); fs.closeSync(new64);
          ok(same, '未改动条目的前 4KB 逐字节一致（抽查 40 个）');
          ok(bytes === fs.statSync(out).size, `写出字节数与文件大小一致 (${bytes})`);
        } finally {
          fs.rmSync(out, { force: true }); // 大文件必须删
        }
        console.log(`  （耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      }
    } finally {
      try { fs.closeSync(loc.fd); } catch (e) {}
    }
  }
}

// 正常结束：收掉看门狗的心跳定时器与 worker（unref 已经能保证不拖延退出，
// 显式 terminate 只是让"正常路径绝不因看门狗多停留"不依赖 unref 的实现细节）
if (wdBeat) { try { clearInterval(wdBeat); } catch (e) {} }
if (wdHandle) { try { wdHandle.terminate(); } catch (e) {} }
console.log('\n' + (failures === 0 ? '全部通过' : `${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);
