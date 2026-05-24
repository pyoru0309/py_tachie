# 立ち絵システム ユーザーガイド

立ち絵システムは、ローカル環境で動作する紙芝居風アニメーションの制作ツールです。
PSD レイヤー付きキャラクター・PNG/WebP 立ち絵・動画背景・BGM・セリフ・音声・テロップを組み合わせて、1920×1080 の MP4 / MOV / MKV を書き出せます。

シナリオの構造はシーン (`scene`) を最外として、その中に **カット (`cut`)** と **テロップ (`telop`)** が並列に並びます。カットは話者・セリフ・キャラ配置のひとまとまりで、テロップはカットと独立してシーン全体に対して任意区間に置けます。

- ソースコード: <https://github.com/pyoru0309/py_tachie/>
- インストール手順: [はじめに](tutorials/getting-started.md) (ターミナルの開き方・Git・Python・ffmpeg の入手まで含む丁寧版)

## 紹介動画

本ツールで作った紹介動画をニコニコ動画で公開しています。立ち絵・セリフ・テロップ・効果音・BGM の組み合わせで、どんな仕上がりになるかご覧いただけます。

<iframe width="640" height="360" src="https://embed.nicovideo.jp/watch/sm46350304" frameborder="0" allowfullscreen></iframe>

- 視聴ページ: <https://www.nicovideo.jp/watch/sm46350304>

## このガイドの使い方

- 初めて使う場合は [はじめに](tutorials/getting-started.md) → [プロジェクトを作成する](tutorials/create-project.md) → [キャラクターをインポートする](tutorials/import-character.md) → [PNG / 動画を書き出す](tutorials/export-video.md) の順で読んでください。
- 音声を VOICEVOX / VOICEPEAK で自動生成したい場合は [音声合成 (VOICEVOX / VOICEPEAK) を使う](tutorials/voice-synthesis.md) を参照してください。
- 編集画面の各ボタン・パネルの意味は [編集画面リファレンス](reference/editor.md) にまとまっています。
- OP / EP のタイトル・章扉・ロゴ風コピーなど、本編とは独立した組版を作るには [タイトル組版エディタ](reference/title-editor.md) を使います。
- ファイル構成や永続化される JSON の仕様は [ファイル構成](reference/file-structure.md) と [シナリオ形式](technical/scenario-format.md) を参照してください。
- キャラ素材を新規に作る場合は [キャラクターモデルの推奨構成](technical/character-model.md) と [PSD レイヤー命名規則](technical/psd-layer-rules.md) を確認してください。
- 動画書き出しのエンコーダ詳細やレンダリングの仕組みは [レンダリングと動画生成](technical/rendering-and-video.md) を読んでください。
- 自作のオーディオビジュアライザを書きたい開発者は [オーディオビジュアライザ開発ガイド](technical/visualizer-plugin.md) を参照してください。
- うまく動かない時は [トラブルシュート](troubleshooting.md) からどうぞ。

## 主な機能

- プロジェクトごとの制作データ管理 (シナリオ・設定・素材・出力)
- シーン単位の動画背景 (`videoTrack`) と BGM (`bgmTracks`)、カット単位のセリフ・音声
- 7 カテゴリ (back_hair / base / cheek / eye / mouth / bangs / front) のキャラクター合成、複数キャラ同時表示
- 表情プリセット (頬 + 目 + 口) と髪型プリセット (ベース + 前髪 + 後ろ髪) の保存・呼出し。アセット定義に保存すれば全プロジェクトで自動共有
- 配布用 `import_manifest.yml` (PyYAML) で 1 PSD / 1 ZIP に flags / preset / メタを完結同梱可能
- 目パチ / 口パク (音量解析) を MP4 出力に反映
- PSD・階層 PNG/WebP フォルダ・ZIP からのキャラクターインポート
- WebGL/three.js によるライブプレビュー (停止中の still 描画も同じ GL シーンを再利用)
- フレーム単位 (project fps = 24) のタイムコード、テロップの一括追加とスタイル一括反映
- 動画書き出しは GL → ffmpeg パイプ (MP4 H.264/H.265 ・ProRes 422 Proxy/HQ ・ProRes 4444 ・QuickTime PNG。後 2 つはアルファ付き透過動画対応)
- VOICEVOX / VOICEPEAK と連携した編集画面からの音声合成、YAML 一括登録対応
- ハードウェアエンコーダ (NVENC / VideoToolbox) を `ffmpeg -encoders` で自動検出
- プロジェクトの ZIP アーカイブ書き出し / 取り込み (取り込み時にスキーマ migration を自動適用)
- three.js / mp4box.js / Noto Sans JP を全体設定からローカルへ取得 (オフライン運用対応)
- Undo / Redo、テーマ切替 (ライト / ダーク)

## 動作環境

開発時に動作確認している構成です。

| 構成 | OS | CPU | GPU | メモリ |
| --- | --- | --- | --- | --- |
| macOS | macOS 15 (Sequoia) | Apple M1 Pro 以上 | 内蔵 (VideoToolbox) | 16 GB+ |
| Windows | Windows 11 | Intel Core i7-12700H | NVIDIA GeForce RTX 3060 Laptop | 16 GB |

最低ライン: Python 3.11 以上、ffmpeg / ffprobe、メモリ 8 GB。
ブラウザは Chrome / Edge / Safari の最新版を想定しています。

## 出力仕様

- 出力解像度は 1920×1080 で固定です。
- フレームレートは書き出しダイアログで 8 / 12 / 24 fps から選択します。
- PNG / 動画ファイルは `projects/<project_id>/outputs/` に保存されます。
- ライブプレビューは WebGL/three.js でリアルタイム描画され、`projects/<project_id>/cache/preview/` 配下のキャラレイヤー PNG (state hash でファイル名固定) を再利用します。

## ドキュメントのビルド

このガイドは Zensical 用の Markdown として `user_guide/` に配置されています。HTML を生成するにはリポジトリのルートで次を実行します。

```bash
zensical build
```

ビルド後の HTML は `docs/` に出力され、立ち絵システム本体を起動した状態で `http://127.0.0.1:8000/help/` から閲覧できます。
GitHub Pages 公開後は同じ内容を Web 上でも閲覧できます (リポジトリ: <https://github.com/pyoru0309/py_tachie/>)。
