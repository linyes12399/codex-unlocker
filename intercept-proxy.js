// 本地代理：拦截 Codex -> 中转站的请求，注入 service_tier，并记录中转站回传的 service_tier
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PROXY_PORT = 8899;
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'vulcanapi.com';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 443);
const UPSTREAM_TLS = (process.env.UPSTREAM_TLS || '1') === '1';
const INJECT_TIER = process.env.INJECT_TIER || 'ultrafast';
const LOG_FILE = path.join(__dirname, 'proxy-intercept.log');

fs.writeFileSync(LOG_FILE, `=== 代理拦截日志 ${new Date().toISOString()} upstream=${UPSTREAM_HOST} ===\n`);

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(line.trim());
};

// 从响应（JSON 或 SSE）里提取所有 service_tier 值
const extractTiers = (text) => {
  const tiers = new Set();
  const re = /"service_tier"\s*:\s*("([^"]*)"|null)/g;
  let m;
  while ((m = re.exec(text))) tiers.add(m[2] ?? 'null');
  return [...tiers];
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const id = Math.random().toString(36).slice(2, 8);
    log(`[${id}] ${req.method} ${req.url} (${body.length} bytes)`);

    if (body.length > 0 && req.method === 'POST' && req.url.includes('/responses')) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        let trigger = '?';
        try {
          trigger = JSON.parse(json.client_metadata?.['x-codex-turn-metadata'] || '{}').turn_trigger || '?';
        } catch (e) {}
        log(`[${id}] model=${json.model} effort=${json.reasoning?.effort} trigger=${trigger} stream=${json.stream}`);
        log(`[${id}] ORIGINAL service_tier from Codex: ${json.service_tier === undefined ? '<absent>' : JSON.stringify(json.service_tier)}`);
        if (INJECT_TIER !== 'off') {
          json.service_tier = INJECT_TIER;
          body = Buffer.from(JSON.stringify(json), 'utf8');
        }
        log(`[${id}] SENT service_tier to relay: ${json.service_tier === undefined ? '<absent>' : JSON.stringify(json.service_tier)}`);
      } catch (e) {
        log(`[${id}] body is not JSON, forwarded unchanged`);
      }
    }

    const headers = { ...req.headers, host: UPSTREAM_HOST, 'accept-encoding': 'identity' };
    if (body.length > 0) headers['content-length'] = String(body.length);
    delete headers['transfer-encoding'];

    const upstream = (UPSTREAM_TLS ? https : http).request(
      { hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
      (upRes) => {
        log(`[${id}] relay response: ${upRes.statusCode}`);
        res.writeHead(upRes.statusCode, upRes.headers);
        let captured = '';
        upRes.on('data', (c) => {
          if (captured.length < 2_000_000) captured += c.toString('utf8');
          res.write(c);
        });
        upRes.on('end', () => {
          res.end();
          const tiers = extractTiers(captured);
          log(`[${id}] RELAY RETURNED service_tier: ${tiers.length ? tiers.join(', ') : '<not present in response>'}`);
          if (upRes.statusCode >= 400) log(`[${id}] error body: ${captured.slice(0, 1000)}`);
        });
      }
    );
    upstream.on('error', (err) => {
      log(`[${id}] upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end('Proxy error');
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  log(`proxy on http://127.0.0.1:${PROXY_PORT} -> ${UPSTREAM_TLS ? 'https' : 'http'}://${UPSTREAM_HOST}:${UPSTREAM_PORT}, inject service_tier=${INJECT_TIER}`);
});
