@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
if exist "%ROOT%.venv\Scripts\python.exe" (
    "%ROOT%.venv\Scripts\python.exe" -m eyetype %*
) else (
    py -3.11 -m eyetype %*
)

