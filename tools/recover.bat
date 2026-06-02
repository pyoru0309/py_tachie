@echo off
REM ============================================================================
REM Tachie System - Recovery script (Windows)
REM
REM Run this (double-click) when the server fails to start, or files got broken
REM or missing after a failed update. It force-syncs the code to the latest
REM state on the remote (GitHub).
REM
REM Your data is NOT touched:
REM   projects\  app_state\  cache\  outputs\  assets\fonts\  assets\sound_effects\
REM   are not tracked by Git, so this recovery never deletes them.
REM   Only manual edits to the source code are discarded (usually none).
REM
REM NOTE: messages are intentionally ASCII-only (.bat runs under Shift_JIS on
REM       Japanese Windows; non-ASCII would be garbled). See .gitattributes.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

echo ============================================================
echo   Tachie System - Recovery
echo ============================================================
echo Folder: %CD%

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] git not found. Install git and run again:
  echo         https://git-scm.com/download/win
  pause
  exit /b 1
)

REM Detect current branch (update channel). Fall back to main.
set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if "%BRANCH%"=="" set "BRANCH=main"
if "%BRANCH%"=="HEAD" set "BRANCH=main"

echo Target branch: %BRANCH%
echo.
echo This will fetch from the remote and force %BRANCH% to match origin/%BRANCH%.
echo  - Uncommitted code changes will be discarded
echo  - Your projects / assets / outputs are NOT deleted
echo.
pause

echo.
echo [1/3] git fetch origin ...
git fetch origin
echo [2/3] git checkout -f %BRANCH% ...
git checkout -f "%BRANCH%"
echo [3/3] git reset --hard origin/%BRANCH% ...
git reset --hard "origin/%BRANCH%"

if errorlevel 1 (
  echo.
  echo [ERROR] Recovery failed. Check your internet connection and retry,
  echo         or re-download the ZIP from GitHub and reinstall.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Recovery complete. Restart the server:
echo     python -m app
echo ============================================================
pause
endlocal
