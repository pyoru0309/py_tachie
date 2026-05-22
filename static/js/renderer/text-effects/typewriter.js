// =============================================================================
// renderer/text-effects/typewriter.js
//
// 入場アニメ "typewriter"。slot: animation_in
// - grapheme 単位で順次出現
// - revealStyle: "instant" = 切替時点で完全表示 / "fade" = 末尾 1 文字だけ α 補間
//
// 実装 (Phase 2 で書き直し):
//   最終全文の layout を基準に描く。clip.text を切り詰めて baseDraw に渡すと
//   center/right alignment で行幅が変動して文字位置が揺れるため、必ず全文を
//   layout させた上で `glyphTransformFn` でグリフ単位の表示/α を制御する。
//   pop_per_char と同じ glyphTransformFn 経路 (= optical kerning 強制 ON)。
//
// グリフ番号の整合性:
//   typewriter の n (= 表示文字数) は grapheme 単位で計算するが、drawTextLines の
//   globalCharIdx は「\n を除いた行内グリフの通し番号」で、layoutTextRun が空白
//   トークン (drawable=false) を 1 として進める。
//   そのため _segments も「\n を除外した grapheme 列」にして、n と globalCharIdx が
//   一致するようにする。
// =============================================================================

import { registerEffectPreset } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  charsPerSec: 12,
  revealStyle: "instant",
  fadeSec: 0.1,
});

const CONTROLS = [
  { key: "charsPerSec", label: "速さ (文字/秒)", type: "number", min: 1, max: 60, step: 1 },
  {
    key: "revealStyle", label: "出現スタイル", type: "select",
    options: [
      { value: "instant", label: "即現れる" },
      { value: "fade", label: "末尾フェード" },
    ],
  },
  { key: "fadeSec", label: "末尾フェード長 (秒)", type: "number", min: 0, max: 1, step: 0.01 },
];

let _segmenter = null;
function _segments(text) {
  // 改行は除外する (drawTextLines の globalCharIdx と整合させるため、§実装ノート参照)。
  const s = String(text || "").replace(/\n/g, "");
  if (!s) return [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    if (!_segmenter) _segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    const arr = [];
    for (const seg of _segmenter.segment(s)) arr.push(seg.segment);
    return arr;
  }
  return Array.from(s);
}

registerEffectPreset({
  id: "typewriter",
  label: "タイプライター",
  slots: ["animation_in"],
  needsOffscreenRedraw: true,   // n が変わるたび offscreen を焼き直す
  needsLayerComposite: true,
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    const segs = _segments(clip?.text || "");
    if (segs.length === 0) { baseDraw(ctx); return; }
    const cps = Math.max(1, Number(params?.charsPerSec ?? DEFAULT_PARAMS.charsPerSec));
    const fullN = segs.length;
    // localSec=0 でも 1 文字出る (= +1)。
    const n = Math.min(fullN, Math.floor(Math.max(0, localSec) * cps) + 1);
    if (n <= 0) return;

    const revealStyle = String(params?.revealStyle || DEFAULT_PARAMS.revealStyle);
    const fadeSec = Math.max(0, Number(params?.fadeSec ?? DEFAULT_PARAMS.fadeSec));
    // 末尾 (n-1 番目) の表示経過時間。fade のとき alpha 補間に使う。
    const elapsedForLast = Math.max(0, localSec - (n - 1) / cps);
    const headAlpha = (revealStyle === "fade" && fadeSec > 0)
      ? Math.min(1, elapsedForLast / fadeSec)
      : 1;

    // glyphTransformFn: 最終全文の layout を基準に
    //   idx >= n          → visible=false  (まだ出ていない)
    //   idx == n-1, fade  → alpha=headAlpha
    //   それ以外          → 通常表示
    const headIdx = n - 1;
    const transformFn = (idx, _char) => {
      if (idx >= n) return { visible: false };
      if (idx === headIdx && headAlpha < 1) return { alpha: headAlpha };
      return null;
    };

    const origStyle = clip?.style;
    if (!origStyle) { baseDraw(ctx); return; }
    // optical kerning を強制 ON (= glyphTransformFn が効く経路に乗せる)。
    const origOptical = origStyle.enableOpticalKerning;
    const hadGlyphTransform = Object.prototype.hasOwnProperty.call(clip, "_glyphTransform");
    const origGlyphTransform = clip._glyphTransform;
    try {
      origStyle.enableOpticalKerning = true;
      clip._glyphTransform = transformFn;
      baseDraw(ctx);
    } finally {
      origStyle.enableOpticalKerning = origOptical;
      if (hadGlyphTransform) clip._glyphTransform = origGlyphTransform;
      else delete clip._glyphTransform;
    }
  },
});
