const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索 threadSettings.serviceTier 的所有出现
console.log('=== threadSettings.serviceTier occurrences ===\n');
const regex = /[^a-zA-Z0-9_]threadSettings\.serviceTier[^a-zA-Z0-9_]/g;
let match;
let count = 0;
const contexts = [];
while ((match = regex.exec(content)) !== null && count < 10) {
  const start = Math.max(0, match.index - 100);
  const end = Math.min(content.length, match.index + 150);
  contexts.push(content.substring(start, end));
  count++;
}

contexts.forEach((ctx, i) => {
  console.log(`${i + 1}. ${ctx.replace(/\s+/g, ' ')}`);
  console.log('');
});

// 搜索读取 thread settings 的地方
console.log('\n=== Looking for thread settings reads ===');
const tsRegex = /\.threadSettings\s*\.\s*\w+/g;
let tsCount = 0;
const tsFound = new Set();
while ((match = tsRegex.exec(content)) !== null && tsCount < 50) {
  tsFound.add(match[0]);
  tsCount++;
}
console.log('Unique threadSettings properties:', [...tsFound].slice(0, 20).join(', '));
