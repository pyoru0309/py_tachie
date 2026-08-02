// =============================================================================
// renderer/dialogue-relayout.js
//
// R8 追加対応: セリフ本文をオプティカル「詰め」/ 個別文字間込みで枠にフィットさせる。
//
// サーバ (compute_dialogue_layout) の折り返しは letterSpacing は考慮するが、
// オプティカルカーニング (詰め) はクライアント (layoutTextRun) でしか計算できない。
// そのためオプティカルが効くと行が実際より狭く描かれ、右側が余って見える。
//
// ここではオプティカル/個別字間が有効なときだけ、サーバが返した「枠 (box)」を保持した
// まま、その枠幅 (maxTextWidth) で layoutTextRun(オプティカル込み) を使って再折り返しし、
// 枠内に縦中央寄せでベースラインを引き直す。オプティカルは詰める方向のみなので行数は
// サーバ以下に収まり、枠が不足することはない (= box 塗り/枠と不整合しない)。
// =============================================================================
import { layoutTextRun } from "./text-layout.js";

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SIDE_WIDTH = 720;

// 禁則セット (app/compositor.py と一致させる)。
const LINE_START_FORBIDDEN = new Set(
  Array.from("、。，．・：；！？!?,.;:”’）)」』】〕〉》］]｝}〙〗｠ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶーゝゞヽヾ々"),
);
const LINE_END_FORBIDDEN = new Set(
  Array.from("“‘（(「『【〔〈《［[｛{〘〖｟"),
);

function lastGrapheme(s) {
  const arr = Array.from(s);
  return arr.length ? arr[arr.length - 1] : "";
}

// app/compositor.py wrap_text の移植 (fit 判定を layoutTextRun のオプティカル込み幅にする)。
function wrapOptical(ctx, rawText, maxWidth, maxLines, runOpts) {
  if (!rawText) return [""];
  const measure = (s) => layoutTextRun(ctx, s, runOpts).width;
  const fits = (s) => measure(s) <= maxWidth;
  const lines = [];
  const paragraphs = rawText.split("\n");
  const paras = paragraphs.length ? paragraphs : [rawText];
  for (const para of paras) {
    let current = "";
    for (const ch of Array.from(para)) {
      const candidate = current + ch;
      if (fits(candidate) || !current) { current = candidate; continue; }
      if (LINE_START_FORBIDDEN.has(ch)) { current = candidate; continue; }
      const last = lastGrapheme(current);
      if (last && LINE_END_FORBIDDEN.has(last)) {
        current = Array.from(current).slice(0, -1).join("");
        if (current) {
          lines.push(current);
          if (lines.length >= maxLines) return lines.slice(0, maxLines);
        }
        current = last + ch;
        continue;
      }
      lines.push(current);
      if (lines.length >= maxLines) return lines.slice(0, maxLines);
      current = ch;
    }
    lines.push(current);
    if (lines.length >= maxLines) return lines.slice(0, maxLines);
  }
  return lines.slice(0, maxLines);
}

function clampRect(left, top, right, bottom) {
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  if (left < 0) { right -= left; left = 0; }
  if (top < 0) { bottom -= top; top = 0; }
  if (right > CANVAS_W) { left -= right - CANVAS_W; right = CANVAS_W; }
  if (bottom > CANVAS_H) { top -= bottom - CANVAS_H; bottom = CANVAS_H; }
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(CANVAS_W, Math.max(left + width, right));
  bottom = Math.min(CANVAS_H, Math.max(top + height, bottom));
  return [left, top, right, bottom];
}

// app/compositor.py text_body_anchor の移植 (showSpeechBox=false 用)。
function textBodyAnchor(placement, offsetX, offsetY, align, textWidth, textHeight) {
  const horizontalIn = (areaLeft, areaWidth) => {
    if (align === "center") return areaLeft + Math.max(0, Math.floor((areaWidth - textWidth) / 2));
    if (align === "right") return areaLeft + Math.max(0, areaWidth - textWidth);
    return areaLeft;
  };
  if (placement === "top") return [horizontalIn(offsetX, CANVAS_W - 2 * offsetX), offsetY];
  if (placement === "left") return [horizontalIn(offsetX, SIDE_WIDTH), offsetY];
  if (placement === "right") return [horizontalIn(CANVAS_W - offsetX - SIDE_WIDTH, SIDE_WIDTH), offsetY];
  if (placement === "center") {
    return [Math.floor((CANVAS_W - textWidth) / 2) + offsetX, Math.floor((CANVAS_H - textHeight) / 2) + offsetY];
  }
  // bottom
  return [horizontalIn(offsetX, CANVAS_W - 2 * offsetX), CANVAS_H - offsetY - textHeight];
}

// セリフレイアウトをオプティカル/個別字間込みで枠にフィットさせ直した layout を返す。
// 変更が不要 (オプティカル/個別字間なし or 再折り返しが同一) なら元の layout をそのまま返す。
export function relayoutDialogue(ctx, layout, bodyFontSpec) {
  if (!layout || layout.maxTextWidth == null) return layout;
  const rawText = String(layout.rawText || "");
  if (!rawText) return layout;
  const opticalActive = !!layout.enableOpticalKerning;
  const kerningActive = layout.charKerning && typeof layout.charKerning === "object"
    && Object.keys(layout.charKerning).length > 0;
  if (!opticalActive && !kerningActive) return layout; // サーバ折り返しで十分

  const fontSize = Number(layout.fontSize) || 0;
  const runOpts = {
    fontSpec: bodyFontSpec,
    fontSize,
    letterSpacing: Number(layout.letterSpacing) || 0,
    opticalKerning: opticalActive,
    opticalKerningHighQuality: !!layout.opticalKerningHighQuality,
    outlineWidth: Number(layout.outlineWidth) || 0,
    medianGapOverride: null,
  };
  ctx.save();
  ctx.font = bodyFontSpec;
  const maxLines = Math.max(1, Number(layout.maxLines) || 1);
  const newLines = wrapOptical(ctx, rawText, Number(layout.maxTextWidth), maxLines, runOpts);

  const oldLines = (layout.textLines || []).map((l) => l.text);
  const sameWrap = oldLines.length === newLines.length
    && oldLines.every((t, i) => t === newLines[i]);
  if (sameWrap) { ctx.restore(); return layout; }

  const n = newLines.length;
  const lineHeight = Number(layout.lineHeight) || fontSize;
  const lineGap = Number(layout.lineGap) || 0;
  const ascent = Number(layout.ascent) || Math.round(fontSize * 0.8);
  const speakerHeight = Number(layout.speakerHeight) || 0;
  const speakerGap = Number(layout.speakerGap) || 0;
  const speakerAscent = Number(layout.speakerAscent) || 0;
  const padX = Number(layout.padX) || 0;
  const align = String(layout.textAlign || "left").toLowerCase();

  const totalTextHeight = lineHeight * n + lineGap * Math.max(0, n - 1);
  const contentHeight = totalTextHeight + speakerHeight + speakerGap;

  let textLeft;
  let textRight;
  let baseline;
  let speakerOut = null;
  let inner;
  let boxOut = layout.box; // ★ 枠はサーバ値を保持 (塗り/枠との不整合を避ける)

  if (layout.showSpeechBox && layout.box) {
    const box = layout.box;
    const boxHeight = box.bottom - box.top;
    const contentTop = box.top + Math.max(0, (boxHeight - contentHeight) / 2);
    baseline = contentTop + speakerHeight + speakerGap + ascent;
    textLeft = box.left;
    textRight = box.right;
    inner = { left: box.left, right: box.right, padX };
    if (layout.speaker) {
      speakerOut = { ...layout.speaker, x: box.left + padX, baselineY: contentTop + speakerAscent };
    }
  } else {
    // 枠なし: 再折り返し後の最大行幅で body anchor を引き直す。
    let widest = 1;
    for (const ln of newLines) {
      widest = Math.max(widest, layoutTextRun(ctx, ln || " ", runOpts).width);
    }
    const placement = String(layout.speechPlacement || "bottom");
    const offsetX = Number(layout.offsetX) || 0;
    const offsetY = Number(layout.offsetY) || 0;
    let [bl, bt] = textBodyAnchor(placement, offsetX, offsetY, align, widest, contentHeight);
    bl = Math.max(0, Math.min(CANVAS_W - widest, bl));
    bt = Math.max(0, Math.min(CANVAS_H - contentHeight, bt));
    textLeft = bl;
    textRight = bl + widest;
    baseline = bt + speakerHeight + speakerGap + ascent;
    inner = { left: textLeft, right: textRight, padX: 0 };
    if (layout.speaker) {
      speakerOut = { ...layout.speaker, x: textLeft, baselineY: bt + speakerAscent };
    }
  }

  const newTextLines = newLines.map((text, i) => {
    const w = layoutTextRun(ctx, text || " ", runOpts).width;
    // x は仮置き (drawDialogueOnCanvas の recomputeLineX が center/right/left を引き直す)。
    let x;
    if (align === "center") x = textLeft + ((textRight - textLeft) - w) / 2;
    else if (align === "right") x = textRight - inner.padX - w;
    else x = textLeft + inner.padX;
    const y = baseline + i * (lineHeight + lineGap);
    return { text, x, baselineY: y, width: Math.round(w) };
  });

  ctx.restore();
  return {
    ...layout,
    box: boxOut,
    textLines: newTextLines,
    speaker: speakerOut,
    textBoxInner: inner,
  };
}
