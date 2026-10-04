#!/bin/bash
# Codex 解锁启动器 · macOS 诊断入口
# 只做检查、不改任何文件；把窗口里的输出整段发出来，就能判断这台机器能不能用解锁版。
set -u
cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  echo ""
  printf "按回车键关闭窗口... "
  read -r _ 2>/dev/null || true
  exit "${1:-0}"
}

NODE_BIN=""
for cand in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done
if [ -z "$NODE_BIN" ]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
if [ -z "$NODE_BIN" ]; then
  echo "没有找到 Node.js，无法生成诊断报告。"
  echo "装法：brew install node   或   https://nodejs.org"
  pause_and_exit 1
fi

"$NODE_BIN" codex-launcher-mac.js --doctor
pause_and_exit 0
