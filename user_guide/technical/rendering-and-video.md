# レンダリングと動画生成

このページでは、ライブプレビュー / PNG 出力 / 動画書き出しの仕組みを説明します。

立ち絵システムの描画エンジンは **WebGL/three.js (v2)** に統一されています。ライブプレビュー / PNG 出力 / 動画書き出し / プロジェクトサムネイルすべてが、ブラウザ側の同じ GL シーンを通って生成されます。

## 出力キャンバス

出力解像度は **1920×1080 固定** です。
プロジェクト内部の fps (タイムコード基準) は **24 fps 固定**、書き出し fps はそれと独立に **8 / 12 / 24** から選択します。

## 画像レンダリング (PNG / 1 フレーム)

1. シーンの `videoTrack` または カットの `state.background` をキャンバス全体にカバー配置。
2. カット内のキャラクターを `state.characters` の順番に合成。各キャラは次の順で焼かれる: `base` → `cheek` → `eye` → `mouth` → `bangs` → `front`。`eyeAboveBangs=true` のときは `cheek` の後に `bangs` を挿入し、続いて `eye` → `mouth` → `front`。
3. `cuts[].state.foreground` があればキャラの上、セリフ枠の下に重ねる。
4. セリフ枠と本文 (`textStyle`) を描画。
5. 該当時刻にアクティブなテロップを描画。

話者が設定されている場合、話者以外のキャラクターには `非話者の暗さ` が黒オーバーレイとして適用されます。UI 表示 (`darkness`) は **0 = 全く暗くしない**、`0.9` が最も暗い指定です。プロジェクト JSON は内部で逆方向の `inactiveCharacterOpacity` (1 = 暗くしない、0.1 = 最も暗い) として保存されます — UI 層で `darkness = 1 - inactiveCharacterOpacity` の変換を行っています (詳細は後述 *「UI ラベルと内部キーの命名差分」*)。

## 目パチ

`目パチ` が有効で、かつ **カットで選んだ目に `blinkOpen` フラグが立っている** とき、その目を起点に目パチが動きます。`blinkOpen` のない目 (笑い目・ウインク目など) を選んだカットでは目パチをスキップします。
中間/閉じフレームには `blinkHalf` / `blinkClosed` フラグの目をシーン共通で使います (`blinkHalf` は任意、無ければ閉じ目を流用した 2 段目パチにフォールバック)。

カット ID をシードにした決定的な乱数で間隔を決めるため、同じシナリオから何度書き出しても同じ瞬きパターンになります。
1 回の瞬きの内訳はプロジェクト設定の **目パチ方式** (`blinkAlgorithm`、既定 `アニメ方式`) と **アニメ fps** (`characterAnimationFps`、8 / 12 / 24) で決まります。`アニメ方式` は「開き → 閉じ → 中 → 開き」のスナップ閉じ + 段階開き、`均等方式` は各 fps で短く均等な瞬きで、中目なしのキャラはさらに短くなります (詳細は [キャラクターモデル](character-model.md#blink-frame-pattern) を参照)。

フラグの設定は [キャラクターモデル](character-model.md#blink-lipsync-flags) を参照してください。

## 口パク

`口パク` が有効なら、`speakerCharacterId` のキャラクターだけに口パクを適用します。
非話者キャラ / 話者の無音区間 / 口パク OFF では **カット選択の口** がそのまま表示されます (= 「ジト目で `:|` の口」のような意図的な選択が無音区間で維持される)。

- カットに `audio` が設定されているとき: ffmpeg + `numpy` で RMS 音量解析を行い、フレームごとに `lipMid` / `lipOpen` フラグの口に切り替えます。silence しきい値以下はカット選択の口に戻します。
- BGM の `useForLipSync` が ON のシーンでは、その BGM トラック自体を口パクの音声入力として使います。
- `lipMid` 未設定 (= 中口素材なし) の場合、mid 帯域もカット選択の口にフォールバックします。

しきい値・RMS 上限/下限・スムージングはプロジェクト設定で調整できます ([プロジェクト設定リファレンス](../reference/project-settings.md))。

## ライブプレビュー

サーバ側で `/api/v2/scene-bundle` がシーンの描画素材を JSON で返し、ブラウザの three.js シーンが背景 / キャラ / 前景 / セリフ / テロップ / ビジュアライザを並べて描画します。

- 停止中の still 描画も同じ GL シーンを再利用 (再生 → 停止 → 再生で scene の組み直しが起こらない)。
- キャラクターアニメは `characterAnimationFps` (8 / 12 / 24, 既定 12) で量子化されており、書き出し fps と独立に動きます。
- 波形・dB メーターはセリフ用音声と BGM のミックスを表示し、口パク有無を視覚化します。
- `videoTrack` は `<video>` 要素 → VideoTexture として取り込み、ブラウザ合成段ではなく GL シェーダ内で他レイヤーと正しく合成します (glow / shadow / colorFilter が動画背景の上でも崩れない)。
- BGM はカット境界をまたぐため、再生開始時に 1 度だけ起動して通しで鳴らします。

再生は再生ヘッドの位置からシーン末尾まで通しで行います。再生ヘッドの位置は `lastPlayheadFrame` としてプロジェクトに保存され、再起動でも復元されます。

## 動画書き出し (GL → ffmpeg)

書き出しは `/v2-export` ページが受け持つ独立の WebSocket セッションで動きます。

1. ブラウザ側の three.js が 1 フレームずつ GL シーンを描画。
2. WebGL2 PBO (Pixel Buffer Object) を 2〜3 段リングに分けて `clientWaitSync` で完了を待つ非同期 readback を行う。
3. RGBA バッファを `/api/v2/export/ws` 経由で uvicorn に流す (圧縮 OFF: `--ws-per-message-deflate false` 必須)。
4. uvicorn 側は ffmpeg を別プロセスで起動し、rawvideo パイプ → エンコーダ → mp4/mov へエンコード。
5. `videoTrack` / テロップ / `bgmTracks` / セリフ音声は GL シーン側で焼き込み済みのため、ffmpeg では基本的に映像 + 音声 mux だけ。
6. シーン間の `startFrame` のギャップはエンコーダ側でカット境界として処理。

書き出しはダイアログ内で進捗 (フレーム数 / 経過時間 / 推定 fps) をリアルタイムに表示します。
ファイルは `projects/<project_id>/outputs/` 直下に保存されます。

> **実測**: macOS Apple M1 Pro + VideoToolbox で 1080p MP4 (H.264) を 89〜92 fps、Windows 12700H + RTX 3060 Laptop NVENC で 32〜62 fps を確認 (PoC `_dev_docs/v2_export_poc_*` 参照)。

## キャッシュと出力

| 種類 | 保存先 | 説明 |
| --- | --- | --- |
| キャラレイヤー PNG | `projects/<project_id>/cache/preview/` | scene-bundle が焼く `under_<token>.png` / `eye_*.png` / `mouth_*.png` / `over_<token>.png` 等。`<token>` は scene state の SHA1 |
| ビジュアライザ stream | `projects/<project_id>/cache/viz/` | per-cut の解析データ (`<token>_<stream>.bin`、float32 / int8 等)。GL plugin が fetch して描画 |
| サムネ | `projects/<project_id>/cache/thumbnail.png` | プロジェクト一覧用 (GL canvas の `toBlob('image/png')`) |
| PNG 出力 | `projects/<project_id>/outputs/` | 明示的に保存した静止画 (GL canvas の snapshot) |
| 動画出力 | `projects/<project_id>/outputs/` | シナリオから生成した動画 (`/api/v2/export/ws` → ffmpeg) |

## 必要な外部ツール

- `ffmpeg` / `ffprobe`: 動画書き出しと音声解析に必須。
- 全体設定の `ffmpeg のパス` で絶対パスを指定可能 (NVENC 対応 ffmpeg を別ディレクトリに置いている場合など)。

## レンダ高速化メカニズム

- **GL scene の hash token + skip-bake**: scene 単位で payload に hash token を付け、scene 内容が変わらない限り three.js のリソースを reuse する (token に viz spec も含まれる)。
- **bg / fg は direct texture**: 背景・前景は cover/contain 配置と blur シェーダを GL 内で実行し、サーバ側の PNG 焼き込みを介さない。
- **WebGL2 PBO 非同期 readback (export)**: `clientWaitSync` を timeout=0 polling + `setTimeout(0)` yield で回し、Chrome の WAIT_FAILED 永続化を回避してフレームロスゼロで読み出す。
- **`/api/v2/scene-bundle`**: dialogue layout は Python 側で計算 (`compute_dialogue_layout`)、テロップ raw 値も含めて 1 リクエストで返す。
- **音声プリフェッチ**: ライブプレビューはカット切替の途切れを抑えるため、再生中に次カット (および再生開始時に残り全カット) の wav を `<audio preload="auto">` で先読みします。
