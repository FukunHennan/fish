@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "CONTROLLER=%ROOT%\controller"
set "FRONTEND=%CONTROLLER%\frontend"
set "RUNTIME=%CONTROLLER%\.runtime"
set "AUTH_DATA=%ROOT%\..\Pro1-runtime"
set "EXE=%RUNTIME%\fish-controller.exe"
set "CLOUDFLARED=%RUNTIME%\cloudflared.exe"
set "TUNNEL_CONFIG=%RUNTIME%\cloudflared-live.yml"
set "CONTROLLER_PID_FILE=%RUNTIME%\fish-controller.pid"
set "TUNNEL_PID_FILE=%RUNTIME%\cloudflared.pid"
set "CONTROLLER_OUT=%RUNTIME%\controller-live.out.log"
set "CONTROLLER_ERR=%RUNTIME%\controller-live.err.log"
set "TUNNEL_OUT=%RUNTIME%\cloudflared-live.out.log"
set "TUNNEL_ERR=%RUNTIME%\cloudflared-live.err.log"

set "FISH_START_ROOT=%ROOT%"
set "FISH_START_CONTROLLER=%CONTROLLER%"
set "FISH_START_EXE=%EXE%"
set "FISH_START_CLOUDFLARED=%CLOUDFLARED%"
set "FISH_START_TUNNEL_CONFIG=%TUNNEL_CONFIG%"
set "FISH_START_CONTROLLER_PID_FILE=%CONTROLLER_PID_FILE%"
set "FISH_START_TUNNEL_PID_FILE=%TUNNEL_PID_FILE%"
set "FISH_START_CONTROLLER_OUT=%CONTROLLER_OUT%"
set "FISH_START_CONTROLLER_ERR=%CONTROLLER_ERR%"
set "FISH_START_TUNNEL_OUT=%TUNNEL_OUT%"
set "FISH_START_TUNNEL_ERR=%TUNNEL_ERR%"
set "FISH_HOT_RELOAD=false"

if not defined FISH_PYTHON if exist "%ROOT%\vision\.venv\Scripts\python.exe" set "FISH_PYTHON=%ROOT%\vision\.venv\Scripts\python.exe"
if not exist "%CONTROLLER%\go.mod" goto :missing_project_file
if not exist "%FRONTEND%\package.json" goto :missing_project_file
if not exist "%ROOT%\vision\server.py" goto :missing_project_file
for %%C in (firmware.json program.json tunnel.json) do if not exist "%ROOT%\config\%%C" goto :missing_project_file

where go >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Go was not found in PATH.
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  exit /b 1
)

if not exist "%RUNTIME%" mkdir "%RUNTIME%"
if not exist "%AUTH_DATA%" mkdir "%AUTH_DATA%"
if not defined FISH_AUTH_USERS if not exist "%AUTH_DATA%\users.json" (
  if exist "%RUNTIME%\users.json" (
    echo [INFO] Migrating the existing project account store...
    for %%F in (users.json.sessions.json users.json.reservations.json users.json) do if exist "%RUNTIME%\%%F" copy /Y "%RUNTIME%\%%F" "%AUTH_DATA%\%%F" >nul
  ) else if exist "%APPDATA%\fish-controller\users.json" (
    echo [INFO] Migrating the existing user account store...
    for %%F in (users.json.sessions.json users.json.reservations.json users.json) do if exist "%APPDATA%\fish-controller\%%F" copy /Y "%APPDATA%\fish-controller\%%F" "%AUTH_DATA%\%%F" >nul
  )
)
if not defined FISH_AUTH_USERS set "FISH_AUTH_USERS=%AUTH_DATA%\users.json"

echo [1/5] Stopping previous Fish processes...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';$root=[IO.Path]::GetFullPath($env:FISH_START_ROOT);$runtime=Join-Path $root 'controller\.runtime';$paths=@((Join-Path $runtime 'fish-controller.exe'),(Join-Path $runtime 'fish-controller.next.exe'),(Join-Path $runtime 'fish-controller.previous.exe'),(Join-Path $runtime 'fish-controller-recovery.exe'),(Join-Path $runtime 'cloudflared.exe'));$launcher=[IO.Path]::GetFullPath((Join-Path $root 'scripts\start.bat'));$watcher='watch-controller.ps1';$vision=[IO.Path]::GetFullPath((Join-Path $root 'vision\server.py'));$currentCmd=(Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f ((Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $PID)).ParentProcessId))).ProcessId;$items=@(Get-CimInstance Win32_Process);foreach($p in $items){$cmd=[string]$p.CommandLine;if($p.ProcessId -ne $currentCmd -and $p.Name -eq 'cmd.exe' -and $cmd.IndexOf($launcher,[StringComparison]::OrdinalIgnoreCase)-ge 0){taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null};if($p.ProcessId -ne $PID -and $p.Name -in @('powershell.exe','pwsh.exe') -and $cmd.IndexOf($watcher,[StringComparison]::OrdinalIgnoreCase)-ge 0){taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null};if($p.Name -in @('python.exe','pythonw.exe') -and $cmd.IndexOf($vision,[StringComparison]::OrdinalIgnoreCase)-ge 0){taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null}};$visionListeners=@(Get-NetTCPConnection -State Listen -LocalPort 8091 -ErrorAction SilentlyContinue);foreach($listener in $visionListeners){$owner=Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $listener.OwningProcess);if($owner -and $owner.Name -in @('python.exe','pythonw.exe') -and ([string]$owner.CommandLine -match '(?i)server\.py')){taskkill.exe /PID $owner.ProcessId /T /F 2>$null | Out-Null}};$items=@(Get-CimInstance Win32_Process);foreach($p in $items){if($p.ExecutablePath){try{$path=[IO.Path]::GetFullPath($p.ExecutablePath)}catch{$path=''};if($paths -contains $path){taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null}}};Start-Sleep -Milliseconds 500;$deadline=[DateTime]::UtcNow.AddSeconds(10);do{$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in 8081,8091});if(-not $listeners){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $deadline);if($listeners){$listeners|ForEach-Object{Write-Host ('port '+$_.LocalPort+' still owned by PID '+$_.OwningProcess)};exit 1};Remove-Item -LiteralPath (Join-Path $runtime 'cloudflared.pid') -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath (Join-Path $runtime 'fish-controller.pid') -Force -ErrorAction SilentlyContinue;exit 0"
if errorlevel 1 goto :startup_failed

if not exist "%FRONTEND%\node_modules" (
  echo [2/5] Installing frontend dependencies...
  pushd "%FRONTEND%" >nul
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    popd >nul
    goto :startup_failed
  )
  popd >nul
)

echo [2/5] Building frontend...
pushd "%FRONTEND%" >nul
call npm run build
if errorlevel 1 (
  popd >nul
  goto :startup_failed
)
popd >nul

echo [3/5] Building Go controller...
pushd "%CONTROLLER%" >nul
go build -trimpath -o "%EXE%" ./cmd/fish-controller
if errorlevel 1 (
  popd >nul
  goto :startup_failed
)
popd >nul

set "TUNNEL_MODE="
for /f "usebackq delims=" %%T in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';$root=$env:FISH_START_ROOT;$source=Join-Path $root 'config\tunnel.json';$runtime=Join-Path $root 'controller\.runtime';$config=Get-Content -LiteralPath $source -Raw | ConvertFrom-Json;if($config.enabled -isnot [bool]){throw 'tunnel.json enabled must be a boolean.'};if($config.enabled -ne $true){'disabled';exit 0};$uuid=[string]$config.tunnelId;if($uuid -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'){throw 'tunnel.json tunnelId is invalid.'};if([string]::IsNullOrWhiteSpace([string]$config.credentialsFile)-or[string]::IsNullOrWhiteSpace([string]$config.hostname)-or[string]::IsNullOrWhiteSpace([string]$config.service)){throw 'tunnel.json is missing required fields.'};$credentials=[string]$config.credentialsFile;if(-not[IO.Path]::IsPathRooted($credentials)){$credentials=Join-Path $root $credentials};if(-not(Test-Path -LiteralPath $credentials -PathType Leaf)){throw ('Cloudflare credentials file not found: '+$credentials)};New-Item -ItemType Directory -Path $runtime -Force | Out-Null;$quote={param([string]$value) ConvertTo-Json -InputObject $value -Compress};$yaml=@(('tunnel: '+(& $quote $uuid)),('credentials-file: '+(& $quote $credentials)),'ingress:',('  - hostname: '+(& $quote ([string]$config.hostname))),('    service: '+(& $quote ([string]$config.service))),'  - service: http_status:404')-join [Environment]::NewLine;[IO.File]::WriteAllText((Join-Path $runtime 'cloudflared-live.yml'),$yaml+[Environment]::NewLine,[Text.UTF8Encoding]::new($false));'enabled'"`) do set "TUNNEL_MODE=%%T"
if errorlevel 1 goto :startup_failed
if not defined TUNNEL_MODE goto :startup_failed
if /I "%TUNNEL_MODE%"=="enabled" if not exist "%CLOUDFLARED%" (
  echo [ERROR] cloudflared.exe is missing: %CLOUDFLARED%
  goto :startup_failed
)

echo [4/5] Starting controller...
del /Q "%CONTROLLER_PID_FILE%" >nul 2>nul
del /Q "%TUNNEL_PID_FILE%" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';$p=Start-Process -FilePath $env:FISH_START_EXE -WorkingDirectory $env:FISH_START_CONTROLLER -PassThru -NoNewWindow -RedirectStandardOutput $env:FISH_START_CONTROLLER_OUT -RedirectStandardError $env:FISH_START_CONTROLLER_ERR;Set-Content -LiteralPath $env:FISH_START_CONTROLLER_PID_FILE -Value $p.Id -Encoding ascii"
if errorlevel 1 goto :startup_failed
set "CONTROLLER_PID="
set /p CONTROLLER_PID=<"%CONTROLLER_PID_FILE%"
if not defined CONTROLLER_PID goto :startup_failed
set "FISH_START_CONTROLLER_PID=!CONTROLLER_PID!"

set "CONTROLLER_READY="
for /l %%N in (1,1,40) do (
  powershell.exe -NoProfile -Command "if(-not(Get-Process -Id $env:FISH_START_CONTROLLER_PID -ErrorAction SilentlyContinue)){exit 1};try{$response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8081/healthz' -TimeoutSec 2;if([int]$response.StatusCode -eq 200){exit 0}else{exit 1}}catch{exit 1}"
  if not errorlevel 1 set "CONTROLLER_READY=1"
  if defined CONTROLLER_READY goto :controller_ready
  timeout /t 1 /nobreak >nul
)
goto :startup_failed

:controller_ready
powershell.exe -NoProfile -Command "try{$response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 5;if([int]$response.StatusCode -ne 200){exit 1}}catch{exit 1}"
if errorlevel 1 goto :startup_failed
echo [OK] Controller and vision service are ready.

set "TUNNEL_PID="
if /I "%TUNNEL_MODE%"=="enabled" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';$p=Start-Process -FilePath $env:FISH_START_CLOUDFLARED -ArgumentList @('--protocol','http2','--config',$env:FISH_START_TUNNEL_CONFIG,'tunnel','run') -WorkingDirectory $env:FISH_START_CONTROLLER -WindowStyle Hidden -PassThru -RedirectStandardOutput $env:FISH_START_TUNNEL_OUT -RedirectStandardError $env:FISH_START_TUNNEL_ERR;Set-Content -LiteralPath $env:FISH_START_TUNNEL_PID_FILE -Value $p.Id -Encoding ascii"
  if errorlevel 1 goto :startup_failed
  set /p TUNNEL_PID=<"%TUNNEL_PID_FILE%"
  if not defined TUNNEL_PID goto :startup_failed
  set "FISH_START_TUNNEL_PID=!TUNNEL_PID!"
  powershell.exe -NoProfile -Command "if(Get-Process -Id $env:FISH_START_TUNNEL_PID -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
  if errorlevel 1 goto :startup_failed
  echo [OK] Cloudflare Tunnel process started with HTTP/2.
)

echo.
echo Fish is running. Open http://127.0.0.1:8081/competition.html
if /I "%TUNNEL_MODE%"=="enabled" echo Public URL is configured by config\tunnel.json
echo Press Q in this window to stop the services cleanly.

:monitor
powershell.exe -NoProfile -Command "if(Get-Process -Id $env:FISH_START_CONTROLLER_PID -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if errorlevel 1 (
  echo [ERROR] Fish Controller stopped. See %CONTROLLER_ERR%
  set "EXIT_CODE=1"
  goto :cleanup
)
if defined TUNNEL_PID (
  powershell.exe -NoProfile -Command "if(Get-Process -Id $env:FISH_START_TUNNEL_PID -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
  if errorlevel 1 (
    echo [ERROR] Cloudflare Tunnel stopped. See %TUNNEL_ERR%
    set "EXIT_CODE=1"
    goto :cleanup
  )
)
choice /C QN /N /T 2 /D N >nul
if errorlevel 2 goto :monitor
goto :cleanup

:missing_project_file
echo [ERROR] Pro1 project files are incomplete.
echo Check controller, frontend, vision, and config directories.
exit /b 1

:startup_failed
echo.
echo [ERROR] Fish startup failed.
echo Controller log: %CONTROLLER_ERR%
echo Tunnel log: %TUNNEL_ERR%
set "EXIT_CODE=1"

:cleanup
if not defined EXIT_CODE set "EXIT_CODE=0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';if($env:FISH_START_CONTROLLER_PID -and (Get-Process -Id $env:FISH_START_CONTROLLER_PID -ErrorAction SilentlyContinue)){try{Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:8081/__dev/restart-controller' -TimeoutSec 2|Out-Null}catch{};$deadline=[DateTime]::UtcNow.AddSeconds(8);while([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $env:FISH_START_CONTROLLER_PID -ErrorAction SilentlyContinue)){Start-Sleep -Milliseconds 200};if(Get-Process -Id $env:FISH_START_CONTROLLER_PID -ErrorAction SilentlyContinue){taskkill.exe /PID $env:FISH_START_CONTROLLER_PID /T /F 2>$null | Out-Null}};if($env:FISH_START_TUNNEL_PID -and (Get-Process -Id $env:FISH_START_TUNNEL_PID -ErrorAction SilentlyContinue)){taskkill.exe /PID $env:FISH_START_TUNNEL_PID /T /F 2>$null | Out-Null};Remove-Item -LiteralPath $env:FISH_START_CONTROLLER_PID_FILE -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $env:FISH_START_TUNNEL_PID_FILE -Force -ErrorAction SilentlyContinue"
 powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';function Stop-Tree([int]$id){if(Get-Process -Id $id -ErrorAction SilentlyContinue){taskkill.exe /PID $id /T 2>$null | Out-Null;Start-Sleep -Seconds 2;if(Get-Process -Id $id -ErrorAction SilentlyContinue){taskkill.exe /PID $id /T /F 2>$null | Out-Null}}};if($env:FISH_START_CONTROLLER_PID){Stop-Tree ([int]$env:FISH_START_CONTROLLER_PID)};if($env:FISH_START_TUNNEL_PID){Stop-Tree ([int]$env:FISH_START_TUNNEL_PID)};Remove-Item -LiteralPath $env:FISH_START_CONTROLLER_PID_FILE -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $env:FISH_START_TUNNEL_PID_FILE -Force -ErrorAction SilentlyContinue"
echo [INFO] Fish services stopped.
exit /b %EXIT_CODE%
