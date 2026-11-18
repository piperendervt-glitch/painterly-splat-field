@echo off
rem Makes splats with SHARP for the start.bat scene (previz-export\ and paint\out\), first view by default.
rem Another view: run.bat --view B
setlocal
cd /d "%~dp0"
title SHARP
if not exist ".venv\Scripts\python.exe" (
  echo [error] Run setup.bat first.
  pause
  exit /b 1
)
.venv\Scripts\python.exe psf_sharp.py %*
pause
