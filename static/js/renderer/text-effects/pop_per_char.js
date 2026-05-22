// =============================================================================
// renderer/text-effects/pop_per_char.js
//
// "pop_per_char" — グリフ単位で出現タイミング + scale overshoot を持つ
// 入場アニメ。slot: animation_in。
//
// 仕様 §7:
//   - グリフごとに localCharSec = localSec - i * perCharDelaySec
//   - localCharSec < 0 は非表示
//   - localCharSec < settleSec は overshoot + scale 補間
//   - グリフ位置は layoutTextRun の x をベースに固定 (measure / draw でズレない)
//   - needsOffscreenRedraw: true / needsLayerComposite: true
//
// 実装:
//   text-core.js drawTextLines に追加した glyphTransformFn を経由して
//   グリフ単位 transform を適用する。clip._glyphTransform に transform 関数を
//   一時的に乗せて baseDraw → drawCaptionClip → drawTextLines に伝搬する。
//   optical kerning ON でしかフックが効かないため、ここで強制 true にする。
// =============================================================================

import { registerEffectPreset } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  perCharDelaySec: 0.06,
  settleSec: 0.32,
  overshoot: 0.25,
  startScale: 0.3,
  popY: 30,
});

const CONTROLS = [
  { key: "perCharDelaySec", label: "文字間隔 (秒)", type: "number", min: 0, max: 0.5, step: 0.01 },
  { key: "settleSec", label: "settle 長 (秒)", type: "number", min: 0.05, max: 1.5, step: 0.05 },
  { key: "overshoot", label: "オーバーシュート量", type: "number", min: 0, max: 0.8, step: 0.05 },
  { key: "startScale", label: "開始 scale", type: "number", min: 0, max: 1, step: 0.05 },
  { key: "popY", label: "下からのオフセット (px)", type: "number", min: 0, max: 200, step: 1 },
];

function _easeOut(t) { return 1 - Math.pow(1 - t, 3); }

registerEffectPreset({
  id: "pop_per_char",
  label: "ポップ (文字単位)",
  slots: ["animation_in"],
  // 文字本体の見た目が時間で変わる (出現タイミング+scale)。
  needsOffscreenRedraw: true,
  needsLayerComposite: true,
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  resolveRuntimeFlags(params, _ctx) {
    const perDelay = Math.max(0, Number(params?.perCharDelaySec ?? DEFAULT_PARAMS.perCharDelaySec));
    const settle = Math.max(0, Number(params?.settleSec ?? DEFAULT_PARAMS.settleSec));
    // perDelay=0 かつ settle=0 のときは効果が消える (静止画でよい)。
    const animated = perDelay > 0 || settle > 0;
    return {
      needsOffscreenRedraw: animated,
      needsLayerComposite: true,
    };
  },
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    const perDelay = Math.max(0, Number(params?.perCharDelaySec ?? DEFAULT_PARAMS.perCharDelaySec));
    const settle = Math.max(0.001, Number(params?.settleSec ?? DEFAULT_PARAMS.settleSec));
    const overshoot = Math.max(0, Number(params?.overshoot ?? DEFAULT_PARAMS.overshoot));
    const startScale = Math.max(0, Math.min(1, Number(params?.startScale ?? DEFAULT_PARAMS.startScale)));
    const popY = Number(params?.popY ?? DEFAULT_PARAMS.popY);

    // (globalCharIdx, char) → glyph-local transform
    const transformFn = (idx, _char) => {
      const t = localSec - idx * perDelay;
      if (t < 0) return { visible: false };
      if (t >= settle) return null;   // 通常描画 (= 規定位置 / scale=1)
      const p = Math.min(1, Math.max(0, t / settle));
      const ease = _easeOut(p);
      // 半開区間 [0, 1) の三角関数 sin(πp) は 0→1→0 で「ぴょこっ」と上振れさせる。
      const overshootBoost = overshoot * Math.sin(p * Math.PI);
      const scale = startScale + (1 - startScale) * ease + overshootBoost;
      const dy = popY * (1 - ease);     // 下からせり上がる
      const alpha = Math.min(1, p * 3); // 0..0.33 で透明→不透明
      return { scale, dy, alpha };
    };

    const origStyle = clip?.style;
    if (!origStyle) { baseDraw(ctx); return; }
    // optical kerning を強制 ON にしないと glyph 単位描画にならない。
    const origOpticalCk = origStyle.enableOpticalKerning;
    const hadGlyphTransform = Object.prototype.hasOwnProperty.call(clip, "_glyphTransform");
    const origGlyphTransform = clip._glyphTransform;
    try {
      origStyle.enableOpticalKerning = true;
      clip._glyphTransform = transformFn;
      baseDraw(ctx);
    } finally {
      origStyle.enableOpticalKerning = origOpticalCk;
      if (hadGlyphTransform) clip._glyphTransform = origGlyphTransform;
      else delete clip._glyphTransform;
    }
  },
});
