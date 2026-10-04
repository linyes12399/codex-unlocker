const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 找到 r?.threadSettings.serviceTier 这个位置
const targetIndex = content.indexOf('serviceTier:r?.threadSettings.serviceTier');
if (targetIndex < 0) {
  console.log('Target not found');
  process.exit(1);
}

// 往前找函数定义
let fnStart = targetIndex;
let braceCount = 0;
for (let i = targetIndex; i >= 0; i--) {
  if (content[i] === '}') braceCount++;
  if (content[i] === '{') {
    braceCount--;
    if (braceCount < 0) {
      fnStart = i;
      break;
    }
  }
}

// 往前找函数签名
const sigStart = Math.max(0, fnStart - 1000);
const sigEnd = fnStart + 50;
console.log('=== Function signature ===');
const sig = content.substring(sigStart, sigEnd);
console.log(sig.substring(sig.lastIndexOf('function'), sig.length).replace(/\n/g, ' ').substring(0, 500));

// 在函数体内找 r 的定义
const fnBody = content.substring(fnStart, targetIndex + 200);
console.log('\n=== Looking for r assignment ===');
const rMatches = fnBody.match(/\br\s*=[^=][^;]{0,100}/g);
if (rMatches) {
  rMatches.slice(0, 5).forEach(m => console.log(m));
}

// 或者 r 可能是参数
const paramMatch = sig.match(/\([^)]{0,200}\br[^a-zA-Z0-9_][^)]{0,50}\)/);
if (paramMatch) {
  console.log('\n=== r as parameter ===');
  console.log(paramMatch[0]);
}
