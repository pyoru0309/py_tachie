// ===========================================================================
// プロジェクトの保管場所 (storage locations)
// ===========================================================================
// 「完成した作品は外付けディスクへ寄せたいが、プロジェクト一覧からは今までどおり
// 開きたい」という運用のための仕組み。サーバ側の実体は app/project_locations.py。
//
// 責務:
//   - /api/project-locations の取得と state.projectLocations への反映
//   - 全体設定 (環境タブ) の保管場所リスト描画・追加・削除・既定切替・名称変更
//   - プロジェクト移動ダイアログ (一覧カードの「移動」から開く)
//   - 保管場所 <select> の共通生成 (移動 / 複製ダイアログ)
//
// プロジェクト一覧側 (カードのボタン / 絞り込み) は project.js が持つ。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";

const BUILTIN_ID = "builtin";

let deps = {
  // 保管場所が変わるとプロジェクト一覧の中身も変わるので、呼び出し側から
  // loadProjects / renderProjectDashboard を注入してもらう (循環 import 回避)。
  reloadProjects: async () => {},
};

export function bindProjectLocations(injectedDeps) {
  deps = { ...deps, ...injectedDeps };

  elements.projectLocationAddButton?.addEventListener("click", (event) => {
    event.preventDefault();
    addProjectLocation();
  });
  elements.projectLocationPathInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addProjectLocation();
    }
  });

  elements.projectMoveForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitProjectMove();
  });
  elements.cancelProjectMoveButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeProjectMoveDialog();
  });
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

/** 保管場所の一覧を取得して state に反映する。失敗しても null を返すだけ (画面は止めない)。 */
export async function loadProjectLocations() {
  try {
    const response = await fetch("/api/project-locations");
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    applyLocationsPayload(data);
    return data;
  } catch (error) {
    console.warn("[locations] 取得に失敗しました", error);
    return null;
  }
}

/** /api/projects や /api/project-locations のレスポンスから保管場所情報を取り込む。 */
export function applyLocationsPayload(data) {
  if (!data) return;
  if (Array.isArray(data.locations)) state.projectLocations = data.locations;
  if (typeof data.defaultLocationId === "string") {
    state.defaultProjectLocationId = data.defaultLocationId || BUILTIN_ID;
  }
  if (Array.isArray(data.duplicateIds)) state.projectIdConflicts = data.duplicateIds;
  renderProjectLocationSettings();
}

export function projectLocations() {
  return Array.isArray(state.projectLocations) ? state.projectLocations : [];
}

export function locationById(id) {
  return projectLocations().find((loc) => loc.id === id) || null;
}

export function locationLabel(id) {
  const loc = locationById(id);
  return loc ? loc.name : id || "";
}

/** 保管場所が 2 つ以上あるときだけ「移動 / 保管場所選択」の UI を出す。 */
export function hasMultipleLocations() {
  return projectLocations().length > 1;
}

// ---------------------------------------------------------------------------
// <select> 生成 (移動 / 複製ダイアログ共通)
// ---------------------------------------------------------------------------

export function fillLocationSelect(select, { selectedId = "", excludeId = "" } = {}) {
  if (!select) return;
  select.innerHTML = "";
  let firstEnabled = "";
  for (const loc of projectLocations()) {
    if (excludeId && loc.id === excludeId) continue;
    const option = document.createElement("option");
    option.value = loc.id;
    const marks = [];
    if (loc.isDefault) marks.push("既定");
    if (!loc.available) marks.push("未接続");
    option.textContent = marks.length ? `${loc.name}（${marks.join(" / ")}）` : loc.name;
    option.title = loc.path;
    // 未接続の保管場所は選べない (選ばせてから 409 で弾くより親切)。
    option.disabled = !loc.available;
    if (!option.disabled && !firstEnabled) firstEnabled = loc.id;
    select.append(option);
  }
  // selectedId が「存在して、かつ選択可能」なときだけ尊重する。存在しない値を
  // select.value に入れると value が空文字になり、送信時に保管場所が未指定になる。
  const preferred = selectedId
    ? select.querySelector(`option[value="${CSS.escape(selectedId)}"]`)
    : null;
  const wanted = preferred && !preferred.disabled ? selectedId : firstEnabled;
  if (wanted) select.value = wanted;
}

// ---------------------------------------------------------------------------
// 全体設定: 保管場所リスト
// ---------------------------------------------------------------------------

function setLocationError(message) {
  const el = elements.projectLocationError;
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function locationActionButton(label, icon, onClick, { danger = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  // プロジェクトカードのアクションと同じ見た目に揃える (小さめのアウトラインボタン)。
  button.className = danger ? "project-delete-button" : "project-rename-button";
  button.innerHTML = `<span class="msym button-icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

export function renderProjectLocationSettings() {
  const list = elements.projectLocationList;
  if (!list) return;
  list.innerHTML = "";
  const locations = projectLocations();
  if (locations.length === 0) {
    // /api/project-locations がまだ来ていない (= 設定ダイアログを開いた直後) 状態。
    const empty = document.createElement("p");
    empty.className = "asset-hint";
    empty.textContent = "保管場所を読み込み中…";
    list.append(empty);
    return;
  }
  for (const loc of locations) {
    const row = document.createElement("div");
    row.className = "location-row";
    if (loc.isDefault) row.classList.add("is-default");
    if (!loc.available) row.classList.add("is-offline");

    const main = document.createElement("div");
    main.className = "location-row-main";
    const title = document.createElement("div");
    title.className = "location-row-title";
    const name = document.createElement("span");
    name.textContent = loc.name;
    title.append(name);
    if (loc.isDefault) {
      const badge = document.createElement("span");
      badge.className = "location-badge default";
      badge.textContent = "新規の保存先";
      title.append(badge);
    }
    if (!loc.available) {
      const badge = document.createElement("span");
      badge.className = "location-badge offline";
      badge.textContent = "未接続";
      title.append(badge);
    }
    main.append(title);

    const pathLine = document.createElement("div");
    pathLine.className = "location-row-path";
    const count = Number.isFinite(loc.projectCount) ? `${loc.projectCount} 件` : "—";
    pathLine.textContent = loc.available
      ? `${loc.path} · プロジェクト ${count}`
      : `${loc.path} · 見つかりません（外付けディスクなら接続してください）`;
    main.append(pathLine);
    row.append(main);

    const actions = document.createElement("div");
    actions.className = "location-row-actions";
    if (!loc.isDefault && loc.available) {
      actions.append(
        locationActionButton("新規の保存先にする", "star", () => setDefaultLocation(loc.id)),
      );
    }
    if (!loc.builtin) {
      actions.append(
        locationActionButton("名称変更", "edit", () => renameLocation(loc)),
        locationActionButton("登録解除", "link_off", () => removeLocation(loc), { danger: true }),
      );
    }
    row.append(actions);
    list.append(row);
  }

  // ID 重複 (Finder で手動コピーした等) は先勝ちで 1 つしか使えない。黙って
  // 見えなくなるのが一番まずいので、設定画面にも出す。
  for (const conflict of state.projectIdConflicts || []) {
    const warn = document.createElement("p");
    warn.className = "asset-warning";
    const names = (conflict.locations || []).map((l) => l.name).join(" / ");
    warn.textContent =
      `⚠ 同じフォルダ名「${conflict.id}」が複数の保管場所にあります（${names}）。`
      + `「${locationLabel(conflict.usedLocationId)}」の方だけが一覧に出ます。`
      + "どちらかのフォルダ名を変更してください。";
    list.append(warn);
  }
}

async function postLocations(url, options) {
  setLocationError("");
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.detail || "保管場所の更新に失敗しました";
    setLocationError(message);
    showToast(message, "error");
    return null;
  }
  applyLocationsPayload(data);
  await deps.reloadProjects();
  return data;
}

async function addProjectLocation() {
  const path = (elements.projectLocationPathInput?.value || "").trim();
  const name = (elements.projectLocationNameInput?.value || "").trim();
  if (!path) {
    setLocationError("保管場所のパスを入力してください");
    return;
  }
  const data = await postLocations("/api/project-locations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      name,
      create: Boolean(elements.projectLocationCreateInput?.checked),
    }),
  });
  if (!data) return;
  if (elements.projectLocationPathInput) elements.projectLocationPathInput.value = "";
  if (elements.projectLocationNameInput) elements.projectLocationNameInput.value = "";
  showToast(`保管場所を追加しました: ${name || path}`);
}

async function setDefaultLocation(locationId) {
  const data = await postLocations("/api/project-locations/default", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: locationId }),
  });
  if (data) showToast(`新規プロジェクトの保存先を「${locationLabel(locationId)}」にしました`);
}

async function renameLocation(loc) {
  const next = window.prompt("保管場所の表示名", loc.name);
  if (next === null) return;
  const name = next.trim();
  if (!name || name === loc.name) return;
  const data = await postLocations(`/api/project-locations/${encodeURIComponent(loc.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (data) showToast("保管場所の名前を変更しました");
}

async function removeLocation(loc) {
  const count = Number(loc.projectCount) || 0;
  const note = count > 0
    ? `\n\nこの場所にある ${count} 件のプロジェクトは一覧に出なくなります。`
    : "";
  const ok = window.confirm(
    `保管場所「${loc.name}」の登録を解除します。\nディスク上のファイルは削除しません。${note}`,
  );
  if (!ok) return;
  const data = await postLocations(`/api/project-locations/${encodeURIComponent(loc.id)}`, {
    method: "DELETE",
  });
  if (data) showToast("保管場所の登録を解除しました");
}

// ---------------------------------------------------------------------------
// プロジェクト移動ダイアログ
// ---------------------------------------------------------------------------

function setMoveError(message) {
  const el = elements.projectMoveError;
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

export function openProjectMoveDialog(project) {
  if (!elements.projectMoveDialog || !project) return;
  state.projectMoveSource = project;
  setMoveError("");
  if (elements.projectMoveDescription) {
    elements.projectMoveDescription.textContent =
      `「${project.title || project.id}」を別の保管場所へ移動します`
      + `（現在: ${locationLabel(project.locationId) || "不明"}）`;
  }
  fillLocationSelect(elements.projectMoveLocationSelect, { excludeId: project.locationId });
  if (!elements.projectMoveLocationSelect?.value) {
    showToast("移動できる保管場所がありません（全体設定で追加してください）", "error");
    state.projectMoveSource = null;
    return;
  }
  elements.projectMoveDialog.showModal();
}

export function closeProjectMoveDialog() {
  elements.projectMoveDialog?.close();
  state.projectMoveSource = null;
  setMoveError("");
}

async function submitProjectMove() {
  const project = state.projectMoveSource;
  if (!project) return;
  const locationId = elements.projectMoveLocationSelect?.value || "";
  if (!locationId) {
    setMoveError("移動先の保管場所を選んでください");
    return;
  }
  const button = elements.confirmProjectMoveButton;
  if (button) button.disabled = true;
  showToast(`「${project.title || project.id}」を移動中…`);
  try {
    // 移動前に「離脱処理」(自動保存 flush / サムネ保存 / 自動バックアップ) を通す。
    // ここを飛ばすと debounce 中の編集が旧パスへ書き戻され、移動後のツリーから
    // 消えたように見える。
    await deps.prepareForMove?.(project);
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.detail || "移動に失敗しました";
      setMoveError(message);
      showToast(message, "error");
      return;
    }
    closeProjectMoveDialog();
    await deps.reloadProjects();
    const notes = [];
    if (data.previousId && data.id !== data.previousId) {
      notes.push(`フォルダ名が重複したため「${data.id}」にしました`);
    }
    if (data.copiedAcrossVolumes) notes.push("別ディスクのためコピーで移動しました");
    if (data.warning) notes.push(data.warning);
    showToast(
      `「${project.title || project.id}」を ${data.locationName} へ移動しました`
      + (notes.length ? ` — ${notes.join(" / ")}` : ""),
    );
    // アクティブプロジェクトを移動した場合、編集画面が握っている ID / パスが
    // 変わりうるので読み直す。
    if (data.activeProjectId && data.activeProjectId === data.id) {
      await deps.reloadActiveProject?.(data.id);
    }
  } catch (error) {
    console.error(error);
    setMoveError("移動に失敗しました（通信エラー）");
    showToast("移動に失敗しました", "error");
  } finally {
    if (button) button.disabled = false;
  }
}
