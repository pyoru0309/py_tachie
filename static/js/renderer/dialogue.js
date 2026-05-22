// =============================================================================
// renderer/dialogue.js
//
// /api/v2/scene-bundle が返す dialogue.raw (compute_dialogue_layout 結果) を
// オフスクリーン Canvas2D に描画して CanvasTexture を作るためのヘルパ。
//
// レイアウト計算 (wrap_text / dialogue_box_rect / baseline 計算) はすべて
// Pillow 側 compute_dialogue_layout で済んでおり、ここでは描画だけ行う。
// これにより画面 (canvas2d) と書き出し (Pillow) の文字位置が一致する。
//
// 入力 layout:
//   {
//     showSpeechBox, box: { left, top, right, bottom, fillColor, fillOpacity,
//       borderColor, borderOpacity, borderWidth, radius } | null,
//     overlayImageUrl: string | null,
//     speaker: { x, baselineY, text, fontSize } | null,
//     textLines: [ { text, x, baselineY, width } ],
//     fontSize, fontFamily, fontWeight,
//     textColor, textOpacity, speakerOpacity,
//     outlineWidth, outlineColor, letterSpacing
//   }
// =============================================================================
import * as THREE from "three";
import { fontFamilyCssStack, resolveFontWeightCss } from "../font.js";
import { hexToRgba } from "../utils.js";
import { layoutTextRun } from "./text-layout.js";

export const DIALOGUE_CANVAS_WIDTH = 1920;
export const DIALOGUE_CANVAS_HEIGHT = 1080;

function fontSpec(layout, sizeOverride = null) {
  // 書体が持たない weight で合成ボールドが起きないよう resolve 経由。
  const familyId = layout.fontFamily || "";
  const weightCss = resolveFontWeightCss(familyId, String(layout.fontWeight || "regular").toLowerCase());
  const family = fontFamilyCssStack(familyId);
  const size = sizeOverride ?? layout.fontSize;
  return `${weightCss} ${size}px ${family}`;
}

// (x, baselineY) に anchor="ls" 同等で描く。letter_spacing > 0 または optical
// kerning ON のときは 1 文字ずつ描画して各文字を共通 baseline に揃える
// (Pillow の draw_text_with_spacing と同等の baseline 振る舞い)。
function drawTextAtBaseline(ctx, text, x, baselineY, options) {
  const {
    letterSpacing = 0,
    fillStyle,
    strokeStyle = null,
    outlineWidth = 0,
    opticalKerning = false,
    opticalKerningHighQuality = false,
    fontSpec = null,
    fontSize = 0,
  } = options;
  ctx.textBaseline = "alphabetic";
  const useStroke = outlineWidth > 0 && strokeStyle;
  if (useStroke) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = outlineWidth * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
  }
  ctx.fillStyle = fillStyle;

  const lsPx = Number(letterSpacing) || 0;

  // optical kerning ON: layoutTextRun の glyph 座標で 1 文字ずつ描く。
  // ctx.font は呼び出し側 (drawDialogueOnCanvas) で fontSpec に揃えてある。
  if (opticalKerning) {
    const run = layoutTextRun(ctx, text, {
      fontSpec,
      fontSize,
      letterSpacing: lsPx,
      opticalKerning: true,
      opticalKerningHighQuality,
      outlineWidth,
    });
    for (const g of run.glyphs) {
      if (g.drawable === false) continue;  // 空白トークンは描画しない (advance だけ進む)
      const gx = x + g.x;
      if (useStroke) ctx.strokeText(g.text, gx, baselineY);
      ctx.fillText(g.text, gx, baselineY);
    }
    return;
  }

  let useNative = false;
  try {
    if ("letterSpacing" in ctx) {
      ctx.letterSpacing = `${lsPx}px`;
      useNative = true;
    }
  } catch (_e) {
    useNative = false;
  }

  if (useNative || lsPx === 0) {
    if (useStroke) ctx.strokeText(text, x, baselineY);
    ctx.fillText(text, x, baselineY);
    return;
  }
  // 手動: 1 文字ずつ baseline 揃え。
  let cx = x;
  for (const ch of text) {
    if (useStroke) ctx.strokeText(ch, cx, baselineY);
    ctx.fillText(ch, cx, baselineY);
    cx += ctx.measureText(ch).width + lsPx;
  }
}

// optical kerning ON のとき、Pillow が決めた行内 x を layoutTextRun の新しい
// 行幅で引き直す。speaker は現状 letter_spacing 適用外で 1 行 1 行も短いので
// 中央寄せの再計算は不要 (左寄せ固定)。
function recomputeLineX(ctx, line, layout) {
  const align = String(layout.textAlign || "left").toLowerCase();
  const fontSize = Number(layout.fontSize) || 0;
  const lsPx = Number(layout.letterSpacing) || 0;
  // ctx.font は呼び出し側で本文 fontSpec に設定済み。
  const inner = layout.textBoxInner || null;
  const fontSpec = ctx.font || "";
  const newW = layoutTextRun(ctx, line.text || "", {
    fontSpec,
    fontSize,
    letterSpacing: lsPx,
    opticalKerning: true,
    opticalKerningHighQuality: !!layout.opticalKerningHighQuality,
    outlineWidth: Number(layout.outlineWidth) || 0,
  }).width;
  if (!inner) return { x: line.x, width: newW };
  const left = Number(inner.left) || 0;
  const right = Number(inner.right) || 0;
  const padX = Number(inner.padX) || 0;
  if (align === "center") {
    return { x: left + ((right - left) - newW) / 2, width: newW };
  }
  if (align === "right") {
    return { x: right - padX - newW, width: newW };
  }
  return { x: left + padX, width: newW };
}

// box の角丸 / マスク領域を内部正規化した値で返す。
// fill / border の両方が同じ角丸計算を使うため共有ヘルパ。
function _resolveBoxRadii(layout) {
  const b = layout?.box;
  if (!b) return null;
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  const r = b.borderRadius || { tl: 0, tr: 0, bl: 0, br: 0 };
  let tl = Math.max(0, Number(r.tl) || 0);
  let tr = Math.max(0, Number(r.tr) || 0);
  let br = Math.max(0, Number(r.br) || 0);
  let bl = Math.max(0, Number(r.bl) || 0);
  let factor = 1;
  if (w > 0) {
    if (tl + tr > w) factor = Math.min(factor, w / (tl + tr));
    if (bl + br > w) factor = Math.min(factor, w / (bl + br));
  }
  if (h > 0) {
    if (tl + bl > h) factor = Math.min(factor, h / (tl + bl));
    if (tr + br > h) factor = Math.min(factor, h / (tr + br));
  }
  if (factor < 1) {
    tl *= factor; tr *= factor; br *= factor; bl *= factor;
  }
  return { left: b.left, top: b.top, w, h, tl, tr, br, bl };
}

// セリフ枠の「背景 (fill)」のみを描画する。透過カラー化はしない: shader 側で
// 適用するため、ここではマスク alpha = 1.0 の純色を描く (内側は box color、
// 外側は完全透明)。renderer/scene-builder の box-fill plane が screen / multiply
// blend で使う。
export function drawDialogueBoxFillOnCanvas(canvas, layout) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rect = _resolveBoxRadii(layout);
  if (!rect || rect.w <= 0 || rect.h <= 0) return;
  const b = layout.box;
  // 純色で塗る (alpha=1.0)。shader で uOpacity と掛け合わせて最終 alpha 化。
  ctx.fillStyle = b.fillColor || "#141C20";
  if ((rect.tl + rect.tr + rect.br + rect.bl) > 0) {
    ctx.beginPath();
    ctx.roundRect(rect.left, rect.top, rect.w, rect.h, [rect.tl, rect.tr, rect.br, rect.bl]);
    ctx.fill();
  } else {
    ctx.fillRect(rect.left, rect.top, rect.w, rect.h);
  }
}

// セリフ枠の「ボーダー (border)」のみを描画する。外周-内周方式で純色のリングを
// 作る (内側は destination-out で抜く)。fill と同じく shader 側で alpha 制御。
export function drawDialogueBoxBorderOnCanvas(canvas, layout) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rect = _resolveBoxRadii(layout);
  if (!rect) return;
  const b = layout.box;
  const bw = Math.max(0, Number(b.borderWidth) || 0);
  if (bw <= 0) return;
  ctx.fillStyle = b.borderColor || "#FFFFFF";
  const useRound = (rect.tl + rect.tr + rect.br + rect.bl) > 0;
  if (useRound) {
    const otl = rect.tl > 0 ? rect.tl + bw : 0;
    const otr = rect.tr > 0 ? rect.tr + bw : 0;
    const obr = rect.br > 0 ? rect.br + bw : 0;
    const obl = rect.bl > 0 ? rect.bl + bw : 0;
    ctx.beginPath();
    ctx.roundRect(rect.left - bw, rect.top - bw, rect.w + 2 * bw, rect.h + 2 * bw, [otl, otr, obr, obl]);
    ctx.fill();
  } else {
    ctx.fillRect(rect.left - bw, rect.top - bw, rect.w + 2 * bw, rect.h + 2 * bw);
  }
  // 内側をマスクで抜く (destination-out)。リング状になる。
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000000";
  if (useRound) {
    ctx.beginPath();
    ctx.roundRect(rect.left, rect.top, rect.w, rect.h, [rect.tl, rect.tr, rect.br, rect.bl]);
    ctx.fill();
  } else {
    ctx.fillRect(rect.left, rect.top, rect.w, rect.h);
  }
  ctx.restore();
}

// オフスクリーン canvas を 1920×1080 で確保し、overlay 画像 → speaker →
// 各行 の順で描画する (セリフ枠は別 canvas / 別 plane へ分離済み)。
//
// overlayImage は呼び出し側で事前に Image を load して渡す。失敗時は null。
export function drawDialogueOnCanvas(canvas, layout, overlayImage = null) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!layout) return;

  if (overlayImage && overlayImage.width > 0 && overlayImage.height > 0) {
    // Pillow draw_overlay_image は 1920×1080 にリサイズして alpha_composite。
    ctx.drawImage(overlayImage, 0, 0, canvas.width, canvas.height);
  }

  if (layout.speaker) {
    const sp = layout.speaker;
    const speakerFill = hexToRgba(layout.textColor || "#FFFFFF", (layout.speakerOpacity ?? 230) / 255);
    const speakerStroke = layout.outlineWidth > 0
      ? hexToRgba(layout.outlineColor || "#666666", 1)
      : null;
    ctx.save();
    ctx.font = fontSpec(layout, sp.fontSize);
    drawTextAtBaseline(ctx, sp.text || "", sp.x, sp.baselineY, {
      letterSpacing: 0, // speaker name は letter_spacing 適用外 (Pillow draw_dialogue と一致)
      fillStyle: speakerFill,
      strokeStyle: speakerStroke,
      outlineWidth: layout.outlineWidth || 0,
      // speaker name はキャラ名表示のみで詰め対象外 (短く / 表記のばらつきを増やしたくない)。
      opticalKerning: false,
    });
    ctx.restore();
  }

  const textFill = hexToRgba(layout.textColor || "#FFFFFF", (layout.textOpacity ?? 255) / 255);
  const textStroke = layout.outlineWidth > 0
    ? hexToRgba(layout.outlineColor || "#666666", 1)
    : null;
  const useOptical = !!layout.enableOpticalKerning;
  const useHQ = !!layout.opticalKerningHighQuality;
  const bodyFontSpec = fontSpec(layout);

  // セリフ本文の glow / dropShadow。テロップと同じ「silhouette + tint + blur」方式。
  // 本文文字 (枠 / overlay 画像 / speaker name は対象外) のシルエットを別 canvas に
  // 取り、ctx.filter = blur(...) + tint 色乗算で合成する。
  const glow = layout.dialogueGlow && typeof layout.dialogueGlow === "object"
    ? layout.dialogueGlow : null;
  const shadow = layout.dialogueDropShadow && typeof layout.dialogueDropShadow === "object"
    ? layout.dialogueDropShadow : null;
  const glowEnabled = !!(glow && glow.enabled);
  const shadowEnabled = !!(shadow && shadow.enabled);
  if ((glowEnabled || shadowEnabled) && Array.isArray(layout.textLines) && layout.textLines.length > 0) {
    const silhouette = _renderDialogueTextSilhouette(canvas.width, canvas.height, ctx, layout, useOptical, useHQ, bodyFontSpec);
    if (silhouette) {
      if (shadowEnabled) {
        const sBlur = Math.max(0, Number(shadow.blurPx) || 0);
        const sOx = Number(shadow.offsetX) || 0;
        const sOy = Number(shadow.offsetY) || 0;
        const sOp = Math.max(0, Math.min(1, Number(shadow.opacity ?? 0.7)));
        const tinted = _tintCanvasInPlace(silhouette, shadow.color || "#000000", sOp, "shadow");
        ctx.save();
        if (sBlur > 0) ctx.filter = `blur(${sBlur}px)`;
        ctx.drawImage(tinted, sOx, sOy);
        ctx.restore();
      }
      if (glowEnabled) {
        const gBlur = Math.max(0, Number(glow.blurPx) || 0);
        const gOp = Math.max(0, Math.min(1, Number(glow.opacity ?? 0.8)));
        const tinted = _tintCanvasInPlace(silhouette, glow.color || "#ffffff", gOp, "glow");
        ctx.save();
        if (gBlur > 0) ctx.filter = `blur(${gBlur}px)`;
        ctx.drawImage(tinted, 0, 0);
        ctx.restore();
      }
    }
  }

  ctx.save();
  ctx.font = bodyFontSpec;
  for (const line of layout.textLines || []) {
    let drawX = line.x;
    if (useOptical) {
      // align の引き直し (新しい行幅で center/right を再計算)。
      const recomputed = recomputeLineX(ctx, line, layout);
      drawX = recomputed.x;
    }
    drawTextAtBaseline(ctx, line.text || "", drawX, line.baselineY, {
      letterSpacing: layout.letterSpacing || 0,
      fillStyle: textFill,
      strokeStyle: textStroke,
      outlineWidth: layout.outlineWidth || 0,
      opticalKerning: useOptical,
      opticalKerningHighQuality: useHQ,
      fontSpec: bodyFontSpec,
      fontSize: layout.fontSize || 0,
    });
  }
  ctx.restore();
}

// セリフ本文の文字シルエットを描いたオフスクリーン canvas を返す。
// テロップと同じく scratch プールを使ってメモリ pressure を抑える。
const _dialogueScratch = { silhouette: null, glow: null, shadow: null };
function _acquireDialogueScratch(slot, width, height) {
  let c = _dialogueScratch[slot];
  if (!c) {
    c = document.createElement("canvas");
    _dialogueScratch[slot] = c;
  }
  if (c.width !== width || c.height !== height) {
    c.width = width; c.height = height;
  } else {
    c.getContext("2d").clearRect(0, 0, width, height);
  }
  const cx = c.getContext("2d");
  cx.globalCompositeOperation = "source-over";
  cx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

function _renderDialogueTextSilhouette(W, H, parentCtx, layout, useOptical, useHQ, bodyFontSpec) {
  const off = _acquireDialogueScratch("silhouette", W, H);
  const cx = off.getContext("2d");
  cx.font = bodyFontSpec;
  // 文字色 = #ffffff で塗り、後で source-in tint する。
  for (const line of layout.textLines || []) {
    let drawX = line.x;
    if (useOptical) {
      const r = recomputeLineX(cx, line, layout);
      drawX = r.x;
    }
    drawTextAtBaseline(cx, line.text || "", drawX, line.baselineY, {
      letterSpacing: layout.letterSpacing || 0,
      fillStyle: "#ffffff",
      strokeStyle: layout.outlineWidth > 0 ? "#ffffff" : null,
      outlineWidth: layout.outlineWidth || 0,
      opticalKerning: useOptical,
      opticalKerningHighQuality: useHQ,
      fontSpec: bodyFontSpec,
      fontSize: layout.fontSize || 0,
    });
  }
  return off;
}

function _tintCanvasInPlace(src, hexColor, opacity, slot) {
  const out = _acquireDialogueScratch(slot, src.width, src.height);
  const cx = out.getContext("2d");
  cx.drawImage(src, 0, 0);
  cx.globalCompositeOperation = "source-in";
  cx.fillStyle = hexColor;
  cx.fillRect(0, 0, out.width, out.height);
  const op = Math.max(0, Math.min(1, Number(opacity)));
  if (op < 1) {
    cx.globalCompositeOperation = "destination-in";
    cx.fillStyle = `rgba(0, 0, 0, ${op})`;
    cx.fillRect(0, 0, out.width, out.height);
  }
  return out;
}

// 1 つの dialogue 用にオフスクリーン canvas + CanvasTexture を確保する。
// scene-builder.buildDialogue から呼ばれ、scene 全体の lifecycle で使い回す。
// canvas を返値に含めるのは、後で「内容変更時のみ再描画 + texture.needsUpdate」で
// in-place 更新するため (現状は scene 単位で build/dispose されるので 1 回だけ)。
export function createDialogueCanvasTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = DIALOGUE_CANVAS_WIDTH;
  canvas.height = DIALOGUE_CANVAS_HEIGHT;
  const texture = new THREE.CanvasTexture(canvas);
  // 他のテクスチャと同じく Y-down camera 用に flipY=false。
  texture.flipY = false;
  // 描画は sRGB color space で行う前提 (色 uniform は HEX → CSS color string で
  // 直接 fillStyle に入る)。
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { canvas, texture };
}

// overlayImageUrl があれば fetch して decode した HTMLImageElement を返す。
// 失敗時は null。dialogue raw が overlayImageUrl を持つときだけ呼ばれる。
export function loadDialogueOverlayImage(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
