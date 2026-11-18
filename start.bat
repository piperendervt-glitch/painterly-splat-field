@echo off
rem painterly-splat-field GUI launcher. Double-click to start. Close this window to stop.
setlocal
cd /d "%~dp0"
title painterly-splat-field

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js was not found. Install the LTS version from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo [setup] Installing packages ^(first time only^)...
  call npm install
  if errorlevel 1 goto :fail
)
if not exist "paint\node_modules\pngjs" (
  echo [setup] Installing packages for paint ^(first time only^)...
  pushd paint
  call npm install
  if errorlevel 1 ( popd & goto :fail )
  popd
)

if defined PSF_SCENE if not exist "painting\node_modules\onnxruntime-node" (
  echo [setup] Installing packages for depth estimation ^(first time only, used by "add a view" in painting scenes^)...
  pushd painting
  call npm install
  if errorlevel 1 echo [warning] Depth estimation packages could not be installed. The tool still starts; depth of newly painted areas stays approximate.
  popd
)

echo.
echo Starting the GUI. Your browser will open by itself.
echo Keep this window open while you use the tool. Close it ^(or press Ctrl+C^) to stop.
echo.
call npm run studio
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [error] Something went wrong. See the messages above.
pause
exit /b 1
