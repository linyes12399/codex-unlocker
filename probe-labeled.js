// 发送带标记的请求，便于在中转站后台按时间/内容逐条对照
// 用法: node probe-labeled.js <direct|proxy> <tier|none> <label>
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');

const [via, tierArg, label] = process.argv.slice(2);
const cfg = fs.readFileSync('C:/Users/86176/.codex/config.toml', 'utf8');
const token = cfg.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)[1];

const payload = { model: 'gpt-6-astra', input: `reply with: ${label}`, reasoning: { effort: 'low' }, stream: false, store: false };
if (tierArg !== 'none') payload.service_tier = tierArg;
const body = Buffer.from(JSON.stringify(payload));

const target = via === 'proxy'
  ? { lib: http, hostname: '127.0.0.1', port: 8899 }
  : { lib: https, hostname: 'vulcanapi.com', port: 443 };

const sentAt = new Date();
const req = target.lib.request(
  {
    hostname: target.hostname, port: target.port, path: '/v1/responses', method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length, 'accept-encoding': 'identity' },
  },
  (res) => {
    let t = '';
    res.on('data', (c) => (t += c));
    res.on('end', () => {
      let returned = '?';
      try { returned = JSON.parse(t).service_tier; } catch (e) { returned = t.slice(0, 200); }
      console.log(JSON.stringify({
        label, via, bodyTier: tierArg,
        sentLocal: sentAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
        status: res.statusCode, relayReturned: returned,
      }));
    });
  }
);
req.on('error', (e) => console.log(JSON.stringify({ label, error: e.message })));
req.write(body);
req.end();
