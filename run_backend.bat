@echo off
REM Simple batch script to run Flask backend without path/quoting issues
cd /d "%~dp0"
call .venv\Scripts\activate.bat
set AIS_ENABLE_ML=1
set AIS_USE_ENSEMBLE=1
python backend/app.py
