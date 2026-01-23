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

REM Ensure cargo is discoverable for "npm run dev"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

REM Test-mode defaults (isolated data dir)
set "DATA_DIR=data\_selftest"
if "%WEB_PORT%"=="" set "WEB_PORT=6785"
if "%ORCHESTRATOR_PORT%"=="" set "ORCHESTRATOR_PORT=6790"
if "%TOOLSERVER_PORT%"=="" set "TOOLSERVER_PORT=6791"

REM Install deps if needed
if not exist "node_modules\" (
  echo [vidunpack] Installing npm dependencies...
  npm install
  if errorlevel 1 exit /b 1
)

echo [vidunpack] Starting dev (web=%WEB_PORT% orchestrator=%ORCHESTRATOR_PORT% toolserver=%TOOLSERVER_PORT% data=%DATA_DIR%)
start "" "http://127.0.0.1:%WEB_PORT%"
npm run dev

