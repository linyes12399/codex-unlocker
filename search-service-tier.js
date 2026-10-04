const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索 service_tier 相关代码
const matches = [];
const regex = /service_tier:\w+/g;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 10) {
  const start = Math.max(0, match.index - 200);
  const end = Math.min(content.length, match.index + match[0].length + 200);
  matches.push({
    index: match.index,
    match: match[0],
    context: content.substring(start, end)
  });
  count++;
}

console.log('Found', matches.length, 'occurrences of service_tier');
matches.forEach((m, i) => {
  console.log(`\n=== Match ${i + 1} at ${m.index} ===`);
  console.log(m.context.replace(/\n/g, ' '));
});
