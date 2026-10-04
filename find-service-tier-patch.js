// 查找需要补丁的位置：s_i 函数构造请求体
const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/newstore-bundles/app-initial.js', 'latin1');

// 找到 service_tier:l??void 0
const target = 'service_tier:l??void 0';
const index = content.indexOf(target);

if (index < 0) {
  console.log('Target not found');
  process.exit(1);
}

console.log('Found at:', index);
console.log('\nContext:');
const start = Math.max(0, index - 200);
const end = Math.min(content.length, index + 200);
console.log(content.substring(start, end));

// 提取周围的字段
console.log('\n\n=== Surrounding fields ===');
const chunk = content.substring(index - 500, index + 500);
const fields = chunk.match(/\w+:[^,}]+/g);
if (fields) {
  fields.slice(-10).forEach(f => console.log(f));
}
