// =============================================================================
// renderer/text-effects/fade.js
//
// 入退場アニメーション "fade"。
// - slots: animation_in / animation_out
// - fade_slide の「位置オフセットを 0 にした」版。位置はいっさい動かさず、
//   alpha のみ 0→1 (in) / 1→0 (out) で補間する。
// - Caption / MV どちらでも軽量に使える。グラフィックを動かさない演出に最適。
//
// 呼出元 (drawTextClip):
//   - animation_in 時:  localSec = sceneSec - clipStart       (0 → durSec)
//   - animation_out 時: localSec = clipEnd - sceneSec         (durSec → 0)
//   どちらも eased(localSec / durSec) を alpha として描画する。
//     in:  localSec=0       → alpha=0 (透明)
//          localSec=durSec  → alpha=1 (完全表示)
//     out: localSec=durSec  → alpha=1 (完全表示)
//          localSec=0       → alpha=0 (完全消失)
//
// params:
//   durSec  入退場の長さ (秒)。0 で no-op (基本描画にフォールバック)
//   easing  "ease_out" (default) / "linear" / "ease_in_out"
// =============================================================================

import { registerEffectPreset } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  durSec: 0.4,
  easing: "ease_out",
});

const CONTROLS = [
  { key: "durSec", label: "長さ (秒)", type: "number", min: 0, max: 5, step: 0.05 },
  {
    key: "easing", label: "イージング", type: "select",
    options: [
      { value: "ease_out", label: "減速" },
      { value: "linear", label: "等速" },
      { value: "ease_in_out", label: "両端緩め" },
    ],
  },
];

function _ease(t, mode) {
  if (mode === "linear") return t;
  if (mode === "ease_in_out") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return 1 - Math.pow(1 - t, 3);  // ease_out (cubic)
}

function _draw(ctx, params, localSec, baseDraw) {
  const durSec = Math.max(0, Number(params?.durSec ?? DEFAULT_PARAMS.durSec));
  if (durSec <= 0) { baseDraw(ctx); return; }
  const t = Math.min(1, Math.max(0, localSec / durSec));
  const alpha = _ease(t, params?.easing || DEFAULT_PARAMS.easing);
  if (alpha <= 0) return;  // 完全透明なら描画スキップ
  ctx.save();
  // 既存 globalAlpha を尊重して掛け合わせる (animation.body と併用時に潰さない)。
  ctx.globalAlpha = (ctx.globalAlpha ?? 1) * alpha;
  baseDraw(ctx);
  ctx.restore();
}

registerEffectPreset({
  id: "fade",
  label: "フェード (透明度のみ)",
  slots: ["animation_in", "animation_out"],
  needsOffscreenRedraw: false,  // 文字本体は不変
  needsLayerComposite: true,    // composite 段の alpha が毎フレーム変わる
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    _draw(ctx, params, localSec, baseDraw);
  },
});
