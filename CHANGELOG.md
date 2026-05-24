# Changelog

このファイルは py_tachie の変更履歴を記録します。
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.1.0] - 2026-05-24

初回公開リリース (Private)。初回 commit (2026-05-22) からタグ付けまでに NFC 正規化補強・アプリ内アップデータ・ビジュアライザーのレイヤー順再構成 (`below_bg` 新設)・カット切替時の音声途切れ解消 (audio.play() と buildScene の並列化)・scene 事前 build memory cache・プレビュー表示品質オプション (sharp/smooth)・キャッシュ retention の時間単位化、などを取り込んでいます。

### 主な機能

- **PSD レイヤー付きキャラクター** の取り込みと立ち絵合成
  - 表情プリセット (目・口・髪) の組み合わせ管理
  - キャラクター単位の `removeWhite` / `antialiasBlackLine` 設定
  - 口パク (`speakerCharacterId` 単体)・目パチ (表示中キャラ全員) の自動同期
- **シナリオ編集 UI** (vanilla HTML/CSS/JS、フレームワーク非依存)
  - v3 シナリオフォーマット (`state.characters` 配列形式) / 旧形式からの自動変換
  - カット・テロップ・効果音・BGM トラック・動画レイヤー・ビジュアライザの統合タイムライン
  - スナップ (再生ヘッド/カット境界/BPM/他端/グリッド) + クロスタイプ選択 + リンク追従
  - 自動バックアップ (周期/切替時/復元前)、複数世代の保持と一覧復元
- **WebGL ベースのプレビュー** (Three.js)
  - リアルタイム再生・PNG 書き出し・動画書き出し・サムネ生成を統一経路で実行
  - シーンバンドル機構 (`sceneOverride` で disk 読込より live state を優先)
- **1920×1080 MP4 書き出し**
  - HW エンコーダ優先 (h264_videotoolbox / nvenc) + ソフトウェアフォールバック
  - 録画素材の PTS gap 検査と再エンコード正規化
  - クリーン PCM 経由の音声同期 (録画素材の AAC PTS gap 対策)
- **TTS 連携**
  - VOICEVOX / Voicepeak (style / emotion をキャラ別に保存)
  - 音声プロジェクト経由の素材管理と未使用フィルタ
- **テキストエフェクトシステム**
  - kind = caption / mv_text / composition の 3 区分
  - エフェクトプリセット 8 種: `fade_slide` / `typewriter` / `neon_glow` / `rgb_shift` / `pop_per_char` / `glitch_scan` / `shake_beat` / `huge_handwritten` (撤去) / `poster_typography`
  - アニメーション in/out/body の独立スロット
  - サーバ側で禁則処理 (`LINE_START/END_FORBIDDEN`)
- **タイトル組版エディタ** (`/title-editor`)
  - プロジェクト横断ストア (`title_compositions/`)
  - ink-aware bbox によるピクセル単位の整列・スナップ
  - 位置プリセット 3×3 / 光彩 / ドロップシャドウ / オプティカルカーニング
- **ビジュアライザプラグイン** (13 種)
  - 波形・スペクトラム・パーティクル・LED グリッド・ジオメトリック背景等
- **多言語対応の準備**
  - 日本語 (LINE Seed JP / Shippori Mincho B1 / M PLUS Rounded / Zen Maru Gothic) を想定したフォント設計
  - ライト / ダークテーマ切替 + `prefers-color-scheme` 連動

### 非機能

- ライセンス: MIT
- 出力解像度: 1920×1080 固定
- 依存: Python 3.11+ / Pillow / FastAPI / ffmpeg (システムインストール)
- 同梱しないもの:
  - フォント (全体設定からユーザーがインストール)
  - 効果音 (将来的にコード生成版で再導入予定)
  - その他キャラクター素材 (権利上の理由)
- 同梱するもの:
  - キャラクター素材: `maki_py`, `moca_py` (作者: pyoru0309 / 改変自由)
  - 背景・前景・装飾画像・音声: `assets/audio`, `backgrounds`, `foregrounds`, `overlays` (作者: pyoru0309 / 改変自由)

[Unreleased]: https://github.com/pyoru0309/py_tachie/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pyoru0309/py_tachie/releases/tag/v0.1.0
