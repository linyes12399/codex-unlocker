# Codex 解锁启动器

自动跟随官方 Codex 桌面端最新版本，打补丁解锁思考强度（Max / Ultra）和速度档位（Fast / Ultrafast），生成独立镜像启动。

- **Windows**：微软商店版或官网 exe 安装版 Codex，入口 `启动Codex解锁版.bat`，细节见 `使用说明.txt`
- **macOS**：官方 `Codex.app`（Apple 芯片），入口 `启动Codex解锁版.command`，细节见 [README-macOS.md](README-macOS.md)

## 功能状态

✅ **已验证功能**（用户在中转站后台已确认生效）：
- 思考强度 6 档全部可用：低 / 中 / 高 / 极高 / Max / Ultra
- 速度档位 3 档全部可用：标准 / 快速 / 超快
- Ultrafast 选中后 UI 保持选中，配置正确写入 `service_tier: "ultrafast"`
- 自动跟随官方更新（检测 app.asar 指纹变化）

补丁集当前在**两代**官方版本上验证过：`26.928.3736.0` 与 `26.930.2377.0`（各 15 处补丁全部命中）。

## 使用方法

### Windows

1. 安装官方 Codex：微软商店的 **OpenAI.Codex**，或官网下载的 `.exe` 安装版
   （装在自定义位置时可以用 `--app-dir` 指定一次，之后会记住）
2. 双击 `启动Codex解锁版.bat`
3. 首次运行会生成镜像（约 2 GB，一两分钟），并在桌面 + 开始菜单自动创建
   "Codex 解锁版"快捷方式；之后点图标启动即可，可以固定到任务栏
4. 想先确认这台机器能不能用：双击 `诊断报告.bat`（只读 `--self-test`）

> Node.js 不再是必需项：入口脚本 `lib/find-node.cmd` 会先找 Codex 自带的 `node.exe`
> （商店版必带；官网版是否自带有待真机确认），再退回应用自己下载的运行时、常见安装目录下的副本
> 和 PATH 上的 `node`（需要 v18 以上），都没有才提示 [E2]。查找过程不依赖 PowerShell（先走 reg.exe 读注册表）。

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
4. **补丁内容**：修改 webview 中 3 个 JavaScript bundle（15 处补丁）
5. **版本兼容**：补丁条目支持**变体**（同一处改动在不同官方版本上的两种写法），
   旧版 `26.928.x` 样本与新版 `26.930.x` 样本都能 15/15 命中，不再"旧版完全解锁不了"
6. **部分解锁**：思考强度（effort）与速度档（speed）两组补丁互相独立；某一组整组对不上时
   只跳过那一组，其余照常解锁，并在日志、状态文件（`partialGroups`）与诊断报告里写明
7. **完整性保护**：
   - 重新计算每个文件的 ASAR integrity（SHA256 + 4MiB blocks）
   - Windows：原位替换 `ChatGPT.exe` 内嵌的 header JSON 哈希
   - macOS：更新 `Info.plist` 的 `ElectronAsarIntegrity`，并 ad-hoc 重新签名（否则系统拒绝启动）
   - 补丁失配或语法错误会终止构建，保留现有可用镜像

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
   - 当前补丁集（Windows `v13` / macOS `mac-v1`）在商店包 `26.928.3736.0`、`26.930.2377.0` 上验证过
     （对应 asar 版本 `26.928.21956`、`26.930.21537`，两边都是 15/15；旧版走补丁变体命中）
   - 未来大版本更新可能需要调整补丁定位逻辑
   - 补丁失配时的行为见上面的"部分解锁"：能解锁的先解锁，两组都不行才整体失败并保留现有镜像
3. **不是真正的插件**：这是"镜像 + 启动器"方案，不是注入原版的插件
4. **调试端口**：如果之前诊断时启动过带 `--remote-debugging-port=9222` 的实例，该端口会保持到用户正常退出应用，下次通过普通 bat 启动不会再开启调试端口
5. **macOS 版未在真机验证过的部分**：见 [README-macOS.md](README-macOS.md) 的"验证状态"一节（受限于开发环境，需要真机跑 `--doctor` 确认）

## 文件说明

- `codex-launcher.js`：Windows 启动器（平台层）
- `codex-launcher-mac.js`：macOS 启动器（平台层，含 `--doctor` 诊断）
- `lib/launcher-core.js`：**两个平台共用**的补丁定义、asar 读写/重打包、bundle 定位、语法校验
- `启动Codex解锁版.bat` / `启动Codex解锁版.command`：两个平台的用户入口
- `诊断报告.bat`：Windows 只读诊断入口（等价于 `--self-test`）
- `诊断报告.command`：macOS 只读诊断入口
- `lib/find-node.cmd`：Windows 入口共用的 Node 查找逻辑（注册表优先，不依赖 PowerShell）
- 注意：所有 `.bat` / `.cmd` 入口保持纯 ASCII + CRLF——cmd 会把多字节字符拆坏，中文提示一律由 Node 打印
- `test/patch-test.js`：离线回归（补丁命中 + 黄金样本逐字节比对 + asar 往返）
- `test/asar-diff.js`：诊断某个 asar 上哪几处补丁不命中
- `test/zip-check.py`：发行包校验（权限位/换行/语法）
- `pack.py` / `pack-mac.py`：打包两个平台的发行 zip
- `patched-bundles/`、`extracted-asar/`、`newstore-bundles/`：分析与回归用的 bundle 样本
- `backup-v10/`：v10 启动器脚本备份

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
