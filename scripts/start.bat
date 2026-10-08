@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "CONTROLLER=%ROOT%\controller"
set "FRONTEND=%CONTROLLER%\frontend"
set "RUNTIME=%CONTROLLER%\.runtime"
set "EXE=%RUNTIME%\fish-controller.exe"
set "CLOUDFLARED=%RUNTIME%\cloudflared.exe"
set "TUNNEL_CONFIG=%RUNTIME%\cloudflared-live.yml"
set "TUNNEL_PID_FILE=%RUNTIME%\cloudflared.pid"
set "PREPARE_TUNNEL=%~dp0prepare-tunnel.ps1"
set "STARTUP_TASK=%~dp0install-startup-task.ps1"
set "TAKEOVER_SCRIPT=%~dp0takeover-running-instance.ps1"
set "WATCH_CONTROLLER=%~dp0watch-controller.ps1"

if not exist "%CONTROLLER%\go.mod" (
  echo [ERROR] controller\go.mod not found.
  pause
  exit /b 1
)

if not exist "%RUNTIME%" mkdir "%RUNTIME%"

if not exist "%TAKEOVER_SCRIPT%" (
  echo [ERROR] Startup takeover helper is missing: %TAKEOVER_SCRIPT%
  pause
  exit /b 1
)
if not exist "%WATCH_CONTROLLER%" (
  echo [ERROR] Hot reload helper is missing: %WATCH_CONTROLLER%
  pause
  exit /b 1
)

echo [INFO] Taking over any previous Fish instance...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TAKEOVER_SCRIPT%"
if errorlevel 1 (
  echo [ERROR] Could not stop the previous Fish instance safely.
  pause
  exit /b 1
)

for /f %%P in ('powershell.exe -NoProfile -Command "try { (Get-NetTCPConnection -State Listen -LocalPort 8081 -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess) } catch { }"') do set "EXISTING_CONTROLLER_PID=%%P"
if defined EXISTING_CONTROLLER_PID (
  echo [ERROR] Port 8081 is owned by unrelated process %EXISTING_CONTROLLER_PID%.
  echo The process was not stopped because it does not belong to this Fish workspace.
  pause
  exit /b 1
)

where go >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Go was not found in PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  pause
  exit /b 1
)

for %%C in (firmware.json program.json tunnel.json) do (
  if not exist "%ROOT%\config\%%C" (
    echo [ERROR] config\%%C is missing.
    goto :fail
  )
)

if not exist "%FRONTEND%\node_modules" (
  echo [1/4] Installing frontend dependencies...
  pushd "%FRONTEND%"
  call npm install
  if errorlevel 1 goto :fail
  popd
)

 echo [2/4] Building frontend...
pushd "%FRONTEND%"
call npm run build
if errorlevel 1 goto :fail
popd

echo [3/4] Building Go controller...
pushd "%CONTROLLER%"
go build -o "%EXE%" ./cmd/fish-controller
if errorlevel 1 goto :fail
popd

set "TUNNEL_MODE="
for /f "usebackq delims=" %%T in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PREPARE_TUNNEL%" -Root "%ROOT%"`) do set "TUNNEL_MODE=%%T"
if not defined TUNNEL_MODE goto :fail
if /I "%TUNNEL_MODE%"=="enabled" (
  if not exist "%CLOUDFLARED%" (
    echo [ERROR] cloudflared.exe is missing: %CLOUDFLARED%
    goto :fail
  )
  if not exist "%TUNNEL_CONFIG%" goto :fail
)

echo [4/4] Updating the FishStack logon task...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%STARTUP_TASK%"
if errorlevel 1 (
  echo [WARN] Could not update the FishStack logon task. Run this script from an elevated terminal once.
)

echo [5/5] Starting Fish Controller and configured tunnel...
echo Close this window to stop the services started from this window.
echo Open: http://localhost:8081
if /I "%TUNNEL_MODE%"=="enabled" (
  if exist "%TUNNEL_PID_FILE%" del /Q "%TUNNEL_PID_FILE%"
  powershell.exe -NoProfile -Command "$p = Start-Process -FilePath '%CLOUDFLARED%' -ArgumentList @('--config','%TUNNEL_CONFIG%','tunnel','run') -PassThru -WindowStyle Hidden -RedirectStandardOutput '%RUNTIME%\cloudflared.out.log' -RedirectStandardError '%RUNTIME%\cloudflared.err.log'; Set-Content -LiteralPath '%TUNNEL_PID_FILE%' -Value $p.Id"
  if exist "%TUNNEL_PID_FILE%" set /p TUNNEL_PID=<"%TUNNEL_PID_FILE%"
  if not defined TUNNEL_PID (
    echo [ERROR] Failed to start Cloudflare Tunnel.
    goto :fail
  )
)
pushd "%CONTROLLER%"
if not defined FISH_HOT_RELOAD set "FISH_HOT_RELOAD=true"
echo [INFO] Fish Controller hot reload supervisor is active.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WATCH_CONTROLLER%" -ControllerDir "%CONTROLLER%" -Executable "%EXE%"
set "EXIT_CODE=!errorlevel!"
popd
if defined TUNNEL_PID powershell.exe -NoProfile -Command "Stop-Process -Id %TUNNEL_PID% -Force -ErrorAction SilentlyContinue"
if exist "%TUNNEL_PID_FILE%" del /Q "%TUNNEL_PID_FILE%"
exit /b !EXIT_CODE!

:fail
popd >nul 2>nul
echo.
echo [ERROR] Startup failed.
pause
exit /b 1
