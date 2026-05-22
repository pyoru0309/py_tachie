# ファイル構成

このページでは、立ち絵システムが作成・参照する主なファイルを説明します。

## リポジトリ直下

| パス | 用途 |
| --- | --- |
| `app/__main__.py` | `python -m app` 起動ラッパ (uvicorn 起動オプションを集約) |
| `app/` | FastAPI サーバと合成・書き出しロジック (`main.py` / `compositor.py` / `render.py` / `export_video.py` / `v2_export.py` / `vendor.py` / `fonts.py` / `project_archive.py` / `project_import.py` ほか) |
| `static/` | ブラウザ UI の HTML / CSS / JavaScript (モジュール分割済み) |
| `static/vendor/` | three.js / mp4box.js のローカル取得先 (`active.json` で現行 version) |
| `assets/` | 共通素材 (キャラ / 背景 / 動画 / 音声 / フォント / 装飾) |
| `assets/fonts/NotoSansJP/` | 「Noto Sans JP をインストール」で取得する static OTF 7 weight (Thin / Light / DemiLight / Regular / Medium / Bold / Black) |
| `projects/` | プロジェクトごとの制作データ |
| `app_state/` | 起動中プロジェクトと全体設定 (`global_config.json`) |
| `cache/` | レイヤーキャッシュ・PSD インポータの中間ファイル等 |
| `outputs/` | 共通の旧出力置き場 (実運用ではプロジェクト配下に保存) |
| `tools/` | PSD 取り込みなど CLI |
| `docs/` | zensical ビルド済みヘルプ (UI から `/help/` で配信) |
| `user_guide/` | このガイドの Markdown ソース |
| `dev_docs/` / `_dev_docs/` | 開発検討メモ・スクリーンショット |
| `requirements.txt` | Python 依存 |
| `README.md` | プロジェクト概要 (PSD レイヤー命名規則とシナリオデータ仕様は `user_guide/technical/` 配下に集約) |
| `zensical.toml` | ヘルプドキュメントのビルド設定 |

## プロジェクト配下

```text
projects/<project_id>/
  project.json
  config.json
  expression_presets.json
  scenarios/
    main.json
  assets/
    characters/
    backgrounds/
    videos/
    audio/
    fonts/
    overlays/
  generated/
    manifest.json
  cache/
    preview/           (scene-bundle が焼くキャラレイヤー PNG)
    lipsync/           (口パク解析の per-cut level バイナリ `lvl_<token>.bin`)
    viz/               (ビジュアライザの per-cut binary stream)
    thumbnail.png      (プロジェクト一覧用のサムネ)
  outputs/
  thumb.png        (任意。一覧表示用)
```

## `project.json`

プロジェクトの基本情報を保存します。

| 項目 | 説明 |
| --- | --- |
| `version` | プロジェクト情報レコードのバージョン (歴史的経緯で 1 のまま) |
| `schemaVersion` | 論理スキーマのバージョン (現行 4)。ZIP 取り込み時の migration 判定に使う |
| `id` | プロジェクト ID (フォルダ名と一致) |
| `title` | 画面に表示するプロジェクト名 |
| `currentScenario` | 現在のシナリオパス (相対) |
| `createdAt` / `updatedAt` / `lastOpenedAt` | 各種日時 |
| `lastPlayheadFrame` | ライブプレビューの再生ヘッド位置 (フレーム) |

## `config.json`

文字 / セリフ枠 / 動画 / 口パク解析 / フォント候補などの設定を保存します。
詳しくは [プロジェクト設定リファレンス](project-settings.md) を参照してください。

## `expression_presets.json`

プロジェクト固有の表情プリセットを保存します。各エントリは `{id, name, characterId, cheekId, eyeId, mouthId, isDefault}` で、頬・目・口の組合せです。

アセット側 (`assets/characters/<id>/expression_presets.json`) と二段マージされ、同 (characterId, presetId) はプロジェクト側が優先 (override) です。詳細は [キャラクターモデル](../technical/character-model.md#expression-presets) を参照してください。

## `scenarios/main.json`

シーン配列とカット配列、各カットの音声・背景・キャラクター状態・セリフ、シーンの動画背景・BGM・テロップを保存します。
詳しくは [シナリオ形式](../technical/scenario-format.md) を参照してください。

## `generated/manifest.json`

素材再スキャンで生成される素材一覧です。
通常は手で編集せず、素材追加後に `素材再スキャン` で更新します。
キャラクターは `backHairs` / `bases` / `cheeks` / `eyes` / `mouths` / `bangs` / `fronts` の 7 リストとして格納されます。

## `cache/`

プロジェクト固有キャッシュ (`projects/<id>/cache/` 配下):

| パス | 用途 |
| --- | --- |
| `cache/preview/` | scene-bundle が焼くキャラレイヤー PNG (`<token>_<charId>_under.png` / `<token>_<charId>_eye_open.png` / `<token>_<charId>_mouth_default.png` / `<token>_<charId>_over.png` 等)。`<token>` は scene state の SHA1 で、設定が変わらなければ同じファイル名を使い回す |
| `cache/lipsync/` | 口パク解析結果 `lvl_<token>.bin` (per-cut の amplitude envelope)。サーバ側で計算してブラウザの口パク shader に渡す |
| `cache/viz/` | ビジュアライザの per-cut binary stream (`<token>_<stream>.bin`)。FFT スペクトル / 波形 PCM / オンセット envelope などをブラウザの GL plugin に渡す |
| `cache/thumbnail.png` | プロジェクト一覧用のサムネイル (GL canvas の `toBlob('image/png')` 結果) |

リポジトリ直下の共有キャッシュ (`cache/` 配下):

| パス | 用途 |
| --- | --- |
| `cache/clean_pcm/` | 動画レイヤー音声の PTS gap 補正済み連続 PCM (`<sha1>.wav` + `<sha1>.map.json`)。録画素材を VL に貼ったときに 1 度だけ生成し、全プロジェクトで共有される |
| `cache/psd-importer/` | PSD インポートの中間ファイル (`cleanup_old_psd_importer_sessions` で古いものは自動削除) |

`cache/` は安全にまるごと削除できます。次回再生 / 書き出し時に必要分だけ再生成されます。アプリ内では **アセット管理 → キャッシュ タブ** から個別 / 共有 / 全体を削除できます (詳細は [素材管理 — キャッシュタブ](./assets.md#キャッシュタブ))。起動時の mtime ベース自動間引きも `全体設定 → キャッシュ` で ON/OFF できます (既定 30 日)。

## `app_state/global_config.json`

全体設定 (動画プリセット / ffmpeg のパス / プロジェクトフォルダ / Undo 履歴サイズ / quietMode / `vendor.useCdn` / `fontWeightOverrides` / `tts.voicevoxAppPath` / `tts.voicevoxBaseUrl` / `tts.voicepeakBinPath` / `backup.autoIntervalMinutes` / `backup.autoRetentionCount` / `cache.autoPruneOnStartup` / `cache.autoPruneOlderThanDays` 等) を保存します。
複数のリポジトリで使い回したい場合は、このファイルを共有 / バージョン管理から外すなどで運用してください。

## `app_state/voice_catalog.json`

VOICEVOX / VOICEPEAK の話者・スタイル・感情の最新カタログ (全体設定 → 音声読み上げ → 「ボイスを登録」で取得) を保存します。話者の追加 / アップデート時に再取得して書き換わります。

## `static/vendor/active.json`

three.js / mp4box.js のローカル取得状況を記録します。サーバが HTML を返すときの `<script type="importmap">` 解決はこのファイルを読みます (`{"three": "0.165.0", "mp4box": "0.5.2"}` のような形)。

各ライブラリは `static/vendor/<lib>/<version>/` 配下に展開され、`active.json` で「現行 version」を切替えます。古い version は残置でき、ロールバックも可能です。

## プロジェクト ZIP アーカイブの構造

ダッシュボードの `アーカイブ` で書き出される zip は、トップに `<project_id>/` を 1 段持ちます。

```text
<project_id>.splite.zip
└── <project_id>/
    ├── project.json
    ├── config.json
    ├── expression_presets.json
    ├── scenarios/main.json
    └── assets/
```

`cache/` / `outputs/` / `exports/` / `generated/` は除外されます。共通アセット (`assets/characters/<id>/`) は含まれません。
