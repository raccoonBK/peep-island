#!/bin/bash
# 窥岛 · 一键启动（双击运行）
# 单进程：server 同时托管打包好的前端。key 从 server/.env 读取。
cd "$(dirname "$0")/server"
lsof -ti:3711 | xargs kill -9 2>/dev/null
( sleep 2 && open "http://localhost:3711" ) &
echo "🏝 窥岛启动中… 浏览器将自动打开 http://localhost:3711"
echo "   （关掉这个终端窗口 = 关掉游戏）"
NODE_USE_ENV_PROXY=1 exec node --env-file=.env index.js
