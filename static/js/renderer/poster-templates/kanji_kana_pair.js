// =============================================================================
// renderer/poster-templates/kanji_kana_pair.js
//
// poster_typography テンプレ "漢字＋かな" (kanji_kana_pair) — 主テキストに
// 小さな添えテキストを寄せる組み合わせ。フリガナ風と限らず「キーワードを
// 大きくして前後の助詞や副詞を小さく添える」用途を想定する。
//
// 生成される TextClip:
//   1. mainText (大): 中央に大きく
//   2. subText (小): mainText に対して placement 方向に配置
//      - "right" / "left" は **ベースライン揃え** で主テキストの右/左に寄せる
//        (= 「音」+「に乗せて」のように下端を揃える)
//      - "above" / "below" は主テキストの中央 X を共有して上下に置く
//
// 後から個別に位置・色・サイズ・アニメを調整できるよう、各 clip は独立した
// TextClip として scenario に乗る。
// =============================================================================

import { registerPosterTemplate } from "./registry.js";

const DEFAULT_PARAMS = Object.freeze({
  mainText: "音",
  subText: "に乗せて",
  placement: "right",          // "above" | "below" | "right" | "left"
  mainSizeRatio: 0.4,          // canvasH に対する main の文字サイズ比
  subSizeRatio: 0.3,           // mainSize に対する sub の比率
  gapPx: 24,                   // mainText の bbox と subText の間隔
  mainColor: "#ffffff",
  subColor: "#ffe45a",
  outlineWidth: 6,
  outlineColor: "#000000",
  // ★ Phase 6: 役割別フォント。空 = defaultTelop (= telopDefaults.fontFamily) 継承
  mainFontFamily: "",
  subFontFamily: "",
});

const CONTROLS = [
  { key: "mainText", label: "主テキスト", type: "text" },
  { key: "subText",  label: "添えるテキスト", type: "text" },
  {
    key: "placement", label: "添え位置", type: "select",
    options: [
      { value: "right", label: "右 (ベースライン揃え)" },
      { value: "left",  label: "左 (ベースライン揃え)" },
      { value: "above", label: "上" },
      { value: "below", label: "下" },
    ],
  },
  { key: "mainSizeRatio", label: "主サイズ (画面高比)", type: "number", min: 0.1, max: 0.9, step: 0.02 },
  { key: "subSizeRatio",  label: "添えサイズ (主比)",   type: "number", min: 0.1, max: 0.8, step: 0.02 },
  { key: "gapPx",         label: "間隔 (px)",          type: "number", min: 0, max: 200, step: 4 },
  { key: "mainColor",     label: "主の文字色",          type: "color" },
  { key: "subColor",      label: "添えの文字色",        type: "color" },
  { key: "mainFontFamily", label: "主の書体",           type: "fontFamily" },
  { key: "subFontFamily",  label: "添えの書体",         type: "fontFamily" },
  { key: "outlineWidth",  label: "アウトライン太さ",    type: "number", min: 0, max: 30, step: 1 },
  { key: "outlineColor",  label: "アウトライン色",      type: "color" },
];

registerPosterTemplate({
  id: "kanji_kana_pair",
  label: "漢字＋かな",
  description: "主テキストに小さな添えテキストを寄せる組み合わせ。右/左はベースライン揃え。",
  defaultParams: { ...DEFAULT_PARAMS },
  controls: CONTROLS,
  generate(params, ctx) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const canvasW = Number(ctx?.canvasW) || 1920;
    const canvasH = Number(ctx?.canvasH) || 1080;
    const mainSize = Math.max(24, canvasH * p.mainSizeRatio);
    const subSize = Math.max(12, mainSize * p.subSizeRatio);
    const gap = Math.max(0, Number(p.gapPx) || 0);
    // bbox サイズの実測は generate 時にできない (canvas 計測コンテキスト無し) ので、
    // 経験則で main 1 グリフあたり mainSize 幅程度として代用。日本語想定なので
    // 1〜3 グリフの主テキストが普通。実 bbox はユーザーが個別調整できる。
    const mainTextLen = Math.max(1, Array.from(String(p.mainText || "")).length);
    const subTextLen = Math.max(1, Array.from(String(p.subText || "")).length);
    const mainBoxW = mainSize * mainTextLen * 1.05 + 16 * 2;
    const mainBoxH = mainSize * 1.3 + 16 * 2;
    const subBoxW = subSize * subTextLen * 1.05 + 12 * 2;
    const subBoxH = subSize * 1.3 + 12 * 2;

    // main は中央。
    const mainX = Math.round((canvasW - mainBoxW) / 2);
    const mainY = Math.round((canvasH - mainBoxH) / 2);

    // sub の配置: main に対して上/下/左/右に寄せる。
    //   above / below: 主テキストの中央 X を共有して上下に置く
    //   right / left: **ベースライン揃え** (= box の下端を揃えて) で主の右/左に置く。
    //                 「音」+「に乗せて」のような添え方が綺麗に見える。
    let subX = Math.round((canvasW - subBoxW) / 2);
    let subY = mainY;
    if (p.placement === "above") {
      subY = mainY - subBoxH - gap;
    } else if (p.placement === "below") {
      subY = mainY + mainBoxH + gap;
    } else if (p.placement === "right") {
      subX = mainX + mainBoxW + gap;
      subY = mainY + mainBoxH - subBoxH;          // 下端 (= ベースライン近似) 揃え
    } else if (p.placement === "left") {
      subX = mainX - subBoxW - gap;
      subY = mainY + mainBoxH - subBoxH;          // 下端揃え
    }

    const mainStyle = {
      fontSize: Math.round(mainSize),
      color: p.mainColor,
      outlineColor: p.outlineColor,
      outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
      align: "center",
    };
    if (p.mainFontFamily) mainStyle.fontFamily = String(p.mainFontFamily);
    const subStyle = {
      fontSize: Math.round(subSize),
      color: p.subColor,
      outlineColor: p.outlineColor,
      outlineWidth: Math.max(0, Number(p.outlineWidth) || 0),
      align: "center",
    };
    if (p.subFontFamily) subStyle.fontFamily = String(p.subFontFamily);

    return [
      {
        text: String(p.mainText || ""),
        position: "custom",
        x: mainX,
        y: mainY,
        style: mainStyle,
        kind: "mv_text",
        role: "main",
      },
      {
        text: String(p.subText || ""),
        position: "custom",
        x: subX,
        y: subY,
        style: subStyle,
        kind: "mv_text",
        role: "sub",
      },
    ];
  },
});
