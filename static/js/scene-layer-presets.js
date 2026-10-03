// =============================================================================
// scene-layer-presets.js
//
// 前景プリセット / 背景プリセット (演出タブ「背景・場面」)。
//   - 前景プリセット: 前景の 画像 / X / Y / 拡大率
//   - 背景プリセット: 背景の 画像 / X / Y / 拡大率 / ぼかし / 背景色 / 背景色の不透明度
// を名前付きで保存し、プルダウンで選ぶと編集中のカットへ流し込む。
//
// 前景と背景は**独立した 2 系統**。片方を保存・削除・適用しても、もう片方の
// プリセットやカットの値には触れない (サーバも kind 単位で置き換える)。
//
// 正本は projects/<id>/scene_layer_presets.json ({ foreground: [...], background: [...] })。
// manifest には sceneLayerPresets として同梱される。
// X / Y の null は cut.state と同じく「中央配置」を意味し、そのまま保持する。
// =============================================================================
import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { normalizeColorValue } from "./utils.js";
import { ensureSelectValue, setSwatchDisplay } from "./scenario-actions.js";

let deps = {
  handleEditorChanged: () => {},
};

export function bindSceneLayerPresets(injectedDeps = {}) {
  deps = { ...deps, ...injectedDeps };
}

// 系統ごとの UI 要素と「入力欄 ⇔ プリセット」の変換。
const KINDS = {
  foreground: {
    label: "前景",
    select: () => elements.foregroundPreset,
    name: () => elements.foregroundPresetName,
    saveButton: () => elements.saveForegroundPresetButton,
    deleteButton: () => elements.deleteForegroundPresetButton,
    image: () => elements.foreground,
    x: () => elements.foregroundX,
    y: () => elements.foregroundY,
    scale: () => elements.foregroundScale,
  },
  background: {
    label: "背景",
    select: () => elements.backgroundPreset,
    name: () => elements.backgroundPresetName,
    saveButton: () => elements.saveBackgroundPresetButton,
    deleteButton: () => elements.deleteBackgroundPresetButton,
    image: () => elements.background,
    x: () => elements.backgroundX,
    y: () => elements.backgroundY,
    scale: () => elements.backgroundScale,
  },
};

function presetsOf(kind) {
  const list = state.manifest?.sceneLayerPresets?.[kind];
  return Array.isArray(list) ? list : [];
}

function _numOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _scaleOrOne(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return 1;
  return Math.min(4, Math.max(0.05, n));
}

function _clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// 入力欄の現在値をプリセット形式で読み出す。
function readControls(kind) {
  const k = KINDS[kind];
  const values = {
    image: k.image()?.value || "",
    x: _numOrNull(k.x()?.value),
    y: _numOrNull(k.y()?.value),
    scale: _scaleOrOne(k.scale()?.value),
  };
  if (kind === "background") {
    values.blurPx = _clamp(elements.backgroundBlurPx?.value, 0, 200, 0);
    values.color = normalizeColorValue(elements.backgroundColor?.value || "#000000", "#000000").toLowerCase();
    values.colorOpacity = _clamp(elements.backgroundColorOpacity?.value, 0, 1, 0);
  }
  return values;
}

// プリセットの値を入力欄へ流し込む (表示ルールは loadCut と同じ: 中央 = 空欄 / 1.0 = 空欄)。
function writeControls(kind, preset) {
  const k = KINDS[kind];
  if (k.image()) ensureSelectValue(k.image(), preset.image || "");
  if (k.x()) k.x().value = preset.x == null ? "" : String(preset.x);
  if (k.y()) k.y().value = preset.y == null ? "" : String(preset.y);
  if (k.scale()) {
    const scale = _scaleOrOne(preset.scale);
    k.scale().value = scale === 1 ? "" : String(scale);
  }
  if (kind === "background") {
    if (elements.backgroundBlurPx) elements.backgroundBlurPx.value = String(_clamp(preset.blurPx, 0, 200, 0));
    if (elements.backgroundColor) {
      const color = normalizeColorValue(preset.color || "#000000", "#000000");
      elements.backgroundColor.value = color;
      setSwatchDisplay(elements.backgroundColorValue, color);
    }
    if (elements.backgroundColorOpacity) {
      elements.backgroundColorOpacity.value = String(_clamp(preset.colorOpacity, 0, 1, 0));
    }
  }
}

function sameNullableNumber(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) < 1e-6;
}

function matchesControls(kind, preset) {
  const cur = readControls(kind);
  if ((preset.image || "") !== cur.image) return false;
  if (!sameNullableNumber(preset.x, cur.x) || !sameNullableNumber(preset.y, cur.y)) return false;
  if (!sameNullableNumber(_scaleOrOne(preset.scale), cur.scale)) return false;
  if (kind === "background") {
    if (!sameNullableNumber(_clamp(preset.blurPx, 0, 200, 0), cur.blurPx)) return false;
    if (String(preset.color || "#000000").toLowerCase() !== cur.color) return false;
    if (!sameNullableNumber(_clamp(preset.colorOpacity, 0, 1, 0), cur.colorOpacity)) return false;
  }
  return true;
}

function basename(path) {
  const s = String(path || "");
  return s.slice(s.lastIndexOf("/") + 1);
}

function optionLabel(preset) {
  const image = preset.image ? basename(preset.image) : "画像なし";
  const pos = preset.x == null && preset.y == null
    ? "中央"
    : `X ${preset.x == null ? "中央" : Math.round(preset.x)} / Y ${preset.y == null ? "中央" : Math.round(preset.y)}`;
  return `${preset.name}（${image} / ${pos} / ×${_scaleOrOne(preset.scale)}）`;
}

// select を埋め直す。selectedId が候補にあればそれを、無ければ「現在の入力欄と
// 完全に一致するプリセット」を自動選択する (= カットを移っても今どれが当たって
// いるか分かる)。
export function fillSceneLayerPresets(kind, selectedId = null) {
  const k = KINDS[kind];
  const select = k?.select();
  if (!select) return;
  const presets = presetsOf(kind);
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "なし";
  select.append(none);
  for (const preset of presets) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = optionLabel(preset);
    select.append(opt);
  }
  let value = "";
  if (selectedId && presets.some((p) => p.id === selectedId)) {
    value = selectedId;
  } else {
    value = presets.find((p) => matchesControls(kind, p))?.id || "";
  }
  select.value = value;
  syncName(kind);
  updateButtons(kind);
}

export function fillAllSceneLayerPresets() {
  fillSceneLayerPresets("foreground");
  fillSceneLayerPresets("background");
}

function syncName(kind) {
  const k = KINDS[kind];
  const nameInput = k.name();
  if (!nameInput) return;
  const preset = presetsOf(kind).find((p) => p.id === k.select()?.value);
  nameInput.value = preset?.name || "";
}

function updateButtons(kind) {
  const k = KINDS[kind];
  const deleteButton = k.deleteButton();
  if (deleteButton) deleteButton.disabled = !k.select()?.value;
}

// select の change ハンドラ。選択したプリセットを入力欄へ流し込み、
// handleEditorChanged で cut.state 反映 + 保存 + 再描画 + 履歴記録する。
export function applySelectedSceneLayerPreset(kind) {
  const k = KINDS[kind];
  const presetId = k.select()?.value || "";
  syncName(kind);
  updateButtons(kind);
  if (!presetId || !state.selectedCutId) return;
  const preset = presetsOf(kind).find((p) => p.id === presetId);
  if (!preset) return;
  writeControls(kind, preset);
  deps.handleEditorChanged();
}

async function savePresetsToServer(kind, presets) {
  const response = await fetch("/api/scene-layer-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, presets }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  // 両系統が返るが、反映するのは保存した系統だけ (もう一方は手元の状態を保つ)。
  state.manifest.sceneLayerPresets = {
    ...(state.manifest.sceneLayerPresets || {}),
    [kind]: result.presets?.[kind] || [],
  };
  return state.manifest.sceneLayerPresets[kind];
}

export async function saveCurrentSceneLayerPreset(kind) {
  const k = KINDS[kind];
  const name = (k.name()?.value || "").trim() || `新規${k.label}`;
  // 選択中プリセットがあれば上書き、無ければ新規 ID を発行する。
  const selectedId = k.select()?.value || "";
  const id = selectedId || `${kind}_${Date.now()}`;
  const preset = { id, name, ...readControls(kind) };
  const presets = [...presetsOf(kind)];
  const index = presets.findIndex((p) => p.id === id);
  if (index >= 0) presets[index] = preset;
  else presets.push(preset);
  const saved = await savePresetsToServer(kind, presets);
  const persisted = saved.find((p) => p.id === id) || saved.find((p) => p.name === name);
  fillSceneLayerPresets(kind, persisted?.id || id);
  showToast(`${k.label}プリセットを保存しました`);
}

export async function deleteCurrentSceneLayerPreset(kind) {
  const k = KINDS[kind];
  const presetId = k.select()?.value || "";
  if (!presetId) return;
  await savePresetsToServer(kind, presetsOf(kind).filter((p) => p.id !== presetId));
  fillSceneLayerPresets(kind, "");
  showToast(`${k.label}プリセットを削除しました`);
}
