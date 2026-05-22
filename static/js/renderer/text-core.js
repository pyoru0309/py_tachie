// =============================================================================
// renderer/text-core.js
//
// テキスト描画のコア層 (グリフ展開・行レイアウト・縁取り・光彩・影)。
//
// 設計の出発点はテロップだが、MV 文字 / タイトルコンポジションでも共通で
// 使うため telop.js から分離した。UI ファイル (telop.js) には描画関数を残さない。
//
// API:
//   drawTextLines(ctx, params)
//     1 行ずつ fontSpec/letterSpacing/opticalKerning/baseline/outline を解決して
//     ctx に直接描く。glow/dropShadow は呼び出し側で silhouette を経由して描く
//     ことを想定し、本関数は fill + stroke だけを担う。
//
//   createTextSilhouetteCanvas(width, height, drawParams)
//   tintSilhouetteCanvas(silCanvas, hex, opacity, slot)
//   releaseTextScratch()
//     scratch canvas プール。glow / dropShadow の中間バッファ。Pillow が
//     描いていた頃と違って GPU 側でブラーをかけるため、bbox + 4σ ぶんの
//     margin だけ確保する (1920×1080 で確保しない)。
//
//   drawCaptionClip(ctx, telop, timelineSec)
//     telops 配列のうち 1 件分を従来の drawTelopsOnCanvas と完全に同じ
//     パラメータ・順序で描く。drawTelopsOnCanvas / drawTextClip(kind=caption)
//     はどちらもこれを呼ぶ。
//
// 既存テロップの見た目を 1px も変えないため、関数の中身は telop.js から
// 機械的に切り出している。state 参照 (telopDefaults / defaultFont) や
// PROJECT_FPS / telopStartSec の依存も残している。
// =============================================================================

import { state } from "../state.js";
import { hexToRgba } from "../utils.js";
import {
  fontFamilyCssStack,
  resolveFontWeightCss,
} from "../font.js";
import { PROJECT_FPS } from "../timecode.js";
import { telopStartSec } from "../scenario.js";
import { telopDurationFrame } from "../scenario.js";
import { layoutTextRun, measureTextRunWidth } from "./text-layout.js";

// グリフ列を 1 行ずつ ctx に描画する。
//
// params:
//   textLeft, textTop                  描画原点 (anchor から padding を加味済み)
//   lines                              改行分割済みテキスト
//   baseLineWidths/Ascents/Descents/Heights  layoutTextRun (or measureText) の結果
//   baseW                              最長行の幅 (align 計算用)
//   lineGap                            行間 (extra)
//   outlineWidth                       stroke 半幅 px
//   fontSpec                           ctx.font 用文字列
//   align                              "left" | "center" | "right"
//   fillStyle, strokeStyle             描画色 (silhouette のときは白)
//   useStroke                          outline を描くか
//   letterSpacing                      px (optical OFF のときのみ参照)
//   enableOpticalKerning, opticalKerningHighQuality, fontSize  optical 詰め用
//   glyphTransformFn (任意)            (globalCharIdx, char) => { dx?, dy?, scale?, alpha?, visible? } | null
//                                      enableOpticalKerning=true のときのみ機能。
//                                      pop_per_char のように「グリフ単位 transform」を入れる用途。
//                                      visible:false でそのグリフをスキップ。null/undefined のグリフは通常描画。
export function drawTextLines(ctx, params) {
  const {
    textLeft, textTop, lines, baseLineWidths, baseLineAscents, baseLineHeights,
    baseW, lineGap, outlineWidth, fontSpec, align,
    fillStyle, strokeStyle, useStroke, letterSpacing,
    enableOpticalKerning = false, opticalKerningHighQuality = false, fontSize = 0,
    glyphTransformFn = null,
  } = params;
  ctx.save();
  ctx.font = fontSpec;
  // textBaseline = "bottom" で各行の bbox 下端を y に揃える。alphabetic baseline で揃えると
  // 「Latin が em-box の上方にデザインされた日本語フォント」(yawarakadragon 等) で Latin が
  // 浮いて見えるため、Pillow 側の anchor="lb" と挙動を統一しつつ視覚的に下端を揃える。
  ctx.textBaseline = "bottom";
  ctx.fillStyle = fillStyle;
  // ctx.letterSpacing は対応ブラウザ (Chrome 99+, Safari 16.4+) でのみ機能。
  // 未対応時は手動 fallback (1文字ずつ描画) に切り替える。
  const lsPx = Number(letterSpacing) || 0;
  // optical kerning ON では layoutTextRun の glyph 座標で 1 文字ずつ描くため
  // ctx.letterSpacing は使わない (二重加算回避)。
  let useNativeLetterSpacing = false;
  if (!enableOpticalKerning) {
    try {
      if ("letterSpacing" in ctx) {
        ctx.letterSpacing = `${lsPx}px`;
        useNativeLetterSpacing = true;
      }
    } catch (_e) {
      useNativeLetterSpacing = false;
    }
  }
  if (useStroke && outlineWidth > 0) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = outlineWidth * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
  }
  let glyphTopY = textTop + outlineWidth;
  let globalCharIdx = 0;   // 行をまたいだ通し文字インデックス (glyphTransformFn に渡す)
  const { baseLineDescents } = params;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || " ";
    const lineW = baseLineWidths[i];
    let x = textLeft + outlineWidth;
    if (align === "right") x = textLeft + outlineWidth + (baseW - lineW);
    else if (align !== "left") x = textLeft + outlineWidth + (baseW - lineW) / 2;
    const bottomY = glyphTopY + baseLineHeights[i];
    if (enableOpticalKerning) {
      // optical kerning: layoutTextRun が決めた glyph[].x で 1 文字ずつ。
      // baseline は手動 letter_spacing 経路と同じ理由で alphabetic に揃える。
      ctx.textBaseline = "alphabetic";
      const baselineY = bottomY - (baseLineDescents?.[i] ?? 0);
      const run = layoutTextRun(ctx, line, {
        fontSpec,
        fontSize,
        letterSpacing: lsPx,
        opticalKerning: true,
        opticalKerningHighQuality,
        outlineWidth,
      });
      for (const g of run.glyphs) {
        if (g.drawable === false) {
          // drawable=false (空白トークン) は描画スキップだが、グリフ番号は進める
          // (pop_per_char の per-char delay が空白で詰まないようにする)。
          globalCharIdx += 1;
          continue;
        }
        const gx = x + g.x;
        const t = glyphTransformFn ? glyphTransformFn(globalCharIdx, g.text) : null;
        if (t && t.visible === false) {
          globalCharIdx += 1;
          continue;
        }
        if (t && (t.dx || t.dy || (t.scale != null && t.scale !== 1) || (t.alpha != null && t.alpha !== 1))) {
          ctx.save();
          const dx = Number(t.dx) || 0;
          const dy = Number(t.dy) || 0;
          const sc = (t.scale != null && Number.isFinite(t.scale)) ? Number(t.scale) : 1;
          const al = (t.alpha != null && Number.isFinite(t.alpha)) ? Number(t.alpha) : 1;
          ctx.translate(gx + dx, baselineY + dy);
          if (sc !== 1) ctx.scale(sc, sc);
          if (al !== 1) ctx.globalAlpha = (ctx.globalAlpha ?? 1) * al;
          if (useStroke && outlineWidth > 0) ctx.strokeText(g.text, 0, 0);
          ctx.fillText(g.text, 0, 0);
          ctx.restore();
        } else {
          if (useStroke && outlineWidth > 0) ctx.strokeText(g.text, gx, baselineY);
          ctx.fillText(g.text, gx, baselineY);
        }
        globalCharIdx += 1;
      }
      ctx.textBaseline = "bottom";
    } else if (useNativeLetterSpacing || lsPx === 0) {
      if (useStroke && outlineWidth > 0) ctx.strokeText(line, x, bottomY);
      ctx.fillText(line, x, bottomY);
    } else {
      // 手動 letterSpacing 経路: 1 文字ずつ描く必要がある。textBaseline="bottom" のまま
      // 描くと各文字の bbox 下端で揃ってしまい (v は baseline、y は descender 底)、
      // v/y が他の文字に対して浮き上がって見える。alphabetic baseline に切り替えて
      // 「全文字共通のベースライン」で並べる。
      ctx.textBaseline = "alphabetic";
      const baselineY = bottomY - (baseLineDescents?.[i] ?? 0);
      let cx = x;
      for (const ch of line) {
        if (useStroke && outlineWidth > 0) ctx.strokeText(ch, cx, baselineY);
        ctx.fillText(ch, cx, baselineY);
        cx += ctx.measureText(ch).width + lsPx;
      }
      ctx.textBaseline = "bottom";
    }
    glyphTopY += baseLineHeights[i] + lineGap + outlineWidth * 2;
  }
  ctx.restore();
}

// glow / dropShadow 用 scratch canvas プール。
//
// 旧実装は telop ごとに silhouette / shadowTinted / glowTinted を `document.createElement`
// して 1920×1080 (= 8.3MB) を 3 枚ずつ確保していた。dj2 (4 分尺・glow blurPx=20 +
// dropShadow blurPx=50 のテロップ 41 個) の書き出しで Canvas backing store が
// 累積し、2010 frame 付近で落ちる現象の主因。対策:
//   1. scratch はモジュールスコープに 1 セットだけ持って telop 間で使い回す。
//   2. サイズは visible bbox + blur margin (4σ ぶん) に縮める (1920×1080 ではない)。
//   3. drawTextClip ループ終了時に width=height=0 で backing store を解放する。
const _textScratch = {
  silhouette: null,
  shadowTinted: null,
  glowTinted: null,
};

function _acquireTextScratch(slot, width, height) {
  let c = _textScratch[slot];
  if (!c) {
    c = document.createElement("canvas");
    _textScratch[slot] = c;
  }
  if (c.width !== width || c.height !== height) {
    c.width = width;
    c.height = height;
  } else {
    c.getContext("2d").clearRect(0, 0, width, height);
  }
  const ctx = c.getContext("2d");
  // 前回 tintSilhouetteCanvas が "destination-in" のまま return しているので戻す。
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

export function releaseTextScratch() {
  for (const slot of Object.keys(_textScratch)) {
    const c = _textScratch[slot];
    if (c && (c.width !== 0 || c.height !== 0)) {
      c.width = 0;
      c.height = 0;
    }
  }
}

// glowSource: "both" (既定) / "stroke" / "fill"
//   "stroke" → silhouette を stroke だけ (= 中身透明、halo は輪郭の周りだけ広がる、ネオン管風)
//   "fill"   → silhouette を fill だけ (= stroke なし、面で halo を出す)
//   "both"   → fill + stroke 両方 (= 既存の塗り潰し文字 + 縁取りベースの halo)
export function createTextSilhouetteCanvas(width, height, drawParams, glowSource = "both") {
  const off = _acquireTextScratch("silhouette", width, height);
  const ox = off.getContext("2d");
  if (glowSource === "stroke") {
    // fill を抜いて stroke だけで halo source を作る。outlineWidth が 0 だと描かれないので
    // 最小 1 を強制 (= 「stroke 由来 halo」を明示指定したのに silhouette が空になる事故を防ぐ)。
    const effectiveOutline = Math.max(1, Number(drawParams.outlineWidth) || 1);
    drawTextLines(ox, {
      ...drawParams,
      outlineWidth: effectiveOutline,
      fillStyle: "rgba(0,0,0,0)",
      strokeStyle: "#ffffff",
      useStroke: true,
    });
  } else if (glowSource === "fill") {
    drawTextLines(ox, {
      ...drawParams,
      fillStyle: "#ffffff",
      strokeStyle: "rgba(0,0,0,0)",
      useStroke: false,
    });
  } else {
    drawTextLines(ox, {
      ...drawParams,
      fillStyle: "#ffffff",
      strokeStyle: "#ffffff",
      useStroke: drawParams.outlineWidth > 0,
    });
  }
  return off;
}

export function tintSilhouetteCanvas(silCanvas, hexColor, opacity, slot) {
  const out = _acquireTextScratch(slot, silCanvas.width, silCanvas.height);
  const cx = out.getContext("2d");
  cx.drawImage(silCanvas, 0, 0);
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

// telop 1 件を ctx に描画。drawTelopsOnCanvas / drawTextClip(kind=caption) の
// どちらからも呼ばれる。
//
// 戻り値 false: telop が `timelineSec` 範囲外、または text が空。呼び出し側で
// active set 計算済みのときは active 配列を渡せばこのチェックはスキップされる
// (ただし内部の二重判定は維持: §10.1 で書いたとおり既存挙動互換のため)。
export function drawCaptionClip(ctx, telop, timelineSec) {
  if (!telop || typeof telop !== "object") return false;
  const canvasW = 1920;
  const canvasH = 1080;
  const start = telopStartSec(telop);
  const dur = telopDurationFrame(telop) / PROJECT_FPS;
  if (dur <= 0) return false;
  if (timelineSec < start || timelineSec >= start + dur) return false;
  const text = String(telop.text || "");
  if (!text) return false;
  const style = telop.style || {};
  const fontSize = Math.max(12, Number(style.fontSize) || 48);
  const fontWeightId = String(style.fontWeight || "regular").toLowerCase();
  // 書体が持たない weight で synthetic bold を起こさせないため、resolve 経由。
  const familyId = style.fontFamily || state.manifest?.config?.defaultFont || "";
  const fontWeightCss = resolveFontWeightCss(familyId, fontWeightId);
  const fontFamily = fontFamilyCssStack(familyId);
  const color = style.color || "#ffffff";
  const outlineColor = style.outlineColor || "#000000";
  // 0 は明示的に「アウトラインなし」を意味するので、|| ではなく未定義時のみフォールバック。
  const outlineWidthRaw = Number(style.outlineWidth);
  const outlineWidth = Math.max(0, Number.isFinite(outlineWidthRaw) ? outlineWidthRaw : 4);
  const align = String(style.align || "center").toLowerCase();
  const lines = text.split("\n");
  const fontSpec = `${fontWeightCss} ${fontSize}px ${fontFamily}`;
  // style.letterSpacing は 1/1000 em で保存される。下流 (描画 / 行幅計測) は
  // px 単位で受け取る前提なので、ここで一度だけ px へ変換する。
  const letterSpacing = (Number(style.letterSpacing) || 0) / 1000 * fontSize;
  const lineSpacingExtra = Number(style.lineSpacing) || 0;
  // textDefaults と telop 個別 style の両方を許容する (一括反映 / per-telop の
  // 切り替えに対応)。優先順は per-telop > telopDefaults。
  const enableOpticalKerning = (() => {
    if (style.enableOpticalKerning != null) return !!style.enableOpticalKerning;
    const td = state.manifest?.config?.telopDefaults || {};
    return !!td.enableOpticalKerning;
  })();
  const opticalKerningHighQuality = (() => {
    if (style.opticalKerningHighQuality != null) return !!style.opticalKerningHighQuality;
    const td = state.manifest?.config?.telopDefaults || {};
    return !!td.opticalKerningHighQuality;
  })();

  // 可視グリフ寸法を Pillow の textbbox(anchor="lt") に揃えるため alphabetic baseline で計測する。
  ctx.save();
  ctx.font = fontSpec;
  ctx.textBaseline = "alphabetic";
  // optical kerning ON では ctx.letterSpacing に頼らず layoutTextRun が
  // letter_spacing を一律加算するため、ネイティブ letterSpacing は使わない。
  let supportsNativeLs = false;
  if (!enableOpticalKerning) {
    try {
      if ("letterSpacing" in ctx) {
        ctx.letterSpacing = `${letterSpacing}px`;
        supportsNativeLs = true;
      }
    } catch (_e) {}
  }

  let baseW = 0;
  const baseLineWidths = [];
  const baseLineAscents = [];
  const baseLineDescents = [];
  const baseLineHeights = [];
  for (const line of lines) {
    let lineW;
    if (enableOpticalKerning) {
      lineW = measureTextRunWidth(ctx, line || " ", {
        fontSpec,
        fontSize,
        letterSpacing,
        opticalKerning: true,
        opticalKerningHighQuality,
        outlineWidth,
      });
    } else if (supportsNativeLs || letterSpacing === 0) {
      lineW = ctx.measureText(line || " ").width;
    } else {
      // 手動 fallback: Σ(各文字幅) + (n-1)*letterSpacing
      let w = 0;
      const chars = Array.from(line || " ");
      for (const ch of chars) w += ctx.measureText(ch).width;
      if (chars.length > 1) w += letterSpacing * (chars.length - 1);
      lineW = w;
    }
    const m = ctx.measureText(line || " ");
    // 行内容に依存しない font 固有のメトリクスを優先する。
    // actualBoundingBoxAscent は「その行に含まれる文字のうち最も高いグリフの上端」を返す
    // ため、Latin だけの行と漢字を含む行で ascent が変わってしまい、行ごとに baseline 位置が
    // ぶれる。Pillow 側 (font.getmetrics) は font 固有値を使うので、Canvas 側も
    // fontBoundingBoxAscent/Descent に揃える (Safari 11.1+ / Chrome 87+ / Firefox 116+)。
    const ascent = Number.isFinite(m.fontBoundingBoxAscent)
      ? m.fontBoundingBoxAscent
      : Number.isFinite(m.actualBoundingBoxAscent)
        ? m.actualBoundingBoxAscent
        : fontSize * 0.8;
    const descent = Number.isFinite(m.fontBoundingBoxDescent)
      ? m.fontBoundingBoxDescent
      : Number.isFinite(m.actualBoundingBoxDescent)
        ? m.actualBoundingBoxDescent
        : fontSize * 0.2;
    const lineH = ascent + descent;
    baseLineWidths.push(lineW);
    baseLineAscents.push(ascent);
    baseLineDescents.push(descent);
    baseLineHeights.push(lineH);
    baseW = Math.max(baseW, lineW);
  }
  ctx.restore();
  const lineGap = Math.max(0, Math.max(2, Math.floor(fontSize / 6)) + lineSpacingExtra);

  const nLines = Math.max(1, lines.length);
  const visibleW = baseW + outlineWidth * 2;
  const visibleH = baseLineHeights.reduce((a, b) => a + b, 0)
    + lineGap * (nLines - 1)
    + outlineWidth * 2 * nLines;

  const padX = Math.max(0, Number(style.boxPaddingX) || 24);
  const padY = Math.max(0, Number(style.boxPaddingY) || 16);
  const boxColor = style.boxBackgroundColor;
  const boxOpacityRaw = style.boxOpacity;
  const boxOpacity = boxOpacityRaw !== undefined && boxOpacityRaw !== null && boxOpacityRaw !== ""
    ? Math.max(0, Math.min(255, Number(boxOpacityRaw) || 0))
    : 0;
  const drawBox = boxOpacity > 0 && boxColor;
  const boxW = visibleW + (drawBox ? padX * 2 : 0);
  const boxH = visibleH + (drawBox ? padY * 2 : 0);

  // ★ align は「box 自体の画面 X 位置」+「box 内の複数行の alignment」の両方に効く。
  //   1 行テロップでも左右揃えが見た目に出るのが直感的 (= dialogue 側の text_align と
  //   揃える)。position="custom" は telop.x が明示指定なので box 位置は触らない。
  //   ALIGN_MARGIN_X = 画面端からのマージン (Pillow 側 speech_offset_x と概念同じ)。
  const ALIGN_MARGIN_X = 80;
  function _alignAnchorX() {
    if (align === "left") return ALIGN_MARGIN_X;
    if (align === "right") return canvasW - boxW - ALIGN_MARGIN_X;
    return Math.round((canvasW - boxW) / 2);
  }
  const position = String(telop.position || "bottom");
  let anchorX;
  let anchorY;
  if (position === "custom") {
    anchorX = telop.x != null ? Number(telop.x) : _alignAnchorX();
    anchorY = telop.y != null ? Number(telop.y) : canvasH - boxH - 80;
  } else if (position === "top") {
    anchorX = _alignAnchorX();
    anchorY = 80;
  } else if (position === "center") {
    anchorX = _alignAnchorX();
    anchorY = Math.round((canvasH - boxH) / 2);
  } else {
    anchorX = _alignAnchorX();
    anchorY = canvasH - boxH - 80;
  }

  // ★ Phase 4: style.rotation (deg)。box 中心を pivot に ctx.rotate する。
  //   rotation = 0 のときは ctx.save/restore コストすら払いたくないので分岐する。
  //   pop_per_char などのグリフ単位 transform は座標系が「rotated frame 内」になるので、
  //   ユーザー目線では rotation との組み合わせが直感的に効く。
  const rotationDeg = Number(style.rotation) || 0;
  const rotationActive = Math.abs(rotationDeg) > 0.0001;
  if (rotationActive) {
    const pivotX = anchorX + boxW / 2;
    const pivotY = anchorY + boxH / 2;
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(rotationDeg * Math.PI / 180);
    ctx.translate(-pivotX, -pivotY);
  }

  if (drawBox) {
    ctx.fillStyle = hexToRgba(boxColor, boxOpacity / 255);
    ctx.fillRect(anchorX, anchorY, boxW, boxH);
  }

  const textLeft = anchorX + (drawBox ? padX : 0);
  const textTop = anchorY + (drawBox ? padY : 0);

  // pop_per_char 等のグリフ単位 transform: プリセット側で clip._glyphTransform に
  // (idx, char) => { dx?, dy?, scale?, alpha?, visible? } を載せて渡す。
  // optical kerning 経路でのみ効く (= 行全体描画パスでは無視)。プリセット側で
  // enableOpticalKerning を強制 true にする責任を持つ。
  const glyphTransformFn = (typeof telop._glyphTransform === "function") ? telop._glyphTransform : null;

  const drawParams = {
    textLeft, textTop, lines,
    baseLineWidths, baseLineAscents, baseLineDescents, baseLineHeights,
    baseW, lineGap, outlineWidth, fontSpec, align,
    letterSpacing,
    enableOpticalKerning, opticalKerningHighQuality, fontSize,
    glyphTransformFn,
  };

  const glow = style.glow && typeof style.glow === "object" ? style.glow : null;
  const shadow = style.dropShadow && typeof style.dropShadow === "object" ? style.dropShadow : null;
  const glowEnabled = !!(glow && glow.enabled);
  const shadowEnabled = !!(shadow && shadow.enabled);

  if (glowEnabled || shadowEnabled) {
    const gBlur = glowEnabled ? Math.max(0, Number(glow.blurPx) || 0) : 0;
    const sBlur = shadowEnabled ? Math.max(0, Number(shadow.blurPx) || 0) : 0;
    const sOx = shadowEnabled ? (Number(shadow.offsetX) || 0) : 0;
    const sOy = shadowEnabled ? (Number(shadow.offsetY) || 0) : 0;
    // ★ glow.passes (任意): 多段発光のパス配列 [{ blurMult, opacityMult }, ...]。
    //   未指定なら 1 パス (= 既存テロップの 1 段 glow と完全互換)。
    //   neon_glow プリセットが指定して「内側くっきり + 外側広く + 加算重ね」のネオン感を出す。
    const glowPasses = (glowEnabled && Array.isArray(glow.passes) && glow.passes.length > 0)
      ? glow.passes
      : [{ blurMult: 1, opacityMult: 1 }];
    // 多段 glow の最大 blur に合わせて bbox margin を広げる (= halo が切れないように)。
    let gBlurMaxEff = 0;
    if (glowEnabled) {
      for (const p of glowPasses) {
        const m = Number(p.blurMult);
        gBlurMaxEff = Math.max(gBlurMaxEff, gBlur * (Number.isFinite(m) ? m : 1));
      }
    }
    // bbox は visible text + blur halo を全部包む大きさ。ガウシアン blur の有効半径は
    // 3σ なので 1σ 余裕を見て 4σ ぶんの margin を取る。silhouette/tinted を全面
    // 1920×1080 で確保していた旧実装より backing store は概ね 20-50 倍小さくなる。
    const blurMargin = Math.ceil(4 * Math.max(gBlurMaxEff, sBlur));
    const bboxX = Math.floor(textLeft - blurMargin);
    const bboxY = Math.floor(textTop - blurMargin);
    const bboxW = Math.max(1, Math.ceil(visibleW + blurMargin * 2));
    const bboxH = Math.max(1, Math.ceil(visibleH + blurMargin * 2));
    // bbox 相対座標で silhouette を描く。drawTextLines は textLeft/textTop を
    // 起点にレイアウトを組むので、原点を bbox 内側に平行移動するだけで済む。
    const localDrawParams = {
      ...drawParams,
      textLeft: textLeft - bboxX,
      textTop: textTop - bboxY,
    };
    // glow の silhouette source は glowSource で切替 (stroke 由来 / fill 由来 / 両方)。
    // shadow は常に "both" (= 影は塗り全体の輪郭が出る方が自然)。
    // ★ silhouette scratch は 1 枚しかないので、shadow → glow の順で「焼いて即 tint で退避」する。
    //   glow を焼くと shadow 用 silhouette が上書きされる可能性があるため、shadowTinted を先に確保。
    const glowSource = (glowEnabled && typeof glow.glowSource === "string") ? glow.glowSource : "both";
    let shadowTinted = null;
    if (shadowEnabled) {
      const shadowSilhouette = createTextSilhouetteCanvas(bboxW, bboxH, localDrawParams, "both");
      shadowTinted = tintSilhouetteCanvas(
        shadowSilhouette,
        shadow.color || "#000000",
        shadow.opacity != null ? Number(shadow.opacity) : 0.7,
        "shadowTinted",
      );
    }
    let silhouette = null;
    if (glowEnabled) {
      silhouette = createTextSilhouetteCanvas(bboxW, bboxH, localDrawParams, glowSource);
    }
    if (shadowEnabled && shadowTinted) {
      ctx.save();
      if (sBlur > 0) ctx.filter = `blur(${sBlur}px)`;
      ctx.drawImage(shadowTinted, bboxX + sOx, bboxY + sOy);
      ctx.restore();
    }
    if (glowEnabled) {
      const baseOpacity = glow.opacity != null ? Number(glow.opacity) : 0.8;
      const glowColor = glow.color || "#ffffff";
      for (let i = 0; i < glowPasses.length; i += 1) {
        const pass = glowPasses[i] || {};
        const blurMult = Number.isFinite(Number(pass.blurMult)) ? Number(pass.blurMult) : 1;
        const opacityMult = Number.isFinite(Number(pass.opacityMult)) ? Number(pass.opacityMult) : 1;
        const passOpacity = Math.max(0, Math.min(1, baseOpacity * opacityMult));
        if (passOpacity <= 0) continue;
        const passBlur = Math.max(0, gBlur * blurMult);
        // ★ Phase 5: per-pass color を許容。pass.color が無ければ glow.color 既定。
        //   neon_glow が「暗色の遠ハロー + 明色の中ブルーム」を 1 回の baseDraw で
        //   出すために使う (= 多段の各 pass で色を切り替えられる)。
        //   pass.color 未指定の既存呼び出しは glowColor 単色のまま完全互換。
        const passColor = (typeof pass.color === "string" && pass.color.trim() !== "")
          ? pass.color
          : glowColor;
        // ★ pass.compositeOperation を許容: 未指定なら 2 段目以降 "lighter" (加算) 既定。
        //   neon_glow の大ハローは加算ではなく source-over で「下に敷く」描画にしたい
        //   ので "source-over" を明示できる経路を用意する。
        const passOp = (typeof pass.compositeOperation === "string" && pass.compositeOperation)
          ? pass.compositeOperation
          : (i === 0 ? "source-over" : "lighter");
        // tintSilhouetteCanvas は scratch の "glowTinted" を上書きするが、
        // すぐ drawImage で消費するので問題なし。
        const tinted = tintSilhouetteCanvas(silhouette, passColor, passOpacity, "glowTinted");
        ctx.save();
        if (passBlur > 0) ctx.filter = `blur(${passBlur}px)`;
        ctx.globalCompositeOperation = passOp;
        ctx.drawImage(tinted, bboxX, bboxY);
        ctx.restore();
      }
    }
  }

  drawTextLines(ctx, {
    ...drawParams,
    fillStyle: color,
    strokeStyle: outlineColor,
    useStroke: outlineWidth > 0,
  });
  if (rotationActive) ctx.restore();
  return true;
}
