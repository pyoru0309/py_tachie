// =============================================================================
// renderer/poster-templates/repeated_ghost.js
//
// poster_typography テンプレ "repeated_ghost" — 同じフレーズの極細アウトラインを
// 上下に反復させる。中央には実体テキスト、上下には透かしのような ghost テキスト。
//
// 想定用途:
//   - 「Twitter始めました」風の動画タイトル組版
//   - メイン文言の周りに透けるレイヤーを敷いて画面を厚くする
//
// 生成される TextClip:
//   1. main clip (中央)
//   2..N. ghost clip[] (上下に反復、color=transparent + outline のみ、ghostAlpha 適用)
// =============================================================================

import { registerPosterTemplate } from "./registry.js";

const DEFAULT_PARAMS = Object.freeze({
  text: "繰り返す音",
  ghostCount: 3,                // 上下それぞれの反復数 (合計 2N + 1 clip)
  ghostAlpha: 0.35,             // ghost 不透明度 (style.bodyOpacity 経由ではなく、color に alpha を焼く)
  ghostSpacingRatio: 0.85,      // 反復間隔 (mainSize に対する比率)
  mainSizeRatio: 0.16,          // 中央 main の文字サイズ (画面高比)
  mainColor: "#ffffff",
  ghostColor: "#ffffff",
  ghostOutlineOnly: true,       // true: fill 透明 + stroke のみ / false: fill 半透明
  outlineWidth: 3,
  outlineColor: "#ffffff",
  // ★ Phase 6: テンプレ単位の書体 (main / ghost 共通)。空 = defaultTelop 継承
  fontFamily: "",
});

const CONTROLS = [
  { key: "text", label: "テキスト", type: "text" },
  { key: "ghostCount", label: "反復数 (上下それぞれ)", type: "number", min: 0, max: 8, step: 1 },
  { key: "ghostAlpha", label: "Ghost 不透明度", type: "number", min: 0, max: 1, step: 0.05 },
  { key: "ghostSpacingRatio", label: "Ghost 間隔比 (主サイズ比)", type: "number", min: 0.3, max: 2.0, step: 0.05 },
  { key: "mainSizeRatio", label: "主サイズ (画面高比)", type: "number", min: 0.05, max: 0.5, step: 0.01 },
  { key: "mainColor", label: "主の文字色", type: "color" },
  { key: "ghostColor", label: "Ghost の色", type: "color" },
  { key: "ghostOutlineOnly", label: "Ghost を輪郭のみにする", type: "checkbox" },
  { key: "fontFamily", label: "書体 (main / ghost 共通)", type: "fontFamily" },
  { key: "outlineWidth", label: "アウトライン太さ", type: "number", min: 0, max: 20, step: 1 },
  { key: "outlineColor", label: "アウトライン色", type: "color" },
];

// "#rrggbb" + alpha [0..1] → "#rrggbbaa" の 8桁 hex (canvas2d がそのまま読める)。
function _hexWithAlpha(hex, alpha) {
  const a = Math.max(0, Math.min(1, Number(alpha)));
  const aHex = Math.round(a * 255).toString(16).padStart(2, "0");
  // hex が "#rrggbb" 形式以外でも文字列を受け取って返すだけ (壊れたら text-core 側で
  // hexToRgba にかかって fallback する)。
  const trimmed = String(hex || "#ffffff").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `${trimmed}${aHex}`;
  }
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 7)}${aHex}`;
  }
  return trimmed;
}

registerPosterTemplate({
  id: "repeated_ghost",
  label: "反復ゴースト (上下に透かし)",
  description: "中央にメイン、上下に透けたゴーストを反復配置。",
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  generate(params, ctx) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const canvasW = Number(ctx?.canvasW) || 1920;
    const canvasH = Number(ctx?.canvasH) || 1080;
    const mainSize = Math.max(16, canvasH * p.mainSizeRatio);
    const ghostCount = Math.max(0, Math.min(8, Math.floor(Number(p.ghostCount) || 0)));
    const ghostSpacing = Math.max(0, mainSize * Number(p.ghostSpacingRatio || 1));
    const text = String(p.text || "");
    const textLen = Math.max(1, Array.from(text).length);
    // 日本語全角想定で 1 文字幅 ≒ fontSize。マージン (padX=24) は box 描画なしのとき
    // 加算されないので除外する。これで main と ghost の x が一致し、画面中央に
    // 寄せたときの「実 box 中心 ≒ 画面中央」が崩れにくい。
    const boxW = mainSize * textLen;
    const boxH = mainSize * 1.3;

    const cx = Math.round((canvasW - boxW) / 2);
    const cy = Math.round((canvasH - boxH) / 2);

    const clips = [];
    const ghostFillColor = p.ghostOutlineOnly
      ? "#00000000"  // 完全透明 fill
      : _hexWithAlpha(p.ghostColor, p.ghostAlpha);
    const ghostOutlineColor = _hexWithAlpha(p.outlineColor || p.ghostColor, p.ghostAlpha);
    const sharedFont = p.fontFamily ? String(p.fontFamily) : "";

    function _ghostStyle() {
      const s = {
        fontSize: Math.round(mainSize),
        color: ghostFillColor,
        outlineColor: ghostOutlineColor,
        outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
        align: "center",
      };
      if (sharedFont) s.fontFamily = sharedFont;
      return s;
    }

    // 上側 ghost: i=1..ghostCount を上方向 (y を ghostSpacing*i ぶん減らす)
    for (let i = ghostCount; i >= 1; i -= 1) {
      clips.push({
        text,
        position: "custom",
        x: cx,
        y: Math.round(cy - ghostSpacing * i),
        style: _ghostStyle(),
        kind: "mv_text",
        role: `ghost_up_${i}`,
      });
    }

    // メイン
    const mainStyle = {
      fontSize: Math.round(mainSize),
      color: p.mainColor,
      outlineColor: p.outlineColor,
      outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
      align: "center",
    };
    if (sharedFont) mainStyle.fontFamily = sharedFont;
    clips.push({
      text,
      position: "custom",
      x: cx,
      y: cy,
      style: mainStyle,
      kind: "mv_text",
      role: "main",
    });

    // 下側 ghost
    for (let i = 1; i <= ghostCount; i += 1) {
      clips.push({
        text,
        position: "custom",
        x: cx,
        y: Math.round(cy + ghostSpacing * i),
        style: _ghostStyle(),
        kind: "mv_text",
        role: `ghost_down_${i}`,
      });
    }

    return clips;
  },
});
