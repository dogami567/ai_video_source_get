@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

title VidUnpack Setup

REM Prefer UTF-8 output for clearer logs (best-effort).
chcp 65001 >nul 2>nul

echo [vidunpack] Setup: npm deps + project-local tools + Playwright browser
echo [vidunpack] This does NOT modify system PATH.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [vidunpack] ERROR: Node.js not found on PATH.
  echo [vidunpack] Install Node.js 20+ and retry.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [vidunpack] ERROR: npm.cmd not found on PATH.
  echo [vidunpack] Reinstall Node.js ^(npm is included^) and retry.
  pause
  exit /b 1
)

REM Keep Playwright browsers inside this repo for a portable setup.
if "%PLAYWRIGHT_BROWSERS_PATH%"=="" set "PLAYWRIGHT_BROWSERS_PATH=0"

echo [vidunpack] 1/3 Installing npm dependencies...
call npm.cmd install --production=false
if errorlevel 1 goto :err

echo.
echo [vidunpack] 2/3 Installing project-local tools (ffmpeg + yt-dlp)...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\\setup_tools.ps1"
if errorlevel 1 goto :err

echo.
echo [vidunpack] 3/3 Installing Playwright Chromium...
where npx.cmd >nul 2>nul
if errorlevel 1 (
  call npm.cmd exec playwright install chromium
) else (
  call npx.cmd playwright install chromium
)
if errorlevel 1 echo [vidunpack] WARN: playwright install failed; you can retry with: npx playwright install chromium

echo.
echo [vidunpack] Done.
echo [vidunpack] You can now run: run_test.bat
echo [vidunpack] E2E: run_e2e.bat
pause
exit /b 0

:err
echo.
echo [vidunpack] ❌ Setup failed.
pause
exit /b 1
