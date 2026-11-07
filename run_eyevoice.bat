@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
echo ========================================================
echo   Starting EyeVoice Patient Communication Dashboard
echo   Web interface: http://localhost:5000
echo   Caregiver view: http://localhost:5000/caregiver
echo ========================================================
if exist "%ROOT%.venv\Scripts\python.exe" (
    "%ROOT%.venv\Scripts\python.exe" -m eyevoice.server %*
) else (
    py -3.11 -m eyevoice.server %*
)

