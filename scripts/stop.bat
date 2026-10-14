@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "RUNTIME=%ROOT%\controller\.runtime"
set "EXE=%RUNTIME%\fish-controller.exe"
set "CLOUDFLARED=%RUNTIME%\cloudflared.exe"
set "CONTROLLER_PID_FILE=%RUNTIME%\fish-controller.pid"
set "TUNNEL_PID_FILE=%RUNTIME%\cloudflared.pid"
set "FISH_STOP_ROOT=%ROOT%"
set "FISH_STOP_EXE=%EXE%"
set "FISH_STOP_CLOUDFLARED=%CLOUDFLARED%"
set "FISH_STOP_CONTROLLER_PID_FILE=%CONTROLLER_PID_FILE%"
set "FISH_STOP_TUNNEL_PID_FILE=%TUNNEL_PID_FILE%"

echo Stopping Pro1 services...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$root=[IO.Path]::GetFullPath($env:FISH_STOP_ROOT);" ^
  "$controller=[IO.Path]::GetFullPath($env:FISH_STOP_EXE);" ^
  "$cloudflared=[IO.Path]::GetFullPath($env:FISH_STOP_CLOUDFLARED);" ^
  "$vision=[IO.Path]::GetFullPath((Join-Path $root 'vision\server.py'));" ^
  "$targets=@(Get-CimInstance Win32_Process);" ^
  "foreach($p in $targets){$path=[string]$p.ExecutablePath;$cmd=[string]$p.CommandLine;$kill=$false;" ^
  "if($path -and ([IO.Path]::GetFullPath($path) -in @($controller,$cloudflared))){$kill=$true};" ^
  "if($p.Name -in @('python.exe','pythonw.exe') -and $cmd.IndexOf($vision,[StringComparison]::OrdinalIgnoreCase) -ge 0){$kill=$true};" ^
  "if($kill){taskkill.exe /PID $p.ProcessId /T /F 2>$null|Out-Null}};" ^
  "Remove-Item -LiteralPath $env:FISH_STOP_CONTROLLER_PID_FILE,$env:FISH_STOP_TUNNEL_PID_FILE -Force -ErrorAction SilentlyContinue"

echo Pro1 services stopped.
exit /b 0
