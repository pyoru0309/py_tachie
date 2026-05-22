// 編集画面のキーボードショートカット定義と、入力イベントから正規化キー文字列を作る
// ユーティリティ。global_config.shortcuts でユーザーが編集できる。
//
// 役割の分担:
//   - ドキュメント全体 (app.js bindKeyboardShortcuts):
//       「全般」+「カット」+「テロップ (重なるテロップ上下)」を担当
//   - タイムライン canvas にフォーカスがある時 (timeline.js):
//       「全般」+「テロップ (フレーム移動・先頭/末尾合わせ)」+「再生ヘッド」を担当
//   どちらの dispatcher も resolveShortcutAction(event) で候補一覧を貰い、
//   自分が扱う action だけを順に試して、最初に成功したものを採用する。

import { state } from "./state.js";

// カテゴリ定義 (UI のセクション見出し兼)
export const SHORTCUT_CATEGORIES = [
  { id: "general", label: "全般" },
  { id: "cut", label: "カット編集" },
  { id: "telop", label: "テロップ編集" },
  { id: "soundEffect", label: "効果音編集" },
  { id: "videoLayer", label: "動画レイヤー編集" },
  { id: "playhead", label: "再生・タイムライン" },
];

// アクション定義。順序は UI 表示順を兼ねるので、同じ既定キーが衝突する場合
// 「先勝ち」になる順に並べる (canvas で ArrowLeft が複数候補に当たるとき
// telopMoveLeft → jumpToPrevTelop の順)。
export const SHORTCUT_ACTIONS = [
  // ---- 全般 ----
  { id: "togglePlay", label: "再生 / 停止", category: "general", default: "Space" },
  { id: "toggleLoopMode", label: "ループ再生を切替 (なし → カット → シーン)", category: "general", default: "R" },
  { id: "duplicateSelection", label: "選択を複製", category: "general", default: "Shift+D" },
  { id: "deleteSelection", label: "選択を削除", category: "general", default: "Backspace" },
  { id: "addCut", label: "カットを追加", category: "general", default: "N" },

  // ---- カット編集 ----
  { id: "prevCut", label: "前のカットへ", category: "cut", default: "ArrowLeft" },
  { id: "nextCut", label: "次のカットへ", category: "cut", default: "ArrowRight" },
  { id: "extendSelectionLeft", label: "選択を左へ広げる", category: "cut", default: "Shift+ArrowLeft" },
  { id: "extendSelectionRight", label: "選択を右へ広げる", category: "cut", default: "Shift+ArrowRight" },
  { id: "moveCutsLeft", label: "選択カットを前へ移動", category: "cut", default: "Alt+ArrowLeft" },
  { id: "moveCutsRight", label: "選択カットを後ろへ移動", category: "cut", default: "Alt+ArrowRight" },

  // ---- テロップ編集 ----
  { id: "selectPrevTelop", label: "前のテロップを選択", category: "telop", default: "ArrowUp" },
  { id: "selectNextTelop", label: "次のテロップを選択", category: "telop", default: "ArrowDown" },
  { id: "telopMoveLeft", label: "テロップを 1 フレーム前へ", category: "telop", default: "ArrowLeft" },
  { id: "telopMoveRight", label: "テロップを 1 フレーム後ろへ", category: "telop", default: "ArrowRight" },
  { id: "telopSnapStartToPlayhead", label: "テロップ先頭を再生位置に合わせる", category: "telop", default: "S" },
  { id: "telopSnapEndToPlayhead", label: "テロップ末尾を再生位置に合わせる", category: "telop", default: "E" },

  // ---- 効果音編集 ----
  // ↑↓ は SE 編集中だけ発火する。テロップと既定キーが被るが、editorTarget で
  // dispatch を分岐しているので衝突しない。
  { id: "selectPrevSoundEffect", label: "前の効果音を選択", category: "soundEffect", default: "ArrowUp" },
  { id: "selectNextSoundEffect", label: "次の効果音を選択", category: "soundEffect", default: "ArrowDown" },

  // ---- 動画レイヤー編集 ----
  // ↑↓ は動画レイヤー編集中だけ発火する (editorTarget="videoLayer" のとき)。
  { id: "selectPrevVideoLayer", label: "前の動画レイヤーを選択", category: "videoLayer", default: "ArrowUp" },
  { id: "selectNextVideoLayer", label: "次の動画レイヤーを選択", category: "videoLayer", default: "ArrowDown" },

  // ---- 再生・タイムライン ----
  { id: "playheadStepBack", label: "再生ヘッドを 1 フレーム前へ", category: "playhead", default: "Shift+ArrowLeft" },
  { id: "playheadStepForward", label: "再生ヘッドを 1 フレーム後ろへ", category: "playhead", default: "Shift+ArrowRight" },
  { id: "playheadJumpBack1Sec", label: "再生ヘッドを 1 秒前へ", category: "playhead", default: "Shift+Alt+ArrowLeft" },
  { id: "playheadJumpForward1Sec", label: "再生ヘッドを 1 秒後ろへ", category: "playhead", default: "Shift+Alt+ArrowRight" },
  { id: "playheadHome", label: "再生ヘッドを先頭へ", category: "playhead", default: "Home" },
  { id: "playheadEnd", label: "再生ヘッドを末尾へ", category: "playhead", default: "End" },
  { id: "jumpToPrevTelop", label: "前のテロップへ移動", category: "playhead", default: "ArrowLeft" },
  { id: "jumpToNextTelop", label: "次のテロップへ移動", category: "playhead", default: "ArrowRight" },
];

// 修飾キーの正規順 (eventToCanonicalKey と一致させる)。
// ここに無い文字列はメインキーとして末尾に置く。
const MODIFIER_ORDER = ["Meta", "Ctrl", "Alt", "Shift"];

// "Shift+Alt+ArrowLeft" のような文字列を、修飾キー順 Meta→Ctrl→Alt→Shift に
// 揃えた canonical 形式に変換する。defaults / ユーザ保存値 / イベント由来 のどれを
// 突き合わせても一致するようにするための正規化。
export function normalizeShortcut(value) {
  if (!value) return "";
  const parts = String(value).split("+").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const mods = [];
  const mains = [];
  for (const p of parts) {
    if (MODIFIER_ORDER.includes(p)) mods.push(p);
    else mains.push(p);
  }
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const main = mains[mains.length - 1] || "";
  if (!main) return "";
  // 同じ修飾キーが複数回書かれても 1 回に潰す
  const seen = new Set();
  const dedup = [];
  for (const m of mods) {
    if (seen.has(m)) continue;
    seen.add(m);
    dedup.push(m);
  }
  return [...dedup, main].join("+");
}

export function defaultShortcuts() {
  const out = {};
  for (const a of SHORTCUT_ACTIONS) out[a.id] = normalizeShortcut(a.default);
  return out;
}

export function userShortcuts() {
  const cfg = state.globalConfig?.config?.shortcuts;
  return (cfg && typeof cfg === "object") ? cfg : null;
}

export function shortcutFor(actionId) {
  const user = userShortcuts();
  if (user && Object.prototype.hasOwnProperty.call(user, actionId)) {
    const v = user[actionId];
    if (v == null || v === "") return "";
    return normalizeShortcut(v);
  }
  const def = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
  return normalizeShortcut(def?.default || "");
}

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

// KeyboardEvent → "Shift+Alt+ArrowLeft" / "Space" / "Delete" 等の正規形
export function eventToCanonicalKey(event) {
  const mods = [];
  if (event.metaKey) mods.push("Meta");
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  let main = event.key || "";
  // Space は event.key が " " (length 1)。先に Space 判定しないと
  // 次の `length === 1` 分岐で " ".toUpperCase() = " " となって Space に化けない。
  if (main === " " || event.code === "Space") {
    main = "Space";
  } else if (main.length === 1) {
    main = main.toUpperCase();
  }
  if (!main || main === "Process" || main === "Dead") {
    if (ARROW_KEYS.has(event.code)) main = event.code;
    else main = event.code || "";
  }
  if (!main) return "";
  return [...mods, main].join("+");
}

// 与えられた KeyboardEvent から「これに割当てられている action ID 群」を、
// SHORTCUT_ACTIONS の定義順で返す。複数候補に当たることがある (例: ArrowLeft が
// prevCut / telopMoveLeft / jumpToPrevTelop すべての default に割り当てられている)。
// 呼び出し側 (dispatcher) はこの順に試して、最初に成功したものを採用する。
export function resolveShortcutAction(event) {
  const canonical = eventToCanonicalKey(event);
  if (!canonical) return [];
  const matches = [];
  for (const action of SHORTCUT_ACTIONS) {
    if (shortcutFor(action.id) === canonical) {
      matches.push(action.id);
    }
  }
  return matches;
}

// 表示用ラベル ("Shift+ArrowLeft" → "Shift + ←")
export function shortcutLabel(value) {
  if (!value) return "なし";
  return value
    .split("+")
    .map((part) => {
      if (part === "ArrowLeft") return "←";
      if (part === "ArrowRight") return "→";
      if (part === "ArrowUp") return "↑";
      if (part === "ArrowDown") return "↓";
      if (part === "Space") return "Space";
      if (part === "Delete") return "Delete";
      if (part === "Backspace") return "Backspace";
      if (part === "Home") return "Home";
      if (part === "End") return "End";
      if (part === "Meta") return "Cmd";
      return part;
    })
    .join(" + ");
}
