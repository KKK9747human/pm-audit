#!/usr/bin/env sh
cd "$(dirname "$0")/.."

if [ -f tmp/server.pid ]; then
  PID=$(cat tmp/server.pid)
  if kill "$PID" 2>/dev/null; then
    echo "已停止 PID $PID"
  else
    echo "PID $PID 不在运行"
  fi
  rm -f tmp/server.pid
  exit 0
fi

PIDS=$(pgrep -f "node server.mjs" || true)
if [ -n "$PIDS" ]; then
  kill $PIDS
  echo "已停止: $PIDS"
else
  echo "服务没有在运行。"
fi
