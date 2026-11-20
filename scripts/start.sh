#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node.js（需要 18+）"
  exit 1
fi

if curl -s -o /dev/null --max-time 2 http://127.0.0.1:7317/api/health; then
  echo "已在运行: http://127.0.0.1:7317"
  exit 0
fi

mkdir -p tmp
nohup node server.mjs >> tmp/server.log 2>&1 &
echo $! > tmp/server.pid
sleep 1
echo "已启动: http://127.0.0.1:7317 （PID $(cat tmp/server.pid)）"
