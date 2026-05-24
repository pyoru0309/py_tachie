# オーディオビジュアライザ開発ガイド

立ち絵システムの **オーディオビジュアライザ** は、シーン内に「波形」「スペクトログラム」「カウントダウン」のような時間連動レイヤを差し込む仕組みです。プラグイン形式で実装でき、`plugins/visualizers/<key>.py` と `static/js/visualizers/<key>.js` の 2 ファイルを 1 セットで追加すれば UI から選択できます。

このページは、新しいビジュアライザを書きたい開発者向けの実装ガイドです。

## 全体像

描画は WebGL/three.js (ブラウザ側 GL シーン) に統一されています。プラグインは **GL plugin の `createVisualizerLayer` を実装することが必須** で、ライブプレビュー / 動画書き出し / サムネのすべてに同じ経路で反映されます。

旧 Python `render(ctx) -> PIL.Image.Image` (Pillow + Canvas2D) 経路は撤去済みです。サーバ側プラグインは「ユーザ向け UI スキーマ (NAME / PARAMS / GL_MODULE) の宣言」と「(任意) 音声解析データを per-cut の binary stream として焼き出す `gl_data_streams`」だけを担当します。

## ファイル構成

新しい `awesomeviz` プラグインを足すなら、最低 2 ファイル:

```text
plugins/visualizers/awesomeviz.py     # サーバ側 (UI スキーマ + 解析データ)
static/js/visualizers/awesomeviz.js   # ブラウザ側 (GL plugin、createVisualizerLayer)
```

`awesomeviz.py` の上端で `GL_MODULE = "/static/js/visualizers/awesomeviz.js"` を宣言すると、サーバが「このプラグインは GL 経路を持っている」と判定し、scene-bundle の `viz.gl.module` にこのパスを乗せます。ブラウザは動的 import → `createVisualizerLayer(ctx)` を呼んで Object3D を生成します。

サーバ側プラグインは起動時に **`plugins/visualizers/*.py` を自動走査** (`app.visualizer.discover_plugins`) します。ファイル名先頭が `_` のものは無視されます。

## サーバ側プラグインの contract

最低限以下の **モジュール変数** を露出してください。

```python
# plugins/visualizers/awesomeviz.py
KEY = "awesomeviz"          # 内部キー (シナリオに保存される)
NAME = "Awesome Visualizer"  # UI 表示名
PARAMS = [...]               # ユーザー設定可能なパラメータ仕様

GL_MODULE = "/static/js/visualizers/awesomeviz.js"   # 必須
GL_VERSION = 1                                        # 任意 (省略時 1)
GL_FRAME_RATE = 24                                    # 任意。plugin が希望する更新粒度 (省略時は project の characterAnimationFps)

# 音声解析が必要な場合のみ実装する (任意)
def gl_data_streams(params, audio, time_grid_sec, fps) -> dict[str, np.ndarray | dict]:
    ...
```

`GL_MODULE` が宣言されていないプラグインは UI に出さずスキップされます (起動ログに `[visualizer] skipping <file>: GL_MODULE が定義されていません` が出ます)。

### `PARAMS` の書き方

UI に表示するフォーム項目を宣言します。`type` は次のいずれかです。

| type | 入力 UI | 値の型 |
| --- | --- | --- |
| `number` | スライダ + 数値 | `float` (`min` / `max` / `step` 任意) |
| `color` | カラーピッカー + HEX 入力 | `str` (`"#rrggbb"`) |
| `select` | ドロップダウン | `str`、`options=[{"value", "label"}]` で選択肢を列挙 |
| `font` | フォント family セレクタ | `str` (内部 ID、空文字 `""` でプロジェクト既定) |
| `font_weight` | フォント太さセレクタ | `str` (内部 ID、`"regular"` / `"bold"` 等) |

例:

```python
PARAMS = [
    {"key": "color",      "type": "color",  "default": "#ffffff", "label": "色"},
    {"key": "lineWidth",  "type": "number", "min": 1, "max": 32, "step": 1,
     "default": 4,        "label": "線の太さ (px)"},
    {"key": "mode",       "type": "select", "default": "outer",   "label": "向き",
     "options": [
         {"value": "outer", "label": "外側のみ"},
         {"value": "both",  "label": "内外両側"},
     ]},
]
```

`default` を必ず設定してください。サーバ側の `merge_params` は `PARAMS` の defaults を base にユーザー入力で上書きするため、`PARAMS` に列挙されていないキーは UI に出ず、`ctx.params` にも入りません。

### `gl_data_streams(params, audio, time_grid_sec, fps)`

per-cut で「フレームごとに事前解析した値」をブラウザに渡したいとき (FFT スペクトル / 波形 PCM / オンセット envelope 等) に実装します。音声不要の plugin (countdown 等) では未定義で OK。

引数:

| 名前 | 型 | 内容 |
| --- | --- | --- |
| `params` | `dict[str, Any]` | ユーザ入力 (defaults とマージ済) |
| `audio` | `AudioContext` または `None` | scene 内の連続 PCM (mono float32 [-1, 1])。`audio.window(t, L)` / `audio.spectrum_db(t, ...)` / `audio.amplitude_db(t, ...)` などで切り出す |
| `time_grid_sec` | `np.ndarray` | per-cut の各フレーム秒 (`cut_start_sec + i / fps` の配列) |
| `fps` | `int` | 解析 fps (= `GL_FRAME_RATE` または project の characterAnimationFps) |

戻り値: `{stream_name: np.ndarray (float32)}` または `{stream_name: {"data": ndarray, "dtype": "int8" | ..., "scale": float, "offset": float}}`。

```python
def gl_data_streams(params, audio, time_grid_sec, fps):
    """time_grid_sec[i] (cut 内の各フレーム秒) ごとに解析を走らせて Float32 配列を返す。"""
    n_frames = int(np.asarray(time_grid_sec).size)
    bands = max(8, int(params.get("bands") or 96))
    if audio is None or n_frames <= 0:
        return {"spectrum": np.full((max(0, n_frames), bands), -120.0, dtype=np.float32)}

    out = np.empty((n_frames, bands), dtype=np.float32)
    for i, t in enumerate(time_grid_sec):
        out[i] = audio.spectrum_db(float(t), n_bands=bands)
    return {"spectrum": out}
```

### AudioContext のヘルパ

`AudioContext` は scene 全体の連続 PCM (mono float32 [-1, 1]) を保持し、以下のヘルパが使えます (詳細は `app/visualizer.py`):

```python
# 低レベル
audio.window(time_sec, length_sec=0.05) -> np.ndarray   # mono float32 PCM 窓
audio.amplitude_db(time_sec, length_sec=0.05) -> float  # RMS dBFS (-120..0)
audio.spectrum_db(time_sec, n_bands=64, window_sec=0.05,
                  fmin=30.0, fmax=14000.0) -> np.ndarray  # log ビン化 dBFS

# 共通ヘルパ (プラグインで再実装されがちなものを集約)
audio.normalized_spectrum(time_sec, n_bands=64, window_sec=0.05,
                          fmin=30.0, fmax=14000.0,
                          db_floor=-75.0, db_ceil=-20.0) -> np.ndarray
    # spectrum_db を [db_floor, db_ceil] で 0..1 に正規化したもの
audio.energy_bands(time_sec, n_subbands=4) -> np.ndarray
    # [full, lo, mid, hi] の正規化エネルギー (n_subbands=1 なら [full] だけ)

# 時間軸全体に対するヘルパ (gl_data_streams 内で使う)
audio.onset_envelope(time_grid_sec) -> np.ndarray  # (N,) 自己正規化済み (0..1)
audio.beat_grid(time_grid_sec, threshold=0.55,
                min_interval_sec=0.18) -> np.ndarray  # (N,) 0/1 のビートフラグ
```

`window(t, L)` は「時刻 t の右端から L 秒前」の窓を切り出します。`spectrum_db` は内部で Hann 窓 + rfft + log 軸ビン化までやります。

`audio` が `None` (= 「ビジュアライザ用音源」がカット側で設定されていない) の場合は **音量ゼロ相当のストリーム** (例: 全要素 `-120.0` の spectrum) を返すと、ブラウザ側でも自然にフォールバック表示できます。

## ブラウザ側 GL プラグインの contract

ファイル `/static/js/visualizers/<key>.js` で次を export してください。

```js
export async function createVisualizerLayer(ctx) {
  return {
    object3D,           // THREE.Object3D。scene にそのまま add される
    update(frameState), // 毎フレーム呼ばれる。texture.needsUpdate = true で反映
    dispose(),          // scene 切替時に呼ばれる。geom / mat / texture の解放
  };
}
```

### `ctx` (createVisualizerLayer の引数)

| キー | 型 | 内容 |
| --- | --- | --- |
| `THREE` | `module` | three.js モジュール (バージョン整合のため呼び側から渡す) |
| `renderer` | `THREE.WebGLRenderer` | メインレンダラ (普段は使わなくて OK) |
| `width` / `height` | `1920` / `1080` | canvas サイズ (固定) |
| `params` | `object` | ユーザー入力 (Python の `PARAMS` と同じキー) |
| `audioData` | `{ [streamName]: Float32Array }` | サーバが書き出した per-cut バイナリ (旧 plugin 互換、復号済 float32) |
| `streamShapes` | `{ [streamName]: number[] }` | 各ストリームの shape (例 `spectrum: [N_frames, bands]`) |
| `streamMeta` | `{ [streamName]: { array, dtype, scale, offset } }` | 圧縮 dtype を扱う新 plugin 向け。`_kit.js` の `sliceStreamRow` / `readStreamScalar` と組み合わせる |
| `frameDurationSec` | `number` | visualizer 更新粒度 (例 `1/12`) |
| `frameCount` | `number` | cut 内の visualizer フレーム数 |
| `cutStartSec` | `number` | scene 内での cut 開始秒 |
| `sceneTotalSec` | `number` | scene 全体の長さ (countdown 等で使う) |
| `fontResolver(familyId, weightId)` | callable | `{family: cssStack, weight: "400"}` を返す |
| `background` | `object` | 自分より下のレイヤーの見た目情報 (色 / 平均色 / 輝度 / 反対色 / source)。詳細は次節 |

### `ctx.background` (背景情報)

「自分より下のレイヤー (= 背景画像 / 動画 / 単色)」を要約した情報。加算合成を避けたいか、影を足すか、色を一段濃くするか、など plugin 側で **背景に応じて自動調整** するために使う。

```js
ctx.background = {
  color: "#ffffff" | null,            // 単色背景 (solid) のときだけ HEX、そうでなければ null
  averageColor: "#c8c8d0",            // 画像/動画はサムネイルから平均色、単色なら同値
  luminance: 0..1,                    // WCAG 相対輝度 (sRGB ガンマ補正済)
  isLight: true | false,              // luminance > 0.5
  contrastColor: "#111111" | "#f4f4f4", // 視認性が確保される反対色 (近似)
  source: "solid" | "image" | "video" | "mixed" | "unknown",
};
```

実装は `static/js/visualizers/_kit.js` の以下のヘルパを使って計算される (プラグインからも import 可):

```js
import {
  backgroundInfoFromColor,    // (hex, { source }) → 上記 dict
  backgroundInfoFromImage,    // (HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, { source, sampleSize }) → 上記 dict
  defaultBackgroundInfo,      // gray (luminance=0.5) フォールバック
  relativeLuminance,          // (r, g, b) → 0..1
  pickContrastColor,          // (luminance) → "#111111" or "#f4f4f4"
} from "/static/js/visualizers/_kit.js";
```

サンプリング戦略:
- **単色**: HEX を直接 luminance 計算 (即時)
- **画像**: 16x16 のオフスクリーン canvas に縮小描画 → 平均 RGB (scene 構築時 1 回)
- **動画**: 同じく 16x16 サンプリング (現状 1 回。動的更新は将来課題)
- **読めない (CORS / 未ロード)**: gray (luminance=0.5) にフォールバック

利用例 (背景が明るすぎる場所では加算合成を抑える):

```js
const bg = ctx.background || { isLight: false };
const blendMode = bg.isLight ? THREE.NormalBlending : THREE.AdditiveBlending;
// テキスト系 plugin で「背景を見て自動で文字色を選ぶ」ときも、参考までに:
const autoTextColor = bg.contrastColor;  // ユーザが明示的に色を指定していない時のフォールバック向け
```

### 共通ヘルパ `_kit.js`

繰り返し書きがちなパターンを `static/js/visualizers/_kit.js` にまとめてあります。新規プラグインは積極的に使ってください (既存プラグインは挙動互換のためそのまま)。

```js
import {
  createCanvasPlane, disposeCanvasPlane,    // CanvasTexture + DoubleSide plane の生成 / 解放
  numParam, clamp, clamp01,                  // 0 を有効値として扱う数値取り出し
  hexToColor, hexToRgba,                     // HEX → THREE.Color / "rgba(...)" 文字列
  decodeStreamArray,                         // ArrayBuffer + meta → TypedArray (dtype 復号)
  sliceStreamRow, readStreamScalar,          // stream の frameIdx 行 / スカラー値を取り出す
} from "/static/js/visualizers/_kit.js";
```

CanvasTexture を使う典型的な plugin は次のように書けます。

```js
import { createCanvasPlane, disposeCanvasPlane, numParam, hexToRgba } from "/static/js/visualizers/_kit.js";

export async function createVisualizerLayer(ctx) {
  const plane = createCanvasPlane(ctx.THREE, ctx.width, ctx.height);
  // plane: { canvas, c2d, texture, geom, material, mesh }

  function update(frameState) {
    plane.c2d.clearRect(0, 0, plane.canvas.width, plane.canvas.height);
    plane.c2d.fillStyle = hexToRgba(ctx.params.color, numParam(ctx.params.opacity, 0.9));
    plane.c2d.fillRect(0, 0, plane.canvas.width, plane.canvas.height);
    plane.texture.needsUpdate = true;
  }
  function dispose() { disposeCanvasPlane(plane); }
  return { object3D: plane.mesh, update, dispose };
}
```

### `frameState` (update の引数)

| キー | 内容 |
| --- | --- |
| `elapsedSec` | **cut-local** 経過秒 (= playback の量子化済み)。`0` で cut 先頭 |
| `sceneSec` | scene 内通算秒 = `cutStartSec + elapsedSec`。countdown 等「scene 全体の残時間」を扱う場合はこちら |
| `frameIdx` | cut-local visualizer frame idx (= `floor(elapsedSec / frameDurationSec)`) |

> **重要**: `elapsedSec` は cut-local です (2026-05-05 整理。`feedback_gl_visualizer_elapsedsec_is_cut_local.md`)。scene 全体の通算秒が欲しい時は必ず `sceneSec` を使ってください。`gl_data_streams` 側の time_grid も `cut_start_sec + i / fps` で per-cut N_frames 行を焼くので、`frameIdx` は **cut-local index** です。

### 標準実装パターン

オフスクリーン canvas に描いて CanvasTexture として GL plane に貼るのが基本パターンです。

```js
export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, audioData, streamShapes, frameCount } = ctx;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const c2d = canvas.getContext("2d");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // Y-down OrthographicCamera + DoubleSide (3D 反転対策)
  const geom = new THREE.PlaneGeometry(canvas.width, canvas.height);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(canvas.width / 2, canvas.height / 2, 0);
  mesh.frustumCulled = false;

  let lastFrameIdx = -1;
  function update(frameState) {
    const idx = Math.max(0, Math.floor(Number(frameState?.frameIdx) || 0));
    if (idx === lastFrameIdx) return;  // 再描画スキップ
    lastFrameIdx = idx;

    c2d.clearRect(0, 0, canvas.width, canvas.height);
    // ... ここで audioData[*] と params から canvas に描く ...
    texture.needsUpdate = true;  // 1 回 upload
  }

  function dispose() {
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  // 初期 1 frame は最初に焼いておく (透明のまま render される事故を防ぐ)
  update({ frameIdx: 0 });

  return { object3D: mesh, update, dispose };
}
```

バー、粒子、リボンのように WebGL のジオメトリで直接表現したい場合も、同じ
contract のまま `THREE.Object3D` / `THREE.InstancedMesh` / `THREE.Points` /
`THREE.Mesh` を返せます。この場合は canvas upload を行わず、`update()` で
`BufferAttribute.needsUpdate`、`instanceMatrix.needsUpdate`、shader uniform などを
更新してください。`depthTest: false` / `depthWrite: false` / `transparent: true` /
`toneMapped: false` / `side: THREE.DoubleSide` は CanvasTexture 版と同じく指定するのが
安全です。

#### 必須の落とし穴 (整理済みノウハウ)

- **DoubleSide + forceSinglePass** を必ず指定。Y-down OrthographicCamera で plane が裏面になる事故を吸収する。
- **`texture.colorSpace = THREE.SRGBColorSpace`** + **`texture.flipY = false`**。これが無いと色が暗くなる / 上下反転する。
- **`texture.needsUpdate = true`** を canvas 描画後に必ず呼ぶ。これを忘れると初期 1 frame しか upload されない。
- **`renderOrder` は scene-builder が `viz.layer` に従って上書きする**。plugin 内で `mesh.renderOrder = ...` を設定しても無視されます。
- **複数 Mesh をまとめる時は `THREE.Group` ではなく `THREE.Object3D` を使う**。`THREE.Group` だと three.js の `projectObject` が `groupOrder = group.renderOrder` を子孫に伝播させ、`reversePainterSortStable` が `groupOrder` を `renderOrder` より優先するため、scene-builder が `viz.layer` に従って Group に renderOrder=50/900/1500 を立てた瞬間に子孫が同じ groupOrder へ昇格し、テロップ (groupOrder=0, renderOrder=3000) より後段にソートされて画面前面に出てしまう。`new THREE.Object3D()` は `isGroup` フラグが立たないので groupOrder 伝播を起こさない。
- **`mesh.frustumCulled = false`**。1080p plane が画面端で勝手にカリングされないように。
- **再描画スキップ**: `update` は毎フレーム呼ばれるので、`lastFrameIdx` 等で「変化が無ければ何もしない」を入れる (CanvasTexture の upload は重い)。

## サーバ側で per-cut binary stream を書き出す

GL plugin が必要とする「per-frame の解析データ」は、サーバ側プラグインの `gl_data_streams(params, audio, time_grid_sec, fps)` で生成します。

サーバは戻り値を `projects/<id>/cache/viz/<token>_<stream>.bin` に書き出し、scene-bundle の `viz.gl.streams` に `{spectrum: {url, dtype: "float32", shape: [n_frames, bands]}}` として乗せます。`token` には plugin / params / audio / cut が含まれているため、設定が変わらなければ HTTP cache が効いて 2 度目以降の fetch はサーバに飛びません。

ブラウザ側は `audioData["spectrum"]` (Float32Array、フラット) と `streamShapes["spectrum"]` (`[n_frames, bands]`) を受け取り、フレームごとに行を切り出して描画します。

```js
const spec = audioData?.spectrum;        // Float32Array (flat)
const bands = streamShapes?.spectrum?.[1] ?? 64;
function readSpectrumRow(frameIdx) {
  const off = frameIdx * bands;
  return spec?.subarray(off, off + bands) ?? null;
}
```

### data stream のサイズ感

転送容量を意識してください (CDN を介さないローカル fetch とはいえ、長尺シーンでは効きます)。

- 24 fps × 10 s × 96 bands × 4 bytes = **0.09 MB / cut** (典型的な spectrum)
- 24 fps × 10 s × 1920 samples × 4 bytes = **1.8 MB / cut** (波形を等倍 ship)

100 MB を超えそうな場合は次の手段で抑えます。

1. **更新粒度を落とす**。プラグインで `GL_FRAME_RATE = 12` を宣言すると visualizer の time_grid が 12fps 相当で構築されます。書き出し fps とは独立。countdown 等は 12fps で十分。
2. **圧縮 dtype** で ship する。`gl_data_streams` の戻り値は `np.ndarray` だけでなく **dict** を返すこともできます。

```python
def gl_data_streams(params, audio, time_grid_sec, fps):
    spec = audio.normalized_spectrum(...)  # 0..1 の float32
    # int8 で ship: 0..1 → 0..127 にスケール、復号は browser 側で v = stored * (1/127) + 0
    quantized = np.round(spec * 127.0).astype(np.int8)
    return {
        "spectrum": {
            "data": quantized,
            "dtype": "int8",
            "scale": 1.0 / 127.0,
            "offset": 0.0,
        },
    }
```

サポートしている dtype: `float32` (既定) / `float16` / `int16` / `int8` / `uint8`。ブラウザ側は `streamMeta[name].array` で TypedArray、`audioData[name]` では復号済み Float32Array が取れます (旧 plugin 互換)。

3. `bands` / sample width 自体を減らす (見た目に妥協が要る)。

## scene への配置と layer 制御

ビジュアライザは scene の Z 軸方向で 4 段階のいずれかに配置できます (シナリオ側で `viz.layer` フィールドとして保存)。

| `viz.layer` | 描画位置 | 用途 |
| --- | --- | --- |
| `below_bg` | 背景色の上、背景画像の下 | 透過 PNG 背景の下に重ねたい場合 |
| `above_bg` (既定) | 背景の上、動画レイヤー・キャラの下 | スペクトログラム背景、波形装飾 |
| `above_chars` | キャラの上、前景の下 | 全画面エフェクト |
| `above_fg` | 前景の上、テロップの下 | カウントダウンなど最前面 |

注: 動画レイヤー (= scene.videoLayers[]) は ``above_bg`` のビジュアライザーより**さらに上**に乗ります (= 背景の一種として扱われます)。動画レイヤーで隠したくないビジュアライザーは ``below_bg`` を選んでください。

UI 側 (右パネルの `演出` タブ) で選択できます。プラグイン側からはこの層配置に責任を持ちません (= `mesh.renderOrder` は scene-builder が上書き)。

## 開発フロー

1. **`plugins/visualizers/<key>.py` を新規作成**。`KEY` / `NAME` / `PARAMS` / `GL_MODULE` (必須) / `gl_data_streams` (音声解析が必要な場合のみ) を実装する。
2. **`static/js/visualizers/<key>.js` を作成** して `createVisualizerLayer(ctx)` を export する。
3. サーバ起動 (既に起動中ならホットリロードでなく **再起動が必要**。`POST /api/cache/empty` は `cache/preview/` 等の中間ファイルを消すためのもので、`discover_plugins()` の `_DISCOVER_CACHE` (プラグイン本体のロード結果) はクリアしないため、新プラグインを認識させる用途には使えない)。
4. **`/dev/visualizers/` を開く**。プラグイン単体で「シーン設定 / 背景 / 音源」のノイズを排除した状態で動作確認。
   - 音源 fixture: `silence` / `sine 440Hz` / `beat (120BPM)` / `sweep 50-8000Hz` / `noise` / `現在のプロジェクトの BGM`
   - 背景: 黒 / 白 / グレー / 透過チェック柄、任意の HEX
   - 24fps 固定 (plugin に `GL_FRAME_RATE` があればそれを優先)
   - パラメータは PARAMS から自動生成
5. 編集画面 → 右パネル → `演出` タブ → 「ビジュアライザ追加」で実シーンに乗せて確認。
6. 動画書き出しで最終確認。

### `/dev/visualizers/` の有効化

ガード: `SPLITE_DEV_TOOLS=1` または loopback 接続 (`127.0.0.1` / `::1`) のときだけ有効です。リモートからアクセスしたい場合だけ環境変数で開けます。

```bash
SPLITE_DEV_TOOLS=1 python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

API としては `POST /api/dev/visualizer/preview` が本体です。本番の `layerData.visualizer` と同じ形 (pluginKey / frameDurationSec / frameCount / cutStartSec / sceneTotalSec / gl: { module, version, params, streams }) を返すので、scene-builder の代わりに最小の `THREE.Scene` を作って `createVisualizerLayer(ctx)` を呼ぶだけで再利用できます。

## 既存プラグインの一覧

参考実装は `plugins/visualizers/` 配下です。

| key | 名前 | 用途 | 主な学び |
| --- | --- | --- | --- |
| `wave` | オーディオ波形 | 中央線 + 振幅 | `audio.window` の使い方、per-frame 1920 サンプルの ship 例 |
| `circle_spectrum` | サークルスペクトログラム | 円周バー | `audio.spectrum_db` の使い方、log ビン化、dB → 長さ正規化 |
| `countdown` | カウントダウン | 時刻表示 | 音声不要 (`gl_data_streams` なし)、`frameState.sceneSec` の使い方、フォント解決 |
| `bar_spectrum` | バー・スペクトラム | 横並びバー | `InstancedMesh` で per-frame の matrix / color だけ更新する例 |
| `geometric_particles` | ジオメトリック・パーティクル | 点群 + 直線ネットワーク | `Points` / `LineSegments` で軽量な音反応パーティクルを作る例 |
| `wave_ribbon` | ウェーブ・リボン | 大きなソフト波線 | 三角形リボン + `ShaderMaterial` で太く柔らかい線を作る例 |
| `floating_particles` | ふわふわパーティクル (サンプル) | 浮遊粒子が音で拍動・onset で弾ける | **`_kit.js` を使う最小サンプル**。`GL_FRAME_RATE=12`、`int8 + scale` 圧縮 stream、`energy_bands` / `onset_envelope` の利用例 |
| `bokeh_gradient` | ぼかし円とグラデーション | 2 色グラデ + 浮遊するボケ円 + スターダスト | 音声なしの装飾系。`ShaderMaterial` 1 plane で大きなボケ円を vec4 uniform 配列に、`InstancedMesh` で小さな星粒を per-instance `aInstAlpha` に分けて描画 |
| `falling_particles` | 降りそそぐパーティクル (星屑 / 雪 / 雨) | 星屑 / 雪 / 雨が一定方向に降る (浮遊も可) | `uShape` 分岐で 1 InstancedMesh から 3 形状を描画、`((t*v + phase*span) mod span)` で wrap、雨は plane を `angle` で回転 |
| `led_grid` | LED グリッド | BPM に合わせて光るドットマトリクス | フルスクリーン fragment shader で `floor(uv * grid)` セル分割 + ハッシュ関数で per-cell color / pulse 決定。`ctx.sceneBpm` を読みつつ `params.bpm > 0` で上書き |
| `glow_shapes` | 光る図形 (角丸四角 / 円 / 三角 / 星) | ネオン輪郭の図形が一定方向に流れる + 背景パターン | SDF (`sdRoundedBox` / `sdCircle` / `sdEquilateralTriangle` / `sdStar5`) を `vShapeId` で分岐、per-instance に色・線幅をバラつかせる例。背景模様 (水玉 / 格子 / 横線 / 縦線) も同梱 |
| `wave_ribbons` | ウェーブリボン (ジオメトリック背景) | 半透明の斜めリボンがゆっくり波打つ「光のサテン」風背景 | vec4 uniform 配列で最大 16 本のリボンを 1 fragment shader で順次 `over` 合成。位相だけ `phase0 + speed*t` で更新する低 CPU パターン |

新しいプラグインを書き始めるときは、最も用途が近いものをコピーして編集するのが早いです。`_kit.js` を使う前提で書き始めるなら **`floating_particles` をテンプレート** にするのが最短です。

### scene の BPM を受け取る

`createVisualizerLayer(ctx)` の `ctx.sceneBpm` には、シーンの「基本」タブで設定された BPM 値が乗ります (未設定なら `0`)。BPM に同期したアニメーション (フラッシュ / 切替 / シーケンス) はこの値を読んで「params.bpm が 0 ならシーン値を使う」というセンチネル設計にしておくと、シーン全体で BPM を一括変更でき、必要に応じて個別ビジュアライザで上書きもできます。`led_grid` の実装が参考になります。

## トラブルシュート

### プラグインが UI に出てこない

- ファイル名が `_` で始まっていないか確認 (`_test.py` などは除外される)。
- サーバを再起動してください (キャッシュ全削除 `POST /api/cache/empty` は中間 PNG / WAV を消すだけで、プラグイン本体のロード結果はクリアしないため再起動が必要)。
- `KEY` / `NAME` のどちらかが欠けている、または `GL_MODULE` が無いと discover に弾かれる (サーバログに `[visualizer] skipping <file>: GL_MODULE が定義されていません` または `failed to load plugin ...` が出る)。

### ライブプレビューでは出るが書き出しで出ない

- ライブプレビューと動画書き出しは同じ GL plugin 経路で動くため、原則「ライブで出るなら書き出しでも出る」はず。差が出る場合は次を疑う:
  - `gl_data_streams` 内の例外はサイレントに落ちる (空 streams が返る) ので、サーバログ (`[visualizer] plugin <key> gl_data_streams raised: ...`) を確認。
  - 書き出し fps と plugin の `GL_FRAME_RATE` が大きく食い違うと、stream の `frameCount` が極端に少なく / 多くなる。`frameCount` を update 内で defensive にハンドル。

### Canvas に描いた絵が真っ黒 / 透明 / 反転する

- `texture.needsUpdate = true` の呼び忘れ (初期 1 frame しか upload されない)。
- `texture.flipY = false` の指定漏れ → 上下反転。
- `material.side = THREE.DoubleSide` + `forceSinglePass: true` の漏れ → 裏面で透明になる。
- `texture.colorSpace = THREE.SRGBColorSpace` の漏れ → 全体的に暗くなる。

### dBFS の値域がおかしい

- `audio.spectrum_db` は `-120 .. 0` 程度の dBFS を返す。`dbFloor = -75`, `dbCeil = -20` あたりが典型的な可視化レンジ (これより上だとサチる、下だと無音時にバーが揺れる)。
