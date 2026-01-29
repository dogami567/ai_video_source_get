@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

title VidUnpack Dev

REM Prefer UTF-8 output for clearer logs (best-effort).
chcp 65001 >nul 2>nul

REM Log file (helps when the window flashes and closes)
set "LOG_DIR=data\_logs"
set "LOG_FILE=%LOG_DIR%\run_test.log"
if not exist "%LOG_DIR%\" mkdir "%LOG_DIR%" >nul 2>nul
type nul > "%LOG_FILE%" 2>nul

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

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [vidunpack] ERROR: npm.cmd not found on PATH.
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
if not exist "%TOOLS_FFMPEG_BIN%\ffmpeg.exe" (
  where ffmpeg >nul 2>nul
  if errorlevel 1 (
    echo [vidunpack] ERROR: ffmpeg not found.
    echo [vidunpack] Run setup_tools.bat to install project-local tools.
    pause
    exit /b 1
  )
)
if not exist "%TOOLS_YTDLP%" (
  where yt-dlp >nul 2>nul
  if errorlevel 1 (
    echo [vidunpack] ERROR: yt-dlp not found.
    echo [vidunpack] Run setup_tools.bat to install project-local tools.
    pause
    exit /b 1
  )
)
if exist "%TOOLS_FFMPEG_BIN%\ffmpeg.exe" set "PATH=%TOOLS_FFMPEG_BIN%;%PATH%"
if exist "%TOOLS_YTDLP%" set "YTDLP_PATH=%TOOLS_YTDLP%"

REM Test-mode defaults (isolated data dir)
if "%DATA_DIR%"=="" set "DATA_DIR=data\_selftest"
if "%WEB_PORT%"=="" set "WEB_PORT=6785"
if "%ORCHESTRATOR_PORT%"=="" set "ORCHESTRATOR_PORT=6790"
if "%TOOLSERVER_PORT%"=="" set "TOOLSERVER_PORT=6791"

REM Keep Playwright browsers inside this repo if installed via setup_tools.bat.
if "%PLAYWRIGHT_BROWSERS_PATH%"=="" set "PLAYWRIGHT_BROWSERS_PATH=0"

REM No auto-install here. If deps are missing, instruct user to run setup_tools.bat.
if not exist "node_modules\" (
  echo [vidunpack] ERROR: node_modules not found.
  echo [vidunpack] Run setup_tools.bat first.
  pause
  exit /b 1
)

echo [vidunpack] Starting dev (web=%WEB_PORT% orchestrator=%ORCHESTRATOR_PORT% toolserver=%TOOLSERVER_PORT% data=%DATA_DIR%)
echo [vidunpack] App URL: http://127.0.0.1:%WEB_PORT%/
echo [vidunpack] Log: %LOG_FILE%

REM Use PowerShell Tee-Object to show logs AND write to file, preserving exit code.
REM Run npm.cmd to avoid PowerShell script-policy issues with npm.ps1 on some machines.
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { cmd /c \"npm.cmd run dev\" 2>&1 | Tee-Object -FilePath '%LOG_FILE%' -Append; exit $LASTEXITCODE }"
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo [vidunpack] Dev failed to start. See logs above.
pause
exit /b 1
