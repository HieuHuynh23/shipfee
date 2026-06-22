@echo off
title ShipFee - Proxy Server

echo.
echo  ==========================================
echo       ShipFee - Start Server
echo  ==========================================
echo.

rem Update PATH for Node.js
set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm"

rem Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER% is ready
echo.

rem Go to server directory
cd /d "%~dp0server"

rem Install dependencies if not present
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm.cmd install
    echo.
)

rem Start proxy server
echo [START] Starting proxy server...
echo.

rem Wait 2 seconds and open browser
start "" /b cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:3001/app/index.html"

rem Run server
node server.js

pause
