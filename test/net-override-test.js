// 网络修复单元测试（规格 §5.10）：decideAuthOverride / providerTableInfo / 主进程注入函数的一致性 /
// mergeCatalogs / buildOverrides。全部是纯函数 + 临时目录，不跑 PowerShell、不读真实 ~/.codex、不碰镜像。
//   node test/net-override-test.js
// 关键断言：launcher 侧（decideAuthOverride）与主进程注入函数（core.NET_INJECT_SRC / evalNetArgs）必须同源——
// launcher 说"可以加鉴权覆盖"的夹具，注入函数必须真的加；launcher 说"不可以"的夹具（含伪造的覆盖文件），
// 注入函数必须挡住。两边漂移会让用户要么继续 401、要么 codex 直接加载不了配置。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp-net-override-' + process.pid);

// ---------- 沙箱环境（必须在 require 启动器之前设置：启动器在 require 时读环境变量） ----------
const envBackup = {};
const setEnv = (k, v) => { envBackup[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
setEnv('USERPROFILE', TMP);
setEnv('HOME', TMP);
setEnv('LOCALAPPDATA', path.join(TMP, 'AppData', 'Local'));
setEnv('APPDATA', path.join(TMP, 'AppData', 'Roaming'));
setEnv('TEMP', path.join(TMP, 'temp'));
setEnv('TMP', path.join(TMP, 'temp'));
setEnv('CODEX_HOME', path.join(TMP, 'codex-home'));
setEnv('CODEX_ELECTRON_RESOURCES_PATH', '');
setEnv('CODEX_LAUNCHER_NO_STORE', '1');
setEnv('CODEX_LAUNCHER_NO_EXTERNAL', '1');
setEnv('CODEX_LAUNCHER_SHORTCUT_DIR', path.join(TMP, 'shortcuts'));
setEnv('CODEX_APP_DIR', undefined);

const core = require('../lib/launcher-core.js');
const L = require('../codex-launcher.js');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK   ' : '  FAIL ') + msg); if (!cond) failures++; };
const head = t => console.log('\n== ' + t + ' ==');

// ---------- 夹具 ----------
// 用户现状：cc-switch 直连形态（requires_openai_auth = false、没有 bearer、key 在 auth.json）
const TOML_DIRECT = [
  'model_provider = "custom"',
  'model = "gpt-6-astra"',
  '',
  '[model_providers.custom]',
  'name = "秋API"',
  'base_url = "https://vulcanapi.com/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = false',
  '',
].join('\n');
// 路由形态：cc-switch 把 base_url 指到本地代理并塞一个占位 bearer
const TOML_ROUTED = [
  'model_provider = "custom"',
  '',
  '[model_providers.custom]',
  'name = "秋API copy"',
  'base_url = "http://127.0.0.1:15721/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'experimental_bearer_token = "sk-probe-routed-placeholder"',
  '',
].join('\n');
const TOML_ALREADY = TOML_DIRECT.replace('requires_openai_auth = false', 'requires_openai_auth = true');
const AUTH_OK = { OPENAI_API_KEY: 'sk-probe-0000' };
const AUTH_TOKENS = { tokens: { access_token: 'sk-probe-token-value', account_id: 'acc' } };
const AUTH_EMPTY = {};
const AUTH_NO_KEY = { OPENAI_API_KEY: '   ' };

// ---------- readTopLevel ----------
head('readTopLevel');
{
  const t = L.readTopLevel(TOML_DIRECT);
  ok(t.modelProvider === 'custom' && t.model === 'gpt-6-astra' && t.modelCatalogJson === null,
    '顶层三个键（modelProvider/model/modelCatalogJson=null）');
  const withCat = 'model_catalog_json = "C:/x/c.json"\n[model_providers.custom]\nname="x"\n';
  const t2 = L.readTopLevel(withCat);
  ok(t2.modelCatalogJson === 'C:/x/c.json', 'model_catalog_json 双引号值');
  // 单引号是 TOML 字面量字符串：反斜杠不是转义符，原样取出
  const t3 = L.readTopLevel("model_catalog_json = 'C:\\x\\c.json'\n");
  ok(t3.modelCatalogJson === 'C:\\x\\c.json', '单引号字面量字符串（不处理转义）');
  const t4 = L.readTopLevel('[model_providers.custom]\nmodel_provider = "late"\n');
  ok(t4.modelProvider === null, '表头之后的同名键不算顶层');
  const t5 = L.readTopLevel('model_provider = "custom" # 注释\n');
  ok(t5.modelProvider === 'custom', '行尾注释被砍掉');
  const t6 = L.readTopLevel('\uFEFFmodel_provider = "custom"\n');
  ok(t6.modelProvider === 'custom', 'BOM 被容忍');
  const t7 = L.readTopLevel('model_provider = "custom"\r\nmodel = "x"\r\n[model_providers.custom]\r\nname="n"\r\n');
  ok(t7.modelProvider === 'custom' && t7.model === 'x', 'CRLF 换行');
}

// ---------- providerTableInfo ----------
head('providerTableInfo');
{
  const i = L.providerTableInfo(TOML_DIRECT, 'custom');
  ok(i.found && i.requiresOpenaiAuth === false && !i.hasBearer && !i.hasEnvKey && !i.hasOtherAuth && i.baseUrlHost === 'vulcanapi.com',
    '直连形态：found、requires_openai_auth=false、主机 vulcanapi.com（' + i.baseUrlHost + '）');
  const r = L.providerTableInfo(TOML_ROUTED, 'custom');
  ok(r.found && r.hasBearer && r.baseUrlHost === '127.0.0.1:15721', '路由形态：hasBearer、主机带端口 127.0.0.1:15721');
  ok(L.providerTableInfo(TOML_DIRECT, 'other').found === false, '别的 id：found=false');
  ok(L.providerTableInfo(TOML_DIRECT.replace('[model_providers.custom]', '[ model_providers.custom ]'), 'custom').found === true,
    '表头内有空格：仍识别（codex 也接受）');
  ok(L.providerTableInfo(TOML_DIRECT.replace('[model_providers.custom]', '[model_providers."custom"]'), 'custom').found === true,
    '双引号表头：识别');
  ok(L.providerTableInfo(TOML_DIRECT.replace('[model_providers.custom]', "[model_providers.'custom']"), 'custom').found === true,
    '单引号表头：识别');
  ok(L.providerTableInfo(TOML_DIRECT.replace('[model_providers.custom]', '[model_providers.custom] # 供应商'), 'custom').found === true,
    '表头尾随注释：识别');
  ok(L.providerTableInfo('model_providers.custom.name = "x"\n', 'custom').found === false,
    '顶层点号键：不识别（假阴性可接受，规格 §10.2）');
  ok(L.providerTableInfo('model_providers.custom = { name = "x" }\n', 'custom').found === false,
    'inline table：不识别（假阴性可接受）');
  const sub = L.providerTableInfo('[model_providers.custom]\nname="x"\n[model_providers.custom.http_headers]\n"X-A"="1"\n', 'custom');
  ok(sub.found && sub.hasOtherAuth, '子表 [model_providers.custom.http_headers]：hasOtherAuth');
  // 第 1 轮审查发现：子表识别的边界写法必须与主进程注入函数同源，否则两边打架
  // （launcher 说"已修"、注入函数不加；或反过来 launcher 说修、注入函数真加了把用户自带的鉴权头顶掉）。
  // 这两种写法原来都漏判，下面逐条锁死。
  const subQuoted = L.providerTableInfo('[model_providers.custom]\nname="x"\n[model_providers."custom".http_headers]\n"X-A"="1"\n', 'custom');
  ok(subQuoted.hasOtherAuth === true, '带引号子表 [model_providers."custom".http_headers]：hasOtherAuth（引号必须整体剥掉再比）');
  const subSpaced = L.providerTableInfo('[model_providers.custom]\nname="x"\n[model_providers . "custom" . http_headers]\n"Authorization"="Bearer mine"\n', 'custom');
  ok(subSpaced.hasOtherAuth === true, '带空格的带引号子表 [model_providers . "custom" . http_headers]：hasOtherAuth（点号两侧空白也要归一）');
  const subSpacedPlain = L.providerTableInfo('[model_providers.custom]\nname="x"\n[model_providers . custom . http_headers]\n"Authorization"="Bearer mine"\n', 'custom');
  ok(subSpacedPlain.hasOtherAuth === true, '带空格的无引号子表 [model_providers . custom . http_headers]：hasOtherAuth');
  ok(L.providerTableInfo('[model_providers.custom]\nname="x"\n[model_providers.\'custom\'.http_headers]\n\'X-A\'=\'1\'\n', 'custom').hasOtherAuth === true,
    "单引号子表 [model_providers.'custom'.http_headers]：hasOtherAuth");
  // 反方向：正常的带引号父表头不能被误判成子表（否则会白白放弃鉴权修复）
  ok(L.providerTableInfo('[model_providers."custom"]\nname="x"\nbase_url="https://x/v1"\n', 'custom').hasOtherAuth === false,
    '带引号父表头 [model_providers."custom"]：不是子表（found=true、hasOtherAuth=false）');
  ok(L.providerTableInfo('[ model_providers . custom ]\nname="x"\nbase_url="https://x/v1"\n', 'custom').hasOtherAuth === false,
    '带空格父表头 [ model_providers . custom ]：不是子表');
  ok(L.providerTableInfo('[model_providers.custom]\nenv_key = "MY_KEY"\n', 'custom').hasEnvKey === true, 'env_key：hasEnvKey');
  ok(L.providerTableInfo('[model_providers.custom]\nauth = "cmd"\n', 'custom').hasOtherAuth === true, 'auth 命令：hasOtherAuth');
  // 多行字符串里的假表头（第 2 轮审查发现，已实测为**致命**假阳性，不是"最坏少推参数"）：
  // 逐行解析不加多行字符串感知时，假表头 -> launcher 判"表存在" -> 写 auth 覆盖 -> 注入函数推出
  // -c model_providers.<id>.requires_openai_auth=true，而 config 里其实没有这张表 -> codex 报
  // `Error: model_providers.custom: provider name must not be empty` 且 **app-server 以退出码 1 直接退出**
  // （实测 61ms；对照：不带 -c 时 app-server 正常应答 initialize）。所以这里必须判"表不存在"。
  const ml = 'x = """\n[model_providers.zzz]\n"""\n';
  ok(L.providerTableInfo(ml, 'zzz').found === false,
    '多行字符串里的假表头：必须**不**识别（识别了会推出致命 -c）');
  ok(L.providerTableInfo("x = '''\n[model_providers.zzz]\n'''\n", 'zzz').found === false,
    "多行字符串（''' 字面量）里的假表头：必须不识别");
  ok(L.providerTableInfo('model_provider = "custom"\ntext = """\n[model_providers.custom]\nrequires_openai_auth = true\n"""\n', 'custom').found === false,
    '多行字符串里的假表头 + 假 requires_openai_auth：都不算数（found=false）');
  ok(L.readTopLevel('text = """\nmodel_provider = "custom"\n"""\n').modelProvider === null,
    'readTopLevel：多行字符串里的 model_provider 不算数');
  // 反方向：多行字符串不能把**真的**表吃掉（否则用户明明配好了却被判 no-table、丢掉鉴权修复）
  const realAfterMl = 'model_provider = "custom"\ntext = """\nline1\nline2\n"""\n\n[model_providers.custom]\nname = "x"\nbase_url = "https://x/v1"\nrequires_openai_auth = false\n';
  ok(L.providerTableInfo(realAfterMl, 'custom').found === true,
    '多行字符串收尾之后的**真表**仍要识别（found=true）');
  ok(L.providerTableInfo('model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://x/v1"\nnote = """\n[model_providers.other]\n"""\n', 'custom').found === true,
    '真表之后的假表头不能把真表抹掉');
  // 注释里的表头本来就该被砍掉（顺带锁死）
  ok(L.providerTableInfo('model_provider = "custom"\n# [model_providers.custom]\n', 'custom').found === false,
    '# 注释里的表头：不识别');
  // 转义语义（TOML § 多行基本字符串）：字符串内容里的 \" 是一个**转义引号**，所以 `\"""`（反斜杠 + 三个引号）
  // 不等于收尾；只有 `\\"""`（转义反斜杠 + 三个引号，即奇数个前导反斜杠之外的情况）才收尾。
  // 这两条是**形式化**的 TOML 规则，写死是为了锁住行为：core 侧目前用朴素的 indexOf 判断收尾（不看转义），
  // 在"转义引号后接真表"这一格上会与 launcher 分歧（实测：launcher 判 found=true、core 判成串提前结束->不推），
  // 造成"日志说已修、实际没修"。launcher 侧按 TOML 语义处理（本文件这两条断言），并已在 handoff 里请 core 对齐。
  const escThenRealTable = 'model_provider = "custom"\ndoc = """\nhe said \\""" ok\n"""\n\n[model_providers.custom]\nname = "x"\nrequires_openai_auth = false\n';
  ok(L.providerTableInfo(escThenRealTable, 'custom').found === true,
    '多行串里的 \\""" 是转义引号（非收尾）：后面的真表仍要识别');
  const escNoRealTable = 'model_provider = "custom"\ndoc = """\nhe said \\""" ok\n[model_providers.custom]\nname = "x"\nrequires_openai_auth = false\n"""\n';
  ok(L.providerTableInfo(escNoRealTable, 'custom').found === false,
    '多行串里的 \\""" 之后的内容仍属于字符串：里面的假表头不算数');
  const trueCloseThenRealTable = 'model_provider = "custom"\ndoc = """\nhe said \\\\"""\n\n[model_providers.custom]\nname = "x"\nrequires_openai_auth = false\n';
  ok(L.providerTableInfo(trueCloseThenRealTable, 'custom').found === true,
    '\\\\""" 是真收尾（转义反斜杠 + 三引号）：后面的真表要识别');
}

// ---------- decideAuthOverride：逐种 diagnosis ----------
head('decideAuthOverride');
const expectDiag = (label, tomlText, authJson, want) => {
  const r = L.decideAuthOverride({ tomlText, authJson });
  ok(r.diagnosis === want, label + ' -> ' + want + '（实际 ' + r.diagnosis + '，provider=' + r.provider + '）');
  return r;
};
{
  const r = expectDiag('用户现状（requires_openai_auth=false、无 bearer、key 在 auth.json）', TOML_DIRECT, AUTH_OK, 'direct-no-credential');
  ok(r.provider === 'custom', '用户现状：provider=custom');
  expectDiag('路由形态（base_url 127.0.0.1 + 占位 bearer）', TOML_ROUTED, AUTH_OK, 'routed-or-bearer');
  ok(L.decideAuthOverride({ tomlText: TOML_ROUTED, authJson: AUTH_OK }).provider === 'custom', '路由形态：provider=custom（也会写进覆盖文件）');
  expectDiag('官方（没有 model_provider）', '[mcp_servers]\n', AUTH_OK, 'no-provider');
  // §10.1 决定 4：内置 id 精确白名单，只有这 4 个
  for (const id of ['openai', 'ollama', 'lmstudio', 'amazon-bedrock']) {
    expectDiag('内置 id ' + id + '（不能加覆盖：会 reserved built-in provider IDs）', 'model_provider = "' + id + '"\n', AUTH_OK, 'no-provider');
  }
  // azure / github_copilot / xai_oauth 是普通表名，必须照常走修复（规格 §10.1 纠正了 §5.3 的说法）
  for (const id of ['azure', 'github_copilot', 'xai_oauth']) {
    const t = 'model_provider = "' + id + '"\n[model_providers.' + id + ']\nbase_url = "https://x/v1"\nrequires_openai_auth = false\n';
    const rr = L.decideAuthOverride({ tomlText: t, authJson: AUTH_OK });
    ok(rr.provider === id && rr.diagnosis === 'direct-no-credential', id + ' 按普通表名处理 -> direct-no-credential（provider=' + rr.provider + '）');
  }
  expectDiag('model_provider 指向不存在的表', 'model_provider = "custom"\n[model_providers.other]\nbase_url="https://x"\n', AUTH_OK, 'no-table');
  expectDiag('provider 名含非法字符 a"b', 'model_provider = "a\\"b"\n', AUTH_OK, 'invalid-id');
  expectDiag('provider 名含非法字符 x]', 'model_provider = "x]"\n', AUTH_OK, 'invalid-id');
  expectDiag('env_key 形态（自带鉴权）', 'model_provider = "custom"\n[model_providers.custom]\nenv_key = "MY_KEY"\n', AUTH_OK, 'other-auth');
  expectDiag('http_headers 子表（自带鉴权）', 'model_provider = "custom"\n[model_providers.custom]\nbase_url="https://x"\n[model_providers.custom.http_headers]\n"X-A"="1"\n', AUTH_OK, 'other-auth');
  expectDiag('auth.json 有 tokens（官方登录）', TOML_DIRECT, AUTH_TOKENS, 'chatgpt-login');
  expectDiag('auth.json 为空对象', TOML_DIRECT, AUTH_EMPTY, 'no-api-key');
  expectDiag('auth.json 的 key 是空白字符串', TOML_DIRECT, AUTH_NO_KEY, 'no-api-key');
  expectDiag('auth.json 缺失（null）', TOML_DIRECT, null, 'no-api-key');
  expectDiag('已是 requires_openai_auth = true', TOML_ALREADY, AUTH_OK, 'already-true');
  expectDiag('带引号表头 [model_providers."custom"]', TOML_DIRECT.replace('[model_providers.custom]', '[model_providers."custom"]'), AUTH_OK, 'direct-no-credential');
  expectDiag('CRLF 换行', TOML_DIRECT.replace(/\n/g, '\r\n'), AUTH_OK, 'direct-no-credential');
  expectDiag('BOM 开头', '\uFEFF' + TOML_DIRECT, AUTH_OK, 'direct-no-credential');
  expectDiag('单引号表头', TOML_DIRECT.replace('[model_providers.custom]', "[model_providers.'custom']"), AUTH_OK, 'direct-no-credential');
  expectDiag('表头内有空格', TOML_DIRECT.replace('[model_providers.custom]', '[ model_providers.custom ]'), AUTH_OK, 'direct-no-credential');
  // tokens 与 API Key 同时存在：官方登录优先（不能拿官方凭据去访问第三方地址）
  expectDiag('tokens + key 同时存在', TOML_DIRECT, { OPENAI_API_KEY: 'sk-probe-0000', tokens: { access_token: 'sk-probe-x' } }, 'chatgpt-login');
  // 三种 provider 非 null 的 diagnosis 之外的都要 provider=null
  ok(L.decideAuthOverride({ tomlText: TOML_DIRECT, authJson: AUTH_TOKENS }).provider === null, 'chatgpt-login 时 provider=null');
  ok(L.decideAuthOverride({ tomlText: TOML_DIRECT, authJson: AUTH_OK, }).provider === 'custom', 'direct-no-credential 时 provider 非空');
  // authJson 也接受 JSON **字符串**（probe 的 callDecide 两种都试；不 parse 会把"已登录"误判成"没 key"）
  expectDiag('authJson 传 JSON 字符串（probe 的第二条路径）', TOML_DIRECT, JSON.stringify(AUTH_OK), 'direct-no-credential');
  ok(L.decideAuthOverride({ tomlText: TOML_DIRECT, authJson: JSON.stringify(AUTH_OK) }).provider === 'custom',
    'authJson 字符串形式同样给出 provider=custom');
  expectDiag('authJson 是坏 JSON 字符串', TOML_DIRECT, 'not-json', 'no-api-key');
  expectDiag('authJson 字符串带 BOM + tokens', TOML_DIRECT, '\uFEFF' + JSON.stringify(AUTH_TOKENS), 'chatgpt-login');
}

// ---------- buildOverrides ----------
head('buildOverrides');
{
  const o1 = L.buildOverrides({ catalogPath: 'C:\\a b\\model-catalog-merged.json', auth: { provider: 'custom' } });
  ok(o1.version === 1 && o1.writer === 'codex-launcher v14', '固定 version/writer');
  ok(o1.catalog === 'C:/a b/model-catalog-merged.json', 'catalog 转正斜杠绝对路径（' + o1.catalog + '）');
  ok(o1.auth && o1.auth.provider === 'custom' && o1.auth.requiresOpenaiAuth === true,
    'auth = { provider, requiresOpenaiAuth:true }（规格 §10.2 决定 2）');
  const o2 = L.buildOverrides({ catalogPath: null, auth: null });
  ok(o2.catalog === null && o2.auth === null, '没有目录/没有鉴权时两个字段都是 null');
  // 夹具里放假 key，序列化结果里绝不允许出现它（安全红线：覆盖文件不含任何 key）。
  // 注意断言必须真的会失败：早期写成 `... || true` 等于空转（已改）。这里再补一条源级检查，
  // 证明"额外字段被丢弃"来自白名单式构造（只 return 四个键），而不是恰好这次没传敏感值
  const o3 = L.buildOverrides({ catalogPath: 'C:/x/c.json', auth: { provider: 'custom' }, extra: 'sk-probe-must-not-appear' });
  ok(!JSON.stringify(o3).includes('sk-probe-must-not-appear'), '额外字段（含假 key 形态）不进覆盖文件');
  {
    const lsrc = fs.readFileSync(path.join(ROOT, 'codex-launcher.js'), 'utf8');
    const body = lsrc.slice(lsrc.indexOf('function buildOverrides('), lsrc.indexOf('// diagnosis -> 一行中文说明'));
    ok(!/\.\.\.\s*(catalogPath|auth|arguments|\w+\s*\))/.test(body) && !/Object\.assign/.test(body),
      'buildOverrides 是白名单字面量构造（没有扩展运算符/Object.assign 把调用方对象整块透传）');
  }
  ok(Object.keys(o3).sort().join(',') === 'auth,catalog,version,writer', '覆盖文件只有四个键：' + Object.keys(o3).sort().join(','));
  const o4 = L.buildOverrides({ catalogPath: 'C:/x/c.json', auth: { provider: 'custom', requiresOpenaiAuth: false } });
  ok(o4.auth.requiresOpenaiAuth === true, 'auth 传入什么，requiresOpenaiAuth 都固定 true（表达"启动器已确认"）');
  // catalog 与 auth 是**两件独立的事**（规格 §4.3：两段各自 try、互不连累）：catalog 只表达"模型目录指向哪里"，
  // 不由鉴权诊断（chatgpt-login / no-api-key / no-provider 等）决定。锁死这条，是因为第 1 轮审查在
  // 官方登录场景提过"目录仍会被写"——那是**有意为之**（目录负责 Ultrafast 档位、鉴权负责 401，互不依赖），
  // 不是缺陷；写成断言避免后人误"修"成"诊断不是 direct-no-credential 就不写目录"。
  const o5 = L.buildOverrides({ catalogPath: 'C:/x/merged.json', auth: null }); // 官方登录/其它不写鉴权的诊断
  ok(o5.catalog === 'C:/x/merged.json' && o5.auth === null,
    'catalog 与 auth 独立：不写鉴权覆盖时 catalog 照写（官方登录场景）');
}

// ---------- 与主进程注入函数的一致性（防止两边逻辑漂移） ----------
head('注入函数一致性（launcher 说可以 -> 必须加；说不可以 -> 必须不加）');
{
  // 造一个假镜像根 + 假 CODEX_HOME，把覆盖文件写进去，用 vm 执行 core.NET_INJECT_SRC / core.evalNetArgs
  const VROOT = path.join(TMP, 'vroot');
  const VHOME = path.join(VROOT, 'codexhome');
  const VAPP = path.join(VROOT, 'app');
  for (const d of [VHOME, VAPP]) fs.mkdirSync(d, { recursive: true });
  const fakeCatalog = path.join(VROOT, 'model-catalog-merged.json');
  fs.writeFileSync(fakeCatalog, '{"models":[]}');
  const fakeProcess = { execPath: path.join(VAPP, 'ChatGPT.exe'), env: { CODEX_HOME: VHOME } };
  // 用 core.NET_INJECT_SRC 直接跑注入函数（不看 bundle）：源码本身就是 '(function launcherOverrides(){...})()'
  const runInject = () => vm.runInNewContext(core.NET_INJECT_SRC, { require, process: fakeProcess, JSON });
  const writeFixture = (tomlText, authJson, over) => {
    fs.writeFileSync(path.join(VHOME, 'config.toml'), tomlText);
    fs.writeFileSync(path.join(VHOME, 'auth.json'), JSON.stringify(authJson));
    fs.writeFileSync(path.join(VROOT, core.NET_OVERRIDES_FILE), JSON.stringify(over));
  };
  const hasAuthArg = args => args.some((a, i) => typeof a === 'string' && a.indexOf('model_providers.custom.requires_openai_auth=') === 0);
  const hasCatalogArg = args => args.some(a => typeof a === 'string' && a.indexOf('model_catalog_json=') === 0);

  // 1) launcher 说"可以加"的三种 diagnosis：覆盖文件按 buildOverrides 的形态写入 -> 注入函数必须加鉴权项
  const canCases = [
    ['direct-no-credential', TOML_DIRECT, AUTH_OK],
    ['routed-or-bearer', TOML_ROUTED, AUTH_OK],
    ['already-true', TOML_ALREADY, AUTH_OK],
  ];
  for (const [name, tomlText, authJson] of canCases) {
    const d = L.decideAuthOverride({ tomlText, authJson });
    ok(d.provider === 'custom', name + '：decideAuthOverride 给出 provider=custom');
    const over = L.buildOverrides({ catalogPath: fakeCatalog, auth: { provider: d.provider } });
    writeFixture(tomlText, authJson, over);
    const args = runInject();
    ok(hasAuthArg(args), name + '：注入函数加了鉴权项（' + JSON.stringify(args.map(a => a.length > 40 ? a.slice(0, 40) + '…' : a)) + '）');
    ok(hasCatalogArg(args), name + '：注入函数也加了 model_catalog_json 项');
  }
  // 2 补) 第 2 轮审查发现的核心回归：多行字符串里的假表头。
  // 这里走**真实流程**（decideAuthOverride -> buildOverrides -> 注入函数），断言"launcher 实际会写出的
  // 覆盖文件"不会让注入函数推出致命 -c。修复前 launcher 会把假表头当真表，写出 auth 覆盖，
  // 注入函数照着推 -c，codex 直接报 provider name must not be empty 且 app-server 以退出码 1 退出。
  const fpToml = 'model_provider = "custom"\ndeveloper_instructions = """\nUse this style guide.\n[model_providers.custom]\nname = "custom"\n"""\n';
  const fpDiag = L.decideAuthOverride({ tomlText: fpToml, authJson: AUTH_OK });
  ok(fpDiag.provider === null && fpDiag.diagnosis === 'no-table',
    '假表头（多行字符串里）：launcher 判 no-table、不写鉴权覆盖（实际 ' + fpDiag.diagnosis + '/provider=' + fpDiag.provider + '）');
  // 按 launcher 的真实决策写覆盖文件（这一步就是启动时会写的内容）
  writeFixture(fpToml, AUTH_OK, L.buildOverrides({ catalogPath: null, auth: fpDiag.provider ? { provider: fpDiag.provider } : null }));
  ok(!hasAuthArg(runInject()),
    '假表头：launcher 写出的覆盖文件不会让注入函数推出 requires_openai_auth（否则 app-server 起不来）');
  // 2) launcher 说"不可以"的 diagnosis：**强制**把 { provider:'custom', requiresOpenaiAuth:true } 写进覆盖文件，
  //    注入函数仍必须不加（运行时防线要独立挡住这些情况）
  const blocked = [
    ['no-table', 'model_provider = "custom"\n[model_providers.other]\nbase_url="https://x"\n', AUTH_OK],
    ['other-auth（env_key）', 'model_provider = "custom"\n[model_providers.custom]\nenv_key = "MY_KEY"\n', AUTH_OK],
    ['other-auth（http_headers 子表）', 'model_provider = "custom"\n[model_providers.custom]\nbase_url="https://x"\n[model_providers.custom.http_headers]\n"X-A"="1"\n', AUTH_OK],
    ['chatgpt-login', TOML_DIRECT, AUTH_TOKENS],
    ['no-api-key', TOML_DIRECT, AUTH_EMPTY],
  ];
  for (const [name, tomlText, authJson] of blocked) {
    const d = L.decideAuthOverride({ tomlText, authJson });
    ok(d.provider === null, name + '：launcher 侧 provider=null（不写 auth）');
    const forced = { version: 1, writer: 'codex-launcher v14', catalog: fakeCatalog.replace(/\\/g, '/'), auth: { provider: 'custom', requiresOpenaiAuth: true } };
    writeFixture(tomlText, authJson, forced);
    const args = runInject();
    ok(!hasAuthArg(args), name + '：运行时防线独立挡住（注入函数不加鉴权项）');
  }
  // 3) auth 缺 requiresOpenaiAuth（老格式/被改过的文件）-> 注入函数不加（§10.2 的必要条件）
  writeFixture(TOML_DIRECT, AUTH_OK, { version: 1, writer: 'x', catalog: null, auth: { provider: 'custom' } });
  ok(!hasAuthArg(runInject()), 'auth 缺 requiresOpenaiAuth：注入函数不加鉴权项（必要条件）');
  writeFixture(TOML_DIRECT, AUTH_OK, { version: 1, writer: 'x', catalog: null, auth: { provider: 'custom', requiresOpenaiAuth: false } });
  ok(!hasAuthArg(runInject()), 'auth.requiresOpenaiAuth=false：注入函数不加鉴权项');
  // 4) 内置 id 挡板（第二道防线）：会话中途 config 改成内置 id 也不会推出致命 -c
  for (const id of ['openai', 'ollama', 'lmstudio', 'amazon-bedrock']) {
    writeFixture('model_provider = "' + id + '"\n', AUTH_OK, { version: 1, writer: 'x', catalog: null, auth: { provider: id, requiresOpenaiAuth: true } });
    ok(!runInject().some(a => typeof a === 'string' && a.indexOf('requires_openai_auth=') >= 0), '内置 id ' + id + '：注入函数挡住（不推 requires_openai_auth）');
  }
  // 5) 覆盖文件不存在 / 坏 JSON / version≠1 -> 空数组
  fs.rmSync(path.join(VROOT, core.NET_OVERRIDES_FILE), { force: true });
  ok(runInject().length === 0, '没有覆盖文件：注入函数返回空数组');
  fs.writeFileSync(path.join(VROOT, core.NET_OVERRIDES_FILE), '{ 坏 JSON');
  ok(runInject().length === 0, '覆盖文件是坏 JSON：返回空数组');
  fs.writeFileSync(path.join(VROOT, core.NET_OVERRIDES_FILE), JSON.stringify({ version: 2, catalog: fakeCatalog, auth: { provider: 'custom', requiresOpenaiAuth: true } }));
  ok(runInject().length === 0, 'version≠1：返回空数组');
  // 6) 目录不存在 -> 只剩鉴权项；鉴权条件不满足 -> 一个都不推
  writeFixture(TOML_DIRECT, AUTH_OK, L.buildOverrides({ catalogPath: path.join(VROOT, 'no-such.json'), auth: { provider: 'custom' } }));
  const onlyAuth = runInject();
  ok(!hasCatalogArg(onlyAuth) && hasAuthArg(onlyAuth), 'catalog 指向不存在的文件：只推鉴权项');
  writeFixture('model_provider = "custom"\n', AUTH_EMPTY, L.buildOverrides({ catalogPath: fakeCatalog, auth: { provider: 'custom' } }));
  const onlyCat = runInject();
  ok(hasCatalogArg(onlyCat) && !hasAuthArg(onlyCat), '没有 key：只推目录项');
  // 7) 目录是相对路径：不推（注入函数要求绝对路径）
  writeFixture(TOML_DIRECT, AUTH_OK, { version: 1, writer: 'x', catalog: 'relative/c.json', auth: null });
  ok(!hasCatalogArg(runInject()), 'catalog 是相对路径：不推目录项');
  // 8) evalNetArgs：从真 bundle 文本跑一遍（真实镜像用 REQUIRE 前捕获的原始 HOME 拼路径，沙箱里 os.homedir() 已变）。
  //    用 core.readAsar + core.locateNetBundle 直取 net bundle：不调 locateBundles（那会扫 14000+ 个 webview 文件，很慢）
  const realHome = envBackup.USERPROFILE || os.homedir();
  const mirrorAsar = path.join(realHome, 'ChatGPT-Patched', 'app', 'resources', 'app.asar');
  if (fs.existsSync(mirrorAsar)) {
    const asar = core.readAsar(mirrorAsar);
    const fd = fs.openSync(mirrorAsar, 'r');
    try {
      const doc = core.locateNetBundle(asar.header, asar.dataBase, fd);
      if (doc) {
        // 两种镜像状态都要能过：还没用 v14 启动过的机器（原文无补丁）和已经在用的机器（重建后原文就带补丁）
        const alreadyPatched = core.hasNetPatch(doc.text);
        const patched = core.applyNetPatch(doc.text);
        if (alreadyPatched) {
          ok(!patched.ok && patched.actual === 0, '真实 bundle 已带 v14 补丁：applyNetPatch 不会二次注入（actual=0）');
          ok(core.hasNetPatch(patched.text), '真实 bundle：hasNetPatch 为真（镜像已由启动器重建打上补丁）');
        } else {
          ok(patched.ok && core.hasNetPatch(patched.text), '真实 bundle：applyNetPatch 成功且 hasNetPatch 为真（' + doc.rel + '）');
          ok(!core.hasNetPatch(doc.text), '真实 bundle 原文：hasNetPatch 为假（还没打补丁）');
        }
        writeFixture(TOML_DIRECT, AUTH_OK, L.buildOverrides({ catalogPath: fakeCatalog, auth: { provider: 'custom' } }));
        // evalNetArgs 在子进程里跑并带超时：它一旦死循环（core 侧正则缺 g 标志，见 handoff），
        // 直接在测试进程里调用会把整条快检查挂死。超时按 FAIL 报，并写明责任方
        const probeFile = path.join(TMP, 'eval-args-probe.js');
        fs.mkdirSync(TMP, { recursive: true });
        fs.writeFileSync(probeFile, [
          "'use strict';",
          'const fs=require("fs"),core=require(' + JSON.stringify(path.join(ROOT, 'lib', 'launcher-core.js')) + ');',
          'const a=core.readAsar(' + JSON.stringify(mirrorAsar) + ');',
          'const fd=fs.openSync(' + JSON.stringify(mirrorAsar) + ',"r");',
          'let doc=null;try{doc=core.locateNetBundle(a.header,a.dataBase,fd);}finally{fs.closeSync(fd);}',
          'const patched=core.applyNetPatch(doc.text);',
          'const args=core.evalNetArgs(patched.text,' + JSON.stringify(fakeProcess) + ');',
          'process.stdout.write(JSON.stringify(args));',
        ].join('\n'));
        const p = require('child_process').spawnSync(process.execPath, [probeFile], { encoding: 'utf8', timeout: 20000 });
        if (p.error && p.error.code === 'ETIMEDOUT') {
          ok(false, 'core.evalNetArgs 在真实 bundle 上 20 秒没返回（死循环：lib/launcher-core.js:582/603 的 while+exec 正则缺 g 标志）——这是 core 的缺陷，已 handoff，不是 launcher 侧问题');
        } else {
          let args = null;
          try { args = JSON.parse((p.stdout || '').trim()); } catch (e) {}
          ok(Array.isArray(args), 'core.evalNetArgs 返回参数数组（' + (args ? JSON.stringify(args.filter(a => a.length < 60)) : p.stderr || p.status) + '）');
          if (Array.isArray(args)) {
            ok(args.some(a => a.indexOf('model_catalog_json=') === 0) && args.some(a => a.indexOf('model_providers.custom.requires_openai_auth=') === 0),
              '真实 bundle + vm 执行 ec()：两条覆盖参数都在');
            ok(args.includes('app-server'), '参数形态：包含 app-server 子命令');
          }
        }
      } else {
        console.log('  SKIP 真实镜像里没有 net bundle（可能版本较旧）');
      }
    } finally { fs.closeSync(fd); }
  } else {
    console.log('  SKIP 真实镜像不存在，跳过 evalNetArgs 的真实样本断言');
  }
}

// ---------- mergeCatalogs ----------
head('mergeCatalogs');
{
  const tier = id => ({ id, name: id, description: '' });
  // 第三方条目的完整必填字段（第 4 轮审查：缺任一 -> codex 拒绝整份目录，实测）
  const thirdParty = (slug, over = {}) => ({
    slug,
    display_name: slug,
    base_instructions: 'x',
    experimental_supported_tools: [],
    priority: 1000,
    shell_type: 'shell_command',
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: 'low' }],
    truncation_policy: { limit: 10000, mode: 'bytes' },
    visibility: 'list',
    service_tiers: [],
    ...over,
  });
  const bundled = {
    note: 'bundled-extra-field', // 顶层其它字段必须原样保留
    models: [
      { slug: 'gpt-6-astra', display_name: 'Astra', service_tiers: [tier('priority')] },
      { slug: 'gpt-plain', display_name: 'Plain', service_tiers: [] },
      { slug: 'no-slug-model' },
    ],
  };
  const extras = [{ path: 'C:/x/cc-switch-model-catalog.json', data: { models: [
    { slug: 'gpt-6-astra', display_name: 'Astra（用户覆盖）', service_tiers: [tier('custom-tier')] },
    thirdParty('glm-5.3', { display_name: 'GLM' }),
    thirdParty('kimi-k3', { display_name: 'Kimi', service_tiers: [tier('fast')] }),
  ] } }];
  const merged = L.mergeCatalogs(bundled, extras);
  const bySlug = new Map(merged.models.map(m => [m.slug, m]));
  ok(merged.note === 'bundled-extra-field', '顶层其它字段原样保留');
  ok(merged.models[0].slug === 'gpt-6-astra' && merged.models[1].slug === 'gpt-plain', '内置 slug 顺序保持（在前）');
  const astra = bySlug.get('gpt-6-astra');
  ok(astra.display_name === 'Astra（用户覆盖）', 'extras 覆盖同 slug 的元数据');
  const ids = astra.service_tiers.map(t => t.id);
  ok(ids.includes('priority') && ids.includes('ultrafast') && ids.includes('custom-tier'), '内置 slug：priority+ultrafast+extras 档位合并（' + ids + '）');
  ok(ids.indexOf('priority') === 0, 'priority 在前（' + ids + '）');
  ok(ids.filter(x => x === 'priority').length === 1 && ids.filter(x => x === 'ultrafast').length === 1, '档位按 id 去重、不重复');
  const plain = bySlug.get('gpt-plain');
  ok(plain.service_tiers.map(t => t.id).join(',') === 'priority,ultrafast', '原本没有档位的内置 slug 补齐 priority+ultrafast');
  ok(bySlug.get('glm-5.3').service_tiers.length === 0, '第三方 slug（glm-5.3）不补任何档位');
  ok(bySlug.get('kimi-k3').service_tiers.map(t => t.id).join(',') === 'fast', '第三方 slug 原有档位原样保留');
  ok(merged.models.map(m => m.slug).join(',') === 'gpt-6-astra,gpt-plain,no-slug-model,glm-5.3,kimi-k3',
    'models 顺序：内置在前（保持原顺序），新 slug 按 extras 出现顺序追加在末尾（' + merged.models.map(m => m.slug).join(',') + '）');
  ok(bySlug.get('gpt-6-astra').service_tiers[0].id === 'priority' && astra.service_tiers[0].name === 'priority',
    '内置已有的 priority 档保留内置元数据（不被 PRIORITY_TIER 顶掉）');
  // 跳过 v13 旧产物
  const v13 = [{ path: 'C:/Users/x/.codex/model-catalog-ultrafast.json', data: { models: [{ slug: 'gpt-6-astra', display_name: 'v13', service_tiers: [] }] } }];
  const m2 = L.mergeCatalogs(bundled, v13);
  ok(m2.models.find(m => m.slug === 'gpt-6-astra').display_name === 'Astra', 'model-catalog-ultrafast.json 被跳过（不覆盖内置条目）');
  ok(m2.models.length === 3, '跳过旧产物后不追加多余 slug（' + m2.models.length + '）');
  // 坏 JSON / 结构不对的 extras 由调用方过滤；这里直接传 data:null 也必须不炸
  const m3 = L.mergeCatalogs(bundled, [{ path: 'C:/x/broken.json', data: null }, { data: { notModels: 1 } }]);
  ok(m3.models.length === bundled.models.length, '坏 extras 被跳过、不影响结果');
  ok(L.mergeCatalogs(null, []).models.length === 0, 'bundled 为 null：返回空 models、不抛错');
  ok(L.mergeCatalogs(bundled, []).models[0].service_tiers.map(t => t.id).join(',') === 'priority,ultrafast',
    '没有 extras 时内置 slug 照样补 priority+ultrafast');

  // ---- 第三方条目缺必填字段：跳过该条（而不是让 codex 拒绝整份目录）----
  // 实测依据（镜像 codex.exe + debug models -c model_catalog_json=<合并目录>）：删掉任一必填字段 ->
  // `failed to parse model_catalog_json path ...: missing field \`X\``，整份目录被拒、app-server 起不来；
  // 只留这 11 个字段 -> 接受（清单完整）；多带未知字段 -> 接受；值写成 null -> 拒绝（null 也算缺失）。
  {
    const missingOne = thirdParty('bad-missing', { display_name: 'Bad' });
    delete missingOne.visibility;
    const nullOne = thirdParty('bad-null', { display_name: 'BadNull', shell_type: null });
    const logLines = [];
    const origLog = console.log;
    console.log = (...a) => logLines.push(a.join(' '));
    let m4;
    try {
      m4 = L.mergeCatalogs(bundled, [{ path: 'C:/x/cc-switch-model-catalog.json', data: { models: [missingOne, nullOne, thirdParty('good-one')] } }]);
    } finally { console.log = origLog; }
    const slugs4 = m4.models.map(m => m.slug).join(',');
    ok(!m4.models.some(m => m.slug === 'bad-missing') && !m4.models.some(m => m.slug === 'bad-null'),
      '缺字段 / 字段为 null 的第三方条目被跳过（' + slugs4 + '）');
    ok(m4.models.some(m => m.slug === 'good-one'), '同批里完好的第三方条目照常并入（只跳坏的那条）');
    ok(logLines.some(l => /缺必填字段/.test(l)) && logLines.some(l => /visibility/.test(l)) && logLines.some(l => /shell_type/.test(l)),
      '跳过时打了中文日志并写明缺哪个字段（' + logLines.filter(l => /缺必填字段/.test(l)).length + ' 条）');
    ok(logLines.some(l => /cc-switch-model-catalog\.json/.test(l)), '日志里带了来源文件路径（便于用户定位是哪个目录文件坏了）');
    // 覆盖内置 slug 的条目**不**做这条校验：它会与内置条目展开合并，缺失字段由内置补齐（实测被 codex 接受）。
    // 对它们也跳过的话，会把用户正常的档位覆盖一起丢掉（下一段的 custom-tier 断言就是这种覆盖）。
    const partialOverride = { slug: 'gpt-plain', service_tiers: [tier('fast')] };
    const m5 = L.mergeCatalogs(bundled, [{ data: { models: [partialOverride] } }]);
    const plain5 = m5.models.find(m => m.slug === 'gpt-plain');
    ok(plain5 && plain5.service_tiers.some(t => t.id === 'fast'),
      '覆盖内置 slug 的条目不做必填校验（缺字段由内置补齐，实测 codex 接受；跳过它反而会丢用户的档位覆盖）');
    // 缺字段的第三方条目不影响内置条目的补齐
    const m6 = L.mergeCatalogs(bundled, [{ data: { models: [missingOne] } }]);
    ok(m6.models.length === 3 && m6.models[0].service_tiers.some(t => t.id === 'ultrafast'),
      '跳过一个坏条目后，内置条目照常补齐 priority+ultrafast');

    // ---- base_instructions 是**二选一**条件必填（第 11 轮审查发现，实测 10 组变体复核）----
    // 依据（镜像 codex.exe `debug models -c model_catalog_json=<目录>`，探针 = cc-switch 真实条目形状改 slug）：
    //   删 base_instructions 且无 model_messages -> 拒绝，原文：
    //     `model \`probe-cond\` is missing both \`base_instructions\` and \`model_messages.instructions_template\``
    //   删 base_instructions + 给 instructions_template -> 接受；base_instructions=null + 给 template -> 接受；
    //   base_instructions=""（空串）-> 接受；template=null / model_messages={} / model_messages=null -> 都拒绝。
    // 若不做条件判定，只靠 instructions_template 提供指令的合法条目会被静默跳过（用户侧：模型没了）。
    {
      const onlyTemplate = thirdParty('tpl-only', { display_name: 'TplOnly' });
      delete onlyTemplate.base_instructions;
      onlyTemplate.model_messages = { instructions_template: 'You are Codex.' };
      const onlyBase = thirdParty('base-only', { display_name: 'BaseOnly' });
      const neither = thirdParty('neither', { display_name: 'Neither' });
      delete neither.base_instructions;
      const tplNull = thirdParty('tpl-null', { display_name: 'TplNull' });
      delete tplNull.base_instructions;
      tplNull.model_messages = { instructions_template: null };
      const emptyBase = thirdParty('empty-base', { display_name: 'EmptyBase', base_instructions: '' });
      const logLines2 = [];
      const origLog2 = console.log;
      console.log = (...a) => logLines2.push(a.join(' '));
      let m7;
      try {
        m7 = L.mergeCatalogs(bundled, [{ path: 'C:/x/cc-switch-model-catalog.json', data: { models: [onlyTemplate, onlyBase, neither, tplNull, emptyBase] } }]);
      } finally { console.log = origLog2; }
      const has = s => m7.models.some(m => m.slug === s);
      ok(has('tpl-only'), '只靠 model_messages.instructions_template：保留（实测 codex 接受，绝不能跳过）');
      ok(has('base-only'), '只靠 base_instructions：保留（对照组）');
      ok(!has('neither'), '两者都没有：跳过（codex 会拒绝整份目录）');
      ok(!has('tpl-null'), 'instructions_template=null 且无 base_instructions：跳过（null 算没给）');
      ok(has('empty-base'), 'base_instructions=""（空串）：保留（实测 codex 接受空串）');
      ok(logLines2.some(l => /缺: base_instructions 或 model_messages\.instructions_template/.test(l)),
        '两条"都没有"的条目在日志里写明是 base_instructions / instructions_template 二者皆缺');
      // 结构不符的 model_messages（字符串）也让 hasField 走不下去 -> 判为缺；实测 codex 对此报
      // `invalid type: string "nope", expected struct ModelMessages` 同样是拒绝，方向一致（不误留）
      const mmStr = thirdParty('mm-str', { display_name: 'MmStr' });
      delete mmStr.base_instructions;
      mmStr.model_messages = 'nope';
      const m8 = L.mergeCatalogs(bundled, [{ data: { models: [mmStr] } }]);
      ok(!m8.models.some(m => m.slug === 'mm-str'),
        'model_messages 是非对象（坏形态）：跳过（实测 codex 报 invalid type，同样拒绝，不误留）');
    }
  }
}

// ---------- tryCachedInstall 的调用形态（矩阵在 install-discovery-test.js） ----------
head('tryCachedInstall（形态与纯函数约束）');
{
  const r = L.tryCachedInstall({}, {});
  ok(r.ok === false && typeof r.reason === 'string', '空状态：ok=false 且带中文原因（' + r.reason + '）');
  ok(typeof L.NODE_PATH_SAFE_RE.test === 'function' && L.NODE_PATH_SAFE_RE.test('C:\\Program Files\\nodejs\\node.exe'),
    'NODE_PATH_SAFE_RE：普通路径通过');
  ok(!L.NODE_PATH_SAFE_RE.test('C:\\a&b\\node.exe') && !L.NODE_PATH_SAFE_RE.test('C:\\中文\\node.exe'),
    'NODE_PATH_SAFE_RE：含 & 或非 ASCII 的路径被拒（防 cmd 注入）');
}

// ---------- REPORT.net.diagnosis 的形态锁定（防止第三次口径漂移） ----------
// 背景：这个字段在本轮开发中变过两次（先整个人对象、后只留判定码字符串）。规格 §5.1 定的是
// string|null，e2e 按字符串断言判定码（且为兼容旧形态写了 typeof 分支，两种都能过，所以漂移不会被它发现）。
// 两处赋值必须取 .diagnosis（字符串），writeReport 必须把对象归一化成字符串。
// 不跑启动器（并行阶段只有 --self-test / 沙箱 --dry-run 允许），所以用源码文本断言 + 纯函数行为断言。
head('REPORT.net.diagnosis 形态（string|null）');
{
  const src = fs.readFileSync(path.join(ROOT, 'codex-launcher.js'), 'utf8');
  const assigns = src.split(/\r?\n/).filter(l => /^\s*NET_STATE\.diagnosis = /.test(l));
  ok(assigns.length === 2, '找到 2 处 NET_STATE.diagnosis 赋值（self-test / runOnce，实际 ' + assigns.length + '）');
  ok(assigns.every(l => /=\s*diag\.diagnosis\s*;/.test(l)),
    '两处赋值都取 .diagnosis 字段（字符串），没有把 decideAuthOverride 的整体对象放进去');
  const wr = src.slice(src.indexOf('function writeReport('), src.indexOf('function reportCandidates('));
  ok(/typeof d === 'object' \? d\.diagnosis : d/.test(wr),
    'writeReport 把对象形态归一化成字符串（任何调用方误塞对象也只落字符串）');
  // 纯函数侧：diagnosis 必须是字符串（e2e 与 probe 都按字符串读它）
  const d = L.decideAuthOverride({ tomlText: TOML_DIRECT, authJson: AUTH_OK });
  ok(typeof d.diagnosis === 'string' && typeof d.provider === 'string',
    'decideAuthOverride 返回 {provider: string, diagnosis: string}（实际 ' + JSON.stringify(d) + '）');
  // REPORT.net.patch 有两个独立产出点：rebuild 里（刚打完补丁）与 netPatchState()（只读探测现有镜像）。
  // runOnce 会按"本次有没有真的重建成功"在两者间切换，形状不一致的话报告消费者得对两种形态各写一套判断
  const PATCH_KEYS = 'actual,applied,located,present,reason,rel';
  const i = src.indexOf('NET_STATE.patch = {');
  const rebuildKeys = [...new Set([...src.slice(i, src.indexOf('};', i) + 2)
    .matchAll(/(?:^|[\s{,()?:])([a-z]+):/g)].map(m => m[1])
    .filter(k => PATCH_KEYS.split(',').includes(k)))].sort().join(',');
  ok(rebuildKeys === PATCH_KEYS, 'rebuild 分支的 net.patch 键集 === ' + PATCH_KEYS + '（实际 ' + rebuildKeys + '）');
  const ns = src.slice(src.indexOf('function netPatchState()'), src.indexOf('function netPatchStateText()'));
  // 先取原始 return 列表（不去重）再判：4 处 return 的键集必须都相同，且至少有 3 处（形态变了要立刻发现）
  const rawSets = [...ns.matchAll(/return \{ ([^}]*)\}/g)]
    .map(m => m[1].split(',').map(s => s.trim().split(':')[0]).filter(Boolean).sort().join(','));
  ok(rawSets.length >= 3 && rawSets.every(s => s === PATCH_KEYS),
    'netPatchState 的每处 return 键集都 === ' + PATCH_KEYS + '（' + rawSets.length + ' 处：' + JSON.stringify([...new Set(rawSets)]) + '）');
}

// ---------- 注入串的 ASCII 约束（rebuild 的守卫 + core 的实际产物） ----------
// 为什么值得锁：core 的注入函数体会被 toString() 拼进 bundle，而 bundle 按 latin1 读写；一旦函数体里
// 混进非 ASCII（例如有人把中文注释写进 launcherOverrides），落盘会变成单字节，某些汉字的低位字节恰好是
// 0x0A/0x0D/0x22/0x27/0x5C/0x60，可能截断注释、把后续字节变成代码 -> 注入后 bundle 语法错误 ->
// syntaxCheckBundles 抛错 -> 整轮重建作废（连 webview 15 条一起丢），与 §4.1「net 失配不阻断重建」相反。
// 实测：CJK 区 U+4E00..U+9FFF 里每 256 个有 6 个字的低位字节落在这个危险集（共 492 个）。
head('注入串 ASCII 约束');
{
  const coreSrc = fs.readFileSync(path.join(ROOT, 'lib', 'launcher-core.js'), 'utf8');
  const injectSrc = require(path.join(ROOT, 'lib', 'launcher-core.js')).NET_INJECT_SRC;
  const nonAscii = [...injectSrc].filter(c => c.charCodeAt(0) > 127).length;
  ok(nonAscii === 0, 'core.NET_INJECT_SRC 当前是纯 ASCII（实际 ' + nonAscii + ' 个非 ASCII 字符）');
  // 单独再锁一次中日韩汉字：launcher 守卫的文案专门点了"混进中文注释"，这条锁住最可能的引入源
  ok(!/[\u4e00-\u9fff]/.test(injectSrc), 'core.NET_INJECT_SRC 里没有中文注释残留（§4.3 硬约束）');
  ok(/const NET_INJECT_SRC = '\(' \+ launcherOverrides\.toString\(\) \+ '\)\(\)'/.test(coreSrc),
    'core 的注入串仍由 launcherOverrides.toString() 生成（守卫检查的就是真正会被拼进 bundle 的那份源码）');
  // launcher 侧的守卫必须存在且形状对：只有"非 ASCII"才跳过 net 补丁，干净时照常放行
  const launcherSrc = fs.readFileSync(path.join(ROOT, 'codex-launcher.js'), 'utf8');
  ok(/const nonAscii = \[\.\.\.core\.NET_INJECT_SRC\]\.filter\(c => c\.charCodeAt\(0\) > 127\)\.length/.test(launcherSrc),
    'rebuild 里有对 core.NET_INJECT_SRC 的 ASCII 自检（把"整轮重建被一个汉字搞挂"降级为"只跳过 net 补丁"）');
  const guardBlock = launcherSrc.slice(launcherSrc.indexOf('const nonAscii = [...core.NET_INJECT_SRC]'), launcherSrc.indexOf('已为主进程补上 401/Ultrafast 修复补丁'));
  // 关键在**顺序**而不只是存在：content.set 必须出现在 if (nonAscii > 0) 之后。
  // 只断言"两串都在 block 里"会被这样的变异骗过——把 content.set 提到守卫之前，非 ASCII 时照样写盘，
  // 守卫等于失效，而"都在"式断言仍为真（实测过这个盲点）。所以这里比下标。
  const iGuard = guardBlock.indexOf('if (nonAscii > 0) {');
  const iSet = guardBlock.indexOf('content.set(netDoc.rel, netApp.text)');
  ok(iGuard >= 0 && iSet > iGuard && /applied: false/.test(guardBlock.slice(0, iSet)),
    '守卫顺序正确：content.set 在 if (nonAscii > 0) 之后（守卫之前只填 applied=false 的报告，绝不写 content）');
  // 危险字节的存在性（说明这条守卫不是空转的）：给出实测计数，防止有人以为"中文注释无所谓"
  let danger = 0;
  for (let cp = 0x4e00; cp <= 0x9fff; cp++) {
    const lo = cp & 0xff;
    if (lo === 0x0a || lo === 0x0d || lo === 0x22 || lo === 0x27 || lo === 0x5c || lo === 0x60) danger++;
  }
  ok(danger === 492, 'CJK 区里低位字节落在危险集（LF/CR/引号/反斜杠/反引号）的字 = 492（实际 ' + danger + '）');
}

// ---------- 悬空 model_catalog_json 的检测（第 3 轮审查发现） ----------
// 背景（实测）：v13 曾把 model_catalog_json 写进用户 config.toml（指向 ~/.codex/model-catalog-ultrafast.json），
// 而使用说明说"删掉也可以"。文件被删掉后，读这份 config 的 codex 每个新会话都失败：
// thread/start 返回 {"code":-12600..} 形态的 `failed to load configuration: 系统找不到指定的文件 (os error 2)`
// （本文件复现实验：config 里放悬空行 -> thread/start 报错；加 -c model_catalog_json=<有效文件> -> 恢复正常）。
// launcher 不写 config.toml（§4.4），所以能做的是"只读检测 + 告警"，这里锁住检测函数本身的行为。
head('danglingCatalogRef（v13 遗留悬空行的只读检测）');
{
  const DHOME = path.join(TMP, 'dangling-home');
  fs.mkdirSync(DHOME, { recursive: true });
  const dead = path.join(DHOME, 'model-catalog-ultrafast.json');   // 刻意不创建
  const alive = path.join(DHOME, 'alive-catalog.json');
  fs.writeFileSync(alive, '{"models":[]}');
  // 绝对路径 + 文件不存在 -> 返回该路径（悬空）
  const t1 = 'model_catalog_json = ' + JSON.stringify(dead.replace(/\\/g, '/')) + '\nmodel_provider = "custom"\n';
  ok(L.danglingCatalogRef(t1) === dead.replace(/\//g, path.sep) || L.danglingCatalogRef(t1) === dead.replace(/\\/g, '/'),
    '文件不存在：返回悬空路径（' + L.danglingCatalogRef(t1) + '）');
  // 文件存在 -> null（不告警）
  const t2 = 'model_catalog_json = ' + JSON.stringify(alive.replace(/\\/g, '/')) + '\n';
  ok(L.danglingCatalogRef(t2) === null, '文件存在：返回 null（不误报）');
  // 没有这一行 -> null
  ok(L.danglingCatalogRef('model_provider = "custom"\n') === null, '没有该行：返回 null');
  ok(L.danglingCatalogRef('') === null && L.danglingCatalogRef(null) === null, '空输入/ null：不抛异常、返回 null');
  // 多行字符串里的假行不能当真（与 readTopLevel 同源的结构感知）
  ok(L.danglingCatalogRef('text = """\nmodel_catalog_json = "Z:/nope.json"\n"""\n') === null,
    '多行字符串里的假行不算数（结构感知与 readTopLevel 同源）');
  // 相对路径按 CODEX_HOME 解析后同样能判断（CODEX_HOME 在本测试里指向 TMP 下的沙箱）
  ok(L.danglingCatalogRef('model_catalog_json = "no-such-relative.json"\n') !== null,
    '相对路径按 CODEX_HOME 解析后文件不存在 -> 判为悬空');
  // 关键承诺：检测本身绝不创建/修改任何东西（严格只读）
  const before1 = fs.readdirSync(DHOME).sort().join(',');
  L.danglingCatalogRef(t1); L.danglingCatalogRef(t2);
  ok(fs.readdirSync(DHOME).sort().join(',') === before1, '检测是只读的（目录内容不变：' + before1 + '）');
  ok(!fs.existsSync(dead), '检测不会"顺手"创建缺失的文件（绝不写 config 指向的路径）');
  // 影响分档（纯函数）：覆盖在位 = 只影响其它客户端（软）；覆盖不在位 = 用户的 Codex 每次新建对话都失败（硬）
  ok(L.danglingCatalogSeverity(null, null) === 'critical', '没有任何覆盖：判为 critical（用户的 Codex 会直接失败）');
  ok(L.danglingCatalogSeverity({ catalog: null }, { present: true }) === 'critical', '覆盖里没目录：critical');
  ok(L.danglingCatalogSeverity({ catalog: 'C:/x/m.json' }, { present: false }) === 'critical',
    '有目录覆盖但 net 补丁不在位：critical（注入函数没被装进镜像，-c 推不上去）');
  ok(L.danglingCatalogSeverity({ catalog: 'C:/x/m.json' }, { present: true }) === 'protected',
    '目录覆盖 + net 补丁都在位：protected（通过解锁版启动的 Codex 不受影响）');
  ok(L.danglingCatalogSeverity(undefined, undefined) === 'critical', 'undefined 输入不抛异常、判为 critical（保守）');
  // 源形状锁：runOnce 与 --self-test 都必须调用它（不然检测形同虚设），且仍然没有写 config.toml 的调用
  {
    const lsrc = fs.readFileSync(path.join(ROOT, 'codex-launcher.js'), 'utf8');
    const calls = (lsrc.match(/danglingCatalogRef\(/g) || []).length;
    ok(calls >= 3, 'launcher 里至少 3 处调用 danglingCatalogRef（定义 1 + runOnce 1 + selfTest 1，实际 ' + calls + '）');
    ok(/danglingCatalogSeverity\(NET_STATE\.overrides, NET_STATE\.patch\)/.test(lsrc),
      'runOnce 的分档基于"本次真实写出的覆盖 + 镜像补丁状态"（不是别的近似判断）');
    ok(/danglingCritical \|\| STATE\.catalogDanglingWarnedFor !== dk/.test(lsrc),
      '硬故障每次启动都提示（不被"已提示过"状态吞掉）');
    ok(!/writeFileSync\([^)]*CODEX_CONFIG|renameSync\([^)]*CODEX_CONFIG|copyFileSync\([^)]*CODEX_CONFIG/.test(lsrc),
      '仍然没有任何写 config.toml 的调用（v14 承诺：只读检测、绝不写回）');
  }
}

// ---------- 启动时序：tasklist 说了算时不等 PowerShell（第 3 轮审查发现） ----------
// 背景（自测：tasklist 412ms / PowerShell Get-Process 全量 1590ms / Promise.all 两者都等 1515ms）：
// 只有"tasklist 说有同名进程"时才需要 PowerShell 的路径过滤结论。旧写法 Promise.all 在两个都结束前
// 不返回，常见路径（没有同名进程）也要白等约 1.5s —— 控制台窗口跟着多挂约 2s（"第二次启动还是慢"）。
head('startOriginalProcessCheck 时序（tasklist 短路）');
{
  const lsrc = fs.readFileSync(path.join(ROOT, 'codex-launcher.js'), 'utf8');
  const fn = lsrc.slice(lsrc.indexOf('function startOriginalProcessCheck'), lsrc.indexOf('function hasSameNameProcess'));
  ok(fn.indexOf('await Promise.all([t.done, p.done])') < 0, '不再"两个子进程都等"（Promise.all 已移除）');
  ok(/const tl = await t\.done;/.test(fn), '先只等 tasklist');
  const iTl = fn.indexOf('const tl = await t.done;');
  const iShort = fn.indexOf('if (!hasSameNameProcess(tl.out, inst.mainExe)) { p.stop(); return []; }');
  ok(iShort >= 0, '短路行存在且形态完整（含 p.stop() 与 return []）');
  const iAwait = fn.indexOf('const ps = await p.done;');
  ok(iAwait > iShort, '短路在 await p.done 之前');
  // 更强的一条：从"拿到 tasklist 结论"到"短路判定"之间不允许出现任何 await p.done。
  // 只比"下一个 await p.done 在后面"会被这样的变异骗过：在短路前多加一行 await p.done
  // （原有那行还在后面 -> 下标比较照样成立，但等待其实已经发生，等于没修）。实测过这个盲点。
  ok(!/await p\.done/.test(fn.slice(iTl, iShort)), '拿 tasklist 结论到短路之间没有 await p.done（不等待 PowerShell 结果）');
  // 短路分支必须真的收尾：只 return 不 stop 的话，那个还挂着的 PowerShell 子进程（未退出、管道未关）
  // 会让 node 事件循环继续等它，bat 窗口照样多挂 1.5s —— 等于没改。
  // 窗口取到该行语句结束（"{ p.stop(); return []; }" 整段），不能用固定小长度截断（实测 40 字符截不到 stop）
  const shortEnd = fn.indexOf('}', iShort);
  const shortBlock = fn.slice(iShort, shortEnd + 1);
  ok(/p\.stop\(\)/.test(shortBlock), '短路分支调用了 p.stop()（kill + destroy + unref，否则窗口照样多挂）');
  // 流上的 error 监听：stop() 在子进程活着时 destroy 管道会触发 stream error，没监听就是未处理异常
  const sc = lsrc.slice(lsrc.indexOf('function spawnCapture'), lsrc.indexOf('function startOriginalProcessCheck'));
  ok(/child\.stdout\.on\('error'/.test(sc), 'spawnCapture 的 stdout 接了 error 监听（destroy 管道不会崩进程）');
}

// ---------- 收尾 ----------
for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) {}

console.log('\n' + (failures === 0 ? 'all passed' : failures + ' failed'));
process.exit(failures === 0 ? 0 : 1);
