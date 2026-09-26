// キャラ単位の口パク (デュエット用ボーカル割り当て / 歌唱判定 MIDI) の共通ロジック。
//
// scene-bundle の `lipSyncByChar` ({ [キャラのインスタンス ID]: entry }) を 1 フレーム
// ぶんの `mouthKeyByChar` に変換する。preview (playback.js) と書き出し
// (export/export-session.js) の両方がここを使うので、口形の決め方は 1 箇所で済む
// (従来の音量口パク mouthKeyFromVolume は両ファイルに二重実装されている)。
//
// entry の形 (app/v2_export.py: compute_cut_lipsync_by_char):
//   { kind: "midi",  shapes: "--aaii..." }       1 文字 = PROJECT_FPS の 1 フレーム
//   { kind: "level", trackSrc, levels?: {url} }  キャラ専用ボーカル音源の音量
//
// このモジュールは依存ゼロ (renderer / export / preview のどこから import しても
// モジュールチェーンを引き込まない)。

export const LIPSYNC_SHAPE_FPS = 24;

// MIDI 口形文字 → scene-builder の mouth キー。
//   a/i/u/e/o = 母音口形 (lipA〜lipO) / n = 口閉じ (lipClosed) / - = 休符 (カット選択の口)
const SHAPE_CHAR_TO_KEY = {
  a: "a",
  i: "i",
  u: "u",
  e: "e",
  o: "o",
  n: "closed",
  "-": "default",
};

// 母音口形が絵に無いときの寄せ先。キャラの作り方 (口の枚数) に応じて自然に縮退する:
//   6 形 (あ/い/う/え/お/ん)   … そのまま
//   4 形 (あえ/い/うお/ん)     … 「あ/え」の口に lipA + lipE、「う/お」に lipU + lipO を立てる
//   3 形 (開け/半開け/閉じ)    … あ・え → 口開け (lipOpen)、い・う・お → 半開け (lipMid)
//   2 形 (開け/閉じ)           … 半開けが無いので い・う・お も口開けへ
// ん は常に lipClosed。最後はカット選択の口 (default)。
export const MOUTH_FALLBACKS = {
  a: ["a", "open", "mid"],
  e: ["e", "a", "open", "mid"],
  i: ["i", "mid", "e", "open"],
  u: ["u", "o", "mid", "open"],
  o: ["o", "u", "mid", "open"],
};

export const MOUTH_VOWEL_KEYS = ["a", "i", "u", "e", "o"];

// mouthTextures ({default, closed, mid, open, a?, i?, ...}) から key に対応する
// テクスチャを引く。母音キーだけ寄せ先を辿り、従来キー (open/mid/closed) の挙動は
// 変えない (mid が無いキャラは従来どおり default に倒れる)。
export function resolveMouthTexture(textures, key) {
  if (!textures) return null;
  const chain = MOUTH_FALLBACKS[key] || [key];
  for (const k of chain) {
    if (textures[k]) return textures[k];
  }
  return textures.default || textures.closed || null;
}

export function mouthKeyFromShapeChar(ch) {
  return SHAPE_CHAR_TO_KEY[ch] || "default";
}

// 口パクは characterAnimationFps (8/12/24) でコマ打ちする (目パチと同じ量子化)。
// cutLocalSec を anim fps で量子化してから 24fps の口形列を引く。
export function shapeIndexForTime(cutLocalSec, animationFps) {
  const fps = Number(animationFps) || 12;
  const quantized = Math.floor(Math.max(0, cutLocalSec) * fps + 1e-6) / fps;
  return Math.floor(quantized * LIPSYNC_SHAPE_FPS + 1e-6);
}

// 1 フレームぶんの mouthKeyByChar を作る。
//   levelForEntry(charId, entry) → 0..1 の音量 (null = 取れない)。kind="level" 用。
//   volumeToKey(volume) → "open"/"mid"/"default"。従来の mouthKeyFromVolume。
// lipSyncByChar が空なら null (= scene-builder は従来の「話者だけ口パク」)。
export function computeMouthKeyByChar(lipSyncByChar, shapeIndex, { levelForEntry, volumeToKey } = {}) {
  if (!lipSyncByChar || typeof lipSyncByChar !== "object") return null;
  const ids = Object.keys(lipSyncByChar);
  if (!ids.length) return null;
  const out = {};
  for (const charId of ids) {
    const entry = lipSyncByChar[charId];
    if (!entry) continue;
    if (entry.kind === "midi") {
      const shapes = typeof entry.shapes === "string" ? entry.shapes : "";
      const ch = shapeIndex >= 0 && shapeIndex < shapes.length ? shapes[shapeIndex] : "-";
      out[charId] = mouthKeyFromShapeChar(ch);
    } else if (entry.kind === "level") {
      const volume = levelForEntry ? levelForEntry(charId, entry) : null;
      out[charId] = volumeToKey ? volumeToKey(volume) : "default";
    }
  }
  return out;
}
