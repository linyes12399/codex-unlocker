// pack-exe.js：把启动器打包成单文件 exe（Node 官方 SEA 方案，见 docs:
// https://nodejs.org/api/single-executable-applications.html）
// 用法: node pack-exe.js            生成 dist/Codex解锁版.exe，并做只读冒烟自测（--self-test）
//       node pack-exe.js --no-smoke 只打包，不自测
// 原理: codex-launcher.js + lib/launcher-core.js 合成单文件 bundle（运行时零 npm 依赖）
//       -> node --experimental-sea-config 生成 blob
//       -> 复制当前 node.exe 为 dist/Codex解锁版.exe
//       -> postject 把 blob 作为 PE 节注入 exe（postject 只在"打包机"上经 npx 一次性下载，不进发行物）
// 注意: 重新打包需要网络（首次拉取 postject）；exe 未签名，SmartScreen/杀软可能提示，属预期
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, '.tmp-sea-build'); // 中间产物（bundle/blob/sea 配置），结束删除
const EXE_NAME = 'Codex解锁版.exe';
const EXE_OUT = path.join(DIST, EXE_NAME);
// Node 官方文档指定的 SEA 哨兵熔丝名（postject 用它定位注入点）
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT_SPEC = 'postject@1.0.0-alpha.6'; // Node 24 官方文档使用的版本

function fail(msg) {
  console.error('[pack-exe] 失败:', msg);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error) fail(`${cmd} 没能正常结束: ${r.error.message}`);
  return r;
}

// ---------- 1) 合成单文件 bundle ----------
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
const coreSrc = fs.readFileSync(path.join(ROOT, 'lib', 'launcher-core.js'), 'utf8');
const launcherSrc = fs.readFileSync(path.join(ROOT, 'codex-launcher.js'), 'utf8');
// 把 launcher-core 包成模块内联进 bundle：等价于原来的 require('./lib/launcher-core.js')
const REQUIRE_LINE = "const core = require('./lib/launcher-core.js');";
if (!launcherSrc.includes(REQUIRE_LINE)) fail('codex-launcher.js 里找不到预期的 require 行，bundle 方案需要更新');
const coreInline =
  'const core = (function () {\n' +
  '  const module = { exports: {} };\n' +
  '  const exports = module.exports;\n' +
  coreSrc +
  '\n  return module.exports;\n' +
  '})();';
const bundle = launcherSrc.replace(REQUIRE_LINE, coreInline);
const bundlePath = path.join(BUILD, 'launcher-bundle.js');
fs.writeFileSync(bundlePath, bundle);
if (run(process.execPath, ['--check', bundlePath]).status !== 0) fail('bundle 语法校验失败:\n' + (run(process.execPath, ['--check', bundlePath]).stderr || ''));
console.log('[pack-exe] bundle 合成完成:', bundlePath, `(${Math.round(bundle.length / 1024)}KB)`);

// ---------- 2) 生成 SEA blob ----------
const seaConfig = path.join(BUILD, 'sea-config.json');
const blobPath = path.join(BUILD, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.basename(bundlePath),
  output: path.basename(blobPath),
  disableExperimentalSEAWarning: true, // 不弹"实验特性"警告
  useCodeCache: false,
  useSnapshot: false,
}));
const cfg = run(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: BUILD });
if (cfg.status !== 0) fail('生成 SEA blob 失败:\n' + (cfg.stderr || cfg.stdout));
if (!fs.existsSync(blobPath)) fail('blob 未生成');
console.log('[pack-exe] SEA blob 生成完成:', `(${Math.round(fs.statSync(blobPath).size / 1024)}KB)`);

// ---------- 3) 复制 node.exe 并注入 blob ----------
fs.mkdirSync(DIST, { recursive: true });
if (fs.existsSync(EXE_OUT)) fs.rmSync(EXE_OUT, { force: true });
fs.copyFileSync(process.execPath, EXE_OUT);
// postject 走 npx：优先用 node 安装目录里的 npx-cli.js（免 shell/免 PATH），退回 shell 的 npx
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const injectBase = [ '-y', POSTJECT_SPEC, EXE_OUT, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE ];
const inject = fs.existsSync(npxCli)
  ? run(process.execPath, [npxCli, ...injectBase], { stdio: ['ignore', 'pipe', 'pipe'] })
  : run('npx', injectBase, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
if (inject.status !== 0 || !/Injection done|injection done/i.test(inject.stdout + inject.stderr))
  fail(`postject 注入失败（退出码 ${inject.status}）:\n` + tail(inject.stdout + '\n' + inject.stderr, 2000));
const sizeMB = Math.round(fs.statSync(EXE_OUT).size / 1024 / 1024);
console.log(`[pack-exe] 注入完成: ${EXE_OUT} (${sizeMB}MB)`);
console.log('[pack-exe] 注入工具输出（末尾）:', tail((inject.stdout + ' ' + inject.stderr).replace(/\s+/g, ' '), 300));

// ---------- 4) 只读冒烟自测：exe 必须能以 --self-test 正常工作（严格只读，不会重建镜像/启动应用） ----------
if (!process.argv.includes('--no-smoke')) {
  console.log('[pack-exe] 冒烟自测: Codex解锁版.exe --self-test （只读，约几秒）...');
  const smoke = run(EXE_OUT, ['--self-test'], { timeout: 120000 });
  const out = (smoke.stdout + (smoke.stderr ? '\n[stderr]\n' + smoke.stderr : '')).trim();
  console.log(out.split(/\r?\n/).slice(-8).join('\n'));
  if (smoke.status !== 0) fail(`exe --self-test 退出码 ${smoke.status}（期望 0）`);
  if (!/补丁试跑通过/.test(out)) fail('exe --self-test 输出里没有找到"补丁试跑通过"');
  console.log('[pack-exe] 冒烟自测通过');
}
fs.rmSync(BUILD, { recursive: true, force: true });
console.log('[pack-exe] 完成 ->', EXE_OUT);
process.exit(0);

function tail(s, n) {
  s = String(s || '').trim();
  return s.length <= n ? s : '…' + s.slice(-n);
}
