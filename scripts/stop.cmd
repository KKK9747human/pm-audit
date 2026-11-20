@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

set PID=
if exist tmp\server.pid set /p PID=<tmp\server.pid

if defined PID (
  taskkill /PID %PID% /F >nul 2>&1
  if not errorlevel 1 echo 已停止服务，PID %PID%
  del tmp\server.pid >nul 2>&1
  exit /b 0
)

set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":7317 .*LISTENING"') do (
  set FOUND=%%p
  taskkill /PID %%p /F >nul 2>&1
  echo 已停止占用 7317 的进程 %%p
)

if not defined FOUND echo 服务没有在运行。
exit /b 0
