// =============================================================================
// マルチキャラレイアウト (B-4)
//
// applyCharacterLayout(pattern, slotAssignments, border) で各キャラに crop +
// layoutSlot を設定し、x/y/scale を slot 中央フィットで再計算する。
// clearCharacterLayout() で cut.state.characterLayout と各キャラの crop /
// layoutSlot を解除する。
// =============================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { selectedCharacter, resolveCharacterLayerWidth } from "./character.js";
import { handleEditorChanged } from "./scenario-actions.js";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// scene-builder の _computeSlotRects と同期。1920×1080 座標系の slot 矩形。
function _computeSlotRects(pattern) {
  switch (pattern) {
    case "vertical_2": return [
      { x: 0, y: 0, w: CANVAS_W / 2, h: CANVAS_H },
      { x: CANVAS_W / 2, y: 0, w: CANVAS_W / 2, h: CANVAS_H },
    ];
    case "vertical_3": return [0, 1, 2].map((i) => ({
      x: (CANVAS_W / 3) * i, y: 0, w: CANVAS_W / 3, h: CANVAS_H,
    }));
    case "vertical_4": return [0, 1, 2, 3].map((i) => ({
      x: (CANVAS_W / 4) * i, y: 0, w: CANVAS_W / 4, h: CANVAS_H,
    }));
    case "horizontal_2": return [
      { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H / 2 },
      { x: 0, y: CANVAS_H / 2, w: CANVAS_W, h: CANVAS_H / 2 },
    ];
    case "horizontal_3": return [0, 1, 2].map((i) => ({
      x: 0, y: (CANVAS_H / 3) * i, w: CANVAS_W, h: CANVAS_H / 3,
    }));
    case "horizontal_4": return [0, 1, 2, 3].map((i) => ({
      x: 0, y: (CANVAS_H / 4) * i, w: CANVAS_W, h: CANVAS_H / 4,
    }));
    case "grid_2x2": return [
      { x: 0, y: 0, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: CANVAS_W / 2, y: 0, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: 0, y: CANVAS_H / 2, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: CANVAS_W / 2, y: CANVAS_H / 2, w: CANVAS_W / 2, h: CANVAS_H / 2 },
    ];
    case "t_top": return [
      { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H / 2 },
      { x: 0, y: CANVAS_H / 2, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: CANVAS_W / 2, y: CANVAS_H / 2, w: CANVAS_W / 2, h: CANVAS_H / 2 },
    ];
    case "t_bottom": return [
      { x: 0, y: 0, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: CANVAS_W / 2, y: 0, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: 0, y: CANVAS_H / 2, w: CANVAS_W, h: CANVAS_H / 2 },
    ];
    case "l_left": return [
      { x: 0, y: 0, w: CANVAS_W / 2, h: CANVAS_H },
      { x: CANVAS_W / 2, y: 0, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: CANVAS_W / 2, y: CANVAS_H / 2, w: CANVAS_W / 2, h: CANVAS_H / 2 },
    ];
    case "l_right": return [
      { x: 0, y: 0, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: 0, y: CANVAS_H / 2, w: CANVAS_W / 2, h: CANVAS_H / 2 },
      { x: CANVAS_W / 2, y: 0, w: CANVAS_W / 2, h: CANVAS_H },
    ];
    default: return [];
  }
}

// キャラの layerWidth/layerHeight を解決する。state.characterLayerSizes に
// あればそれを使い、無ければ resolveCharacterLayerWidth で base 画像をロード
// (layerWidth) + naturalHeight も別経路で同期取得。
async function _resolveCharacterLayerSize(character) {
  const cached = state.characterLayerSizes?.get(character.id);
  if (cached?.width && cached?.height) return { width: cached.width, height: cached.height };
  // layerWidth だけは resolveCharacterLayerWidth が cache を埋めてくれる
  await resolveCharacterLayerWidth(character);
  const after = state.characterLayerSizes?.get(character.id);
  if (after?.width && after?.height) return { width: after.width, height: after.height };
  // フォールバック: 既定サイズ
  return { width: 1024, height: 1536 };
}

// scale を slot 高さに合わせて算出 (0.85 で少し余白を取る)。
const FIT_RATIO = 0.85;

// 1 キャラを slot にフィットさせる位置 + サイズを計算する。
//   - scale = 0.85 × slot_h / layerHeight
//   - x = slot 中央水平 - (layerWidth * scale) / 2
//   - y = slot 中央垂直 - (layerHeight * scale) / 2
function _computeFitTransform(layerSize, slotRect) {
  const scale = (FIT_RATIO * slotRect.h) / layerSize.height;
  const w = layerSize.width * scale;
  const h = layerSize.height * scale;
  const x = slotRect.x + (slotRect.w - w) / 2;
  const y = slotRect.y + (slotRect.h - h) / 2;
  return {
    x: Math.round(x),
    y: Math.round(y),
    scale: Math.round(scale * 1000) / 1000,
  };
}

function _activeCut() {
  const cuts = state.scenario?.cuts || [];
  return cuts.find((c) => c.id === state.selectedCutId) || null;
}

// 「キャラを配置」ダイアログから呼ばれる。pattern / slotAssignments / border を
// 反映して cut.state.characterLayout を書き込み、各キャラに crop / layoutSlot を
// 設定する。autoFit=true (= 既定) なら x/y/scale も slot 中央フィットで再計算する。
// autoFit=false なら crop / layoutSlot だけ更新し、各キャラの x/y/scale は維持する
// (ボーダーやスロット番号だけ調整したい用途)。
export async function applyCharacterLayout({ pattern, slotAssignments, border, autoFit = true }) {
  const cut = _activeCut();
  if (!cut) throw new Error("カットが選択されていません");
  const slotRects = _computeSlotRects(pattern);
  if (slotRects.length === 0) throw new Error(`未知のパターン: ${pattern}`);
  if (slotAssignments.length !== slotRects.length) {
    throw new Error(`スロット数 ${slotRects.length} とキャラ数 ${slotAssignments.length} が不一致`);
  }

  const characters = state.currentCharacters || [];
  // characters を id -> character map に
  const byId = new Map(characters.map((c) => [c.id, c]));

  // 各 slot に紐付けられたキャラを配置。autoFit=true なら scale + x/y を再計算、
  // autoFit=false なら crop / layoutSlot だけ更新して x/y/scale は touched しない。
  for (let slotIndex = 0; slotIndex < slotRects.length; slotIndex += 1) {
    const characterId = slotAssignments[slotIndex];
    const character = byId.get(characterId);
    if (!character) continue;
    const slot = slotRects[slotIndex];
    character.layoutSlot = slotIndex;
    character.crop = { x: slot.x, y: slot.y, width: slot.w, height: slot.h };
    if (autoFit) {
      const layerSize = await _resolveCharacterLayerSize(character);
      const fit = _computeFitTransform(layerSize, slot);
      character.character = {
        ...(character.character || {}),
        x: fit.x,
        y: fit.y,
        scale: fit.scale,
      };
    }
  }

  // cut.state.characterLayout を書き込む
  cut.state = cut.state || {};
  cut.state.characterLayout = {
    pattern,
    border: {
      width: Math.max(0, Number(border?.width) || 0),
      color: border?.color || "#ffffff",
      includeOuter: !!border?.includeOuter,
    },
  };

  // 現在編集中のキャラの UI を最新値で更新 (X/Y/拡大率入力)
  const editing = selectedCharacter();
  if (editing && elements.characterX && elements.characterY && elements.characterScale) {
    elements.characterX.value = Math.round(editing.character?.x ?? 0);
    elements.characterY.value = Math.round(editing.character?.y ?? 0);
    elements.characterScale.value = String(editing.character?.scale ?? 1);
  }

  // 通常の変更検知経路を踏ませて save + render を更新する。
  handleEditorChanged();
}

// レイアウト解除: cut.state.characterLayout と各キャラの crop / layoutSlot を消す。
// x/y/scale はユーザの自由配置に任せるためそのまま保持する。
export function clearCharacterLayout() {
  const cut = _activeCut();
  if (!cut) return;
  if (cut.state) cut.state.characterLayout = null;
  for (const character of state.currentCharacters || []) {
    character.crop = null;
    character.layoutSlot = null;
  }
  handleEditorChanged();
}

// スロット交換: slotIndex を変更したいキャラ id だけを受け取り、対応する slot
// にフィット再計算する (= pattern と border は変更しない)。
// 主にダイアログ外からの「奥のキャラを別のスロットに差し替えたい」操作を想定。
export async function moveCharacterToSlot(characterId, slotIndex) {
  const cut = _activeCut();
  const layout = cut?.state?.characterLayout;
  if (!cut || !layout) throw new Error("レイアウト未設定のカットです");
  const slotRects = _computeSlotRects(layout.pattern);
  if (slotIndex < 0 || slotIndex >= slotRects.length) {
    throw new Error(`スロット index 範囲外: ${slotIndex}`);
  }
  const character = (state.currentCharacters || []).find((c) => c.id === characterId);
  if (!character) throw new Error(`キャラが見つかりません: ${characterId}`);
  const slot = slotRects[slotIndex];
  const layerSize = await _resolveCharacterLayerSize(character);
  const fit = _computeFitTransform(layerSize, slot);
  character.layoutSlot = slotIndex;
  character.crop = { x: slot.x, y: slot.y, width: slot.w, height: slot.h };
  character.character = {
    ...(character.character || {}),
    x: fit.x,
    y: fit.y,
    scale: fit.scale,
  };
  handleEditorChanged();
}
