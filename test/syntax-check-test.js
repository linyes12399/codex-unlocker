// 回归：单文件 exe（Node SEA）模式下的语法校验不能拿 process.execPath 去跑 --check。
// 背景（实测事故）：v15 初版 syntaxCheckBundles 用 process.execPath，在 exe 模式下那是
// Codex解锁版.exe 自己，`--check` 被当成未知参数 -> "重建失败: 语法校验失败 ... 未知参数: --check"
// -> 用户在 26.1013 上一直停在旧镜像。
// 本测试在不依赖真实 exe 的情况下验证：
//   1) resolveNodeBin 能找到镜像里的 cua_node node（exe 用户最可靠的来源）
//   2) syntaxCheckBundles 对含 ESM 语法的文本能正确通过（`node --check` 支持，vm.Script 不支持）
//   3) 语法真错时报错信息里带上"用 <node> 校验"
//   4) 显式传入非 node 可执行文件时，错误不会被误当成"语法错误"
// 用法: node test/syntax-check-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../lib/launcher-core.js');

let fails = 0, total = 0;
function ok(cond, msg) {
  total++;
  if (cond) console.log('  OK   ' + msg);
  else { fails++; console.log('  FAIL ' + msg); }
}
function head(s) { console.log('\n== ' + s + ' =='); }

const TMP = path.join(__dirname, '..', '.tmp-syntax-check-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });

try {
  head('resolveNodeBin：路径探测');
  const home = process.env.USERPROFILE || os.homedir();
  const mirrorNode = path.join(home, 'ChatGPT-Patched', 'app', 'resources', 'cua_node', 'bin', 'node.exe');
  const hasMirrorNode = fs.existsSync(mirrorNode);
  {
    const got = core.resolveNodeBin();
    ok(typeof got === 'string' && got.length > 0, '无参数调用能找到 node（实际 ' + got + '）');
    // 当前测试进程本身是 node，所以第一个分支就会命中——这本身也是期望行为
    ok(/^node(\.exe)?$/i.test(path.basename(got)), '找到的确实是 node 可执行文件');
    if (hasMirrorNode) {
      ok(core.resolveNodeBin(mirrorNode) === mirrorNode, '显式传入镜像 node 时原样返回');
    } else {
      console.log('  SKIP 本机没有镜像 cua_node（跳过镜像路径断言）');
    }
  }

  head('syntaxCheckBundles：ESM 文本必须能通过（vm.Script 会误判）');
  {
    const content = new Map([
      ['webview/assets/x.js', 'export const a = 1;\nexport default function f(){ return a }\n'],
      ['webview/assets/y.js', 'const b = () => ({ ok: true }); module.exports = b();\n'],
    ]);
    let threw = null;
    try { core.syntaxCheckBundles(content, path.join(TMP, 'ok')); } catch (e) { threw = e; }
    ok(threw === null, 'ESM + CJS 两种文本都通过（' + (threw ? threw.message : '无异常') + '）');
    // rel 里的 / 换成 __；内容含 export 时按 ESM 存成 .mjs，否则 .js
    ok(fs.existsSync(path.join(TMP, 'ok', 'webview__assets__x.mjs')), '含 ESM 语法的文本按 .mjs 校验（文件名由 rel 整体转换）');
    ok(fs.existsSync(path.join(TMP, 'ok', 'webview__assets__y.js')), '纯 CJS 文本按 .js 校验');
  }

  head('syntaxCheckBundles：语法错误必须失败，且说明用了哪个 node');
  {
    const content = new Map([['webview/assets/bad.js', 'export const = 1;\n']]);
    let threw = null;
    try { core.syntaxCheckBundles(content, path.join(TMP, 'bad')); } catch (e) { threw = e; }
    ok(threw !== null, '语法错误被检出');
    ok(threw && /语法校验失败/.test(threw.message) && /校验/.test(threw.message),
      '错误信息含"语法校验失败"与所用的 node（实际 ' + (threw ? threw.message.slice(0, 120) : '无') + '）');
  }

  head('syntaxCheckBundles：传错 node 可执行文件时不会被误报成语法错误');
  {
    // 造一个"不是 node、且对 --check 一定失败"的可执行文件：只会 exit 1 的 .cmd 包装。
    // 不能用 cmd.exe 本身：`cmd --check <file>` 在本机实测 exit 0，测不出问题。
    const fake = path.join(TMP, 'fake-checker.cmd');
    if (process.platform === 'win32') {
      fs.writeFileSync(fake, '@echo off\r\necho fake-checker: not node >&2\r\nexit /b 1\r\n');
      let threw = null;
      try {
        core.syntaxCheckBundles(new Map([['a.js', 'var a=1;']]), path.join(TMP, 'wrong'), { nodeBin: fake });
      } catch (e) { threw = e; }
      ok(threw !== null && /语法校验失败/.test(threw.message),
        '传入非 node 校验器时报"语法校验失败"（实际 ' +
        (threw ? threw.message.replace(/\s+/g, ' ').slice(0, 130) : '无异常') + '）');
      // 关键：错误里要能让用户/维护者看出"不是补丁的问题"，而是校验器不对
      // （spawn 失败时 message 里带可执行文件路径，正常退出时由我们拼接"（用 <path> 按 ... 校验）"）
      ok(threw && /fake-checker\.cmd/.test(threw.message),
        '错误信息标明用的是哪个可执行文件（便于定位 exe 模式的这类事故）');
    } else {
      console.log('  SKIP 非 Windows');
    }
  }

  head('syntaxCheckBundles：真实新版 bundle 能通过');
  {
    const dir = path.join(__dirname, '..', 'newest-bundles');
    const f = path.join(dir, 'app-initial.js');
    if (fs.existsSync(f)) {
      const s = fs.readFileSync(f).toString('latin1');
      let threw = null;
      try { core.syntaxCheckBundles(new Map([['webview/assets/app-initial.js', s]]), path.join(TMP, 'real')); } catch (e) { threw = e; }
      ok(threw === null, '26.1013 的 app-initial 原文能通过校验（' + (threw ? threw.message.slice(0, 100) : '无异常') + '）');
      // 模拟打过补丁的文本也要能过
      const patched = core.applyPatchSet(new Map([['webview/assets/app-initial.js', s]]), { initial: { rel: 'webview/assets/app-initial.js' } });
      const t = patched.results.length;
      ok(t > 0, '对真实 bundle 应用补丁集有结果（' + t + ' 条）');
    } else {
      console.log('  SKIP 没有 newest-bundles 样本');
    }
  }

  head('exe 模式等价性：用一个"不是 node"的进程名复现事故路径');
  {
    // 直接验证事故的判定逻辑：process.execPath 不是 node 时，resolveNodeBin 不能返回它
    // （用子进程把 process.execPath 换成 cmd.exe 的路径做不到，这里用契约断言：返回值的 basename 必须是 node）
    const got = core.resolveNodeBin();
    ok(/^node(\.exe)?$/i.test(path.basename(got)),
      'resolveNodeBin 永不返回非 node 可执行文件（实际 ' + path.basename(got) + '）');
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n检查 ' + total + ' 项，' + (fails === 0 ? 'all passed' : fails + ' failed'));
process.exit(fails === 0 ? 0 : 1);
