@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

title VidUnpack Backend

REM Log file (helps when the window flashes and closes)
set "LOG_DIR=data\_logs"
set "LOG_FILE=%LOG_DIR%\run_backend.log"
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

REM Project-local tools: ffmpeg + yt-dlp (no system PATH changes)
set "TOOLS_FFMPEG_BIN=%~dp0tools\ffmpeg\bin"
set "TOOLS_YTDLP=%~dp0tools\yt-dlp\yt-dlp.exe"
set "_NEED_TOOLS="
if not exist "%TOOLS_FFMPEG_BIN%\ffmpeg.exe" (
  where ffmpeg >nul 2>nul
  if errorlevel 1 set "_NEED_TOOLS=1"
)
if not exist "%TOOLS_YTDLP%" (
  where yt-dlp >nul 2>nul
  if errorlevel 1 set "_NEED_TOOLS=1"
)
if defined _NEED_TOOLS (
  echo [vidunpack] Tools missing: ffmpeg/yt-dlp; installing project-local tools...
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup_tools.ps1"
  if errorlevel 1 goto :err
)
if exist "%TOOLS_FFMPEG_BIN%\ffmpeg.exe" (
  set "PATH=%TOOLS_FFMPEG_BIN%;%PATH%"
)
if exist "%TOOLS_YTDLP%" (
  set "YTDLP_PATH=%TOOLS_YTDLP%"
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

REM Ensure backend ports are free (best-effort)
node scripts/predev.mjs --backend
if errorlevel 1 goto :err

echo [vidunpack] Starting backend (orchestrator=%ORCHESTRATOR_PORT% toolserver=%TOOLSERVER_PORT% data=%DATA_DIR%)
echo [vidunpack] Orchestrator health: http://127.0.0.1:%ORCHESTRATOR_PORT%/api/health
echo [vidunpack] Toolserver health:   http://127.0.0.1:%TOOLSERVER_PORT%/health
echo [vidunpack] NOTE: This script starts backend only. For full app (web+backend), run: npm run dev
echo [vidunpack] Log: %LOG_FILE%

REM Run orchestrator + toolserver together
REM Use PowerShell Tee-Object to show logs AND write to file, preserving exit code.
powershell -NoProfile -Command "& { npx concurrently --kill-others-on-fail -n orchestrator,toolserver -c blue,magenta 'npm -w @vidunpack/orchestrator run dev:serve' 'node scripts/run-toolserver.mjs' 2>&1 | Tee-Object -FilePath '%LOG_FILE%' -Append; exit $LASTEXITCODE }"
if errorlevel 1 goto :err

exit /b 0

:err
echo.
echo [vidunpack] Backend failed to start. See logs above.
pause
exit /b 1
