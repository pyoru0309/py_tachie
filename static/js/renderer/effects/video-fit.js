// ===========================================================================
// renderer/effects/video-fit.js
//
// 動画レイヤー / 背景動画の `fit` (cover / contain / fill) + `scale` を
// 「PlaneGeometry のサイズ」と「VideoTexture の UV (offset / repeat)」に
// 翻訳するヘルパ。
//
// videoEl.style.objectFit は VideoTexture には効かないため、GL 側で計算する
// 必要がある。動画レイヤーの実装と同時に、背景動画の fit にも将来適用できる
// 形にする。
// ===========================================================================

import { CANVAS_WIDTH, CANVAS_HEIGHT } from "../core.js";

/**
 * @param {number} srcW 素材幅 (px)。/api/video-duration から取得した値を渡す
 * @param {number} srcH 素材高 (px)
 * @param {"cover"|"contain"|"fill"} fit アスペクト処理モード
 * @param {number} scale fit 適用後の追加倍率 (縦横比維持、中央アンカー、0.05〜4.0)
 * @param {number} offsetX 中央アンカーからの X オフセット (px、+で右へ)
 * @param {number} offsetY 中央アンカーからの Y オフセット (px、+で下へ; Y-down 座標)
 * @returns {{
 *   planeW: number, planeH: number,
 *   planeX: number, planeY: number,
 *   uvOffsetX: number, uvOffsetY: number,
 *   uvScaleX: number, uvScaleY: number,
 * }}
 *   - planeW/H: 1920×1080 stage 上での描画サイズ
 *   - planeX/Y: stage 左上原点での「plane の左上座標」(中央アンカーで配置 + offset)
 *   - uvOffsetX/Y, uvScaleX/Y: THREE.Texture の offset.set / repeat.set にそのまま渡せる
 */
export function computeVideoFit(srcW, srcH, fit = "contain", scale = 1.0, offsetX = 0, offsetY = 0) {
  const stageW = CANVAS_WIDTH;
  const stageH = CANVAS_HEIGHT;
  const w = Number(srcW) > 0 ? Number(srcW) : stageW;
  const h = Number(srcH) > 0 ? Number(srcH) : stageH;
  const srcAspect = w / h;
  const stageAspect = stageW / stageH;
  const mode = (fit === "cover" || fit === "fill") ? fit : "contain";

  let planeW = stageW;
  let planeH = stageH;
  let uvOffsetX = 0;
  let uvOffsetY = 0;
  let uvScaleX = 1;
  let uvScaleY = 1;

  if (mode === "fill") {
    // 縦横引き伸ばし。texture 全域を使う。
    planeW = stageW;
    planeH = stageH;
  } else if (mode === "cover") {
    // stage を埋める。texture を中央クロップ。
    planeW = stageW;
    planeH = stageH;
    if (srcAspect > stageAspect) {
      // 横長 → 左右クロップ
      const cropRatio = stageAspect / srcAspect;
      uvScaleX = cropRatio;
      uvScaleY = 1;
      uvOffsetX = (1 - cropRatio) / 2;
      uvOffsetY = 0;
    } else if (srcAspect < stageAspect) {
      // 縦長 → 上下クロップ
      const cropRatio = srcAspect / stageAspect;
      uvScaleX = 1;
      uvScaleY = cropRatio;
      uvOffsetX = 0;
      uvOffsetY = (1 - cropRatio) / 2;
    }
  } else {
    // contain (default): 縦横比維持で stage に内接。plane を縮小、texture 全域を使う。
    if (srcAspect > stageAspect) {
      planeW = stageW;
      planeH = stageW / srcAspect;
    } else {
      planeH = stageH;
      planeW = stageH * srcAspect;
    }
  }

  // 追加 scale (縦横比維持、中央アンカー)。0.05〜4.0 でクランプ。
  const s = Math.max(0.05, Math.min(4.0, Number(scale) || 1.0));
  planeW *= s;
  planeH *= s;

  // 中央アンカー: 左上座標は stage 中心 - plane 半サイズ + offset。
  // offset は ±2000 でクランプ (画面外側に動かすケースを許容)。
  const offX = Math.max(-2000, Math.min(2000, Number(offsetX) || 0));
  const offY = Math.max(-2000, Math.min(2000, Number(offsetY) || 0));
  const planeX = (stageW - planeW) / 2 + offX;
  const planeY = (stageH - planeH) / 2 + offY;

  return {
    planeW,
    planeH,
    planeX,
    planeY,
    uvOffsetX,
    uvOffsetY,
    uvScaleX,
    uvScaleY,
  };
}
