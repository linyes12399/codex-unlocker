const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索调用 u_i 的地方
const calls = [];
const regex = /u_i\s*\([^,]+,\s*\{[^}]{0,800}serviceTier:[^,}]{0,100}/g;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 5) {
  calls.push({
    index: match.index,
    call: match[0]
  });
  count++;
}

console.log('Found', calls.length, 'calls to u_i() with serviceTier');
calls.forEach((c, i) => {
  console.log(`\n=== Call ${i + 1} at ${c.index} ===`);
  // 找到 serviceTier 部分
  const stMatch = c.call.match(/serviceTier:[^,}]+/);
  console.log('serviceTier parameter:', stMatch ? stMatch[0] : 'not found');
  console.log('Context:', c.call.substring(0, 500));
});
