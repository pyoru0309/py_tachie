// =============================================================================
// renderer/text-clip-draw.js
//
// TextClip (caption / mv_text) を 1 件描画するエントリポイント。
//
// 現状の役割:
//   - kind ("caption" | "mv_text") を解決
//   - clip.animation.{body,in,out} と clip.effectPreset を解決
//   - baseDraw = drawCaptionClip(ctx, clip, sceneSec) を closure で作って渡す
//   - 効果スタックの順序は外→内: body → in/out → effect → baseDraw
//
// Phase 1 では fade_slide (in/out) と typewriter (in) のみ実装。
// body / effect 系プリセットは Phase 2/3 で追加。
//
// API:
//   drawTextClip(ctx, clip, sceneSec, frameIdx, context)
//   drawTextClipsOnCanvas(ctx, clips, sceneSec, frameIdx, context)
//   analyzeRuntimeFlags(clips, sceneSec, context)
//     → { needsLayerComposite, needsOffscreenRedraw, fingerprint }
//     refreshTelopCanvas が毎フレーム再描画するかの判定材料。
//   PROJECT_FPS_REF (秒→フレーム量子化用) は呼出側で参照する想定。
// =============================================================================

import { drawCaptionClip, releaseTextScratch } from "./text-core.js";
import { getEffectPreset, resolveRuntimeFlags } from "./text-effects.js";
import { PROJECT_FPS } from "../timecode.js";
// 副作用登録: プリセットを全部読み込む。
import "./text-effects/index.js";

const KIND_CAPTION = "caption";
const KIND_MV_TEXT = "mv_text";

function _resolveKind(clip) {
  const k = String(clip?.kind || "").toLowerCase();
  return k === KIND_MV_TEXT ? KIND_MV_TEXT : KIND_CAPTION;
}

// clip の active 判定 (drawCaptionClip 内部でも判定するが、効果適用前に弾きたい)。
function _isActiveAt(clip, sceneSec) {
  if (!clip || typeof clip !== "object") return false;
  const start = (Number(clip.startFrame) || 0) / PROJECT_FPS;
  const dur = (Number(clip.durationFrame) || 0) / PROJECT_FPS;
  if (dur <= 0) return false;
  return sceneSec >= start && sceneSec < start + dur;
}

function _clipDurationSec(clip) {
  return (Number(clip?.durationFrame) || 0) / PROJECT_FPS;
}

function _clipStartSec(clip) {
  return (Number(clip?.startFrame) || 0) / PROJECT_FPS;
}

// animation スロットの記述から、現在 active なプリセット + そのときの localSec を返す。
// in / out は durSec の窓に入っているかを判定。
function _resolveAnimationLayer(clip, slotKey, sceneSec) {
  const anim = clip?.animation;
  if (!anim || typeof anim !== "object") return null;
  const entry = anim[slotKey];
  if (!entry || typeof entry !== "object") return null;
  const presetId = entry.preset;
  if (!presetId) return null;
  const preset = getEffectPreset(presetId);
  if (!preset) return null;
  const params = entry.params || {};
  const start = _clipStartSec(clip);
  const dur = _clipDurationSec(clip);
  const elapsed = sceneSec - start;
  if (slotKey === "in") {
    if (elapsed < 0) return null;
    // ★ durSec の解釈: プリセット側に durSec が定義されている場合のみ「durSec を
    //   過ぎたら外す」。typewriter のように durSec を持たないプリセットは clip
    //   全期間 active として扱う (= 表示文字数が full に到達した後も active が続き、
    //   全文表示状態を描き続ける)。
    const durRaw = params.durSec ?? preset.defaultParams.durSec;
    if (durRaw != null) {
      const durIn = Math.max(0, Number(durRaw));
      if (durIn <= 0) return null;
      if (elapsed >= durIn) return null;
    }
    return { preset, params, slot: "animation_in", localSec: elapsed };
  }
  if (slotKey === "out") {
    const remaining = dur - elapsed;
    if (remaining < 0) return null;
    const durRaw = params.durSec ?? preset.defaultParams.durSec;
    if (durRaw != null) {
      const durOut = Math.max(0, Number(durRaw));
      if (durOut <= 0) return null;
      if (remaining > durOut) return null;
      return { preset, params, slot: "animation_out", localSec: remaining };
    }
    // durSec を持たない out 系プリセットは clip 全期間 active。localSec は remaining。
    return { preset, params, slot: "animation_out", localSec: remaining };
  }
  if (slotKey === "body") {
    // body はクリップ全期間動く。durSec の概念は無いので elapsed を localSec として渡す。
    return { preset, params, slot: "animation_body", localSec: elapsed };
  }
  return null;
}

function _resolveEffect(clip, sceneSec) {
  if (_resolveKind(clip) !== KIND_MV_TEXT) return null;
  const id = clip?.effectPreset;
  if (!id) return null;
  const preset = getEffectPreset(id);
  if (!preset) return null;
  const params = clip?.effectParams || {};
  const elapsed = sceneSec - _clipStartSec(clip);
  return { preset, params, slot: "effect", localSec: elapsed };
}

function _frameIdxFor(sceneSec, context) {
  const fps = Math.max(1, Number(context?.characterAnimationFps) || 12);
  return Math.floor(Math.max(0, sceneSec) * fps);
}

export function drawTextClip(ctx, clip, sceneSec, _frameIdx, context) {
  if (!_isActiveAt(clip, sceneSec)) return false;
  if (!String(clip?.text || "")) return false;

  // baseDraw = 「素の caption 描画 1 件分」。プリセット側はこの closure を
  // ctx.save/translate/globalAlpha で囲って呼ぶ。
  const baseDraw = (ctx2) => {
    // drawCaptionClip は内部で _isActiveAt と同等の判定を行う。
    // typewriter が clip.text を書き換えている可能性があるので、必ず最新の clip を渡す。
    drawCaptionClip(ctx2, clip, sceneSec);
  };

  // 効果スタック (外→内): body → in & out → effect → baseDraw
  // in と out が同時 active の場合は両方の transform を順に適用する。
  const body = _resolveAnimationLayer(clip, "body", sceneSec);
  const animIn = _resolveAnimationLayer(clip, "in", sceneSec);
  const animOut = _resolveAnimationLayer(clip, "out", sceneSec);
  const effect = _resolveEffect(clip, sceneSec);

  const ctxForFrame = (context && typeof context === "object") ? context : {};
  const frameIdx = _frameIdxFor(sceneSec, ctxForFrame);

  // closure を内側から外側に積み上げる (各 preset は baseDraw を受け取る)。
  let next = baseDraw;
  if (effect) {
    const inner = next;
    next = (ctx2) => effect.preset.draw(
      ctx2, clip, effect.params, effect.localSec, frameIdx,
      { ...ctxForFrame, slot: effect.slot, clipDurationSec: _clipDurationSec(clip) },
      inner,
    );
  }
  if (animIn) {
    const inner = next;
    next = (ctx2) => animIn.preset.draw(
      ctx2, clip, animIn.params, animIn.localSec, frameIdx,
      { ...ctxForFrame, slot: animIn.slot, clipDurationSec: _clipDurationSec(clip) },
      inner,
    );
  }
  if (animOut) {
    const inner = next;
    next = (ctx2) => animOut.preset.draw(
      ctx2, clip, animOut.params, animOut.localSec, frameIdx,
      { ...ctxForFrame, slot: animOut.slot, clipDurationSec: _clipDurationSec(clip) },
      inner,
    );
  }
  if (body) {
    const inner = next;
    next = (ctx2) => body.preset.draw(
      ctx2, clip, body.params, body.localSec, frameIdx,
      { ...ctxForFrame, slot: body.slot, clipDurationSec: _clipDurationSec(clip) },
      inner,
    );
  }
  next(ctx);
  return true;
}

export function drawTextClipsOnCanvas(ctx, clips, sceneSec, frameIdx, context) {
  if (!Array.isArray(clips) || clips.length === 0) {
    releaseTextScratch();
    return;
  }
  for (const clip of clips) {
    drawTextClip(ctx, clip, sceneSec, frameIdx, context);
  }
  releaseTextScratch();
}

// =============================================================================
// runtime flag 集計
//
// refreshTelopCanvas が「毎フレーム redraw すべきか」を判定するための分析。
// シーン内 active clip 集合の OR を取り、layerComposite または offscreenRedraw が
// 立つフレームは毎フレーム redraw、そうでないなら旧 fingerprint 経路を維持する。
// =============================================================================

// 1 clip の runtime flag を計算する (= analyzeRuntimeFlags の per-clip 版)。
// per-clip offscreen キャッシュの判定に使う (静的 clip のみメモ化対象)。
export function resolveClipRuntimeFlags(clip, sceneSec, context) {
  let needsLayerComposite = false;
  let needsOffscreenRedraw = false;
  const slotsToCheck = [];
  const animIn = _resolveAnimationLayer(clip, "in", sceneSec);
  if (animIn) slotsToCheck.push({ preset: animIn.preset, params: animIn.params });
  const animOut = _resolveAnimationLayer(clip, "out", sceneSec);
  if (animOut) slotsToCheck.push({ preset: animOut.preset, params: animOut.params });
  const body = _resolveAnimationLayer(clip, "body", sceneSec);
  if (body) slotsToCheck.push({ preset: body.preset, params: body.params });
  const effect = _resolveEffect(clip, sceneSec);
  if (effect) slotsToCheck.push({ preset: effect.preset, params: effect.params });
  for (const { preset, params } of slotsToCheck) {
    const flags = resolveRuntimeFlags(preset, params, context || {});
    if (flags.needsLayerComposite) needsLayerComposite = true;
    if (flags.needsOffscreenRedraw) needsOffscreenRedraw = true;
  }
  return { needsLayerComposite, needsOffscreenRedraw };
}

export function analyzeRuntimeFlags(clips, sceneSec, context) {
  let needsLayerComposite = false;
  let needsOffscreenRedraw = false;
  let activeCount = 0;
  const fpParts = [];
  if (!Array.isArray(clips)) {
    return { needsLayerComposite, needsOffscreenRedraw, fingerprint: "", activeCount };
  }
  for (const clip of clips) {
    if (!_isActiveAt(clip, sceneSec)) continue;
    activeCount += 1;
    fpParts.push(`${clip.id || ""}:${clip.startFrame || 0}:${clip.durationFrame || 0}`);
    const flags = resolveClipRuntimeFlags(clip, sceneSec, context);
    if (flags.needsLayerComposite) needsLayerComposite = true;
    if (flags.needsOffscreenRedraw) needsOffscreenRedraw = true;
  }
  return {
    needsLayerComposite,
    needsOffscreenRedraw,
    fingerprint: fpParts.join("|"),
    activeCount,
  };
}

// =============================================================================
// per-clip offscreen キャッシュ (Phase 2-5)
//
// 静的 clip (needsOffscreenRedraw=false && needsLayerComposite=false) の
// 描画結果を clip ID 単位で再利用する。content が変わるまで再描画しない。
// 動的 clip は対象外 (毎フレーム plane に直接描く)。
//
// bbox は 1920×1080 全面で割り切る (= scene 共通の overlay plane と同サイズ)。
// MVP として簡略。Phase 3 以降で bbox + margin に縮める最適化が可能。
// =============================================================================

export function makeClipOffscreenCache() {
  return new Map();
}

export function disposeClipOffscreenCache(cache) {
  if (!(cache instanceof Map)) return;
  for (const entry of cache.values()) {
    if (entry?.canvas) {
      try {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      } catch (_) {}
    }
  }
  cache.clear();
}

// 静的 clip の見た目を決める主要キーを単純連結したハッシュ。
// 「静的」= runtime flag が両方 false の意味で、effectPreset/animation を持っていても
// それらが時間で変化しないケース (例: neon_glow で pulse/flicker=0 等)。
// その場合 effect/animation の中身は見た目に影響するため fingerprint に必ず含める。
function _staticClipFingerprint(clip) {
  if (!clip) return "";
  const s = clip.style || {};
  return [
    clip.id,
    clip.kind || "caption",
    clip.text,
    clip.position, clip.x ?? "", clip.y ?? "",
    s.fontSize, s.fontFamily, s.fontWeight,
    s.color, s.outlineColor, s.outlineWidth,
    s.boxBackgroundColor ?? "", s.boxOpacity ?? "",
    s.boxPaddingX ?? "", s.boxPaddingY ?? "",
    s.align, s.letterSpacing ?? 0, s.lineSpacing ?? 0,
    s.enableOpticalKerning ? 1 : 0,
    s.opticalKerningHighQuality ? 1 : 0,
    s.rotation ?? 0,
    s.glow ? `g${s.glow.enabled ? 1 : 0}:${s.glow.color}:${s.glow.blurPx}:${s.glow.opacity}:${s.glow.intensity ?? 1}` : "",
    s.dropShadow ? `d${s.dropShadow.enabled ? 1 : 0}:${s.dropShadow.color}:${s.dropShadow.blurPx}:${s.dropShadow.offsetX}:${s.dropShadow.offsetY}:${s.dropShadow.opacity}:${s.dropShadow.intensity ?? 1}` : "",
    // ★ 静的 effect / animation も見た目に影響するため含める。
    clip.effectPreset || "",
    JSON.stringify(clip.effectParams || {}),
    JSON.stringify(clip.animation || {}),
  ].join("|");
}

// clip の offscreen を取得 (キャッシュにあれば再利用、無ければ焼く)。
// 戻り値: HTMLCanvasElement | null (text 空などで描画スキップ時)
//
// ★ drawTextClip 経由で焼く: 両 flag=false でも effectPreset (静的化された
//   neon_glow など) や静的化された animation を持つ clip がある
//   (= drawCaptionClip 直呼びだと effect が消える)。
//   静的なら時間に依存しない見た目になるので、frameIdx=0 で 1 回焼けば再利用できる。
export function getOrBakeStaticClipOffscreen(cache, clip, sceneSec, canvasW, canvasH, context) {
  if (!(cache instanceof Map) || !clip) return null;
  const fp = _staticClipFingerprint(clip);
  const existing = cache.get(clip.id);
  if (existing && existing.contentFingerprint === fp
      && existing.canvas.width === canvasW
      && existing.canvas.height === canvasH) {
    return existing.canvas;
  }
  // 焼き直し
  let canvas = existing?.canvas;
  if (!canvas) {
    canvas = document.createElement("canvas");
  }
  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvas.width = canvasW;
    canvas.height = canvasH;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvasW, canvasH);
  // drawTextClip 経由で焼く (effect/animation を反映)。
  // 静的なら frameIdx は何でも OK、ここでは 0 固定。
  drawTextClip(ctx, clip, sceneSec, 0, context || {});
  cache.set(clip.id, { canvas, contentFingerprint: fp });
  return canvas;
}

// active 集合に含まれない clip のキャッシュエントリを破棄する (メモリ節約)。
export function evictUnusedClipOffscreens(cache, activeClipIds) {
  if (!(cache instanceof Map)) return;
  const activeSet = new Set(activeClipIds);
  for (const id of Array.from(cache.keys())) {
    if (!activeSet.has(id)) {
      const entry = cache.get(id);
      if (entry?.canvas) {
        try {
          entry.canvas.width = 0;
          entry.canvas.height = 0;
        } catch (_) {}
      }
      cache.delete(id);
    }
  }
}
