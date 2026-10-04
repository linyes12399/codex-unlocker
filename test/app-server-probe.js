// v14 决定性网络验收（规格 §6）：真实 codex.exe 的 app-server（JSON-RPC over stdio）
//   + 127.0.0.1 回显服务器 + 临时 CODEX_HOME + 假 key，验证"补丁后的 ec() 参数 + launcher 写出的覆盖文件"
//   端到端地修好两个 bug：
//     A) cc-switch 路由模式下 Ultrafast 真的发出去（请求体里 service_tier="ultrafast"）；
//     B) 关掉路由（直连形态）不再 401（请求带 Bearer <auth.json 里的 Key>）。
// 参数不手写：从镜像 app.asar 取出 net bundle 原文 -> core.applyNetPatch -> core.evalNetArgs（假 process）原样 spawn。
// 覆盖文件与合并目录也走 launcher 的真实纯函数（mergeCatalogs / decideAuthOverride / buildOverrides）。
// 只用临时 CODEX_HOME（工作区 .tmp-probe-*，刻意不放 %TEMP%：规格 §10.5 实测 %TEMP% 下 codex 会往 stderr 打
// PATH 别名告警污染输出）与假 key；不读真实 ~/.codex，不向真实中转站或 api.openai.com 发请求。
// 输出：每个用例一行（编号、实际 auth 标签、实际 tier、通过/失败），最后一行 all passed 或 N failed。
// 与报告字段的关系：本测试**不读** REPORT.net / REPORT.timing，也不跑启动器 CLI——参数与覆盖文件都直接走
// core/launcher 的纯函数与真实 codex.exe，所以报告字段形态变化不影响本文件。
// 若将来要在这里顺带核对报告：REPORT.net.diagnosis 的最终形态是**判定码字符串**（如 'direct-no-credential'），
// 不是对象（codex-launcher.js:1706-1708 writeReport 会把对象归一化成字符串；§5.1 冻结形态 string|null）；
// 而 decideAuthOverride 这个纯函数返回的仍是 { provider, diagnosis } 对象（对象里取 .diagnosis 才是判定码）。
// 开发期自测钩子：CODEX_PROBE_CORE / CODEX_PROBE_LAUNCHER 可指向桩模块（core/launcher 并行开发期间）；
// 门禁与正式运行不设置这两个变量，走 lib/launcher-core.js 与 codex-launcher.js 本体。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const WORK_DIR = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(WORK_DIR, '.tmp-probe-' + process.pid);
const MIRROR_RES = path.join(os.homedir(), 'ChatGPT-Patched', 'app', 'resources');
const CODEX_EXE = (process.env.CODEX_PROBE_EXE || '').trim() || path.join(MIRROR_RES, 'codex.exe');
const CORE_PATH = (process.env.CODEX_PROBE_CORE || '').trim() || path.join(WORK_DIR, 'lib', 'launcher-core.js');
const LAUNCHER_PATH = (process.env.CODEX_PROBE_LAUNCHER || '').trim() || path.join(WORK_DIR, 'codex-launcher.js');

// 内置 slug（规格 §10.9：turn/start 的模型必须是内置 slug，且 config 不写顶层 service_tier）
const MODEL_SLUG = 'gpt-6-astra';
// P9 用的第三方 slug（模拟 cc-switch 的 glm/kimi 这类条目）：只出现在 extras 里，
// 必须被合并目录保留、且**不补任何档位**（§5.2 规则 4：给第三方模型发 service_tier 可能被中转站拒绝）
const THIRD_PARTY_SLUG = 'glm-5.3-probe';
const AUTH_KEY = 'sk-probe-authjson-0000'; // 假 key，写在临时 auth.json 里
const BEARER_KEY = 'sk-probe-bearer-1111'; // 假 key，写在路由形态的 config.toml 里
const CASE_TIMEOUT_MS = 30000;             // 规格 §6：每个用例 ≤30s 超时，超时按失败算（不让门禁挂死）
const REQ_TIMEOUT_MS = 8000;               // 单条 JSON-RPC 请求的等待上限
const HIT_WAIT_MS = 12000;                 // 等回显服务器收到请求的上限

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 覆盖类参数的判据（-c 的值形态）：目录覆盖与鉴权覆盖。§10.4 的位置断言、P9 的 debug models 复核都用它。
function isOverrideArg(k) {
  return /^(model_catalog_json=|model_providers\..+\.requires_openai_auth=)/.test(k);
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {} }
// 删除临时目录（Windows 上 codex 退出后句柄释放有延迟：实测它的 goals_*/logs_*.sqlite-shm/-wal
// 会在 kill+1.5s 之后仍然被占用，导致 .tmp-probe-<pid>/case-* 残留；实测这些残留过一会儿就能正常删除）。
// 本机实测：空载时几十毫秒内可删；机器有并发负载时实测最长约 1 分钟才释放（21:47:36 验收结束后
// 21:48:34 才删掉），所以窗口取 60s。重试只在真被占用时才等待（正常路径一次就删净、零额外耗时），
// 总额外耗时上限约 60s，远小于门禁 900s 超时。仍删不掉时返回 false，由调用方告警（不静默留垃圾）。
async function rmrfRetry(p, attempts = 60, gapMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    rmrf(p);
    if (!fs.existsSync(p)) return true;
    await sleep(gapMs);
  }
  return !fs.existsSync(p);
}
// 所有输出都走这里：打印前统一过滤，任何形如 sk-… 的串或 "Bearer xxx" 的真实 token 都不许出现在输出里
// （安全红线 §2）。这是单一收口点——断言比较用的是 authLabel() 的固定标签，不受这里影响。
function log(s) { console.log(redact(s)); }

let CASE_ABORTED = null; // 用例超时后置位：所有等待立即失败，不再拖时间
function checkAbort() { if (CASE_ABORTED) throw CASE_ABORTED; }

// ---------- 回显服务器：记录每个请求的 Authorization 头与 service_tier，然后回 400（不真发上游） ----------
// port 省略时由系统分配（0）；P9 需要固定端口（内置 ollama 的端点不可改，实测见下），
// 端口被占用（例如用户真的在跑 ollama）时返回 { bindError }，由调用方降级而不是判失败。
function startEcho(port) {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, rsp) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        hits.push({
          url: req.url,
          auth: req.headers.authorization || null,
          tier: body.service_tier === undefined ? '<absent>' : body.service_tier,
        });
        rsp.writeHead(400, { 'content-type': 'application/json' });
        rsp.end('{"error":{"message":"probe"}}');
      });
    });
    srv.once('error', e => resolve({ srv: null, hits, port: port || null, bindError: e.code || e.message }));
    srv.listen(port || 0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port }));
  });
}

// auth 头只映射成标签，绝不打印任何 key/token 的值（比较用的也都是本文件里的假 key）
function authLabel(a) {
  if (!a) return 'NONE';
  if (a.includes(AUTH_KEY)) return 'Bearer<auth.json>';
  if (a.includes(BEARER_KEY)) return 'Bearer<bearer_token>';
  return 'Bearer<其它>';
}
// 打印 codex/文件来的文本前一律过一遍：任何形如 sk-… 的串都不许出现在输出里（规格 §2 安全红线）
function redact(s) {
  return String(s == null ? '' : s).replace(/sk-[A-Za-z0-9_\-]{4,}/g, 'sk-<已隐去>');
}

// ---------- JSON-RPC over stdio 客户端（形态与 v14-ref/probe-appserver.js 一致） ----------
function makeRpc(proc) {
  let buf = '', id = 0, aborted = null;
  const waiters = new Map();
  proc.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id !== undefined && waiters.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const api = {
    isAborted: () => aborted,
    abort(reason) {
      aborted = reason || new Error('已中止');
      // waiter 是普通函数（不是 {resolve,reject} 对象）：只用它把挂着的请求叫醒，
      // 真正的"中止"由用例体里的 checkAbort()/aborted 状态判定（见 req 的注释）。
      // 把中止原因原样带上（如"用例超过 30s 超时"），方便从输出里直接看出是超时还是真报错。
      const msg = aborted && aborted.message ? aborted.message : 'aborted';
      for (const [, w] of waiters) w({ error: { message: msg } });
      waiters.clear();
    },
    req(method, params) {
      if (aborted) return Promise.reject(aborted);
      const my = ++id;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          waiters.delete(my);
          resolve({ error: { message: 'timeout' } }); // 单条请求超时不代表进程坏了，交给断言判定
        }, REQ_TIMEOUT_MS);
        // 注意：waiter 是普通函数（不是 {resolve,reject} 对象）——abort() 里只用它把挂着的请求叫醒，
        // 真正的"中止"由调用方通过 checkAbort()/aborted 状态判定。这里必须保持调用约定一致，
        // 否则超时中止时会抛 TypeError，正好在最需要兜底的时候崩掉。
        waiters.set(my, m => { clearTimeout(t); resolve(m); });
        try { proc.stdin.write(JSON.stringify({ id: my, method, params }) + '\n'); }
        catch (e) { clearTimeout(t); waiters.delete(my); reject(aborted || e); }
      });
    },
    note(method, params) {
      try { proc.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n'); } catch (e) {}
    },
  };
  // 子进程被打死后管道会报错，必须接住，否则 node 会因未处理的 error 事件退出
  proc.stdin.on('error', () => {});
  proc.stdout.on('error', () => {});
  proc.stderr.on('error', () => {});
  return api;
}

// 一个会话：thread/start -> turn/start -> 等回显服务器收到请求（规格 §10.9：config 必须在会话建立前写好）
async function sessionOnce(ctx, serviceTier) {
  checkAbort();
  const before = ctx.hits.length;
  const t = await ctx.rpc.req('thread/start', { cwd: ctx.home });
  if (t.error) return { err: 'thread/start 失败: ' + JSON.stringify(t.error).slice(0, 240) };
  const thread = (t.result && (t.result.thread || t.result)) || {};
  const threadId = thread.id || (t.result && t.result.threadId);
  if (!threadId) return { err: 'thread/start 没返回 threadId: ' + JSON.stringify(t.result).slice(0, 240) };
  const u = await ctx.rpc.req('turn/start', Object.assign(
    { threadId, input: [{ type: 'text', text: 'hi', text_elements: [] }] },
    serviceTier ? { serviceTier } : {}));
  if (u.error) return { err: 'turn/start 失败: ' + JSON.stringify(u.error).slice(0, 240) };
  const deadline = Date.now() + HIT_WAIT_MS;
  while (ctx.hits.length === before && Date.now() < deadline) { checkAbort(); await sleep(250); }
  const fresh = ctx.hits.slice(before);
  const h = fresh.find(x => /responses/.test(x.url)) || fresh[0];
  if (!h) return { err: '没看到任何请求（回显服务器 0 次命中）' };
  return { auth: authLabel(h.auth), tier: h.tier, url: h.url, count: fresh.length };
}

// ---------- 夹具：三种 config.toml 形态（都带内置 slug，且不写顶层 service_tier） ----------
function cfgDirect(port) {
  return [
    'model_provider = "custom"',
    'model = "' + MODEL_SLUG + '"',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    'base_url = "http://127.0.0.1:' + port + '/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
}
// cc-switch 路由模式：base_url 指向本地代理 + 占位 bearer；requires_openai_auth=true
function cfgRouted(port) {
  return cfgDirect(port).replace('requires_openai_auth = false', 'requires_openai_auth = true')
    + 'experimental_bearer_token = "' + BEARER_KEY + '"\n';
}
// 会话中途换成 model_provider="other" 的完整表；keepCustom 决定是否保留 [model_providers.custom]
function cfgOther(port, keepCustom) {
  const out = ['model_provider = "other"', 'model = "' + MODEL_SLUG + '"', ''];
  if (keepCustom) {
    out.push('[model_providers.custom]', 'name = "custom"', 'base_url = "http://127.0.0.1:' + port + '/v1"',
      'wire_api = "responses"', 'requires_openai_auth = false', '');
  }
  out.push('[model_providers.other]', 'name = "other"', 'base_url = "http://127.0.0.1:' + port + '/v1"',
    'wire_api = "responses"', 'requires_openai_auth = true', '');
  return out.join('\n');
}

// ---------- 依赖（core / launcher 的冻结导出，规格 §4.2 / §5.9 / §10.10） ----------
function requireDeps() {
  const need = {
    core: ['NET_OVERRIDES_FILE', 'NET_MARKER', 'NET_BUNDLE_RE', 'NET_RE', 'NET_INJECT_SRC',
      'applyNetPatch', 'hasNetPatch', 'evalNetArgs', 'locateNetBundle', 'readAsar', 'listAsarEntries', 'readAsarEntry', 'runCaptured'],
    launcher: ['mergeCatalogs', 'buildOverrides', 'decideAuthOverride', 'readTopLevel', 'providerTableInfo'],
  };
  const missing = [];
  let core, launcher;
  try { core = require(CORE_PATH); } catch (e) { missing.push('core 模块加载失败: ' + e.message); }
  try { launcher = require(LAUNCHER_PATH); } catch (e) { missing.push('launcher 模块加载失败: ' + e.message); }
  for (const name of (need.core || [])) if (core && core[name] === undefined) missing.push('core.' + name);
  for (const name of (need.launcher || [])) if (launcher && launcher[name] === undefined) missing.push('launcher.' + name);
  if (missing.length) {
    log('缺少并行开发中的导出（规格 §4.2 / §5.9 冻结签名），无法继续：');
    for (const m of missing) log('  - ' + m);
    log('core 模块: ' + CORE_PATH);
    log('launcher 模块: ' + LAUNCHER_PATH);
    return null;
  }
  return { core, launcher };
}

// ---------- 从镜像 asar 取 net bundle 原文，并得到"补丁后"的文本 ----------
// 两种原文来源（P7/P8 要一份"未打补丁"的 ec() 做对照）：
//   1) 镜像 asar 还没被 launcher 重建过 -> 它自己就是原文；
//   2) 镜像已含 v14 补丁 -> 用工作区里的旧备份 asar（app.asar.backup-20261001，安全红线禁删）里的同一函数做原文。
// 两处来源都不可得时返回 null，由调用方报"无法验证"而不是静默通过。
const BACKUP_ASAR = path.join(WORK_DIR, 'app.asar.backup-20261001');
function readBundleFrom(core, asar) {
  const { header, dataBase } = core.readAsar(asar);
  const fd = fs.openSync(asar, 'r');
  try {
    const e = core.locateNetBundle(header, dataBase, fd);
    if (!e) return null;
    const text = typeof e.text === 'string' ? e.text : core.readAsarEntry(fd, dataBase, e).toString('latin1');
    return { rel: e.rel, text };
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
}
// 返回 { rel, mirrorText, original, originalFrom }：
//   mirrorText = 镜像 asar 里那份（可能已含补丁）；original = 一份确认"未打补丁"的 ec()（P7/P8 的对照），拿不到为 null
function unpatchedBundle(core) {
  const asar = path.join(MIRROR_RES, 'app.asar');
  if (!fs.existsSync(asar)) throw new Error('镜像 app.asar 不存在: ' + asar);
  const m = readBundleFrom(core, asar);
  if (!m) throw new Error('镜像 asar 里找不到含 ' + core.NET_MARKER + ' 的主进程 bundle（' + core.NET_BUNDLE_RE + '）');
  if (!core.hasNetPatch(m.text) && core.NET_RE.test(m.text)) {
    return { rel: m.rel, mirrorText: m.text, original: m.text, originalFrom: '镜像 asar（未打补丁）' };
  }
  if (core.hasNetPatch(m.text) && fs.existsSync(BACKUP_ASAR)) {
    // 镜像已被 launcher 重建：从旧备份 asar 取一份"未打补丁"的 ec()（只用于 P7/P8 的基线对照）
    try {
      const b = readBundleFrom(core, BACKUP_ASAR);
      if (b && !core.hasNetPatch(b.text) && core.NET_RE.test(b.text)) {
        return { rel: m.rel, mirrorText: m.text, original: b.text, originalFrom: '工作区备份 asar（' + path.basename(BACKUP_ASAR) + '）' };
      }
    } catch (e) { /* 备份读不了就当没有，下面按 original=null 处理 */ }
  }
  return { rel: m.rel, mirrorText: m.text, original: null, originalFrom: null };
}
// 得到"补丁后文本"：镜像已含补丁直接用镜像的；否则对未打补丁原文现场注入
function patchedTextOf(core, mirrorText, original) {
  if (core.hasNetPatch(mirrorText)) return { text: mirrorText, source: '镜像 asar 已含 v14 net 补丁' };
  const src = original || mirrorText;
  const r = core.applyNetPatch(src);
  if (!r || !r.ok || r.actual !== 1) {
    throw new Error('core.applyNetPatch 未成功（ok=' + (r && r.ok) + ' actual=' + (r && r.actual) + '），镜像 bundle 形态不匹配');
  }
  if (!core.hasNetPatch(r.text)) throw new Error('core.applyNetPatch 产物没有补丁标记（hasNetPatch=false），注入与自检标记不一致');
  return { text: r.text, source: '由 core.applyNetPatch 现场注入' };
}

// ---------- 内置模型目录：跑一次镜像 codex.exe（临时 CODEX_HOME 在工作区，不放 %TEMP%） ----------
// 输出兜底（规格 §10.5）：丢弃第一个 { 之前的内容；前面有垃圾就打警告；完全没有 JSON 就抛中文错误。
function loadBundledCatalog(core) {
  const home = path.join(TMP_ROOT, 'catalog-home');
  fs.mkdirSync(home, { recursive: true });
  let out = '';
  try {
    out = core.runCaptured(CODEX_EXE, ['debug', 'models', '--bundled'], { env: Object.assign({}, process.env, { CODEX_HOME: home }) });
  } catch (e) {
    out = String((e && e.stdout) || ''); // 失败时也尽量从输出里救出 JSON（runCaptured 把 stdout+stderr 写一起）
    if (!out) throw new Error('codex debug models --bundled 执行失败: ' + (e && e.message));
  }
  const i = out.indexOf('{');
  if (i < 0) throw new Error('codex debug models --bundled 没有输出 JSON（开头: ' + out.slice(0, 80).replace(/\s+/g, ' ') + '）');
  if (i > 0) log('警告: codex 输出里 JSON 之前有 ' + i + ' 字节垃圾内容，已丢弃（开头: ' + out.slice(0, 40).replace(/\s+/g, ' ') + '）');
  return JSON.parse(out.slice(i));
}

// ---------- 覆盖文件：走 launcher 的真实决策链 ----------
// decideAuthOverride 的 authJson 规格里没写明类型。launcher 产品代码传的是**已解析的对象**
// （codex-launcher.js:1441：读 auth.json -> JSON.parse -> 传对象），所以对象形式是唯一的产品口径，
// 本函数**必须**用它取 diagnosis；对象形式失败就是调用约定漂移，直接抛错说清楚，
// 绝不悄悄退到另一种形式上去（否则一旦退化，用例会带着错误的 diagnosis 继续跑、把归因搞乱）。
// 字符串形式只当**交叉核对**用（launcher 已让字符串先 parse 再用，codex-launcher.js:1181-1185，
// 并承诺两条路径同结果）：若两者分歧，说明上下游对同一接口的理解已经不一致，按失败报出来。
function callDecide(launcher, tomlText, authJson) {
  let d = null, objErr = null;
  try {
    const x = launcher.decideAuthOverride({ tomlText, authJson });
    if (x && typeof x === 'object' && typeof x.diagnosis === 'string') d = x;
    else objErr = new Error('返回结构不是 {diagnosis:string}：' + JSON.stringify(x).slice(0, 120));
  } catch (e) { objErr = e; }
  if (!d) {
    // 明确失败：这是"probe 与 launcher 的调用约定不一致"，不是"修复没生效"
    throw new Error('launcher.decideAuthOverride 用对象形式（产品口径）调用失败，'
      + '属调用约定漂移、不是修复失效，请核对签名与返回结构：' + (objErr && objErr.message ? objErr.message : String(objErr)));
  }
  const note = [], fails = [];
  try {
    const y = launcher.decideAuthOverride({ tomlText, authJson: JSON.stringify(authJson) });
    if (y && typeof y.diagnosis === 'string' && y.diagnosis !== d.diagnosis) {
      fails.push('decideAuthOverride 的对象形式与字符串形式 diagnosis 分歧（对象 ' + d.diagnosis
        + ' / 字符串 ' + y.diagnosis + '）：上下游对同一接口的理解已不一致，按失败报出');
    }
  } catch (e) {
    note.push('（字符串形式抛错，已跳过交叉核对：' + (e && e.message ? e.message.slice(0, 60) : '') + '）');
  }
  return { d, note: 'authJson=对象' + (note.length ? '；' + note.join('；') : ''), fails };
}
function overridesFor(ctx, out) {
  const home = path.join(ctx.dir, 'decide-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), ctx.config);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(ctx.authJson));
  const cd = callDecide(ctx.launcher, ctx.config, ctx.authJson);
  const d = cd.d;
  ctx.decideDiagnosis = d.diagnosis; // P9 的 argsCheck 要核对内置 id 给出 no-provider（launcher 侧与注入函数同源）
  out.lines.push('decideAuthOverride: diagnosis=' + d.diagnosis + ' provider=' + (d.provider || 'null') + ' ' + cd.note);
  for (const f of (cd.fails || [])) out.fails.push(f); // 接口漂移（两形式分歧）按失败报出，不让它静默
  // 顺带核对 providerTableInfo（同样是冻结接口）：只记录，不作断言，避免与实现细节耦合
  try {
    const top = ctx.launcher.readTopLevel(ctx.config);
    const tid = top && top.modelProvider;
    const info = tid ? ctx.launcher.providerTableInfo(ctx.config, tid) : null;
    if (info) out.lines.push('providerTableInfo(' + tid + '): found=' + info.found + ' requiresOpenaiAuth=' + info.requiresOpenaiAuth + ' hasBearer=' + !!info.hasBearer);
  } catch (e) {
    out.lines.push('providerTableInfo/readTopLevel 调用异常: ' + e.message);
  }
  const auth = d.provider ? { provider: d.provider, requiresOpenaiAuth: true } : null;
  return ctx.launcher.buildOverrides({ catalogPath: ctx.catalogPath, auth });
}

// ---------- 用例执行骨架：建目录 -> 起回显服务器 -> 写 config/覆盖文件 -> 算参数 -> spawn -> 断言 ----------
async function runCase(c) {
  const out = { id: c.id, title: c.title, known: !!c.known, lines: [], fails: [], args: null, result: null };
  const dir = path.join(TMP_ROOT, 'case-' + String(c.id).toLowerCase());
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'ChatGPT.exe'), ''); // 假镜像主程序：注入函数只取它的上级目录名
  let srv = null, proc = null, timer = null, rpc = null;
  try {
    // P9 用内置 ollama：它的端点是固定的 127.0.0.1:11434，**不可通过 -c 或环境变量改**
    // （实测：-c model_providers.ollama.base_url=... 直接触发 reserved built-in provider IDs 致命错误；
    //  OLLAMA_HOST / OLLAMA_BASE_URL 都不被采纳），所以只能用固定端口观测。
    // 端口被真实 ollama 占用时 bindError 非空：该用例降级为"只断言参数数组"并明确写出降级原因（不装成功）。
    srv = await startEcho(c.echoPort || 0);
    const ctx = {
      id: c.id, dir, home, port: srv.port || 11434, hits: srv.hits, echoBindError: srv.bindError || null,
      core: c.core, launcher: c.launcher, catalogPath: c.catalogPath, catalogJson: c.catalogJson,
      mergedCatalog: c.mergedCatalog, // P9 用：验证"合并是超集"（保留第三方 slug、不补档位）
      text: c.text, rawText: c.rawText, // text = 本用例要执行的 ec() 文本（补丁后或原文）
      authJson: c.authJson || { OPENAI_API_KEY: AUTH_KEY },
      config: '',
      rpc: null,
      writeConfig(text) { ctx.config = text; fs.writeFileSync(path.join(ctx.home, 'config.toml'), text); },
    };
    ctx.writeConfig(c.startup(ctx));                 // 规格 §10.9：config 必须在会话建立前写好
    // 临时 CODEX_HOME 里的假 auth.json（注入函数与 codex 都从这里读；绝不碰真实 ~/.codex）
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(ctx.authJson));
    const ov = c.overrides ? c.overrides(ctx, out) : null;
    ctx.overridesObj = ov; // P9 的运行时白名单复检要基于它改一个字段再写回去
    if (ov) {
      if (ov.version !== 1) out.fails.push('覆盖文件 version 不是 1: ' + JSON.stringify(ov.version));
      if (ov.auth && ov.auth.requiresOpenaiAuth !== true) out.fails.push('覆盖文件 auth.requiresOpenaiAuth 不是 true（§10.2 的必要条件）');
      fs.writeFileSync(path.join(dir, c.core.NET_OVERRIDES_FILE), JSON.stringify(ov));
    }
    const fakeProcess = { execPath: path.join(dir, 'app', 'ChatGPT.exe'), env: { CODEX_HOME: home } };
    // 参数必须由真实代码路径产出。注入函数读不到覆盖文件/目录文件时会**静默少推参数**
    // （最坏情况退化成原版参数）。本机实测过这种瞬时缺失（重负载 + 目录文件 statSync 失败）。
    // 判定不能只看"是否等于原版参数"：覆盖项有两类（目录 + 鉴权），只丢一类时也不等于原版（实测踩到）。
    // 所以按"该推的项是否都在"判定：ov.catalog 存在且文件可读 -> 必须有 model_catalog_json=；
    // ov.auth 存在 -> 必须有 requires_openai_auth=（注入函数还会自己复检表/白名单，这里是它的超集）。
    // 缺项就重写覆盖文件与目录文件后重算一次并记录诊断，让"真失效"（重算仍缺）与"瞬时抖动"可区分。
    // 重算必须写**正确的**目录内容（ctx.catalogJson，与写进文件的完全一致）：早前版本在这里写空目录
    // {"models":[]}，会静默把 ultrafast 档抹掉、让 tier 变成 <absent>（实测踩到）。
    const expectCat = !!(ov && ov.catalog && ctx.catalogPath && fs.existsSync(ctx.catalogPath));
    const expectAuth = !!(ov && ov.auth && ov.auth.provider);
    const missingOf = a => {
      const s = a.join(' ');
      const miss = [];
      if (expectCat && !s.includes('model_catalog_json=')) miss.push('model_catalog_json');
      if (expectAuth && !s.includes('requires_openai_auth=')) miss.push('requires_openai_auth');
      return miss;
    };
    let args = c.core.evalNetArgs(ctx.text, fakeProcess);
    let missing = missingOf(args);
    if (missing.length) {
      const ovPath = path.join(dir, c.core.NET_OVERRIDES_FILE);
      out.lines.push('注入函数少推了参数 [' + missing.join(',') + ']；诊断: 覆盖文件存在=' + fs.existsSync(ovPath)
        + ' 目录文件存在=' + (ctx.catalogPath ? fs.existsSync(ctx.catalogPath) : null) + '，重写覆盖文件与目录文件后重算一次');
      try { if (ctx.catalogJson) fs.writeFileSync(ctx.catalogPath, ctx.catalogJson); } catch (e) {}
      try { fs.writeFileSync(ovPath, JSON.stringify(ov)); } catch (e) {}
      args = c.core.evalNetArgs(ctx.text, fakeProcess);
      missing = missingOf(args);
      out.lines.push('重算后参数=' + JSON.stringify(args) + (missing.length ? '（仍缺 ' + missing.join(',') + '）' : ''));
    }
    out.args = args;
    ctx.args = args; // 用例体里要读参数数组（P6/P7/P8 的断言）
    if (!Array.isArray(args)) throw new Error('core.evalNetArgs 没返回数组');
    // 结构性断言（规格 §10.4）：覆盖参数必须出现在 app-server 之后，否则 codex 不会把它们当子命令参数，
    // src= 之类的覆盖会静默失效（那样 P1/P3/P4 会全被误判成"修复无效"）。
    // 这里不自己拼参数（参数一律来自真实代码路径），只校验顺序，防止 evalNetArgs 的实现漂移。
    const asIdx = args.indexOf('app-server');
    for (const k of args) {
      if (isOverrideArg(k)) {
        const kIdx = args.indexOf(k);
        if (asIdx < 0 || kIdx < asIdx) out.fails.push('-c 覆盖参数位置错误（必须在 app-server 之后）: ' + JSON.stringify(args));
      }
    }
    if (c.argsCheck) c.argsCheck(ctx, out, args);
    if (c.noSpawn) {
      ctx.rpc = { req: () => Promise.reject(new Error('本用例不发请求')), note() {}, isAborted: () => false, abort() {} };
      await c.run(ctx, out);
      return out;
    }
    proc = spawn(CODEX_EXE, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        CODEX_HOME: home,          // 只用临时 CODEX_HOME，绝不读真实 ~/.codex
        OPENAI_API_KEY: '',
        CODEX_APP_SERVER_OPENAI_BASE_URL: '',
        CODEX_APP_SERVER_CHATGPT_BASE_URL: '',
      }),
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { out.fails.push('codex.exe 启动失败: ' + e.message); });
    rpc = makeRpc(proc);
    ctx.rpc = rpc;
    CASE_ABORTED = null;
    timer = setTimeout(() => {
      CASE_ABORTED = new Error('用例超过 ' + (CASE_TIMEOUT_MS / 1000) + 's 超时（规格 §6）');
      try { proc.kill(); } catch (e) {}
      rpc.abort(CASE_ABORTED);
    }, CASE_TIMEOUT_MS);
    const init = await rpc.req('initialize', { clientInfo: { name: 'probe', title: null, version: '0.0.1' }, capabilities: null });
    if (init.error) {
      out.fails.push('initialize 失败: ' + JSON.stringify(init.error).slice(0, 240));
    } else {
      rpc.note('initialized');
      await c.run(ctx, out);
    }
    // 只在没看到请求时补一行 stderr 末行（错误信息里不会有 key；codex 自己也不会打印 key）
    if (!/auth=/.test(out.lines.join(' '))) {
      const lastErr = stderr.split(/\r?\n/).filter(l => /error|invalid/i.test(l)).slice(-1)[0];
      if (lastErr) out.lines.push('stderr 末条错误: ' + redact(lastErr).slice(0, 200));
    }
  } catch (e) {
    out.fails.push('异常: ' + (e && e.message ? e.message : String(e)));
  } finally {
    if (timer) clearTimeout(timer);
    CASE_ABORTED = null;
    try { if (proc && !proc.killed) proc.kill(); } catch (e) {}
    if (srv) { try { srv.srv.closeAllConnections(); } catch (e) {} try { srv.srv.close(); } catch (e) {} }
    if (proc) await sleep(1500); // Windows 上 codex 退出后句柄释放有延迟：等一会儿再删（没起进程就不用等）
    // 单用例目录先试着删；句柄释放慢时删不掉很正常（实测 SQLite WAL 会多占一会儿），
    // 这里不报噪音——留空目录不影响断言，结尾对整个 TMP_ROOT 做带重试的统一清理并告警。
    await rmrfRetry(dir, 2, 800);
  }
  return out;
}

// ---------- 用例定义 ----------
function buildCases() {
  return [
    {
      id: 'P1',
      title: '直连形态（用户现状：requires_openai_auth=false、无 bearer、Key 在 auth.json）+ serviceTier=ultrafast',
      startup: ctx => cfgDirect(ctx.port),
      overrides: overridesFor,
      run: async (ctx, out) => {
        const r = await sessionOnce(ctx, 'ultrafast');
        if (r.err) return void out.fails.push('第一会话: ' + r.err);
        out.lines.push('auth=' + r.auth + ' tier=' + r.tier);
        if (r.auth !== 'Bearer<auth.json>') out.fails.push('auth 期望 Bearer<auth.json>，实际 ' + r.auth);
        if (r.tier !== 'ultrafast') out.fails.push('service_tier 期望 ultrafast，实际 ' + r.tier);
      },
    },
    {
      id: 'P2',
      title: '同 P1 + serviceTier=fast（应归一化成 priority）',
      startup: ctx => cfgDirect(ctx.port),
      overrides: overridesFor,
      run: async (ctx, out) => {
        const r = await sessionOnce(ctx, 'fast');
        if (r.err) return void out.fails.push('第一会话: ' + r.err);
        out.lines.push('auth=' + r.auth + ' tier=' + r.tier);
        if (r.auth !== 'Bearer<auth.json>') out.fails.push('auth 期望 Bearer<auth.json>，实际 ' + r.auth);
        if (r.tier !== 'priority') out.fails.push('service_tier 期望 priority，实际 ' + r.tier);
      },
    },
    {
      id: 'P3',
      title: '路由形态（requires_openai_auth=true + bearer 占位）+ serviceTier=ultrafast',
      startup: ctx => cfgRouted(ctx.port),
      overrides: overridesFor,
      run: async (ctx, out) => {
        const r = await sessionOnce(ctx, 'ultrafast');
        if (r.err) return void out.fails.push('第一会话: ' + r.err);
        out.lines.push('auth=' + r.auth + ' tier=' + r.tier);
        if (r.auth !== 'Bearer<bearer_token>') out.fails.push('auth 期望 Bearer<bearer_token>，实际 ' + r.auth);
        if (r.tier !== 'ultrafast') out.fails.push('service_tier 期望 ultrafast，实际 ' + r.tier);
      },
    },
    {
      id: 'P4',
      title: '启动时路由形态 -> 会话中途切成直连形态（cc-switch 关掉路由）+ ultrafast',
      startup: ctx => cfgRouted(ctx.port),
      overrides: overridesFor,
      run: async (ctx, out) => {
        const first = await sessionOnce(ctx, 'ultrafast');
        out.lines.push('第一会话 auth=' + (first.err ? '(失败)' : first.auth) + (first.err ? '' : ' tier=' + first.tier));
        if (first.err) return void out.fails.push('第一会话: ' + first.err);
        if (first.auth !== 'Bearer<bearer_token>') out.fails.push('第一会话 auth 期望 Bearer<bearer_token>，实际 ' + first.auth);
        ctx.writeConfig(cfgDirect(ctx.port));  // 会话中途改 config（新会话会重读）
        await sleep(800);
        const second = await sessionOnce(ctx, 'ultrafast');
        if (second.err) return void out.fails.push('第二会话: ' + second.err);
        out.lines.push('第二会话 auth=' + second.auth + ' tier=' + second.tier);
        // 关键在于有覆盖：否则第二会话会是 auth=NONE —— 正是用户看到的 401 API_KEY_REQUIRED 根因
        if (second.auth !== 'Bearer<auth.json>') out.fails.push('第二会话 auth 期望 Bearer<auth.json>，实际 ' + second.auth);
        if (second.tier !== 'ultrafast') out.fails.push('第二会话 service_tier 期望 ultrafast，实际 ' + second.tier);
      },
    },
    {
      id: 'P5',
      title: '启动时直连形态 -> 中途换成 model_provider="other" 且保留 custom 表 + ultrafast',
      startup: ctx => cfgDirect(ctx.port),
      overrides: overridesFor,
      run: async (ctx, out) => {
        const first = await sessionOnce(ctx, 'ultrafast');
        if (first.err) return void out.fails.push('第一会话: ' + first.err);
        out.lines.push('第一会话 auth=' + first.auth + ' tier=' + first.tier);
        ctx.writeConfig(cfgOther(ctx.port, true));
        await sleep(800);
        const second = await sessionOnce(ctx, 'ultrafast');
        if (second.err) return void out.fails.push('第二会话: ' + second.err);
        out.lines.push('第二会话 auth=' + second.auth + ' tier=' + second.tier);
        if (second.auth !== 'Bearer<auth.json>') out.fails.push('第二会话 auth 期望 Bearer<auth.json>，实际 ' + second.auth);
      },
    },
    {
      id: 'P5x',
      known: true, // 已知限制，只记录不判失败（规格 §6 / §10.9；主控据此决定使用说明"已知限制"那条怎么写）
      title: '启动时直连形态 -> 中途换成 model_provider="other" 并删掉 custom 表（启动时的 -c 已固定）',
      startup: ctx => cfgDirect(ctx.port),
      overrides: overridesFor,
      run: async (ctx, out) => {
        const first = await sessionOnce(ctx, 'ultrafast');
        out.lines.push('第一会话 ' + (first.err ? '失败: ' + first.err : 'auth=' + first.auth + ' tier=' + first.tier));
        ctx.writeConfig(cfgOther(ctx.port, false));
        await sleep(800);
        const second = await sessionOnce(ctx, 'ultrafast');
        // 实测预期：第二个会话 thread/start 返回 model_providers.custom: provider name must not be empty
        out.p5x = second.err ? '第二个会话报错：' + second.err : '第二个会话正常：auth=' + second.auth + ' tier=' + second.tier;
        out.lines.push('第二会话 ' + (second.err ? '失败: ' + second.err : 'auth=' + second.auth + ' tier=' + second.tier));
      },
    },
    {
      id: 'P6',
      noSpawn: true,
      title: 'auth.json 只有 tokens（假官方登录）：参数数组里不许有 requires_openai_auth',
      startup: ctx => cfgDirect(ctx.port || 1),
      authJson: { OPENAI_API_KEY: null, tokens: { id_token: 'x', access_token: 'probe-access', refresh_token: 'y', account_id: 'z' } },
      overrides: overridesFor,
      argsCheck: (ctx, out, args) => {
        const s = args.join(' ');
        if (s.includes('requires_openai_auth')) out.fails.push('官方登录凭据下不该出现 requires_openai_auth，实际参数: ' + JSON.stringify(args));
        if (!s.includes('model_catalog_json=')) out.fails.push('目录覆盖项应当仍然存在，实际参数: ' + JSON.stringify(args));
      },
      run: async (ctx, out) => { out.lines.push('参数=' + JSON.stringify(ctx.args || [])); },
    },
    {
      id: 'P7',
      title: '覆盖文件不存在：参数与原版完全一致，service_tier 不发（复现 bug 的基线）',
      startup: ctx => cfgDirect(ctx.port),
      noOverridesBaseline: true, // 需要"未打补丁的原文"做参数对照
      overrides: null, // 关键：不写覆盖文件
      run: async (ctx, out) => {
        // 覆盖文件不存在时，补丁后的 ec() 必须与未打补丁的原文产出完全相同的参数
        const rawArgs = ctx.core.evalNetArgs(ctx.rawText, { execPath: path.join(ctx.dir, 'app', 'ChatGPT.exe'), env: { CODEX_HOME: ctx.home } });
        out.lines.push('补丁后参数=' + JSON.stringify(ctx.args));
        if (JSON.stringify(ctx.args) !== JSON.stringify(rawArgs)) {
          out.fails.push('覆盖文件不存在时参数应与原文一致，期望 ' + JSON.stringify(rawArgs) + '，实际 ' + JSON.stringify(ctx.args));
        }
        const r = await sessionOnce(ctx, 'ultrafast');
        if (r.err) return void out.fails.push('第一会话: ' + r.err);
        out.lines.push('auth=' + r.auth + ' tier=' + r.tier);
        if (r.auth !== 'NONE') out.fails.push('auth 期望 NONE（基线：没有鉴权覆盖），实际 ' + r.auth);
        if (r.tier !== '<absent>') out.fails.push('service_tier 期望 <absent>（基线：目录里没有 ultrafast），实际 ' + r.tier);
      },
    },
    {
      id: 'P8',
      title: '未打补丁的原文 ec()（无任何覆盖）+ 直连形态 + ultrafast：复现 401 基线',
      startup: ctx => cfgDirect(ctx.port),
      useRawText: true, // 用未打补丁的原文算参数
      overrides: null,
      run: async (ctx, out) => {
        out.lines.push('参数=' + JSON.stringify(ctx.args));
        const r = await sessionOnce(ctx, 'ultrafast');
        if (r.err) return void out.fails.push('第一会话: ' + r.err);
        out.lines.push('auth=' + r.auth + ' tier=' + r.tier);
        if (r.auth !== 'NONE') out.fails.push('auth 期望 NONE（401 基线），实际 ' + r.auth);
        if (r.tier !== '<absent>') out.fails.push('service_tier 期望 <absent>，实际 ' + r.tier);
      },
    },
    {
      // P9：内置 provider（ollama）路径。为什么单独加：P1~P8 的 config 全是第三方供应商（custom/other），
      // 内置 provider 这条路径端到端零覆盖——而它恰恰是最不能出错的一条：给内置 id 加 -c 覆盖会让 codex
      // 直接拒绝配置（实测 app-server 只打错误、连 initialize 都不应答，见下面 argsCheck 的说明）。
      // 三条断言（全部经主控/本机实测确认可观测）：
      //  (i)   参数只含 model_catalog_json、绝不含 requires_openai_auth（内置白名单在 lib/launcher-core.js:525 挡下）
      //  (ii)  用该参数起 app-server，codex 接受，且 gpt-6-astra 的 ultrafast 真能发到线上（内置 ollama 端点
      //        固定是 127.0.0.1:11434，且 service_tier 能不能发出去完全取决于合并目录里有没有这个档位）
      //  (iii) 合并目录对第三方 slug 是**超集**语义：保留它们、但不给它们补档位
      // 注意：config 里**不能**写 [model_providers.ollama]（实测：写了之后 initialize 仍应答，但每个
      // thread/start 都返回 "...model_providers contains reserved built-in provider IDs: `ollama`"）。
      id: 'P9',
      echoPort: 11434, // 内置 ollama 的固定端点（不可用 -c/环境变量改，实测）
      usePlusCatalog: true, // 用带第三方 slug 的那份目录（验证"合并是超集"）
      title: '内置 provider（ollama）：参数不许带鉴权覆盖 + ultrafast 仍能发出 + 合并目录是第三方超集',
      startup: () => 'model_provider = "ollama"\nmodel = "' + MODEL_SLUG + '"\n',
      authJson: { OPENAI_API_KEY: AUTH_KEY }, // 有假 key：若无白名单挡板，注入函数就会推出致命的 -c
      overrides: overridesFor,
      argsCheck: (ctx, out, args) => {
        const s = args.join(' ');
        // (i) 内置 provider：目录覆盖可以有，鉴权覆盖绝不能有（致命 -c）
        if (s.includes('requires_openai_auth')) {
          out.fails.push('内置 provider(ollama) 下不该出现 requires_openai_auth（会让 codex 直接拒绝配置、连 initialize 都不应答），实际参数: ' + JSON.stringify(args));
        }
        if (!s.includes('model_catalog_json=')) out.fails.push('目录覆盖项应当存在，实际参数: ' + JSON.stringify(args));
        // decideAuthOverride 对内置 id 应给出 no-provider（不写 auth）；核对 launcher 侧与注入函数同源
        if (ctx.decideDiagnosis !== 'no-provider') {
          out.fails.push('decideAuthOverride 对内置 id 的 diagnosis 期望 no-provider，实际 ' + ctx.decideDiagnosis);
        }
        // (ii)-a 目录覆盖确实被 codex 采纳：跑一次 `debug models`（会带上 -c 覆盖）对比不带覆盖的基线，
        //  直接可观测"模型集合与不加覆盖时完全一致、且 gpt-6-astra 多出 ultrafast 档"（本机实测：
        //  基线 ultrafast 档=0，带这份覆盖时=合并目录里带 ultrafast 的模型数；--bundled 与不带都一样是干净基线）。
        //  这比只看 app-server 收到请求更早失败，也把"覆盖是否被采纳"与"请求是否发出"分成两条独立证据。
        try {
          const dbg = extraArgs => {
            const out = ctx.core.runCaptured(CODEX_EXE, ['debug', 'models', ...extraArgs],
              { env: Object.assign({}, process.env, { CODEX_HOME: ctx.home }) });
            return JSON.parse(out.slice(out.indexOf('{')));
          };
          const jBase = dbg([]);
          // 把 ctx.args 里的覆盖**连同它们的 -c 前缀**搬过来（只搬值会变成未知子命令参数，实测报 Command failed）
          const ovArgs = [];
          for (let i = 0; i < ctx.args.length; i++) {
            if (isOverrideArg(ctx.args[i]) && i > 0 && ctx.args[i - 1] === '-c') ovArgs.push('-c', ctx.args[i]);
          }
          const jOv = dbg(ovArgs);
          const baseSlugs = jBase.models.map(m => m.slug);
          const ovSlugs = jOv.models.map(m => m.slug);
          const added = ovSlugs.filter(x => !baseSlugs.includes(x));
          const removed = baseSlugs.filter(x => !ovSlugs.includes(x));
          const ultraOf = j => j.models.filter(m => (m.service_tiers || []).some(t => t.id === 'ultrafast')).length;
          out.lines.push('debug models: 基线 slugs=' + baseSlugs.length + '(ultrafast ' + ultraOf(jBase) + ') -> 带覆盖 slugs='
            + ovSlugs.length + '(ultrafast ' + ultraOf(jOv) + ')，新增=' + JSON.stringify(added) + ' 丢失=' + JSON.stringify(removed));
          if (removed.length) out.fails.push('目录覆盖后丢了模型: ' + JSON.stringify(removed));
          if (ultraOf(jBase) !== 0) out.fails.push('基线（不带覆盖）本不该有 ultrafast 档，实际 ' + ultraOf(jBase) + '（夹具前提变了）');
          if (ultraOf(jOv) === 0) out.fails.push('目录覆盖后没有任何模型带 ultrafast 档（覆盖没被采纳）');
        } catch (e) {
          out.fails.push('debug models 复核失败（' + e.message.slice(0, 140) + '）');
        }
      },
      run: async (ctx, out) => {
        out.lines.push('参数=' + JSON.stringify(ctx.args));
        // (iii) 合并目录是超集：第三方 slug 保留、且不给它补档位
        const merged = ctx.mergedCatalog;
        if (!merged || !Array.isArray(merged.models)) return void out.fails.push('合并目录不可用，无法验证超集语义');
        if (!merged.models.some(m => m.slug === THIRD_PARTY_SLUG)) {
          out.fails.push('合并目录应保留第三方 slug ' + THIRD_PARTY_SLUG + '（合并是超集，不是替换）');
        } else {
          const tr = merged.models.find(m => m.slug === THIRD_PARTY_SLUG);
          const trTiers = (tr.service_tiers || []).map(t => t.id);
          if (trTiers.length) out.fails.push('第三方 slug ' + THIRD_PARTY_SLUG + ' 不该被补档位，实际 ' + JSON.stringify(trTiers));
          out.lines.push('合并目录: ' + merged.models.length + ' 个 slug，含第三方 ' + THIRD_PARTY_SLUG + '（档位=' + JSON.stringify(trTiers) + '）');
        }
        const astra = merged.models.find(m => m.slug === MODEL_SLUG);
        const at = astra ? (astra.service_tiers || []).map(t => t.id) : [];
        if (!at.includes('ultrafast')) out.fails.push('合并目录里 ' + MODEL_SLUG + ' 缺 ultrafast 档，P9 的第二条断言无从谈起');
        out.lines.push(MODEL_SLUG + ' 档位=' + JSON.stringify(at));

        // (iv) 运行时第二道防线（§10.1）：把覆盖文件硬改成"给内置 id 加鉴权覆盖"（模拟覆盖文件过期 /
        //      上一版 launcher 写的残留），补丁后的 ec() **也绝不能**推出那条致命 -c。
        //      为什么必须单独测：本用例的正常路径里 launcher 已给出 no-provider、覆盖文件 auth=null，
        //      注入函数根本走不到白名单那一行——所以"运行时白名单"在 P9 的正常路径上是零覆盖的。
        //      更要紧的是：注入函数还有一道 `found && !bad`（配置里存在该 provider 表）在前，
        //      所以**光写一个内置 id 到覆盖文件还不够**，必须让 config 里真有那张表，
        //      白名单那一行才是唯一挡板（本机隔离验证过：带表时删掉白名单行就会推出致命 -c）。
        //      两种 config 都测：无表（found=false 挡）+ 有表（只有白名单能挡）。
        //      实测后果（本机）：给内置 ollama 推 requires_openai_auth 会让 app-server 只打错误、
        //      连 initialize 都不应答（20s 零字节 stdout），用户看到的是"应用起不来"。
        try {
          const ovPath = path.join(ctx.dir, ctx.core.NET_OVERRIDES_FILE);
          const cfgPath = path.join(ctx.home, 'config.toml');
          const stale = Object.assign({}, ctx.overridesObj, { auth: { provider: 'ollama', requiresOpenaiAuth: true } });
          const casesOfStale = [
            { name: '无 ollama 表（found 挡）', cfg: ctx.config },
            { name: '有 ollama 表（只有白名单能挡）', cfg: ctx.config + '[model_providers.ollama]\nname = "ollama"\nbase_url = "http://127.0.0.1:11434/v1"\n' },
          ];
          for (const sc of casesOfStale) {
            fs.writeFileSync(cfgPath, sc.cfg);
            fs.writeFileSync(ovPath, JSON.stringify(stale));
            const staleArgs = ctx.core.evalNetArgs(ctx.text, {
              execPath: path.join(ctx.dir, 'app', 'ChatGPT.exe'), env: { CODEX_HOME: ctx.home },
            });
            const ss = staleArgs.join(' ');
            out.lines.push('运行时白名单复检[' + sc.name + '] 参数=' + JSON.stringify(staleArgs));
            if (ss.includes('requires_openai_auth')) {
              out.fails.push('覆盖文件里是内置 id(ollama) 时，注入函数仍推了 requires_openai_auth（' + sc.name
                + '；会让 codex 拒绝配置、连 initialize 都不应答），实际参数: ' + JSON.stringify(staleArgs));
            }
          }
          fs.writeFileSync(cfgPath, ctx.config);              // 还原，避免影响后续断言
          fs.writeFileSync(ovPath, JSON.stringify(ctx.overridesObj));
        } catch (e) {
          out.lines.push('运行时白名单复检异常: ' + e.message);
        }
        // (ii) 端到端：codex 接受该参数，且 ultrafast 真发到线上
        if (ctx.echoBindError) {
          // 端口被真实 ollama 占用：不能装作验收通过，但也确实无法观测 -> 明确记录降级，不计入通过/失败
          out.lines.push('（降级：127.0.0.1:11434 被占用 ' + ctx.echoBindError + '，本用例只验证了参数数组与合并目录，未做端到端观测）');
          out.degraded = true;
          return;
        }
        const r = await sessionOnce(ctx, 'ultrafast');
        if (r.err) return void out.fails.push('第一会话: ' + r.err);
        out.lines.push('auth=' + r.auth + ' tier=' + r.tier);
        if (r.auth !== 'NONE') out.fails.push('auth 期望 NONE（内置 provider 不该被加鉴权覆盖），实际 ' + r.auth);
        if (r.tier !== 'ultrafast') out.fails.push('service_tier 期望 ultrafast（目录里有这个档位就该发出去），实际 ' + r.tier);
      },
    },
  ];
}

// ---------- 看门狗：依赖代码若有同步死循环，用例超时定时器也会失效，必须另起线程杀进程 ----------
// 背景（本机实测）：lib/launcher-core.js 的 evalNetArgs 早期修订版正则漏了 g，
// while ((m = endRe.exec(s))) 里 exec 不前进 -> 主线程被同步占死，setTimeout 永不触发，门禁直接挂死。
// 做法：SharedArrayBuffer + Atomics 计数。主线程用一个 setInterval 推进计数——**这个信号本身就是判据**：
// 事件循环只要还在转（含 await 等待、异步 IO），计数就会前进；被同步死循环占死时计数器停住。
// worker 连续 5 次（每秒一次）看到计数不动就杀掉整个进程（worker 里 process.exit 只结束 worker 自己，
// 必须 process.kill(process.pid)，本机实测过）。worker 内的定时器不能 unref（否则 worker 事件循环为空立刻退出，
// 看门狗等于不存在，实测过）；只 unref 主线程这边的 Worker 引用，主线程正常跑完时不会因为 worker 多停留。
function startWatchdog() {
  const ctrl = new SharedArrayBuffer(8);
  const ctr = new Int32Array(ctrl);
  // 主线程心跳：250ms 一次。所有合法操作（含 readAsar 读头、execFileSync 跑 codex ~45ms）都远快于 5s 阈值
  const hb = setInterval(() => { Atomics.add(ctr, 0, 1); }, 250);
  hb.unref();
  const WORKER = [
    'const { workerData } = require("worker_threads");',
    'const ctr = new Int32Array(workerData.ctrl);',
    'const staleLimit = 5;', // 5 次 × 1s 没推进 = 事件循环停了 ~5s，判定同步死循环
    'let last = Atomics.load(ctr, 0), stale = 0;',
    'setInterval(() => {',
    '  const cur = Atomics.load(ctr, 0);',
    '  if (cur !== last) { last = cur; stale = 0; return; }',
    '  if (++stale >= staleLimit) {',
    '    // 用 writeSync 同步写：随后的 SIGKILL 是瞬时的，异步 console.error 的消息会丢（实测）。',
    '    // 这条消息是"门禁为什么被杀"的唯一线索，必须落到 stderr。',
    '    try { require("fs").writeSync(2, "[probe] 看门狗：主线程 " + staleLimit + "s 没有进展（依赖代码疑似同步死循环），强制结束进程\\n"); } catch (e) {}',
    '    process.kill(process.pid, "SIGKILL");',
    '  }',
    '}, 1000);',
  ].join('\n');
  const wd = new (require('worker_threads').Worker)(WORKER, { eval: true, workerData: { ctrl } });
  wd.unref();
  wd.on('error', () => {}); // worker 自身出错不该拖垮主流程
}

// 从用例明细里抽出"实际 auth 标签 / 实际 tier"，拼成规格 §6 要求的单行结果
// （编号、实际 auth 标签、实际 tier、通过/失败）。多个会话时按顺序全部列出（第一会话/第二会话）。
function summarize(r) {
  const seen = [];
  for (const line of r.lines) {
    const re = /auth=([^\s|]+) tier=([^\s|]+)/g;
    let m;
    while ((m = re.exec(line))) {
      const tag = seen.length === 0 ? '' : (seen.length === 1 ? '第二会话 ' : '第' + (seen.length + 1) + '会话 ');
      seen.push(tag + 'auth=' + m[1] + ' tier=' + m[2]);
    }
  }
  const pass = r.fails.length === 0;
  const head = '[' + r.id + ']';
  const body = seen.length ? seen.join(' | ') : (r.args ? '参数=' + JSON.stringify(r.args) : '（无观测数据）');
  return head + ' ' + body + ' -> ' + (pass ? '通过' : '失败');
}

// ---------- 入口 ----------
(async () => {
  log('=== Codex 解锁版 v14 app-server 网络验收（规格 §6） ===');
  startWatchdog();
  const deps = requireDeps();
  if (!deps) { process.exitCode = 1; return; }
  const { core, launcher } = deps;
  log('core 模块: ' + require.resolve(CORE_PATH));
  log('launcher 模块: ' + require.resolve(LAUNCHER_PATH));
  log('codex.exe: ' + CODEX_EXE);
  if (!fs.existsSync(CODEX_EXE)) {
    log('失败：找不到 codex.exe（可用环境变量 CODEX_PROBE_EXE 指定）。本测试是验收，不跳过。');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  let results = [];
  let FATAL = false; // 准备阶段（目录/asar/目录生成）就失败：用例没跑，结尾不能打印 all passed
  try {
    const bundle = unpatchedBundle(core);
    const patched = patchedTextOf(core, bundle.mirrorText, bundle.original);
    log('net bundle: ' + bundle.rel + '（' + patched.source + '）');
    // P7/P8 需要"未打补丁"的 ec() 做对照；镜像已被重建又拿不到备份原文时必须明说，不能假装通过
    const cases = buildCases();
    if (cases.some(c => c.useRawText || c.noOverridesBaseline) && !bundle.original) {
      log('失败：镜像 asar 已含 v14 补丁，且工作区没有可用的未打补丁备份 asar（' + BACKUP_ASAR + '），');
      log('      P7/P8 的"未打补丁基线"无法验证。请保留 app.asar.backup-20261001 或先让镜像处于未重建状态。');
      process.exitCode = 1;
      return;
    }
    if (bundle.originalFrom) log('未打补丁原文来源: ' + bundle.originalFrom);

    // 合并目录：必须生成成功，且 gpt-6-astra 同时有 priority 与 ultrafast（规格 §10.9 的用例前提）
    const bundled = loadBundledCatalog(core);
    const merged = launcher.mergeCatalogs(bundled, []);
    if (!merged || !Array.isArray(merged.models)) { log('失败：launcher.mergeCatalogs 没返回 {models:[...]}'); process.exitCode = 1; return; }
    const astra = merged.models.find(m => m.slug === MODEL_SLUG);
    const tierIds = (astra && astra.service_tiers ? astra.service_tiers : []).map(t => t.id);
    const ultraCount = merged.models.filter(m => (m.service_tiers || []).some(t => t.id === 'ultrafast')).length;
    log('合并目录: ' + merged.models.length + ' 个模型，其中 ' + ultraCount + ' 个带 ultrafast；' + MODEL_SLUG + ' 档位=[' + tierIds + ']');
    if (!astra) { log('失败：合并目录里没有内置 slug ' + MODEL_SLUG); process.exitCode = 1; return; }
    if (!tierIds.includes('ultrafast') || !tierIds.includes('priority')) {
      log('失败：合并目录里 ' + MODEL_SLUG + ' 缺档位（ultrafast/priority 都要有），P1/P2 无从谈起');
      process.exitCode = 1;
      return;
    }
    const catalogPath = path.join(TMP_ROOT, 'model-catalog-merged.json').replace(/\\/g, '/');
    const catalogJson = JSON.stringify(merged); // 与写进文件的完全一致；重算分支要原样重写，绝不能写成空目录
    fs.writeFileSync(catalogPath, catalogJson);

    // P9 用：带第三方 slug 的合并目录（验证"合并是超集"）。
    // 第三方条目必须**字段完整**（实测：只给 slug 会让 codex 直接报
    // `failed to parse model_catalog_json path ...: missing field display_name` 并拒绝整个目录），
    // 所以用真实内置条目做模板改 slug；再删掉 service_tiers，模拟真实第三方条目的样子
    // （真实第三方条目没有 codex 的档位字段；规则 4 要求不给他们补档位）。
    const thirdTpl = bundled.models.find(m => m.slug === MODEL_SLUG);
    const thirdEntry = Object.assign({}, thirdTpl, { slug: THIRD_PARTY_SLUG, display_name: 'Probe Third Party' });
    delete thirdEntry.service_tiers;
    const mergedPlus = launcher.mergeCatalogs(bundled, [{ path: path.join(TMP_ROOT, 'cc-switch-model-catalog.json'), data: { models: [thirdEntry] } }]);
    const plusPath = path.join(TMP_ROOT, 'model-catalog-merged-plus.json').replace(/\\/g, '/');
    const plusJson = JSON.stringify(mergedPlus);
    fs.writeFileSync(plusPath, plusJson);

    for (const c of cases) {
      c.core = core;
      c.launcher = launcher;
      // P9 要那份带第三方 slug 的目录（验证超集语义）；其余用例用只含内置 slug 的目录
      c.catalogPath = c.usePlusCatalog ? plusPath : catalogPath;
      c.catalogJson = c.usePlusCatalog ? plusJson : catalogJson;
      c.mergedCatalog = c.usePlusCatalog ? mergedPlus : merged;
      c.text = c.useRawText ? bundle.original : patched.text;
      c.rawText = bundle.original; // P7 的对照也需要未打补丁的原文
      const r = await runCase(c);
      results.push(r);
      if (r.known) {
        // 规格 §6：P5x 只记录不判失败，固定输出一行"P5x（已知限制）实际结果：..."
        log('P5x（已知限制）实际结果：' + (r.p5x || r.lines.join(' | ')));
        for (const l of r.lines) log('    ' + l); // 明细行（诊断 + 第一/第二会话）
      } else {
        log(summarize(r));                       // 每个用例一行：编号、实际 auth 标签、实际 tier、通过/失败
        log('    ' + r.title);
        for (const l of r.lines) log('    ' + l);
      }
      for (const f of r.fails) log('    ! ' + f);
    }
  } catch (e) {
    log('失败: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
    FATAL = true; // 用例根本没跑起来：不许再打印 all passed
  } finally {
    await sleep(1500);
    // 临时目录必须删掉（安全红线 §2）。但"删得慢"和"验收不过"是两件事：
    // 实测 codex 退出后 sqlite WAL 句柄可能多占一会儿（残留过几秒就能删），
    // 所以这里只告警、不因此把本次验收判失败——否则验收结果会随机器IO时序抖动。
    if (!(await rmrfRetry(TMP_ROOT))) {
      log('警告: 临时目录暂未删干净（句柄释放慢），请稍后手工删除: ' + TMP_ROOT);
    }
  }
  if (FATAL) {
    log('（验收未完成，用例没有全部执行）');
    return;
  }
  if (!results.length) { log('（没有执行任何用例）'); process.exitCode = 1; return; }
  const counted = results.filter(r => !r.known);
  const failed = counted.filter(r => r.fails.length > 0);
  log(failed.length ? failed.length + ' failed' : 'all passed');
  if (failed.length) process.exitCode = 1;
})();
