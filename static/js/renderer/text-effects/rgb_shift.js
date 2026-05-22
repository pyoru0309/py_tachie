// =============================================================================
// renderer/text-effects/rgb_shift.js
//
// "rgb_shift" — 色収差 (RGB チャネルずれ) 効果。
// 同じ文字を赤・緑・青の 3 色でずらして重ね、最後に本体を上書き描画する。
//
// params:
//   shiftPx       チャネルの基本ずれ幅 (px)。3 チャネルを 120° 等分で配置
//   jitterPx      フレームごとの追加ランダム揺らぎ (deterministicRandom 経由)
//   redColor, greenColor, blueColor   各チャネル色 (RGB primary が既定)
//   blendMode     "screen" / "lighter" / "source-over"
//   drawBody      true なら最後に本体を不透明で上書き
//
// 仕様 §7:
//   slot: "effect"、固定 needsOffscreenRedraw/Composite=true
//   resolveRuntimeFlags で
//     jitterPx=0 → needsOffscreenRedraw=false (静的、1 回焼けばよい)
//     shiftPx>16 → fullCanvasOffscreen=true (bbox を超えるため全面 fallback)
// =============================================================================

import { registerEffectPreset, deterministicRandom } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  shiftPx: 6,
  jitterPx: 0,
  redColor: "#ff0040",
  greenColor: "#00ffa0",
  blueColor: "#0080ff",
  blendMode: "screen",
  drawBody: true,
});

const CONTROLS = [
  { key: "shiftPx", label: "ずれ幅 (px)", type: "number", min: 0, max: 80, step: 1 },
  { key: "jitterPx", label: "ランダム揺らぎ (px)", type: "number", min: 0, max: 32, step: 1 },
  { key: "redColor", label: "R チャネル色", type: "color" },
  { key: "greenColor", label: "G チャネル色", type: "color" },
  { key: "blueColor", label: "B チャネル色", type: "color" },
  {
    key: "blendMode", label: "ブレンドモード", type: "select",
    options: [
      { value: "screen", label: "screen (暗背景で映える)" },
      { value: "lighter", label: "加算" },
      { value: "source-over", label: "通常" },
    ],
  },
  {
    key: "drawBody", label: "本体を重ねる", type: "select",
    options: [
      { value: true, label: "ON" },
      { value: false, label: "OFF (チャネルのみ)" },
    ],
  },
];

registerEffectPreset({
  id: "rgb_shift",
  label: "RGB ずれ",
  slots: ["effect"],
  needsOffscreenRedraw: true,
  needsLayerComposite: true,
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  resolveRuntimeFlags(params, _ctx) {
    const jitter = Math.max(0, Number(params?.jitterPx ?? DEFAULT_PARAMS.jitterPx));
    const shift = Math.max(0, Number(params?.shiftPx ?? DEFAULT_PARAMS.shiftPx));
    return {
      // jitter=0 ならチャネルずれは静的、1 回焼けば済む。
      needsOffscreenRedraw: jitter > 0,
      needsLayerComposite: true,
      // 大きな shift は bbox を超える可能性が高い。fullCanvas 化して欠けを防ぐ。
      fullCanvasOffscreen: shift > 16 || jitter > 16,
    };
  },
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    const origStyle = clip?.style;
    if (!origStyle) { baseDraw(ctx); return; }
    const shiftPx = Math.max(0, Number(params?.shiftPx ?? DEFAULT_PARAMS.shiftPx));
    const jitterPx = Math.max(0, Number(params?.jitterPx ?? DEFAULT_PARAMS.jitterPx));
    const blendMode = String(params?.blendMode || DEFAULT_PARAMS.blendMode);
    const drawBody = params?.drawBody !== false;

    const channels = [
      { color: params?.redColor || DEFAULT_PARAMS.redColor },
      { color: params?.greenColor || DEFAULT_PARAMS.greenColor },
      { color: params?.blueColor || DEFAULT_PARAMS.blueColor },
    ];

    const origColor = origStyle.color;
    const origOutlineColor = origStyle.outlineColor;
    const origGlow = origStyle.glow;
    const origShadow = origStyle.dropShadow;

    // チャネル合成は独自 blend で行う。glow/shadow が乗ると色が濁るため、
    // チャネル描画時のみ無効化する (= 本体描画時に元の glow/shadow を復元)。
    ctx.save();
    try {
      ctx.globalCompositeOperation = blendMode;
      for (let i = 0; i < channels.length; i += 1) {
        const angle = (i * Math.PI * 2) / 3;   // 0°, 120°, 240°
        const baseX = Math.cos(angle) * shiftPx;
        const baseY = Math.sin(angle) * shiftPx;
        const jx = jitterPx > 0
          ? (deterministicRandom(clip?.id || "", frameIdx, i * 2) - 0.5) * 2 * jitterPx
          : 0;
        const jy = jitterPx > 0
          ? (deterministicRandom(clip?.id || "", frameIdx, i * 2 + 1) - 0.5) * 2 * jitterPx
          : 0;
        ctx.save();
        ctx.translate(baseX + jx, baseY + jy);
        try {
          origStyle.color = channels[i].color;
          origStyle.outlineColor = channels[i].color;
          // チャネル描画では glow / shadow を一時的に切る (色濁り防止)
          if (origGlow) origStyle.glow = { ...origGlow, enabled: false };
          if (origShadow) origStyle.dropShadow = { ...origShadow, enabled: false };
          baseDraw(ctx);
        } finally {
          origStyle.color = origColor;
          origStyle.outlineColor = origOutlineColor;
          origStyle.glow = origGlow;
          origStyle.dropShadow = origShadow;
        }
        ctx.restore();
      }
    } finally {
      ctx.restore();
    }

    if (drawBody) {
      baseDraw(ctx);   // 本体は元の色・glow・shadow で上書き
    }
  },
});
