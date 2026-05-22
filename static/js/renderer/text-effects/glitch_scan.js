// =============================================================================
// renderer/text-effects/glitch_scan.js
//
// "glitch_scan" — 横スキャンライン状にスライスを左右にずらすグリッチ effect。
// slot: effect。
//
// 仕様 §7:
//   - clip 描画を一度オフスクリーン canvas (中間バッファ) に焼く
//   - 横方向に sliceCount 個の短冊に分割、各短冊を deterministicRandom でずらす
//   - holdFrames 単位で frameIdx を量子化してちらつき抑制
//   - fullCanvasOffscreen: true (slice ずれで bbox を超えるため全面 fallback)
//
// 実装メモ:
//   中間 canvas は毎フレーム createElement + width/height で backing store を解放。
//   1920×1080 1 枚なので問題なし (glow/dropShadow scratch とは別経路)。
// =============================================================================

import { registerEffectPreset, deterministicRandom } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  sliceCount: 16,
  intensity: 0.7,
  maxShiftPx: 36,
  holdFrames: 2,
  dropoutRate: 0.0,
});

const CONTROLS = [
  { key: "sliceCount", label: "短冊数", type: "number", min: 2, max: 60, step: 1 },
  { key: "intensity", label: "ずれの強さ", type: "number", min: 0, max: 1, step: 0.05 },
  { key: "maxShiftPx", label: "最大ずれ幅 (px)", type: "number", min: 0, max: 200, step: 1 },
  { key: "holdFrames", label: "ちらつき抑制 (フレーム)", type: "number", min: 1, max: 12, step: 1 },
  { key: "dropoutRate", label: "短冊欠落率", type: "number", min: 0, max: 0.5, step: 0.02 },
];

registerEffectPreset({
  id: "glitch_scan",
  label: "グリッチスキャン",
  slots: ["effect"],
  needsOffscreenRedraw: true,
  needsLayerComposite: true,
  fullCanvasOffscreen: true,
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  resolveRuntimeFlags(params, _ctx) {
    const intensity = Math.max(0, Number(params?.intensity ?? DEFAULT_PARAMS.intensity));
    const dropout = Math.max(0, Number(params?.dropoutRate ?? DEFAULT_PARAMS.dropoutRate));
    const animated = intensity > 0 || dropout > 0;
    return {
      // intensity=0 & dropout=0 なら効果ゼロ (素の描画と同じ) → 静的化
      needsOffscreenRedraw: animated,
      needsLayerComposite: true,
      fullCanvasOffscreen: true,
    };
  },
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    const sliceCount = Math.max(2, Math.floor(Number(params?.sliceCount ?? DEFAULT_PARAMS.sliceCount)));
    const intensity = Math.max(0, Math.min(1, Number(params?.intensity ?? DEFAULT_PARAMS.intensity)));
    const maxShift = Math.max(0, Number(params?.maxShiftPx ?? DEFAULT_PARAMS.maxShiftPx));
    const holdFrames = Math.max(1, Math.floor(Number(params?.holdFrames ?? DEFAULT_PARAMS.holdFrames)));
    const dropoutRate = Math.max(0, Math.min(1, Number(params?.dropoutRate ?? DEFAULT_PARAMS.dropoutRate)));

    if (intensity <= 0 && dropoutRate <= 0) {
      baseDraw(ctx);   // 効果ゼロのとき素の描画
      return;
    }

    const canvasW = Number(context?.canvasW) || 1920;
    const canvasH = Number(context?.canvasH) || 1080;
    // holdFrames 単位で量子化 (= ちらつき抑制)
    const f2 = Math.floor(Number(frameIdx) / holdFrames);
    const clipId = clip?.id || "";

    // 中間 canvas に baseDraw を焼く。1920×1080 全面 (= fullCanvasOffscreen)
    const mid = document.createElement("canvas");
    mid.width = canvasW;
    mid.height = canvasH;
    try {
      const midCtx = mid.getContext("2d");
      baseDraw(midCtx);

      // 短冊に分割して各短冊を ctx に描画
      const sliceH = canvasH / sliceCount;
      for (let i = 0; i < sliceCount; i += 1) {
        // 連続した短冊ごとに deterministic な「ずれ」を決める。
        // intensity を係数にして [-maxShift, +maxShift] にスケール。
        const r = deterministicRandom(clipId, f2, i);
        const shiftX = (r - 0.5) * 2 * maxShift * intensity;
        // 短冊の欠落 (= dropoutRate に基づく) は別 salt で判定
        if (dropoutRate > 0) {
          const d = deterministicRandom(clipId, f2, 100 + i);
          if (d < dropoutRate) continue;
        }
        const sy = Math.floor(i * sliceH);
        // 最終短冊は端数を吸収するため canvasH 末尾までで切る
        const sh = (i === sliceCount - 1) ? (canvasH - sy) : Math.ceil(sliceH);
        if (sh <= 0) continue;
        ctx.drawImage(mid, 0, sy, canvasW, sh, shiftX, sy, canvasW, sh);
      }
    } finally {
      // backing store を即解放 (= 1920×1080 × 4 = 8MB がフレームごとに残らない)
      mid.width = 0;
      mid.height = 0;
    }
  },
});
