// find-node.cmd 回归测试：验证 v14 新增的 node-path.txt 缓存候选（快，不运行启动器）
//   node test/find-node-test.js
// 沙箱：工作区 .tmp-find-node-<pid>\ 当作 USERPROFILE，绝不碰真实镜像/真实用户目录。
// 只读真实环境的部分只有 reg query 与 Get-AppxPackage（缓存未命中时的回落链路本来就会跑）。
// 用例：
//   (a) node-path.txt = 当前 process.execPath      -> NODE 就是它（缓存命中）
//   (a2) 缓存用正斜杠写法                          -> NODE 逐字等于它，证明确实读到了缓存
//        （回落链路只会给出反斜杠路径，所以这条能挡住"缓存整段坏掉但断言恒真"的盲区：
//         用商店包自带的 node 跑本测试时，(a) 会因候选 3 恰好返回同一路径而假通过）
//   (b) node-path.txt = 不存在的路径               -> 仍能找到某个 node（回落链路）
//   (c) node-path.txt = 各种注入载荷               -> 输出里不出现 INJECTED，仍能找到 node
//   (d) 没有 node-path.txt                         -> 与改动前（backup-v13 的同一份脚本）结果完全一致
//   (e) CODEX_NODE 已设置                          -> 仍然优先于缓存
// 最后一行 all passed / N failed，退出码对应。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'find-node.cmd');
const OLD_LIB = path.join(ROOT, 'backup-v13', 'lib', 'find-node.cmd'); // 只读对照：改动前的同一份脚本
const SANDBOX = path.join(ROOT, '.tmp-find-node-' + process.pid);
const CACHE = path.join(SANDBOX, 'ChatGPT-Patched', 'node-path.txt');
const FALLBACK_DIR = path.join(SANDBOX, 'fallback');
const FALLBACK_NODE = path.join(FALLBACK_DIR, 'node.exe');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK   ' : '  FAIL ') + msg); if (!cond) failures++; };
const head = t => console.log('\n== ' + t + ' ==');
const info = m => console.log('       ' + m);

// cmd 的中文提示是按控制台代码页（本机 GBK）输出的；Node 18+ 自带 TextDecoder('gbk')
function decode(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return Buffer.from(buf).toString('latin1'); }
}

// 跑一次 find-node.cmd 并取出它设置的 NODE。
// 观察方式必须是 `set NODE`：cmd 在解析整行时就会展开 %NODE%，`echo NODE=%NODE%` 只会打印
// 字面量（实测），所以按名字列出变量是唯一可靠的形式；`^%NODE^%` 也一样不行。
// 整条命令行用 windowsVerbatimArguments 原样交给 cmd，路径里的空格/中文/& 都不会被二次加工。
function runFindNode(libPath, o = {}) {
  // o.keepCache：保持调用方已经摆好的缓存位置不动（"缓存是目录"那一条用例用）
  if (!o.keepCache) {
    fs.rmSync(CACHE, { recursive: true, force: true });
    if (o.cache !== undefined) fs.writeFileSync(CACHE, Buffer.isBuffer(o.cache) ? o.cache : Buffer.from(o.cache, 'ascii'));
  }
  const root = path.parse(SANDBOX).root; // 'F:\'
  const env = { ...process.env };
  delete env.CODEX_NODE;
  if (o.codexNode !== undefined) env.CODEX_NODE = o.codexNode;
  Object.assign(env, {
    USERPROFILE: SANDBOX, HOME: SANDBOX,
    HOMEDRIVE: root.replace(/\\$/, ''), HOMEPATH: SANDBOX.slice(root.length - 1),
    LOCALAPPDATA: path.join(SANDBOX, 'AppData', 'Local'),
    APPDATA: path.join(SANDBOX, 'AppData', 'Roaming'),
    TEMP: path.join(SANDBOX, 'temp'), TMP: path.join(SANDBOX, 'temp'),
    ProgramFiles: path.join(SANDBOX, 'program-files'),
    'ProgramFiles(x86)': path.join(SANDBOX, 'program-files86'),
    // PATH 只留沙箱里的"回落 node"和 System32（cmd.exe/reg.exe 自己要能找到）。
    // 这样 (a) 命中缓存拿到的路径与回落链路给出的路径必然不同：断言才有判别力。
    PATH: FALLBACK_DIR + ';' + SYSTEM32,
  });
  const line = 'call "' + libPath + '" & set NODE';
  const r = spawnSync('cmd.exe', ['/d /c ' + line], {
    env, cwd: ROOT, encoding: 'buffer', windowsHide: true, windowsVerbatimArguments: true, timeout: 120000,
  });
  const out = decode(r.stdout || Buffer.alloc(0));
  const err = decode(r.stderr || Buffer.alloc(0));
  const m = out.match(/^NODE=(.*)$/m); // NODE_PATH=... 不会被匹配（NODE 后面是下划线）
  return { code: r.status, node: m ? m[1].trim() : null, out, err, error: r.error && r.error.message };
}

// 缓存文件的安全字符集必须与 launcher（§5.8 NODE_PATH_SAFE_RE）和 lib/find-node.cmd 里
// findstr 的白名单三者一致：launcher 只写含 [A-Za-z0-9 _.:\/-] 的路径，entry 只读这一集。
const SAFE_RE = /^[A-Za-z0-9 _.:\\/-]+$/;
const isNodeExe = s => !!s && /[\\/]node\.exe$/i.test(s);

try {
  // ---------- 沙箱与夹具 ----------
  head('沙箱与夹具');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const d of ['ChatGPT-Patched', path.join('AppData', 'Local'), path.join('AppData', 'Roaming'), 'temp',
    'program-files', 'program-files86']) fs.mkdirSync(path.join(SANDBOX, d), { recursive: true });
  fs.mkdirSync(FALLBACK_DIR, { recursive: true });
  ok(fs.existsSync(LIB), '被测脚本存在：' + path.relative(ROOT, LIB));
  const haveOld = fs.existsSync(OLD_LIB);
  info('改动前对照脚本：' + (haveOld ? path.relative(ROOT, OLD_LIB) : '不存在，用例 (d) 只能断言"仍能找到 node"'));

  // 回落链路里的"某个 node"：沙箱内一份 node.exe（路径与 process.execPath 不同，
  // 这样 (a) 的相等断言只能由缓存解释）。优先硬链接，省掉一份 89MB 的拷贝；不行再复制。
  try { fs.linkSync(process.execPath, FALLBACK_NODE); }
  catch (e) { fs.copyFileSync(process.execPath, FALLBACK_NODE); }
  ok(fs.statSync(FALLBACK_NODE).size === fs.statSync(process.execPath).size, '夹具：沙箱里放了一份 node.exe（回落链路用）');
  const fv = spawnSync(FALLBACK_NODE, ['-e', 'process.stdout.write(process.versions.node)'], { encoding: 'utf8', windowsHide: true });
  ok(fv.status === 0 && +String(fv.stdout).split('.')[0] >= 18, '夹具：副本是可运行的 node（' + String(fv.stdout).trim() + '）');
  info('缓存安全字符集判定用的 process.execPath：' + process.execPath);

  // ---------- (a) 缓存命中 ----------
  head('(a) node-path.txt = 当前 process.execPath');
  if (!SAFE_RE.test(process.execPath)) {
    // §5.8：launcher 对含白名单外字符的路径不写缓存文件，所以本用例在本机不适用
    info('跳过：本机 process.execPath 含缓存白名单之外的字符（launcher 不会写这种缓存）');
  } else {
    const a = runFindNode(LIB, { cache: process.execPath + '\r\n' });
    ok(a.code === 0, '(a) 退出码 0（实际 ' + a.code + (a.error ? ' ' + a.error : '') + '）');
    ok(a.node === process.execPath, '(a) NODE 等于缓存里的路径（实际 ' + JSON.stringify(a.node) + '）');
  }

  // ---------- (a2) 判别力自查：证明缓存这条候选真的在起作用（防断言恒真）----------
  // (a) 断言 NODE === process.execPath 有个盲区：如果测试恰好是用商店包自带的 node 跑的
  // （lib/find-node.cmd 的候选 3 正是那个路径），即使缓存候选整段坏掉，回落链路也会返回同一个
  // 路径、(a) 照样绿（实测确认过这个盲区）。
  // 这里用一个"回落链路给不出"的形态做判别：所有回落候选（reg query、where、文件系统枚举）
  // 返回的都是反斜杠路径，所以只要缓存值是"同一路径的正斜杠写法"，NODE 逐字等于它就只能来自缓存。
  // （工作区路径含中文、不在白名单内，所以造不出沙箱内的"够不到的路径"，只能用形态判别。）
  head('(a2) 缓存候选确实生效（判别力自查）');
  const fwd = String(process.execPath).replace(/\\/g, '/');
  if (!SAFE_RE.test(process.execPath)) {
    info('跳过：本机 process.execPath 含缓存白名单之外的字符（同 (a)，launcher 不会写这种缓存）');
  } else {
    const noCache = runFindNode(LIB, { cache: 'C:\\no-such-dir-' + process.pid + '\\node.exe\r\n' });
    const a2 = runFindNode(LIB, { cache: fwd + '\r\n' });
    ok(!String(noCache.node).includes('/'), '(a2) 回落链路给出的路径不含正斜杠（' + JSON.stringify(noCache.node) + '）');
    ok(a2.node === fwd, '(a2) 缓存用正斜杠写法时 NODE 逐字等于它（' + JSON.stringify(a2.node) + '）—— 只可能来自缓存');
  }

  // ---------- (b) 缓存失效 -> 回落链路 ----------
  head('(b) node-path.txt = 不存在的路径');
  const missing = 'C:\\no-such-dir-' + process.pid + '\\no-such-node.exe';
  const b = runFindNode(LIB, { cache: missing + '\r\n' });
  ok(b.code === 0, '(b) 退出码 0');
  ok(isNodeExe(b.node) && b.node !== missing, '(b) 仍能找到某个 node（实际 ' + JSON.stringify(b.node) + '）');
  info('(b) 回落链路给出的 node 与缓存路径不同，说明缓存失效没有把链路卡死');

  // ---------- (c) 注入载荷 ----------
  head('(c) node-path.txt = 注入载荷（一个都不许被当成命令执行）');
  const payloads = [
    ['& 命令分隔', 'C:\\x & echo INJECTED'],
    ['引号闭合 + rem 注释', 'C:\\x" & echo INJECTED & rem "'],
    ['^ 转义', 'C:\\x^& echo INJECTED'],
    ['| 管道', 'C:\\x|echo INJECTED'],
    ['< 重定向', 'C:\\x<echo INJECTED'],
    ['> 重定向', 'C:\\x>echo INJECTED'],
    ['% 二次展开', 'C:\\x%PATH% & echo INJECTED'],
    ['! 延迟展开', 'C:\\x! & echo INJECTED'],
    ['( 括号', 'C:\\x( & echo INJECTED'],
    [') 括号', 'C:\\x) & echo INJECTED'],
  ];
  for (const [label, value] of payloads) {
    const r = runFindNode(LIB, { cache: value + '\r\n' });
    const hit = (r.out + r.err).includes('INJECTED');
    ok(r.code === 0 && !hit && isNodeExe(r.node) && r.node !== value,
      '(c) ' + label + '：注入未执行、仍找到 node（实际 ' + JSON.stringify(r.node) + '）');
  }
  // 非 ASCII 字节：白名单外，必须整份丢弃（launcher 自己也不会写中文路径）
  const nonAscii = 'C:\\工具\\node.exe';
  const rc = runFindNode(LIB, { cache: Buffer.from(nonAscii + '\r\n', 'utf8') });
  ok(isNodeExe(rc.node) && rc.node !== nonAscii, '(c) 非 ASCII 路径：整份丢弃并回落（实际 ' + JSON.stringify(rc.node) + '）');

  // 白名单内的合法路径但不是 node.exe：必须整份丢弃并回落。
  // :try 单独用时会接受任何"能启动且退出码 0"的既有文件（cmd.exe 就算一个，实测），
  // 所以缓存这一路额外要求文件名以 node.exe 结尾（launcher 写的也一定是 node.exe）；
  // 这条同时挡住"缓存指向一个 .txt 文档，:try 把它 ShellExecute 起来"的情况。
  const notNode = path.join(SYSTEM32, 'cmd.exe');
  const rn = runFindNode(LIB, { cache: notNode + '\r\n' });
  ok(isNodeExe(rn.node) && rn.node !== notNode, '(c) 存在但不是 node（cmd.exe）：被拒并回落（实际 ' + JSON.stringify(rn.node) + '）');
  // 带空格/白名单内字符、但目录不存在的 node.exe 路径：:try 判不存在 -> 回落
  const sp = 'C:\\no such dir ' + process.pid + '\\node.exe';
  const rs = runFindNode(LIB, { cache: sp + '\r\n' });
  ok(isNodeExe(rs.node) && rs.node !== sp, '(c) 含空格的失效路径：回落（实际 ' + JSON.stringify(rs.node) + '）');
  // 门禁是"整份文件"判定：任何一行有白名单外的字节，整份丢弃（宁可不用缓存，也不赌哪一行）。
  // launcher 只写一行，所以这只会发生在文件被外部改动过的情况下。
  const twoLines = process.execPath + '\r\nC:\\x & echo INJECTED\r\n';
  const r2 = runFindNode(LIB, { cache: twoLines });
  ok(isNodeExe(r2.node) && !(r2.out + r2.err).includes('INJECTED'), '(c) 好行+坏行：整份丢弃、注入未执行（实际 ' + JSON.stringify(r2.node) + '）');
  // 空文件 / 只有换行 / 白名单内字符但无换行，都不能把链路卡住
  for (const [label, payload] of [['空文件', ''], ['只有 CRLF', '\r\n'], ['只有空白', '   \r\n']]) {
    const re = runFindNode(LIB, { cache: payload });
    ok(re.code === 0 && isNodeExe(re.node), '(c) ' + label + '：仍能找到 node（实际 ' + JSON.stringify(re.node) + '）');
  }
  // node-path.txt 是目录（不是文件）：提前绕开，且不要往控制台吐 for /f 的报错
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  {
    const rd = runFindNode(LIB, { keepCache: true });
    ok(rd.code === 0 && isNodeExe(rd.node), '(c) node-path.txt 是目录：回落到正常链路（实际 ' + JSON.stringify(rd.node) + '）');
    ok(!/系统找不到文件|cannot find the file/.test(rd.out + rd.err), '(c) node-path.txt 是目录：控制台没有多出报错');
  }
  // 正斜杠形态的接受性在 (a2) 里已经断言过（缓存用正斜杠写法 -> NODE 逐字等于它），此处不再重复。

  // ---------- (d) 没有缓存文件：与改动前一致 ----------
  head('(d) 没有 node-path.txt（等价于改动前的链路）');
  const dNew = runFindNode(LIB, {});
  ok(dNew.code === 0 && isNodeExe(dNew.node), '(d) 新脚本仍能找到 node（实际 ' + JSON.stringify(dNew.node) + '）');
  if (haveOld) {
    const dOld = runFindNode(OLD_LIB, {});
    ok(dOld.node === dNew.node && !!dNew.node,
      '(d) 与 backup-v13 的同一份脚本结果一致（新 ' + JSON.stringify(dNew.node) + ' / 旧 ' + JSON.stringify(dOld.node) + '）');
  } else {
    info('跳过 backup-v13 对照：文件不存在');
  }
  // 缓存被拒的路径（(c) 的注入载荷）也应与"没有缓存"一致地回落到同一个 node
  const dRejected = runFindNode(LIB, { cache: 'C:\\x & echo INJECTED\r\n' });
  ok(dRejected.node === dNew.node, '(d) 缓存被拒时与整条链路原始行为一致（' + JSON.stringify(dRejected.node) + '）');

  // ---------- (e) CODEX_NODE 优先于缓存 ----------
  head('(e) CODEX_NODE 已设置时，缓存不抢优先级');
  const e = runFindNode(LIB, { cache: process.execPath + '\r\n', codexNode: FALLBACK_NODE });
  ok(!/[\\/]nodeJs[\\/]node\.exe$/i.test(String(e.node)) || e.node === FALLBACK_NODE,
    '(e) NODE 来自 CODEX_NODE 而不是缓存（实际 ' + JSON.stringify(e.node) + '）');
  ok(e.node !== null && e.node !== process.execPath, '(e) 缓存里的 process.execPath 没有被采用');
} finally {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'));
console.log(failures === 0 ? 'all passed' : failures + ' failed');
process.exit(failures === 0 ? 0 : 1);
