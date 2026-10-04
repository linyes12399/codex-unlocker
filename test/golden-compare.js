// 溯源比对：用当前补丁集处理 newstore-bundles，看是否逐字节重现已知可用的 patched-bundles / extracted-asar
//   node test/golden-compare.js
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../lib/launcher-core.js');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(p).toString('latin1');

const SRC = path.join(ROOT, 'newstore-bundles');
const role = {}, content = new Map();
for (const [name, file] of Object.entries({ initial: 'app-initial.js', shared: 'app-shared.js', primary: 'app-primary.js' })) {
  role[name] = { rel: file };
  content.set(file, read(path.join(SRC, file)));
}
const before = new Map([...content].map(([k, v]) => [k, v.length]));
const { failCount } = core.applyPatchSet(content, role);
console.log('补丁命中失败数:', failCount);

const dirs = {
  'patched-bundles': path.join(ROOT, 'patched-bundles'),
  'extracted-asar/webview/assets': path.join(ROOT, 'extracted-asar', 'webview', 'assets'),
};
const base = { initial: 'app-initial', shared: 'app-shared', primary: 'app-primary' };

for (const [label, dir] of Object.entries(dirs)) {
  if (!fs.existsSync(dir)) { console.log(`\n[${label}] 不存在，跳过`); continue; }
  console.log(`\n[${label}]`);
  for (const [name, prefix] of Object.entries(base)) {
    const cands = fs.readdirSync(dir).filter(f => f.startsWith(prefix + '-') && f.endsWith('.js'));
    if (!cands.length) { console.log(`  ${name}: 无候选`); continue; }
    const mine = content.get(role[name].rel);
    for (const c of cands) {
      const other = read(path.join(dir, c));
      const same = other === mine;
      console.log(`  ${name} vs ${c}: ${same ? '逐字节相同 <<==' : `不同（本地 ${mine.length}B / 该文件 ${other.length}B）`}`);
    }
  }
}

// 反向：这些"已知可用"的 patched 文件里是否已经包含补丁特征（判断它们是否已打过补丁）
console.log('\n[特征检查]');
const marks = {
  'gate 已打(!0 取代 gate 调用)': s => !s.includes('`536305374`'),
  'includeUltra=!0': s => s.includes('m=!0'),
  'service_tier||"ultrafast"': s => s.includes('||"ultrafast"'),
  'isServiceTierAllowed d=!0': s => s.includes('d=!0'),
};
const probes = {
  'newstore-bundles/app-initial.js': path.join(SRC, 'app-initial.js'),
  'patched-bundles/app-initial-3916b423772b.js': path.join(ROOT, 'patched-bundles', 'app-initial-3916b423772b.js'),
  'patched-bundles/app-initial-fd3c4b862660.js': path.join(ROOT, 'patched-bundles', 'app-initial-fd3c4b862660.js'),
  'extracted app-initial-3916b423772b.js': path.join(ROOT, 'extracted-asar', 'webview', 'assets', 'app-initial-3916b423772b.js'),
};
for (const [label, p] of Object.entries(probes)) {
  if (!fs.existsSync(p)) { console.log(`  ${label}: 不存在`); continue; }
  const s = read(p);
  const hit = Object.entries(marks).map(([k, f]) => `${f(s) ? 'Y' : 'n'}:${k}`).join('  ');
  console.log(`  ${label} (${s.length}B)\n      ${hit}`);
}
