// =============================================================================
// visualizers/index.js
//
// ブラウザ側 GL ビジュアライザ プラグインのローダ。
//
// サーバ側 (Python) plugin が ``GL_MODULE = "/static/js/visualizers/<key>.js"`` を
// 持っていれば、scene-bundle の visualizer payload に ``gl: { module, version,
// params, streams }`` が乗ってくる。本モジュールはそのモジュールを動的 import
// し、`createVisualizerLayer(ctx)` を呼んで Object3D を返す。
//
// プラグインの contract:
//   export async function createVisualizerLayer(ctx) {
//     return { object3D, update(frameState), dispose() };
//   }
//
//   ctx = {
//     THREE,            // three.js モジュール (バージョン整合のため呼び側から渡す)
//     renderer,         // THREE.WebGLRenderer
//     width, height,    // canvas 1920x1080 (固定)
//     params,           // user 設定値 (Python plugin の PARAMS と同じキー)
//     audioData,        // { [streamName]: Float32Array } per-cut 一括
//     streamShapes,     // { [streamName]: number[] } e.g. spectrum: [frameCount, bands]
//     frameDurationSec, // visualizer の更新粒度 (例 1/12 sec)
//     frameCount,       // cut 内の visualizer frame 数
//     cutStartSec,      // scene 内での cut の開始秒
//     sceneTotalSec,    // scene 全体の長さ (countdown 等で使う)
//   }
//
//   frameState = {
//     elapsedSec,       // ★ cut-local (= playback.js の quantized)。0 でカット先頭。
//     sceneSec,         // scene 内通算秒 = cutStartSec + elapsedSec。countdown 等
//                       //   「scene 全体の残時間」を扱う plugin はこちらを使う。
//     frameIdx,         // cut-local visualizer frame idx
//                       //   (= floor(elapsedSec / frameDurationSec) clamp)
//   }
//
// 注意: 過去仕様では elapsedSec を scene 内通算秒として扱う実装が混在していたが、
// playback.js が cut-local しか渡さない事実に合わせて 2026-05-05 に整理した。
// gl_data_streams は `time_grid = cut_start_sec + i / fps` で per-cut N_frames 行を
// 焼くので、frameIdx は **cut-local index** で読むのが正解。
//
// 既存の PNG 連番経路は scene-builder.js 側で温存。GL ありなら GL 経路、
// 無ければ PNG fallback。
// =============================================================================

const _moduleCache = new Map();

export async function loadVisualizerModule(moduleUrl) {
  if (!moduleUrl) throw new Error("loadVisualizerModule: moduleUrl is empty");
  const cached = _moduleCache.get(moduleUrl);
  if (cached) return cached;
  // 動的 import。failure は呼び側で catch して PNG fallback へ。
  const mod = await import(/* @vite-ignore */ moduleUrl);
  if (typeof mod?.createVisualizerLayer !== "function") {
    throw new Error(`visualizer module ${moduleUrl} does not export createVisualizerLayer`);
  }
  _moduleCache.set(moduleUrl, mod);
  return mod;
}

// streams = { [name]: { url, dtype, shape, scale?, offset? } }
//
// 戻り値:
//   audioData     : { [name]: Float32Array }                     互換用 (旧 plugin が直接読む)
//   streamShapes  : { [name]: number[] }                          shape そのまま
//   streamMeta    : { [name]: { array, dtype, scale, offset } }  新 plugin 向け (_kit.js が読む)
//
// 拡張 dtype (int8 / uint8 / int16 / float16) は scale / offset 付きで送られてくる。
// 旧 plugin は ``audioData[name]`` をそのまま Float32Array 想定で読むため、
// ここで dtype 復号を済ませて Float32Array に展開する。
import { decodeStreamArray } from "/static/js/visualizers/_kit.js";
export async function fetchVisualizerStreams(streams) {
  const audioData = {};
  const streamShapes = {};
  const streamMeta = {};
  if (!streams || typeof streams !== "object") return { audioData, streamShapes, streamMeta };
  const entries = Object.entries(streams);
  await Promise.all(
    entries.map(async ([name, meta]) => {
      if (!meta?.url) return;
      const res = await fetch(meta.url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`stream ${name} fetch failed: ${res.status}`);
      const buf = await res.arrayBuffer();
      const decoded = decodeStreamArray(buf, meta);
      streamMeta[name] = decoded;
      streamShapes[name] = Array.isArray(meta.shape) ? meta.shape.slice() : [decoded.array.length];
      // 旧 plugin 互換: 圧縮 dtype は scale/offset を適用した Float32 配列を渡す。
      // float32 ストリームは追加コピー無しで TypedArray を直接渡す (ホットパス保護)。
      if (decoded.dtype === "float32" && decoded.scale === 1 && decoded.offset === 0) {
        audioData[name] = decoded.array;
      } else {
        const out = new Float32Array(decoded.array.length);
        const s = decoded.scale ?? 1;
        const o = decoded.offset ?? 0;
        if (s === 1 && o === 0) {
          for (let i = 0; i < out.length; i++) out[i] = decoded.array[i];
        } else {
          for (let i = 0; i < out.length; i++) out[i] = decoded.array[i] * s + o;
        }
        audioData[name] = out;
      }
    }),
  );
  return { audioData, streamShapes, streamMeta };
}
