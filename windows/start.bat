@echo off
setlocal
title CMT Metrics Hub

set "APP_DIR=%~dp0.."
pushd "%APP_DIR%"
set "APP_DIR=%CD%"
popd

:: Check dist exists
if not exist "%APP_DIR%\dist\index.js" (
    echo  [!] App is not built yet. Run install.bat first.
    pause
    exit /b 1
)

:: Kill any existing instance on port 3001
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    taskkill /PID %%p /F >nul 2>&1
)

echo.
echo  ================================================================
echo   CMT Metrics Hub  ^|  Starting...
echo  ================================================================
echo.
echo   Dashboard: http://localhost:3001
echo.
echo   Press Ctrl+C to stop the server.
echo.

cd /d "%APP_DIR%"
node dist\index.js
