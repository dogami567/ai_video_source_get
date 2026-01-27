@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

title VidUnpack Dev

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

REM Test-mode defaults (isolated data dir)
if "%DATA_DIR%"=="" set "DATA_DIR=data\_selftest"
if "%WEB_PORT%"=="" set "WEB_PORT=6785"
if "%ORCHESTRATOR_PORT%"=="" set "ORCHESTRATOR_PORT=6790"
if "%TOOLSERVER_PORT%"=="" set "TOOLSERVER_PORT=6791"

REM Install deps if needed (dev tools required: tsx + concurrently)
set "_NEED_INSTALL="
if not exist "node_modules\" set "_NEED_INSTALL=1"
if not exist "node_modules\.bin\concurrently.cmd" if not exist "node_modules\.bin\concurrently" set "_NEED_INSTALL=1"
if not exist "node_modules\.bin\tsx.cmd" if not exist "node_modules\.bin\tsx" set "_NEED_INSTALL=1"

if defined _NEED_INSTALL (
  echo [vidunpack] Installing npm dependencies ^(including dev^)...
  call npm install --production=false
  if errorlevel 1 goto :err
)

echo [vidunpack] Starting dev (web=%WEB_PORT% orchestrator=%ORCHESTRATOR_PORT% toolserver=%TOOLSERVER_PORT% data=%DATA_DIR%)
echo [vidunpack] App URL: http://127.0.0.1:%WEB_PORT%/
echo [vidunpack] Tip: set AUTO_OPEN=1 to open browser automatically

REM Optional browser auto-open (off by default to avoid confusion when startup fails)
if "%AUTO_OPEN%"=="1" (
  start "" /B powershell -NoProfile -Command "for ($i=0; $i -lt 240; $i++){ try{ $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%WEB_PORT%/ -TimeoutSec 2; if($r.StatusCode -ge 200){ Start-Process http://127.0.0.1:%WEB_PORT%/; break } } catch {} Start-Sleep -Milliseconds 500 }"
)

call npm run dev
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo [vidunpack] Dev failed to start. See logs above.
pause
exit /b 1
