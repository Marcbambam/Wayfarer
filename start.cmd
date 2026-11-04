@echo off
rem Wayfarer Smart Home starten (Doppelklick).
cd /d "%~dp0"
title Wayfarer Smart Home

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js ist nicht installiert.
  echo  Bitte die LTS-Version von https://nodejs.org installieren und danach erneut starten.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

echo.
echo  Wayfarer Smart Home startet ...
echo  Das Dashboard oeffnet sich gleich im Browser: http://localhost:8080
echo  Dieses Fenster offen lassen. Beenden mit Strg+C oder Fenster schliessen.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8080"
node "%~dp0server.js"
echo.
echo  Die Zentrale wurde beendet.
pause
