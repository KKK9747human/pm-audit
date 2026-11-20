@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo 拉取 GitHub 数据并重算…
node bin\pmctl.mjs audit %* --fresh
echo.
pause
