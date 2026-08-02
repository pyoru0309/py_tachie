// =============================================================================
// title-editor / bbox.js
//
// TextClip の bounding box を「実描画 → alpha スキャン」で算出する。
//
// 公開 API:
//   measureClipBBox(clip) -> { inkX, inkY, inkW, inkH }
//     clip 原点 (clip.x/y) からの相対 ink 矩形。ink = テキスト本体 + outline +
//     box background。glow / dropShadow は含めない (= 編集感が halo で振れない)。
//
//   inkBox(clip) -> { x, y, w, h }
//     measureClipBBox を clip.x/y で絶対座標化したもの。既存呼び出し互換。
//
//   visualBox(clip) -> { x, y, w, h }
//     ink + glow + dropShadow を全部含む絶対矩形。当面の呼び出し元はなし。
//     将来の自動トリム / はみ出し警告 / 光彩込みプレビュー枠で使う。
//
// 実装:
//   元 clip を浅クローンし、position="custom" / x,y を offscreen canvas 内側の
//   anchor へ移し替えて drawCaptionClip で焼く。mode="ink" は glow/dropShadow を
//   無効化、mode="visual" はそのまま。getImageData して alpha>0 の min/max を
//   走査し、anchor からの相対 offset を返す。
//
// キャッシュ:
//   { mode + text + style 主要キー + fontsEpoch } を fingerprint にして
//   結果を Map に持つ。clip.x/y は含めないのでドラッグ中は再スキャンしない。
//   FontFace の load 完了 (document.fonts.ready / loadingdone) で epoch を
//   増分し、フォール バックメトリクスで焼かれた古い結果を無効化する。
// =============================================================================

import { state } from "../state.js";
import { drawCaptionClip } from "../renderer/text-core.js";
import { verticalGlyphsEpoch } from "../renderer/text-vertical.js";
import { fontFamilyCssStack, resolveFontWeightCss } from "../font.js";

// ---------------------------------------------------------------------------
// オフスクリーン canvas プール (= measure 用と scan 用で別々に持つ)
// ---------------------------------------------------------------------------
let _measureCanvas = null;
let _scanCanvas = null;

function _getMeasureCtx() {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  return _measureCanvas.getContext("2d");
}

function _getScanCanvas(w, h) {
  if (!_scanCanvas) _scanCanvas = document.createElement("canvas");
  if (_scanCanvas.width !== w || _scanCanvas.height !== h) {
    _scanCanvas.width = w;
    _scanCanvas.height = h;
  }
  return _scanCanvas;
}

// ---------------------------------------------------------------------------
// font ready epoch (= フォント load 完了で全 cache を実質 invalidate)
// ---------------------------------------------------------------------------
let _fontsEpoch = 0;
if (typeof document !== "undefined" && document.fonts) {
  if (document.fonts.ready && typeof document.fonts.ready.then === "function") {
    document.fonts.ready.then(() => { _fontsEpoch += 1; });
  }
  if (typeof document.fonts.addEventListener === "function") {
    document.fonts.addEventListener("loadingdone", () => { _fontsEpoch += 1; });
  }
}

// ---------------------------------------------------------------------------
// fingerprint: clip.x/y / position は含めない (= ドラッグ中はキャッシュヒット)
// ---------------------------------------------------------------------------
const SEP = "";

function _baseFingerprint(clip) {
  const s = clip?.style || {};
  return [
    _fontsEpoch,
    clip?.text ?? "",
    s.fontSize, s.fontFamily, s.fontWeight,
    s.outlineWidth, s.outlineColor, s.color,
    s.align, s.letterSpacing, s.lineSpacing,
    s.boxOpacity, s.boxBackgroundColor, s.boxPaddingX, s.boxPaddingY,
    s.enableOpticalKerning, s.opticalKerningHighQuality,
    s.rotation,
    // 縦書き: モードと GSUB vert グリフ取得 epoch (取得前後で ink が変わる)
    s.writingMode === "vertical" ? `v${verticalGlyphsEpoch()}` : "",
  ].join(SEP);
}

function _fingerprintInk(clip) {
  return "ink" + SEP + _baseFingerprint(clip);
}

function _fingerprintVisual(clip) {
  const s = clip?.style || {};
  return "visual" + SEP + _baseFingerprint(clip)
    + SEP + JSON.stringify(s.glow || null)
    + SEP + JSON.stringify(s.dropShadow || null);
}

// ---------------------------------------------------------------------------
// 結果キャッシュ (FIFO eviction)
// ---------------------------------------------------------------------------
const _cache = new Map();
const CACHE_MAX = 256;

function _cachePut(key, value) {
  if (_cache.size >= CACHE_MAX) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
  _cache.set(key, value);
}

// ---------------------------------------------------------------------------
// 空テキスト / スキャン失敗時のフォールバック (= 掴める最小サイズ)
// ---------------------------------------------------------------------------
function _emptyRel(clip) {
  const fs = Math.max(12, Number(clip?.style?.fontSize) || 48);
  return {
    relX: 0,
    relY: 0,
    relW: Math.max(40, Math.round(fs * 1.5)),
    relH: Math.max(24, Math.round(fs * 1.3)),
  };
}

// ---------------------------------------------------------------------------
// scan canvas 寸法の見積もり (= measureText で行幅をざっくり取る軽い前段)
// ---------------------------------------------------------------------------
function _estimateExtent(clip, mode) {
  const s = clip?.style || {};
  const fs = Math.max(12, Number(s.fontSize) || 48);
  const text = String(clip?.text || "");
  const lines = text.split("\n");

  // ★ 重要: drawCaptionClip と同じ font resolve 経路を通すこと。
  //   familyId をそのまま `ctx.font` に書くと FontFace に登録されていない名前
  //   (= "auto_shipporiminchob1" のような内部 ID) になり、ブラウザが sans-serif
  //   へフォールバックする。advance が実フォントより小さくなり、scan canvas が
  //   不足して drawCaptionClip 描画の右端が clip される事故になる。
  //   fontFamilyCssStack / resolveFontWeightCss は drawCaptionClip 内部の
  //   `fontSpec` 構築と完全に同じ。
  const ctx = _getMeasureCtx();
  const familyId = s.fontFamily || state.manifest?.config?.defaultFont || "";
  const fontFamily = fontFamilyCssStack(familyId);
  const fontWeightCss = resolveFontWeightCss(familyId, String(s.fontWeight || "regular"));
  ctx.font = `${fontWeightCss} ${fs}px ${fontFamily}`;
  const letterSpacing = (Number(s.letterSpacing) || 0) / 1000 * fs;
  try { ctx.letterSpacing = `${letterSpacing}px`; } catch (_) {}

  let maxAdvance = 0;
  for (const line of lines) {
    const w = ctx.measureText(line || " ").width;
    if (w > maxAdvance) maxAdvance = w;
  }

  const outline = Math.max(0, Number(s.outlineWidth) || 0);
  const padX = Math.max(0, Number(s.boxPaddingX) || 0);
  const padY = Math.max(0, Number(s.boxPaddingY) || 0);
  const hasBox = Number(s.boxOpacity) > 0 && !!s.boxBackgroundColor;

  let glowBlur = 0, shadowBlur = 0, shadowOx = 0, shadowOy = 0;
  if (mode === "visual") {
    if (s.glow?.enabled) {
      const base = Math.max(0, Number(s.glow.blurPx) || 0);
      let mult = 1;
      if (Array.isArray(s.glow.passes)) {
        for (const p of s.glow.passes) {
          const m = Number(p?.blurMult);
          if (Number.isFinite(m) && m > mult) mult = m;
        }
      }
      glowBlur = base * mult;
    }
    if (s.dropShadow?.enabled) {
      shadowBlur = Math.max(0, Number(s.dropShadow.blurPx) || 0);
      shadowOx = Math.abs(Number(s.dropShadow.offsetX) || 0);
      shadowOy = Math.abs(Number(s.dropShadow.offsetY) || 0);
    }
  }
  // ガウシアン blur の有効半径は 3σ、念のため 4σ ぶん。offset は方向不明なので大きい方。
  const haloMargin = Math.ceil(4 * Math.max(glowBlur, shadowBlur)) + Math.max(shadowOx, shadowOy);

  // 行幅: max advance + outline*2 + (box padding*2) + halo*2 + 余裕
  // 行高: line 数 * fs * 1.6 + outline*2 + (box padding*2) + halo*2 + 余裕
  let widthEstimate = maxAdvance + outline * 2 + (hasBox ? padX * 2 : 0) + haloMargin * 2 + 64;
  let heightEstimate = lines.length * fs * 1.6 + outline * 2 * lines.length
    + (hasBox ? padY * 2 : 0) + haloMargin * 2 + 64;

  // rotation が掛かると AABB が広がる。任意角度の包絡矩形:
  //   aw = |w cos θ| + |h sin θ|
  //   ah = |w sin θ| + |h cos θ|
  const rot = Math.abs(Number(s.rotation) || 0);
  if (rot > 0.001) {
    const a = rot * Math.PI / 180;
    const ca = Math.abs(Math.cos(a));
    const sa = Math.abs(Math.sin(a));
    const aw = widthEstimate * ca + heightEstimate * sa;
    const ah = widthEstimate * sa + heightEstimate * ca;
    widthEstimate = aw;
    heightEstimate = ah;
  }

  // anchor は canvas 内側にマージンを取って配置 (= clipping を回避)
  const anchorOff = Math.max(32, Math.ceil(haloMargin + Math.max(padX, padY) + outline + 32));
  // 上限: ノートPCでも getImageData が現実的な範囲に収める
  const canvasW = Math.max(96, Math.min(3072, Math.ceil(widthEstimate + anchorOff * 2)));
  const canvasH = Math.max(96, Math.min(2048, Math.ceil(heightEstimate + anchorOff * 2)));
  return { canvasW, canvasH, anchorX: anchorOff, anchorY: anchorOff };
}

// ---------------------------------------------------------------------------
// mode に応じて clip を浅クローンし、anchor (= offscreen canvas 内座標) に配置
// ---------------------------------------------------------------------------
function _clonedForRender(clip, mode, anchorX, anchorY) {
  const s = clip?.style || {};
  const style = { ...s };
  if (mode === "ink") {
    if (style.glow) style.glow = { ...style.glow, enabled: false };
    if (style.dropShadow) style.dropShadow = { ...style.dropShadow, enabled: false };
  }
  return {
    ...clip,
    position: "custom",
    x: anchorX,
    y: anchorY,
    style,
  };
}

// ---------------------------------------------------------------------------
// 実描画 → alpha スキャン: clip 原点 (= 配置時の anchor) からの相対座標を返す
// ---------------------------------------------------------------------------
function _scanRel(clip, mode) {
  const text = String(clip?.text || "");
  if (!text) return null;
  const ext = _estimateExtent(clip, mode);
  const canvas = _getScanCanvas(ext.canvasW, ext.canvasH);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, ext.canvasW, ext.canvasH);


  const placed = _clonedForRender(clip, mode, ext.anchorX, ext.anchorY);
  try {
    drawCaptionClip(ctx, placed, 0.5);
  } catch (err) {
    console.error("[title-editor/bbox] drawCaptionClip failed", err, clip);
    return null;
  }

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, ext.canvasW, ext.canvasH);
  } catch (err) {
    console.error("[title-editor/bbox] getImageData failed", err);
    return null;
  }
  const data = imageData.data;
  const W = ext.canvasW;
  const H = ext.canvasH;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  // 行ごとに ink 範囲を出す。Uint8ClampedArray の add は cheap で、1024×600 で <10ms。
  for (let y = 0; y < H; y += 1) {
    let xLeft = -1;
    let xRight = -1;
    const rowOff = y * W * 4 + 3;   // alpha チャンネルへのオフセット
    for (let x = 0; x < W; x += 1) {
      if (data[rowOff + x * 4] > 0) {
        if (xLeft < 0) xLeft = x;
        xRight = x;
      }
    }
    if (xRight >= 0) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (xLeft < minX) minX = xLeft;
      if (xRight > maxX) maxX = xRight;
    }
  }
  if (maxX < 0) return null;
  return {
    relX: minX - ext.anchorX,
    relY: minY - ext.anchorY,
    relW: maxX - minX + 1,
    relH: maxY - minY + 1,
  };
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

// clip の ink 矩形 (= テキスト + outline + box、glow/shadow は含まない)。
// 戻り値は clip.x/y からの相対 offset + サイズ。
export function measureClipBBox(clip) {
  if (!clip) {
    const f = _emptyRel(null);
    return { inkX: f.relX, inkY: f.relY, inkW: f.relW, inkH: f.relH };
  }
  const key = _fingerprintInk(clip);
  let rel = _cache.get(key);
  if (rel === undefined) {
    rel = _scanRel(clip, "ink") || _emptyRel(clip);
    _cachePut(key, rel);
  }
  return { inkX: rel.relX, inkY: rel.relY, inkW: rel.relW, inkH: rel.relH };
}

// 絶対座標の ink 矩形 (既存 API・互換維持)
export function inkBox(clip) {
  const m = measureClipBBox(clip);
  return {
    x: (clip?.x ?? 0) + m.inkX,
    y: (clip?.y ?? 0) + m.inkY,
    w: m.inkW,
    h: m.inkH,
  };
}

// 絶対座標の visual 矩形 (= ink + glow + dropShadow)。当面の呼び出し元はなし、
// 将来の自動トリム / はみ出し警告 / 光彩込みプレビュー枠で使う。
export function visualBox(clip) {
  if (!clip) {
    const f = _emptyRel(null);
    return { x: 0, y: 0, w: f.relW, h: f.relH };
  }
  const key = _fingerprintVisual(clip);
  let rel = _cache.get(key);
  if (rel === undefined) {
    rel = _scanRel(clip, "visual") || _emptyRel(clip);
    _cachePut(key, rel);
  }
  return {
    x: (clip?.x ?? 0) + rel.relX,
    y: (clip?.y ?? 0) + rel.relY,
    w: rel.relW,
    h: rel.relH,
  };
}
