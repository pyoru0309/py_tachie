// ===========================================================================
// アセット定義の髪型プリセット編集ダイアログ
// (assets/characters/<id>/hairstyle_presets.json への CRUD)
// 髪型プリセットはアセット定義のみ。プロジェクト側で個別 override は持たず、
// cut.state.characters[].hairstylePresetId が直接ここの id を参照する。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy, migrateInDialogToasts } from "./toast.js";
import { fillCharacterAssetControls } from "./character.js";
import { selectedCharacter } from "./character.js";

let deps = {
  refreshManifest: async () => {},
};

function ensureDraftState() {
  if (!state.assetHairstylePresets) {
    state.assetHairstylePresets = {
      assetRoot: "",
      character: null,
      drafts: [],
      original: [],
    };
  }
  return state.assetHairstylePresets;
}

function isDirty() {
  const s = ensureDraftState();
  if (s.drafts.length !== s.original.length) return true;
  for (let i = 0; i < s.drafts.length; i++) {
    const a = s.drafts[i];
    const b = s.original[i];
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.baseId !== b.baseId ||
      a.bangsId !== b.bangsId ||
      a.backHairId !== b.backHairId ||
      !!a.isDefault !== !!b.isDefault
    )
      return true;
  }
  return false;
}

function makeIdFromName(name, existingIds) {
  const base = (name || "hairstyle").trim().replace(/\s+/g, "_") || "hairstyle";
  let id = base;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function selectOptions(items, currentId, emptyLabel) {
  const lines = [`<option value="">${emptyLabel}</option>`];
  for (const item of items || []) {
    const safeId = String(item.id || "").replace(/"/g, "&quot;");
    const safeName = String(item.name || item.id || "").replace(/</g, "&lt;");
    const sel = currentId === item.id ? " selected" : "";
    lines.push(`<option value="${safeId}"${sel}>${safeName}</option>`);
  }
  return lines.join("");
}

function renderPresets() {
  const root = elements.assetHairstylePresetsBody;
  if (!root) return;
  const s = ensureDraftState();
  const character = s.character || {};
  const bases = character.bases || [];
  const bangs = character.bangs || [];
  const backHairs = character.backHairs || [];
  root.innerHTML = "";
  if (!s.drafts.length) {
    const empty = document.createElement("div");
    empty.className = "asset-empty";
    empty.textContent = "髪型プリセットがありません。「髪型を追加」で作成してください。";
    root.append(empty);
    updateStatus();
    return;
  }
  for (let i = 0; i < s.drafts.length; i++) {
    const preset = s.drafts[i];
    const row = document.createElement("div");
    row.className = "asset-preset-row asset-hairstyle-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "asset-preset-name";
    nameInput.placeholder = "髪型名";
    nameInput.value = preset.name || "";
    nameInput.addEventListener("input", () => {
      preset.name = nameInput.value;
      updateStatus();
    });
    row.append(nameInput);

    const makeSelect = (key, items, emptyLabel) => {
      const sel = document.createElement("select");
      sel.className = "asset-preset-select";
      sel.innerHTML = selectOptions(items, preset[key] || "", emptyLabel);
      sel.addEventListener("change", () => {
        preset[key] = sel.value;
        updateStatus();
      });
      return sel;
    };
    row.append(makeSelect("baseId", bases, "(ベースなし)"));
    row.append(makeSelect("bangsId", bangs, "(前髪なし)"));
    row.append(makeSelect("backHairId", backHairs, "(後ろ髪なし)"));

    const defLabel = document.createElement("label");
    defLabel.className = "checkbox-row asset-preset-default";
    const defCb = document.createElement("input");
    defCb.type = "checkbox";
    defCb.checked = !!preset.isDefault;
    defCb.title = "新規キャラ追加時の既定髪型";
    defCb.addEventListener("change", () => {
      const desired = defCb.checked;
      preset.isDefault = desired;
      if (desired) {
        for (let j = 0; j < s.drafts.length; j++) {
          if (j !== i) s.drafts[j].isDefault = false;
        }
      }
      renderPresets();
    });
    const defText = document.createElement("span");
    defText.textContent = "デフォルト";
    defLabel.append(defCb, defText);
    row.append(defLabel);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-button danger asset-preset-delete";
    delBtn.title = "この髪型を削除";
    delBtn.innerHTML = '<span class="msym" aria-hidden="true">delete</span>';
    delBtn.addEventListener("click", () => {
      s.drafts.splice(i, 1);
      renderPresets();
    });
    row.append(delBtn);

    root.append(row);
  }
  updateStatus();
}

function updateStatus() {
  if (!elements.assetHairstylePresetsStatus) return;
  if (isDirty()) {
    elements.assetHairstylePresetsStatus.textContent = "未保存の変更があります";
  } else {
    elements.assetHairstylePresetsStatus.textContent = "";
  }
}

export async function openAssetHairstylePresets(assetRoot) {
  if (!assetRoot) return;
  let data;
  try {
    const r = await fetch(
      `/api/characters/hairstyle-presets?assetRoot=${encodeURIComponent(assetRoot)}`,
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || "アセット髪型プリセットの取得に失敗しました");
    }
    data = await r.json();
  } catch (error) {
    showToast(error.message || "アセット髪型プリセットの取得に失敗しました", "error");
    return;
  }
  const character = data.character || {};
  const presets = (data.presets || []).map((p) => ({
    id: p.id || "",
    name: p.name || "",
    baseId: p.baseId || "",
    bangsId: p.bangsId || "",
    backHairId: p.backHairId || "",
    isDefault: !!p.isDefault,
  }));
  state.assetHairstylePresets = {
    assetRoot,
    character,
    drafts: presets.map((p) => ({ ...p })),
    original: presets.map((p) => ({ ...p })),
  };
  if (elements.assetHairstylePresetsSubtitle) {
    elements.assetHairstylePresetsSubtitle.textContent = `${character.name || ""} (${character.id || ""}) — ${assetRoot}`;
  }
  renderPresets();
  if (typeof elements.assetHairstylePresetsDialog?.showModal === "function") {
    if (!elements.assetHairstylePresetsDialog.open) {
      elements.assetHairstylePresetsDialog.showModal();
    }
  } else {
    elements.assetHairstylePresetsDialog?.setAttribute("open", "");
  }
  migrateInDialogToasts();
}

function close() {
  if (elements.assetHairstylePresetsDialog?.open) {
    elements.assetHairstylePresetsDialog.close();
  }
}

function tryCancel() {
  if (isDirty() && !window.confirm("変更が保存されていません。破棄して閉じますか？")) {
    return;
  }
  close();
}

async function savePresets() {
  const s = ensureDraftState();
  const assetRoot = s.assetRoot;
  if (!assetRoot) return;
  const usedIds = new Set();
  for (const p of s.drafts) {
    if (p.id) usedIds.add(p.id);
  }
  for (const p of s.drafts) {
    if (!p.id) p.id = makeIdFromName(p.name, usedIds);
    usedIds.add(p.id);
  }
  try {
    const r = await fetch("/api/characters/hairstyle-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetRoot, presets: s.drafts }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "保存に失敗しました");
    showToast(`アセット髪型プリセットを保存しました (${(data.presets || []).length}件)`);
    s.original = (data.presets || []).map((p) => ({ ...p }));
    s.drafts = (data.presets || []).map((p) => ({ ...p }));
    // refresh は close より先に。dashboard 閉じる瞬間の DOM 更新タイミング対策。
    if (state.activeProjectId) {
      try {
        await deps.refreshManifest();
      } catch (_error) {}
      // 念押しで cut editor の髪型セレクタを直接再構築する
      try {
        fillCharacterAssetControls(selectedCharacter());
      } catch (_error) {}
    }
    close();
  } catch (error) {
    console.error(error);
    showToast(error.message || "保存に失敗しました", "error");
  }
}

export function bindAssetHairstylePresets(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  elements.assetHairstylePresetsAddButton?.addEventListener("click", () => {
    const s = ensureDraftState();
    const usedIds = new Set(s.drafts.map((p) => p.id).filter(Boolean));
    s.drafts.push({
      id: makeIdFromName(`hairstyle_${s.drafts.length + 1}`, usedIds),
      name: `髪型${s.drafts.length + 1}`,
      baseId: "",
      bangsId: "",
      backHairId: "",
      isDefault: false,
    });
    renderPresets();
  });
  elements.assetHairstylePresetsSaveButton?.addEventListener("click", () => {
    withBusy(elements.assetHairstylePresetsSaveButton, "保存中", savePresets).catch(
      (error) => console.error(error),
    );
  });
  elements.assetHairstylePresetsCancelButton?.addEventListener("click", () => {
    tryCancel();
  });
  elements.assetHairstylePresetsDialog?.addEventListener("cancel", (event) => {
    if (isDirty()) {
      event.preventDefault();
      tryCancel();
    }
  });
}
