// =============================================================================
// renderer/text-effects/fade_slide.js
//
// 入退場アニメーション "fade_slide"。
// - slots: animation_in / animation_out
// - 文字本体は静的に焼き、composite 段で位置オフセット + α を補間する
//   (§6.2: animation 由来の opacity / 位置は plane ではなく clip-local で適用)
// - Caption でも MV でも軽量に使える。Caption MVP の必須プリセット。
//
// 呼出元 (drawTextClip):
//   - animation_in 時: localSec = sceneSec - clipStart (0..params.durSec の窓)
//   - animation_out 時: localSec = clipDurationSec - (sceneSec - clipStart) (残り時間、同窓)
//   どちらの場合も「localSec が 0→durSec へ進むほど 0%→100% に補間」する。
//   in: 0%=透明・離れた位置 → 100%=不透明・規定位置
//   out: 残り 0%=透明・離れた位置 → 残り 100%=不透明・規定位置
//   (= out では localSec=durSec のとき完全表示、localSec=0 のとき完全消失)
//
// params:
//   durSec     入退場の長さ (秒)。0 で no-op
//   direction  "up" / "down" / "left" / "right"
//              animation_in: direction の方向 *へ* 飛び込むイメージ
//                            (例: up = 下から上に上がってくる)
//              animation_out: direction の方向 *へ* 抜けていくイメージ
//                            (例: up = 上に抜けていく)
//   distancePx スライド量 px。0 で α フェードのみ
//   easing     "ease_out" (default) / "linear" / "ease_in_out"
// =============================================================================

import { registerEffectPreset } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  durSec: 0.4,
  direction: "up",
  distancePx: 60,
  easing: "ease_out",
});

const CONTROLS = [
  { key: "durSec", label: "長さ (秒)", type: "number", min: 0, max: 5, step: 0.05 },
  {
    key: "direction", label: "方向", type: "select",
    options: [
      { value: "up", label: "上方向" },
      { value: "down", label: "下方向" },
      { value: "left", label: "左方向" },
      { value: "right", label: "右方向" },
    ],
  },
  { key: "distancePx", label: "スライド量 (px)", type: "number", min: 0, max: 500, step: 1 },
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

// direction の方向 "へ" 距離 d だけ外側に置くオフセット。
// y-down 画面なので "up" は dy が負。
function _dirOffset(direction, d) {
  switch (direction) {
    case "down":  return { dx: 0, dy:  d };
    case "left":  return { dx: -d, dy: 0 };
    case "right": return { dx:  d, dy: 0 };
    case "up":
    default:      return { dx: 0, dy: -d };
  }
}

function _draw(ctx, params, localSec, slot, baseDraw) {
  const durSec = Math.max(0, Number(params?.durSec ?? DEFAULT_PARAMS.durSec));
  if (durSec <= 0) { baseDraw(ctx); return; }
  // localSec が durSec を超えていたら「ピーク状態」= 規定位置 + 不透明。
  // 呼出側でフィルタしていれば来ない想定だが、安全側で clamp する。
  const t = Math.min(1, Math.max(0, localSec / durSec));
  const eased = _ease(t, params?.easing || DEFAULT_PARAMS.easing);
  const alpha = eased;
  if (alpha <= 0) return;  // 描画スキップ
  const distance = Math.max(0, Number(params?.distancePx ?? DEFAULT_PARAMS.distancePx));
  // in と out で direction の解釈が逆: in は「下から上へ」「外から内へ」、
  // out は「上へ抜ける」「内から外へ」。
  // どちらも「初期オフセット = direction の方向に distance 離れた位置」を採用し、
  // in は (1 - eased) * distance で 0 に向けて寄り、out は同じ式で 0 から離れる
  // (in: localSec→durSec で寄ってくる / out: 残り→0 で離れていく)
  // → どちらも (1 - eased) を係数にすれば、in は「離れた位置から戻る」、out は
  //   「規定位置から離れる」になる。
  const offMagnitude = (1 - eased) * distance;
  // 方向解釈: in は「direction で示した方向から飛び込む」、out は「direction で
  // 示した方向へ抜ける」と読む。視覚的には対称的なので、in 時は方向を反転して
  // 「離れた位置」を出す (例: up = 下方向にオフセットしておいて 0 に寄る)。
  const sign = (slot === "animation_in") ? -1 : 1;
  const { dx, dy } = _dirOffset(params?.direction || DEFAULT_PARAMS.direction, offMagnitude * sign);
  ctx.save();
  ctx.translate(dx, dy);
  // 既存 globalAlpha を尊重して掛け合わせる (animation.body と併用時に潰さない)。
  ctx.globalAlpha = (ctx.globalAlpha ?? 1) * alpha;
  baseDraw(ctx);
  ctx.restore();
}

registerEffectPreset({
  id: "fade_slide",
  label: "フェードスライド",
  slots: ["animation_in", "animation_out"],
  needsOffscreenRedraw: false,   // 文字本体は不変
  needsLayerComposite: true,     // composite 段の transform/alpha が毎フレーム変わる
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    _draw(ctx, params, localSec, context?.slot, baseDraw);
  },
});
