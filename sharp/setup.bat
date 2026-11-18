@echo off
rem SHARP (apple/ml-sharp) setup. Run once. Needs Python 3.10-3.13.
rem   1. creates a Python virtual environment in sharp\.venv
rem   2. installs PyTorch (CUDA build if an NVIDIA GPU is found, CPU build otherwise)
rem   3. installs ml-sharp (pinned commit)
rem   4. downloads the trained model (about 2.8 GB, from Apple) into sharp\models
rem The model is under the Apple Machine Learning Research Model License (research only, non-commercial).
setlocal
cd /d "%~dp0"
title SHARP setup
set ML_SHARP=https://github.com/apple/ml-sharp/archive/aed6527499ef91cba3b54c18d49a870f25947190.zip
set MODEL_URL=https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt

if exist ".venv\Scripts\python.exe" goto :venv_ok
set PY=
rem Prefer the py launcher with a supported version (newest first), then plain python.
for %%V in (3.13 3.12 3.11 3.10) do if not defined PY py -%%V -c "pass" >nul 2>nul && set PY=py -%%V
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY goto :nopython
echo [1/4] Creating the Python environment...
%PY% -m venv .venv
if errorlevel 1 goto :nopython
:venv_ok
set VPY=.venv\Scripts\python.exe
%VPY% -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)"
if errorlevel 1 goto :badpython
%VPY% -m pip install --upgrade pip >nul

echo [2/4] Installing PyTorch...
where nvidia-smi >nul 2>nul
if errorlevel 1 goto :cpu_torch
echo   NVIDIA GPU found: installing the CUDA build.
%VPY% -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto :fail
goto :torch_ok
:cpu_torch
echo   No NVIDIA GPU found: installing the CPU build (prediction will take a few minutes).
%VPY% -m pip install torch==2.8.0 torchvision==0.23.0
if errorlevel 1 goto :fail
:torch_ok

echo [3/4] Installing ml-sharp...
%VPY% -m pip install -r requirements.txt
if errorlevel 1 goto :fail
%VPY% -m pip install --no-deps "%ML_SHARP%"
if errorlevel 1 goto :fail

echo [4/4] Downloading the trained model (about 2.8 GB, first time only)...
if exist "models\sharp_2572gikvuh.pt" goto :model_ok
if not exist models mkdir models
curl.exe -L --fail -o "models\sharp_2572gikvuh.pt.part" "%MODEL_URL%"
if errorlevel 1 goto :fail
move /y "models\sharp_2572gikvuh.pt.part" "models\sharp_2572gikvuh.pt" >nul
:model_ok
%VPY% -c "import torch, sharp; print('Ready. torch', torch.__version__, '/ CUDA', torch.cuda.is_available())"
if errorlevel 1 goto :fail
echo Next, run run-jatte.bat (La Grande Jatte painting).
pause
exit /b 0

:nopython
echo [error] Python was not found. Install Python 3.12 or 3.13 from https://www.python.org/downloads/ and run this file again.
pause
exit /b 1
:badpython
echo [error] Wrong Python version (3.10-3.13 needed). Delete sharp\.venv, install a matching Python, and run this file again.
pause
exit /b 1
:fail
echo [error] Something went wrong. See the messages above.
pause
exit /b 1
