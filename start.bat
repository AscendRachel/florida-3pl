@echo off
cd /d "%~dp0"
start "" http://localhost:8765
call serve.bat
pause
