# はじめに

このチュートリアルでは、立ち絵システムをまっさらな環境にセットアップして、ブラウザで編集画面を開くまでの手順を説明します。
ComfyUI のようなワンクリックインストーラはまだ用意していないので、Git・Python・ffmpeg を順に入れていく形になります。

> ソースコード: <https://github.com/pyoru0309/py_tachie/>

## 必要なもの

| 種類 | 何をする | 必要なバージョン |
| --- | --- | --- |
| Git | ソースコードを取得する | 最新の安定版 |
| Python | サーバ本体を動かす | **3.11 以上** (3.12 / 3.14 で動作確認) |
| ffmpeg / ffprobe | 動画書き出し・音声解析 | 最新の安定版 (NVENC を使うなら GPL ビルド) |
| ブラウザ | UI を開く | Chrome / Edge / Safari の最新版 |

最低 8 GB、長尺シナリオは 16 GB 以上のメモリを推奨します。
動作確認している構成は次のとおりです。

| 構成 | OS | CPU | GPU |
| --- | --- | --- | --- |
| macOS | macOS 15 (Sequoia) | Apple M1 Pro 以上 | 内蔵 (VideoToolbox) |
| Windows | Windows 11 | Intel Core i7-12700H | NVIDIA GeForce RTX 3060 Laptop |

## ターミナル (コマンドライン) の開き方

これから実行するコマンドはすべて「ターミナル」と呼ばれる文字入力の窓に打ち込みます。
普段使っていない場合の開き方は次のとおりです。

### macOS

- **Spotlight 検索**: `Cmd + Space` を押して `terminal` または `ターミナル` と入力 → Enter。
- **Launchpad**: `その他` → `ターミナル`。
- **Finder**: `アプリケーション` → `ユーティリティ` → `ターミナル.app`。

文字を貼り付けるときは `Cmd + V`、コピーは `Cmd + C` です。

### Windows

- **スタートメニュー**: スタート → `ターミナル` (Windows 11) または `Windows PowerShell` (Windows 10) を開く。
- **Win + X**: `Windows 11` ならメニューから `ターミナル` を選べる。
- **コマンドプロンプト派**: スタートで `cmd` と入力。

このガイドでは PowerShell の例を載せます。コマンドプロンプトでも `Activate.ps1` を `activate.bat` に置き換えれば同じ手順で動きます。

## 1. Git のインストール

ソースコードを GitHub から取ってくるためのツールです。

### macOS

- ターミナルで `git --version` を実行。
- 入っていなければ自動的に Xcode Command Line Tools のインストールダイアログが出るので、`インストール` を押します (数分〜十数分かかります)。
- Homebrew を使っている場合は `brew install git` でも OK です。

### Windows

- `winget install Git.Git` (Windows 11 の `winget` 経由) が一番簡単です。
- それ以外は <https://git-scm.com/download/win> から `Git for Windows` インストーラを実行してください。途中の選択肢は基本そのまま `Next` で問題ありません。

インストール後、ターミナルを開き直して `git --version` で動作確認します。

## 2. Python のインストール

立ち絵システムは Python 3.11 以上で動きます。`python3 --version` (または `python --version`) で確認してください。

### macOS

- 標準の Python 3 が古い (3.10 以下) 場合は <https://www.python.org/downloads/macos/> の公式インストーラ、または `brew install python@3.12` をおすすめします。
- インストール後にターミナルを開き直して `python3 --version` を確認。

### Windows

- `winget install Python.Python.3.12` が一番簡単です。
- それ以外は <https://www.python.org/downloads/windows/> の公式インストーラを使ってください。
- インストーラ起動時に **「Add python.exe to PATH」のチェックを必ず入れる** こと。これを忘れるとターミナルから `python` が呼べません。
- インストール後にターミナルを開き直して `py -3.12 --version` または `python --version` を確認。

## 3. ffmpeg のインストール

動画書き出しと音声解析に必須です。立ち絵システムは PATH 上の `ffmpeg` / `ffprobe` を自動検出しますが、見つからない場合は後述の `全体設定` で絶対パスを指定する方法もあります。

### macOS

**Homebrew を使う方法 (推奨)**:

```bash
brew install ffmpeg
ffmpeg -version
```

`brew` が入っていない場合は <https://brew.sh/index_ja> の指示に従ってまず Homebrew を入れてください。

**公式バイナリを使う方法**:

- <https://evermeet.cx/ffmpeg/> から `ffmpeg-<version>.zip` と `ffprobe-<version>.zip` を取得。
- 展開した `ffmpeg` / `ffprobe` を `/usr/local/bin/` か `~/bin/` に置きます。
- `chmod +x ffmpeg ffprobe` で実行権限を付与。
- 初回実行時に Gatekeeper でブロックされた場合は、`システム設定` → `プライバシーとセキュリティ` の下のほうに「許可」ボタンが出るので押します。

### Windows

**`winget` を使う方法 (推奨、Windows 11)**:

```powershell
winget install Gyan.FFmpeg
ffmpeg -version
```

ターミナルを開き直してから `ffmpeg -version` を実行してください。

**手動でインストールする方法**:

1. <https://www.gyan.dev/ffmpeg/builds/> から `ffmpeg-release-essentials.zip` (NVENC を使うなら `ffmpeg-release-full.7z`) をダウンロードします。
2. 展開して、中身のフォルダを `C:\ffmpeg\` に置きます (例: `C:\ffmpeg\bin\ffmpeg.exe` / `C:\ffmpeg\bin\ffprobe.exe`)。
   - ユーザー権限の場所に置きたいなら `%USERPROFILE%\tools\ffmpeg\` でも構いません。
3. **環境変数 PATH に `bin` フォルダを追加** します。
   - スタート → `環境変数` → `システム環境変数の編集` → `環境変数` ボタン。
   - 「ユーザーの環境変数」の `Path` を選んで `編集` → `新規` → `C:\ffmpeg\bin` を追加 → `OK` で閉じる。
   - ターミナルを開き直し、`ffmpeg -version` で動作確認。
4. PATH をどうしても通せない場合は、起動後に立ち絵システム本体の `全体設定 → ffmpeg のパス` に `ffmpeg.exe` の絶対パスを入れれば PATH なしでも動きます。

> **NVENC を使う場合**: GPL ビルド (`gyan.dev` の `essentials` / `full` はどちらも GPL) を選んでください。LGPL ビルドだと UI に NVENC エンコーダが出てきません。

### 共通の動作確認

```bash
ffmpeg -version
ffprobe -version
```

両方ともバージョン番号 (例: `ffmpeg version 7.1`) が表示されれば OK です。

## 4. ソースコードを取得

GitHub から `git clone` で取得します。
ホームフォルダの直下、または任意の作業フォルダで実行してください。

```bash
git clone https://github.com/pyoru0309/py_tachie.git
cd py_tachie
```

> **インストール場所のおすすめ**:
>
> - macOS: `~/Documents/py_tachie/` または `~/projects/py_tachie/`
> - Windows: `C:\Users\<あなたのユーザー名>\Documents\py_tachie\` (パスに日本語やスペースが入らない場所が無難)
>
> 後述する `projects/` フォルダ (制作データ) もこの中に作られます。
> 制作データを別ドライブに置きたい場合は、起動後に `全体設定 → プロジェクトフォルダ` で別パスを指定できます。

## 5. Python 仮想環境を作る

依存ライブラリを他の Python プロジェクトと混ぜないために、仮想環境 (`.venv`) を作ります。

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### Windows (PowerShell)

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

`Activate.ps1` が実行ポリシーで止められる場合は次のいずれかで対処します。

- 一時的に Bypass で起動: `PowerShell -ExecutionPolicy Bypass`
- コマンドプロンプトで `activate.bat` を使う: `.\.venv\Scripts\activate.bat`

仮想環境が有効になっていると、プロンプトの先頭に `(.venv)` が表示されます。

## 6. サーバを起動する

推奨は次の 1 行です。

```bash
python -m app
```

これは `app/__main__.py` 経由の uvicorn 薄ラッパで、動画書き出しの WebSocket が圧縮で潰れないよう `ws_per_message_deflate=False` を強制し、`reload=True` で開発時のホットリロードも有効にします。

オプションを指定したい場合:

```bash
python -m app --port 8080          # 別ポートで起動
python -m app --host 0.0.0.0       # LAN に公開
python -m app --no-reload          # autoreload を切る (本番想定)
python -m app --workers 2          # ワーカー数を上書き (reload は自動 OFF)
```

uvicorn を直接呼ぶ場合は次の通り (動画書き出しの圧縮事故を避けるため `--ws-per-message-deflate false` が必要)。

```bash
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --ws-per-message-deflate false
```

ターミナルに `Uvicorn running on http://127.0.0.1:8000` という行が出れば成功です。
ブラウザで次の URL を開きます。

```text
http://127.0.0.1:8000/
```

ヘルプドキュメント (このガイドのビルド済み HTML) は次の URL でも確認できます。

```text
http://127.0.0.1:8000/help/
```

GitHub Pages で公開された後は、同じ内容を Web 上でも閲覧できます。

## 7. (任意) JS ライブラリと日本語フォントをローカル化

描画エンジンと動画書き出しで使う three.js / mp4box.js は、既定では `static/vendor/` のローカル版を見て、無ければ jsdelivr の CDN にフォールバックします。社内環境などインターネット非接続で運用する場合は、最初に 1 回だけ取得しておきましょう。

1. ブラウザで <http://127.0.0.1:8000/> を開く。
2. ヘッダーの **全体設定** (歯車アイコン) → 左側の **環境** タブ。
3. **JS ライブラリのインストール** ボタンを押す (npm registry / jsdelivr から取得 → `static/vendor/three/<ver>/` と `static/vendor/mp4box/<ver>/` に展開)。
4. すぐ下の **Noto Sans JP をインストール** で日本語フォントを `assets/fonts/NotoSansJP/` に展開。

「CDN を使う」チェックを付けると、ローカル版があっても CDN を強制利用します (デバッグ用)。

## 最初に見る画面

起動後はプロジェクト一覧またはダッシュボードが表示されます。プロジェクトが存在しない場合は、ヘッダーの `新規` から最初のプロジェクトを作成してください。

編集画面の構成は次のとおりです。

- **上部ヘッダー**: プロジェクト切替、素材再スキャン、キャラ管理、PSD インポート、PNG 出力、MP4 出力、設定、テーマ切替。
- **左/中央**: 1920×1080 のライブプレビュー (canvas)。波形と dB メーター、再生/停止ボタンが下に並びます。
- **右パネル**: 選択中アイテム (カット or テロップ) に応じて中身が差し替わる編集パネル。`キャラ配置` タブと `お芝居` タブが並びます。
- **下部タイムライン**: ruler / 波形 / カット / テロップを 1 枚の canvas に描画。シーンごとに切替可能。

## 基本の作業順

1. プロジェクトを作成または選択する。
2. ダッシュボードからキャラクター素材 (PSD・PNG/WebP・ZIP) を取り込む。
3. シーンに動画背景や BGM を設定する。
4. カットを追加し、キャラ配置・話者・セリフ・モーションを編集する。
5. テロップを追加し、タイムラインで開始・終了・スタイルを整える。
6. 再生ヘッドを動かしてライブプレビューで確認する。
7. PNG または MP4 を書き出す。

## 終了方法

- ブラウザを閉じる。
- サーバを起動しているターミナルで `Ctrl + C` を押す (`Cmd + C` ではなく **Ctrl + C**)。
- 仮想環境を抜けたいときは `deactivate` と入力する。

シナリオは編集ごとに自動保存され、再生ヘッド位置もプロジェクトに保存されます。次回起動時には最後に開いたプロジェクトが自動で開き、再生ヘッドが当時のフレームへ復元されます。

## 次回以降の起動

セットアップ後の起動は次の 3 行だけです。

```bash
cd py_tachie

# macOS / Linux
source .venv/bin/activate
# Windows
.\.venv\Scripts\Activate.ps1

python -m app
```

ソースを最新版に更新するには `git pull` を実行してから依存を入れ直します (`pip install -r requirements.txt`)。
