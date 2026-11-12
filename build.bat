@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1 || (echo [!] Can cai Node.js 18+ : https://nodejs.org & pause & exit /b 1)

echo [*] Cai dat thu vien...
call npm install || (pause & exit /b 1)

echo [*] Build dist\NetworkTracer.exe ...
call npm run build || (echo [!] Build that bai & pause & exit /b 1)

echo.
echo [OK] File exe: %~dp0dist\NetworkTracer.exe
pause
