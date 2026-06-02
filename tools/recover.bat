@echo off
chcp 65001 >nul
REM ============================================================================
REM 立ち絵システム 復旧スクリプト (Windows)
REM
REM アップデートに失敗してサーバが起動しなくなった / ファイルが壊れた / 欠落した
REM ときに、ダブルクリックで実行してください。リモート (GitHub) の最新状態へ強制
REM 的に一致させて復旧します。
REM
REM あなたのデータは消えません:
REM   projects\  app_state\  cache\  outputs\  assets\fonts\  assets\sound_effects\
REM   などは git 管理外なので、この復旧では一切触りません。
REM   消えるのは「あなたが手で書き換えたコード」だけです (通常はありません)。
REM ============================================================================
setlocal
cd /d "%~dp0\.."

echo ============================================================
echo   立ち絵システム 復旧
echo ============================================================
echo フォルダ: %CD%

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo [エラー] git が見つかりません。git をインストールしてから再実行してください。
  echo          https://git-scm.com/download/win
  pause
  exit /b 1
)

REM 現在のブランチ (受信チャネル) を取得。取れなければ main。
set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if "%BRANCH%"=="" set "BRANCH=main"
if "%BRANCH%"=="HEAD" set "BRANCH=main"

echo 対象ブランチ: %BRANCH%
echo.
echo リモートから取得し、%BRANCH% を origin/%BRANCH% に完全一致させます。
echo  - コミットしていないコードの変更は破棄されます
echo  - プロジェクト/素材/出力などのデータは消えません
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
  echo [エラー] 復旧に失敗しました。ネット接続を確認のうえ再実行するか、
  echo          GitHub から ZIP を再ダウンロードして入れ直してください。
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   復旧が完了しました。サーバを起動し直してください。
echo     python -m app
echo ============================================================
pause
endlocal
