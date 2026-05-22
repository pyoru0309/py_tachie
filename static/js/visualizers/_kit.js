// =============================================================================
// visualizers/_kit.js
//
// GL plugin 共通ユーティリティ。
// - createCanvasPlane(THREE, w, h)  : CanvasTexture + DoubleSide plane を一発生成
// - disposeCanvasPlane(parts)       : geom / material / texture を一括 dispose
// - numParam(value, fallback)       : 0 を有効値として扱う数値取り出し
// - hexToColor(THREE, hex)          : 既定色フォールバック付きの THREE.Color 化
// - hexToRgba(hex, alpha)           : canvas2d 用 "rgba(r,g,b,a)" 文字列
// - clamp01 / clamp                 : よく書く 0..1 / [lo, hi] のクランプ
// - sliceStreamRow(...)             : stream の frameIdx 行を切り出して値域変換
// - decodeStreamArray(...)          : サーバが返した meta から TypedArray を作る
//
// プラグインからの利用例:
//   import {
//     createCanvasPlane, disposeCanvasPlane, numParam, hexToColor,
//     decodeStreamArray, sliceStreamRow,
//   } from "/static/js/visualizers/_kit.js";
//
// 既存プラグインは触らない (中身を見れば挙動が分かる方が学習コスト低い)。
// 新規プラグイン / 開発ラボ専用 plugin で利用する。
// =============================================================================

/** 0 を有効値として保持する numeric 取り出し (Python の `int(p.get(k, default))` 等価)。 */
export function numParam(value, fallback) {
  const raw = value ?? fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

/** HEX (#rgb / #rrggbb) を THREE.Color に。失敗時は white フォールバック。 */
export function hexToColor(THREE, hex) {
  try {
    return new THREE.Color(hex || "#ffffff");
  } catch (_err) {
    return new THREE.Color("#ffffff");
  }
}

/** HEX → "rgba(r, g, b, a)" 文字列。canvas2d の strokeStyle / fillStyle 用。 */
export function hexToRgba(hex, alpha = 1) {
  let s = String(hex || "#ffffff").trim();
  if (!s.startsWith("#")) s = "#" + s;
  if (s.length === 4) {
    s = "#" + s.slice(1).split("").map((c) => c + c).join("");
  }
  if (s.length !== 7) return `rgba(255, 255, 255, ${clamp01(alpha)})`;
  const r = parseInt(s.slice(1, 3), 16);
  const g = parseInt(s.slice(3, 5), 16);
  const b = parseInt(s.slice(5, 7), 16);
  if (![r, g, b].every(Number.isFinite)) {
    return `rgba(255, 255, 255, ${clamp01(alpha)})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

/**
 * 1920x1080 想定の CanvasTexture + DoubleSide plane を一発生成。Y-down camera 用。
 * 戻り値は { canvas, c2d, texture, geom, material, mesh }。
 *
 *   const plane = createCanvasPlane(THREE, width, height);
 *   plane.c2d.fillStyle = "#fff";
 *   plane.c2d.fillRect(0, 0, plane.canvas.width, plane.canvas.height);
 *   plane.texture.needsUpdate = true;
 *   scene.add(plane.mesh);
 *
 * dispose は disposeCanvasPlane(plane) で一括解放できる。
 */
export function createCanvasPlane(THREE, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 1920));
  const h = Math.max(1, Math.round(Number(height) || 1080));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext("2d");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const geom = new THREE.PlaneGeometry(w, h);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(w / 2, h / 2, 0);
  mesh.frustumCulled = false;
  return { canvas, c2d, texture, geom, material, mesh };
}

/** createCanvasPlane の戻り値を一括 dispose。dispose() を 1 回で済ませるため。 */
export function disposeCanvasPlane(parts) {
  if (!parts) return;
  try { parts.geom?.dispose(); } catch (_) {}
  try { parts.material?.dispose(); } catch (_) {}
  try { parts.texture?.dispose(); } catch (_) {}
}

// ---------------------------------------------------------------------------
// stream の TypedArray 化と行切り出し
// ---------------------------------------------------------------------------

const _DTYPE_TO_CTOR = {
  float32: Float32Array,
  float16: null,        // Float16Array はブラウザ未対応。Float32Array に展開する。
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
};

/**
 * fetch した ArrayBuffer + meta から TypedArray を作る。Float16 はブラウザ非対応
 * のため Float32Array に展開する (ship size を半分にして展開後に float32 で扱う想定)。
 * 戻り値: { array, scale, offset, dtype }。値の復号は ``v = array[i] * scale + offset``。
 */
export function decodeStreamArray(buffer, meta) {
  const dtype = String(meta?.dtype || "float32");
  const scale = Number.isFinite(Number(meta?.scale)) ? Number(meta.scale) : 1;
  const offset = Number.isFinite(Number(meta?.offset)) ? Number(meta.offset) : 0;
  const Ctor = _DTYPE_TO_CTOR[dtype];
  if (Ctor) {
    return { array: new Ctor(buffer), scale, offset, dtype };
  }
  if (dtype === "float16") {
    // 簡易 IEEE 754 binary16 → binary32 変換。ship size を float32 の半分に
    // 抑えるための補助。1 stream あたりの長尺 BGM サイズ削減用。
    const u16 = new Uint16Array(buffer);
    const f32 = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) f32[i] = _f16_to_f32(u16[i]);
    return { array: f32, scale, offset, dtype: "float32" };
  }
  // 不明 dtype: 防衛的に Float32Array として読む。
  return { array: new Float32Array(buffer), scale, offset, dtype: "float32" };
}

function _f16_to_f32(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  let val;
  if (e === 0) {
    val = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  } else if (e === 0x1f) {
    val = f ? NaN : ((s ? -1 : 1) * Infinity);
  } else {
    val = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return val;
}

/**
 * shape が ``[N_frames, W]`` の stream から frameIdx 行を切り出して、復号済み
 * Float32Array を返す。subarray view ではなく **新規バッファ** を返すので、
 * 呼び出し側は値の改変を気にしなくて良い (ホットループで毎フレーム new する
 * コストはあるが、N が小さいので無視できる)。``out`` を渡すと再利用する。
 */
export function sliceStreamRow(stream, frameIdx, rowSize, out = null) {
  const w = Math.max(1, Math.floor(Number(rowSize) || 0));
  if (!stream?.array) return out || new Float32Array(w);
  const off = Math.max(0, Math.floor(frameIdx)) * w;
  if (off + w > stream.array.length) return out || new Float32Array(w);
  const dst = out && out.length === w ? out : new Float32Array(w);
  const src = stream.array;
  const scale = stream.scale ?? 1;
  const offset = stream.offset ?? 0;
  if (scale === 1 && offset === 0) {
    for (let i = 0; i < w; i++) dst[i] = src[off + i];
  } else {
    for (let i = 0; i < w; i++) dst[i] = src[off + i] * scale + offset;
  }
  return dst;
}

/**
 * 1 次元 stream (= shape ``[N_frames]``) の frameIdx 値を 1 つ復号して返す。
 * peak / onset / beat 等の per-frame スカラー用。
 */
export function readStreamScalar(stream, frameIdx, fallback = 0) {
  if (!stream?.array) return fallback;
  const i = Math.max(0, Math.floor(frameIdx));
  if (i >= stream.array.length) return fallback;
  const scale = stream.scale ?? 1;
  const offset = stream.offset ?? 0;
  const v = stream.array[i] * scale + offset;
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// 背景色情報 (ctx.background)
// ---------------------------------------------------------------------------
//
// プラグインに「自分より下のレイヤー (背景画像/動画) の見た目」をコンテクスト
// として渡すための共通形:
//   {
//     color?: "#rrggbb",          // 単色背景のとき (それ以外は null)
//     averageColor: "#rrggbb",    // 画像/動画はサムネイルから平均色、単色なら同値
//     luminance: 0..1,            // WCAG 相対輝度。AdditiveBlending 回避や影付け判定に
//     isLight: boolean,           // luminance > 0.5
//     contrastColor: "#rrggbb",   // 視認性が確保される反対色 (近似)
//     source: "solid" | "image" | "video" | "mixed" | "unknown"
//   }
//
// 計算手順:
//   - 単色:  parseHex → relativeLuminance
//   - 画像:  Image / Canvas を 16x16 に縮小描画 → 平均 RGB
//   - 動画:  HTMLVideoElement を 16x16 に縮小描画 → 平均 RGB
//   - 透過/不明: gray (0.5) フォールバック
//
// 重い処理 (動画毎フレーム sample) は呼び出し側でレートを絞ること。本ヘルパは
// 1 回計算するだけ。

const _BG_DEFAULT = Object.freeze({
  color: null,
  averageColor: "#808080",
  luminance: 0.5,
  isLight: false,
  contrastColor: "#ffffff",
  source: "unknown",
});

export function defaultBackgroundInfo() { return { ..._BG_DEFAULT }; }

function parseHexRgb(hex) {
  let s = String(hex || "").trim();
  if (!s.startsWith("#")) s = "#" + s;
  if (s.length === 4) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
  if (s.length !== 7) return null;
  const r = parseInt(s.slice(1, 3), 16);
  const g = parseInt(s.slice(3, 5), 16);
  const b = parseInt(s.slice(5, 7), 16);
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG 相対輝度 (0..1)。 */
export function relativeLuminance(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 相対輝度から、視認性が高い反対色を返す。完全な #000/#fff だと固すぎるので
 * #111111 / #f4f4f4 程度に丸める (本体テキストでも同じ扱い)。 */
export function pickContrastColor(luminance) {
  return luminance > 0.5 ? "#111111" : "#f4f4f4";
}

export function backgroundInfoFromColor(hex, { source = "solid" } = {}) {
  const rgb = parseHexRgb(hex);
  if (!rgb) return defaultBackgroundInfo();
  const lum = relativeLuminance(rgb.r, rgb.g, rgb.b);
  const norm = rgbToHex(rgb.r, rgb.g, rgb.b);
  return {
    color: source === "solid" ? norm : null,
    averageColor: norm,
    luminance: lum,
    isLight: lum > 0.5,
    contrastColor: pickContrastColor(lum),
    source,
  };
}

/** 画像 (HTMLImageElement / HTMLCanvasElement / HTMLVideoElement) をサンプルして
 * 平均 RGB → 背景情報 dict を返す。失敗時は default。
 *
 * ``source`` で結果に詰める種別を指定 ("image" / "video" / "mixed" など)。
 */
export function backgroundInfoFromImage(image, { source = "image", sampleSize = 16 } = {}) {
  if (!image) return defaultBackgroundInfo();
  const w = Number(image.naturalWidth || image.videoWidth || image.width || 0);
  const h = Number(image.naturalHeight || image.videoHeight || image.height || 0);
  if (w <= 0 || h <= 0) return defaultBackgroundInfo();
  const c = document.createElement("canvas");
  c.width = c.height = Math.max(2, Math.floor(sampleSize));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return defaultBackgroundInfo();
  try {
    ctx.drawImage(image, 0, 0, c.width, c.height);
  } catch (_err) {
    // tainted (CORS) 等で読めない: default にフォールバック
    return defaultBackgroundInfo();
  }
  let data;
  try {
    data = ctx.getImageData(0, 0, c.width, c.height).data;
  } catch (_err) {
    return defaultBackgroundInfo();
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue; // ほぼ透明 pixel は無視
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
  }
  if (n === 0) return defaultBackgroundInfo();
  r /= n; g /= n; b /= n;
  const lum = relativeLuminance(r, g, b);
  return {
    color: null,
    averageColor: rgbToHex(r, g, b),
    luminance: lum,
    isLight: lum > 0.5,
    contrastColor: pickContrastColor(lum),
    source,
  };
}
