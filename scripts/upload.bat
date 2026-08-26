@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git was not found in PATH.
  popd
  pause
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [ERROR] This folder is not a Git repository.
  popd
  pause
  exit /b 1
)

echo.
git status --short
echo.
set /p "MSG=Commit message (leave empty for update): "
if "%MSG%"=="" set "MSG=update"

git add -A
if errorlevel 1 goto :fail

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MSG%"
  if errorlevel 1 goto :fail
) else (
  echo No new file changes to commit.
)

echo.
echo Pushing to GitHub...
git push
if errorlevel 1 goto :fail

echo.
echo Upload complete.
popd
exit /b 0

:fail
echo.
echo [ERROR] Git upload failed. Check the message above.
popd
pause
exit /b 1
