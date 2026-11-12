@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1 || (echo [!] Can cai Node.js 18+ : https://nodejs.org & pause & exit /b 1)

if not exist "node_modules\playwright" (
    echo [*] Cai dat thu vien...
    call npm install || (pause & exit /b 1)
    call npx playwright install chromium
)

node src\server.js
pause
