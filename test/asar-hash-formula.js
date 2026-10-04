// 交叉验证 asar 完整性哈希的"口径"：
// Windows 版的启动器会把新 asar 的 header 哈希写进 ChatGPT.exe 的内嵌 JSON。
// 拿实机上这份已写好的值，去和同一个 asar 的 4 种候选口径比对，就能确定 Electron 用的是哪一种。
// 这个口径 macOS 的 Info.plist ElectronAsarIntegrity 用的是同一套定义，因此可以据此确认 mac 版逻辑。
//   node test/asar-hash-formula.js [chatgpt.exe] [app.asar]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../lib/launcher-core.js');

const MIRROR = path.join(os.homedir(), 'ChatGPT-Patched', 'app');
const exePath = process.argv[2] || path.join(MIRROR, 'ChatGPT.exe');
const asarPath = process.argv[3] || path.join(MIRROR, 'resources', 'app.asar');

for (const p of [exePath, asarPath]) {
  if (!fs.existsSync(p)) {
    console.log('跳过：找不到 ' + p);
    console.log('（需要一台已经用 Windows 版启动器构建过镜像的机器，或手动传入 exe 与 asar 路径）');
    process.exit(0);
  }
}

// 1) 从 exe 里取出内嵌的 asar 校验值（和启动器 patchExeHash 用的是同一个锚点）
const buf = fs.readFileSync(exePath);
const needle = Buffer.from('[{"file":"resources\\\\app.asar","alg":"SHA256","value":"', 'latin1');
const pos = buf.indexOf(needle);
console.log('exe:', exePath, `(${buf.length} 字节)`);
if (pos < 0) { console.error('exe 里没有内嵌 asar 校验段（NO_PAYLOAD）'); process.exit(1); }
const hexStart = pos + needle.length;
const embedded = buf.subarray(hexStart, hexStart + 64).toString('latin1');
console.log('  exe 内嵌的值 :', embedded);

// 2) 对同一个 asar 算 4 种候选口径
const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const whole = Buffer.alloc(8 + headerSize);
fs.readSync(fd, whole, 0, whole.length, 0);
fs.closeSync(fd);

const cands = [
  { name: 'json', buf: whole.subarray(16, 16 + jsonLen) },
  { name: 'payload(8..)', buf: whole.subarray(8) },
  { name: 'pickle(4..)', buf: whole.subarray(4) },
  { name: 'whole(0..)', buf: whole },
];
console.log('asar:', asarPath, `(${fs.statSync(asarPath).size} 字节, headerSize=${headerSize}, jsonLen=${jsonLen})`);

let hit = null;
for (const c of cands) {
  const h = core.sha256Hex(c.buf);
  const ok = h === embedded;
  if (ok) hit = c.name;
  console.log(`  ${ok ? '==>' : '   '} ${c.name.padEnd(14)} ${h}`);
}
console.log('\n结论: ' + (hit ? `Electron 用的是「${hit}」口径` : '四种口径都对不上（需要重新判断）'));
process.exit(hit ? 0 : 1);
