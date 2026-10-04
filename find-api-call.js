const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索 fetch 或 request 调用，特别是发送到 /responses 的
const patterns = [
  /fetch\([^)]{0,100}responses/gi,
  /\.post\([^)]{0,100}responses/gi,
  /request\([^)]{0,100}responses/gi,
];

console.log('=== Searching for API call sites ===\n');

for (const pattern of patterns) {
  const matches = content.match(pattern);
  if (matches) {
    console.log(`Pattern: ${pattern.source}`);
    matches.slice(0, 3).forEach(m => console.log('  ', m));
    console.log();
  }
}

// 搜索 headers 附近的 service_tier
console.log('=== Searching near headers for service_tier context ===');
let index = 0;
let count = 0;
while ((index = content.indexOf('service_tier:', index)) !== -1 && count < 3) {
  const start = Math.max(0, index - 500);
  const end = Math.min(content.length, index + 500);
  const chunk = content.substring(start, end);
  
  // 查看是否有 headers 关键字
  if (chunk.includes('headers') || chunk.includes('Headers')) {
    console.log(`\nFound at ${index}:`);
    console.log(chunk.substring(0, 800).replace(/\s+/g, ' '));
  }
  
  index += 10;
  count++;
}
