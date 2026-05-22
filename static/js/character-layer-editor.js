// ===========================================================================
// キャラクターレイヤーエディタ（ID リネーム / 削除のドラフト編集）
// refreshManifest / refreshAssetManager は asset / manifest 系が未モジュール化のため
// bindCharacterLayerEditor から依存性注入で受け取る。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy, migrateInDialogToasts } from "./toast.js";
import { openPsdImporter } from "./psd-importer.js";

const LAYER_CATEGORY_LABELS = {
  back_hair: "後ろ髪",
  base: "ベース",
  cheek: "頬",
  eye: "目",
  mouth: "口",
  bangs: "前髪",
  front: "前面",
};
const LAYER_MANIFEST_KEY = {
  back_hair: "backHairs",
  base: "bases",
  cheek: "cheeks",
  eye: "eyes",
  mouth: "mouths",
  bangs: "bangs",
  front: "fronts",
};
const LAYER_CATEGORY_ORDER = ["back_hair", "base", "cheek", "eye", "mouth", "bangs", "front"];

// 目パチ・口パクのフラグ。各カテゴリで UI に出すチェックボックスの並び。
// blinkHalf/blinkClosed/lipClosed/lipMid/lipOpen は manifest 全体で 1 枚のみ
// (排他)。blinkOpen は per-character 複数立てて OK。サーバ側 layers/save が
// 排他制約を強制適用する (UI もそれに追従)。
const FLAG_DEFS_BY_CATEGORY = {
  eye: [
    { key: "blinkOpen", label: "開き", suffix: "（開き）", exclusive: false },
    { key: "blinkHalf", label: "中間", suffix: "（中間）", exclusive: true },
    { key: "blinkClosed", label: "閉じ", suffix: "（閉じ）", exclusive: true },
  ],
  mouth: [
    { key: "lipOpen", label: "開き", suffix: "（開き）", exclusive: true },
    { key: "lipMid", label: "中間", suffix: "（中間）", exclusive: true },
    { key: "lipClosed", label: "閉じ", suffix: "（閉じ）", exclusive: true },
  ],
};

let deps = {
  refreshManifest: async () => {},
  refreshAssetManager: async () => {},
};

function layerKey(category, id) {
  return `${category}|${id}`;
}

function resetCharacterLayerEditorDraft() {
  state.characterLayerEditor.draftRenames = new Map();
  state.characterLayerEditor.draftDeletes = new Set();
  state.characterLayerEditor.draftFlags = new Map();
  state.characterLayerEditor.draftNames = new Map();
}

function characterLayerEditorHasDraftChanges() {
  return (
    (state.characterLayerEditor.draftRenames?.size || 0) > 0 ||
    (state.characterLayerEditor.draftDeletes?.size || 0) > 0 ||
    (state.characterLayerEditor.draftFlags?.size || 0) > 0 ||
    (state.characterLayerEditor.draftNames?.size || 0) > 0
  );
}

function entryFlags(entry) {
  const flags = entry?.flags;
  return flags && typeof flags === "object" ? flags : {};
}

// draft で上書きされていればそれを、無ければ manifest の現状を返す。
function effectiveFlags(category, entry) {
  const k = layerKey(category, entry.id);
  const draft = state.characterLayerEditor.draftFlags?.get(k);
  if (draft) return draft;
  return entryFlags(entry);
}

// draft に新フラグ集合を保存。manifest 既存値と一致するなら draft から消す。
function setDraftFlags(category, entry, nextFlags) {
  const k = layerKey(category, entry.id);
  const original = entryFlags(entry);
  const sameAsOriginal =
    Object.keys(original).length === Object.keys(nextFlags).length &&
    Object.keys(original).every((key) => !!original[key] === !!nextFlags[key]);
  if (sameAsOriginal) {
    state.characterLayerEditor.draftFlags.delete(k);
  } else {
    state.characterLayerEditor.draftFlags.set(k, { ...nextFlags });
  }
}

export async function openCharacterLayerEditor(assetRoot) {
  if (!assetRoot) return;
  const r = await fetch(`/api/characters/layers?assetRoot=${encodeURIComponent(assetRoot)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    showToast(data.detail || "レイヤー情報の取得に失敗しました", "error");
    return;
  }
  state.characterLayerEditor = {
    assetRoot: data.assetRoot || assetRoot,
    manifest: data.manifest || null,
    hasImportYaml: !!data.hasImportYaml,
    draftRenames: new Map(),
    draftDeletes: new Set(),
    // category|id -> { flagName: bool }。manifest 既存値とのマージは
    // effectiveFlags() で吸収するので、ここには「変更後の最終状態」を保存。
    draftFlags: new Map(),
    // 表示名 (name) のドラフト。 category|id -> 新表示名。元の name と同じなら
    // setDraftName で削除する (空文字保存も不可、空のときは draft から消す)。
    draftNames: new Map(),
  };
  if (elements.characterLayerEditorSubtitle) {
    const m = data.manifest || {};
    elements.characterLayerEditorSubtitle.textContent = `${m.name || ""} (${m.id || ""}) — ${state.characterLayerEditor.assetRoot}`;
  }
  if (elements.characterLayerEditorStatus) elements.characterLayerEditorStatus.textContent = "";
  renderCharacterLayerEditor();
  if (typeof elements.characterLayerEditorDialog?.showModal === "function") {
    if (!elements.characterLayerEditorDialog.open) elements.characterLayerEditorDialog.showModal();
  } else {
    elements.characterLayerEditorDialog?.setAttribute("open", "");
  }
  migrateInDialogToasts();
}

function closeCharacterLayerEditor() {
  if (elements.characterLayerEditorDialog?.open) elements.characterLayerEditorDialog.close();
}

function tryCancelCharacterLayerEditor() {
  if (
    characterLayerEditorHasDraftChanges() &&
    !window.confirm("変更が保存されていません。破棄して閉じますか？")
  ) {
    return;
  }
  resetCharacterLayerEditorDraft();
  closeCharacterLayerEditor();
}

function renderCharacterLayerEditor() {
  const root = elements.characterLayerEditorBody;
  if (!root) return;
  root.innerHTML = "";
  const manifest = state.characterLayerEditor.manifest;
  if (!manifest) return;

  for (const category of LAYER_CATEGORY_ORDER) {
    const manifestKey = LAYER_MANIFEST_KEY[category];
    const entries = manifest[manifestKey] || [];
    if (!entries.length) continue;
    const section = document.createElement("section");
    section.className = "layer-editor-section";
    const header = document.createElement("h3");
    header.textContent = LAYER_CATEGORY_LABELS[category];
    if (category === "eye") {
      const note = document.createElement("span");
      note.className = "asset-hint";
      note.textContent =
        " — 「開き」フラグ付きの目だけ目パチ対象。中間／閉じはシーンで 1 枚ずつ指定。";
      header.append(note);
    } else if (category === "mouth") {
      const note = document.createElement("span");
      note.className = "asset-hint";
      note.textContent =
        " — 開き／中間／閉じはそれぞれ 1 枚を指定。指定無し時は口パクが劣化します。";
      header.append(note);
    }
    section.append(header);
    for (const entry of entries) {
      section.append(createLayerEditorRow(category, entry));
    }
    root.append(section);
  }
  if (!root.children.length) {
    const empty = document.createElement("div");
    empty.className = "asset-empty";
    empty.textContent = "レイヤーがありません";
    root.append(empty);
  }
  updateCharacterLayerEditorStatus();
}

function updateCharacterLayerEditorStatus() {
  if (!elements.characterLayerEditorStatus) return;
  const renames = state.characterLayerEditor.draftRenames?.size || 0;
  const deletes = state.characterLayerEditor.draftDeletes?.size || 0;
  const flags = state.characterLayerEditor.draftFlags?.size || 0;
  const names = state.characterLayerEditor.draftNames?.size || 0;
  if (renames === 0 && deletes === 0 && flags === 0 && names === 0) {
    elements.characterLayerEditorStatus.textContent = "";
    return;
  }
  const parts = [];
  if (renames) parts.push(`リネーム ${renames}件`);
  if (deletes) parts.push(`削除 ${deletes}件`);
  if (flags) parts.push(`フラグ ${flags}件`);
  if (names) parts.push(`表示名 ${names}件`);
  elements.characterLayerEditorStatus.textContent = `保留中: ${parts.join(" / ")}`;
}

function createLayerEditorRow(category, entry) {
  const row = document.createElement("div");
  row.className = "layer-editor-row";
  const k = layerKey(category, entry.id);
  const isDeleted = state.characterLayerEditor.draftDeletes.has(k);
  const draftNew = state.characterLayerEditor.draftRenames.get(k);
  if (isDeleted) row.classList.add("is-deleted");
  if (!isDeleted && draftNew) row.classList.add("is-renamed");

  const tag = document.createElement("span");
  tag.className = "layer-editor-tag";
  tag.textContent = category;
  row.append(tag);

  const idLabel = document.createElement("span");
  idLabel.className = "layer-editor-id";
  if (draftNew && !isDeleted) {
    idLabel.innerHTML = "";
    const oldSpan = document.createElement("span");
    oldSpan.className = "layer-editor-id-old";
    oldSpan.textContent = entry.id || "(no id)";
    const arrow = document.createElement("span");
    arrow.className = "layer-editor-id-arrow";
    arrow.textContent = " → ";
    const newSpan = document.createElement("span");
    newSpan.className = "layer-editor-id-new";
    newSpan.textContent = draftNew;
    idLabel.append(oldSpan, arrow, newSpan);
  } else {
    idLabel.textContent = entry.id || "(no id)";
  }
  if (entry.sourceCombination) idLabel.title = entry.sourceCombination;
  row.append(idLabel);

  // 表示名 (name) の編集 input。プリセットセレクタやセレクトボックスで
  // 表示される文字列。id と独立して編集可能 (UTF-8 日本語可)。
  // 元の name と同じ・空文字なら draftNames から消して dirty 扱いにしない。
  const draftedName = state.characterLayerEditor.draftNames?.get(k);
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "layer-editor-name-input";
  nameInput.placeholder = "表示名";
  nameInput.value = draftedName !== undefined ? draftedName : (entry.name || "");
  nameInput.disabled = isDeleted;
  nameInput.addEventListener("input", () => {
    const v = nameInput.value.trim();
    const original = (entry.name || "").trim();
    if (!v || v === original) {
      state.characterLayerEditor.draftNames?.delete(k);
    } else {
      state.characterLayerEditor.draftNames?.set(k, v);
    }
    updateCharacterLayerEditorStatus();
  });
  row.append(nameInput);

  // フラグチェックボックス (eye / mouth のみ)。
  // 排他フラグ (blinkHalf / blinkClosed / lipClosed/Mid/Open) は同カテゴリで
  // 1 枚だけ立てられるので、新たに立てると他行の同フラグは下げる。
  const flagDefs = FLAG_DEFS_BY_CATEGORY[category] || [];
  if (flagDefs.length) {
    const flagBox = document.createElement("div");
    flagBox.className = "layer-editor-flags";
    const currentFlags = effectiveFlags(category, entry);
    for (const def of flagDefs) {
      const wrap = document.createElement("label");
      wrap.className = "checkbox-row layer-editor-flag";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!currentFlags[def.key];
      cb.disabled = isDeleted;
      cb.addEventListener("change", () => {
        const desired = cb.checked;
        const baseFlags = { ...effectiveFlags(category, entry) };
        if (desired) {
          baseFlags[def.key] = true;
        } else {
          delete baseFlags[def.key];
        }
        setDraftFlags(category, entry, baseFlags);
        // 排他フラグ ON のときは他行の同フラグを下げる。
        if (desired && def.exclusive) {
          const entries =
            state.characterLayerEditor.manifest?.[LAYER_MANIFEST_KEY[category]] || [];
          for (const other of entries) {
            if (other === entry) continue;
            const otherFlags = { ...effectiveFlags(category, other) };
            if (otherFlags[def.key]) {
              delete otherFlags[def.key];
              setDraftFlags(category, other, otherFlags);
            }
          }
        }
        renderCharacterLayerEditor();
      });
      const text = document.createElement("span");
      text.textContent = def.label;
      wrap.append(cb, text);
      flagBox.append(wrap);
    }
    row.append(flagBox);
  } else {
    // base/cheek/bangs/front は flexbox の余白だけ取るスペーサーを置く。
    const spacer = document.createElement("span");
    spacer.className = "layer-editor-flag-spacer";
    row.append(spacer);
  }

  const actionBox = document.createElement("div");
  actionBox.className = "layer-editor-row-actions";
  if (isDeleted) {
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "icon-button";
    undoBtn.title = "削除を取り消す";
    undoBtn.innerHTML = '<span class="msym" aria-hidden="true">undo</span>';
    undoBtn.addEventListener("click", () => {
      state.characterLayerEditor.draftDeletes.delete(k);
      renderCharacterLayerEditor();
    });
    actionBox.append(undoBtn);
  } else {
    if (draftNew) {
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.className = "icon-button";
      revertBtn.title = "変更を取り消す";
      revertBtn.innerHTML = '<span class="msym" aria-hidden="true">undo</span>';
      revertBtn.addEventListener("click", () => {
        state.characterLayerEditor.draftRenames.delete(k);
        renderCharacterLayerEditor();
      });
      actionBox.append(revertBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-button danger";
    delBtn.title = "このレイヤーを削除";
    delBtn.innerHTML = '<span class="msym" aria-hidden="true">delete</span>';
    delBtn.addEventListener("click", () => {
      state.characterLayerEditor.draftDeletes.add(k);
      state.characterLayerEditor.draftRenames.delete(k);
      renderCharacterLayerEditor();
    });
    actionBox.append(delBtn);
  }
  row.append(actionBox);

  return row;
}

async function saveCharacterLayerEditor() {
  if (!characterLayerEditorHasDraftChanges()) {
    closeCharacterLayerEditor();
    return;
  }
  const updates = [];
  for (const k of state.characterLayerEditor.draftDeletes) {
    const sep = k.indexOf("|");
    if (sep < 0) continue;
    updates.push({ category: k.slice(0, sep), oldId: k.slice(sep + 1), deleted: true });
  }
  for (const [k, newId] of state.characterLayerEditor.draftRenames.entries()) {
    const sep = k.indexOf("|");
    if (sep < 0) continue;
    updates.push({ category: k.slice(0, sep), oldId: k.slice(sep + 1), newId });
  }
  // フラグ更新は最終 desired 状態を 1 回ずつ送る (false 解除も明示的に送る)。
  // サーバ側は received flags 内の true/false を見て manifest を更新する。
  for (const [k, flags] of state.characterLayerEditor.draftFlags.entries()) {
    const sep = k.indexOf("|");
    if (sep < 0) continue;
    const category = k.slice(0, sep);
    const oldId = k.slice(sep + 1);
    const original = entryFlags(
      (state.characterLayerEditor.manifest?.[LAYER_MANIFEST_KEY[category]] || []).find(
        (e) => e.id === oldId,
      ) || {},
    );
    // 立てる / 落とす の両方を 1 ペイロードに含める。
    const flagPayload = { ...flags };
    for (const key of Object.keys(original)) {
      if (!(key in flagPayload)) flagPayload[key] = false;
    }
    updates.push({ category, oldId, flags: flagPayload });
  }
  // 表示名の更新。同じ entry に rename / flags が同時指定されてもサーバは
  // 1 件の oldId に対して name フィールドを後勝ちで適用するので、別 update
  // 行として送る (oldId が一致すれば各処理が自動的に重なって動作する)。
  for (const [k, name] of state.characterLayerEditor.draftNames.entries()) {
    const sep = k.indexOf("|");
    if (sep < 0) continue;
    updates.push({ category: k.slice(0, sep), oldId: k.slice(sep + 1), name });
  }
  try {
    const res = await fetch("/api/characters/layers/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetRoot: state.characterLayerEditor.assetRoot,
        updates,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "保存に失敗しました");
    showToast(
      `保存しました（リネーム ${data.applied?.renames ?? 0}件 / 削除 ${data.applied?.deletes ?? 0}件 / フラグ ${data.applied?.flags ?? 0}件 / 表示名 ${data.applied?.names ?? 0}件）`,
    );
    state.characterLayerEditor.manifest = data.manifest || state.characterLayerEditor.manifest;
    resetCharacterLayerEditorDraft();
    closeCharacterLayerEditor();
    if (state.activeProjectId) {
      try {
        await deps.refreshManifest();
      } catch (_error) {}
    }
    if (elements.assetManagerDialog?.open) {
      try {
        await deps.refreshAssetManager();
      } catch (_error) {}
    }
    // アセット管理ダイアログ閉じ時に再スキャンが走るようマーク
    try {
      const mod = await import("./assets.js");
      mod.markAssetManagerDirty?.();
    } catch (_error) {}
  } catch (error) {
    console.error(error);
    showToast(error.message || "保存に失敗しました", "error");
  }
}

export function bindCharacterLayerEditor(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  elements.characterLayerEditorSaveButton?.addEventListener("click", () => {
    withBusy(elements.characterLayerEditorSaveButton, "保存中", saveCharacterLayerEditor).catch(
      (error) => console.error(error),
    );
  });
  elements.characterLayerEditorCancelButton?.addEventListener("click", () => {
    tryCancelCharacterLayerEditor();
  });
  elements.characterLayerEditorDialog?.addEventListener("cancel", (event) => {
    // ESC キーでも保留中の変更は確認する。
    if (characterLayerEditorHasDraftChanges()) {
      event.preventDefault();
      tryCancelCharacterLayerEditor();
    } else {
      resetCharacterLayerEditorDraft();
    }
  });
  elements.characterLayerEditorAppendButton?.addEventListener("click", () => {
    const assetRoot = state.characterLayerEditor.assetRoot;
    if (!assetRoot) return;
    if (
      characterLayerEditorHasDraftChanges() &&
      !window.confirm("保留中の変更があります。先に保存または破棄しますか？\nOK で破棄して追加インポートに進みます。")
    ) {
      return;
    }
    resetCharacterLayerEditorDraft();
    closeCharacterLayerEditor();
    openPsdImporter({ mode: "append", assetRoot }).catch((error) => {
      console.error(error);
      showToast(error.message || "PSDインポータの起動に失敗しました", "error");
    });
  });
}
