// =============================================================================
// renderer/telop.js
//
// scene-level の telops 配列をオフスクリーン Canvas2D に描画して CanvasTexture
// を作るためのヘルパ。
//
// テロップごとの幾何計算は text-core.js / text-clip-draw.js に集約。
// ここでは plane 用 canvas を確保して per-clip 描画を呼び、CanvasTexture を作る。
//
// 再描画ポリシー (§9.1, Phase 2-5 で per-clip キャッシュ導入):
//
//   active clip ごとに resolveClipRuntimeFlags を評価し
//     - 静的 (両 flag=false): per-clip offscreen キャッシュから drawImage 合成
//                              (出現時 1 回だけ焼く、content 不変なら再利用)
//     - 動的 (どちらか true): drawTextClip で plane に直接描画
//
//   plane 全体は active 集合変化 or 動的 clip がいるフレームで毎周期 redraw。
//   静的 clip のみのシーンは fingerprint 変化時だけ redraw (= 旧経路温存)。
// =============================================================================
import * as THREE from "three";
import { PROJECT_FPS } from "../timecode.js";
import {
  drawTextClip,
  analyzeRuntimeFlags,
  resolveClipRuntimeFlags,
  makeClipOffscreenCache,
  disposeClipOffscreenCache,
  getOrBakeStaticClipOffscreen,
  evictUnusedClipOffscreens,
} from "./text-clip-draw.js";
import { releaseTextScratch } from "./text-core.js";

export const TELOP_CANVAS_WIDTH = 1920;
export const TELOP_CANVAS_HEIGHT = 1080;

function selectActiveTelops(telops, sceneSec) {
  if (!Array.isArray(telops) || telops.length === 0) return [];
  const out = [];
  for (const telop of telops) {
    if (!telop || typeof telop !== "object") continue;
    const startFrame = Number(telop.startFrame) || 0;
    const durationFrame = Number(telop.durationFrame) || 0;
    if (durationFrame <= 0) continue;
    const start = startFrame / PROJECT_FPS;
    const dur = durationFrame / PROJECT_FPS;
    if (sceneSec >= start && sceneSec < start + dur) out.push(telop);
  }
  return out;
}

export function createTelopCanvasTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = TELOP_CANVAS_WIDTH;
  canvas.height = TELOP_CANVAS_HEIGHT;
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { canvas, texture };
}

// 必要なら canvas を再描画して texture.needsUpdate を立てる。
// state は { lastFingerprint, lastDynamicFrameIdx, lastWasDynamic, offscreenCache?, underlayInfo? }。
export function refreshTelopCanvas(canvas, texture, telops, sceneSec, state, context) {
  const ctxInfo = context && typeof context === "object" ? context : {};
  const fps = Math.max(1, Number(ctxInfo.characterAnimationFps) || 12);
  const active = selectActiveTelops(telops || [], sceneSec);
  const flags = analyzeRuntimeFlags(telops || [], sceneSec, ctxInfo);
  const dynamic = flags.needsLayerComposite || flags.needsOffscreenRedraw;
  const visible = flags.activeCount > 0;
  const quantizedFrameIdx = Math.floor(Math.max(0, sceneSec) * fps);
  const wasDynamic = state.lastWasDynamic === true;

  // per-clip offscreen キャッシュ (= Phase 2-5)。state に持つ。
  if (!state.offscreenCache) state.offscreenCache = makeClipOffscreenCache();
  const cache = state.offscreenCache;

  const drawCtx = {
    ...ctxInfo,
    canvasW: canvas.width,
    canvasH: canvas.height,
    characterAnimationFps: fps,
  };

  const doRedraw = () => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (visible) {
      // 各 clip を静的 / 動的に振り分けて描く。
      for (const clip of active) {
        const f = resolveClipRuntimeFlags(clip, sceneSec, ctxInfo);
        if (!f.needsLayerComposite && !f.needsOffscreenRedraw) {
          // 静的: per-clip offscreen キャッシュから drawImage で合成。
          // drawTextClip 経由で焼くため context (underlayInfo 等) も渡す。
          const offscreen = getOrBakeStaticClipOffscreen(
            cache, clip, sceneSec, canvas.width, canvas.height, drawCtx,
          );
          if (offscreen) ctx.drawImage(offscreen, 0, 0);
        } else {
          // 動的: plane に直接描く (per-clip cache はパス、毎フレーム計算)。
          drawTextClip(ctx, clip, sceneSec, quantizedFrameIdx, drawCtx);
        }
      }
      // 動的 clip 用 scratch (glow / dropShadow) を解放。
      releaseTextScratch();
    }
    texture.needsUpdate = true;
  };

  // active 集合外の clip キャッシュエントリは破棄 (メモリ節約)。
  evictUnusedClipOffscreens(cache, active.map((c) => c.id));

  if (dynamic) {
    // 動的 clip がいる: 量子化 frameIdx 周期で全 plane を再構築。
    if (state.lastDynamicFrameIdx === quantizedFrameIdx && state.lastFingerprint === flags.fingerprint) {
      return visible;
    }
    state.lastDynamicFrameIdx = quantizedFrameIdx;
    state.lastFingerprint = flags.fingerprint;
    state.lastWasDynamic = true;
    doRedraw();
    return visible;
  }

  // 静的経路: active 集合変化 or 「直前が動的だった」フレームのみ redraw。
  // 後者を入れないと、animation_in の最終量子化フレーム (= alpha<1) が canvas に
  // 焼き付いたまま残る (fade_slide durSec=0.25 で「半透明で固まる」現象、§Phase 1)。
  if (!wasDynamic && state.lastFingerprint === flags.fingerprint) {
    return visible;
  }
  state.lastFingerprint = flags.fingerprint;
  state.lastDynamicFrameIdx = null;
  state.lastWasDynamic = false;
  doRedraw();
  return visible;
}

// scene dispose 時に呼ぶ (= scene-builder の dispose 経路から)。
// per-clip offscreen をすべて破棄する。
export function disposeTelopState(state) {
  if (state?.offscreenCache) {
    disposeClipOffscreenCache(state.offscreenCache);
    state.offscreenCache = null;
  }
}

export { selectActiveTelops };
