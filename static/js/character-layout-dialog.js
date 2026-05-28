// =============================================================================
// 「キャラを配置」ダイアログ (B-3)
//
// カット内のキャラに対して、分割パターン + ボーダー + スロット割り当てを一括設定する。
// 配置を実行すると B-4 の applyCharacterLayout を呼んで各キャラの crop / x / y /
// scale / layoutSlot を再計算する。
// =============================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { applyCharacterLayout, clearCharacterLayout } from "./character-layout.js";

// パターン ID → { label, slotCount, svg (subset of slot rects) }
// SVG viewBox は 1920×1080 のアスペクト比 (横長) で描画する。
const PATTERNS = {
  vertical_2: { label: "縦 2 分割", slotCount: 2 },
  vertical_3: { label: "縦 3 分割", slotCount: 3 },
  vertical_4: { label: "縦 4 分割", slotCount: 4 },
  horizontal_2: { label: "横 2 分割", slotCount: 2 },
  horizontal_3: { label: "横 3 分割", slotCount: 3 },
  horizontal_4: { label: "横 4 分割", slotCount: 4 },
  t_top: { label: "上 1 + 下 2", slotCount: 3 },
  t_bottom: { label: "上 2 + 下 1", slotCount: 3 },
  l_left: { label: "左 1 + 右 2", slotCount: 3 },
  l_right: { label: "左 2 + 右 1", slotCount: 3 },
  grid_2x2: { label: "田 (2×2)", slotCount: 4 },
};

// pattern → slot rect (0..192 × 0..108 = SVG 用に縮小した座標)。
// scene-builder の _computeSlotRects と同じレイアウト規則。
const SVG_W = 192;
const SVG_H = 108;

function _svgSlotRects(pattern) {
  const W = SVG_W;
  const H = SVG_H;
  switch (pattern) {
    case "vertical_2": return [
      { x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H },
    ];
    case "vertical_3": return [0, 1, 2].map((i) => ({ x: (W / 3) * i, y: 0, w: W / 3, h: H }));
    case "vertical_4": return [0, 1, 2, 3].map((i) => ({ x: (W / 4) * i, y: 0, w: W / 4, h: H }));
    case "horizontal_2": return [
      { x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 },
    ];
    case "horizontal_3": return [0, 1, 2].map((i) => ({ x: 0, y: (H / 3) * i, w: W, h: H / 3 }));
    case "horizontal_4": return [0, 1, 2, 3].map((i) => ({ x: 0, y: (H / 4) * i, w: W, h: H / 4 }));
    case "grid_2x2": return [
      { x: 0, y: 0, w: W / 2, h: H / 2 },
      { x: W / 2, y: 0, w: W / 2, h: H / 2 },
      { x: 0, y: H / 2, w: W / 2, h: H / 2 },
      { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
    ];
    case "t_top": return [
      { x: 0, y: 0, w: W, h: H / 2 },
      { x: 0, y: H / 2, w: W / 2, h: H / 2 },
      { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
    ];
    case "t_bottom": return [
      { x: 0, y: 0, w: W / 2, h: H / 2 },
      { x: W / 2, y: 0, w: W / 2, h: H / 2 },
      { x: 0, y: H / 2, w: W, h: H / 2 },
    ];
    case "l_left": return [
      { x: 0, y: 0, w: W / 2, h: H },
      { x: W / 2, y: 0, w: W / 2, h: H / 2 },
      { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
    ];
    case "l_right": return [
      { x: 0, y: 0, w: W / 2, h: H / 2 },
      { x: 0, y: H / 2, w: W / 2, h: H / 2 },
      { x: W / 2, y: 0, w: W / 2, h: H },
    ];
    default: return [];
  }
}

function _buildPatternSvg(pattern) {
  const rects = _svgSlotRects(pattern);
  const rectMarkup = rects
    .map((r) => `<rect class="layout-slot" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="2" />`)
    .join("");
  return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="xMidYMid meet">${rectMarkup}</svg>`;
}

// ダイアログ内の選択状態。配置実行までは scenario に書き戻さない。
const dialogState = {
  pattern: "",
  charCount: 0,
  slotAssignments: [],  // index = slotIndex, value = character.id
};

function _availablePatternsFor(charCount) {
  return Object.entries(PATTERNS)
    .filter(([, meta]) => meta.slotCount === charCount)
    .map(([id, meta]) => ({ id, ...meta }));
}

function _renderPatterns(charCount) {
  const host = elements.characterLayoutPatterns;
  if (!host) return;
  host.innerHTML = "";
  const patterns = _availablePatternsFor(charCount);
  if (patterns.length === 0) {
    host.innerHTML = `<p class="asset-hint">${charCount} キャラ用のパターンがありません。</p>`;
    return;
  }
  for (const p of patterns) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "character-layout-pattern";
    button.dataset.pattern = p.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.innerHTML = `${_buildPatternSvg(p.id)}<span class="pattern-label">${p.label}</span>`;
    button.addEventListener("click", () => _selectPattern(p.id));
    host.appendChild(button);
  }
  // デフォルト: 最初のパターン (= 多くの場合 vertical_n)
  _selectPattern(patterns[0].id);
}

function _selectPattern(pattern) {
  dialogState.pattern = pattern;
  const host = elements.characterLayoutPatterns;
  if (!host) return;
  host.querySelectorAll(".character-layout-pattern").forEach((btn) => {
    const selected = btn.dataset.pattern === pattern;
    btn.dataset.selected = selected ? "true" : "false";
    btn.setAttribute("aria-checked", selected ? "true" : "false");
  });
}

function _renderSlots(charCount) {
  const host = elements.characterLayoutSlots;
  if (!host) return;
  host.innerHTML = "";
  const characters = state.currentCharacters || [];
  // デフォルト割当: 配列順 (index 順) のキャラ id を slot 0 から順に。
  dialogState.slotAssignments = characters.slice(0, charCount).map((c) => c.id);

  for (let slotIndex = 0; slotIndex < charCount; slotIndex += 1) {
    const row = document.createElement("div");
    row.className = "character-layout-slot-row";

    const label = document.createElement("span");
    label.className = "slot-label";
    label.textContent = `スロット ${slotIndex + 1}`;
    row.appendChild(label);

    const select = document.createElement("select");
    for (const ch of characters) {
      const opt = document.createElement("option");
      opt.value = ch.id;
      opt.textContent = ch.name || ch.id;
      select.appendChild(opt);
    }
    select.value = dialogState.slotAssignments[slotIndex] || "";
    select.addEventListener("change", () => {
      dialogState.slotAssignments[slotIndex] = select.value;
    });
    row.appendChild(select);
    host.appendChild(row);
  }
}

function _readBorderSettings() {
  const enabled = !!elements.characterLayoutBorderEnabled?.checked;
  const width = Math.max(0, Number(elements.characterLayoutBorderWidth?.value) || 0);
  const color = elements.characterLayoutBorderColor?.value || "#ffffff";
  const includeOuter = !!elements.characterLayoutBorderIncludeOuter?.checked;
  return {
    width: enabled ? width : 0,
    color,
    includeOuter,
  };
}

export function openCharacterLayoutDialog() {
  const characters = state.currentCharacters || [];
  if (characters.length < 2) {
    showToast("カット内に 2 キャラ以上必要です", "error");
    return;
  }
  dialogState.charCount = characters.length;
  if (elements.characterLayoutCharCount) {
    elements.characterLayoutCharCount.textContent = String(characters.length);
  }

  // 既存 cut.state.characterLayout があれば、ダイアログ初期値を復元。
  const cut = state.scenario?.cuts?.find((c) => c.id === state.selectedCutId);
  const existing = cut?.state?.characterLayout;
  if (existing?.border) {
    elements.characterLayoutBorderEnabled.checked = (existing.border.width || 0) > 0;
    elements.characterLayoutBorderWidth.value = String(existing.border.width || 4);
    elements.characterLayoutBorderColor.value = existing.border.color || "#ffffff";
    elements.characterLayoutBorderIncludeOuter.checked = !!existing.border.includeOuter;
  } else {
    elements.characterLayoutBorderEnabled.checked = false;
    elements.characterLayoutBorderWidth.value = "4";
    elements.characterLayoutBorderColor.value = "#ffffff";
    elements.characterLayoutBorderIncludeOuter.checked = false;
  }

  _renderPatterns(characters.length);
  _renderSlots(characters.length);

  // 既存 pattern を尊重 (= 編集用に開いた場合)
  if (existing?.pattern && PATTERNS[existing.pattern]?.slotCount === characters.length) {
    _selectPattern(existing.pattern);
    // 既存スロット割当も復元
    const fromExisting = characters.map((c) => c).sort((a, b) => {
      const sa = Number.isInteger(a.layoutSlot) ? a.layoutSlot : 999;
      const sb = Number.isInteger(b.layoutSlot) ? b.layoutSlot : 999;
      return sa - sb;
    });
    dialogState.slotAssignments = fromExisting.slice(0, characters.length).map((c) => c.id);
    // select 表示も同期
    const rows = elements.characterLayoutSlots.querySelectorAll(".character-layout-slot-row select");
    rows.forEach((sel, idx) => { sel.value = dialogState.slotAssignments[idx] || ""; });
  }

  elements.characterLayoutDialog?.showModal();
}

function _closeCharacterLayoutDialog() {
  if (elements.characterLayoutDialog?.open) {
    elements.characterLayoutDialog.close();
  }
}

async function _onApply() {
  if (!dialogState.pattern) {
    showToast("分割パターンを選択してください", "error");
    return;
  }
  // slot に同じキャラが複数割り当てられていないかチェック
  const seen = new Set();
  for (const id of dialogState.slotAssignments) {
    if (!id) {
      showToast("すべてのスロットにキャラを割り当ててください", "error");
      return;
    }
    if (seen.has(id)) {
      showToast("同じキャラを複数のスロットに割り当てられません", "error");
      return;
    }
    seen.add(id);
  }
  try {
    await applyCharacterLayout({
      pattern: dialogState.pattern,
      slotAssignments: dialogState.slotAssignments,
      border: _readBorderSettings(),
      // 自動サイズ調整 OFF のとき: crop / layoutSlot / characterLayout は更新するが
      // 各キャラの x / y / scale は維持する。ボーダーやスロット番号だけ調整したい
      // ケース (= 拡大率を一度決めた後の微調整) で再計算を避ける。
      autoFit: !!elements.characterLayoutAutoFit?.checked,
    });
    _closeCharacterLayoutDialog();
    showToast("キャラを配置しました");
  } catch (error) {
    console.error(error);
    showToast(`配置に失敗しました: ${error?.message || error}`, "error");
  }
}

export function bindCharacterLayoutDialog() {
  if (!elements.characterLayoutDialog) return;
  elements.openCharacterLayoutButton?.addEventListener("click", () => {
    openCharacterLayoutDialog();
  });
  elements.characterLayoutApplyButton?.addEventListener("click", _onApply);
  elements.characterLayoutCancelButton?.addEventListener("click", () => {
    _closeCharacterLayoutDialog();
  });
  // 他のダイアログと挙動を揃えて、背景クリックでは閉じない (= modal 動作)。
  // 閉じるのはキャンセル / 配置を実行 / ESC のみ。
}

export { clearCharacterLayout };
