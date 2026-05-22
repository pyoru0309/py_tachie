// =============================================================================
// renderer/text-effects.js
//
// TextClip プリセットのレジストリ。
// 各プリセットは `static/js/renderer/text-effects/<id>.js` で
// `import { registerEffectPreset } from "../text-effects.js";` し、モジュール
// 読み込み時の副作用で自身を登録する。
//
// 公開 API:
//   registerEffectPreset(preset)
//   getEffectPreset(id)             id 未登録時は null
//   listEffectPresets({slot})       slot で絞る (UI セレクタ用)
//   resolveRuntimeFlags(preset, params, context)
//                                   resolveRuntimeFlags 未実装プリセットは固定値
//   deterministicRandom(clipId, frame, salt = 0)
//                                   書き出し再現性のため Math.random() 直接禁止
//
// プリセット個別実装側の slot 値は _contract.js の TEXT_EFFECT_SLOT_VALUES を参照。
// =============================================================================

import { TEXT_EFFECT_SLOT_VALUES } from "./text-effects/_contract.js";

const _registry = new Map();

export function registerEffectPreset(preset) {
  if (!preset || typeof preset !== "object") {
    throw new Error("registerEffectPreset: preset must be an object");
  }
  const id = String(preset.id || "").trim();
  if (!id) throw new Error("registerEffectPreset: preset.id is required");
  if (_registry.has(id)) {
    // 同 id の重複登録は単純に上書き (HMR / テスト都合)。
    // 本番では起動時に 1 度だけ登録される想定。
    console.warn(`[text-effects] overwriting preset "${id}"`);
  }
  // 1 プリセットが複数 slot を持つことを許す (fade_slide は in/out 両方)。
  // slots: ["animation_in","animation_out"] の形を期待し、旧 slot: 単一文字列も
  // 互換のため受け付ける (Phase 1 開発中の中間状態)。
  const slotsRaw = preset.slots ?? (preset.slot ? [preset.slot] : []);
  const slots = Array.isArray(slotsRaw)
    ? slotsRaw.map((s) => String(s).trim()).filter(Boolean)
    : [String(slotsRaw).trim()].filter(Boolean);
  if (slots.length === 0) {
    throw new Error(`registerEffectPreset: preset.slots is required (id=${id})`);
  }
  for (const s of slots) {
    if (!TEXT_EFFECT_SLOT_VALUES.includes(s)) {
      throw new Error(
        `registerEffectPreset: slot "${s}" is not one of ${TEXT_EFFECT_SLOT_VALUES.join(", ")} (id=${id})`,
      );
    }
  }
  if (typeof preset.draw !== "function") {
    throw new Error(`registerEffectPreset: preset.draw must be a function (id=${id})`);
  }
  _registry.set(id, {
    id,
    label: String(preset.label || id),
    slots,
    needsOffscreenRedraw: !!preset.needsOffscreenRedraw,
    needsLayerComposite: !!preset.needsLayerComposite,
    fullCanvasOffscreen: !!preset.fullCanvasOffscreen,
    defaultParams: { ...(preset.defaultParams || {}) },
    controls: Array.isArray(preset.controls) ? preset.controls.slice() : [],
    resolveRuntimeFlags: typeof preset.resolveRuntimeFlags === "function"
      ? preset.resolveRuntimeFlags
      : null,
    draw: preset.draw,
  });
}

export function getEffectPreset(id) {
  if (!id) return null;
  return _registry.get(String(id)) || null;
}

export function listEffectPresets({ slot } = {}) {
  const out = [];
  for (const preset of _registry.values()) {
    if (slot && !preset.slots.includes(slot)) continue;
    out.push(preset);
  }
  return out;
}

// preset.resolveRuntimeFlags が未実装なら固定値をそのまま返す。
// 呼び出し側 (refreshTelopCanvas 拡張) は clip ごとに 1 回だけ評価して
// キャッシュする (毎フレームは呼ばない)。
export function resolveRuntimeFlags(preset, params, context) {
  if (!preset) {
    return {
      needsOffscreenRedraw: false,
      needsLayerComposite: false,
      fullCanvasOffscreen: false,
    };
  }
  if (preset.resolveRuntimeFlags) {
    const dyn = preset.resolveRuntimeFlags(params || {}, context || {}) || {};
    return {
      needsOffscreenRedraw: dyn.needsOffscreenRedraw ?? preset.needsOffscreenRedraw,
      needsLayerComposite: dyn.needsLayerComposite ?? preset.needsLayerComposite,
      fullCanvasOffscreen: dyn.fullCanvasOffscreen ?? preset.fullCanvasOffscreen,
    };
  }
  return {
    needsOffscreenRedraw: preset.needsOffscreenRedraw,
    needsLayerComposite: preset.needsLayerComposite,
    fullCanvasOffscreen: preset.fullCanvasOffscreen,
  };
}

// =============================================================================
// deterministic 乱数 (mulberry32 ベース)
//
// 書き出し再現性のため、プリセット内の jitter / dropout / shake direction は
// 必ずこれを通す。Math.random() 直接使用は禁止 (export 中に分岐すると視覚的に
// 再現性が消える)。
//
// シードは clipId と frameIdx と salt をハッシュして 32-bit に潰す。
// =============================================================================

// 文字列を 32-bit に潰す (FNV-1a)。
function _fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function _mulberry32(seed) {
  let s = seed >>> 0;
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function deterministicRandom(clipId, frame, salt = 0) {
  const idHash = _fnv1a32(String(clipId || ""));
  // 32-bit でラップする。idHash と frame・salt が独立な変動軸になるよう
  // bit shift 後に XOR で混ぜ込む (素直に加算するとフレーム間で線形相関する)。
  const f = ((Number(frame) | 0) ^ ((Number(frame) | 0) << 13)) >>> 0;
  const s = ((Number(salt) | 0) ^ ((Number(salt) | 0) << 7)) >>> 0;
  const seed = ((idHash ^ f ^ (s * 0x85ebca6b)) >>> 0);
  return _mulberry32(seed);
}
