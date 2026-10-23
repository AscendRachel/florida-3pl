@echo off
cd /d "%~dp0"
:run
python server.py
if %errorlevel%==3 goto run
