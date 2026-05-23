// ===========================================================================
// フォント関連: 表示名・ウェイト・CSS スタック・FontFace 登録
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { fillSelect } from "./utils.js";

export const FONT_WEIGHT_CSS = {
  thin: 100,
  extralight: 200,
  extra_light: 200,
  light: 300,
  demilight: 350,
  demi_light: 350,
  regular: 400,
  medium: 500,
  semibold: 600,
  semi_bold: 600,
  bold: 700,
  extrabold: 800,
  extra_bold: 800,
  black: 900,
};

export function fontDisplayName(fontId) {
  if (!fontId) return "";
  const item = (state.manifest?.config?.fonts || []).find((f) => f.id === fontId);
  return item?.name || fontId;
}

export function globalWeightLabel(weightId) {
  const item = (state.manifest.config.fontWeights || []).find((weight) => weight.id === weightId);
  return item?.name || weightId;
}

export function weightItemsForFamily(familyId) {
  const font = (state.manifest.config.fonts || []).find((item) => item.id === familyId);
  const weightIds = font?.weights ? Object.keys(font.weights) : [];
  const ids = weightIds.length > 0 ? weightIds : [state.manifest.config.defaultFontWeight || "regular"];
  return ids.map((id) => ({ id, name: globalWeightLabel(id) }));
}

export function fillFontWeights(preferredWeight) {
  const currentFamily = elements.fontFamily.value || state.manifest.config.defaultFont;
  const weights = weightItemsForFamily(currentFamily);
  fillSelect(elements.fontWeight, weights, false);
  const fallback = weights[0]?.id || "regular";
  const preferredExists = weights.some((item) => item.id === preferredWeight);
  elements.fontWeight.value = preferredExists ? preferredWeight : fallback;
}

export function fillDefaultFontWeights(preferredWeight) {
  const family = elements.defaultFontFamily.value || state.manifest.config.defaultFont;
  const font = (state.manifest.config.fonts || []).find((item) => item.id === family);
  const weightIds = font?.weights ? Object.keys(font.weights) : [];
  const ids = weightIds.length > 0 ? weightIds : [state.manifest.config.defaultFontWeight || "regular"];
  const items = ids.map((id) => ({ id, name: globalWeightLabel(id) }));
  fillSelect(elements.defaultFontWeight, items, false);
  const fallback = items[0]?.id || "regular";
  elements.defaultFontWeight.value = items.some((item) => item.id === preferredWeight) ? preferredWeight : fallback;
}

export function fillTelopDefaultFontWeights(preferredWeight) {
  if (!elements.telopDefaultFontWeight) return;
  const family = elements.telopDefaultFontFamily?.value || state.manifest.config.defaultFont;
  const font = (state.manifest.config.fonts || []).find((item) => item.id === family);
  const weightIds = font?.weights ? Object.keys(font.weights) : [];
  const ids = weightIds.length > 0 ? weightIds : [state.manifest.config.defaultFontWeight || "regular"];
  const items = ids.map((id) => ({ id, name: globalWeightLabel(id) }));
  fillSelect(elements.telopDefaultFontWeight, items, false);
  const fallback = items[0]?.id || "regular";
  elements.telopDefaultFontWeight.value =
    items.some((item) => item.id === preferredWeight) ? preferredWeight : fallback;
}

// 「書体が持つ weight」に丸めて CSS 数値 weight を返す。
//
// 背景: Pillow (`paths_for_weight`) は要求 weight が無いとき regular → medium →
//   bold → 先頭、の順でフォールバックして「実在するファイル」を返すので、合成
//   ボールドは発生しない。
//   ところが canvas2d はブラウザの `font-synthesis: weight` (既定 on) が効くため、
//   FontFace が weight=400 だけ登録された書体に対して `font: 700 ...` を渡すと、
//   ブラウザが weight=400 のグリフを **太らせて描画** してしまい、Pillow と
//   全く違う絵 (= 「潰れたボールド」) になる。
//
// 本関数は要求 weightId を「該当書体が持つ weight」に丸めてから CSS 数値 weight を
// 返す。FontFace 登録時の weight と一致させることで合成ボールドを起こさせない。
//
// 例: Dela Gothic One (weights={regular}) + weightId="bold" → "400"
//     Noto Sans JP   (weights={...bold,...}) + weightId="bold" → "700"
export function resolveFontWeightCss(familyId, weightId) {
  const font = (state.manifest?.config?.fonts || []).find((it) => it.id === familyId);
  const available = font?.weights ? Object.keys(font.weights) : [];
  let actual = weightId;
  if (!available.includes(weightId)) {
    if (available.includes("regular")) actual = "regular";
    else if (available.includes("medium")) actual = "medium";
    else if (available.includes("bold")) actual = "bold";
    else actual = available[0] || "regular";
  }
  return String(FONT_WEIGHT_CSS[actual] ?? 400);
}

export function fontFamilyCssStack(familyId) {
  const font = (state.manifest?.config?.fonts || []).find((item) => item.id === familyId);
  const displayName = font?.name || familyId || "";
  // 配列順: 指定フォント → 既知の日本語フォールバック → 汎用
  // 注: LINE Seed JP は CDN で常に読み込まれているため、フォールバックの先頭に置くと
  // 他フォントが未ロードの瞬間に LINE Seed JP に倒れて表示されてしまう。除外する。
  const fallback = [`"Noto Sans JP"`, `"Hiragino Sans"`, `"Yu Gothic"`, "sans-serif"];
  if (displayName && displayName !== "LINE Seed JP") {
    return [`"${displayName}"`, ...fallback].join(", ");
  }
  return [`"LINE Seed JP"`, ...fallback].join(", ");
}

// フォントロードの epoch カウンタ。document.fonts.ready が resolve した瞬間と、
// その後の loadingdone (= 追加 FontFace の load 完了) で increment する。
// telop / dialogue の offscreen キャッシュ fingerprint に含めることで、
// 「未ロード状態で焼かれたキャンバスがロード後に置換されない」事故を防ぐ。
// PNG 出力時に preview と違うフォントになっていた現象 (= cache hit で古い
// canvas2D texture を再利用) の根本対策。
let _fontsEpoch = 0;
let _fontsEpochSubscribed = false;

function _subscribeFontsEpoch() {
  if (_fontsEpochSubscribed) return;
  _fontsEpochSubscribed = true;
  if (!document?.fonts) return;
  // 初回ロード完了
  if (document.fonts.ready && typeof document.fonts.ready.then === "function") {
    document.fonts.ready.then(() => { _fontsEpoch += 1; }).catch(() => {});
  }
  // 追加ロード完了
  if (typeof document.fonts.addEventListener === "function") {
    document.fonts.addEventListener("loadingdone", () => { _fontsEpoch += 1; });
  }
}

export function getFontsEpoch() {
  _subscribeFontsEpoch();
  return _fontsEpoch;
}

// dialogue / telop が使う font を document.fonts.load() で明示的にロードする。
// document.fonts.ready は「現在登録されている全 face の load 完了」を待つが、
// 特定の (family, weight) が未登録のまま canvas2D で `ctx.font = 'bold 42px X'`
// を使うと、ブラウザはサイレントに fallback を選んで描画する。これがプレビューと
// PNG 出力で違うフォントになる経路の主因。
//
// 引数 layerData は scene-bundle の payload (dialogue / telops を含む)。
// 内部で必要な FontSpec をかき集めて Promise.all で load する。
export async function preloadSceneFonts(layerData) {
  if (!document?.fonts?.load) return;
  const specs = new Set();
  const add = (family, weight, size) => {
    const fam = family || "";
    if (!fam) return;
    const w = weight || 400;
    const sz = Math.max(8, Number(size) || 32);
    specs.add(`${w} ${sz}px "${fam}"`);
  };
  const dialogue = layerData?.dialogue?.raw;
  if (dialogue) {
    const family = dialogue.fontFamily || dialogue.style?.fontFamily;
    const weight = dialogue.fontWeightCss || dialogue.style?.fontWeightCss || 400;
    const size = dialogue.fontSize || dialogue.style?.fontSize;
    add(family, weight, size);
    if (dialogue.speaker) {
      add(family, weight, dialogue.speaker.fontSize);
    }
  }
  const telops = Array.isArray(layerData?.telops) ? layerData.telops : [];
  for (const t of telops) {
    const s = t?.style || {};
    add(s.fontFamily, s.fontWeightCss || 400, s.fontSize);
  }
  if (specs.size === 0) return;
  const tasks = [];
  for (const spec of specs) {
    try {
      tasks.push(document.fonts.load(spec));
    } catch (_err) {
      /* 無効 spec はスキップ */
    }
  }
  await Promise.allSettled(tasks);
}

// プロジェクト assets/ 内に実体がある書体を FontFace として登録し、
// canvas (テロップ・セリフ) が Python 側のレンダリングと一致するようにする。
export async function registerProjectFonts() {
  if (!window.FontFace || !state.manifest?.config?.fonts) return;
  state.registeredFontFaces = state.registeredFontFaces || new Set();
  const tasks = [];
  for (const font of state.manifest.config.fonts) {
    if (!font?.name || !font?.weights) continue;
    for (const [weightId, paths] of Object.entries(font.weights)) {
      const candidates = Array.isArray(paths) ? paths : [paths];
      tasks.push(registerFontFamilyWeight(font.name, weightId, candidates));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

// (font.name, weightId) ごとに candidates を順番に試し、最初に load() に
// 成功したものを document.fonts に登録する。Python 側の existing_font_path
// と同じ「実在する候補を採用」セマンティクス。
export async function registerFontFamilyWeight(name, weightId, candidates) {
  // assets/ 配下（共通素材）と projects/ 配下（プロジェクト固有）の両方を許可。
  // /assets は PROJECT_ROOT にマウントされているのでどちらも /assets/<path> で取得できる。
  const cssWeight = String(FONT_WEIGHT_CSS[weightId] ?? 400);
  for (const localPath of candidates) {
    if (typeof localPath !== "string") continue;
    if (!localPath.startsWith("assets/") && !localPath.startsWith("projects/")) continue;
    const url = `/assets/${localPath}`;
    const key = `${name}::${cssWeight}::${url}`;
    if (state.registeredFontFaces.has(key)) return;
    try {
      const face = new FontFace(name, `url(${url})`, { weight: cssWeight, style: "normal" });
      await face.load(); // 404 等はここで例外、次の候補に回す
      document.fonts.add(face);
      state.registeredFontFaces.add(key);
      return;
    } catch (_err) {
      // 候補が実在しない／読めない場合はサイレントで次へ。Python 側と挙動を揃える。
    }
  }
}
