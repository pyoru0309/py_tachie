#!/usr/bin/env bash
# ============================================================================
# 立ち絵システム 復旧スクリプト (macOS / Linux)
#
# アップデートに失敗してサーバが起動しなくなった / ファイルが壊れた・欠落した
# ときに実行してください。リモート (GitHub) の最新状態へ強制的に一致させて
# 復旧します。
#
# あなたのデータは消えません:
#   projects/  app_state/  cache/  outputs/  assets/fonts/  assets/sound_effects/
#   などは git 管理外なので、この復旧では一切触りません。
#   消えるのは「あなたが手で書き換えたコード」だけです (通常はありません)。
#
# 使い方:
#   bash tools/recover.sh
# ============================================================================
set -euo pipefail

# リポジトリ root へ移動 (このスクリプトは tools/ に置かれる前提)
cd "$(dirname "$0")/.."

echo "============================================================"
echo "  立ち絵システム 復旧"
echo "============================================================"
echo "フォルダ: $(pwd)"

if ! command -v git >/dev/null 2>&1; then
  echo
  echo "[エラー] git が見つかりません。git をインストールしてから再実行してください。"
  exit 1
fi

# 現在のブランチ (受信チャネル) を取得。取れなければ main。
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  BRANCH="main"
fi

echo "対象ブランチ: $BRANCH"
echo
echo "リモートから取得し、$BRANCH を origin/$BRANCH に完全一致させます。"
echo " - コミットしていないコードの変更は破棄されます"
echo " - プロジェクト/素材/出力などのデータは消えません"
echo
read -r -p "続行しますか? [y/N] " ans
case "$ans" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "中止しました"; exit 1 ;;
esac

echo
echo "[1/3] git fetch origin ..."
git fetch origin
echo "[2/3] git checkout -f $BRANCH ..."
git checkout -f "$BRANCH"
echo "[3/3] git reset --hard origin/$BRANCH ..."
git reset --hard "origin/$BRANCH"

echo
echo "============================================================"
echo "  復旧が完了しました。サーバを起動し直してください。"
echo "    python3 -m app"
echo "============================================================"
