import { state } from "./state.js";
import { elements } from "./elements.js";
import { escapeHtml, formatSize, formatTimestamp } from "./utils.js";
import { showToast } from "./toast.js";
import {
  characterIdExists,
  applyIdValidationFeedback,
  bindLiveIdValidation,
} from "./id-validation.js";
import { openCharacterLayerEditor } from "./character-layer-editor.js";
import { openAssetExpressionPresets } from "./asset-expression-presets.js";
import { openAssetHairstylePresets } from "./asset-hairstyle-presets.js";

let deps = {
  openCharacterManager: async () => {},
  reloadProjectData: async () => {},
};

// アセット管理ダイアログ内で素材が増減 / 改名 / 削除 / 復元されたら true。
// ダイアログ閉じたタイミングで一度だけ project rescan を回す。
let assetManagerDirty = false;

// 「音声（プロジェクト）」だけの限定機能:
// - 未使用音声だけに絞り込むフィルタ
// - 個別 / 一括でゴミ箱へ送る選択モード
// 他カテゴリでは出さない。
let projectAudioUnusedOnly = false;
let projectAudioSelection = new Set();  // rootPath を保持

export function markAssetManagerDirty() {
  assetManagerDirty = true;
}

export function bindAssets(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
}

export const ASSET_CATEGORY_KEYS = ["characters", "backgrounds", "foregrounds", "overlays", "fonts", "audio", "sound_effects", "videos"];
export const ASSET_CATEGORY_LABELS = {
  characters: "キャラクター",
  backgrounds: "背景",
  foregrounds: "前景",
  overlays: "装飾オーバーレイ",
  fonts: "フォント",
  audio: "音声",
  sound_effects: "効果音",
  videos: "動画",
};
export const ASSET_CATEGORY_ICONS = {
  characters: "groups",
  backgrounds: "image",
  foregrounds: "wallpaper",
  overlays: "auto_awesome",
  fonts: "text_fields",
  audio: "music_note",
  sound_effects: "graphic_eq",
  videos: "movie",
};
export const ASSET_CATEGORY_ACCEPT = {
  backgrounds: ".png,.jpg,.jpeg,.webp,.avif",
  foregrounds: ".png,.jpg,.jpeg,.webp,.avif",
  overlays: ".png,.webp,.avif",
  fonts: ".otf,.ttf",
  audio: ".wav,.mp3,.m4a,.aac,.ogg",
  sound_effects: ".wav,.mp3,.m4a,.aac,.ogg",
  videos: ".mp4,.mov,.webm,.mkv",
  characters: ".psd,.zip,.png,.webp,.avif",
};

// state.scenario を走査して、現在プロジェクトで参照されている音声 rootPath の Set を返す。
// 参照ソース:
//   - cut.audio (話者音声)
//   - scene.bgmTracks[].src (BGM)
// scene.soundEffects は別カテゴリ (sound_effects) なので除外。
function collectReferencedAudioPaths() {
  const used = new Set();
  const add = (raw) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    used.add(trimmed);
  };
  const scenario = state.scenario || {};
  for (const scene of scenario.scenes || []) {
    for (const cut of scene?.cuts || []) {
      add(cut?.audio);
    }
    for (const bgm of scene?.bgmTracks || []) {
      add(bgm?.src);
    }
  }
  // v3 以前互換: scenario.cuts (scenes に入っていないルートレベル) も走査。
  for (const cut of scenario.cuts || []) {
    add(cut?.audio);
  }
  return used;
}

async function fetchAssetInventory(scope) {
  try {
    const response = await fetch(`/api/assets/inventory?scope=${scope}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function fetchMissingReferences() {
  try {
    const response = await fetch("/api/assets/missing");
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.missing) ? data.missing : [];
  } catch (_error) {
    return [];
  }
}

async function fetchProjectOutputs() {
  try {
    const response = await fetch("/api/outputs/list?scope=project");
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function fetchCacheStats() {
  try {
    const response = await fetch("/api/cache/stats");
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
}

export async function refreshAssetManager() {
  const tasks = [fetchAssetInventory("common"), fetchCacheStats()];
  if (state.activeProjectId) {
    tasks.push(fetchAssetInventory("project"));
    tasks.push(fetchMissingReferences());
    tasks.push(fetchProjectOutputs());
  } else {
    tasks.push(Promise.resolve(null));
    tasks.push(Promise.resolve([]));
    tasks.push(Promise.resolve(null));
  }
  const [common, cacheStats, project, missing, outputs] = await Promise.all(tasks);
  state.assetInventory = { common, project };
  state.assetMissing = missing || [];
  state.outputsData = outputs;
  state.cacheStats = cacheStats;
  if (
    state.assetSelected.scope === "project" &&
    !state.activeProjectId
  ) {
    state.assetSelected = { scope: "common", category: "characters", view: "category" };
  }
  renderAssetManagerTree();
  renderAssetMissingBanner();
  renderAssetList();
}

function renderAssetManagerTree() {
  const root = elements.assetManagerTree;
  if (!root) return;
  root.innerHTML = "";

  const commonSection = createAssetTreeSection("共通アセット", "folder_shared");
  for (const category of ASSET_CATEGORY_KEYS) {
    const items = state.assetInventory.common?.categories?.[category] || [];
    commonSection.append(createAssetTreeItem("common", category, "category", items.length));
  }
  root.append(commonSection);

  const projectSection = createAssetTreeSection(
    state.activeProjectId
      ? `プロジェクト: ${currentProjectTitle()}`
      : "プロジェクト（未選択）",
    "folder_special"
  );
  for (const category of ASSET_CATEGORY_KEYS) {
    const items = state.assetInventory.project?.categories?.[category] || [];
    const button = createAssetTreeItem("project", category, "category", items.length);
    if (!state.activeProjectId) button.classList.add("disabled");
    projectSection.append(button);
  }
  const outputsCount = state.outputsData?.outputs?.length || 0;
  const outputsItem = createAssetTreeItem(
    "project",
    null,
    "outputs",
    outputsCount,
    "出力済データ",
    "movie",
  );
  if (!state.activeProjectId) outputsItem.classList.add("disabled");
  projectSection.append(outputsItem);
  // キャッシュ (preview / lipsync / clean_pcm)。プロジェクト固有のもの + 全体共有。
  // バッジには全プロジェクト合計サイズ (MB) を出す。
  const cacheTotalBytes = state.cacheStats?.totalBytes || 0;
  const cacheBadge = cacheTotalBytes > 0 ? formatSize(cacheTotalBytes) : "0";
  const cacheItem = createAssetTreeItem(
    "project",
    null,
    "cache",
    cacheBadge,
    "キャッシュ",
    "memory",
  );
  projectSection.append(cacheItem);
  root.append(projectSection);

  const trashSection = createAssetTreeSection("ゴミ箱", "delete");
  trashSection.append(
    createAssetTreeItem("common", null, "trash", state.assetInventory.common?.trash?.length || 0, "共通"),
  );
  const projTrashCount = state.assetInventory.project?.trash?.length || 0;
  const projTrashItem = createAssetTreeItem("project", null, "trash", projTrashCount, "プロジェクト");
  if (!state.activeProjectId) projTrashItem.classList.add("disabled");
  trashSection.append(projTrashItem);
  root.append(trashSection);
}

function currentProjectTitle() {
  const project = (state.projects || []).find((item) => item.id === state.activeProjectId);
  return project?.title || state.activeProjectId || "(no project)";
}

function createAssetTreeSection(title, icon) {
  const wrap = document.createElement("div");
  wrap.className = "asset-tree-section";
  const heading = document.createElement("div");
  heading.className = "asset-tree-heading";
  heading.innerHTML = `<span class="msym" aria-hidden="true">${icon}</span><span>${escapeHtml(title)}</span>`;
  wrap.append(heading);
  return wrap;
}

function createAssetTreeItem(scope, category, view, count, customLabel = null, customIcon = null) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "asset-tree-item";
  const labelText = customLabel || ASSET_CATEGORY_LABELS[category] || category || "アセット";
  const iconName =
    customIcon
      ? customIcon
      : view === "trash"
        ? "delete"
        : view === "outputs"
          ? "movie"
          : ASSET_CATEGORY_ICONS[category] || "folder";
  item.innerHTML = `<span class="msym" aria-hidden="true">${iconName}</span><span>${escapeHtml(labelText)}</span><span class="badge">${count}</span>`;
  item.addEventListener("click", () => {
    if (item.classList.contains("disabled")) return;
    selectAssetCategory(scope, category, view);
  });
  if (
    state.assetSelected.scope === scope &&
    (state.assetSelected.category || null) === (category || null) &&
    state.assetSelected.view === view
  ) {
    item.classList.add("active");
  }
  return item;
}

function selectAssetCategory(scope, category, view) {
  state.assetSelected = { scope, category, view };
  renderAssetManagerTree();
  renderAssetList();
}

function renderAssetMissingBanner() {
  const missing = state.assetMissing || [];
  if (!elements.assetMissingBanner) return;
  if (missing.length === 0) {
    elements.assetMissingBanner.classList.add("hidden");
    elements.assetMissingDetails.classList.add("hidden");
    return;
  }
  elements.assetMissingBanner.classList.remove("hidden");
  elements.assetMissingMessage.textContent = `参照先が見つからないアセット: ${missing.length} 件（カット側はスケルトンのまま残ります）`;
  const lines = missing.map(
    (item) => `[${item.scenario || "scenario"}] ${item.cutId || ""} : ${item.field} → ${item.path}`,
  );
  elements.assetMissingDetails.textContent = lines.join("\n");
}

function renderAssetList() {
  const { scope, category, view } = state.assetSelected;
  if (!scope) return;
  const inventory = state.assetInventory[scope];
  let items = [];
  let title = "";
  let hint = "";
  let showUpload = false;
  let showCharFields = false;
  let showBulkButton = false;
  let bulkLabel = "ゴミ箱を空にする";

  if (view === "trash") {
    title = scope === "common" ? "ゴミ箱（共通）" : "ゴミ箱（プロジェクト）";
    items = inventory?.trash || [];
    hint = "「復元」で元の場所に戻すか、「ゴミ箱を空にする」で完全に削除します。";
    showBulkButton = items.length > 0;
    bulkLabel = "ゴミ箱を空にする";
  } else if (view === "outputs") {
    title = "出力済データ（プロジェクト）";
    items = state.outputsData?.outputs || [];
    const dir = state.outputsData?.outputDir ? `${state.outputsData.outputDir}/` : "";
    hint = dir
      ? `${dir} （PNG/動画 出力先。削除はゴミ箱を経由しません）`
      : "動画出力・PNG出力で生成されたファイルを整理します（削除はゴミ箱を経由しません）";
    showBulkButton = items.length > 0;
    bulkLabel = "全削除";
  } else if (view === "cache") {
    // キャッシュビューは独自レンダリング (項目リストではなく統計サマリ + 各種クリアボタン)。
    // 後続の通常リスト構築をスキップし、専用関数に委譲。
    renderCacheView();
    return;
  } else if (category) {
    const scopeLabel = scope === "common" ? "共通" : "プロジェクト";
    title = `${ASSET_CATEGORY_LABELS[category] || category}（${scopeLabel}）`;
    items = inventory?.categories?.[category] || [];
    const root = inventory?.scopeRoot ? `${inventory.scopeRoot}/${category}/` : "";
    hint = root || "";
    showUpload = !(scope === "project" && !state.activeProjectId);
    showCharFields = category === "characters" && showUpload;
  } else {
    title = "";
    hint = "";
  }

  elements.assetCategoryTitle.textContent = title;
  elements.assetCategoryHint.textContent = hint;
  elements.assetUploadButton.classList.toggle("hidden", !showUpload);
  elements.assetEmptyTrashButton.classList.toggle("hidden", !showBulkButton);
  const bulkLabelSpan = elements.assetEmptyTrashButton?.querySelector("span:last-child");
  if (bulkLabelSpan) bulkLabelSpan.textContent = bulkLabel;
  (elements.assetUploadCharIdWrap || elements.assetUploadCharIdInput).classList.toggle("hidden", !showCharFields);
  elements.assetUploadCharNameInput.classList.toggle("hidden", !showCharFields);
  elements.assetCharacterUploadHint.classList.toggle("hidden", !showCharFields);
  elements.assetUploadStatus.textContent = "";

  const accept = view === "trash" || view === "outputs" ? "" : ASSET_CATEGORY_ACCEPT[category] || "";
  elements.assetUploadInput.setAttribute("accept", accept);
  elements.assetUploadInput.toggleAttribute("multiple", true);

  const list = elements.assetList;
  list.innerHTML = "";

  // 「音声（プロジェクト）」だけのフィルタ + 一括選択ツールバー。
  // ここで items を未使用フィルタにかけ、UI を組み立てる。
  // 他のカテゴリで開いたときは projectAudioSelection をクリアして次回に持ち越さない。
  const isProjectAudio =
    scope === "project" && category === "audio" && view === "category";
  let usedAudioPaths = null;
  if (isProjectAudio) {
    usedAudioPaths = collectReferencedAudioPaths();
    if (projectAudioUnusedOnly) {
      items = items.filter((it) => !usedAudioPaths.has(it.rootPath));
    }
    // 表示されない項目を選択集合から落とす (フィルタ ON/OFF や削除後)。
    const visible = new Set(items.map((it) => it.rootPath));
    for (const key of [...projectAudioSelection]) {
      if (!visible.has(key)) projectAudioSelection.delete(key);
    }
    list.append(_buildProjectAudioToolbar(usedAudioPaths, items));
  } else {
    projectAudioSelection = new Set();
  }

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "asset-empty";
    empty.textContent =
      view === "trash"
        ? "ゴミ箱は空です"
        : view === "outputs"
          ? "出力済データはありません。PNG／動画 出力後にここに並びます"
          : isProjectAudio && projectAudioUnusedOnly
            ? "未使用の音声はありません。フィルタを解除すると全件表示できます。"
            : "アセットがありません。「追加」からアップロードできます";
    list.append(empty);
    return;
  }

  for (const item of items) {
    list.append(createAssetCard(scope, category, view, item, {
      isProjectAudio,
      usedAudioPaths,
    }));
  }
}

// キャッシュビュー。`projects/<id>/cache/preview/` + `cache/clean_pcm/` 等の
// サイズ統計を表示し、プロジェクト単位 / 共有 / 全体それぞれをクリアできる。
//
// `.asset-list` は `display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, ...))`
// なので、ここに直接 flex 行を append すると 180px 幅のグリッドセルに押し込まれて
// 文字が縦書きになる崩れが出る。全行を 1 つのラッパで包んで `grid-column: 1 / -1`
// で全幅を占有させる。
function renderCacheView() {
  const stats = state.cacheStats;
  const title = "キャッシュ";
  elements.assetCategoryTitle.textContent = title;
  elements.assetCategoryHint.textContent =
    "プレビュー描画 / 口パク解析 / 録画素材 PCM 等の中間ファイル。"
    + " 削除しても次回開いたときに必要分だけ自動再生成されます (= プロジェクトは壊れません)。"
    + " 起動時に古いものを自動間引きする設定は「全体設定」から変更できます。";
  elements.assetUploadButton.classList.add("hidden");
  elements.assetEmptyTrashButton.classList.add("hidden");
  (elements.assetUploadCharIdWrap || elements.assetUploadCharIdInput).classList.add("hidden");
  elements.assetUploadCharNameInput.classList.add("hidden");
  elements.assetCharacterUploadHint.classList.add("hidden");
  elements.assetUploadStatus.textContent = "";

  const list = elements.assetList;
  list.innerHTML = "";

  // 親 `.asset-list` のグリッドを 1 カラム占有して縦積みで全幅にする。
  const container = document.createElement("div");
  container.className = "asset-cache-view";
  container.style.cssText =
    "grid-column: 1 / -1;display:flex;flex-direction:column;gap:6px;min-width:0;";
  list.append(container);

  if (!stats) {
    const empty = document.createElement("div");
    empty.className = "asset-empty";
    empty.textContent = "キャッシュ統計を取得できませんでした";
    container.append(empty);
    return;
  }

  // ----- 全体サマリ + 全削除ボタン
  const summary = document.createElement("div");
  summary.style.cssText =
    "display:flex;align-items:center;gap:12px;padding:12px 14px;"
    + "background:var(--surface-2,#222);border:1px solid var(--border,#333);"
    + "border-radius:6px;margin-bottom:8px;min-width:0;";
  const summaryText = document.createElement("div");
  summaryText.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;";
  const summaryTitle = document.createElement("strong");
  summaryTitle.textContent = `合計 ${formatSize(stats.totalBytes || 0)}`;
  const summarySub = document.createElement("span");
  summarySub.style.cssText = "color:var(--text-muted,#888);font-size:0.9em;";
  summarySub.textContent = `プロジェクト ${stats.projects?.length || 0} 件 + 共有キャッシュ`;
  summaryText.append(summaryTitle, summarySub);
  summary.append(summaryText);

  const emptyAllBtn = document.createElement("button");
  emptyAllBtn.type = "button";
  emptyAllBtn.className = "compact-action-button danger";
  emptyAllBtn.style.cssText = "flex:0 0 auto;white-space:nowrap;";
  emptyAllBtn.innerHTML =
    `<span class="msym" aria-hidden="true">delete_sweep</span><span>全プロジェクト + 共有を全削除</span>`;
  emptyAllBtn.addEventListener("click", () => emptyCacheScope("all"));
  summary.append(emptyAllBtn);
  container.append(summary);

  // ----- プロジェクト別行
  const projects = Array.isArray(stats.projects) ? stats.projects : [];
  for (const proj of projects) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:12px;padding:10px 14px;"
      + "border:1px solid var(--border,#333);border-radius:6px;min-width:0;";
    const label = document.createElement("div");
    label.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;";
    const labelTitle = document.createElement("strong");
    labelTitle.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    labelTitle.textContent = proj.title || proj.id;
    if (proj.isActive) {
      labelTitle.textContent += " (使用中)";
    }
    const labelSub = document.createElement("span");
    labelSub.style.cssText =
      "color:var(--text-muted,#888);font-size:0.85em;"
      + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const previewLine = `preview ${formatSize(proj.preview?.bytes || 0)} / ${proj.preview?.count || 0} 件`;
    const lipsyncLine = `lipsync ${formatSize(proj.lipsync?.bytes || 0)} / ${proj.lipsync?.count || 0} 件`;
    labelSub.textContent = `${previewLine} ・ ${lipsyncLine}`;
    label.append(labelTitle, labelSub);
    row.append(label);

    const total = document.createElement("span");
    total.style.cssText =
      "flex:0 0 auto;min-width:80px;text-align:right;font-variant-numeric:tabular-nums;";
    total.textContent = formatSize(proj.totalBytes || 0);
    row.append(total);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "compact-action-button";
    btn.style.cssText = "flex:0 0 auto;white-space:nowrap;";
    btn.innerHTML = `<span class="msym" aria-hidden="true">delete</span><span>削除</span>`;
    btn.title = "このプロジェクトのキャッシュを削除";
    btn.addEventListener("click", () => emptyCacheProject(proj.id, proj.title));
    row.append(btn);

    container.append(row);
  }

  // ----- 共有キャッシュ
  const shared = stats.shared || {};
  const sharedRow = document.createElement("div");
  sharedRow.style.cssText =
    "display:flex;align-items:center;gap:12px;padding:10px 14px;"
    + "border:1px dashed var(--border,#333);border-radius:6px;margin-top:10px;min-width:0;";
  const sharedLabel = document.createElement("div");
  sharedLabel.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;";
  const sharedTitle = document.createElement("strong");
  sharedTitle.textContent = "共有キャッシュ";
  const sharedSub = document.createElement("span");
  sharedSub.style.cssText =
    "color:var(--text-muted,#888);font-size:0.85em;"
    + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  sharedSub.textContent =
    `clean_pcm ${formatSize(shared.cleanPcm?.bytes || 0)} / ${shared.cleanPcm?.count || 0} 件`
    + ` ・ psd-importer ${formatSize(shared.psdImporter?.bytes || 0)} / ${shared.psdImporter?.count || 0} 件 (psd は自動管理)`;
  sharedLabel.append(sharedTitle, sharedSub);
  sharedRow.append(sharedLabel);

  const sharedBytes = (shared.cleanPcm?.bytes || 0) + (shared.psdImporter?.bytes || 0);
  const sharedTotalSpan = document.createElement("span");
  sharedTotalSpan.style.cssText =
    "flex:0 0 auto;min-width:80px;text-align:right;font-variant-numeric:tabular-nums;";
  sharedTotalSpan.textContent = formatSize(sharedBytes);
  sharedRow.append(sharedTotalSpan);

  const sharedBtn = document.createElement("button");
  sharedBtn.type = "button";
  sharedBtn.className = "compact-action-button";
  sharedBtn.style.cssText = "flex:0 0 auto;white-space:nowrap;";
  sharedBtn.innerHTML = `<span class="msym" aria-hidden="true">delete</span><span>共有を削除</span>`;
  sharedBtn.title = "共有キャッシュ (clean_pcm) を削除";
  sharedBtn.addEventListener("click", () => emptyCacheScope("shared"));
  sharedRow.append(sharedBtn);

  container.append(sharedRow);
}

async function emptyCacheProject(projectId, projectTitle) {
  const label = projectTitle || projectId;
  if (!window.confirm(`「${label}」のキャッシュを削除します。よろしいですか？`)) return;
  try {
    const response = await fetch("/api/cache/empty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", projectId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "キャッシュ削除に失敗しました");
    const previewN = data.preview ?? 0;
    const lipsyncN = data.lipsync ?? 0;
    showToast(`${label} のキャッシュを削除しました (preview ${previewN} / lipsync ${lipsyncN})`);
    await refreshAssetManager();
  } catch (error) {
    console.error(error);
    showToast(error.message || "キャッシュ削除に失敗しました", "error");
  }
}

async function emptyCacheScope(scope) {
  const confirmMsg =
    scope === "all"
      ? "全プロジェクトのキャッシュと共有キャッシュをまとめて削除します。よろしいですか？"
      : "共有キャッシュ (clean_pcm) を削除します。よろしいですか？";
  if (!window.confirm(confirmMsg)) return;
  try {
    const response = await fetch("/api/cache/empty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "キャッシュ削除に失敗しました");
    const summary =
      scope === "all"
        ? `preview ${data.preview ?? 0} / lipsync ${data.lipsync ?? 0} / clean_pcm ${data.cleanPcm ?? 0}`
        : `clean_pcm ${data.cleanPcm ?? 0}`;
    showToast(`キャッシュを削除しました (${summary})`);
    await refreshAssetManager();
  } catch (error) {
    console.error(error);
    showToast(error.message || "キャッシュ削除に失敗しました", "error");
  }
}

// 「音声（プロジェクト）」のための追加ツールバー (フィルタ + 一括選択コントロール)。
// 他カテゴリでは出さない。
function _buildProjectAudioToolbar(usedAudioPaths, displayedItems) {
  const bar = document.createElement("div");
  bar.className = "asset-project-audio-toolbar";

  // 未使用フィルタトグル。OFF のときも参照先が無い項目を視認できるよう、各カードに
  // 「未使用」バッジは別途付ける (createAssetCard 側)。
  const filterLabel = document.createElement("label");
  filterLabel.className = "checkbox-row";
  filterLabel.title = "現在のシナリオに参照されていない音声ファイルだけに絞り込みます";
  const filterInput = document.createElement("input");
  filterInput.type = "checkbox";
  filterInput.checked = projectAudioUnusedOnly;
  filterInput.addEventListener("change", () => {
    projectAudioUnusedOnly = filterInput.checked;
    renderAssetList();
  });
  const filterText = document.createElement("span");
  filterText.textContent = "未使用のみ表示";
  filterLabel.append(filterInput, filterText);
  bar.append(filterLabel);

  // 件数サマリ (現在の絞り込み状態を分かりやすく)
  const totalProject = (state.assetInventory.project?.categories?.audio || []).length;
  const unusedCount = totalProject - (state.assetInventory.project?.categories?.audio || [])
    .filter((it) => usedAudioPaths.has(it.rootPath)).length;
  const summary = document.createElement("span");
  summary.className = "asset-project-audio-summary";
  summary.textContent =
    `${projectAudioUnusedOnly ? "未使用 " : ""}${displayedItems.length}/${totalProject} 件 (未使用 ${unusedCount} 件)`;
  bar.append(summary);

  // 選択操作 (未使用フィルタ ON のときだけ「未使用を全選択」ボタンを出す)
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  bar.append(spacer);

  const selectableItems = displayedItems.filter((it) => !usedAudioPaths.has(it.rootPath));
  if (selectableItems.length > 0) {
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "link-button";
    const allSelected = selectableItems.every((it) => projectAudioSelection.has(it.rootPath));
    selectAllBtn.textContent = allSelected ? "選択を解除" : "未使用を全選択";
    selectAllBtn.addEventListener("click", () => {
      if (allSelected) {
        for (const it of selectableItems) projectAudioSelection.delete(it.rootPath);
      } else {
        for (const it of selectableItems) projectAudioSelection.add(it.rootPath);
      }
      renderAssetList();
    });
    bar.append(selectAllBtn);
  }

  const bulkBtn = document.createElement("button");
  bulkBtn.type = "button";
  bulkBtn.className = "compact-action-button danger";
  bulkBtn.disabled = projectAudioSelection.size === 0;
  bulkBtn.innerHTML = `<span class="msym" aria-hidden="true">delete_sweep</span><span>選択した音声を一括削除 (${projectAudioSelection.size})</span>`;
  bulkBtn.title = "選択した未使用音声をまとめてゴミ箱へ送ります";
  bulkBtn.addEventListener("click", () => bulkDeleteSelectedProjectAudio());
  bar.append(bulkBtn);

  return bar;
}

async function bulkDeleteSelectedProjectAudio() {
  const inventoryItems = state.assetInventory.project?.categories?.audio || [];
  const itemsByPath = new Map(inventoryItems.map((it) => [it.rootPath, it]));
  const targets = [...projectAudioSelection]
    .map((rootPath) => itemsByPath.get(rootPath))
    .filter(Boolean);
  if (targets.length === 0) return;
  if (!window.confirm(`選択中の ${targets.length} 件の音声をゴミ箱へ送ります。よろしいですか？`)) return;

  let ok = 0;
  let ng = 0;
  for (const item of targets) {
    try {
      const path = item.relativePath
        ? item.relativePath.replace(/^audio\//, "")
        : item.name || "";
      const response = await fetch("/api/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "project", category: "audio", path }),
      });
      if (!response.ok) throw new Error();
      ok += 1;
    } catch (_e) {
      ng += 1;
    }
  }
  projectAudioSelection = new Set();
  markAssetManagerDirty();
  await refreshAssetManager();
  if (ng === 0) {
    showToast(`${ok} 件をゴミ箱へ送りました`);
  } else {
    showToast(`${ok} 件削除 / ${ng} 件失敗`, ng === targets.length ? "error" : "warn");
  }
}

function createAssetCard(scope, category, view, item, audioCtx = null) {
  const card = document.createElement("div");
  card.className = "asset-card";

  // 「音声（プロジェクト）」だけ: 選択チェック + 未使用バッジを付ける。
  // 未使用音声のときだけチェックを有効化、使用中音声には disable + 説明 title。
  if (audioCtx?.isProjectAudio && view === "category") {
    const isUnused = !audioCtx.usedAudioPaths.has(item.rootPath);
    const wrap = document.createElement("label");
    wrap.className = "asset-card-select";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = projectAudioSelection.has(item.rootPath);
    cb.disabled = !isUnused;
    cb.title = isUnused ? "未使用音声 — 一括削除対象に追加" : "シナリオで使用中のため選択できません";
    cb.addEventListener("change", () => {
      if (cb.checked) projectAudioSelection.add(item.rootPath);
      else projectAudioSelection.delete(item.rootPath);
      // ツールバーのボタンラベル更新のため再描画。
      renderAssetList();
    });
    wrap.append(cb);
    card.append(wrap);
    if (!isUnused) {
      const usedBadge = document.createElement("span");
      usedBadge.className = "badge asset-card-badge asset-audio-badge used";
      usedBadge.textContent = "使用中";
      card.append(usedBadge);
    } else {
      const unusedBadge = document.createElement("span");
      unusedBadge.className = "badge asset-card-badge asset-audio-badge unused";
      unusedBadge.textContent = "未使用";
      card.append(unusedBadge);
    }
  }

  const preview = document.createElement("div");
  preview.className = "asset-card-preview";
  const itemCategory = item.category || category;
  const isImage =
    item.kind === "directory" ||
    (item.ext && /\.(png|jpe?g|webp|avif)$/i.test(item.name)) ||
    itemCategory === "backgrounds" ||
    itemCategory === "foregrounds" ||
    itemCategory === "overlays";

  if (view === "outputs") {
    if (item.kind === "image" && item.url) {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.name;
      img.loading = "lazy";
      preview.append(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "msym";
      icon.textContent =
        item.kind === "video"
          ? "movie"
          : item.kind === "directory"
            ? "folder"
            : "insert_drive_file";
      preview.append(icon);
    }
  } else if (view === "trash") {
    const icon = document.createElement("span");
    icon.className = "msym";
    icon.textContent = ASSET_CATEGORY_ICONS[itemCategory] || "delete";
    preview.append(icon);
  } else if (itemCategory === "fonts") {
    preview.classList.add("font-preview");
    preview.textContent = "あア亜 Aa Yy 1";
  } else if (item.url && isImage) {
    if (itemCategory === "characters" && item.kind === "directory") {
      preview.classList.add("character-thumb");
    }
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.displayName || item.name;
    img.loading = "lazy";
    preview.append(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "msym";
    icon.textContent = ASSET_CATEGORY_ICONS[itemCategory] || "insert_drive_file";
    preview.append(icon);
  }
  card.append(preview);

  if (item.readOnly) {
    const badge = document.createElement("span");
    badge.className = "badge readonly asset-card-badge";
    badge.textContent = "READ ONLY";
    card.append(badge);
  }

  const meta = document.createElement("div");
  meta.className = "asset-card-meta";

  const name = document.createElement("div");
  name.className = "asset-card-name";
  name.textContent = item.displayName || item.name || "(no name)";
  name.title = item.relativePath || item.originalPath || item.name || "";
  meta.append(name);

  if (itemCategory === "characters" && item.kind === "directory") {
    const idLine = document.createElement("div");
    idLine.className = "asset-card-id";
    idLine.textContent = `ID: ${item.characterId || item.name || ""}`;
    idLine.title = idLine.textContent;
    meta.append(idLine);
  }

  // フォントは見出しに日本語 family 名 (displayName) を出すため、実ファイル名が
  // 隠れる。削除対象を取り違えないよう、ファイル名を補助行で併記する。
  if (itemCategory === "fonts" && item.displayName && item.displayName !== item.name) {
    const fileLine = document.createElement("div");
    fileLine.className = "asset-card-id";
    fileLine.textContent = item.name || "";
    fileLine.title = fileLine.textContent;
    meta.append(fileLine);
  }

  const detail = document.createElement("div");
  detail.className = "asset-card-detail";
  const sizeStr = formatSize(item.size || 0);
  if (view === "trash") {
    detail.textContent = `${sizeStr} · 削除 ${formatTimestamp(item.deletedAt)}`;
  } else if (item.kind === "directory") {
    const parts = item.partsCount || {};
    const summary = Object.entries(parts)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}:${count}`)
      .join(" ");
    detail.textContent = summary || `${sizeStr} · ${formatTimestamp(item.modifiedAt)}`;
  } else {
    detail.textContent = `${sizeStr} · ${formatTimestamp(item.modifiedAt)}`;
  }
  meta.append(detail);

  card.append(meta);

  const actions = document.createElement("div");
  actions.className = "asset-card-actions";
  if (view === "outputs") {
    if (item.url) {
      actions.append(
        makeAssetCardAction("open_in_new", "開く", () => {
          window.open(item.url, "_blank", "noopener");
        }),
      );
    }
    actions.append(
      makeAssetCardAction("delete", "削除", () => deleteOutput(item), "danger"),
    );
  } else if (view === "trash") {
    actions.append(
      makeAssetCardAction("restore_from_trash", "復元", () => restoreAsset(scope, item)),
    );
  } else {
    if (itemCategory === "characters" && item.kind === "directory") {
      const assetRoot = item.rootPath || `${scope === "common" ? "assets" : `projects/${state.activeProjectId}/assets`}/characters/${item.characterId}`;
      actions.classList.add("icon-only");
      actions.append(
        makeAssetCardAction("edit_note", "詳細編集", () => {
          deps.openCharacterManager(assetRoot).catch((error) => {
            console.error(error);
            showToast("キャラ管理の起動に失敗しました", "error");
          });
        }, "", { iconOnly: true }),
      );
      actions.append(
        makeAssetCardAction("layers", "レイヤー編集", () => {
          openCharacterLayerEditor(assetRoot).catch((error) => {
            console.error(error);
            showToast(error.message || "レイヤー編集の起動に失敗しました", "error");
          });
        }, "", { iconOnly: true }),
      );
      actions.append(
        makeAssetCardAction("mood", "表情プリセット", () => {
          openAssetExpressionPresets(assetRoot).catch((error) => {
            console.error(error);
            showToast(error.message || "表情プリセット編集の起動に失敗しました", "error");
          });
        }, "", { iconOnly: true }),
      );
      actions.append(
        makeAssetCardAction("content_cut", "髪型プリセット", () => {
          openAssetHairstylePresets(assetRoot).catch((error) => {
            console.error(error);
            showToast(error.message || "髪型プリセット編集の起動に失敗しました", "error");
          });
        }, "", { iconOnly: true }),
      );
      actions.append(
        makeAssetCardAction("image", "サムネイル設定", () => {
          chooseCharacterThumbnail(scope, assetRoot).catch((error) => {
            console.error(error);
            showToast(error.message || "サムネイル設定に失敗しました", "error");
          });
        }, "", { iconOnly: true }),
      );
      actions.append(
        makeAssetCardAction("delete", "削除", () => deleteAsset(scope, itemCategory, item), "danger", { iconOnly: true }),
      );
    } else {
      actions.append(
        makeAssetCardAction("delete", "削除", () => deleteAsset(scope, itemCategory, item), "danger"),
      );
    }
  }
  card.append(actions);

  return card;
}

function makeAssetCardAction(icon, label, onClick, modifier = "", options = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  const classes = ["asset-card-action"];
  if (modifier) classes.push(modifier);
  if (options.iconOnly) classes.push("icon-only");
  btn.className = classes.join(" ");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  if (options.iconOnly) {
    btn.innerHTML = `<span class="msym" aria-hidden="true">${icon}</span>`;
  } else {
    btn.innerHTML = `<span class="msym" aria-hidden="true">${icon}</span><span>${label}</span>`;
  }
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return btn;
}

export async function ensureCommonInventoryLoaded() {
  if (state.assetInventory?.common) return;
  try {
    const data = await fetchAssetInventory("common");
    if (data) {
      state.assetInventory = state.assetInventory || { common: null, project: null };
      state.assetInventory.common = data;
    }
  } catch (_error) {}
}

// アクティブプロジェクトの asset inventory を 1 度だけ取りに行く。
// プロジェクト未選択時は無視。PSD インポータの「登録先=プロジェクト」時の
// ID 重複チェックなどで使う。
export async function ensureProjectInventoryLoaded() {
  if (!state.activeProjectId) return;
  if (state.assetInventory?.project) return;
  try {
    const data = await fetchAssetInventory("project");
    if (data) {
      state.assetInventory = state.assetInventory || { common: null, project: null };
      state.assetInventory.project = data;
    }
  } catch (_error) {}
}


async function uploadAssets(files) {
  const { scope, category, view } = state.assetSelected;
  if (view !== "category" || !category || !files || files.length === 0) return;
  if (scope === "project" && !state.activeProjectId) {
    showToast("プロジェクトが未選択です", "error");
    return;
  }
  const form = new FormData();
  form.append("scope", scope);
  form.append("category", category);
  if (category === "characters") {
    const id = (elements.assetUploadCharIdInput.value || "").trim();
    const name = (elements.assetUploadCharNameInput.value || "").trim();
    if (!id) {
      showToast("キャラIDを入力してください", "error");
      return;
    }
    if (characterIdExists(scope, id)) {
      applyIdValidationFeedback(elements.assetUploadCharIdInput, elements.assetUploadCharIdWarning, scope);
      elements.assetUploadCharIdInput?.focus();
      showToast(`同じID（${id}）のキャラクターが既に存在します`, "error");
      return;
    }
    form.append("character_id", id);
    if (name) form.append("display_name", name);
  }
  for (const file of files) {
    form.append("files", file);
  }
  elements.assetUploadStatus.textContent = "アップロード中...";
  try {
    const response = await fetch("/api/assets/upload", {
      method: "POST",
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.detail || "アップロードに失敗しました");
    }
    elements.assetUploadStatus.textContent = "";
    if (category === "characters") {
      elements.assetUploadCharIdInput.value = "";
      elements.assetUploadCharIdInput.classList.remove("has-error");
      if (elements.assetUploadCharIdWarning) {
        elements.assetUploadCharIdWarning.hidden = true;
        elements.assetUploadCharIdWarning.textContent = "";
      }
      elements.assetUploadCharNameInput.value = "";
    }
    markAssetManagerDirty();
    await refreshAssetManager();
    showToast("アップロードが完了しました");
  } catch (error) {
    console.error(error);
    elements.assetUploadStatus.textContent = "";
    showToast(error.message || "アップロードに失敗しました", "error");
  } finally {
    elements.assetUploadInput.value = "";
  }
}

async function deleteAsset(scope, category, item) {
  const label = item.displayName || item.name || "";
  if (!window.confirm(`「${label}」をゴミ箱へ移動しますか？`)) return;
  try {
    const path = item.relativePath
      ? item.relativePath.replace(new RegExp(`^${category}/`), "")
      : item.name || "";
    const response = await fetch("/api/assets/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, category, path }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "削除に失敗しました");
    markAssetManagerDirty();
    await refreshAssetManager();
    showToast("ゴミ箱に移動しました");
  } catch (error) {
    console.error(error);
    showToast(error.message || "削除に失敗しました", "error");
  }
}

async function restoreAsset(scope, item) {
  try {
    const response = await fetch("/api/assets/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, id: item.id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "復元に失敗しました");
    markAssetManagerDirty();
    await refreshAssetManager();
    showToast("復元しました");
  } catch (error) {
    console.error(error);
    showToast(error.message || "復元に失敗しました", "error");
  }
}

async function deleteOutput(item) {
  if (!window.confirm(`「${item.name}」を完全に削除します。よろしいですか？`)) return;
  try {
    const response = await fetch("/api/outputs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: item.name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "削除に失敗しました");
    await refreshAssetManager();
    showToast(`${item.name} を削除しました`);
  } catch (error) {
    console.error(error);
    showToast(error.message || "削除に失敗しました", "error");
  }
}

async function emptyAllOutputs() {
  const count = state.outputsData?.outputs?.length || 0;
  if (count === 0) return;
  if (!window.confirm(`${count} 件の出力済データをすべて削除します。よろしいですか？`)) {
    return;
  }
  try {
    const response = await fetch("/api/outputs/empty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "全削除に失敗しました");
    await refreshAssetManager();
    showToast(`出力済データを ${data.removed ?? count} 件削除しました`);
  } catch (error) {
    console.error(error);
    showToast(error.message || "全削除に失敗しました", "error");
  }
}

async function emptyTrashAtScope(scope) {
  if (!window.confirm(`${scope === "common" ? "共通" : "プロジェクト"}のゴミ箱を空にします。よろしいですか？`)) {
    return;
  }
  try {
    const response = await fetch("/api/assets/empty-trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "ゴミ箱を空にできませんでした");
    markAssetManagerDirty();
    await refreshAssetManager();
    showToast("ゴミ箱を空にしました");
  } catch (error) {
    console.error(error);
    showToast(error.message || "ゴミ箱を空にできませんでした", "error");
  }
}

export async function openAssetManager() {
  // 開くたびに「音声（プロジェクト）」専用の選択状態とフィルタを初期化する。
  // 別プロジェクトに切り替えた後で古い rootPath が選択集合に残らないようにする。
  projectAudioUnusedOnly = false;
  projectAudioSelection = new Set();
  if (typeof elements.assetManagerDialog?.showModal === "function") {
    elements.assetManagerDialog.showModal();
  } else {
    elements.assetManagerDialog?.setAttribute("open", "");
  }
  await refreshAssetManager();
}

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".png,.jpg,.jpeg,.webp,.avif";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] || null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

async function chooseCharacterThumbnail(scope, assetRoot) {
  const file = await pickImageFile();
  if (!file) return;
  const form = new FormData();
  form.append("scope", scope);
  form.append("asset_root", assetRoot);
  form.append("file", file);
  const response = await fetch("/api/assets/character-thumbnail", { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "サムネイル設定に失敗しました");
  }
  markAssetManagerDirty();
  showToast("サムネイルを更新しました");
  await refreshAssetManager();
}

async function flushAssetManagerCloseRescan() {
  if (!assetManagerDirty) return;
  assetManagerDirty = false;
  // 共通アセット (キャラ) を含めて全プロジェクトに反映するために
  // reloadProjectData を呼ぶ。エラーは静かに warn だけ。
  try {
    await deps.reloadProjectData();
  } catch (error) {
    console.warn("auto rescan after asset manager close failed", error);
  }
}

export function bindAssetManager() {
  elements.openAssetManagerButton?.addEventListener("click", openAssetManager);
  elements.dashboardAssetManagerButton?.addEventListener("click", openAssetManager);
  elements.closeAssetManagerButton?.addEventListener("click", () => {
    elements.assetManagerDialog?.close();
  });
  elements.assetManagerDialog?.addEventListener("close", () => {
    flushAssetManagerCloseRescan();
  });
  elements.assetMissingToggle?.addEventListener("click", () => {
    elements.assetMissingDetails.classList.toggle("hidden");
  });
  elements.assetUploadButton?.addEventListener("click", () => {
    elements.assetUploadInput.click();
  });
  elements.assetUploadInput?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    await uploadAssets(files);
  });
  elements.assetEmptyTrashButton?.addEventListener("click", () => {
    if (state.assetSelected.view === "outputs") {
      emptyAllOutputs();
    } else {
      emptyTrashAtScope(state.assetSelected.scope);
    }
  });
  bindLiveIdValidation(
    elements.assetUploadCharIdInput,
    elements.assetUploadCharIdWarning,
    () => state.assetSelected.scope || "common",
  );
}
