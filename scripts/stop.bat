@echo off
setlocal
chcp 65001 >nul

echo Stopping Fish Controller and child processes...
taskkill /IM fish-controller.exe /T /F >nul 2>nul
if errorlevel 1 (
  echo Fish Controller is not running.
  exit /b 0
)

echo Stopped.
exit /b 0
