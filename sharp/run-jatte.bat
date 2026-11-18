@echo off
rem Makes splats with SHARP from the La Grande Jatte painting (scenes\jatte\paint-out\J_painted.png).
rem Output: scenes\jatte\paint-out\J_sharp.ply. View it with start-jatte.bat, tab "splat space", placement "SHARP".
setlocal
cd /d "%~dp0"
title SHARP - La Grande Jatte
if not exist ".venv\Scripts\python.exe" (
  echo [error] Run setup.bat first.
  pause
  exit /b 1
)
.venv\Scripts\python.exe psf_sharp.py --scene jatte --view J %*
pause
