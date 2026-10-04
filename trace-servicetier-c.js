const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/patched-bundles/app-initial-3916b423772b.js', 'latin1');

// 找到 Call 2: serviceTier:C
const call2Index = content.indexOf('s_i({action:`next`,consumerLockdownModeDisabled:D,conversationId:x,conversationOrigin:l,isDoNotRemember:f,isTemporaryChat:p,model:_,requestedDefaultModel:l===`tpp`?void 0:fEn(e,u,_),parentMessageId:v,serviceTier:C');

if (call2Index < 0) {
  console.log('Call 2 not found');
  process.exit(1);
}

// 往前找函数开头
let fnStart = call2Index;
let braceCount = 0;
for (let i = call2Index; i >= 0; i--) {
  if (content[i] === '}') braceCount++;
  if (content[i] === '{') {
    braceCount--;
    if (braceCount < 0) {
      fnStart = i;
      break;
    }
  }
}

const fnBody = content.substring(fnStart, call2Index + 500);

// 搜索 C= 的赋值
console.log('=== Searching for C assignments ===');
const cRegex = /\bC\s*=\s*[^=][^,;}\n]{0,150}/g;
let match;
let found = 0;
while ((match = cRegex.exec(fnBody)) !== null && found < 5) {
  console.log('\n', match[0]);
  found++;
}

// 也看看函数参数
const sigStart = Math.max(0, fnStart - 800);
const sigEnd = fnStart + 100;
console.log('\n\n=== Function signature ===');
console.log(content.substring(sigStart, sigEnd).replace(/\n/g, ' ').substring(0, 600));
