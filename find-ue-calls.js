const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 找到 ue=async(t,n,r)=> 的完整定义
const targetIndex = content.indexOf('ue=async(t,n,r)=>{K6r(a,e,t');
if (targetIndex < 0) {
  console.log('Target not found');
  process.exit(1);
}

console.log('Found ue function at', targetIndex);

// 搜索调用 ue( 的地方
console.log('\n=== Searching for ue() calls ===');
const regex = /\bue\s*\([^)]{0,200}\)/g;
let match;
let count = 0;
const calls = [];
while ((match = regex.exec(content)) !== null && count < 10) {
  if (match.index > targetIndex - 50000 && match.index < targetIndex + 50000) {
    calls.push({
      index: match.index,
      call: match[0]
    });
    count++;
  }
}

calls.forEach((c, i) => {
  console.log(`\n${i + 1}. at ${c.index}: ${c.call}`);
});

// 也搜索 ue 作为回调传递的情况
console.log('\n=== ue as callback ===');
const cbRegex = /[,\(]\s*ue[,\)]/g;
let cbCount = 0;
while ((match = cbRegex.exec(content)) !== null && cbCount < 5) {
  if (match.index > targetIndex - 10000 && match.index < targetIndex + 10000) {
    const start = Math.max(0, match.index - 80);
    const end = Math.min(content.length, match.index + 80);
    console.log(content.substring(start, end).replace(/\s+/g, ' '));
    cbCount++;
  }
}
