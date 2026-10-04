'use strict';
const https = require('https');
const fs = require('fs');
const cfg = fs.readFileSync('C:/Users/86176/.codex/config.toml', 'utf8');
const token = cfg.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)[1];
const tier = process.argv[2];
const stream = process.argv[3] !== 'nostream';
const payload = { model: 'gpt-6-astra', input: 'reply with: ok', reasoning: { effort: 'low' }, stream, store: false, service_tier: tier };
const body = Buffer.from(JSON.stringify(payload));
const req = https.request({ hostname: 'vulcanapi.com', path: '/v1/responses', method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length, 'accept-encoding': 'identity' } }, (res) => {
  console.log('status', res.statusCode);
  for (const [k, v] of Object.entries(res.headers)) if (/tier|model|request-id|x-/i.test(k)) console.log('hdr', k, '=', v);
  let t = ''; res.on('data', c => t += c); res.on('end', () => {
    if (!stream) { const j = JSON.parse(t); console.log('service_tier =', j.service_tier, '| model =', j.model); return; }
    for (const block of t.split('\n\n')) {
      const ev = (block.match(/^event: (.*)$/m) || [])[1];
      const m = block.match(/"service_tier"\s*:\s*("([^"]*)"|null)/);
      if (m) console.log(ev, '-> service_tier =', m[1], '| model =', (block.match(/"model"\s*:\s*"([^"]*)"/) || [])[1]);
    }
  });
});
req.write(body); req.end();
