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
  // 配列順: 指定フォント → 既知の日本語フォールバック → 汎用
  // 注: LINE Seed JP は CDN で常に読み込まれているため、フォールバックの先頭に置くと
  // 他フォントが未ロードの瞬間に LINE Seed JP に倒れて表示されてしまう。除外する。
  const fallback = [`"Noto Sans JP"`, `"Hiragino Sans"`, `"Yu Gothic"`, "sans-serif"];
  // PC インストール済みフォント (system): FontFace 登録はせず、OS が解決できる
  // family 名 (和名/英名の両方) を先頭に積む。ブラウザはインストール済み
  // フォント (Adobe Fonts のアクティベート含む) をローカル名で直接使える。
  if (Array.isArray(font?.cssFamilies) && font.cssFamilies.length > 0) {
    const names = font.cssFamilies.filter((n) => typeof n === "string" && n);
    if (names.length > 0) {
      return [...names.map((n) => `"${n}"`), ...fallback].join(", ");
    }
  }
  const displayName = font?.name || familyId || "";
  if (displayName && displayName !== "LINE Seed JP") {
    return [`"${displayName}"`, ...fallback].join(", ");
  }
  return [`"LINE Seed JP"`, ...fallback].join(", ");
}

// プロジェクト assets/ 内に実体がある書体を FontFace として登録し、
// canvas (テロップ・セリフ) が Python 側のレンダリングと一致するようにする。
export async function registerProjectFonts() {
  if (!window.FontFace || !state.manifest?.config?.fonts) return;
  state.registeredFontFaces = state.registeredFontFaces || new Set();
  const tasks = [];
  for (const font of state.manifest.config.fonts) {
    if (!font?.name || !font?.weights) continue;
    // PC インストール済みフォントは FontFace 登録不要 (OS がローカル名で解決する)
    if (font.system) continue;
    for (const [weightId, paths] of Object.entries(font.weights)) {
      const candidates = Array.isArray(paths) ? paths : [paths];
      tasks.push(registerFontFamilyWeight(font.name, weightId, candidates));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

// PC インストール済みフォントのスキャンは起動直後サーバ側でバックグラウンドに
// 走っている。初回 manifest 取得がスキャン完了より早いとフォント一覧に PC
// フォントが載らないので、ready を検知したら manifest を再取得して選択肢に
// 反映する (2 回目以降の起動はディスクキャッシュ即読みなので通常 1 周で済む)。
export function watchSystemFontsReady(refreshManifest) {
  const hasSystemFonts = () =>
    (state.manifest?.config?.fonts || []).some((font) => font.system);
  if (hasSystemFonts()) return;
  let attempts = 0;
  const poll = async () => {
    attempts += 1;
    try {
      const res = await fetch("/api/system-fonts");
      if (!res.ok) return;
      const data = await res.json();
      if (!data.enabled || data.status === "failed") return;
      if (data.status === "ready") {
        if (data.familyCount > 0 && !hasSystemFonts()) {
          await refreshManifest();
        }
        return;
      }
    } catch (_err) {
      // サーバ再起動中など。次のポーリングで追い付く。
    }
    if (attempts < 30) setTimeout(poll, 2000);
  };
  setTimeout(poll, 1500);
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
