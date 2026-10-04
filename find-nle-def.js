const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 搜索 nle 的定义
// 可能形式: function nle(... 或 nle=function 或 nle=(...
const patterns = [
  /function\s+nle\s*\([^)]*\)\s*{[^}]{0,300}}/,
  /\bnle\s*=\s*function\s*\([^)]*\)\s*{[^}]{0,300}}/,
  /\bnle\s*=\s*\([^)]*\)\s*=>\s*[^;]{0,200}/,
  /\bnle\s*=\s*\w+\s*=>\s*[^;]{0,200}/,
];

console.log('=== Searching for nle definition ===\n');
for (const pattern of patterns) {
  const match = content.match(pattern);
  if (match) {
    console.log('Found with pattern:', pattern.source);
    console.log(match[0]);
    console.log('\n');
  }
}

// 也搜索 nle 作为导入的情况
const importMatch = content.match(/nle[^a-zA-Z0-9_][^;]{0,100}/);
if (importMatch) {
  console.log('nle usage context:', importMatch[0]);
}

// 搜索 nle 在 import 语句中
const imports = content.match(/import\s*\{[^}]*nle[^}]*\}\s*from/g);
if (imports) {
  console.log('\n=== nle imports ===');
  imports.forEach(imp => console.log(imp));
}
