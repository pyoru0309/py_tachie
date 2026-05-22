// =============================================================================
// renderer/poster-templates/central_emphasis.js
//
// poster_typography テンプレ "central_emphasis" — 中央に大語句、周辺に小語句。
// 中央テキスト 1 個 + 周辺テキスト N 個 (改行区切り) を、配置モードに応じて
// 角・辺・散布で散らす。
//
// 想定用途:
//   - MV のサビ画面 (中央に主題、周辺にキーワード)
//   - アイキャッチ (中央にタイトル、周辺に英訳やジャンル)
//
// 生成される TextClip:
//   1. center clip (大、中央)
//   2..N. peripheral clip[] (小、配置モードに応じて散布)
// =============================================================================

import { registerPosterTemplate } from "./registry.js";

const DEFAULT_PARAMS = Object.freeze({
  centerText: "音楽",
  peripheralTexts: "リズム\nメロディ\nハーモニー",  // 改行で区切る
  centerSizeRatio: 0.45,        // canvasH 比
  peripheralSizeRatio: 0.08,    // canvasH 比
  layout: "polygon",            // "polygon" | "corners" | "edges" | "scatter"
  jitterPx: 0,                  // 配置ジッタ (固定 seed)。polygon は 0 が綺麗
  centerColor: "#ffffff",
  peripheralColor: "#a8d8ff",
  outlineWidth: 0,              // ネオン/MV 用途では既定でアウトラインなし
  outlineColor: "#000000",
  // ★ Phase 6: 役割別フォント。空 = defaultTelop 継承
  centerFontFamily: "",
  peripheralFontFamily: "",
});

const CONTROLS = [
  { key: "centerText", label: "中央テキスト", type: "text" },
  { key: "peripheralTexts", label: "周辺テキスト (改行区切り)", type: "text" },
  {
    key: "layout", label: "配置", type: "select",
    options: [
      { value: "polygon", label: "多角形 (中央から放射状に均等)" },
      { value: "corners", label: "四隅 + 上下左右" },
      { value: "edges",   label: "上下左右の辺" },
      { value: "scatter", label: "散布 (ランダム)" },
    ],
  },
  { key: "centerSizeRatio",     label: "中央サイズ (画面高比)", type: "number", min: 0.15, max: 0.9, step: 0.02 },
  { key: "peripheralSizeRatio", label: "周辺サイズ (画面高比)", type: "number", min: 0.03, max: 0.3, step: 0.01 },
  { key: "jitterPx",            label: "配置ジッタ (px)",      type: "number", min: 0, max: 200, step: 4 },
  { key: "centerColor",         label: "中央の文字色",         type: "color" },
  { key: "peripheralColor",     label: "周辺の文字色",         type: "color" },
  { key: "centerFontFamily",    label: "中央の書体",           type: "fontFamily" },
  { key: "peripheralFontFamily", label: "周辺の書体",         type: "fontFamily" },
  { key: "outlineWidth",        label: "アウトライン太さ",     type: "number", min: 0, max: 20, step: 1 },
  { key: "outlineColor",        label: "アウトライン色",       type: "color" },
];

// 固定 seed の乱数 (deterministicRandom と同じく書き出し再現性のため Math.random は使わない)。
function _detRand(seed, salt) {
  let h = ((seed | 0) ^ ((salt | 0) << 13)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

// 配置スロットの正規化座標 [0..1] in [x, y]。
// "polygon" : 中央から半径 rx/ry で N 個を等角度 (= 楕円多角形)。
//             横長 (16:9) なので正多角形にはならないが、視覚的には均等配置に見える。
//             N=1 は左、N=2 は上下、N=3 は上+左下+右下、N=4 は四方、N>=5 は均等。
// "corners" : 8 スロット (四隅 + 上下左右の中心) を順番に使う (旧モード)
// "edges"   : 4 スロット (上下左右の中心) を順番に使う (旧モード)
// "scatter" : N 個を 0.1〜0.9 内で deterministic にばらまく
function _layoutSlots(layout, n) {
  if (layout === "polygon") {
    if (n <= 0) return [];
    const out = [];
    // 楕円半径 (正規化 0..1 空間)。中央テキストとあからさまに重ならないよう外側寄り。
    const rx = 0.36;
    const ry = 0.36;
    // 開始角は -90deg (= 真上) からスタートして時計回り。N=2 のときは上下に
    // なるよう、N が奇数なら頂点が上に来るよう揃える。
    const startAngle = -Math.PI / 2;
    for (let i = 0; i < n; i += 1) {
      const angle = startAngle + (i / n) * 2 * Math.PI;
      const x = 0.5 + rx * Math.cos(angle);
      const y = 0.5 + ry * Math.sin(angle);
      out.push([x, y]);
    }
    return out;
  }
  if (layout === "corners") {
    return [
      [0.12, 0.15], [0.88, 0.15],
      [0.12, 0.85], [0.88, 0.85],
      [0.5, 0.08], [0.5, 0.92],
      [0.08, 0.5], [0.92, 0.5],
    ].slice(0, n);
  }
  if (layout === "edges") {
    return [
      [0.5, 0.1], [0.5, 0.9],
      [0.1, 0.5], [0.9, 0.5],
    ].slice(0, n);
  }
  // scatter
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const rx = 0.1 + _detRand(i + 1, 7) * 0.8;
    const ry = 0.1 + _detRand(i + 1, 11) * 0.8;
    out.push([rx, ry]);
  }
  return out;
}

registerPosterTemplate({
  id: "central_emphasis",
  label: "中央強調 (周辺に散らす)",
  description: "中央に大きな主題、周辺に小さなキーワードを散らす。サビ画面・アイキャッチ向き。",
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  generate(params, ctx) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const canvasW = Number(ctx?.canvasW) || 1920;
    const canvasH = Number(ctx?.canvasH) || 1080;
    const centerSize = Math.max(24, canvasH * p.centerSizeRatio);
    const periSize = Math.max(12, canvasH * p.peripheralSizeRatio);
    const jitter = Math.max(0, Number(p.jitterPx) || 0);
    const centerTextLen = Math.max(1, Array.from(String(p.centerText || "")).length);
    const centerBoxW = centerSize * centerTextLen * 1.05 + 16 * 2;
    const centerBoxH = centerSize * 1.3 + 16 * 2;

    const peripherals = String(p.peripheralTexts || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const slots = _layoutSlots(p.layout, peripherals.length);

    const clips = [];
    const centerStyle = {
      fontSize: Math.round(centerSize),
      color: p.centerColor,
      outlineColor: p.outlineColor,
      outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
      align: "center",
    };
    if (p.centerFontFamily) centerStyle.fontFamily = String(p.centerFontFamily);
    clips.push({
      text: String(p.centerText || ""),
      position: "custom",
      x: Math.round((canvasW - centerBoxW) / 2),
      y: Math.round((canvasH - centerBoxH) / 2),
      style: centerStyle,
      kind: "mv_text",
      role: "center",
    });

    for (let i = 0; i < peripherals.length; i += 1) {
      const text = peripherals[i];
      const slot = slots[i] || [0.5, 0.5];
      const textLen = Math.max(1, Array.from(text).length);
      const w = periSize * textLen * 1.05 + 12 * 2;
      const h = periSize * 1.3 + 12 * 2;
      const jx = (_detRand(i + 1, 17) - 0.5) * 2 * jitter;
      const jy = (_detRand(i + 1, 19) - 0.5) * 2 * jitter;
      const cx = slot[0] * canvasW + jx;
      const cy = slot[1] * canvasH + jy;
      const periStyle = {
        fontSize: Math.round(periSize),
        color: p.peripheralColor,
        outlineColor: p.outlineColor,
        outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
        align: "center",
      };
      if (p.peripheralFontFamily) periStyle.fontFamily = String(p.peripheralFontFamily);
      clips.push({
        text,
        position: "custom",
        x: Math.round(cx - w / 2),
        y: Math.round(cy - h / 2),
        style: periStyle,
        kind: "mv_text",
        role: `peripheral_${i}`,
      });
    }

    return clips;
  },
});
