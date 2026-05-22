// =============================================================================
// renderer/text-effects/shake_beat.js
//
// "shake_beat" — 拍に合わせて文字を「ドン」と揺らす持続モーション。slot: animation_body。
//
// 仕様 §7:
//   - context.sceneBpm が無い場合は bpmSync=false 扱いに自動降格
//   - decaySec で拍直後だけ強く揺れ、すぐ収束する
//   - 揺れ軸は deterministicRandom(clipId, beatIdx) で beat ごとに方向固定
//   - 文字本体は静止画でよい (composite 段で揺らす) → needsOffscreenRedraw: false
//
// 実装:
//   BPM 同期: localSec * (bpm/60) で beatIdx と beat 内位相を計算。
//             各拍直後 decaySec で揺れ強度 exp 減衰、それ以降は 0。
//   非同期 (bpmSync=false or sceneBpm 不在): 連続的な sin 揺れ。
// =============================================================================

import { registerEffectPreset, deterministicRandom } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  amplitudePx: 10,
  bpmSync: true,
  decaySec: 0.18,
  freqHz: 8,           // bpmSync=false のときの揺れ周波数
});

const CONTROLS = [
  { key: "amplitudePx", label: "揺れ幅 (px)", type: "number", min: 0, max: 80, step: 1 },
  {
    key: "bpmSync", label: "BPM 同期", type: "select",
    options: [
      { value: true, label: "ON (拍ごとに「ドン」)" },
      { value: false, label: "OFF (連続揺れ)" },
    ],
  },
  { key: "decaySec", label: "拍後の減衰時間 (秒)", type: "number", min: 0.05, max: 1, step: 0.01 },
  { key: "freqHz", label: "非同期時の周波数 (Hz)", type: "number", min: 1, max: 30, step: 0.5 },
];

registerEffectPreset({
  id: "shake_beat",
  label: "拍揺れ",
  slots: ["animation_body"],
  // 文字本体ピクセルは不変 (= scratch 焼き直しなし)、composite 段の transform だけ。
  needsOffscreenRedraw: false,
  needsLayerComposite: true,
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  resolveRuntimeFlags(params, _ctx) {
    const amp = Math.max(0, Number(params?.amplitudePx ?? DEFAULT_PARAMS.amplitudePx));
    return {
      needsOffscreenRedraw: false,
      needsLayerComposite: amp > 0,    // amp=0 なら完全静止
    };
  },
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    const amp = Math.max(0, Number(params?.amplitudePx ?? DEFAULT_PARAMS.amplitudePx));
    if (amp <= 0) { baseDraw(ctx); return; }
    const wantBpmSync = params?.bpmSync !== false;
    const bpm = Number(context?.sceneBpm);
    const useBpmSync = wantBpmSync && Number.isFinite(bpm) && bpm > 0;

    let shakeX = 0;
    let shakeY = 0;
    if (useBpmSync) {
      const beatSec = 60 / bpm;
      const beatIdx = Math.floor(localSec / beatSec);
      const elapsedInBeat = localSec - beatIdx * beatSec;
      const decaySec = Math.max(0.001, Number(params?.decaySec ?? DEFAULT_PARAMS.decaySec));
      // 拍直後ほど強い、decaySec を経て 0 に近づく (exp 減衰、3σ 相当)
      const strength = elapsedInBeat < decaySec
        ? Math.exp(-(elapsedInBeat / decaySec) * 3)
        : 0;
      if (strength > 0) {
        // beat ごとに揺れ方向を固定 (= 1 拍内ではぶれない、deterministic)
        const angle = deterministicRandom(clip?.id || "", beatIdx, 7) * Math.PI * 2;
        shakeX = Math.cos(angle) * amp * strength;
        shakeY = Math.sin(angle) * amp * strength;
      }
    } else {
      // 非同期: 二軸の sin で連続的に揺れる (Lissajous 風)
      const freq = Math.max(0.1, Number(params?.freqHz ?? DEFAULT_PARAMS.freqHz));
      shakeX = Math.sin(localSec * freq * Math.PI * 2) * amp;
      shakeY = Math.cos(localSec * freq * Math.PI * 2 * 1.3) * amp * 0.7;
    }

    if (shakeX === 0 && shakeY === 0) {
      baseDraw(ctx);
      return;
    }
    ctx.save();
    ctx.translate(shakeX, shakeY);
    baseDraw(ctx);
    ctx.restore();
  },
});
