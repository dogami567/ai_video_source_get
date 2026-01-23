@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

REM Create .env if missing (edit keys if needed)
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [vidunpack] Created .env from .env.example
  )
)

REM Ensure cargo is discoverable for toolserver fallback
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

REM Defaults (allow override via env/.env)
if "%ORCHESTRATOR_PORT%"=="" set "ORCHESTRATOR_PORT=6790"
if "%TOOLSERVER_PORT%"=="" set "TOOLSERVER_PORT=6791"
if "%DATA_DIR%"=="" set "DATA_DIR=data"

REM Install deps if needed
if not exist "node_modules\" (
  echo [vidunpack] Installing npm dependencies...
  npm install
  if errorlevel 1 exit /b 1
)

echo [vidunpack] Starting backend (orchestrator=%ORCHESTRATOR_PORT% toolserver=%TOOLSERVER_PORT% data=%DATA_DIR%)
start "" "http://127.0.0.1:%ORCHESTRATOR_PORT%/api/health"

REM Run orchestrator + toolserver together
npx concurrently -n orchestrator,toolserver -c blue,magenta "npm -w @vidunpack/orchestrator run dev" "node scripts/run-toolserver.mjs"
