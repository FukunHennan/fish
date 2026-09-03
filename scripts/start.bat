@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "CONTROLLER=%ROOT%\controller"
set "FRONTEND=%CONTROLLER%\frontend"
set "RUNTIME=%CONTROLLER%\.runtime"
set "EXE=%RUNTIME%\fish-controller.exe"
set "FRPC_CONFIG=%ROOT%\config\frpc.toml"
set "FRPC_LOG=%RUNTIME%\frpc.log"

if not exist "%CONTROLLER%\go.mod" (
  echo [ERROR] controller\go.mod not found.
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

if not exist "%ROOT%\config\deployment.json" (
  if not exist "%ROOT%\config\deployment.example.json" (
    echo [ERROR] config\deployment.example.json is missing.
    pause
    exit /b 1
  )
  echo [INFO] Creating config\deployment.json from the example preset...
  copy /Y "%ROOT%\config\deployment.example.json" "%ROOT%\config\deployment.json" >nul
  if errorlevel 1 goto :fail
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

if not exist "%RUNTIME%" mkdir "%RUNTIME%"

echo [3/4] Building Go controller...
pushd "%CONTROLLER%"
go build -o "%EXE%" ./cmd/fish-controller
if errorlevel 1 goto :fail
popd

for /f "tokens=1" %%P in ('tasklist /FI "IMAGENAME eq fish-controller.exe" /NH 2^>nul') do (
  if /I "%%P"=="fish-controller.exe" (
    echo [INFO] An existing Fish Controller is running. Stopping it first...
    taskkill /IM fish-controller.exe /T /F >nul 2>nul
    timeout /t 1 /nobreak >nul
  )
)

echo [4/4] Starting Fish Controller...
start "FishController" /D "%CONTROLLER%" cmd /k ""%EXE%""

if exist "%FRPC_CONFIG%" (
  call :start_frpc
)

echo.
echo Started. Open: http://localhost:8081
exit /b 0

:start_frpc
where frpc >nul 2>nul
if errorlevel 1 (
  echo [INFO] frpc was not found in PATH; skipping public tunnel.
  exit /b 0
)
for /f "tokens=1" %%P in ('tasklist /FI "IMAGENAME eq frpc.exe" /NH 2^>nul') do (
  if /I "%%P"=="frpc.exe" (
    echo [INFO] An existing frpc is running. Stopping it first...
    taskkill /IM frpc.exe /T /F >nul 2>nul
    timeout /t 1 /nobreak >nul
  )
)
echo [INFO] Starting frpc using %FRPC_CONFIG%...
start "FRPC" /D "%ROOT%" cmd /k "frpc -c \"%FRPC_CONFIG%\" > \"%FRPC_LOG%\" 2>&1"
exit /b 0

:fail
popd >nul 2>nul
echo.
echo [ERROR] Startup failed.
pause
exit /b 1
