@echo off
title CMT Metrics Hub - Installer

:: Resolve paths from this script's own location
for %%i in ("%~f0\..")        do set "SCRIPT_DIR=%%~fi"
for %%i in ("%SCRIPT_DIR%\..") do set "APP_DIR=%%~fi"

:: Pass APP_DIR as an env var and run the real installer inside cmd /k
:: cmd /k keeps the window open no matter what happens inside
set "APP_DIR=%APP_DIR%"
cmd /k ""%SCRIPT_DIR%\_install_run.bat""
