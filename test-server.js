// 测试服务器：回显收到的请求
const http = require('http');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 15888;
const LOG_FILE = path.join(__dirname, 'test-server.log');

fs.writeFileSync(LOG_FILE, `=== 测试服务器日志 ${new Date().toISOString()} ===\n\n`);

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(line.trim());
};

const server = http.createServer((req, res) => {
  const chunks = [];
  
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    
    log(`\n${'='.repeat(80)}`);
    log(`收到请求: ${req.method} ${req.url}`);
    log(`Headers:\n${JSON.stringify(req.headers, null, 2)}`);
    
    if (body.length > 0) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        log(`Body JSON:\n${JSON.stringify(json, null, 2)}`);
        
        // 检查关键字段
        if (json.service_tier) {
          log(`\n✓✓✓ SUCCESS: service_tier = "${json.service_tier}" ✓✓✓`);
        } else {
          log(`\n✗✗✗ FAILED: service_tier NOT FOUND ✗✗✗`);
        }
      } catch (e) {
        log(`Body (raw): ${body.toString('utf8').substring(0, 500)}`);
      }
    }
    
    // 返回成功响应（模拟 API）
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      received: {
        method: req.method,
        url: req.url,
        hasServiceTier: body.length > 0 ? JSON.parse(body.toString('utf8')).service_tier !== undefined : false
      }
    }));
  });
});

server.listen(TEST_PORT, '127.0.0.1', () => {
  log(`测试服务器启动在 http://127.0.0.1:${TEST_PORT}`);
  log(`日志文件: ${LOG_FILE}`);
  log(`\n配置方法：`);
  log(`1. 确保代理运行在 http://127.0.0.1:8899`);
  log(`2. 代理会转发到这个测试服务器`);
  log(`3. 检查日志确认 service_tier 字段`);
});
