@echo off
:: Called by install.bat via: cmd /k _install_run.bat
:: APP_DIR is inherited as an environment variable from install.bat.
:: The cmd /k parent keeps this window open no matter what happens here.

echo.
echo  ================================================================
echo   CMT Metrics Hub  - Windows Installer
echo  ================================================================
echo.
echo  [+] App root: %APP_DIR%
echo.

:: cd into APP_DIR so all checks use relative paths
cd /d "%APP_DIR%" 2>nul
if errorlevel 1 (
    echo  [!] ERROR: Could not navigate to app folder:
    echo      %APP_DIR%
    echo.
    echo      Make sure the folder exists and you have access to it.
    goto :eof
)

:: Verify package.json exists
if not exist "package.json" (
    echo  ================================================================
    echo   ERROR: package.json not found in:
    echo     %CD%
    echo  ================================================================
    echo.
    echo   1. You ran install.bat BEFORE fully extracting the zip.
    echo      FIX: Right-click the zip, Extract All to a folder,
    echo           then run install.bat again.
    echo.
    echo   2. You ran install.bat from INSIDE the zip preview.
    echo      FIX: Close the zip, extract it first, then run install.bat.
    echo.
    goto :eof
)

echo  [+] package.json found.
echo.

:: 1. Check for Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo  [!] Node.js is NOT installed.
    echo.
    echo      Please install Node.js 20 LTS from https://nodejs.org
    echo      then close this window and run install.bat again.
    echo.
    start https://nodejs.org/en/download
    goto :eof
)

for /f "tokens=*" %%i in ('node --version 2^>nul') do set NODE_VER=%%i
if "%NODE_VER%"=="" (
    echo  [!] Could not read Node.js version. Please re-install Node.js 20 LTS.
    goto :eof
)
echo  [+] Node.js found: %NODE_VER%

for /f "tokens=1 delims=." %%v in ("%NODE_VER:v=%") do set NODE_MAJOR=%%v
if "%NODE_MAJOR%"=="" (
    echo  [!] Could not parse Node.js version number.
    goto :eof
)

if %NODE_MAJOR% LSS 18 (
    echo  [!] Node.js 18+ required. You have %NODE_VER%.
    echo      Install Node.js 20 LTS from https://nodejs.org
    goto :eof
)

:: 2. npm install
echo.
echo  [*] Installing dependencies (this may take 2-5 minutes)...
echo.

call npm install --omit=dev
if errorlevel 1 (
    echo.
    echo  ================================================================
    echo   ERROR: npm install failed.
    echo  ================================================================
    echo.
    echo   Common causes:
    echo   1. No internet connection.
    echo   2. Missing C++ build tools for the SQLite native module.
    echo.
    echo   To fix #2, open a NEW Command Prompt as Administrator and run:
    echo     npm install --global windows-build-tools
    echo   Then close this window and run install.bat again.
    echo.
    goto :eof
)
echo  [+] Dependencies installed.

:: 3. Playwright Chromium (optional)
echo.
echo  [*] Playwright browser (~180 MB) is needed ONLY for automated
echo      IBM EngageSupport extraction. Skip if using manual XLSX upload.
echo.
choice /C YN /M "Install Playwright browser? (Y=Yes, N=Skip)"
if errorlevel 2 (
    echo  [-] Skipped. Use manual XLSX upload on the Ingest page.
    goto :after_playwright
)
call npx playwright install chromium --with-deps
if errorlevel 1 (
    echo  [!] Playwright install failed. Manual XLSX upload still works.
) else (
    echo  [+] Playwright Chromium installed.
)
:after_playwright

:: 4. Create .env if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo  [+] Created .env from template.
    ) else (
        echo PORT=3001> ".env"
        echo  [+] Created minimal .env
    )
) else (
    echo  [+] .env already exists.
)

:: 5. Ensure data directory exists
if not exist "data" mkdir "data"
echo  [+] Data directory ready.

:: 6. Verify dist built
if not exist "dist\index.js" (
    echo.
    echo  [!] dist\index.js not found. Contact the person who sent you this zip.
    echo.
    goto :eof
)
echo  [+] Application build verified.

:: 7. Done
echo.
echo  ================================================================
echo   Installation complete!
echo  ================================================================
echo.
echo   HOW TO USE:
echo     Start   : double-click  windows\start.bat
echo     Stop    : double-click  windows\stop.bat  (or Ctrl+C)
echo     Browser : http://localhost:3001
echo.
echo  ================================================================
echo.
choice /C YN /M "Start CMT Metrics Hub now?"
if errorlevel 2 goto :eof
call "windows\start.bat"
