@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

title VidUnpack E2E

REM Log file (helps when the window flashes and closes)
set "LOG_DIR=data\_logs"
set "LOG_FILE=%LOG_DIR%\run_e2e.log"
if not exist "%LOG_DIR%\" mkdir "%LOG_DIR%" >nul 2>nul
echo ==== %DATE% %TIME% ==== > "%LOG_FILE%" 2>nul

REM Create .env if missing (edit keys if needed)
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [vidunpack] Created .env from .env.example
  )
)

REM Basic preflight
where node >nul 2>nul
if errorlevel 1 (
  echo [vidunpack] ERROR: Node.js not found on PATH.
  echo [vidunpack] Install Node.js 20+ and try again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [vidunpack] ERROR: npm not found on PATH.
  echo [vidunpack] Reinstall Node.js ^(npm is included^) and try again.
  pause
  exit /b 1
)

REM Ensure cargo is discoverable for toolserver fallback
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

REM E2E defaults (isolated data dir)
if "%DATA_DIR%"=="" set "DATA_DIR=data\_e2e_dev"
if "%WEB_PORT%"=="" set "WEB_PORT=6785"
if "%ORCHESTRATOR_PORT%"=="" set "ORCHESTRATOR_PORT=6790"
if "%TOOLSERVER_PORT%"=="" set "TOOLSERVER_PORT=6791"
if "%E2E_MOCK_CHAT%"=="" set "E2E_MOCK_CHAT=1"

REM Install deps if needed (playwright + dev tools required)
set "_NEED_INSTALL="
if not exist "node_modules\" set "_NEED_INSTALL=1"
if not exist "node_modules\.bin\playwright.cmd" if not exist "node_modules\.bin\playwright" set "_NEED_INSTALL=1"
if not exist "node_modules\.bin\concurrently.cmd" if not exist "node_modules\.bin\concurrently" set "_NEED_INSTALL=1"
if not exist "node_modules\.bin\tsx.cmd" if not exist "node_modules\.bin\tsx" set "_NEED_INSTALL=1"

if defined _NEED_INSTALL (
  echo [vidunpack] Installing npm dependencies ^(including dev^)...
  call npm install --production=false
  if errorlevel 1 goto :err
)

echo [vidunpack] Running Playwright E2E (dev config)
echo [vidunpack] WEB_PORT=%WEB_PORT% ORCHESTRATOR_PORT=%ORCHESTRATOR_PORT% TOOLSERVER_PORT=%TOOLSERVER_PORT% DATA_DIR=%DATA_DIR%
echo [vidunpack] Log: %LOG_FILE%
echo [vidunpack] Tip: if Playwright browser is missing, run: npx playwright install chromium

REM Use PowerShell Tee-Object to show logs AND write to file, preserving exit code.
powershell -NoProfile -Command "& { npm run test:e2e:dev 2>&1 | Tee-Object -FilePath '%LOG_FILE%' -Append; exit $LASTEXITCODE }"
if errorlevel 1 goto :err

echo.
echo [vidunpack] ✅ E2E PASSED
echo [vidunpack] Report: playwright-report\index.html
pause
exit /b 0

:err
echo.
echo [vidunpack] ❌ E2E FAILED. See logs above.
echo [vidunpack] Log: %LOG_FILE%
echo [vidunpack] Report: playwright-report\index.html
pause
exit /b 1
