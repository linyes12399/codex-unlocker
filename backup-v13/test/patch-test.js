// 离线回归测试：验证平台无关核心（lib/launcher-core.js）
//   node test/patch-test.js            补丁集 + 变体/分组/部分解锁语义（快，用仓库里的 bundle 样本）
//   node test/patch-test.js --asar     额外做真实 asar 的定位+补丁+重打包往返（慢，需要 app.asar 备份）
//   node test/patch-test.js --asar=<path>
//   node test/patch-test.js --strict   黄金样本比对失败时计为 FAIL（默认只 WARN）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ---------- 5. 真实 asar：定位 + 补丁 + 重打包往返 ----------
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

console.log('\n' + (failures === 0 ? '全部通过' : `${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);
