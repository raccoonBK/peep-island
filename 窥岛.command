#!/bin/bash
# 窥岛 · 一键启动（双击运行）
# 单进程：server 同时托管打包好的前端。key 从 server/.env 或界面 ⚙️ 里读取。
cd "$(dirname "$0")/server"

# 启动前先跑一遍回归自检：纯逻辑、不调 API、一秒跑完。
# 这一层出过两次悄无声息的回归（一次让三个角色 100% 静默且表面看不出原因），
# 所以坏了要在开门之前就知道，而不是玩了半天才发现角色不说话。
if ! node --env-file=.env 自检.mjs > /tmp/peep-selfcheck.log 2>&1; then
  echo "⚠️  自检未通过 —— 角色的行为可能已经坏了。详情："
  echo
  grep -A2 '✗' /tmp/peep-selfcheck.log | head -30
  echo
  echo "   仍然可以继续玩，但先看看上面那几条。按回车继续，Ctrl-C 退出。"
  read -r _
else
  echo "✓ 自检通过（$(grep -o '[0-9]* 通过' /tmp/peep-selfcheck.log | head -1)）"
fi

lsof -ti:3711 | xargs kill -9 2>/dev/null
( sleep 2 && open "http://localhost:3711" ) &
echo "🏝 窥岛启动中… 浏览器将自动打开 http://localhost:3711"
echo "   （关掉这个终端窗口 = 关掉游戏）"
NODE_USE_ENV_PROXY=1 exec node --env-file=.env index.js
