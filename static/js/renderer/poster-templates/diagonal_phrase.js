// =============================================================================
// renderer/poster-templates/diagonal_phrase.js
//
// poster_typography テンプレ "diagonal_phrase" — フレーズを斜めに配置。
// タイトル / サブタイトル / 英訳など複数行を異なる角度で組み合わせる。
//
// 想定用途:
//   - MV のタイトル組版 (主題 + サブコピー + 英訳を別角度で重ねる)
//   - 雑誌風レイアウト
//
// 生成される TextClip:
//   - lines パラメータ (改行区切り) の各行が 1 clip
//   - 行ごとに rotation / sizeRatio / xRatio / yRatio を変えてリズムを作る
//   - 既定では 3 行分のプリセットを内蔵。行数を増やしても順送りで角度・サイズを循環
// =============================================================================

import { registerPosterTemplate } from "./registry.js";

const DEFAULT_PARAMS = Object.freeze({
  lines: "音に合わせ\n踊りまくれ",
  sizeRatios: "0.18,0.18",               // 行ごとの size ratio (画面高比)、CSV
  rotationsDeg: "-12,-6",                // 行ごとの回転 (deg)、CSV
  xRatios: "0.5,0.5",                    // 行ごとの X 中心 (画面幅比)、CSV
  yRatios: "0.36,0.62",                  // 行ごとの Y 中心 (画面高比)、CSV
  color: "#ffffff",
  accentColor: "#ffb347",                // 偶数行 (= 1, 3, 5 行目) に適用
  outlineWidth: 4,
  outlineColor: "#000000",
  // ★ Phase 6: 役割別フォント。偶数行目 (1,3,5…) は accentFontFamily、奇数行目は fontFamily。
  //   どちらも空 = defaultTelop 継承。
  fontFamily: "",
  accentFontFamily: "",
});

const CONTROLS = [
  { key: "lines",       label: "行 (改行区切り)", type: "text" },
  { key: "sizeRatios",  label: "サイズ比 CSV (行順)", type: "text" },
  { key: "rotationsDeg",label: "回転 CSV (行順, deg)", type: "text" },
  { key: "xRatios",     label: "X 中心 CSV (画面幅比, 行順)", type: "text" },
  { key: "yRatios",     label: "Y 中心 CSV (画面高比, 行順)", type: "text" },
  { key: "color",        label: "基本の文字色",   type: "color" },
  { key: "accentColor",  label: "アクセント色 (奇数行目)", type: "color" },
  { key: "fontFamily",       label: "基本の書体",       type: "fontFamily" },
  { key: "accentFontFamily", label: "アクセントの書体 (奇数行目)", type: "fontFamily" },
  { key: "outlineWidth", label: "アウトライン太さ", type: "number", min: 0, max: 30, step: 1 },
  { key: "outlineColor", label: "アウトライン色",   type: "color" },
];

function _parseCsvNumbers(str, fallback) {
  if (!str) return fallback.slice();
  return String(str).split(",").map((s) => {
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : 0;
  });
}

function _pickCycle(arr, idx, fallback) {
  if (!arr || arr.length === 0) return fallback;
  return arr[idx % arr.length];
}

registerPosterTemplate({
  id: "diagonal_phrase",
  label: "斜めフレーズ (複数行を別角度で)",
  description: "複数行を異なる角度・サイズ・位置で配置するタイトル組版テンプレ。",
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  generate(params, ctx) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const canvasW = Number(ctx?.canvasW) || 1920;
    const canvasH = Number(ctx?.canvasH) || 1080;

    const lines = String(p.lines || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];

    const sizeRatios = _parseCsvNumbers(p.sizeRatios, [0.18]);
    const rotations  = _parseCsvNumbers(p.rotationsDeg, [0]);
    const xRatios    = _parseCsvNumbers(p.xRatios, [0.5]);
    const yRatios    = _parseCsvNumbers(p.yRatios, [0.5]);

    const clips = [];
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i];
      const sizeRatio = _pickCycle(sizeRatios, i, 0.15);
      const rotationDeg = _pickCycle(rotations, i, 0);
      const xRatio = _pickCycle(xRatios, i, 0.5);
      const yRatio = _pickCycle(yRatios, i, 0.5);
      const size = Math.max(16, canvasH * sizeRatio);
      const textLen = Math.max(1, Array.from(text).length);
      const boxW = size * textLen * 1.05 + 16 * 2;
      const boxH = size * 1.3 + 16 * 2;
      const cx = canvasW * xRatio;
      const cy = canvasH * yRatio;
      const isAccent = (i % 2 === 0);
      const color = isAccent ? p.accentColor : p.color;
      const fontFamily = isAccent
        ? (p.accentFontFamily || p.fontFamily || "")
        : (p.fontFamily || "");
      const style = {
        fontSize: Math.round(size),
        color,
        outlineColor: p.outlineColor,
        outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
        align: "center",
        rotation: Number(rotationDeg) || 0,
      };
      if (fontFamily) style.fontFamily = String(fontFamily);
      clips.push({
        text,
        position: "custom",
        x: Math.round(cx - boxW / 2),
        y: Math.round(cy - boxH / 2),
        style,
        kind: "mv_text",
        role: `line_${i}`,
      });
    }
    return clips;
  },
});
