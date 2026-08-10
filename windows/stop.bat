@echo off
title CMT Metrics Hub — Stop

echo  [*] Stopping CMT Metrics Hub (port 3001)...

for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    echo  [+] Killing PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

echo  [+] Done.
timeout /t 2 >nul
