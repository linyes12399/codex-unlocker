const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/proxy-intercept.log', 'utf8');

// 找到最后一个 POST /v1/responses
const lastPostIndex = content.lastIndexOf('POST /v1/responses');
if (lastPostIndex < 0) {
  console.log('No POST request found');
  process.exit(1);
}

// 提取这个请求的 Body JSON 部分
const bodyJsonStart = content.indexOf('Body JSON:', lastPostIndex);
if (bodyJsonStart < 0) {
  console.log('No Body JSON found');
  process.exit(1);
}

// 找到下一个分隔符
const nextSep = content.indexOf('================', bodyJsonStart + 100);
const bodyJsonEnd = nextSep > 0 ? nextSep : content.length;

const bodySection = content.substring(bodyJsonStart, bodyJsonEnd);

// 解析 JSON
const jsonStart = bodySection.indexOf('{');
const jsonStr = bodySection.substring(jsonStart);

try {
  const json = JSON.parse(jsonStr);
  
  console.log('=== Request Body Structure ===');
  console.log('Top-level keys:', Object.keys(json).join(', '));
  
  if (json.service_tier !== undefined) {
    console.log('\n✓ service_tier found:', json.service_tier);
  } else {
    console.log('\n✗ service_tier NOT FOUND in request body');
  }
  
  console.log('\nFull body (first 2000 chars):');
  console.log(JSON.stringify(json, null, 2).substring(0, 2000));
} catch (e) {
  console.log('Failed to parse JSON:', e.message);
  console.log('Raw:', jsonStr.substring(0, 500));
}
