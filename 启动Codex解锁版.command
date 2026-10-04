#!/bin/bash
# Codex 解锁启动器 · macOS 入口
# 这个文件必须是 LF 换行、并且有可执行权限（chmod +x）。中文提示由 codex-launcher-mac.js 打印。
set -u
cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  echo ""
  printf "按回车键关闭窗口... "
  read -r _ 2>/dev/null || true
  exit "${1:-1}"
}

if [ ! -f codex-launcher-mac.js ]; then
  echo "没有找到 codex-launcher-mac.js。"
  echo "请先把整个压缩包解压到某个目录，再从这个目录里运行它。"
  pause_and_exit 1
fi

NODE_BIN=""
for cand in \
  "$HOME/.local/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done

# Codex.app 里可能自带一份 node，有就优先用它，省得让用户额外装 Node
if [ -z "$NODE_BIN" ]; then
  for app in "/Applications/Codex.app" "/Applications/OpenAI Codex.app" "$HOME/Applications/Codex.app"; do
    for rel in "Contents/Resources/cua_node/bin/node" "Contents/Resources/node/bin/node"; do
      if [ -x "$app/$rel" ]; then NODE_BIN="$app/$rel"; break 2; fi
    done
  done
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "没有找到 Node.js —— 启动器本身需要 Node.js 才能跑。"
  echo ""
  echo "两种装法（任选一种）："
  echo "  1) 已经装了 Homebrew：  brew install node"
  echo "  2) 官网下载安装包：     https://nodejs.org   （LTS 版即可）"
  pause_and_exit 1
fi

echo "使用的 Node: $NODE_BIN"
"$NODE_BIN" codex-launcher-mac.js "$@"
code=$?
if [ "$code" -ne 0 ]; then
  pause_and_exit "$code"
fi
