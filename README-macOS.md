# macOS 移植说明（Codex 解锁启动器）

本文件面向上手维护这个项目的人，记录 macOS 版是怎么落地的、哪些地方已验证、哪些地方还必须在真机上确认。

## 1. 结论先说

Windows 版的核心做法（**镜像 + 改 webview bundle + 重打包 app.asar + 回填 asar 校验值 + 启动副本**）
在 macOS 上完全成立，因为 macOS 的 Codex 桌面端**就是同一套 Electron 工程**：

| 证据 | 位置 |
| --- | --- |
| 同一份 `app.asar` 内含 macOS 专属逻辑 | `objc-js`、`NSHapticFeedbackManager`、`Library/Application Support/Codex` |
| macOS 专属更新器（Sparkle） | `.vite/build/build-flavor-*.js` → `shouldIncludeSparkle(..., 'darwin')` |
| macOS 专属授权路径 | 同文件 → `shouldIncludeBrowserUsePeerAuthorization(..., 'darwin')` |
| 打包配置里有公证依赖 | `package.json` → `@electron/notarize` |
| 官方只发 Apple 芯片版 | 官方下载页 / 社区讨论（Intel 需第三方重打包） |

所以**补丁本身不用改**，要改的是"外壳"：应用在哪、怎么拷、哈希在哪、改完怎么让系统还肯启动它。

## 2. 代码结构

```
codex-launcher.js         Windows 平台层（商店 MSIX / robocopy / exe 内嵌哈希 / junction）
codex-launcher-mac.js     macOS 平台层（Codex.app / ditto / Info.plist / 重签名）
lib/launcher-core.js      两边共用：15 处补丁定义、asar 读/写/重打包、bundle 定位、语法校验
test/patch-test.js        离线回归（补丁命中 + 黄金样本逐字节比对 + asar 往返）
test/asar-diff.js         诊断某个 asar 上"哪几处补丁不中"
test/golden-compare.js    溯源比对（可选）
pack.py / pack-mac.py     两个平台的发行 zip
```

新增补丁或调整锚点时**只改 `lib/launcher-core.js`**，两个平台同时生效；改完必须跑
`node test/patch-test.js`，它会断言补丁集能把商店原版 bundle 逐字节还原成"已知可用"的产物。

## 3. Windows → macOS 的逐项差异

| 关注点 | Windows | macOS |
| --- | --- | --- |
| 应用位置 | `%ProgramFiles%\WindowsApps\OpenAI.Codex_*\app` | `/Applications/Codex.app`（`Contents/`） |
| asar | `resources/app.asar` | `Contents/Resources/app.asar` |
| 版本号来源 | MSIX 目录名 | `Info.plist` 的 `CFBundleShortVersionString` + asar 内 `package.json` |
| 复制 | `robocopy /E` | `ditto`（保留符号链接/权限/扩展属性），先 `rm -rf` 目标 |
| asar 校验值位置 | `ChatGPT.exe` 内嵌 `[{"file":"resources\\app.asar",...}]` | `Contents/Info.plist` 的 `ElectronAsarIntegrity` |
| 校验值口径 | header JSON 的 SHA256 | 不预设：用"原版 asar + plist 旧值"反推口径再写回 |
| 改完是否需要签名 | 不需要 | **必须** ad-hoc 重新签名，否则系统拒绝启动 |
| 隔离属性 | 无 | 需要 `xattr -dr com.apple.quarantine` |
| 进程枚举 | PowerShell `Get-Process` | `ps -Ao pid=,command=` + 前缀匹配 |
| 结束进程 | `taskkill /F` | 先 `SIGTERM`，4 秒后 `SIGKILL` |
| 资源目录同步 | 目录 junction + 文件硬链接 | 目录符号链接（`'dir'`）+ 文件硬链接 |
| 启动 | `spawn(ChatGPT.exe)` | `spawn(Contents/MacOS/<CFBundleExecutable>)`，并做 3 秒存活检查 |
| 镜像目录 | `%USERPROFILE%\ChatGPT-Patched` | `~/Codex-Patched` |
| 命令行工具 | `resources/codex.exe debug models --bundled` | `Contents/Resources/codex debug models --bundled`（自动探测） |

## 4. macOS 上必须处理的三个坑

1. **代码签名失效**
   改了 `Contents/Resources/app.asar`，原签名里的资源封印（`_CodeSignature/CodeResources`）就对不上。
   Apple 芯片上签名是强制的，系统会直接杀掉进程（表现为"一闪就没"或"已损坏"）。
   处理：`codesign --force --sign - [--preserve-metadata=entitlements] Codex.app`，并**保留原 entitlements**
   （Electron 需要 JIT 相关权限）。`--preserve-metadata` 只保留 entitlements、不保留 hardened runtime flags，
   这是故意的：ad-hoc 签名 + hardened runtime 会触发 library validation，反而加载不了嵌套组件。
   重签后做 `codesign --verify --strict` 复核，失败会自动降级到更保守的签名方式（`--deep`）。

2. **asar 完整性校验值**
   Electron 在 macOS 上从 `Info.plist` 的 `ElectronAsarIntegrity` 读取 asar 的 SHA256。
   改完 asar 不同步这个值 → 启动即崩。风险在于"hash 到底对哪段字节取摘要"各版本实现有差异，
   所以启动器**不猜**：拿原版 asar 的 4 种候选口径（仅 JSON / payload / pickle / 整个 header）
   去和 plist 里记着的旧值比对，命中哪种就用哪种写回新值；一种都对不上时**宁可中止构建**并打印全部候选值，
   也不写一个不确定的哈希进去。没有 `ElectronAsarIntegrity` 键则说明该构建没开校验，跳过即可。

3. **Quarantine（隔离属性）**
   从网上下载的 zip 解压出来的东西都带 `com.apple.quarantine`。带隔离属性的、签名被改动的 app
   会被 Gatekeeper 拦下。启动器在拷贝后会 `xattr -dr com.apple.quarantine` 清掉。

## 5. 验证状态（诚实清单）

**已在 Windows 上离线验证（可重复执行）：**

- `node test/patch-test.js`：15 处补丁在**两代**商店 bundle 上全部命中（`26.928.3736.0` 的仓库样本、
  `26.930.2377.0` 的实机 dry-run），改写结果通过 `node --check`；
- **黄金样本**：用当前补丁集处理商店原版 bundle，逐字节等于此前已确认可用的 patched 产物
  （`app-initial-3916b423772b.js` / `app-shared-7552fc8d5d82.js` / `app-primary-7b889402e22e.js`）；
- **asar 往返**：对 541 MB 的真实 asar 做定位 → 打补丁 → 重打包 → 回读，条目数与 integrity 全部正确、
  未改动条目逐字节一致；
- **Windows 端到端**：`node codex-launcher.js --dry-run` 在实机上完整跑通
  （拷贝 → 打补丁 → 重打包 → `ChatGPT.exe` 哈希回填），且未触碰现有镜像；
- **asar 完整性哈希口径（关键假设，已实证）**：`node test/asar-hash-formula.js` 拿实机
  `ChatGPT.exe` 里由启动器写好的内嵌哈希，与同一个 asar 的 4 种候选口径对比，
  只有 **「对 header JSON 字节取 SHA256」** 命中。Electron 的完整性校验实现是跨平台共用的，
  macOS 侧 `ElectronAsarIntegrity.hash` 用的是同一套定义 —— 所以 mac 版候选表的首选口径已被独立佐证；
- `--selftest` 与两个平台的 `node --check`。

**独立代码审查（对抗式）已跑过一轮**，结论记录如下，便于后续维护者知道哪些已经查过：

- 逐个核对了 macOS 命令行工具的调用形态（`plutil -extract/-replace`、`codesign --verify/-d --entitlements/--force --sign`、
  `xattr -dr`、`ditto`、`ps`）参数顺序与输出解析，未发现错误；
- 用真实的 541 MB asar 验证了 header 候选口径的字节区间与"原版/新版索引复用"的正确性；
- 复核了 asar 重打包的 offset 对齐、integrity 结构，以及"未改动条目逐字节一致"；
- 确认任何代码路径都不会写 `/Applications/Codex.app` 本身（只有 staging 和镜像会被改）；
- 据此修掉的问题：进程匹配过宽（可能误杀无关进程）、`plutil` 条目按键名猜可能写错条目、
  重签名可能静默丢掉 entitlements 而 `--verify` 查不出、启动存活判定在 POSIX 上不可靠、
  `writeAsar` 在目标打不开时泄漏源句柄、错误信息被截断、`--app` 可指向镜像自身等。

**未验证（受限于手上没有 Mac，必须真机确认）：**

- `ditto` 拷贝后 `.app` 的签名/属性是否如预期（ditto 是 Apple 官方工具，风险低）；
- `Info.plist` 里实际写的是哪种键名/写法，以及 `plutil -extract` 能否按预期读到
  ——**用 `--doctor` 一次就能看出来**：它会打印 plist 原值、四种口径的实算值以及是否匹配；
- ad-hoc 重签后应用是否正常启动（重签名 + 3 秒存活检查会给出明确提示）；
- 官方 macOS 版的 `Contents/Resources/codex` 是否就是模型目录导出用的 CLI（找不到会跳过，只告警）。

因此给用户的第一个动作是：**双击"诊断报告.command"，把输出发回来**。报告里包含版本、签名状态、
asar 完整性口径判定、补丁命中数——足够判断问题出在哪一层。

## 6. 日常维护

Codex 更新导致补丁失配时：

```bash
node codex-launcher-mac.js --doctor          # 看哪几处 MISS
node test/asar-diff.js "/Applications/Codex.app/Contents/Resources/app.asar"   # 看锚点上下文
```

想复核"asar 完整性哈希口径"这个关键假设（需要一台跑过 Windows 版启动器的机器）：

```bash
node test/asar-hash-formula.js               # 默认读 %USERPROFILE%\ChatGPT-Patched
```

拿到新版 bundle 后调整 `lib/launcher-core.js` 里的锚点（正则尽量锚定函数名字面量与调用形态，
不要把压缩后的变量名写死），然后：

```bash
node test/patch-test.js                       # 断言 15 处仍命中 + 语法通过
node codex-launcher-mac.js --dry-run          # 真机完整走一遍，不动现有镜像
```

补丁集有实质变更时，把 `codex-launcher-mac.js` 里的 `PATCH_SET_VERSION`（当前 `mac-v1`）
和 Windows 版的对应常量一起加一，触发重新构建。

## 7. 待办与已知限制

- macOS 版目前不做 Intel（x86_64）重打包：官方只发 Apple 芯片版，用户装的是哪个就拷哪个；
  `--doctor` 会打印架构。
- 原版与解锁版共用 `~/Library/Application Support/Codex`（和 Windows 一致），
  好处是登录状态不用重来，代价是两者配置不分家。
- Codex 的单实例锁：原版开着时解锁版可能起不来。启动器会检测并提示，但不会替你杀原版。
