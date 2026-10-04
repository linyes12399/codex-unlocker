# Codex 解锁启动器

> **一句话**：不改官方 Codex 一个字节，复制一份"解锁版"——多出 Max / Ultra 思考强度与 Fast / Ultrafast 速度档，并修复 cc-switch 路由场景下的 401 与 Ultrafast 失效。

## 项目简介

**项目作用**：微软商店版 / 官网安装版的 Codex 桌面应用，会按账号档位锁住思考强度和速度档。本启动器把电脑上已装的官方 Codex **复制成本地镜像**，在镜像内打补丁解锁之后启动：

- 思考强度 6 档：低 / 中 / 高 / 极高 / **Max / Ultra**
- 速度档 3 档：标准 / 快速 / **Ultrafast**（请求体真实携带 `service_tier: "ultrafast"`，中转站后台可识别）
- 修复 cc-switch 场景：关闭路由后 401 API_KEY_REQUIRED、路由模式下 Ultrafast 被丢弃

**项目优势**：

- **原版零修改**：补丁只作用于 `%USERPROFILE%\ChatGPT-Patched` 镜像；原版随时照常打开，删掉镜像即完全还原
- **不折腾配置**：不写 `~/.codex/config.toml`，cc-switch 随便切换供应商/路由，修复照样生效；日志绝不打印任何密钥
- **自动跟随官方更新**：官方更新后下一次启动自动重建镜像；补丁按内容匹配 + 多写法变体 + 分组部分解锁，已在 26.928 / 26.930 两代验证
- **开箱即用**：单文件 `Codex解锁版.exe`（内嵌 Node.js，无需安装）或 bat 版；首次运行自动创建桌面/开始菜单图标，第二次启动约 2 秒
- **可验证**：网络行为有端到端验收测试（真实 app-server + 本机回显服务器 + 假 key，见 `test/app-server-probe.js`），发行包与源码一致性有 64 项自动检查

## 下载安装包

到 **[Releases 最新版](https://github.com/linyes12399/codex-unlocker/releases/latest)** 下载：

| 文件 | 平台 | 说明 |
|---|---|---|
| `CodexUnlocker-v14.1.exe` | Windows | 单文件免安装，**无需 Node.js**，双击即用（推荐；即"Codex 解锁版"，下载后名字可随意改） |
| `CodexLauncher-win-v14.1.zip` | Windows | bat 版：解压后运行 `启动Codex解锁版.bat`（需要 Node.js） |
| `CodexLauncher-macOS-v14.1.dmg` | macOS | 磁盘映像：打开后把里面的目录拖到 Applications，双击 `启动Codex解锁版.command`（需要 Node.js） |
| `CodexLauncher-macOS-v14.1.zip` | macOS | zip 备用形态，内容与 dmg 相同 |

Windows exe 直链（始终指向最新版）：
`https://github.com/linyes12399/codex-unlocker/releases/latest/download/CodexUnlocker-v14.1.exe`

> - Windows exe 未做数字签名：首次运行如遇 SmartScreen 蓝色提示，点"更多信息 → 仍要运行"；杀毒软件提示时选"允许"。
> - macOS 的 dmg 由 GitHub Actions 的 macOS 机器自动制作（`hdiutil`），打开后把目录拖到 Applications 即可；zip 是备用形态。
> - 前提：电脑上要先装好官方 Codex（Windows：微软商店 OpenAI.Codex 或官网安装版；macOS：官方 Codex.app）。

**自动构建**：发行包由 [.github/workflows/release.yml](.github/workflows/release.yml) 在 GitHub Actions 上自动构建——推一个 `v*` 标签即自动打包三平台产物并发布 Release（Windows runner 出 exe/zip，macOS runner 出 dmg/zip）；也可以在 Actions 页面手动触发试构建（不发布）。

- **Windows**：微软商店版或官网 exe 安装版 Codex，入口 `启动Codex解锁版.bat`，细节见 `使用说明.txt`
- **macOS**：官方 `Codex.app`（Apple 芯片），入口 `启动Codex解锁版.command`，细节见 [README-macOS.md](README-macOS.md)

## 功能状态

✅ **已验证功能**：
- 思考强度 6 档全部可用：低 / 中 / 高 / 极高 / Max / Ultra
- 速度档位 3 档全部可用：标准 / 快速 / 超快
- Ultrafast 选中后 UI 保持选中，配置正确写入 `service_tier: "ultrafast"`
- **v14**：请求里真的带上了 `service_tier`
  （`test/app-server-probe.js` 用真实 `codex.exe` 的 app-server + 本机回显服务器实测：
  选 Ultrafast -> 请求体 `service_tier="ultrafast"`，选 Fast -> `"priority"`；
  直连与路由两种形态都验过）
- 自动跟随官方更新（检测 app.asar 指纹变化）

补丁集当前在**两代**官方版本上验证过：`26.928.3736.0` 与 `26.930.2377.0`（各 15 处补丁全部命中）；
另有独立的 net 补丁（主进程 app-server 参数，两代样本各命中 1 处）。

## 使用方法

### Windows

1. 安装官方 Codex：微软商店的 **OpenAI.Codex**，或官网下载的 `.exe` 安装版
   （装在自定义位置时可以用 `--app-dir` 指定一次，之后会记住）
2. 双击 `启动Codex解锁版.bat`
3. 首次运行会生成镜像（约 2 GB，一两分钟），并在桌面 + 开始菜单自动创建
   "Codex 解锁版"快捷方式；之后点图标启动即可，可以固定到任务栏
4. 想先确认这台机器能不能用：双击 `诊断报告.bat`（只读 `--self-test`）

> **解锁版会接管"模型目录来源"**（v14，副作用但无害）：它在 app-server 启动参数上加了
> `-c model_catalog_json=<镜像根>\model-catalog-merged.json`，而这份合并目录 =
> 镜像内置目录 + **你自己的目录**（`config.toml` 里 `model_catalog_json` 指向的文件、
> 以及 `~/.codex/cc-switch-model-catalog.json`）的超集。
> 两点用户该知道的：
> - 即使你用内置/本地供应商（`openai` / `ollama` / `lmstudio` / `amazon-bedrock`），
>   这条覆盖**也会生效**：模型集合不变（还是原来那些），只是给它补上了 Fast / Ultrafast 档
>   （注入函数的 catalog 段在 `lib/launcher-core.js:518-521`，先于 `:522` 起的 auth 段、
>   不受内置供应商白名单影响；实测镜像内置 11 个模型 -> 11 个都带上 ultrafast）
> - **你自己的自定义模型不会丢**：`config.toml` 的 `model_catalog_json` 指向的文件、
>   以及 cc-switch 的 `cc-switch-model-catalog.json` 里的第三方 slug 原样保留，
>   只是**不给它们补档位**（第三方模型带 `service_tier` 可能被中转站拒绝）。
>   实测：内置 11 个 + 本机 cc-switch 的 6 个（`glm-5.3` / `hy4` / `kimi-k3` 等）
>   = 合并后 17 个，6 个自定义 slug 一个不少、`service_tiers` 都为空
>
> 排查提示：合并目录里若有一项缺必填字段（如 `shell_type`），codex 会**拒绝整份目录**
> 并让配置加载失败（实测 `Error loading configuration: ... missing field ...`）——
> 请先修好你自己那份目录文件。这不是 v14 引入的：那份坏目录单独用（没装 v14）时同样会让
> codex 报错。

> Node.js 不再是必需项：入口脚本 `lib/find-node.cmd` 会先读解锁版上次缓存的
> `%USERPROFILE%\ChatGPT-Patched\node-path.txt`（v14，最快），再找 Codex 自带的 `node.exe`
> （商店版必带；官网版是否自带有待真机确认），然后退回应用自己下载的运行时、常见安装目录下的副本
> 和 PATH 上的 `node`（需要 v18 以上），都没有才提示 [E2]。查找过程不依赖 PowerShell（先走 reg.exe 读注册表）。

### 用 cc-switch 时（Windows，v14）

- **路由模式下选 Ultrafast**：解锁版会给请求带上 `service_tier`
  （Ultrafast -> `"ultrafast"`、Fast -> `"priority"`），这一点面向**第三方中转站**。
  中转站后台显不显示 ultrafast 由中转站/上游决定；若请求带了而后台仍显示 default，需要问中转站。
  注意副作用：若用的是"官方登录"（cc-switch 里的 ChatGPT 账号登录，而非第三方中转站），
  解锁版同样会补档位、档位会跟着请求发到官方地址；不想这样就在 cc-switch 里
  改用第三方供应商（官方登录场景直接用原版 Codex）。
  这一行为是有意的：模型目录（决定档位能不能发）与鉴权修复（决定 401）互相独立，
  官方登录时只跳过后者（`lib/launcher-core.js:506-509` 的 catalog 段先于
  `:510-536` 的 auth 段执行，auth 段在 `:517` 遇到 `a.tokens` 就提前返回），
  目录照写——已由 `test/net-override-test.js` 的断言锁死
- **关掉路由后报 401 API_KEY_REQUIRED**：解锁版在启动时自动改用 `auth.json` 里的 Key
  （前提是供应商没填 Key、`requires_openai_auth = false`、`auth.json` 里有非空 `OPENAI_API_KEY`
  且不是官方登录）。想根治：在 cc-switch 里把该供应商的 `requires_openai_auth` 改成 `true`，
  或直接给它填好 API Key
- **不写用户配置**：v14 只往镜像根目录 `%USERPROFILE%\ChatGPT-Patched\` 写自己的文件
  （`model-catalog-merged.json`、`codex-launcher-overrides.json`、`node-path.txt`、
  `launcher-state.json`、运行时的 `launcher.lock`），
  `~/.codex/config.toml` 与 cc-switch 的模型目录文件**只读不改**；
  覆盖文件里**不含任何 key/token**
- **确认修复是否生效**：双击 `诊断报告.bat`，应看到 `网络修复补丁: 镜像已包含 401/Ultrafast 修复补丁 (…)`、
  `合并目录（会写入的覆盖）: …，含 N 个带 Ultrafast 档的模型`（N 应大于 0）
  与一行 `诊断结果: <代码> - <说明>`（写明当前供应商的判断结果）；
  正常启动时窗口里对应的那行叫 `网络修复： …`
- 细节与"遇到问题怎么办"见 `使用说明.txt` 的"用 cc-switch 时：Ultrafast / 401 报错"一节

### macOS

1. 从官网安装 Codex 桌面版（`Codex.app` 放进"应用程序"）
2. 安装 **Node.js**（`brew install node`，或 https://nodejs.org 的 LTS 包）
3. 双击 `启动Codex解锁版.command`
4. 首次若被系统拦住：右键 → 打开；或终端里 `chmod +x *.command`
5. 想先确认环境能不能用，先双击 `诊断报告.command`（只看不改）

### 日常使用（两个平台一致）

- 直接双击对应入口启动
- 官方应用更新后，启动器会自动检测并重新构建镜像
- **如果镜像应用正在运行时检测到更新**，启动器会跳过更新并提示关闭后重新运行

### 命令行选项

```bash
# Windows（bat 与 node 直接跑等价："启动Codex解锁版.bat" 会把参数原样转给启动器）
node codex-launcher.js                 # 正常启动
node codex-launcher.js --no-launch     # 仅重建镜像，不启动应用
node codex-launcher.js --dry-run       # 完整走一遍构建与校验，但不替换镜像/不改配置/不启动
node codex-launcher.js --force         # 忽略"该版本重建失败"记录，强制重试
node codex-launcher.js --self-test     # 严格只读自检：环境、候选安装、补丁命中情况（退出码 0/1）
node codex-launcher.js --create-shortcut   # 只创建/刷新快捷方式后退出
node codex-launcher.js --no-shortcut       # 本次不碰快捷方式
node codex-launcher.js --app-dir=<目录>    # 手动指定 Codex 安装目录；--app-dir=（空）清除
# 模式优先级 --self-test > --create-shortcut > --dry-run；未列出的参数一律中文报错并退出 1（不会落入普通模式）
# --app-dir 的用法（实测）：bat 名不加引号或完整路径整体加引号时，--app-dir="D:\My Codex" 都可用；
# 只有把整行当单字符串交给 cmd（快捷方式式 cmd /d /c ""<bat>"" 参数）时，参数里再带引号才会报
# "文件名、目录名或卷标语法不正确"。绝不要不加引号地写含 & 的路径（会被 cmd 拆断并丢失后续参数，
# 可能误入普通模式）。想省心可用 set "CODEX_APP_DIR=D:\My Codex" 后启动 bat（不经命令行参数解析）。
# 显式指定的目录校验失败会中文报错并以退出码 1 退出（不会静默改用其它安装）；
# 状态里记住的 installOverride 失效时只提示一句、照常启动（用 --app-dir= 清除记录）

# macOS
node codex-launcher-mac.js             # 正常启动
node codex-launcher-mac.js --no-launch
node codex-launcher-mac.js --dry-run   # staging 里会留一份签好名的 Codex.app，可以先双击它试
node codex-launcher-mac.js --doctor    # 只做诊断并打印报告（排查问题的第一步）
node codex-launcher-mac.js --force
node codex-launcher-mac.js --app /path/to/Codex.app
```

## 工作原理

1. **非破坏性**：官方原版保持不动（Windows 在 `C:\Program Files\WindowsApps\`，macOS 在 `/Applications`）
2. **镜像机制**：Windows 在 `%USERPROFILE%\ChatGPT-Patched\app`、macOS 在 `~/Codex-Patched/Codex.app` 创建独立镜像
3. **智能更新**：
   - 检测官方版 `app.asar` 的 SHA256 指纹
   - 只在官方更新或补丁集版本变化时重建
   - 重建使用 staging 目录，全部验证通过才替换现有镜像（Windows 的 `--dry-run` 完全不碰镜像）
   - **应用运行中不强制更新**，避免影响使用
4. **补丁内容**：修改 webview 中 3 个 JavaScript bundle（15 处补丁），
   另外给主进程的 `.vite/build/application-network-startup-*.js` 打一处"net 补丁"（v14）：
   给 app-server 的启动参数追加两条 `-c` 覆盖（`model_catalog_json=` 指向解锁版自己的合并目录、
   `model_providers.<id>.requires_openai_auth=true`），前提条件在每次拉起 app-server 时重新检查，
   任何异常都只是少推一条参数——最坏情况等于没打这个补丁，绝不让 app-server 起不来
5. **版本兼容**：补丁条目支持**变体**（同一处改动在不同官方版本上的两种写法），
   旧版 `26.928.x` 样本与新版 `26.930.x` 样本都能 15/15 命中，不再"旧版完全解锁不了"
6. **部分解锁**：思考强度（effort）与速度档（speed）两组补丁互相独立；某一组整组对不上时
   只跳过那一组，其余照常解锁，并在日志、状态文件（`partialGroups`）与诊断报告里写明
7. **不回写用户配置**（v14）：模型目录写镜像根目录的 `model-catalog-merged.json`、
   设置写镜像根目录的 `codex-launcher-overrides.json`，**永不修改 `~/.codex/config.toml`**，
   也永不覆盖 cc-switch 自己的模型目录文件；cc-switch 切换供应商/路由后不会把这些抹掉
8. **安装发现缓存**（v14）：上次成功启动时记下安装来源 + 包集合 + exe 目录列表，
   下次启动先走快路径（reg.exe 一次 + 目录列表 + 读 asar 头），命中就跳过完整检测
   （PowerShell 发现脚本约 1.6~2s）；`reg.exe` 的包集合或 exe 的 `app-*` 目录一变就自动失效
9. **完整性保护**：
   - 重新计算每个文件的 ASAR integrity（SHA256 + 4MiB blocks）
   - Windows：原位替换 `ChatGPT.exe` 内嵌的 header JSON 哈希
   - macOS：更新 `Info.plist` 的 `ElectronAsarIntegrity`，并 ad-hoc 重新签名（否则系统拒绝启动）
   - 补丁失配或语法错误会终止构建，保留现有可用镜像
   - net 补丁失配**不阻断**构建：webview 解锁照常，日志与报告里写明 401/Ultrafast 修复不可用

## 安全说明

### 进程隔离
- `killApp()` 只终止路径含 `ChatGPT-Patched` 的进程
- 不会影响商店原版或其它项目（如并行的 codex-host）

### 回退方式
如需回退到原版：
1. 关闭镜像应用
2. 直接从开始菜单启动原版 Codex（商店版或官网版）
3. 或删除整个镜像目录：`%USERPROFILE%\ChatGPT-Patched`

如需恢复上一个可用镜像版本：
```bash
cd "%USERPROFILE%\ChatGPT-Patched"
rmdir /s /q app
ren app.old app
```

### 备份
- 每次更新会自动将旧镜像重命名为 `app.old`（macOS 为 `Codex.app.old`）
- 启动器脚本备份在：`F:\test\AI项目\codex修复\backup-v10\`

## 已知限制

1. **平台**：Windows 10/11 需要官方 Codex（微软商店版或官网 exe 安装版）；macOS 需要官方 `Codex.app`（Apple 芯片）
2. **版本兼容性**：
   - 当前补丁集（Windows `v14` / macOS `mac-v1`）在商店包 `26.928.3736.0`、`26.930.2377.0` 上验证过
     （对应 asar 版本 `26.928.21956`、`26.930.21537`，两边都是 15/15；旧版走补丁变体命中）
   - net 补丁（v14）在镜像 `26.930` 与旧版备份 `app.asar.backup-20261001` 上都命中 1 处；
     找不到这个形态的版本不会阻断重建，只是 401/Ultrafast 修复不可用（日志与报告里写明）
   - 未来大版本更新可能需要调整补丁定位逻辑
   - 补丁失配时的行为见上面的"部分解锁"：能解锁的先解锁，两组都不行才整体失败并保留现有镜像
3. **升级到 v14 的第一次启动会重建镜像**（补丁集版本变了），之后启动才走缓存快路径
4. **cc-switch 的已知边界（会话中途换供应商）**：解锁版在**启动那一刻**按当时的供应商把修复参数算好、
   之后固定不变（`-c` 覆盖在拉起 app-server 时生效，规格 §1.2/§10.4），而 codex 每开新会话重读 `config.toml`。
   于是中途换供应商会有两种现象，处理办法都是**完全退出解锁版后重新运行一次**（它会按新配置重算）：
   - 换成**另一个同样没填 Key** 的供应商：新开的对话会再报最初的 `401 API_KEY_REQUIRED`
     （鉴权覆盖是给上一个供应商写的）。启动器写入鉴权覆盖时会在窗口里打一行提示
     （同一个 `config.toml` 只打一次）：
     `提示: 如果在 cc-switch 里换成另一个同样没填 Key 的供应商，新开的对话可能再报 401 —— 重新运行一次解锁版即可（鉴权覆盖在启动时按当时的供应商生成）`
   - 换成"官方登录"、且 cc-switch 把 `[model_providers.<id>]` 表整个删掉：新开的对话可能报
     `provider name must not be empty`
   两者都是启动时定死参数的已知限制，不做修复
5. **不是真正的插件**：这是"镜像 + 启动器"方案，不是注入原版的插件
6. **调试端口**：如果之前诊断时启动过带 `--remote-debugging-port=9222` 的实例，该端口会保持到用户正常退出应用，下次通过普通 bat 启动不会再开启调试端口
7. **macOS 版未在真机验证过的部分**：见 [README-macOS.md](README-macOS.md) 的"验证状态"一节（受限于开发环境，需要真机跑 `--doctor` 确认）

## 文件说明

- `codex-launcher.js`：Windows 启动器（平台层）
- `codex-launcher-mac.js`：macOS 启动器（平台层，含 `--doctor` 诊断）
- `lib/launcher-core.js`：**两个平台共用**的补丁定义、asar 读写/重打包、bundle 定位、语法校验、
  net 补丁（`locateNetBundle` / `applyNetPatch` / `hasNetPatch` / `evalNetArgs`）
- `启动Codex解锁版.bat` / `启动Codex解锁版.command`：两个平台的用户入口
- `诊断报告.bat`：Windows 只读诊断入口（等价于 `--self-test`）
- `诊断报告.command`：macOS 只读诊断入口
- `lib/find-node.cmd`：Windows 入口共用的 Node 查找逻辑（缓存文件优先，注册表兜底，不依赖 PowerShell）；
  缓存那条候选前面有一道 `findstr` 白名单，字符集与启动器的 `NODE_PATH_SAFE_RE` 逐字符相同
  （实测两边都是 69 个字符 `[A-Za-z0-9 _.:\/-]`）——两边任一方要放宽，必须同时改，否则缓存会静默失效
- 注意：所有 `.bat` / `.cmd` 入口保持纯 ASCII + CRLF——cmd 会把多字节字符拆坏，中文提示一律由 Node 打印
- `test/patch-test.js`：离线回归（补丁命中 + 黄金样本逐字节比对 + asar 往返）
- `test/net-override-test.js`：net 覆盖的纯函数回归（TOML 判定 / 合并目录 / 覆盖文件 / diagnosis）
- `test/install-discovery-test.js`：安装发现与快路径缓存回归（用注入的 deps，不跑 PowerShell）
- `test/app-server-probe.js`：真实 codex.exe 的 app-server 网络验收（127.0.0.1 回显服务器 + 假 key）
- `test/find-node-test.js`：`lib/find-node.cmd` 的缓存/回落/注入回归（cmd 子进程 + 沙箱 USERPROFILE）；
  其中 (a2) 是一条**判别力自查**：缓存值用正斜杠写法，只有真读到缓存才会逐字返回该串
  （回落链路只会给出反斜杠路径）——挡住"缓存坏掉但断言恒真"的盲区
- `test/asar-diff.js`：诊断某个 asar 上哪几处补丁不命中
- `test/zip-check.py`：发行包校验（权限位/换行/语法，以及内容新鲜度断言：
  两个包都做"包内 = 仓库源码"——`lib/launcher-core.js` 是两个平台共用的，
  windows 包另外还做"`dist\<TOP>\` 下那份解压副本 = 包内"）
- `pack.py` / `pack-mac.py`：打包两个平台的发行 zip；`pack.py` 每次还会重建
  `dist\Codex解锁启动器\Codex解锁启动器\` 这份解压副本——用户的桌面/开始菜单快捷方式
  可能正指着它（解压到 dist 下再建的图标），不刷新就等于把旧代码留在用户手里
- `patched-bundles/`、`extracted-asar/`、`newstore-bundles/`：分析与回归用的 bundle 样本
- `backup-v10/`、`backup-v12/`、`backup-v13/`：历史启动器脚本备份

## 技术细节

### 补丁定位
启动器通过内容标记定位 bundle，不依赖文件名哈希：
- **app-initial**：包含 gate `536305374` 的最大 bundle
- **app-shared**：包含 `show-ultra-in-model-picker-slider`
- **app-primary**：包含 `FastModeToggle`

### 补丁内容（共 15 处）
1. Gate 536305374 永远开启（5 处）
2. 不从 enabled 列表剔除任意强度档
3. 自动降级调用改为空操作
4. 为每个模型目录条目补齐 `supportedReasoningEfforts` 和 `serviceTiers`（关键：修复 UI 回读）
5. 移除 includeUltra / enabled / U_e 三重过滤
6. 强制 includeUltraReasoningEffort = true
7. Fast 档位 isServiceTierAllowed 强制 true
8. 滑块解析器 options 补 max/ultra
9. 滑块解析器 versionOptions + internalOptions 补 max/ultra
10. serviceTiersByModelSlug 补齐 Fast/Ultrafast
11. 速度档菜单注入 Ultrafast 并保留 Fast 兜底
12. 强度滑块过滤放行 max/ultra
13. Fast 档位图标显示条件放宽
14. Fast 模型选择器显示条件放宽
15. 请求体强制带 `service_tier`（默认 `ultrafast`）


## 故障排除

### 启动失败
- 检查是否已安装官方 Codex（Windows：商店版或官网安装版；macOS：`/Applications/Codex.app`）
- Windows：双击 `诊断报告.bat`（只读自检），它会列出找到的候选安装、补丁命中数和镜像状态
- 检查 Node.js 是否可用：`node --version`（Windows 一般不用管：`lib/find-node.cmd` 会先找 Codex 自带的）
- macOS：先跑 `--doctor` 或双击"诊断报告.command"，把输出发出来
- 查看控制台错误信息

### 补丁未生效
- 可能是官方版本大幅更新，补丁定位失败
- 启动器会报告具体哪个补丁未命中；只有一组失配时会部分解锁，并在状态文件里记 `partialGroups`
- 两组都失配时会保留现有可用镜像，不会破坏
- 定位用：`node test/asar-diff.js "<app.asar 路径>"` 会打印每处补丁的命中情况与锚点上下文

### 更新卡住
- 如果镜像应用正在运行，启动器会跳过更新
- 请完全关闭应用后重新运行启动器

### Windows 特有
- 快捷方式没了或指向不对：`node codex-launcher.js --create-shortcut` 重建；
  用户删掉的不会自动加回（除非显式跑 `--create-shortcut`）
- 找不到安装：`node codex-launcher.js --app-dir=<目录>` 手动指定，成功后会记进状态文件
- 从压缩包里直接双击 bat：启动器会拒绝建快捷方式并提示先解压
  （`--create-shortcut` 同样会先做这项检查，请先完整解压）
- 退出码：`1` 失败（窗口停住显示中文提示）、`2` 需要用户看一眼的提示（同样停住）——
  `2` 如"重建失败"/"该版本此前重建失败"/"磁盘空间不足"/"Codex 正在运行，跳过更新"（镜像仍可用，
  只是这次没更新成）、原版在运行但解锁版已启动、单实例锁被占用；
  镜像本来就缺失且重建也没成功时改为回退打开原版（未解锁）并以 `1` 结束（附求助提示）

### macOS 特有
- 提示"已损坏，无法打开"：`xattr -dr com.apple.quarantine ~/Codex-Patched`，必要时再
  `codesign --force --deep --sign - ~/Codex-Patched/Codex.app`
- 想在不碰现有镜像的前提下先试一遍：`node codex-launcher-mac.js --dry-run`，
  它会留一份签好名的副本在 `~/Codex-Patched/.staging/Codex.app`，可以直接双击试

## 未确认的内容

以下内容**未被实际验证**，不应作为保证：
- TUN 代理是否影响之前的问题尚不确定
- 中转站是否真的按 `service_tier` 差异计费未验证
- Fast/Ultrafast 的 "1.5x/2x speed" 描述只是客户端显示文案
- 没有实际抓取到原生 HTTP 请求体，成功依据是用户在中转站后台确认
- Windows 官网 exe 安装版的目录结构没有真机样本（本机只有商店版），
  发现逻辑用"通用扫描 + 身份校验（asar 里 `name === 'openai-codex-electron'`）+ 手动 `--app-dir`"兜底；
  官网版是否自带 `cua_node\node.exe` 也未证实（找不到就用 PATH 上的 Node.js）
- 部分解锁只有静态证据：effort/speed 两组各自单独应用都通过 `node --check`，
  但没有在真实应用里跑过运行时验证（红线：不允许以普通模式运行真实启动器）
- macOS 版的真机行为（代码签名、Info.plist 校验值口径、ditto 拷贝）尚未在 Mac 上实测，
  详见 [README-macOS.md](README-macOS.md)

## 更新记录

### v14.1 (2026-10-04)

**新增：单文件 exe 版（Node SEA）**
- `node pack-exe.js` 生成 `dist/Codex解锁版.exe`（约 89MB）：官方 Single Executable Application
  方案，把 Node 运行时嵌进 exe（bundle = codex-launcher.js + lib/launcher-core.js 内联合成），
  用户机器不再需要装 Node.js，`find-node.cmd` 的候选链对 exe 用户整体不再走
- 启动器适配（`SEA_MODE` 检测 `require('node:sea').isSea()`）：
  快捷方式直接指向 exe（无参数、无 cmd 包装）；`tempDirBat` 在 exe 模式恒为 false
  （单文件自包含，不存在"压缩包里直接双击"问题）；`clearZoneIdentifiers` 顺带清理 exe 自身的
  Zone.Identifier；状态字段 `shortcutBat` 语义扩展为"入口路径"（bat 或 exe），bat/exe 二选一使用、
  图标跟随最后使用的入口；`ENTRY_PATH` 必须在 `win` 定义之后（const 暂时性死区）
- `argv`/`__dirname` 在 SEA 下与 `node 脚本.js` 形态一致（实测），参数处理零改动
- 测试配套：`net-override-test.js` 的真实镜像断言改为双状态（未打补丁 → 注入成功；
  已打补丁 → 拒绝二次注入），兼容"用户已用 v14 正常启动过"的机器
- 打包脚本：`pack-exe.js`（bundle → `--experimental-sea-config` → 复制 node.exe →
  postject 注入，postject 仅打包期经 npx 一次性拉取，产物与启动器运行时仍零 npm 依赖）；
  打包完自动跑只读冒烟（`--self-test`），zip/zip-check 不受影响（exe 不进 zip）

### v14 (2026-10-03)

**修复（用户报告的三个问题）**
- **cc-switch 路由模式下 Ultrafast 不生效**：v13 是往 `config.toml` 写一行 `model_catalog_json`，
  而 cc-switch 每次切换供应商/路由都会重写 `config.toml`，这行被抹掉就失效。
  v14 改成给主进程 bundle 打 net 补丁，在拉起 app-server 时追加
  `-c model_catalog_json=<镜像根/model-catalog-merged.json>`，
  参数由启动器每次启动时确定，cc-switch 怎么写 `config.toml` 都不影响。
  合并目录 = `codex debug models --bundled` 的内置目录 + 给内置 slug 补 `priority`/`ultrafast` +
  用户自定义目录（`cc-switch-model-catalog.json` 等，只读）里的第三方模型原样保留
- **关闭 cc-switch 路由后 401 API_KEY_REQUIRED**：用户的供应商是
  `requires_openai_auth = false` 且没有 bearer，请求里根本没有 Authorization 头。
  v14 在启动时读一次 `config.toml`/`auth.json`（只读），确认"有非空 `OPENAI_API_KEY`、
  无 `tokens`、表存在且没自带其它鉴权"后，追加
  `-c model_providers.<id>.requires_openai_auth=true`，让 codex 用 `auth.json` 里的 Key。
  会话中途关掉路由/切换供应商，新开对话也按新配置生效
- **第二次启动慢**：安装发现加缓存（快路径只跑一次 reg.exe + 目录列表 + 读 asar 头，
  跳过约 1.6~2s 的 PowerShell 发现脚本）；启动前后的进程检查改成异步
  （tasklist 并发发起、最多等 3 秒，超时就当"不知道"，不再让控制台多挂 1.5s）；
  快捷方式检查命中缓存时不再跑 PowerShell；`lib/find-node.cmd` 增加 `node-path.txt` 缓存候选
  （实测缓存命中约 0.21s，走 reg.exe 链路约 0.46~0.49s），并且不依赖 PowerShell 就能找 Node

**不写用户配置（重要变化）**
- v14 **不再修改 `~/.codex/config.toml`**，也不再写 `model_catalog_json`；
  v13 遗留的 `~/.codex/model-catalog-ultrafast.json` 不再使用（留着不影响）；
  **但别只删文件、不删 `config.toml` 里那行**：那一行还在、文件没了时，
  直接读这份配置的 Codex（含 VS Code 扩展）新建对话会报「系统找不到指定的文件」(os error 2)
  （实测 `login status` 退出码 1、`Error loading configuration: 系统找不到指定的文件。 (os error 2)`）。
  解锁版自己的目录覆盖在位时能盖住，其它客户端盖不住；启动器与 `--self-test` 都会就这种悬空行告警。
  清理时两样一起处理：先删 `config.toml` 那一行，再删文件（或都留着）
- 也不再覆盖 cc-switch 自己的模型目录文件：v13 的 `regenCatalog` 会把内置目录写到
  `config.toml` 指向的文件上，若那正是 `cc-switch-model-catalog.json` 就会把它覆盖掉；
  v14 只读它，输出固定写镜像根目录 `model-catalog-merged.json`
- 用户自己的 `requires_openai_auth = false` 一个字节都不会被改：修复只作用于解锁版镜像的启动参数，
  cc-switch 侧仍是原样；文档里给了"在 cc-switch 里把 `requires_openai_auth` 改成 `true`"的根治办法

**其它**
- net 补丁（主进程 bundle）：定位标记 `CODEX_APP_SERVER_OPENAI_BASE_URL`；
  失配不阻断重建，报告 `REPORT.net.patch.{located,applied,actual,rel}`、状态文件加 `netPatched`
- 机器可读报告新增 `REPORT.timing = { discovery, discoveryMs, preLaunchMs, totalMs }`
  （`discovery` 取值 `cache`/`full`/`manual`），普通模式最后一行打印
  `本次启动用时 X.Xs（安装检测：缓存/完整/手动）`
- `--self-test`（诊断报告.bat）新增网络诊断：镜像是否已含 401/Ultrafast 修复补丁、
  `model_provider`/`model`/`baseUrlHost`/`requires_openai_auth`/有无 bearer/有无 Key/有无 tokens、
  合并目录里有多少个带 Ultrafast 的模型（仍然严格只读，临时 `CODEX_HOME` 建在镜像根下并删除）
- 新增回归：`test/net-override-test.js`（纯函数）、`test/find-node-test.js`（find-node.cmd）、
  `test/app-server-probe.js`（真实 codex.exe 的 app-server + 127.0.0.1 回显服务器，
  端到端验证两个 bug）；`test/sandbox-e2e.js` 新增用例 D（沙箱普通模式两次启动，
  并在沙箱里让 `lib/find-node.cmd` 真去读启动器写下的 `node-path.txt`，
  即 §5.8 写缓存 ↔ §7.1 读缓存的联调也在门禁里）
- `lib/find-node.cmd` 的缓存候选有一道字符白名单（`findstr`，与启动器的
  `NODE_PATH_SAFE_RE` 同一字符集 `[A-Za-z0-9 _.:\/-]`）挡在前面，
  缓存文件只可能是自己写的那一行；不通过（含白名单外字节、空文件、指向的不是 node.exe）
  就照旧走 reg.exe 链路

### v13 (2026-10-02)

**Windows**
- 支持官网 exe 安装版：不再只认微软商店版；发现来源＝手动 `--app-dir`、商店版（Get-AppxPackage / reg.exe）、
  卸载注册表、开始菜单与桌面 `.lnk`、正在运行的进程、`%LOCALAPPDATA%\Programs` 等常见目录的文件系统扫描，
  统一做身份校验（asar 里 `name` 必须是 `openai-codex-electron`），选版本最高的候选
- 新增"Codex 解锁版"桌面 + 开始菜单快捷方式（目标 `cmd.exe`，绕开 .bat 的 SmartScreen 提示），
  可固定到任务栏；首次成功启动后自动创建，文件夹搬家后自动更新，用户删掉的不再加回
- 旧版本兼容：补丁条目支持**变体**，旧样本 `26.928.21956` 从 11/15 变成 15/15（此前旧版完全解锁不了）
- 启用**部分解锁**：一组失配只跳过该组，日志/状态（`partialGroups`）/诊断报告里说明未解锁的部分
- 新增 `诊断报告.bat`（只读 `--self-test`）与 `lib/find-node.cmd`
  （入口脚本不再内联 PowerShell 查找逻辑：注册表优先，PowerShell 被禁用也能找到 Node）
- 快捷方式的桌面/开始菜单目录发现有三条通道：PowerShell → Windows 脚本宿主（cscript）→
  常见位置推断（`USERPROFILE\Desktop`、OneDrive 的 `Desktop`/`桌面`、`%APPDATA%\...\Start Menu\Programs`，
  只挑真实存在的）。禁用 PowerShell 的机器通常仍能自动建图标；三条都不可用时才提示
  "无法获取桌面/开始菜单目录（PowerShell/脚本宿主都不可用，常见位置也不存在）"，可手动建快捷方式
- 入口脚本加固：`pushd` 支持网络路径、退出码原样透传（1/2 时窗口停住）、[E1]/[E2] 提示、
  说明文件缺失时不误开记事本；`.bat`/`.cmd` 保持纯 ASCII + CRLF
- 新增单实例锁 `launcher.lock`、磁盘空间检查、exe 安装版回退启动（直接 spawn 原版主程序）
- 状态文件新增 `installSource`/`installPath`/`appVersion`/`mainExe`/`fastKey`/`installOverride`/`partialGroups`
  （旧字段名保留）；`fastKey` 命中时跳过全量 sha256（省约 2.5 秒）
- 新增机器可读报告 `CODEX_LAUNCHER_REPORT=<文件>`（给 e2e 断言用，不写进使用说明）

**macOS**
- 新增 macOS 支持：`codex-launcher-mac.js` + `启动Codex解锁版.command` + `诊断报告.command`
- **代码重构**：补丁定义与 asar 读写逻辑抽到 `lib/launcher-core.js`，两个平台共用一份，
  避免补丁集分叉；Windows 端产物不变（`--dry-run` 实机验证 15 处补丁全中、重打包与 exe 哈希回填通过）
- 新增 `--dry-run`（两个平台）、`--doctor`（macOS）、`--selftest`
- 新增离线回归：`test/patch-test.js`（补丁命中 + 与已知可用产物逐字节比对 + asar 往返）、
  `test/asar-diff.js`、`test/zip-check.py`
- 子进程输出改为临时文件重定向，不再依赖管道 stdio（部分受限环境会 EPERM）
- 修正：重打包后覆盖 `app.asar` 前必须先关闭源文件句柄（Windows 上否则 EPERM）
- 文档修正：补丁数为 15 处（原写 14）

### v10 (2026-10-01)
- 修复 Ultrafast 选中后 UI 回读变 Standard 的问题（关键：补齐模型 serviceTiers）
- 改进启动器安全性：
  - 进程隔离：只终止镜像进程
  - Staging 构建：验证通过才替换
  - 补丁失配终止：不应用半成品
  - 应用运行中延后更新：不强制重启
  - 保留上一版本为 app.old
- 改进 bat 脚本：可移植路径定位 + 错误输出

---

**注意**：本工具修改 Codex 客户端行为，使用需自担风险。确保理解其工作原理，并遵守相关服务条款。
