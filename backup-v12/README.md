# Codex 解锁启动器

自动跟随官方 Codex 桌面端最新版本，打补丁解锁思考强度（Max / Ultra）和速度档位（Fast / Ultrafast），生成独立镜像启动。

- **Windows**：微软商店版 Codex（`OpenAI.Codex`），入口 `启动Codex解锁版.bat`
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

1. 从微软商店安装 **OpenAI.Codex**
2. 安装 **Node.js**（推荐 v18 或更高）
3. 双击 `启动Codex解锁版.bat`

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
# Windows
node codex-launcher.js                 # 正常启动
node codex-launcher.js --no-launch     # 仅重建镜像，不启动应用
node codex-launcher.js --dry-run       # 完整走一遍构建与校验，但不替换镜像/不改配置/不启动
node codex-launcher.js --force         # 忽略"该版本重建失败"记录，强制重试

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
5. **完整性保护**：
   - 重新计算每个文件的 ASAR integrity（SHA256 + 4MiB blocks）
   - Windows：原位替换 `ChatGPT.exe` 内嵌的 header JSON 哈希
   - macOS：更新 `Info.plist` 的 `ElectronAsarIntegrity`，并 ad-hoc 重新签名（否则系统拒绝启动）
   - 补丁失配或语法错误会终止构建，保留现有可用镜像

## 安全说明

### 进程隔离
- `killApp()` 只终止路径含 `ChatGPT-Patched` 的进程
- 不会影响商店原版或其它项目（如并行的 codex-host）

### 回退方式
如需回退到商店原版：
1. 关闭镜像应用
2. 直接从开始菜单启动商店版 Codex
3. 或删除整个镜像目录：`C:\Users\86176\ChatGPT-Patched`

如需恢复上一个可用镜像版本：
```bash
cd "C:\Users\86176\ChatGPT-Patched"
rmdir /s /q app
ren app.old app
```

### 备份
- 每次更新会自动将旧镜像重命名为 `app.old`（macOS 为 `Codex.app.old`）
- 启动器脚本备份在：`F:\test\AI项目\codex修复\backup-v10\`

## 已知限制

1. **平台**：Windows 10/11 需要微软商店版 Codex；macOS 需要官方 `Codex.app`（Apple 芯片）
2. **版本兼容性**：
   - 当前补丁集（Windows `v12` / macOS `mac-v1`）在商店版本 `26.928.3736.0`、`26.930.2377.0` 上验证过
   - 未来大版本更新可能需要调整补丁定位逻辑
   - 补丁失配时会保留现有镜像并报错，不会应用半成品
3. **不是真正的插件**：这是"镜像 + 启动器"方案，不是注入原版的插件
4. **调试端口**：如果之前诊断时启动过带 `--remote-debugging-port=9222` 的实例，该端口会保持到用户正常退出应用，下次通过普通 bat 启动不会再开启调试端口
5. **macOS 版未在真机验证过的部分**：见 [README-macOS.md](README-macOS.md) 的"验证状态"一节（受限于开发环境，需要真机跑 `--doctor` 确认）

## 文件说明

- `codex-launcher.js`：Windows 启动器（平台层）
- `codex-launcher-mac.js`：macOS 启动器（平台层，含 `--doctor` 诊断）
- `lib/launcher-core.js`：**两个平台共用**的补丁定义、asar 读写/重打包、bundle 定位、语法校验
- `启动Codex解锁版.bat` / `启动Codex解锁版.command`：两个平台的用户入口
- `诊断报告.command`：macOS 只读诊断入口
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
- 检查是否已安装官方 Codex（Windows：商店版；macOS：`/Applications/Codex.app`）
- 检查 Node.js 是否可用：`node --version`
- macOS：先跑 `--doctor` 或双击"诊断报告.command"，把输出发出来
- 查看控制台错误信息

### 补丁未生效
- 可能是官方版本大幅更新，补丁定位失败
- 启动器会报告具体哪个补丁未命中
- 失败时会保留现有可用镜像，不会破坏
- 定位用：`node test/asar-diff.js "<app.asar 路径>"` 会打印每处补丁的命中情况与锚点上下文

### 更新卡住
- 如果镜像应用正在运行，启动器会跳过更新
- 请完全关闭应用后重新运行启动器

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
- macOS 版的真机行为（代码签名、Info.plist 校验值口径、ditto 拷贝）尚未在 Mac 上实测，
  详见 [README-macOS.md](README-macOS.md)

## 更新记录

### v13 (2026-10-02) · macOS 版
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
