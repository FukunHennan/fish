@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "CONTROLLER=%ROOT%\controller"
set "FRONTEND=%CONTROLLER%\frontend"
set "VISION=%ROOT%\vision"
set "RUNTIME=%CONTROLLER%\.runtime"
set "EXE=%RUNTIME%\fish-controller.exe"
set "BUILD_EXE=%RUNTIME%\fish-controller-next.exe"
set "CLOUDFLARED=%RUNTIME%\cloudflared.exe"
set "TUNNEL_CONFIG=%RUNTIME%\cloudflared-live.yml"
set "CONTROLLER_PID_FILE=%RUNTIME%\fish-controller.pid"
set "TUNNEL_PID_FILE=%RUNTIME%\cloudflared.pid"
set "CONTROLLER_OUT=%RUNTIME%\controller-live.out.log"
set "CONTROLLER_ERR=%RUNTIME%\controller-live.err.log"
set "TUNNEL_OUT=%RUNTIME%\cloudflared-live.out.log"
set "TUNNEL_ERR=%RUNTIME%\cloudflared-live.err.log"
set "BUILD_LOG=%RUNTIME%\build-last.log"
set "AUTH_DATA=%ROOT%\..\Pro1-runtime"
set "FISH_START_ROOT=%ROOT%"
set "FISH_START_CONTROLLER=%CONTROLLER%"
set "FISH_START_EXE=%EXE%"
set "FISH_START_BUILD_EXE=%BUILD_EXE%"
set "FISH_START_CLOUDFLARED=%CLOUDFLARED%"
set "FISH_START_TUNNEL_CONFIG=%TUNNEL_CONFIG%"
set "FISH_START_CONTROLLER_PID_FILE=%CONTROLLER_PID_FILE%"
set "FISH_START_TUNNEL_PID_FILE=%TUNNEL_PID_FILE%"
set "FISH_START_CONTROLLER_OUT=%CONTROLLER_OUT%"
set "FISH_START_CONTROLLER_ERR=%CONTROLLER_ERR%"
set "FISH_START_TUNNEL_OUT=%TUNNEL_OUT%"
set "FISH_START_TUNNEL_ERR=%TUNNEL_ERR%"
if not defined FISH_HOT_RELOAD set "FISH_HOT_RELOAD=true"
set "STARTED_CONTROLLER=0"
set "STARTED_TUNNEL=0"
set "EXIT_CODE=1"

set "ACCESS_MODE="
if /I "%~1"=="lan" set "ACCESS_MODE=lan"
if /I "%~1"=="public" set "ACCESS_MODE=public"
if defined ACCESS_MODE goto :access_selected
echo.
echo [1] LAN only - do not start Cloudflare Tunnel
echo [2] Public access - start Cloudflare Tunnel
choice /C 12 /N /M "Select access mode [1/2]: "
if errorlevel 2 (set "ACCESS_MODE=public") else (set "ACCESS_MODE=lan")
:access_selected
echo Access mode: !ACCESS_MODE!
set "FISH_ACCESS_MODE=!ACCESS_MODE!"
set "FISH_RECORDING_MAX_FPS=20"
if /I "!ACCESS_MODE!"=="lan" (
  set "FISH_CAPTURE_WIDTH=640"
  set "FISH_CAPTURE_HEIGHT=480"
  set "FISH_CAPTURE_FPS=30"
  set "FISH_WEBRTC_MAX_FPS=30"
  set "FISH_WEBRTC_STUN_URL="
  set "FISH_WEBRTC_TURN_URL="
  set "FISH_WEBRTC_TURN_USERNAME="
  set "FISH_WEBRTC_TURN_CREDENTIAL="
  set "FISH_WEBRTC_ICE_TRANSPORT_POLICY=all"
  set "FISH_WEBRTC_BROWSER_ICE_TRANSPORT_POLICY=all"
) else (
  set "FISH_WEBRTC_ICE_TRANSPORT_POLICY=all"
  set "FISH_WEBRTC_BROWSER_ICE_TRANSPORT_POLICY=all"
)

if not defined FISH_PYTHON if exist "%VISION%\.venv\Scripts\python.exe" set "FISH_PYTHON=%VISION%\.venv\Scripts\python.exe"
if not defined FISH_AUTH_USERS set "FISH_AUTH_USERS=%AUTH_DATA%\users.json"

if not exist "%CONTROLLER%\go.mod" goto :missing
if not exist "%FRONTEND%\package.json" goto :missing
if not exist "%VISION%\server.py" goto :missing
for %%C in (firmware.json program.json tunnel.json) do if not exist "%ROOT%\config\%%C" goto :missing

where go >nul 2>nul
if errorlevel 1 goto :missing_tools
where npm >nul 2>nul
if errorlevel 1 goto :missing_tools

if not exist "%RUNTIME%" mkdir "%RUNTIME%"
if not exist "%AUTH_DATA%" mkdir "%AUTH_DATA%"


echo [1/5] Building frontend while existing services remain running...
pushd "%FRONTEND%"
call npm run build >"%BUILD_LOG%" 2>&1
set "BUILD_RESULT=!errorlevel!"
popd
if not "!BUILD_RESULT!"=="0" goto :frontend_failed
if defined FISH_PYTHON (
  "%FISH_PYTHON%" -c "import cv2, numpy, av, aiortc, flask" >>"%BUILD_LOG%" 2>&1
  if errorlevel 1 goto :python_failed
)

echo [2/5] Building controller...
pushd "%CONTROLLER%"
call go build -trimpath -o "%BUILD_EXE%" ./cmd/fish-controller >>"%BUILD_LOG%" 2>&1
set "BUILD_RESULT=!errorlevel!"
popd
if not "!BUILD_RESULT!"=="0" goto :controller_build_failed

echo [3/5] Preparing Cloudflare Tunnel...
set "TUNNEL_MODE="
if /I "!ACCESS_MODE!"=="lan" (
  set "TUNNEL_MODE=disabled"
  goto :tunnel_prepared
)
for /f "usebackq delims=" %%T in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\runtime\prepare-tunnel.ps1" -Root "%ROOT%"`) do set "TUNNEL_MODE=%%T"
if errorlevel 1 goto :tunnel_config_failed
if not defined TUNNEL_MODE goto :tunnel_config_failed
if /I not "!TUNNEL_MODE!"=="enabled" if /I not "!TUNNEL_MODE!"=="disabled" goto :tunnel_config_failed
if /I "!TUNNEL_MODE!"=="enabled" if not exist "%CLOUDFLARED%" goto :cloudflared_missing
if /I "!ACCESS_MODE!"=="public" if /I not "!TUNNEL_MODE!"=="enabled" goto :tunnel_config_failed

:tunnel_prepared

echo [4/5] Stopping old Pro1 processes...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';$controller=[IO.Path]::GetFullPath($env:FISH_START_EXE);$cloudflared=[IO.Path]::GetFullPath($env:FISH_START_CLOUDFLARED);$vision=[IO.Path]::GetFullPath((Join-Path $env:FISH_START_ROOT 'vision\server.py'));foreach($p in @(Get-CimInstance Win32_Process)){ $path=[string]$p.ExecutablePath; $cmd=[string]$p.CommandLine; $kill=$false; if($path -and ([IO.Path]::GetFullPath($path) -in @($controller,$cloudflared))){$kill=$true}; if($p.Name -in @('python.exe','pythonw.exe') -and $cmd.IndexOf($vision,[StringComparison]::OrdinalIgnoreCase) -ge 0){$kill=$true}; if($kill){taskkill.exe /PID $p.ProcessId /T /F 2>$null|Out-Null} };Start-Sleep -Seconds 1;Remove-Item -LiteralPath $env:FISH_START_CONTROLLER_PID_FILE,$env:FISH_START_TUNNEL_PID_FILE -Force -ErrorAction SilentlyContinue"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8081,8091 -ErrorAction SilentlyContinue);if($listeners){$listeners|ForEach-Object{Write-Output ('Port '+$_.LocalPort+' is still owned by PID '+$_.OwningProcess)};exit 1};exit 0"
if errorlevel 1 goto :old_process_failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';Move-Item -LiteralPath $env:FISH_START_BUILD_EXE -Destination $env:FISH_START_EXE -Force"
if errorlevel 1 goto :controller_build_failed

echo [5/5] Starting controller and vision...
del /Q "%CONTROLLER_PID_FILE%" "%TUNNEL_PID_FILE%" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';$p=Start-Process -FilePath $env:FISH_START_EXE -WorkingDirectory $env:FISH_START_CONTROLLER -PassThru -WindowStyle Hidden -RedirectStandardOutput $env:FISH_START_CONTROLLER_OUT -RedirectStandardError $env:FISH_START_CONTROLLER_ERR;Set-Content -LiteralPath $env:FISH_START_CONTROLLER_PID_FILE -Value $p.Id -Encoding ascii"
if errorlevel 1 goto :controller_start_failed
set "STARTED_CONTROLLER=1"
set /p FISH_START_OWN_CONTROLLER_PID=<"%CONTROLLER_PID_FILE%"

set "READY="
for /L %%N in (1,1,60) do (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try{$c=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8081/healthz' -TimeoutSec 2;$v=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8091/health' -TimeoutSec 2;$j=$v.Content|ConvertFrom-Json;if($c.StatusCode -eq 200 -and $j.ok -eq $true){exit 0}}catch{};exit 1" >nul 2>&1
  if not errorlevel 1 set "READY=1"
  if defined READY goto :controller_ready
  timeout /t 1 /nobreak >nul
)
goto :ready_failed

:controller_ready
if /I "!TUNNEL_MODE!"=="enabled" (
  echo Starting Cloudflare Tunnel...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';$p=Start-Process -FilePath $env:FISH_START_CLOUDFLARED -ArgumentList @('--protocol','http2','--config',$env:FISH_START_TUNNEL_CONFIG,'tunnel','run') -WorkingDirectory $env:FISH_START_CONTROLLER -PassThru -WindowStyle Hidden -RedirectStandardOutput $env:FISH_START_TUNNEL_OUT -RedirectStandardError $env:FISH_START_TUNNEL_ERR;Set-Content -LiteralPath $env:FISH_START_TUNNEL_PID_FILE -Value $p.Id -Encoding ascii"
  if errorlevel 1 goto :tunnel_start_failed
  set "STARTED_TUNNEL=1"
  set /p FISH_START_OWN_TUNNEL_PID=<"%TUNNEL_PID_FILE%"
  set "TUNNEL_READY="
  for /L %%N in (1,1,30) do (
    powershell.exe -NoProfile -Command "if(-not (Get-Process -Id ([int]$env:FISH_START_OWN_TUNNEL_PID) -ErrorAction SilentlyContinue)){exit 2};if(Select-String -LiteralPath $env:FISH_START_TUNNEL_ERR -SimpleMatch 'Registered tunnel connection' -Quiet -ErrorAction SilentlyContinue){exit 0};exit 1" >nul 2>&1
    if errorlevel 2 goto :tunnel_start_failed
    if not errorlevel 1 set "TUNNEL_READY=1"
    if defined TUNNEL_READY goto :tunnel_ready
    timeout /t 1 /nobreak >nul
  )
  goto :tunnel_start_failed
)

:tunnel_ready
set "EXIT_CODE=0"
echo.
echo Pro1 started successfully.
echo Local URL: http://127.0.0.1:8081/competition.html
powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*'} | ForEach-Object {Write-Output ('LAN URL: http://'+$_.IPAddress+':8081/competition.html')}"
if /I "!ACCESS_MODE!"=="lan" echo LAN mode: direct WebRTC video, no STUN or TURN; Cloudflare Tunnel disabled.
if "!STARTED_TUNNEL!"=="1" echo Public tunnel process started.
echo Controller log: "%CONTROLLER_OUT%"
echo Controller error log: "%CONTROLLER_ERR%"
echo Vision log: "%CONTROLLER%\diagnostics\runs\SESSION\python-vision.txt"
echo Press Q to stop the services started by this script.

:monitor
if "!STARTED_CONTROLLER!"=="1" powershell.exe -NoProfile -Command "if(Get-Process -Id ([int]$env:FISH_START_OWN_CONTROLLER_PID) -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if errorlevel 1 goto :runtime_failed
if "!STARTED_TUNNEL!"=="1" powershell.exe -NoProfile -Command "if(Get-Process -Id ([int]$env:FISH_START_OWN_TUNNEL_PID) -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if errorlevel 1 goto :tunnel_start_failed
powershell.exe -NoProfile -Command "try{$response=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8091/health' -TimeoutSec 2;$body=$response.Content|ConvertFrom-Json;if($body.ok -eq $true){exit 0}}catch{};exit 1" >nul 2>&1
if errorlevel 1 echo [WARNING] Vision health check failed. Check the current python-vision.txt log.
choice /C QN /N /T 2 /D N >nul
if errorlevel 2 goto :monitor
goto :cleanup

:missing
echo [ERROR] Pro1 project files are incomplete.
goto :failure_pause
:missing_tools
echo [ERROR] Go or npm is not available in PATH.
goto :failure_pause
:python_failed
echo [ERROR] Python video dependencies are unavailable. Existing services have not been stopped. See "%BUILD_LOG%".
goto :failure_pause
:old_process_failed
echo [ERROR] An old Pro1 process or port is still active.
goto :failure_pause
:frontend_failed
echo [ERROR] Frontend build failed. See "%BUILD_LOG%".
goto :failure_pause
:controller_build_failed
echo [ERROR] Controller build failed. See "%BUILD_LOG%".
goto :failure_pause
:tunnel_config_failed
echo [ERROR] Tunnel configuration failed. Local services were not started.
goto :failure_pause
:cloudflared_missing
echo [ERROR] Missing "%CLOUDFLARED%".
goto :failure_pause
:controller_start_failed
echo [ERROR] Controller could not be started.
goto :failure_pause
:tunnel_start_failed
echo [ERROR] Cloudflare Tunnel did not become ready or stopped. See "%TUNNEL_ERR%".
goto :failure_pause
:ready_failed
echo [ERROR] Controller or vision service did not become healthy.
goto :failure_pause
:runtime_failed
echo [ERROR] Controller stopped unexpectedly. Check "%CONTROLLER_ERR%".
set "EXIT_CODE=1"
goto :cleanup
:failure_pause
set "EXIT_CODE=1"
echo.
echo Press any key to close this window.
pause >nul

:cleanup
if "!STARTED_TUNNEL!"=="1" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\runtime\stop-owned-process.ps1" -ProcessId "!FISH_START_OWN_TUNNEL_PID!" -Executable "%CLOUDFLARED%" -PidFile "%TUNNEL_PID_FILE%"
if "!STARTED_CONTROLLER!"=="1" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\runtime\stop-owned-process.ps1" -ProcessId "!FISH_START_OWN_CONTROLLER_PID!" -Executable "%EXE%" -PidFile "%CONTROLLER_PID_FILE%"
exit /b %EXIT_CODE%
