const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 找到 service_tier:l 这段代码
const stIndex = content.indexOf('service_tier:l??void 0');
if (stIndex < 0) {
  console.log('Not found');
  process.exit(1);
}

// 往前找函数开头，通常是 function xxx( 或 (参数)=> 或 function(
let fnStart = stIndex;
let braceCount = 0;
for (let i = stIndex; i >= 0; i--) {
  if (content[i] === '}') braceCount++;
  if (content[i] === '{') {
    braceCount--;
    if (braceCount < 0) {
      fnStart = i;
      break;
    }
  }
}

// 往前再找一点，看函数签名
const sigStart = Math.max(0, fnStart - 500);
const sigEnd = Math.min(content.length, fnStart + 100);
console.log('=== Function signature area ===');
console.log(content.substring(sigStart, sigEnd).replace(/\n/g, ' '));

// 在函数体内找 l 的赋值
const fnBody = content.substring(fnStart, stIndex + 200);
const lAssignments = fnBody.match(/\bl\s*=[^=]/g);
console.log('\n=== Variable l assignments in function ===');
console.log('Found', lAssignments ? lAssignments.length : 0, 'assignments');

// 搜索 l= 的上下文
const lMatches = [];
const lRegex = /\bl\s*=\s*[^=][^,;}\n]{0,100}/g;
let match;
while ((match = lRegex.exec(fnBody)) !== null) {
  console.log('\n', match[0]);
}
