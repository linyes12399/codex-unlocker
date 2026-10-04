const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索调用 s_i 的地方
const calls = [];
const regex = /s_i\s*\(\s*\{[^}]{0,500}\}/g;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 10) {
  calls.push({
    index: match.index,
    call: match[0]
  });
  count++;
}

console.log('Found', calls.length, 'calls to s_i()');
calls.forEach((c, i) => {
  console.log(`\n=== Call ${i + 1} at ${c.index} ===`);
  console.log(c.call.substring(0, 400));
});
