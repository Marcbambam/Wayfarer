@echo off
rem Wayfarer Smart Home aktualisieren (Doppelklick). config.json und data bleiben erhalten.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
pause
