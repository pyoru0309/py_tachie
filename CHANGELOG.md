# Changelog

このファイルは py_tachie の変更履歴を記録します。
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.2.0] - 2026-06-02

Windows での動画書き出しの実用化を中心とした大型アップデート。書き出し経路を
WebGL → WebSocket → ffmpeg のまま、**ブラウザ内 WebCodecs で H.264 に圧縮してから
送る**方式 (transport=webcodecs-h264) を追加し、Windows の書き出しを大幅に高速化・
安定化しました。あわせて、起動できない/書き出しが固まる Windows 由来の不具合と、
アップデート機能の堅牢化を行いました。

### Added
- **動画書き出しの高速化 (WebCodecs)**: 書き出しダイアログに「高速書き出し
  (WebCodecs)」トグル (既定 ON) を追加。H.264 mp4 プリセットのとき、ブラウザ内で
  H.264 に圧縮してから送り、サーバは ffmpeg `-c copy` でコンテナ化のみ行います。
  ブラウザ→サーバの転送量が 1/数百〜数千 に激減し、特に Windows で書き出しが大幅に
  速くなります。透過 (ProRes/PNG) や非対応ブラウザでは自動的に従来方式へフォール
  バックします。
- **実行環境診断**: 全体設定 → アップデートタブに、Python / websockets / 高速化拡張
  (websockets.speedups) の状態を表示する診断パネルを追加。書き出しが遅くなる構成を
  早期に発見できます。
- **復旧スクリプト**: `tools/recover.bat` (Windows) / `tools/recover.sh` (macOS/Linux)
  を同梱。アップデート失敗で起動しなくなったとき、ダブルクリック等でリモートの最新
  状態へ復旧できます (プロジェクト等のデータは保持)。

### Changed
- **アップデートの適用方式を `git pull` (merge) から `fetch + reset --hard` に変更**。
  作業ツリーが壊れていても確実にリモートと一致させ、ファイル欠落による起動不能を
  防ぎます。
- 「依存パッケージも再インストールする (pip install)」オプションを、`requirements.txt`
  が変更されたアップデートのときだけ表示するようにしました。
- 書き出し用レンダラを `antialias:false` + `preserveDrawingBuffer:false` に分岐
  (プレビューは従来どおり)。Windows で毎フレームの読み出しが MSAA 解決で直列化して
  遅くなる問題を解消しました。

### Fixed
- Windows でサーバ起動直後やアップデート時に、ffmpeg/ffprobe の UTF-8 出力を cp932 で
  デコードしようとして `UnicodeDecodeError` で落ちる問題 (全同期 subprocess を utf-8
  固定)。
- Windows で autoreload 起動時に動画書き出しが `FFMPEG_SPAWN_FAILED` になる問題
  (reload を自動無効化)。
- 背景動画が後半のカットで消える問題 (WebCodecs デコードの出力サーフェスプール枯渇)。
- 動画レイヤーのデコードが特定環境で停止/ハングする問題に対し、deadline 打ち切りと、
  失敗時はそのレイヤーをスキップして書き出しを完走させるフェイルセーフを追加。
- 書き出しのエンコーダ表示が、プリセット利用時に実際と異なるエンジン名 (videotoolbox)
  を出していた誤表示を修正。
- プレビューの smooth モードでキャラクターのドラッグが効かない問題を修正。

### 注記 (既知の制限)
- Windows のブラウザ内 H.264 エンコードはソフトウェア実装になる環境があり、その場合は
  書き出し速度に上限があります (macOS の HW エンコードほどは出ません)。サーバ GPU
  エンコード (NVENC) を活かす中間形式経路は今後検討します。

(本リリースは py_tachie/dev チャネルで先行配信していた一連の変更を、Mac/Windows
両方での検証を経て stable に取り込んだものです。)

## [0.1.3] - 2026-05-25

### Fixed
- 動画レイヤーを多数 (例: 10 本以上) 含むプロジェクトの長時間プレビュー再生で、Chrome のメモリ消費が常時増加していた問題を構造的に解消。シーン全体の動画レイヤーすべてに対して `<video preload=auto>` と clean PCM `<audio preload=auto>` を常駐させていた経路を、「現カット ± lookahead カット」の時間窓内のみに絞るよう変更しました。窓外の `<video>` / `<audio>` / VideoTextureProvider は dispose されます。
- Windows で `project.json` の保存と読み込みが極短時間に並列衝突し、`PermissionError: [Errno 13]` でサーバが例外を投げる (= プレビューが詰まる + ターミナルの Ctrl+C が効かなくなる) 不具合を修正。`write_project_file` を per-project の Lock で直列化し、`read_project_file` の retry に `PermissionError` を追加しました。再生中の playhead 連続保存で踏みやすかった経路です。
- `stopPreviewPlayback()` で pre-built SceneInstance キャッシュも一緒にクリアするように変更 (停止 → 編集 → 再生で古い prefetch が残らないように)。

### Added
- 開発者向け観測ログ `window.__spliteVLPerf = true`。再生中、1 秒間隔で `state.playbackVideoLayerEls` 等の Map サイズと dedup 後の実リソース数、prefetch キャッシュ数、VL group 数を Console に出力します。既存の `window.__spliteCutPerf = true` と組み合わせて切替コストを観測できます。

(本リリースの内容は v0.1.2 公開後に py_tachie/dev チャネルで先行配信していた変更を、Mac/Windows 両方での検証完了を受けて stable に取り込んだものです。)

## [0.1.2] - 2026-05-24

### Added
- ツールバー overflow (`>>`) メニュー: ウィンドウ幅が足りないとき、収まらないボタンを右端の「>>」ボタンを押すとプルダウンメニュー表示する動的振り分け機構を実装。タイムラインが押し下げられず常に 1 段に収まります。サブメニュー (例: 「アイテムを追加」) は overflow に入った場合、右側へ flyout します。

### Changed
- 上段 / 下段ツールバーを `flex-wrap: nowrap` 固定にしてボタンの縦書き崩れを回避。

(本リリースの内容は v0.1.1 公開後に py_tachie/dev チャネルで先行配信していた変更を、検証完了を受けて stable に取り込んだものです。)

## [0.1.1] - 2026-05-24

### Added
- 受信チャネル選択 (stable / dev)。全体設定 → アップデートに `受信チャネル` セレクタを追加。`stable` (= origin/main、安定版) と `dev` (= origin/dev、ナイトリービルド) を切替可能。検証中コードを含むため既定は `stable`。
- `/api/update/{check,apply}` に `channel` パラメータ対応。target branch がローカルに無い場合は origin から自動 checkout して切替する。

### Docs
- user_guide のアップデート章に dev チャネル (ナイトリービルド) 注意書きを追記。

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

[Unreleased]: https://github.com/pyoru0309/py_tachie/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/pyoru0309/py_tachie/releases/tag/v0.1.3
[0.1.2]: https://github.com/pyoru0309/py_tachie/releases/tag/v0.1.2
[0.1.1]: https://github.com/pyoru0309/py_tachie/releases/tag/v0.1.1
[0.1.0]: https://github.com/pyoru0309/py_tachie/releases/tag/v0.1.0
