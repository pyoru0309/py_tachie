// =============================================================================
// renderer/text-vertical.js
//
// テロップ縦書きの「文字分類・縦書き代替グリフ (GSUB vert)・縦レイアウト」層。
//
// Canvas2D に縦書き API は無いので、1 文字ずつ自前でレイアウトする。
// 文字は 3 通りの描き方に分かれる:
//
//   1. 正立 (upright)      … 漢字・仮名・全角英数など。fillText をそのまま使う
//                            (フォントの vert feature も正立文字には置換を持たない)。
//   2. GSUB vert 代替字形   … 句読点 (、。) / 括弧類 / 長音 (ー) / 小書き仮名など。
//                            サーバ (/api/fonts/vertical-glyphs, fontTools) から
//                            フォント自身の縦書き用グリフ輪郭 (SVG path) を取得し、
//                            Path2D で描く。フォントデザイナーの意図した縦書き字形。
//   3. フォールバック変換    … vert を持たないフォント (ピクセルフォント等) や
//                            取得完了前。UAX #50 (Unicode Vertical Text Layout) の
//                            Vertical_Orientation を近似した分類で、回転 (R) /
//                            右上シフト (Tu 近似) / 正立 (U) に振り分ける。
//
// グリフストアは (familyId, weightId) 単位でモジュールキャッシュし、取得完了で
// verticalGlyphsEpoch が進む。text-clip-draw の静的キャッシュ fingerprint に
// epoch を含めることで「フォールバック描画 → 本物の vert 字形」への再焼きを保証する。
// =============================================================================

import { state } from "../state.js";

// ---------------------------------------------------------------------------
// 文字分類 (UAX #50 近似)
// ---------------------------------------------------------------------------

// 右上へ移動する句読点 (UAX #50 では Tu = transformed-upright)
const PUNCT_SHIFT_CHARS = new Set(["、", "。", "，", "．"]);

// 小書き仮名: フォントに vert 置換が無い場合は右上へ僅かにシフトして組版慣行に寄せる
const SMALL_KANA_CHARS = new Set(
  "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ".split(""),
);

// 90° 回転する記号 (UAX #50 では R / Tr)。括弧・ダッシュ・長音など。
const ROTATE_CHARS = new Set([
  "ー", "ｰ", "〜", "～", "…", "‥", "―", "—", "–", "‐", "−",
  "「", "」", "『", "』", "（", "）", "(", ")", "［", "］", "[", "]",
  "｛", "｝", "{", "}", "〈", "〉", "《", "》", "【", "】", "〔", "〕",
  "〖", "〗", "〘", "〙", "｟", "｠", "＜", "＞", "<", ">",
  "＝", "=", "＿", "_", "：", ":", "；", ";", "→", "←",
]);

// 縦書きセルでの描き方分類。
//   "upright"  … そのまま正立
//   "rotate"   … 90° 時計回り回転 (欧文・括弧・長音などのフォールバック)
//   "punct"    … 右上シフト (、。のフォールバック)
//   "small"    … 僅かに右上シフト (小書き仮名のフォールバック)
export function classifyVertical(grapheme) {
  const ch = grapheme || "";
  if (PUNCT_SHIFT_CHARS.has(ch)) return "punct";
  if (SMALL_KANA_CHARS.has(ch)) return "small";
  if (ROTATE_CHARS.has(ch)) return "rotate";
  const cp = ch.codePointAt(0) || 0;
  // ASCII / Latin-1 / 拡張ラテン / 一般句読点あたりは横倒し (UAX#50 vo=R)。
  // 全角形 (FF01-FF60) と半角カナ (FF61-FF9F) は正立 (vo=U)。
  if (cp >= 0x0020 && cp <= 0x02af) return "rotate";
  if (cp >= 0x2000 && cp <= 0x206f) return "rotate";
  return "upright";
}

// フォントに vert 置換が無いときのフォールバック移動量 (em)。
// 、。は「em ボックス左下 → 右上」への移動 (実フォントの vert 字形の実測に合わせ
// 約 0.6em)。小書き仮名は組版慣行の「右上に僅かに寄せる」近似。
export const PUNCT_FALLBACK_SHIFT_EM = 0.6;
export const SMALL_KANA_FALLBACK_SHIFT_EM = 0.1;

// ---------------------------------------------------------------------------
// GSUB vert グリフストア
// ---------------------------------------------------------------------------

// (familyId::weightId) → {
//   status: "ready" | "unavailable",   // fetch 済みか (unavailable = フォント解決不可)
//   upem, emAscent, emDescent,
//   glyphs: Map(ch → {path: Path2D, vAdvEm, hAdvEm} | null),  // null = 置換なし確認済み
//   requested: Set(ch),                // 取得要求済み文字 (in-flight 含む)
// }
const _stores = new Map();
let _epoch = 0;

export function verticalGlyphsEpoch() {
  return _epoch;
}

function _storeKey(familyId, weightId) {
  return `${familyId || ""}::${weightId || "regular"}`;
}

function _getOrCreateStore(familyId, weightId) {
  const key = _storeKey(familyId, weightId);
  let store = _stores.get(key);
  if (!store) {
    store = {
      status: "pending",
      upem: 1000,
      emAscent: 0.88,
      emDescent: 0.12,
      glyphs: new Map(),
      requested: new Set(),
    };
    _stores.set(key, store);
  }
  return store;
}

// 描画時の同期参照。まだ何も取得していなければ null 相当の空ストアが返る。
export function getVerticalStore(familyId, weightId) {
  return _stores.get(_storeKey(familyId, weightId)) || null;
}

// text 中の「vert 置換があり得る文字」(= 正立分類以外) をサーバへ問い合わせ、
// ストアへ取り込む。取得済み文字はスキップ。新規グリフが増えたら epoch を進める。
export async function ensureVerticalGlyphs(familyId, weightId, text) {
  if (!familyId || !text) return;
  const store = _getOrCreateStore(familyId, weightId);
  if (store.status === "unavailable") return;
  const wanted = [];
  for (const ch of new Set(Array.from(String(text)))) {
    if (/\s/.test(ch)) continue;
    if (classifyVertical(ch) === "upright") continue;
    if (store.requested.has(ch)) continue;
    store.requested.add(ch);
    wanted.push(ch);
  }
  if (wanted.length === 0) return;
  try {
    const res = await fetch("/api/fonts/vertical-glyphs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: state.activeProjectId || state.manifest?.projectId || "",
        fontFamily: familyId,
        fontWeight: weightId || "regular",
        chars: wanted.join(""),
      }),
    });
    if (!res.ok) throw new Error(`vertical-glyphs ${res.status}`);
    const data = await res.json();
    if (!data.available) {
      store.status = "unavailable";
      // 再試行できるように要求済みマークは戻す (プロジェクト切替等でフォントが
      // 解決可能になるケース)。
      for (const ch of wanted) store.requested.delete(ch);
      return;
    }
    store.status = "ready";
    store.upem = Number(data.upem) || 1000;
    store.emAscent = Number(data.emAscent) || 0.88;
    store.emDescent = Number(data.emDescent) || 0.12;
    let added = false;
    for (const ch of wanted) {
      const entry = data.glyphs?.[ch];
      if (entry && typeof entry.d === "string" && entry.d) {
        store.glyphs.set(ch, {
          path: new Path2D(entry.d),
          vAdvEm: Number(entry.vAdv) || 1,
          hAdvEm: Number(entry.hAdv) || 1,
        });
        added = true;
      } else {
        store.glyphs.set(ch, null); // 置換なし確認済み → フォールバック描画で確定
      }
    }
    if (added) _epoch += 1;
  } catch (err) {
    // ネットワーク失敗などは要求済みマークを戻して次の描画で再試行させる
    for (const ch of wanted) store.requested.delete(ch);
    console.warn("ensureVerticalGlyphs failed", err);
  }
}

// scene-builder / 書き出し用: telop 配列の縦書き分をまとめて事前取得する。
// buildTelops で await することで「書き出し 1 フレーム目からフォールバックでなく
// 本物の vert 字形で焼かれる」ことを保証する。
export async function ensureVerticalGlyphsForTelops(telops) {
  const byFont = new Map();
  for (const t of telops || []) {
    const style = t?.style || {};
    if (String(style.writingMode || "") !== "vertical") continue;
    const familyId = style.fontFamily || state.manifest?.config?.defaultFont || "";
    const weightId = String(style.fontWeight || "regular").toLowerCase();
    const key = _storeKey(familyId, weightId);
    const bucket = byFont.get(key) || { familyId, weightId, text: "" };
    bucket.text += String(t.text || "");
    byFont.set(key, bucket);
  }
  if (byFont.size === 0) return;
  await Promise.allSettled(
    Array.from(byFont.values(), (b) => ensureVerticalGlyphs(b.familyId, b.weightId, b.text)),
  );
}

// ---------------------------------------------------------------------------
// 縦レイアウト (1 カラム = 横書きの 1 行)
// ---------------------------------------------------------------------------

let _segmenter = null;
function _graphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    if (!_segmenter) _segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    return Array.from(_segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

// 1 カラムぶんの縦レイアウトを組む。ctx.font は呼び出し側で設定済みであること。
//
// options: { fontSize, letterSpacing (px), charKerning ({gapIndex: 1/1000em} | null), store }
// 返り値: {
//   glyphs: [{ text, y, advance, cls, wPx, entry, drawable }],
//   height,   // カラム総高さ (px)
// }
//   y       … カラム上端からセル上端までのオフセット
//   advance … セルの縦送り量 (px)
//   entry   … GSUB vert グリフ ({path, vAdvEm, hAdvEm}) or null
export function layoutTextColumn(ctx, text, options) {
  const { fontSize, letterSpacing = 0, charKerning = null, store = null } = options;
  const glyphs = [];
  let cursor = 0;
  const chars = _graphemes(String(text));
  for (let i = 0; i < chars.length; i += 1) {
    const chText = chars[i];
    if (i > 0) {
      cursor += letterSpacing;
      if (charKerning) {
        const delta = Number(charKerning[i - 1]);
        if (Number.isFinite(delta)) cursor += (delta / 1000) * fontSize;
      }
    }
    const isSpace = /^\s+$/.test(chText);
    const cls = isSpace ? "upright" : classifyVertical(chText);
    const wPx = ctx.measureText(chText).width;
    const entry = (!isSpace && store && store.glyphs.get(chText)) || null;
    let advance;
    if (isSpace) {
      // 空白は横書きの advance をそのまま縦送りに使う (全角空白 = 1em)
      advance = wPx;
    } else if (entry) {
      advance = entry.vAdvEm * fontSize;
    } else if (cls === "rotate") {
      // 回転文字は横幅ぶんが縦に伸びる
      advance = wPx;
    } else {
      // 正立 CJK は em ボックス送り。半角の正立記号も em セルに収める
      advance = fontSize;
    }
    glyphs.push({
      text: chText,
      y: cursor,
      advance,
      cls,
      wPx,
      entry,
      drawable: !isSpace,
    });
    cursor += advance;
  }
  return { glyphs, height: cursor };
}
