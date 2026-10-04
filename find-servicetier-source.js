const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索读取配置中 serviceTier 的地方，常见模式：
// - e.serviceTier
// - getServiceTier
// - serviceTier: xxx()
// - serviceTier = ...

console.log('=== Searching for serviceTier reads/gets ===\n');

// 1. 搜索 getServiceTier 之类的函数
const getMatches = content.match(/\w+ServiceTier\w*/g);
if (getMatches) {
  const unique = [...new Set(getMatches)].slice(0, 20);
  console.log('ServiceTier-related identifiers:', unique.join(', '));
}

// 2. 搜索 serviceTier: 后面跟函数调用的模式
console.log('\n=== serviceTier assignments/calls ===');
const regex = /serviceTier:\s*\w+\([^)]{0,100}\)/g;
let match;
let count = 0;
const found = new Set();
while ((match = regex.exec(content)) !== null && count < 20) {
  if (!found.has(match[0])) {
    found.add(match[0]);
    console.log(match[0]);
  }
  count++;
}

// 3. 搜索可能是从 state/config 读取的地方
console.log('\n=== Looking for state/config reads ===');
const stateRegex = /\.\s*serviceTier\b/g;
let stateCount = 0;
while ((match = stateRegex.exec(content)) !== null && stateCount < 10) {
  const start = Math.max(0, match.index - 50);
  const end = Math.min(content.length, match.index + 50);
  console.log(content.substring(start, end).replace(/\s+/g, ' '));
  stateCount++;
}
