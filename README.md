# py_tachie

ローカル環境の Python/FastAPI サーバで動く、紙芝居風アニメーション動画の制作ツールです。
PSD レイヤー付きキャラクター・PNG/WebP 立ち絵・動画背景・BGM・セリフ・音声・テロップを組み合わせて、1920×1080 の MP4 / MOV (ProRes/QuickTime PNG) を書き出せます。

ライセンスは [MIT](LICENSE) です。商用利用・改変・再配布、いずれも自由に行えます。

構造はシーン (scene) を最外として、その中に **カット (cut)** と **テロップ (telop)** が並列に並びます。カットは話者・セリフ・キャラ配置のひとまとまり、テロップはカットと独立してシーン全体に対して任意区間に配置します。

- 永続スキーマは v4 (`scenes[]` + フレームベースのタイムコード)
- 描画エンジンは **WebGL/three.js (v2)** に統一。動画書き出し / PNG 出力 / サムネイルすべて v2 GL 経路
- ライブプレビュー (GL シーン + 波形/dB メーター + テロップタイムライン)
- ffmpeg ハードウェアエンコーダ (NVENC / VideoToolbox) を自動検出
- `python -m app` で起動 (内部で `ws_per_message_deflate=False` を強制)
- プロジェクトは ZIP アーカイブで持ち出し / 取り込み可能

- リポジトリ: <https://github.com/pyoru0309/py_tachie/>
- ユーザー向け解説: [`user_guide/`](user_guide/index.md) (ビルド済み HTML は [`docs/`](docs/index.html)、GitHub Pages でも公開予定)
  - PSD レイヤー命名規則: [`user_guide/technical/psd-layer-rules.md`](user_guide/technical/psd-layer-rules.md)
  - シナリオデータ仕様: [`user_guide/technical/scenario-format.md`](user_guide/technical/scenario-format.md)

## 推奨環境

開発・動作確認に使っている環境は次の 2 構成です。

| 構成 | OS | CPU | GPU | メモリ | 備考 |
| --- | --- | --- | --- | --- | --- |
| macOS | macOS 15 (Sequoia) | Apple M1 Pro 以上 | 内蔵 (VideoToolbox) | 16 GB+ | 開発主環境。VideoToolbox HW エンコード推奨 |
| Windows | Windows 11 | Intel Core i7-12700H | NVIDIA GeForce RTX 3060 Laptop | 16 GB | NVENC で MP4 約 32–62 fps の書き出し速度を確認済み |

最低ライン:

- Python **3.11 以上** (3.12 / 3.14 で動作確認)
- ffmpeg / ffprobe (HW エンコードを使う場合は NVENC または VideoToolbox 対応のビルド)
- メモリ 8 GB 以上 (長尺シナリオは 16 GB 推奨)

ブラウザは Chrome / Edge / Safari の最新版を想定しています。

## クイックスタート

専用のセットアップツールはまだありません。Git・Python・ffmpeg を順に整えて、`uvicorn` でサーバを起動してください。
詳しい手順 (ターミナルの開き方、Python / ffmpeg の入手先まで含む丁寧版) は [user_guide/tutorials/getting-started.md](user_guide/tutorials/getting-started.md) を参照してください。

### 0. 前提

- Git (`git --version` が通ること)
- Python **3.11 以上** (`python3 --version` で確認)
- ffmpeg / ffprobe (詳細は次節)

### 1. ソースを取得

```bash
git clone https://github.com/pyoru0309/py_tachie.git
cd py_tachie
```

### 2. ffmpeg を導入

**macOS** (Homebrew が入っていれば):

```bash
brew install ffmpeg
ffmpeg -version   # 動作確認
```

**Windows** (`winget` が使える Win11 の場合):

```powershell
winget install Gyan.FFmpeg
ffmpeg -version
```

`winget` を使わない場合は <https://www.gyan.dev/ffmpeg/builds/> から `ffmpeg-release-essentials.zip` (NVENC を使うなら `ffmpeg-release-full.7z`) を取得し、`C:\ffmpeg\` などに展開して `bin\` を環境変数 `Path` に追加します。
インストール場所が固定できない場合は、起動後に立ち絵システム側の `全体設定 → ffmpeg のパス` で `ffmpeg.exe` の絶対パスを指定すれば PATH に依らず動きます。

> **NVENC を使う場合**: GPL ビルドの ffmpeg を選んでください (`gyan.dev` の `essentials` / `full` は GPL)。LGPL ビルドだと UI に「NVENC (NVIDIA HW)」が出てきません。

### 3. Python 仮想環境 + 依存ライブラリ

**macOS / Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

**Windows (PowerShell):**

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

(`Activate.ps1` が実行ポリシーで止められる場合は `PowerShell -ExecutionPolicy Bypass` で起動するか、コマンドプロンプトで `.\.venv\Scripts\activate.bat` を使ってください)

### 4. サーバ起動

```bash
python -m app
```

`python -m app` は `app/__main__.py` 経由の薄い uvicorn ラッパで、

- `ws_per_message_deflate=False` (v2 export の RGBA WS が圧縮で潰されないように) を強制
- `--port 8080` で別ポートに上書き、`--host 0.0.0.0` で LAN 公開、`--no-reload` で本番運用

など必要なオプションを切り替えられます (`python -m app --help`)。

uvicorn を直接呼ぶ場合は次の通りです (上記の挙動を自分で揃える必要あり)。

```bash
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
    --ws-per-message-deflate false
```

ブラウザで <http://127.0.0.1:8000/> を開きます。
ヘルプドキュメント (zensical でビルドした `docs/`) は <http://127.0.0.1:8000/help/> で配信されます。GitHub Pages 公開後は同じ内容を Web 上でも閲覧できます。

### 5. JS ライブラリと日本語フォント (任意・初回セットアップ)

v2 描画エンジンと動画書き出しは three.js / mp4box.js を使います。既定では `static/vendor/` のローカル版を見て、無ければ jsdelivr CDN にフォールバックします。オフラインで使うなら、起動後に **全体設定 → 環境 → JS ライブラリのインストール** から 1 クリックで `static/vendor/` 以下に展開してください。

日本語フォントも空の状態で配布されます。最低限の日本語表示が必要なら、同じ画面の **Noto Sans JP をインストール** ボタンで `assets/fonts/NotoSansJP/` へ取り込みできます (`notofonts/noto-cjk` リポジトリの static OTF を 7 weight 取得 — Thin / Light / DemiLight / Regular / Medium / Bold / Black。書き出しでも利用可能)。

### 6. 音声読み上げ (TTS) のボイス登録 (任意)

VOICEVOX や Voicepeak で生成されるボイス (キャラクター × 声 × 感情) は、初回起動時に自動では登録されません。
**全体設定 → 音声読み上げ → 「ボイスを登録」** ボタンを 1 度押すと、ローカルで起動している VOICEVOX / Voicepeak から利用可能なボイスを取得して `app_state/voice_catalog.json` に書き込みます。これでカット編集画面の「声」セレクタから話者を選べるようになります。

ボイス追加・エンジン入れ替え後は同じボタンで再登録できます。

## 更新方法 (新しいバージョンへのアップグレード)

### 推奨: アプリ内アップデータ

サーバを起動した状態で **全体設定 → 環境 → アップデート → 「アップデートを確認」** を押すと、最新版があるか自動でチェックします。新バージョンが見つかったら **「アップデートを実行」** で取得・適用します。git コマンドは不要です。

通常のソフトのアップデータと同じく、**あなたのカスタマイズは壊れません**:

- ❌ プロジェクトデータ (`projects/<id>/`) は更新の影響を受けない
- ❌ アップロードしたフォント (`assets/fonts/`) は影響を受けない
- ❌ アップロードした効果音 (`assets/sound_effects/`) は影響を受けない
- ❌ 書き出し済みファイル (`outputs/`) やキャッシュ (`cache/`) は影響を受けない
- ✅ 配布キャラ・配布素材 (`assets/characters/maki_py`, `assets/backgrounds/` 等) は、既定では更新されません。「共通アセット (背景・音声等) も更新する」にチェックを入れたときだけ最新版に差し替えます

アップデート前に `app_state/backups/update_<timestamp>/` にバックアップを取るオプションが既定でオンになっています。万一の事故時はこのバックアップから手動で復旧できます。

> アップデート完了後はサーバ (`python -m app`) を一度終了して再起動してください。ブラウザのリロードだけでは反映されません。

### 上級者向け: コマンドラインで更新

git に慣れている方は、次のコマンドで更新できます:

```bash
cd py_tachie
git pull
```

ローカルで変更したファイルがあると merge conflict が出ることがあります。その場合は `git status` で変更内容を確認してから、必要に応じて `git stash` で退避してください。

### GitHub Desktop を使う場合

1. GitHub Desktop で `py_tachie` リポジトリを開く
2. 画面上部の **Fetch origin** をクリック
3. **Pull origin** が表示されたら押す

これでアプリのコードが最新になります。再度 `python -m app` で起動してください。

## ディレクトリ構成

| パス | 役割 |
| --- | --- |
| `app/__main__.py` | `python -m app` 起動ラッパ (uvicorn の起動オプションを集約) |
| `app/main.py` | FastAPI ルーティング (プロジェクト / 素材 / 書き出し / vendor / fonts API) |
| `app/compositor.py` | v2 scene-bundle 用の Pillow 補助 (キャラレイヤー焼き / dialogue レイアウト計算 / フォント解決) |
| `app/render.py` | フレーム生成・タイムコード解決・キャラ補間 |
| `app/export_video.py` | 動画書き出し補助 (ffmpeg 引数 / amix / 音声レベル算出) |
| `app/v2_export.py` | WebGL/three.js 経路の動画書き出し (本線) |
| `app/global_config.py` | 全体設定 (動画プリセット・ffmpeg パス・プロジェクトフォルダ・vendor) |
| `app/vendor.py` | three.js / mp4box.js を `static/vendor/` へ取得 / active 切替 |
| `app/fonts.py` | Noto Sans JP などのデフォルトフォントを `assets/fonts/` へ取得 |
| `app/project_archive.py` | プロジェクトディレクトリ → ZIP の書き出し |
| `app/project_import.py` | ZIP → プロジェクト取り込み + スキーマ移行 (将来の移行ツール基盤) |
| `app/psd.py` / `tools/import_psd.py` | PSD インポータ (UI / CLI) |
| `static/index.html` | UI マークアップ (importmap はサーバ側が動的注入) |
| `static/css/` | デザイントークン・コンポーネント・レイアウト |
| `static/js/` | モジュール分割された vanilla JS (timeline / telop / playback / renderer / export ほか) |
| `static/vendor/` | three.js / mp4box.js のローカル vendor (`active.json` で現行 version) |
| `assets/` | 共通素材 (キャラクター・背景・音声・フォント・装飾) |
| `assets/characters/<id>/` | 共通キャラ素材。通常は READ ONLY |
| `projects/<id>/` | プロジェクト固有データ (`project.json` / `config.json` / `scenarios/` / `assets/` / `outputs/` / `cache/`) |
| `app_state/` | アプリ状態 (起動中プロジェクト・全体設定 `global_config.json`) |
| `cache/` / `outputs/` | グローバルキャッシュ・書き出し置き場 (Git 管理外) |
| `tools/` | PSD 取り込み・旧素材移行 |
| `docs/` / `user_guide/` | zensical でビルドする HTML / Markdown ソース |

プロジェクトの保存先 (`projects/`) は全体設定で別ディレクトリへ切り替えられます。

## 主な機能

- **シーン (scene) の中にカット (cut) とテロップ (telop) を並列で配置**
  - シーンは 1 つの `videoTrack` (任意)、複数の `bgmTracks`、複数の `cuts`、複数の `telops` を持つ
  - カットは `startFrame` + `durationFrame` でシーン上に配置 (カット同士は重なり禁止)
  - テロップはカットと独立した別系列で、シーンに対して任意の区間に置ける (カットの境界に縛られない)
- **タイムコードはフレームベース** (project fps = 24 固定)
  - スキーマ上はすべて `startFrame` / `durationFrame`
  - 表示は `MM:SS.FF`、`bindTimecodeInput` でフォーム入力をフレームに正規化
- **キャラクター v4 manifest**
  - カテゴリは `base / cheek / eye / mouth / bangs / front` の 6 種に統一 (旧 `body` / `pose` / `costume` / `foreground` は import 時に正規化)
  - `eyeAboveBangs` カットフラグで前髪と目の前後関係を切替
- **PSD インポータ**
  - ダッシュボードから PSD をアップロード → ツリー確認 → 取り込み (新規 / 追記)
  - `.import.yaml` の `map:` で `mouth_closed` / `eye_open` 等の推奨キーへ任意レイヤーを割当て
  - `thumb` / `サムネイル` レイヤーをサムネイルとして自動書き出し
  - **縦横上限 px** と **補間アルゴリズム** (lanczos / bicubic / hamming / bilinear / box / nearest) を取り込み時に指定可能
  - `_` で始まるレイヤーは取り込み除外
- **テロップ**
  - 右パネルに統合された編集 UI、書体/太さ/色/アウトライン/サイズ/縦位置/横位置をカット非依存で設定
  - タイムライン下のテロップ帯で `s` / `e` / 矢印キーで開始/終了/シフトを編集
  - 一括追加、一括スタイル反映、複数選択 (`Cmd/Ctrl+A` でタイムライン上の全選択)
- **ライブプレビュー (v2 GL)**
  - three.js シーンに背景 / キャラ / 前景 / セリフ / テロップを並べ、停止中も同じシーンで still 描画
  - 波形 + dB メーター、テロップタイムライン、ビジュアライザ (wave / circle_spectrum / countdown ほか)
  - キャラアニメは `characterAnimationFps` (8/12/24, 既定 12) で量子化
  - 再生ヘッド位置はプロジェクトに保存され、再起動後にカット位置から復元
- **動画書き出し (v2 GL → ffmpeg)**
  - GL canvas を WebGL2 PBO で読み出し → WebSocket で uvicorn → ffmpeg にパイプ
  - 内蔵プリセット: H.264 標準 / H.264 高画質 / H.265 高効率 / ProRes 422 Proxy/HQ/4444 / QuickTime PNG / FFV1
  - alpha 対応プリセット (ProRes 4444 / QtPNG) は背景なしで透過動画として書き出し
  - HW エンコーダは `ffmpeg -encoders` を解析して自動検出。利用可能なものだけ UI に並ぶ
  - 書き出し中はバックグラウンドスレッドで実行し、フレーム単位の進捗をストリーム表示
- **プロジェクト ZIP アーカイブ / 取り込み**
  - 各プロジェクトカードの「アーカイブ」で `<title>.splite.zip` をダウンロード (cache / outputs / exports / generated は除外)
  - ダッシュボード上部の「読み込み」で取り込み。スキーマ migration は `app/project_import.py` の `MIGRATIONS` レジストリに集約 (将来のバージョンアップ対応)
- **JS ライブラリ / フォントの vendor 化**
  - 全体設定 → 環境 → 「JS ライブラリのインストール」で three.js / mp4box.js を `static/vendor/` に取得
  - 「Noto Sans JP をインストール」で `assets/fonts/NotoSansJP/` に static OTF 7 weight (Thin / Light / DemiLight / Regular / Medium / Bold / Black) を取得
  - `vendor.useCdn` トグルで CDN 強制使用に切替可能 (オフライン運用時はインストール推奨)
- **Undo / Redo** (`Cmd/Ctrl+Z` / `Cmd+Shift+Z`、履歴サイズは全体設定で可変)
- **テーマ** (ライト / ダーク、prefers-color-scheme で初期化)

## 動画書き出しエンコーダ

`app/global_config.py` の `BUILTIN_VIDEO_PRESETS` に組み込みプリセットが定義されています。

| プリセット | コンテナ | 用途 |
| --- | --- | --- |
| MP4 (H.264) 標準 | mp4 | 汎用 / 配信プレビュー (NVENC/VideoToolbox alternate あり) |
| MP4 (H.264) 高画質 | mp4 | マスタ用。CRF 16 / NVENC は -cq 19 |
| MP4 (H.265) 高効率 | mp4 | サイズ重視。HEVC NVENC/VideoToolbox alternate あり |
| ProRes 422 Proxy | mov | 編集ソフト取り込み用に軽量 |
| ProRes 422 HQ | mov | 視覚ロスレスの編集中間 |
| ProRes 4444 (alpha) | mov | アルファ付き透過素材 (合成素材納品向け) |
| QuickTime PNG (alpha) | mov | 完全可逆 + アルファ。容量大 |
| FFV1 (mkv) | mkv | 完全可逆。長期保管 |

`writeup` 時に `ffmpeg` の能力を検出して、未搭載のエンコーダはダイアログ上で disabled になります。NVENC を使う場合は GPL ビルド版 ffmpeg を全体設定の `ffmpeg のパス` に指定してください。

書き出しダイアログから FPS (8 / 12 / 24)、エンコーダ alternate、モノラル → ステレオ自動変換、書き出し前確認の有無を切り替えられます。

## ショートカットキー

タイムラインの canvas にフォーカスがある (Tab で focus、または canvas クリック) と、テロップ操作系のキーが有効になります。

| キー | 場所 | 動作 |
| --- | --- | --- |
| `Space` | グローバル | 再生 / 停止 |
| `←` / `→` | グローバル | 前 / 次のカットへ移動 |
| `n` / `N` | グローバル | 現在のカットの末尾に新規カットを挿入 |
| `Cmd/Ctrl+Z` | グローバル | Undo |
| `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` | グローバル | Redo |
| `Cmd/Ctrl+A` | タイムライン canvas | 全テロップ選択 |
| `Delete` / `Backspace` | タイムライン canvas | 選択中テロップ削除 |
| `Home` / `End` | タイムライン canvas | 再生ヘッドを先頭 / 末尾へ |
| `s` / `S` | タイムライン canvas | 選択テロップ群の先頭、または直近のテロップ先頭を再生ヘッドに合わせる |
| `e` / `E` | タイムライン canvas | 直近のテロップの終端を再生ヘッドに合わせる (1 frame snap あり) |
| `←` / `→` | タイムライン canvas | テロップ未選択: 前後のテロップへジャンプ。テロップ選択中: 選択群を ±1 frame 平行移動 |
| `Shift+←` / `Shift+→` | タイムライン canvas | 再生ヘッドを ±1 frame 移動 |

ダイアログを開いている間や `<input>` / `<textarea>` にフォーカスがある間は、上記ショートカットは OS の編集操作 (Undo/Redo 等) を優先します。

## よく使うコマンド

```bash
# サーバ起動 (推奨)
python3 -m app

# サーバ起動 (uvicorn 直叩き)
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --ws-per-message-deflate false

# PSD 取り込み (CLI、共通キャラ向け)
python3 tools/import_psd.py assets/characters/<id>/psd/キャラクター.psd --out assets/characters/<id>

# 旧素材を v4 形式へ移行
python3 tools/migrate_character_assets.py --source assets/character --dest assets/characters/default --id default --name "Default Character"

# 旧 v3 シナリオを v4 (scenes[]) へ変換
python3 tools/migrate_v3_to_v4.py projects/<id>/scenarios/main.json
```

## ライセンス

[MIT License](LICENSE) — Copyright (c) 2026 pyoru0309。
改変・再配布・商用利用すべて自由に行えます。

## 同梱素材のクレジット

すべて pyoru0309 (ぴょうる) が制作・所有しており、改変・再配布自由 (MIT に準拠) です。

- **キャラクター素材** — `assets/characters/maki_py/`, `assets/characters/moca_py/`
- **背景画像** — `assets/backgrounds/`
- **前景画像** — `assets/foregrounds/`
- **装飾画像** — `assets/overlays/`
- **音声 (BGM 等)** — `assets/audio/`

### 同梱していないもの

リポジトリのサイズ・ライセンス・素材権利の都合から、以下は**同梱せず**にユーザー側でセットアップする方式にしています:

- **フォント** — 起動後に *全体設定 → 環境 → Noto Sans JP をインストール* で `assets/fonts/NotoSansJP/` に取得できます。その他、ご自身で M PLUS Rounded / LINE Seed JP / Shippori Mincho B1 / Zen Maru Gothic などを `assets/fonts/` に配置すると UI に表示されます。
- **効果音 (SE)** — v0.1.0 では同梱していません。`.mp3` ファイルを `assets/sound_effects/` に配置すれば、UI 上で利用できます。

## 依存ライブラリ

- バックエンド: FastAPI, Uvicorn, websockets, httpx, Pillow, psd-tools, NumPy, ffmpeg (外部)
- フロントエンド: vanilla HTML/CSS/JavaScript (フレームワーク非導入), three.js, mp4box.js
- 描画エンジン: WebGL2 + three.js (v2)。Pillow は PSD インポータ / scene-bundle 補助 / 画像検証で利用
- フォント: Material Symbols Outlined / LINE Seed JP を CDN ロード。日本語本文用には Noto Sans JP を `static/vendor/` 経由でローカル取得可能
- vendor: `static/vendor/` 配下の three.js / mp4box.js は npm registry / jsdelivr ESM bundle から取得

## コントリビューション

バグ報告・機能提案・プルリクエスト、いずれも歓迎します。Issues / Pull Requests からどうぞ。

詳しい使い方は [`user_guide/`](user_guide/index.md) を参照してください。
