// ===========================================================================
// 一括反映 (bulk apply) ダイアログ用ユーティリティの純粋部分
// 値の整形・変更検出・ラベル定義のみ。実際の apply (saveScenario / recordHistory
// / loadCut などを呼ぶ部分) と prompt 系ダイアログ操作は app.js に残してある。
// ===========================================================================

import { fontDisplayName, globalWeightLabel } from "./font.js";

export const TEXT_DEFAULT_LABELS = {
  fontFamily: "デフォルト書体",
  fontWeight: "デフォルト太さ",
  fontSize: "デフォルト文字サイズ",
  boxOpacity: "デフォルト帯の濃さ",
  textColor: "デフォルト文字色",
  textOutlineWidth: "デフォルトアウトライン",
  textOutlineColor: "デフォルトアウトライン色",
  showSpeakerName: "話者名の表示",
  letterSpacing: "文字間",
  lineGap: "行間",
  dialogueGlow: "セリフ光彩",
  dialogueDropShadow: "セリフドロップシャドウ",
};

export const TELOP_DEFAULT_LABELS = {
  fontFamily: "書体",
  fontWeight: "太さ",
  fontSize: "文字サイズ",
  color: "文字色",
  outlineWidth: "アウトライン",
  outlineColor: "アウトライン色",
  letterSpacing: "文字間",
  lineSpacing: "行間",
  glow: "光彩",
  dropShadow: "ドロップシャドウ",
  // ★ Phase 3 で追加 (TextClip 拡張)。これらは telop の top-level に乗るキー。
  //   反映先は kind が一致するもののみ (= caption ↔ mv_text 間では反映しない)。
  renderLayer: "描画レイヤー",
  effectPreset: "視覚エフェクト",
  effectParams: "エフェクトパラメータ",
  animation: "アニメーション",
  // 表示位置 (top/bottom/center/custom) と座標 (x, y)。共に top-level (style 配下ではない)。
  position: "表示位置",
  x: "X 座標",
  y: "Y 座標",
};

// applyTelopDefaultsToAllTelops が「style ではなく telop の top-level に直接書く」キー。
// dialog.js 側で分岐するために share。
export const TELOP_TOP_LEVEL_KEYS = new Set([
  "renderLayer",
  "effectPreset",
  "effectParams",
  "animation",
  "position",
  "x",
  "y",
]);

export function formatBulkValue(key, value) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (key === "fontFamily") return fontDisplayName(value) || value;
    if (key === "fontWeight") return globalWeightLabel(value);
    return value;
  }
  if (typeof value === "object") {
    if ("enabled" in value) return value.enabled ? "ON" : "OFF";
    return JSON.stringify(value).slice(0, 60);
  }
  return String(value);
}

export function textDefaultsDiff(previous, next) {
  const diff = {};
  if (previous.fontFamily !== next.fontFamily && next.fontFamily) {
    diff.fontFamily = next.fontFamily;
  }
  if (previous.fontWeight !== next.fontWeight && next.fontWeight) {
    diff.fontWeight = next.fontWeight;
  }
  if (
    Number.isFinite(previous.fontSize) &&
    Number.isFinite(next.fontSize) &&
    previous.fontSize !== next.fontSize
  ) {
    diff.fontSize = next.fontSize;
  }
  if (
    Number.isFinite(previous.boxOpacity) &&
    Number.isFinite(next.boxOpacity) &&
    Math.abs(previous.boxOpacity - next.boxOpacity) > 1e-6
  ) {
    diff.boxOpacity = next.boxOpacity;
  }
  if (previous.textColor !== next.textColor && next.textColor) {
    diff.textColor = next.textColor;
  }
  if (
    Number.isFinite(previous.textOutlineWidth) &&
    Number.isFinite(next.textOutlineWidth) &&
    previous.textOutlineWidth !== next.textOutlineWidth
  ) {
    diff.textOutlineWidth = next.textOutlineWidth;
  }
  if (previous.textOutlineColor !== next.textOutlineColor && next.textOutlineColor) {
    diff.textOutlineColor = next.textOutlineColor;
  }
  if (Boolean(previous.showSpeakerName) !== Boolean(next.showSpeakerName)) {
    diff.showSpeakerName = next.showSpeakerName;
  }
  if (
    Number.isFinite(previous.letterSpacing) &&
    Number.isFinite(next.letterSpacing) &&
    Math.abs(previous.letterSpacing - next.letterSpacing) > 1e-6
  ) {
    diff.letterSpacing = next.letterSpacing;
  }
  if (
    Number.isFinite(previous.lineGap) &&
    Number.isFinite(next.lineGap) &&
    previous.lineGap !== next.lineGap
  ) {
    diff.lineGap = next.lineGap;
  }
  // dialogueGlow / dialogueDropShadow は object 同士の JSON 比較。
  for (const key of ["dialogueGlow", "dialogueDropShadow"]) {
    const a = JSON.stringify(previous[key] || {});
    const b = JSON.stringify(next[key] || {});
    if (a !== b) diff[key] = next[key];
  }
  return diff;
}

export function telopDefaultsDiff(prev, next) {
  const diff = {};
  for (const key of ["fontFamily", "fontWeight", "color", "outlineColor"]) {
    const a = String(prev?.[key] ?? "");
    const b = String(next?.[key] ?? "");
    if (a !== b && b) diff[key] = next[key];
  }
  for (const key of ["fontSize", "outlineWidth"]) {
    const a = Number(prev?.[key] ?? NaN);
    const b = Number(next?.[key] ?? NaN);
    if (Number.isFinite(b) && a !== b) diff[key] = next[key];
  }
  // letterSpacing は小数点を含むので Math.abs 比較。
  // lineSpacing は整数。
  for (const key of ["letterSpacing", "lineSpacing"]) {
    const a = Number(prev?.[key] ?? 0);
    const b = Number(next?.[key] ?? 0);
    if (Number.isFinite(b) && Math.abs(a - b) > 1e-6) diff[key] = next[key];
  }
  for (const key of ["glow", "dropShadow"]) {
    const aJson = JSON.stringify(prev?.[key] || {});
    const bJson = JSON.stringify(next?.[key] || {});
    if (aJson !== bJson) diff[key] = next[key];
  }
  return diff;
}
