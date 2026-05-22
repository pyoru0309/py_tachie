// ===========================================================================
// PSD インポータ（未対応構造のPSDをカテゴリ別レイヤー組合わせに割り当てて取り込み）
// asset 系・character manager は循環参照を避けるため bindPsdImporter から
// 依存性注入で受け取る (deps.{ensureCommonInventoryLoaded, refreshManifest,
// refreshAssetManager, openCharacterLayerEditor})。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy, migrateInDialogToasts } from "./toast.js";
import {
  pathToKey,
  keyToPath,
  pathArrayToString,
} from "./utils.js";
import {
  applyIdValidationFeedback,
  bindLiveIdValidation,
  characterIdExists,
} from "./id-validation.js";

const PSD_IMPORTER_ZOOM_STEPS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];

const PSD_IMPORTER_CATEGORY_LABELS = {
  back_hair: "後ろ髪",
  base: "ベース",
  cheek: "頬",
  eye: "目",
  mouth: "口",
  bangs: "前髪",
  front: "前面",
  thumb: "サムネイル",
};

// 並びは PSD レイヤー / モデルの重なり順 (上が前面、下が背面) に揃える。
// YAML の追記順もこの並びに連動する。
// 補足: 概念的には front が一番手前だが、サムネイル (thumb) は YAML 上の専用キーで
// 単独行として先頭に出力されるため、この配列には含めない (serialize 側で別途扱う)。
const PSD_IMPORTER_CATEGORY_ORDER = ["front", "bangs", "eye", "mouth", "cheek", "base", "back_hair"];

const PSD_IMPORTER_LABEL_TO_KEY = {
  ベース: "base",
  base: "base",
  Base: "base",
  // v3 互換: body/pose/costume はすべて base 扱い
  体: "base",
  身体: "base",
  body: "base",
  Body: "base",
  ポーズ: "base",
  pose: "base",
  衣装: "base",
  costume: "base",
  頬: "cheek",
  ほほ: "cheek",
  チーク: "cheek",
  cheek: "cheek",
  Cheek: "cheek",
  目: "eye",
  眼: "eye",
  eye: "eye",
  Eye: "eye",
  口: "mouth",
  mouth: "mouth",
  Mouth: "mouth",
  前髪: "bangs",
  bangs: "bangs",
  Bangs: "bangs",
  後ろ髪: "back_hair",
  うしろ髪: "back_hair",
  後髪: "back_hair",
  back_hair: "back_hair",
  BackHair: "back_hair",
  Backhair: "back_hair",
  backhair: "back_hair",
  前面: "front",
  // v3 互換: foreground/前景 は front 扱い
  前景: "front",
  手前: "front",
  foreground: "front",
  front: "front",
  Front: "front",
  Foreground: "front",
  サムネイル: "thumb",
  サムネ: "thumb",
  thumb: "thumb",
  thumbnail: "thumb",
};

let deps = {
  ensureCommonInventoryLoaded: async () => {},
  ensureProjectInventoryLoaded: async () => {},
  refreshManifest: async () => {},
  refreshAssetManager: async () => {},
  openCharacterLayerEditor: async () => {},
};

// 黒線 AA プリセット <select> を upload レスポンスの一覧で組み立てる。
// 同じインポートセッション中の選択値は保持する (再 upload しても直近選択を維持)。
function populateBlackLineAaPresetSelect(presets, defaultId) {
  const select = elements.psdImporterBlackLineAaPreset;
  if (!select) return;
  const previousValue = select.value || "";
  select.innerHTML = "";
  const list = Array.isArray(presets) && presets.length ? presets : [
    { id: "normal", label: "標準", description: "" },
  ];
  for (const preset of list) {
    const option = document.createElement("option");
    option.value = String(preset.id || "");
    option.textContent = String(preset.label || preset.id || "");
    if (preset.description) option.title = String(preset.description);
    select.append(option);
  }
  const validIds = new Set(list.map((p) => String(p.id || "")));
  if (previousValue && validIds.has(previousValue)) {
    select.value = previousValue;
  } else {
    select.value = validIds.has(defaultId) ? defaultId : list[0].id;
  }
}

// 現在 UI で選択中の登録先 scope を返す。append モードでは概念的に意味を持たない
// (固定の assetRoot を上書きする) ため "common" を返してフォールバックする。
function currentPsdImporterScope() {
  if (state.psdImporter?.mode === "append") return "common";
  const v = String(elements.psdImporterScopeSelect?.value || "common").toLowerCase();
  return v === "project" ? "project" : "common";
}

export async function openPsdImporter(options = {}) {
  resetPsdImporterState();
  const mode = options.mode === "append" ? "append" : "create";
  state.psdImporter.mode = mode;
  state.psdImporter.assetRoot = options.assetRoot || "";

  applyPsdImporterModeUi(mode, options.assetRoot || "");

  if (mode === "append" && options.assetRoot) {
    try {
      const r = await fetch(`/api/characters/import-yaml?assetRoot=${encodeURIComponent(options.assetRoot)}`);
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        if (elements.psdImporterYamlTextarea) elements.psdImporterYamlTextarea.value = data.yaml || "";
        if (data.id && elements.psdImporterIdInput) elements.psdImporterIdInput.value = data.id;
        if (data.name && elements.psdImporterNameInput) elements.psdImporterNameInput.value = data.name;
      }
    } catch (error) {
      console.error(error);
    }
  }

  if (typeof elements.psdImporterDialog?.showModal === "function") {
    elements.psdImporterDialog.showModal();
  } else {
    elements.psdImporterDialog?.setAttribute("open", "");
  }
  migrateInDialogToasts();
  if (mode !== "append") {
    // 登録先 scope の選択肢を現在の状態に合わせて初期化する。
    // - プロジェクト未選択時は「プロジェクト」オプションを disabled にして common を強制。
    // - プロジェクト選択時は両方有効、既定は common。
    const scopeSelect = elements.psdImporterScopeSelect;
    if (scopeSelect) {
      const projectOption = scopeSelect.querySelector('option[value="project"]');
      const hasActiveProject = !!state.activeProjectId;
      if (projectOption) projectOption.disabled = !hasActiveProject;
      scopeSelect.value = "common";
      scopeSelect.disabled = false;
    }
    const initialScope = currentPsdImporterScope();
    const inventoryLoader = initialScope === "project"
      ? deps.ensureProjectInventoryLoaded
      : deps.ensureCommonInventoryLoaded;
    inventoryLoader()
      .then(() => applyIdValidationFeedback(
        elements.psdImporterIdInput,
        elements.psdImporterIdWarning,
        initialScope,
      ))
      .catch(() => {});
  }
}

function applyPsdImporterModeUi(mode, assetRoot) {
  const idInput = elements.psdImporterIdInput;
  const nameInput = elements.psdImporterNameInput;
  const scopeSelect = elements.psdImporterScopeSelect;
  const status = elements.psdImporterStatus;
  const idWarning = elements.psdImporterIdWarning;
  const isAppend = mode === "append";
  if (idInput) idInput.disabled = isAppend;
  if (nameInput) nameInput.disabled = isAppend;
  // append モードは既存の assetRoot に追加するため、登録先 select は無効化する。
  if (scopeSelect) scopeSelect.disabled = isAppend;
  if (idWarning) {
    idWarning.hidden = true;
    idWarning.textContent = "";
  }
  if (status) {
    status.textContent = isAppend
      ? `追加インポートモード — ${assetRoot} の既存マニフェストにマージします`
      : "";
  }
}

function closePsdImporter() {
  if (elements.psdImporterDialog?.open) {
    elements.psdImporterDialog.close();
  }
}

function resetPsdImporterState() {
  state.psdImporter = {
    token: "",
    fileName: "",
    size: [0, 0],
    tree: [],
    checked: new Set(),
    previewSeq: 0,
    zoom: "fit",
    mode: "create",
    assetRoot: "",
  };
  if (elements.psdImporterIdInput) elements.psdImporterIdInput.disabled = false;
  if (elements.psdImporterNameInput) elements.psdImporterNameInput.disabled = false;
  if (elements.psdImporterIdInput) {
    elements.psdImporterIdInput.value = "";
    elements.psdImporterIdInput.classList.remove("has-error");
  }
  if (elements.psdImporterIdWarning) {
    elements.psdImporterIdWarning.hidden = true;
    elements.psdImporterIdWarning.textContent = "";
  }
  if (elements.psdImporterNameInput) elements.psdImporterNameInput.value = "";
  if (elements.psdImporterScopeSelect) {
    elements.psdImporterScopeSelect.value = "common";
    elements.psdImporterScopeSelect.disabled = false;
  }
  if (elements.psdImporterFileInput) elements.psdImporterFileInput.value = "";
  if (elements.psdImporterStatus) elements.psdImporterStatus.textContent = "";
  if (elements.psdImporterYamlTextarea) elements.psdImporterYamlTextarea.value = "";
  if (elements.psdImporterPreviewImage) {
    elements.psdImporterPreviewImage.removeAttribute("src");
    elements.psdImporterPreviewImage.classList.remove("has-image");
    elements.psdImporterPreviewImage.style.width = "";
    elements.psdImporterPreviewImage.style.height = "";
  }
  applyPsdImporterZoom();
  renderPsdImporterTree();
}

function applyPsdImporterZoom() {
  const img = elements.psdImporterPreviewImage;
  const viewport = elements.psdImporterPreviewViewport;
  const label = elements.psdImporterZoomLabel;
  if (!img || !viewport) return;
  const zoom = state.psdImporter.zoom;
  if (zoom === "fit" || !img.naturalWidth || !img.naturalHeight) {
    img.style.width = "";
    img.style.height = "";
    viewport.classList.remove("is-zoomed");
    if (label) label.textContent = "フィット";
    return;
  }
  img.style.width = `${Math.round(img.naturalWidth * zoom)}px`;
  img.style.height = `${Math.round(img.naturalHeight * zoom)}px`;
  viewport.classList.add("is-zoomed");
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
}

function changePsdImporterZoom(direction) {
  const current = state.psdImporter.zoom === "fit" ? null : state.psdImporter.zoom;
  if (direction === "reset") {
    state.psdImporter.zoom = "fit";
  } else if (direction === "in") {
    if (current === null) {
      state.psdImporter.zoom = 1.0;
    } else {
      const next = PSD_IMPORTER_ZOOM_STEPS.find((step) => step > current);
      state.psdImporter.zoom = next ?? PSD_IMPORTER_ZOOM_STEPS[PSD_IMPORTER_ZOOM_STEPS.length - 1];
    }
  } else if (direction === "out") {
    if (current === null) {
      state.psdImporter.zoom = 0.75;
    } else {
      const candidates = PSD_IMPORTER_ZOOM_STEPS.filter((step) => step < current);
      state.psdImporter.zoom = candidates.length ? candidates[candidates.length - 1] : PSD_IMPORTER_ZOOM_STEPS[0];
    }
  }
  applyPsdImporterZoom();
}

async function uploadPsdImporterFile() {
  const file = elements.psdImporterFileInput?.files?.[0];
  if (!file) {
    showToast("PSDファイルを選択してください", "error");
    return;
  }
  const form = new FormData();
  form.append("psdFile", file);
  if (elements.psdImporterStatus) elements.psdImporterStatus.textContent = "PSD読み込み中...";
  try {
    const response = await fetch("/api/psd-importer/upload", { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.detail || "PSD読み込みに失敗しました");
    }
    state.psdImporter.token = data.token;
    state.psdImporter.fileName = data.fileName || file.name;
    state.psdImporter.size = data.size || [0, 0];
    state.psdImporter.tree = data.tree || [];
    state.psdImporter.checked = new Set();
    // 黒線 AA プリセット select の組み立て。upload レスポンスからプリセット一覧と
    // 既定 id を受け取り、既存選択値があれば保持する。
    populateBlackLineAaPresetSelect(
      data.blackLineAaPresets || [],
      data.defaultBlackLineAaPreset || "normal",
    );
    // PSD ルート直下に `import_manifest.yml` テキストレイヤーがあれば、
    // ダイアログのマッピング YAML / ID / 表示名フォームに自動反映する。
    // append モード時は既存マニフェストを fetch して埋めるロジックが
    // openPsdImporter で既に走っているため、上書きしない。
    if (state.psdImporter.mode !== "append") {
      const embeddedYaml = String(data.embeddedYaml || "").trim();
      if (embeddedYaml && elements.psdImporterYamlTextarea) {
        elements.psdImporterYamlTextarea.value = embeddedYaml;
      }
      if (data.embeddedId && elements.psdImporterIdInput && !elements.psdImporterIdInput.value.trim()) {
        elements.psdImporterIdInput.value = String(data.embeddedId);
      }
      if (data.embeddedName && elements.psdImporterNameInput && !elements.psdImporterNameInput.value.trim()) {
        elements.psdImporterNameInput.value = String(data.embeddedName);
      }
    }
    if (elements.psdImporterStatus) {
      const [w, h] = state.psdImporter.size;
      const yamlNote = data.embeddedYaml ? " — 埋め込み import_manifest.yml を反映" : "";
      elements.psdImporterStatus.textContent = `${state.psdImporter.fileName} (${w}×${h}) を読み込みました${yamlNote}`;
    }
    renderPsdImporterTree();
    requestPsdImporterPreview();
  } catch (error) {
    console.error(error);
    showToast(error.message || "PSD読み込みに失敗しました", "error");
    if (elements.psdImporterStatus) elements.psdImporterStatus.textContent = "";
  }
}

function renderPsdImporterTree() {
  const root = elements.psdImporterTree;
  if (!root) return;
  root.innerHTML = "";
  if (!state.psdImporter.tree?.length) {
    const empty = document.createElement("div");
    empty.className = "asset-empty";
    empty.textContent = "PSD未読み込み";
    root.append(empty);
    return;
  }
  const list = document.createElement("ul");
  for (const node of state.psdImporter.tree) {
    list.append(createPsdImporterTreeItem(node));
  }
  root.append(list);
}

function createPsdImporterTreeItem(node) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = `psd-importer-tree-row${node.isGroup ? " group" : ""}`;
  const isThumbName = (node.name || "").trim().toLowerCase();
  if (isThumbName === "thumb" || isThumbName === "thumbnail" || isThumbName === "サムネイル" || isThumbName === "サムネ") {
    row.classList.add("is-thumb");
  }

  const toggle = document.createElement("span");
  toggle.className = "msym toggle";
  if (node.isGroup) {
    toggle.textContent = node.expanded === false ? "chevron_right" : "expand_more";
    toggle.style.cursor = "pointer";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      node.expanded = node.expanded === false;
      renderPsdImporterTree();
    });
  } else {
    toggle.classList.add("is-leaf");
  }
  row.append(toggle);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const key = pathToKey(node.path);
  checkbox.checked = state.psdImporter.checked.has(key);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      state.psdImporter.checked.add(key);
    } else {
      state.psdImporter.checked.delete(key);
    }
    requestPsdImporterPreview();
  });
  row.append(checkbox);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = node.name || "(unnamed)";
  label.title = (node.path || []).join(" / ");
  row.append(label);
  li.append(row);

  if (node.isGroup && (node.children || []).length > 0 && node.expanded !== false) {
    const childList = document.createElement("ul");
    for (const child of node.children) {
      childList.append(createPsdImporterTreeItem(child));
    }
    li.append(childList);
  }
  return li;
}

function setAllPsdImporterChecks(checked) {
  const visit = (nodes) => {
    for (const node of nodes || []) {
      const key = pathToKey(node.path);
      if (checked) state.psdImporter.checked.add(key);
      else state.psdImporter.checked.delete(key);
      if (node.isGroup) visit(node.children);
    }
  };
  visit(state.psdImporter.tree);
  renderPsdImporterTree();
  requestPsdImporterPreview();
}

let psdImporterPreviewTimer = null;

function requestPsdImporterPreview() {
  if (!state.psdImporter.token) return;
  if (psdImporterPreviewTimer) clearTimeout(psdImporterPreviewTimer);
  psdImporterPreviewTimer = setTimeout(() => {
    psdImporterPreviewTimer = null;
    fetchPsdImporterPreview().catch((error) => console.error(error));
  }, 120);
}

async function fetchPsdImporterPreview() {
  const seq = ++state.psdImporter.previewSeq;
  const paths = collectCheckedLeafPaths();
  try {
    const response = await fetch("/api/psd-importer/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.psdImporter.token, paths }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "プレビュー生成に失敗しました");
    if (seq !== state.psdImporter.previewSeq) return;
    if (elements.psdImporterPreviewImage && data.url) {
      const img = elements.psdImporterPreviewImage;
      img.onload = () => applyPsdImporterZoom();
      img.src = data.url;
      img.classList.add("has-image");
      // 既に同サイズの画像がキャッシュから来た場合 onload が即時発火しないので明示適用
      if (img.complete) applyPsdImporterZoom();
    }
  } catch (error) {
    console.error(error);
  }
}

function collectCheckedLeafPaths() {
  const result = [];
  for (const key of state.psdImporter.checked) {
    const path = keyToPath(key);
    if (path.length === 0) continue;
    result.push(path);
  }
  return result;
}

function buildCombinationFromCheckedTopLevel() {
  const checked = state.psdImporter.checked;
  if (checked.size === 0) return "";
  const order = [];
  const visit = (nodes) => {
    for (const node of nodes || []) {
      const key = pathToKey(node.path);
      if (checked.has(key)) {
        order.push(pathArrayToString(node.path));
      } else if (node.isGroup) {
        visit(node.children);
      }
    }
  };
  visit(state.psdImporter.tree);
  return order.join(",");
}

function appendPsdImporterMapping(category) {
  if (!state.psdImporter.token) {
    showToast("先にPSDを読み込んでください", "error");
    return;
  }
  const combination = buildCombinationFromCheckedTopLevel();
  if (!combination) {
    showToast("チェックされているレイヤーがありません", "error");
    return;
  }
  const existing = readPsdImporterYamlState();
  if (category === "thumb") {
    existing.thumb = [combination];
  } else {
    if (!Array.isArray(existing.categories[category])) existing.categories[category] = [];
    existing.categories[category].push(combination);
  }
  writePsdImporterYamlState(existing);
  showToast(`${PSD_IMPORTER_CATEGORY_LABELS[category]} に登録しました`);
}

function readPsdImporterYamlState() {
  const text = elements.psdImporterYamlTextarea?.value || "";
  return parsePsdImporterYaml(text);
}

function writePsdImporterYamlState(data) {
  if (!elements.psdImporterYamlTextarea) return;
  elements.psdImporterYamlTextarea.value = serializePsdImporterYaml(data);
}

// `'!眉/*普通眉,...'` のような single/double quoted YAML 値からクォートを剥がす。
// サーバ側 (PyYAML safe_dump) は `!` / `*` 始まり文字列を自動で quote するため、
// 簡易パーサで読むとクォートが値に混入する。表示と再送のために 1 段だけ剥がす。
function stripYamlScalarQuotes(value) {
  if (typeof value !== "string") return value;
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      let inner = value.slice(1, -1);
      if (first === "'") inner = inner.replace(/''/g, "'");
      else inner = inner.replace(/\\(.)/g, "$1");
      return inner;
    }
  }
  return value;
}

function parsePsdImporterYaml(text) {
  const result = {
    id: "",
    name: "",
    categories: { back_hair: [], base: [], cheek: [], eye: [], mouth: [], bangs: [], front: [] },
    thumb: [],
  };
  let currentTarget = null;
  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) continue;
    const stripped = line.replace(/^\s+/, "");
    if (stripped.startsWith("#")) continue;
    if (stripped.startsWith("- ")) {
      const value = stripYamlScalarQuotes(stripped.slice(2).trimStart());
      if (!value || currentTarget === null) continue;
      if (currentTarget === "thumb") result.thumb.push(value);
      else if (Array.isArray(result.categories[currentTarget])) result.categories[currentTarget].push(value);
      continue;
    }
    if (stripped === "-") continue;
    const colon = stripped.indexOf(":");
    if (colon < 0) continue;
    const key = stripped.slice(0, colon).trim();
    const value = stripYamlScalarQuotes(stripped.slice(colon + 1).trim());
    let normalized = PSD_IMPORTER_LABEL_TO_KEY[key];
    if (!normalized) {
      const lower = key.toLowerCase();
      if (lower === "id" || lower === "name") normalized = lower;
    }
    if (normalized === "id" || normalized === "name") {
      if (value) result[normalized] = value;
      currentTarget = null;
      continue;
    }
    if (normalized === "thumb") {
      if (value) {
        result.thumb.push(value);
        currentTarget = null;
      } else {
        currentTarget = "thumb";
      }
      continue;
    }
    if (normalized && Array.isArray(result.categories[normalized])) {
      if (value) {
        result.categories[normalized].push(value);
        currentTarget = null;
      } else {
        currentTarget = normalized;
      }
      continue;
    }
    currentTarget = null;
  }
  return result;
}

function serializePsdImporterYaml(data) {
  const lines = [];
  if (data.id) lines.push(`id: ${data.id}`);
  if (data.name) lines.push(`name: ${data.name}`);
  // サムネイルは構造上の重なり順とは独立した「キャラ識別用 1 枚絵」なので、
  // メタ情報の延長として id / name の直下に置く。続いてカテゴリは
  // 前面 → 前髪 → 目 → 口 → 頬 → ベース → 後ろ髪 の重なり順で並ぶ。
  for (const entry of data.thumb || []) {
    lines.push(`サムネイル: ${entry}`);
  }
  for (const key of PSD_IMPORTER_CATEGORY_ORDER) {
    const entries = data.categories?.[key] || [];
    if (!entries.length) continue;
    lines.push(`${PSD_IMPORTER_CATEGORY_LABELS[key]}:`);
    for (const entry of entries) lines.push(`  - ${entry}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

async function convertPsdImporter() {
  if (!state.psdImporter.token) {
    showToast("先にPSDを読み込んでください", "error");
    return;
  }
  const mode = state.psdImporter.mode === "append" ? "append" : "create";
  const id = (elements.psdImporterIdInput?.value || "").trim();
  const name = (elements.psdImporterNameInput?.value || "").trim();
  const yaml = elements.psdImporterYamlTextarea?.value || "";

  const scope = currentPsdImporterScope();
  if (mode === "create") {
    if (!id && !name) {
      showToast("キャラIDまたは表示名を入力してください", "error");
      return;
    }
    if (scope === "project" && !state.activeProjectId) {
      showToast("プロジェクトが選択されていません", "error");
      return;
    }
    const candidateId = id || name;
    // 登録先 scope に応じて重複チェックの inventory を切り替える。
    if (scope === "project") {
      await deps.ensureProjectInventoryLoaded();
    } else {
      await deps.ensureCommonInventoryLoaded();
    }
    if (characterIdExists(scope, candidateId)) {
      applyIdValidationFeedback(elements.psdImporterIdInput, elements.psdImporterIdWarning, scope);
      elements.psdImporterIdInput?.focus();
      const scopeLabel = scope === "project" ? "プロジェクト" : "共通アセット";
      showToast(`${scopeLabel}に同じID（${candidateId}）のキャラクターが既に存在します`, "error");
      return;
    }
  }

  const parsed = parsePsdImporterYaml(yaml);
  const hasAnyEntry =
    PSD_IMPORTER_CATEGORY_ORDER.some((key) => (parsed.categories[key] || []).length > 0) ||
    (parsed.thumb || []).length > 0;
  if (!hasAnyEntry && mode === "create") {
    if (!window.confirm("カテゴリへの登録が無いまま取り込みます。よろしいですか？\n（baseは透過のbase.pngだけが生成されます）")) {
      return;
    }
  }
  if (elements.psdImporterStatus) elements.psdImporterStatus.textContent = "変換中...";
  try {
    const imageFormat = (elements.psdImporterFormatSelect?.value || "png").toLowerCase();
    const maxWidth = Math.max(0, Math.floor(Number(elements.psdImporterMaxWidthInput?.value) || 0));
    const maxHeight = Math.max(0, Math.floor(Number(elements.psdImporterMaxHeightInput?.value) || 0));
    const resampling = (elements.psdImporterResamplingSelect?.value || "lanczos").toLowerCase();
    const bakeWhiteTransparent = Boolean(elements.psdImporterBakeWhiteTransparent?.checked);
    const bakeBlackLineAa = Boolean(elements.psdImporterBakeBlackLineAa?.checked);
    const blackLineAaPreset = (elements.psdImporterBlackLineAaPreset?.value || "normal").toLowerCase();
    const body = {
      token: state.psdImporter.token,
      id,
      name,
      yaml,
      mode,
      imageFormat,
      maxWidth,
      maxHeight,
      resampling,
      // 各レイヤー PNG 保存前の追加処理 (両方既定 OFF):
      //   - bakeWhiteTransparent: 純白を α=0 にする
      //   - bakeBlackLineAa: 黒線専用アンチエイリアス (内部線を周囲色に・シルエットを半透明黒に)
      // 順序は backend で「白透過 → 黒線 AA」固定。
      // blackLineAaPreset: AA のパラメータプリセット (sharp / normal / soft / mild / thick-tolerant)
      bakeWhiteTransparent,
      bakeBlackLineAa,
      blackLineAaPreset,
      // 登録先 (create のみ意味を持つ): common = 共通アセット / project = アクティブプロジェクト。
      scope,
    };
    if (mode === "append") body.assetRoot = state.psdImporter.assetRoot;
    const response = await fetch("/api/psd-importer/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "変換に失敗しました");
    showToast(`${data.name || data.id} を${mode === "append" ? "追加インポート" : "取り込"}しました`);
    if (elements.psdImporterStatus) elements.psdImporterStatus.textContent = "完了しました";
    const resumeAssetRoot = mode === "append" ? data.assetRoot || state.psdImporter.assetRoot : "";
    closePsdImporter();
    if (state.activeProjectId) {
      try {
        await deps.refreshManifest();
      } catch (_error) {}
    }
    if (elements.assetManagerDialog?.open) {
      await deps.refreshAssetManager();
    }
    try {
      const mod = await import("./assets.js");
      mod.markAssetManagerDirty?.();
    } catch (_error) {}
    if (resumeAssetRoot) {
      try {
        await deps.openCharacterLayerEditor(resumeAssetRoot);
      } catch (_error) {}
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || "変換に失敗しました", "error");
    if (elements.psdImporterStatus) elements.psdImporterStatus.textContent = "";
  }
}

export function bindPsdImporter(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  elements.dashboardPsdImporterButton?.addEventListener("click", () => openPsdImporter());
  elements.psdImporterCloseButton?.addEventListener("click", closePsdImporter);
  elements.psdImporterUploadButton?.addEventListener("click", () => {
    uploadPsdImporterFile();
  });
  elements.psdImporterCheckAllButton?.addEventListener("click", () => setAllPsdImporterChecks(true));
  elements.psdImporterUncheckAllButton?.addEventListener("click", () => setAllPsdImporterChecks(false));
  elements.psdImporterYamlClearButton?.addEventListener("click", () => {
    if (elements.psdImporterYamlTextarea) elements.psdImporterYamlTextarea.value = "";
  });
  elements.psdImporterConvertButton?.addEventListener("click", () => {
    withBusy(elements.psdImporterConvertButton, "変換中", convertPsdImporter).catch((error) => {
      console.error(error);
    });
  });
  for (const button of elements.psdImporterMappingButtons || []) {
    button.addEventListener("click", () => {
      const category = button.getAttribute("data-psd-importer-category");
      if (category) appendPsdImporterMapping(category);
    });
  }
  elements.psdImporterZoomInButton?.addEventListener("click", () => changePsdImporterZoom("in"));
  elements.psdImporterZoomOutButton?.addEventListener("click", () => changePsdImporterZoom("out"));
  elements.psdImporterZoomResetButton?.addEventListener("click", () => changePsdImporterZoom("reset"));
  // 黒線 AA チェックボックスのトグルで preset select の disabled を連動。
  const syncBlackLineAaPresetDisabled = () => {
    if (!elements.psdImporterBlackLineAaPreset) return;
    elements.psdImporterBlackLineAaPreset.disabled =
      !elements.psdImporterBakeBlackLineAa?.checked;
  };
  elements.psdImporterBakeBlackLineAa?.addEventListener("change", syncBlackLineAaPresetDisabled);
  syncBlackLineAaPresetDisabled();
  elements.psdImporterPreviewViewport?.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changePsdImporterZoom(event.deltaY < 0 ? "in" : "out");
  }, { passive: false });
  bindLiveIdValidation(
    elements.psdImporterIdInput,
    elements.psdImporterIdWarning,
    () => currentPsdImporterScope(),
  );
  // 登録先を切り替えたら、inventory を必要に応じてロードしてから ID 重複チェックを引き直す。
  elements.psdImporterScopeSelect?.addEventListener("change", () => {
    const scope = currentPsdImporterScope();
    const loader = scope === "project"
      ? deps.ensureProjectInventoryLoaded
      : deps.ensureCommonInventoryLoaded;
    loader()
      .then(() => applyIdValidationFeedback(
        elements.psdImporterIdInput,
        elements.psdImporterIdWarning,
        scope,
      ))
      .catch(() => {});
  });
}
