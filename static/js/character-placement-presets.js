// =============================================================================
// character-placement-presets.js
//
// 配置プリセット: 編集中キャラ 1 体の「X / Y / 拡大率」を名前付きで保存し、
// 任意のカットの同じキャラへ適用する。
//
// 表情プリセット (expression_presets.json) とは**独立した系統**で、適用しても
// 表情・髪型・前面オブジェクトには一切触れない。逆に表情プリセットを切り替えても
// 配置は変わらない。
//
// 正本は projects/<id>/placement_presets.json (プロジェクト単位)。座標はその
// プロジェクトの構図設計に強く依存するので、共通アセット
// (assets/characters/<id>/) 側には持たせない。
//
// レコード形式: { id, name, characterId, x, y, scale }
//   characterId = キャラ**定義** ID (インスタンス ID ではない)。
// =============================================================================
import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { selectedCharacter } from "./character.js";

let deps = {
  handleEditorChanged: () => {},
};

export function bindPlacementPresets(injectedDeps = {}) {
  deps = { ...deps, ...injectedDeps };
}

function allPresets() {
  return Array.isArray(state.manifest?.placementPresets) ? state.manifest.placementPresets : [];
}

// 指定キャラクター定義に紐付く配置プリセットだけを返す。
export function placementPresetsForCharacter(characterId) {
  if (!characterId) return [];
  return allPresets().filter((item) => (item.characterId || "") === characterId);
}

function _numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _scaleOr(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return fallback;
  return Math.min(4, Math.max(0.05, n));
}

// 配置プリセット select を編集中キャラの候補で埋め直す。
// selectedId が候補にあればそれを選択、無ければ「現在の X/Y/拡大率 と一致する
// プリセット」を自動選択する (= カット移動しても「今どれが当たっているか」が分かる)。
export function fillPlacementPresets(selectedId = null) {
  const select = elements.placementPreset;
  if (!select) return;
  const character = selectedCharacter();
  const characterId = character?.characterId || "";
  const presets = placementPresetsForCharacter(characterId);
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "なし";
  select.append(none);
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.name}（X ${Math.round(preset.x)} / Y ${Math.round(preset.y)} / ×${preset.scale}）`;
    select.append(option);
  }
  let value = "";
  if (selectedId && presets.some((p) => p.id === selectedId)) {
    value = selectedId;
  } else {
    const curX = _numOr(elements.characterX?.value, NaN);
    const curY = _numOr(elements.characterY?.value, NaN);
    const curScale = _numOr(elements.characterScale?.value, NaN);
    const match = presets.find(
      (p) => Math.round(p.x) === Math.round(curX)
        && Math.round(p.y) === Math.round(curY)
        && Math.abs(p.scale - curScale) < 1e-6,
    );
    value = match?.id || "";
  }
  select.value = value;
  syncPlacementPresetName();
  updatePlacementPresetButtons();
}

export function syncPlacementPresetName() {
  if (!elements.placementPresetName) return;
  const character = selectedCharacter();
  const characterId = character?.characterId || "";
  const preset = placementPresetsForCharacter(characterId).find(
    (item) => item.id === elements.placementPreset?.value,
  );
  elements.placementPresetName.value = preset?.name || "";
}

export function updatePlacementPresetButtons() {
  const hasCharacter = Boolean(selectedCharacter());
  const presetId = elements.placementPreset?.value || "";
  if (elements.placementPreset) elements.placementPreset.disabled = !hasCharacter;
  if (elements.placementPresetName) elements.placementPresetName.disabled = !hasCharacter;
  if (elements.savePlacementPresetButton) elements.savePlacementPresetButton.disabled = !hasCharacter;
  if (elements.deletePlacementPresetButton) {
    elements.deletePlacementPresetButton.disabled = !hasCharacter || !presetId;
  }
}

// select の change ハンドラ。選択されたプリセットの X / Y / 拡大率 を入力欄へ流し込み、
// handleEditorChanged で cut.state へ反映 + 再描画させる。
export function applySelectedPlacementPreset() {
  const character = selectedCharacter();
  if (!character) return;
  const presetId = elements.placementPreset?.value || "";
  syncPlacementPresetName();
  updatePlacementPresetButtons();
  if (!presetId) return;
  const preset = placementPresetsForCharacter(character.characterId).find((p) => p.id === presetId);
  if (!preset) return;
  if (elements.characterX) elements.characterX.value = String(preset.x);
  if (elements.characterY) elements.characterY.value = String(preset.y);
  if (elements.characterScale) elements.characterScale.value = String(preset.scale);
  deps.handleEditorChanged();
}

async function savePresetsToServer(presets) {
  const response = await fetch("/api/placement-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presets }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  state.manifest.placementPresets = result.presets;
  return result.presets;
}

export async function saveCurrentPlacementPreset() {
  const character = selectedCharacter();
  if (!character) {
    showToast("登場キャラを追加してから配置プリセットを保存してください", "error");
    return;
  }
  const characterId = character.characterId || "";
  const name = (elements.placementPresetName?.value || "").trim() || "新規配置";
  // 選択中プリセットがあれば上書き、無ければ新規 ID を発行する。
  const selectedId = elements.placementPreset?.value || "";
  const id = selectedId || `placement_${Date.now()}`;
  const preset = {
    id,
    name,
    characterId,
    x: _numOr(elements.characterX?.value, 0),
    y: _numOr(elements.characterY?.value, 0),
    scale: _scaleOr(elements.characterScale?.value, 1),
  };
  const presets = [...allPresets()];
  const index = presets.findIndex(
    (item) => item.id === preset.id && (item.characterId || "") === characterId,
  );
  if (index >= 0) presets[index] = preset;
  else presets.push(preset);
  const saved = await savePresetsToServer(presets);
  // サーバ側で ID が衝突回避リネームされている可能性があるので、名前で拾い直す。
  const persisted = saved.find(
    (item) => (item.characterId || "") === characterId && item.name === name,
  );
  fillPlacementPresets(persisted?.id || preset.id);
  showToast("配置プリセットを保存しました");
}

export async function deleteCurrentPlacementPreset() {
  const character = selectedCharacter();
  if (!character) return;
  const presetId = elements.placementPreset?.value || "";
  if (!presetId) return;
  const characterId = character.characterId || "";
  const presets = allPresets().filter(
    (item) => item.id !== presetId || (item.characterId || "") !== characterId,
  );
  await savePresetsToServer(presets);
  fillPlacementPresets("");
  showToast("配置プリセットを削除しました");
}
