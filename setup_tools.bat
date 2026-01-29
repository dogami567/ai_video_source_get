@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

title VidUnpack Setup Tools

echo [vidunpack] Setting up project-local tools (ffmpeg + yt-dlp)...
echo [vidunpack] This does NOT modify system PATH.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\\setup_tools.ps1"
if errorlevel 1 goto :err

echo.
echo [vidunpack] Done.
echo [vidunpack] You can now run: run_test.bat
pause
exit /b 0

:err
echo.
echo [vidunpack] ❌ Setup failed.
pause
exit /b 1
