// ===========================================================================
// アセット定義の表情プリセット編集ダイアログ
// (assets/characters/<id>/expression_presets.json への CRUD)
// プロジェクトの projects/<id>/expression_presets.json は別系統で、
// 同 (characterId, presetId) は project 側が優先される。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy, migrateInDialogToasts } from "./toast.js";
import { fillExpressionPresets } from "./character-manager.js";

let deps = {
  refreshManifest: async () => {},
};

function ensureDraftState() {
  if (!state.assetExpressionPresets) {
    state.assetExpressionPresets = {
      assetRoot: "",
      character: null,
      drafts: [], // 編集中のプリセット配列 (UI ローカル)
      original: [], // 開いた瞬間のサーバ側内容 (差分判定用)
    };
  }
  return state.assetExpressionPresets;
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
      a.cheekId !== b.cheekId ||
      a.eyeId !== b.eyeId ||
      a.mouthId !== b.mouthId ||
      !!a.isDefault !== !!b.isDefault
    )
      return true;
  }
  return false;
}

function makeIdFromName(name, existingIds) {
  const base = (name || "preset").trim().replace(/\s+/g, "_") || "preset";
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
  const root = elements.assetExpressionPresetsBody;
  if (!root) return;
  const s = ensureDraftState();
  const character = s.character || {};
  const cheeks = character.cheeks || [];
  const eyes = character.eyes || [];
  const mouths = character.mouths || [];
  root.innerHTML = "";
  if (!s.drafts.length) {
    const empty = document.createElement("div");
    empty.className = "asset-empty";
    empty.textContent = "プリセットがありません。「プリセットを追加」で作成してください。";
    root.append(empty);
    updateStatus();
    return;
  }
  for (let i = 0; i < s.drafts.length; i++) {
    const preset = s.drafts[i];
    const row = document.createElement("div");
    row.className = "asset-preset-row";

    // 名前入力
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "asset-preset-name";
    nameInput.placeholder = "表情名";
    nameInput.value = preset.name || "";
    nameInput.addEventListener("input", () => {
      preset.name = nameInput.value;
      updateStatus();
    });
    row.append(nameInput);

    // 頬・目・口セレクタ
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
    row.append(makeSelect("cheekId", cheeks, "(頬なし)"));
    row.append(makeSelect("eyeId", eyes, "(目なし)"));
    row.append(makeSelect("mouthId", mouths, "(口なし)"));

    // デフォルトチェックボックス
    const defLabel = document.createElement("label");
    defLabel.className = "checkbox-row asset-preset-default";
    const defCb = document.createElement("input");
    defCb.type = "checkbox";
    defCb.checked = !!preset.isDefault;
    defCb.title = "新規キャラ追加時の既定表情";
    defCb.addEventListener("change", () => {
      const desired = defCb.checked;
      preset.isDefault = desired;
      // 排他: 1 件だけ。他を全部 false。
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

    // 削除ボタン
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-button danger asset-preset-delete";
    delBtn.title = "このプリセットを削除";
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
  if (!elements.assetExpressionPresetsStatus) return;
  if (isDirty()) {
    elements.assetExpressionPresetsStatus.textContent = "未保存の変更があります";
  } else {
    elements.assetExpressionPresetsStatus.textContent = "";
  }
}

export async function openAssetExpressionPresets(assetRoot) {
  if (!assetRoot) return;
  let data;
  try {
    const r = await fetch(
      `/api/characters/expression-presets?assetRoot=${encodeURIComponent(assetRoot)}`,
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || "アセット表情プリセットの取得に失敗しました");
    }
    data = await r.json();
  } catch (error) {
    showToast(error.message || "アセット表情プリセットの取得に失敗しました", "error");
    return;
  }
  const character = data.character || {};
  const presets = (data.presets || []).map((p) => ({
    id: p.id || "",
    name: p.name || "",
    cheekId: p.cheekId || "",
    eyeId: p.eyeId || "",
    mouthId: p.mouthId || "",
    isDefault: !!p.isDefault,
  }));
  state.assetExpressionPresets = {
    assetRoot,
    character,
    drafts: presets.map((p) => ({ ...p })),
    original: presets.map((p) => ({ ...p })),
  };
  if (elements.assetExpressionPresetsSubtitle) {
    elements.assetExpressionPresetsSubtitle.textContent = `${character.name || ""} (${character.id || ""}) — ${assetRoot}`;
  }
  renderPresets();
  if (typeof elements.assetExpressionPresetsDialog?.showModal === "function") {
    if (!elements.assetExpressionPresetsDialog.open) {
      elements.assetExpressionPresetsDialog.showModal();
    }
  } else {
    elements.assetExpressionPresetsDialog?.setAttribute("open", "");
  }
  migrateInDialogToasts();
}

function close() {
  if (elements.assetExpressionPresetsDialog?.open) {
    elements.assetExpressionPresetsDialog.close();
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
  // ID を name から自動生成 (空 ID のものに付ける)。サーバ側でも正規化されるが
  // 表示上の安定のためここでも実施。
  const usedIds = new Set();
  for (const p of s.drafts) {
    if (p.id) usedIds.add(p.id);
  }
  for (const p of s.drafts) {
    if (!p.id) p.id = makeIdFromName(p.name, usedIds);
    usedIds.add(p.id);
  }
  try {
    const r = await fetch("/api/characters/expression-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetRoot, presets: s.drafts }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "保存に失敗しました");
    showToast(`アセット表情プリセットを保存しました (${(data.presets || []).length}件)`);
    s.original = (data.presets || []).map((p) => ({ ...p }));
    s.drafts = (data.presets || []).map((p) => ({ ...p }));
    // refresh は close より先に実行する。close 後だと dashboard のレイヤーが
    // 落ちた瞬間に project edit の DOM 更新が間に合わずに stale で見えるケースに
    // 対応するため。refreshManifest 内で fillAssetControls → fillExpressionPresets
    // までは走るので、project edit の preset セレクタにアセット由来 preset が
    // origin="asset" として追加される。
    if (state.activeProjectId) {
      try {
        await deps.refreshManifest();
      } catch (_error) {}
      // refreshManifest のチェーン (fillAssetControls → fillExpressionPresets)
      // を信用しつつ、念押しで preset セレクタを直接再構築する。fillAssetControls
      // 中の他処理 (loadCharacterIntoControls など) で例外が起きた場合の保険。
      try {
        fillExpressionPresets();
      } catch (_error) {}
    }
    close();
  } catch (error) {
    console.error(error);
    showToast(error.message || "保存に失敗しました", "error");
  }
}

export function bindAssetExpressionPresets(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  elements.assetExpressionPresetsAddButton?.addEventListener("click", () => {
    const s = ensureDraftState();
    const usedIds = new Set(s.drafts.map((p) => p.id).filter(Boolean));
    s.drafts.push({
      id: makeIdFromName(`preset_${s.drafts.length + 1}`, usedIds),
      name: `表情${s.drafts.length + 1}`,
      cheekId: "",
      eyeId: "",
      mouthId: "",
      isDefault: false,
    });
    renderPresets();
  });
  elements.assetExpressionPresetsSaveButton?.addEventListener("click", () => {
    withBusy(elements.assetExpressionPresetsSaveButton, "保存中", savePresets).catch(
      (error) => console.error(error),
    );
  });
  elements.assetExpressionPresetsCancelButton?.addEventListener("click", () => {
    tryCancel();
  });
  elements.assetExpressionPresetsDialog?.addEventListener("cancel", (event) => {
    if (isDirty()) {
      event.preventDefault();
      tryCancel();
    }
  });
}
