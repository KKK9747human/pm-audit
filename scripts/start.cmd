@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js，请先安装 Node 18 或更高版本。
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":7317 .*LISTENING" >nul
if not errorlevel 1 (
  echo 服务已经在运行：http://127.0.0.1:7317
  start "" http://127.0.0.1:7317
  exit /b 0
)

if not exist tmp mkdir tmp
start "pm-audit" /min cmd /c "node server.mjs >> tmp\server.log 2>&1"
ping -n 2 127.0.0.1 >nul
start "" http://127.0.0.1:7317
echo 服务已启动，浏览器已打开 http://127.0.0.1:7317
echo 关闭服务：scripts\stop.cmd
exit /b 0
