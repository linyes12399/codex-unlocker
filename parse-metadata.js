const fs = require('fs');
const content = fs.readFileSync('F:/test/AI项目/codex修复/proxy-intercept.log', 'utf8');

// 提取 x-codex-turn-metadata
const match = content.match(/"x-codex-turn-metadata":"(\{[^"]+\})"/);
if (!match) {
  console.log('No turn metadata found');
  process.exit(0);
}

const jsonStr = match[1].replace(/\\"/g, '"');
const metadata = JSON.parse(jsonStr);

console.log('=== Turn Metadata Fields ===');
Object.keys(metadata).forEach(key => {
  console.log(`${key}: ${metadata[key]}`);
});

console.log('\n=== Searching for tier/speed ===');
if (metadata.service_tier) {
  console.log('✓ service_tier found:', metadata.service_tier);
} else {
  console.log('✗ service_tier NOT FOUND');
}

if (metadata.speed) {
  console.log('✓ speed found:', metadata.speed);
} else {
  console.log('✗ speed NOT FOUND');
}
