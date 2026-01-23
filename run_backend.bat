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

REM Resolve config (env > .env > defaults) and export to child processes.
set "_ORCH_PORT=%ORCHESTRATOR_PORT%"
set "_TOOL_PORT=%TOOLSERVER_PORT%"
set "_DATA_DIR=%DATA_DIR%"

if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    set "K=%%A"
    set "V=%%B"
    if /I "!K!"=="ORCHESTRATOR_PORT" if "!_ORCH_PORT!"=="" set "_ORCH_PORT=!V!"
    if /I "!K!"=="TOOLSERVER_PORT" if "!_TOOL_PORT!"=="" set "_TOOL_PORT=!V!"
    if /I "!K!"=="DATA_DIR" if "!_DATA_DIR!"=="" set "_DATA_DIR=!V!"
  )
)

if "!_ORCH_PORT!"=="" set "_ORCH_PORT=6790"
if "!_TOOL_PORT!"=="" set "_TOOL_PORT=6791"
if "!_DATA_DIR!"=="" set "_DATA_DIR=data"

set "ORCHESTRATOR_PORT=!_ORCH_PORT!"
set "TOOLSERVER_PORT=!_TOOL_PORT!"
set "DATA_DIR=!_DATA_DIR!"

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
