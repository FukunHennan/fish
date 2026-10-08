@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Please install Node.js with npm first.
  pause
  exit /b 1
)
node "%~dp0setup-windows.mjs" %*
if errorlevel 1 (
  echo [ERROR] Setup did not complete. Read the message above.
  pause
  exit /b 1
)
echo Setup completed.
pause
