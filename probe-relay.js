// 直接向中转站发送最小请求，对比不同 service_tier 下中转站的返回
'use strict';
const https = require('https');
const fs = require('fs');

const cfg = fs.readFileSync('C:/Users/86176/.codex/config.toml', 'utf8');
const token = (cfg.match(/experimental_bearer_token\s*=\s*"([^"]+)"/) || [])[1];
const model = (cfg.match(/^model\s*=\s*"([^"]+)"/m) || [])[1] || 'gpt-6-astra';
if (!token) throw new Error('token not found in config.toml');

const probe = (tier) =>
  new Promise((resolve) => {
    const payload = {
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'reply with: ok' }] }],
      reasoning: { effort: 'low' },
      stream: true,
      store: false,
    };
    if (tier !== undefined) payload.service_tier = tier;
    const body = Buffer.from(JSON.stringify(payload));
    const t0 = Date.now();
    const req = https.request(
      {
        hostname: 'vulcanapi.com',
        path: '/v1/responses',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': body.length,
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          const tiers = [...new Set([...text.matchAll(/"service_tier"\s*:\s*("([^"]*)"|null)/g)].map((m) => m[2] ?? 'null'))];
          resolve({
            sent: tier === undefined ? '<absent>' : tier,
            status: res.statusCode,
            returned: tiers.length ? tiers.join(', ') : '<not present>',
            ms: Date.now() - t0,
            err: res.statusCode >= 400 ? text.slice(0, 400) : undefined,
          });
        });
      }
    );
    req.on('error', (e) => resolve({ sent: tier, status: 'ERR', returned: e.message }));
    req.write(body);
    req.end();
  });

(async () => {
  console.log(`model=${model}`);
  for (const tier of [undefined, 'fast', 'priority', 'ultrafast', 'bogus_tier_xyz']) {
    const r = await probe(tier);
    console.log(JSON.stringify(r));
  }
})();
