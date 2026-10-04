// 调试：定位补丁后语法错误
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../lib/launcher-core.js');

const SRC = path.join(__dirname, '..', process.argv[2] || 'newstore-bundles');
const FILES = { initial: 'app-initial.js', shared: 'app-shared.js', primary: 'app-primary.js' };
const role = {}, content = new Map();
for (const [name, file] of Object.entries(FILES)) {
  role[name] = { rel: 'webview/assets/' + file };
  content.set(role[name].rel, fs.readFileSync(path.join(SRC, file)).toString('latin1'));
}
// 逐条应用，每条之后做一次语法检查，找出第一条把代码写坏的补丁
const tmp = path.join(os.tmpdir(), 'codex-dbg-' + process.pid + '.js');
let i = 0;
for (const p of core.PATCHES) {
  i++;
  const rel = role[p.file].rel;
  let s = content.get(rel);
  let actual;
  if (p.regex) {
    actual = (s.match(new RegExp(p.regex.source, 'g')) || []).length;
    if (actual === p.expect) s = p.repFn ? s.replace(new RegExp(p.regex.source, p.regex.flags), p.repFn) : s.replace(new RegExp(p.regex.source, p.regex.flags), p.rep);
  } else {
    actual = s.split(p.old).length - 1;
    if (actual === p.expect) s = s.split(p.old).join(p.rep);
  }
  if (actual !== p.expect) { console.log(`#${i} 未命中: ${p.note}`); continue; }
  const prev = content.get(rel);
  content.set(rel, s);
  const dir = path.join(os.tmpdir(), 'codex-dbg-' + process.pid);
  try {
    core.syntaxCheckBundles(new Map([[rel, s]]), dir, execFileSync);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`#${i} OK   ${p.file}/${p.note}`);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`#${i} BAD  ${p.file}/${p.note}`);
    console.log('---- 报错 ----');
    console.log(e.message.split('\n').slice(0, 8).join('\n'));
    // 打印改动点上下文
    const at = firstDiff(prev, s);
    console.log('---- 改动点上下文 ----');
    console.log(s.slice(Math.max(0, at - 300), at + 400));
    break;
  }
}
fs.rmSync(tmp, { force: true });

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
