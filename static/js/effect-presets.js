// =============================================================================
// effect-presets.js
//
// キャラの特殊効果 (オーラ / 雷 / 光の筋) のプリセット。お芝居タブの各効果欄の
// 「プリセット」行 (選択 / 名前 / 保存 / 削除)。
//
// キャラ・シーン・プロジェクトに依存しない共通データ (app_state/effect_presets.json、
// GET/POST /api/effect-presets)。3 系統は独立していて、保存は系統ごとに置き換える。
// プリセットの値はカットのキャラ設定の aura / lightning / streaks と同じ形。
//
// 選ぶと欄へ流し込み (効果も ON にする)、handleEditorChanged で編集中キャラへ反映
// + 保存 + 履歴記録する。保存先の決め方は preset-save-target.js (名前を変えたら別名で新規)。
// キャラ・カットを移ったときは、欄の値と全項目が一致するプリセットを自動選択する。
// =============================================================================
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { collectEffectControls, applyEffectControls } from "./character.js";
import { resolvePresetSaveTarget } from "./preset-save-target.js";

let deps = {
  handleEditorChanged: () => {},
};

const KINDS = {
  aura: { label: "オーラ", prefix: "Aura" },
  lightning: { label: "雷", prefix: "Lightning" },
  streaks: { label: "光の筋", prefix: "Streaks" },
};

let presets = { aura: [], lightning: [], streaks: [] };

const ui = (kind, name) => elements[`character${KINDS[kind].prefix}${name}`];

export function bindEffectPresets(injectedDeps = {}) {
  deps = { ...deps, ...injectedDeps };
  for (const kind of Object.keys(KINDS)) {
    ui(kind, "PresetSelect")?.addEventListener("change", () => applySelectedEffectPreset(kind));
    ui(kind, "PresetSaveButton")?.addEventListener("click", () => {
      saveCurrentEffectPreset(kind).catch((error) => showToast(error.message, "error"));
    });
    ui(kind, "PresetDeleteButton")?.addEventListener("click", () => {
      deleteCurrentEffectPreset(kind).catch((error) => showToast(error.message, "error"));
    });
  }
}

export async function loadEffectPresets() {
  try {
    const response = await fetch("/api/effect-presets");
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    presets = { aura: [], lightning: [], streaks: [], ...(data.presets || {}) };
  } catch (error) {
    console.warn("effect presets load failed", error);
  }
  for (const kind of Object.keys(KINDS)) fillEffectPresets(kind);
}

function sameValue(a, b) {
  if (typeof a === "number" || typeof b === "number") {
    return Math.abs(Number(a) - Number(b)) < 1e-3;
  }
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

// 欄の値がプリセットと一致するか (プリセット側にある項目だけを比べる)。
function matchesControls(kind, preset) {
  if (!ui(kind, "Enabled")?.checked) return false;
  const cur = collectEffectControls(kind) || {};
  return Object.entries(preset.values || {}).every(([key, value]) => key === "enabled" || sameValue(value, cur[key]));
}

export function fillEffectPresets(kind, selectedId = null) {
  const select = ui(kind, "PresetSelect");
  if (!select) return;
  const list = presets[kind] || [];
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "なし";
  select.append(none);
  for (const preset of list) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.name;
    select.append(opt);
  }
  select.value = selectedId && list.some((p) => p.id === selectedId)
    ? selectedId
    : (list.find((p) => matchesControls(kind, p))?.id || "");
  syncNameAndButtons(kind);
}

// キャラ・カット切替で欄が書き換わったあとに呼ぶ (一致するプリセットを選び直す)。
export function syncEffectPresetSelections() {
  for (const kind of Object.keys(KINDS)) fillEffectPresets(kind);
}

function syncNameAndButtons(kind) {
  const id = ui(kind, "PresetSelect")?.value || "";
  const preset = (presets[kind] || []).find((p) => p.id === id);
  const name = ui(kind, "PresetName");
  if (name) name.value = preset?.name || "";
  const del = ui(kind, "PresetDeleteButton");
  if (del) del.disabled = !preset;
}

function applySelectedEffectPreset(kind) {
  syncNameAndButtons(kind);
  const id = ui(kind, "PresetSelect")?.value || "";
  const preset = (presets[kind] || []).find((p) => p.id === id);
  if (!preset) return;
  applyEffectControls(kind, preset.values);
  deps.handleEditorChanged();
}

async function savePresetsToServer(kind, list) {
  const response = await fetch("/api/effect-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, presets: list }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  presets = { ...presets, [kind]: data.presets?.[kind] || [] };
  return presets[kind];
}

async function saveCurrentEffectPreset(kind) {
  const { label } = KINDS[kind];
  const list = [...(presets[kind] || [])];
  const target = await resolvePresetSaveTarget({
    presets: list,
    selectedId: ui(kind, "PresetSelect")?.value || "",
    name: ui(kind, "PresetName")?.value,
    fallbackName: label,
    newId: () => `${kind}_${Date.now()}`,
    label,
  });
  if (!target) return;
  const preset = { id: target.id, name: target.name, values: collectEffectControls(kind) };
  const index = list.findIndex((p) => p.id === target.id);
  if (index >= 0) list[index] = preset;
  else list.push(preset);
  const saved = await savePresetsToServer(kind, list);
  fillEffectPresets(kind, (saved.find((p) => p.id === target.id) || saved.find((p) => p.name === target.name))?.id || "");
  showToast(target.existing
    ? `${label}プリセット「${target.name}」を上書きしました`
    : `${label}プリセット「${target.name}」を新しく保存しました`);
}

async function deleteCurrentEffectPreset(kind) {
  const id = ui(kind, "PresetSelect")?.value || "";
  if (!id) return;
  const { label } = KINDS[kind];
  await savePresetsToServer(kind, (presets[kind] || []).filter((p) => p.id !== id));
  fillEffectPresets(kind, "");
  showToast(`${label}プリセットを削除しました`);
}
