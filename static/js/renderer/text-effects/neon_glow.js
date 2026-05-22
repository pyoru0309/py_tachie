// =============================================================================
// renderer/text-effects/neon_glow.js (Phase 5 再設計)
//
// "neon_glow" — 本物のネオン管に寄せた発光テキスト。下から順に 4 層を重ねる:
//
//   ① 暗色の大ハロー    (background の周りにじんわり残光、彩度高め・明度低めの同系色)
//   ② 明色の中ブルーム   (lighter 加算で発光密度を積む)
//   ③ 色付き管 (tube) ストローク   (細め、tubeColor)
//   ④ 白〜淡色の細い芯 (hot core) ストローク   (coreColor、最細)
//
// 設計上のポイント (ユーザーレビューから):
//   - 「中身を白く塗る」 (= 旧 coreOpacity) は太い日本語フォントで「中が白い字幕」に
//     見えてしまう。理想は「チューブ線の中心線だけが白い」状態。だから本実装では
//     fill を完全に透明にし、白芯は **別の細い stroke** として 2 回目の baseDraw で
//     重ねる (= coreStrokeWidth)。
//   - 「遠い光」は明るい同色ではなく **少し暗め・濃いめの同系色** にすると残光感が出る。
//     haloColor 未指定なら tubeColor を自動で 35% 明度に落とした色を使う。
//   - autoAttenuateBright は MV 用途では基本オフ。
//
// params:
//   tubeColor          管の色 (例 "#70f6ff")。「光の色」と呼ぶ
//   tubeWidth          管 stroke 太さ (px、1.5〜3 推奨。太いと字幕化する)
//   coreColor          白芯 stroke の色 (既定 "#ffffff"、わずかに色付き淡色も可)
//   coreStrokeWidth    白芯 stroke 太さ (px、tubeWidth の 1/2 前後が映える)
//   haloColor          遠ハローの色 (空文字なら tubeColor の暗色版を自動生成)
//   haloBlurPx         遠ハローの blur (px、45〜80 推奨)
//   haloStrength       遠ハローの濃度乗数 (1.8〜3.0)
//   midBlurPx          中ブルームの blur (px、12〜24 推奨)
//   midStrength        中ブルームの濃度乗数 (0.8〜1.6)
//   opacity            全体 halo opacity (0.9〜1.0)
//   pulseAmount        パルス幅 (sin 揺らぎ、0.05〜0.12 推奨)
//   pulseHz            パルス速度 (Hz)
//   flickerAmount      フリッカ幅 (deterministicRandom、0〜0.08)
//
// 廃止 (Phase 4 まで存在):
//   color / hollowFill / coreOpacity / blurPx / glowSource / autoAttenuateBright
//   これらが disk に残っていても neon_glow.js では参照しない。
//   旧 disk データは Phase 5 normalize で新キーへ非可逆 migration (= 旧キー削除)。
// =============================================================================

import { registerEffectPreset, deterministicRandom } from "../text-effects.js";

const DEFAULT_PARAMS = Object.freeze({
  // 「らしさ」を強く出すデフォルトとしてマゼンタ寄りピンクを採用。
  // tubeColor を変えれば自動で haloColor も同系暗色 (= 濃いマゼンタ) になる。
  tubeColor: "#ff5ce1",
  tubeWidth: 2,
  coreColor: "#ffffff",
  coreStrokeWidth: 1,
  haloColor: "",          // 空 = tubeColor を自動暗色化
  haloBlurPx: 56,
  haloStrength: 2.4,
  midBlurPx: 18,
  midStrength: 1.2,
  opacity: 1.0,
  pulseAmount: 0.08,
  pulseHz: 1.0,
  flickerAmount: 0.0,
});

const CONTROLS = [
  { key: "tubeColor",       label: "管の色 (光の色)", type: "color" },
  { key: "tubeWidth",       label: "管の太さ (px)",   type: "number", min: 1, max: 8,  step: 0.5 },
  { key: "coreColor",       label: "白芯の色",         type: "color" },
  { key: "coreStrokeWidth", label: "白芯の太さ (px)", type: "number", min: 0, max: 6,  step: 0.5 },
  { key: "haloColor",       label: "遠ハロー色 (空=自動暗色)", type: "text" },
  { key: "haloBlurPx",      label: "遠ハロー幅 (px)", type: "number", min: 0, max: 200, step: 1 },
  { key: "haloStrength",    label: "遠ハロー強さ",     type: "number", min: 0, max: 4,  step: 0.1 },
  { key: "midBlurPx",       label: "中ブルーム幅 (px)", type: "number", min: 0, max: 80, step: 1 },
  { key: "midStrength",     label: "中ブルーム強さ",   type: "number", min: 0, max: 4,  step: 0.1 },
  { key: "opacity",         label: "全体不透明度",     type: "number", min: 0, max: 1,  step: 0.05 },
  { key: "pulseAmount",     label: "パルス幅",         type: "number", min: 0, max: 0.5, step: 0.01 },
  { key: "pulseHz",         label: "パルス速度 (Hz)", type: "number", min: 0.1, max: 6, step: 0.1 },
  { key: "flickerAmount",   label: "フリッカ幅",       type: "number", min: 0, max: 0.5, step: 0.01 },
];

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// "#rrggbb" / "#rgb" を [r,g,b] (0..255) に。未対応形式は null。
function _hexToRgb(hex) {
  const m = String(hex || "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  if (m[1].length === 3) {
    return [
      parseInt(m[1][0] + m[1][0], 16),
      parseInt(m[1][1] + m[1][1], 16),
      parseInt(m[1][2] + m[1][2], 16),
    ];
  }
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16),
  ];
}

function _rgbToHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// tubeColor から「遠ハロー用の少し暗め・濃いめの同系色」を自動生成する。
// HSL 系に持っていくと色相が安定するが、簡略のため RGB を 0.35x するだけで
// 「暗色化」する。これで「水色 → 濃いシアン」「ピンク → マゼンタ寄り」になる。
// haloColor が明示されていれば自動生成しない。
function _autoHaloColor(tubeColor) {
  const rgb = _hexToRgb(tubeColor);
  if (!rgb) return "#202020";
  const [r, g, b] = rgb;
  // 単純に 0.35 倍では「ただ暗いグレー」寄りになるので、最大成分は維持気味に潰す。
  // dim = 0.4 で全体を落とし、もっとも明るかった成分は 0.55 倍まで戻す (= 彩度を保つ)。
  const maxIdx = (r >= g && r >= b) ? 0 : (g >= b ? 1 : 2);
  const dim = 0.4;
  const out = [r * dim, g * dim, b * dim];
  out[maxIdx] = [r, g, b][maxIdx] * 0.55;
  return _rgbToHex(out[0], out[1], out[2]);
}

registerEffectPreset({
  id: "neon_glow",
  label: "ネオン発光",
  slots: ["effect"],
  needsOffscreenRedraw: true,
  needsLayerComposite: true,
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  resolveRuntimeFlags(params, _ctx) {
    const pulse = Math.max(0, Number(params?.pulseAmount ?? DEFAULT_PARAMS.pulseAmount));
    const flicker = Math.max(0, Number(params?.flickerAmount ?? DEFAULT_PARAMS.flickerAmount));
    const animated = pulse > 0 || flicker > 0;
    return {
      needsOffscreenRedraw: animated,
      needsLayerComposite: true,
    };
  },
  draw(ctx, clip, params, localSec, frameIdx, context, baseDraw) {
    const origStyle = clip?.style;
    if (!origStyle) { baseDraw(ctx); return; }

    const tubeColor = String(params?.tubeColor || DEFAULT_PARAMS.tubeColor);
    const tubeWidth = Math.max(0.5, Number(params?.tubeWidth ?? DEFAULT_PARAMS.tubeWidth));
    const coreColor = String(params?.coreColor || DEFAULT_PARAMS.coreColor);
    const coreStrokeWidth = Math.max(0, Number(params?.coreStrokeWidth ?? DEFAULT_PARAMS.coreStrokeWidth));
    const haloColorRaw = String(params?.haloColor || "").trim();
    const haloColor = haloColorRaw !== "" ? haloColorRaw : _autoHaloColor(tubeColor);
    const haloBlurPx = Math.max(0, Number(params?.haloBlurPx ?? DEFAULT_PARAMS.haloBlurPx));
    const haloStrength = Math.max(0, Number(params?.haloStrength ?? DEFAULT_PARAMS.haloStrength));
    const midBlurPx = Math.max(0, Number(params?.midBlurPx ?? DEFAULT_PARAMS.midBlurPx));
    const midStrength = Math.max(0, Number(params?.midStrength ?? DEFAULT_PARAMS.midStrength));
    const baseOpacity = _clamp(Number(params?.opacity ?? DEFAULT_PARAMS.opacity), 0, 1);
    const pulseAmount = Math.max(0, Number(params?.pulseAmount ?? DEFAULT_PARAMS.pulseAmount));
    const pulseHz = Math.max(0.01, Number(params?.pulseHz ?? DEFAULT_PARAMS.pulseHz));
    const flickerAmount = Math.max(0, Number(params?.flickerAmount ?? DEFAULT_PARAMS.flickerAmount));

    // pulse / flicker (deterministic) で halo opacity を動的に揺らす。
    // pulseAmount は「±割合」で扱う (= 0.1 なら 0.9〜1.1 倍)。
    const pulse = pulseAmount * Math.sin(localSec * Math.PI * 2 * pulseHz);
    const flickerRaw = (deterministicRandom(clip?.id || "", frameIdx, 1) - 0.5) * 2;
    const flicker = flickerAmount * flickerRaw;
    const dynScale = _clamp(1.0 + pulse + flicker, 0, 2);

    // 4 段の glow passes を 1 回の baseDraw に乗せる:
    //   pass[0] : 遠ハロー (haloColor 暗色, blur 大)            → source-over で下地に敷く
    //   pass[1] : 中ブルーム (tubeColor 明色, blur 中)          → lighter で加算密度
    //   pass[2] : 近距離ブルーム (tubeColor 明色, blur 小)      → lighter 加算で管周辺くっきり
    //   pass[3] : 管周りタイト (tubeColor 明色, blur 極小)      → lighter で管そのものを輝かせる
    //
    // text-core.js の glow.passes は per-pass color と compositeOperation を受け取る
    // (Phase 5 拡張)。1 回の baseDraw で済むので、レイアウト計算は 1 回だけ。
    //
    // 注意: blurMult / opacityMult は glow.blurPx / glow.opacity に対する乗数。
    //   ここでは glow.blurPx = haloBlurPx を「最大 blur」として渡し、その何%という形で
    //   各 pass の実 blur を決める。
    const haloBaseOpacity = _clamp(baseOpacity * haloStrength * dynScale, 0, 1);
    const midBaseOpacity = _clamp(baseOpacity * midStrength * dynScale, 0, 1);
    const haloBlur = haloBlurPx;
    const midBlur = midBlurPx;
    // glow.passes は blurMult を「glow.blurPx に対する倍率」として消費するので、
    // 全 pass を haloBlurPx 基準で算出して mid/near は 「midBlurPx/haloBlurPx」倍率で表現する。
    const midBlurMult = haloBlur > 0 ? (midBlur / haloBlur) : 0;
    const nearBlurMult = haloBlur > 0 ? (Math.max(2, midBlur * 0.4) / haloBlur) : 0;
    const tightBlurMult = haloBlur > 0 ? (Math.max(1, tubeWidth * 0.6) / haloBlur) : 0;

    const passes = [
      // 大ハロー: 暗色を source-over で「敷く」 (= 加算ではない、画面に残る残光)
      {
        color: haloColor,
        blurMult: 1.0,
        opacityMult: haloBaseOpacity / Math.max(0.001, baseOpacity),
        compositeOperation: "source-over",
      },
      // 中ブルーム: 明色を加算で重ねる (= 発光密度)
      {
        color: tubeColor,
        blurMult: midBlurMult,
        opacityMult: midBaseOpacity / Math.max(0.001, baseOpacity),
        compositeOperation: "lighter",
      },
      // 近距離: 明色をさらに細く加算 (= 管周辺にじむ強い光)
      {
        color: tubeColor,
        blurMult: nearBlurMult,
        opacityMult: midBaseOpacity / Math.max(0.001, baseOpacity) * 0.7,
        compositeOperation: "lighter",
      },
      // 管周りタイト: 管自身が輝いて見えるよう細く加算
      {
        color: tubeColor,
        blurMult: tightBlurMult,
        opacityMult: dynScale,
        compositeOperation: "lighter",
      },
    ];

    const origGlow = origStyle.glow;
    const origColor = origStyle.color;
    const origOutlineColor = origStyle.outlineColor;
    const origOutlineWidth = origStyle.outlineWidth;
    try {
      // ─── 1 回目の baseDraw: 多段 halo + 色管 stroke (fill 透明) ───
      origStyle.glow = {
        enabled: true,
        color: tubeColor,         // pass.color が未指定の場合のフォールバック
        blurPx: haloBlur,
        opacity: baseOpacity,
        glowSource: "stroke",     // halo の source は管 (stroke) のみ
        passes,
      };
      // fill は使わない (= 「中身が白く塗られた字幕」を防ぐ)。
      origStyle.color = "rgba(0,0,0,0)";
      origStyle.outlineColor = tubeColor;
      origStyle.outlineWidth = tubeWidth;
      baseDraw(ctx);

      // ─── 2 回目の baseDraw: 白芯 stroke のみ (halo なし、fill 透明) ───
      if (coreStrokeWidth > 0) {
        origStyle.glow = { enabled: false };
        origStyle.color = "rgba(0,0,0,0)";
        origStyle.outlineColor = coreColor;
        origStyle.outlineWidth = coreStrokeWidth;
        baseDraw(ctx);
      }
    } finally {
      origStyle.glow = origGlow;
      origStyle.color = origColor;
      origStyle.outlineColor = origOutlineColor;
      origStyle.outlineWidth = origOutlineWidth;
    }
  },
});
