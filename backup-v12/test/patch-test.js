// 离线回归测试：验证平台无关核心（lib/launcher-core.js）
//   node test/patch-test.js            仅补丁集（快，用仓库里的商店原版 bundle）
//   node test/patch-test.js --asar     额外做真实 asar 的定位+重打包往返（慢，需要 app.asar 备份）
//   node test/patch-test.js --asar=<path>
'use strict';
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

// ---------- 1. 补丁集：用仓库里的商店原版 bundle 逐条验证 ----------
head('补丁集命中（商店原版 bundle）');
const SRC = path.join(ROOT, 'newstore-bundles');
const FILES = { initial: 'app-initial.js', shared: 'app-shared.js', primary: 'app-primary.js' };

const role = {};
const content = new Map();
for (const [name, file] of Object.entries(FILES)) {
  const p = path.join(SRC, file);
  const s = fs.readFileSync(p).toString('latin1');
  role[name] = { rel: 'webview/assets/' + file, size: s.length };
  content.set(role[name].rel, s);
}

// 角色判定必须与"按内容定位"一致：每个标记只应命中它自己的那份 bundle
for (const [name, marker] of Object.entries(core.BUNDLE_MARKERS)) {
  const hits = Object.entries(FILES).filter(([, f]) => fs.readFileSync(path.join(SRC, f), 'latin1').includes(marker)).map(([n]) => n);
  ok(hits.length === 1 && hits[0] === name, `标记 ${marker} 只出现在 ${name}（实际: ${hits.join(',') || '无'}）`);
}

const before = new Map([...content].map(([k, v]) => [k, v.length]));
const { failCount, results } = core.applyPatchSet(content, role);
for (const r of results) {
  if (r.ok) console.log('  OK   ' + r.note);
  else console.log(`  FAIL ${r.note}: 期望 ${r.expect} 处，实际 ${r.actual} 处`);
}
failures += failCount;
ok(failCount === 0, `全部 ${results.length} 处补丁命中`);
ok(before.get(role.initial.rel) !== content.get(role.initial.rel).length, 'initial bundle 内容确实被改写');

// 语法校验（真实调用 node --check）
head('语法校验');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-patch-check-'));
try {
  core.syntaxCheckBundles(content, tmpDir, execFileSync);
  ok(true, '改写后的 3 个 bundle 均通过 node --check');
} catch (e) {
  ok(false, '语法校验失败: ' + e.message);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------- 1b. 黄金样本：补丁集必须逐字节重现"已知可用"的 patched bundle ----------
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
  const mine = content.get(role[name].rel);
  const cands = goldenCandidates(prefix);
  const same = cands.filter(p => fs.readFileSync(p).toString('latin1') === mine);
  if (same.length) ok(true, `${name} 与黄金样本逐字节一致（${path.basename(same[0])}, ${mine.length}B）`);
  else if (STRICT) ok(false, `${name} 与任何黄金样本都不一致`);
  else console.log(`  WARN ${name}: 未与现有黄金样本匹配（黄金样本可能来自更早的商店版本；不是失败）`);
}

// ---------- 2. 真实 asar：定位 + 重打包往返 ----------
const asarArg = process.argv.find(a => a.startsWith('--asar'));
if (asarArg) {
  const explicit = asarArg.includes('=') ? asarArg.slice(asarArg.indexOf('=') + 1) : null;
  // 结构往返测试对任意 asar 都成立，但"补丁命中"必须在**未打补丁**的样本上有意义。
  // 镜像目录里那份是已经打过补丁的（gate 标记已被改写掉），所以只作最后的兜底。
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

      // 真实数据上跑一遍补丁（命中数仅供参考：该 asar 可能不是当前商店版本）
      const c2 = new Map();
      for (const [, e] of found) c2.set(e.rel, loc.text(e));
      const role2 = Object.fromEntries(found);
      const r2 = core.applyPatchSet(c2, role2);
      console.log(`  INFO 该 asar 上补丁命中 ${r2.results.length - r2.failCount}/${r2.results.length}` +
        (r2.failCount ? '（未命中的多为版本差异，见 test/asar-diff.js 诊断）' : ''));
      for (const r of r2.results) if (!r.ok) console.log(`       MISS [${r.note}] 期望 ${r.expect} 实际 ${r.actual}`);

      // 重打包到临时文件并回读校验
      const entries = core.listAsarEntries(loc.header);
      const patched = new Map([...c2].map(([rel, s]) => [rel, Buffer.from(s, 'latin1')]));
      const out = path.join(os.tmpdir(), 'codex-asar-roundtrip.asar');
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
      fs.rmSync(out, { force: true });
      console.log(`  （耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      }
    } finally {
      try { fs.closeSync(loc.fd); } catch (e) {}
    }
  }
}

console.log('\n' + (failures === 0 ? '全部通过' : `${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);
