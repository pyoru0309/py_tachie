import { state } from "./state.js";
import { elements } from "./elements.js";
import { option, formatProjectDate } from "./utils.js";
import { showToast } from "./toast.js";
import { recordHistory, clearHistory } from "./history.js";
import { stopPreviewPlayback } from "./playback.js";
import { captureAndUploadThumbnail } from "./thumbnail.js";
import { flushAutoBackupOnLeave } from "./backup.js";
import { cancelPendingScenarioSave } from "./scenario-actions.js";

// 編集画面を離れる直前 (= ダッシュボード遷移 / 別プロジェクトへ切替 / 新規プロジェクト
// 作成 / プロジェクト削除) に、現在の v2 GL canvas をサムネとして保存する。
// stopPreviewPlayback({hard:true}) や activateProject の fetch などで scene が
// 破棄される/別プロジェクトに付け変わる前に呼ぶ必要がある。
// 失敗しても遷移自体はブロックしない (best-effort)。
async function captureLeavingThumbnail() {
  try {
    await captureAndUploadThumbnail({ force: true });
  } catch (err) {
    console.warn("[thumbnail] leave capture failed:", err);
  }
}

let deps = {
  reloadProjectData: async () => {},
  clearProjectData: () => {},
};

export function bindProject(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  // ZIP 読み込み: ボタンクリックで <input type="file"> を click() し、change で取り込む。
  if (elements.dashboardImportProjectButton && elements.dashboardImportProjectFile) {
    elements.dashboardImportProjectButton.addEventListener("click", () => {
      elements.dashboardImportProjectFile.value = "";
      elements.dashboardImportProjectFile.click();
    });
    elements.dashboardImportProjectFile.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await importProjectFromFile(file);
      } finally {
        event.target.value = "";
      }
    });
  }
}

export function fillProjectSelect() {
  elements.projectSelect.innerHTML = "";
  // プロジェクト切替中は state.manifest が直前プロジェクトのまま残る瞬間がある。
  // セレクタ表示は state.activeProjectId を優先し、古い manifest.projectId に引き戻されないようにする。
  const activeId = state.activeProjectId || state.manifest?.projectId;
  const recentProjects = sortedProjects("recent").slice(0, 10);
  if (activeId && !recentProjects.some((project) => project.id === activeId)) {
    const active = state.projects.find((project) => project.id === activeId);
    if (active) {
      recentProjects.unshift(active);
    }
  }
  for (const project of recentProjects) {
    elements.projectSelect.append(option(project.title || project.id, project.id));
  }
  if (activeId) {
    elements.projectSelect.value = activeId;
  }
  const active = state.projects.find((project) => project.id === elements.projectSelect.value);
  elements.projectSelect.disabled = state.projects.length === 0;
  const activeTitle = active ? (active.title || active.id) : "";
  document.title = activeTitle ? `立ち絵システム - ${activeTitle}` : "立ち絵システム";
}

export function projectTimestamp(project, key) {
  return Date.parse(project[key] || "") || 0;
}

export function sortedProjects(sortMode = elements.projectSort?.value || "recent") {
  const projects = [...state.projects];
  if (sortMode === "name") {
    projects.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id, "ja"));
    return projects;
  }
  if (sortMode === "created") {
    projects.sort((a, b) => projectTimestamp(b, "createdAt") - projectTimestamp(a, "createdAt"));
    return projects;
  }
  if (sortMode === "updated") {
    projects.sort((a, b) => projectTimestamp(b, "updatedAt") - projectTimestamp(a, "updatedAt"));
    return projects;
  }
  projects.sort((a, b) => {
    const aTime = projectTimestamp(a, "lastOpenedAt") || projectTimestamp(a, "updatedAt");
    const bTime = projectTimestamp(b, "lastOpenedAt") || projectTimestamp(b, "updatedAt");
    return bTime - aTime;
  });
  return projects;
}

export function filteredProjects() {
  const nameQuery = (elements.projectNameFilter.value || "").trim().toLowerCase();
  const dateQuery = elements.projectDateFilter.value || "";
  return sortedProjects().filter((project) => {
    const name = `${project.title || ""} ${project.id || ""}`.toLowerCase();
    const dates = [project.updatedAt, project.createdAt, project.lastOpenedAt].filter(Boolean).join(" ");
    return (!nameQuery || name.includes(nameQuery)) && (!dateQuery || dates.includes(dateQuery));
  });
}

export function renderProjectDashboard() {
  elements.projectGrid.innerHTML = "";
  const projects = filteredProjects();
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dashboard-empty";
    empty.textContent = "条件に合うプロジェクトがありません";
    elements.projectGrid.append(empty);
    return;
  }
  for (const project of projects) {
    const card = document.createElement("div");
    card.role = "button";
    card.tabIndex = 0;
    card.className = `project-card${project.active ? " active" : ""}`;

    const thumb = document.createElement("div");
    thumb.className = "project-thumb";
    if (project.thumbnail) {
      const image = document.createElement("img");
      image.alt = "";
      // project.thumbnail には server 側で `?v=<mtime>` が付くので、
      // ここで追加のキャッシュバスターは不要。スクロール外のカードは遅延 fetch する。
      image.loading = "lazy";
      image.decoding = "async";
      image.src = project.thumbnail;
      thumb.append(image);
    } else {
      thumb.textContent = "No Preview";
    }

    const title = document.createElement("div");
    title.className = "project-card-title";
    title.textContent = project.title || project.id;

    const meta = document.createElement("div");
    meta.className = "project-card-meta";
    meta.textContent = `更新 ${formatProjectDate(project.updatedAt || project.createdAt)}`;

    const actions = document.createElement("div");
    actions.className = "project-card-actions";
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "project-rename-button";
    renameButton.textContent = "名称変更";
    renameButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectForm("rename", project);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "project-delete-button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      confirmDeleteProject(project);
    });
    const duplicateButton = document.createElement("button");
    duplicateButton.type = "button";
    duplicateButton.className = "project-rename-button";
    duplicateButton.textContent = "複製";
    duplicateButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectDuplicateDialog(project);
    });

    const archiveButton = document.createElement("button");
    archiveButton.type = "button";
    archiveButton.className = "project-rename-button";
    archiveButton.textContent = "アーカイブ";
    archiveButton.title = "ZIP でダウンロード";
    archiveButton.addEventListener("click", (event) => {
      event.stopPropagation();
      downloadProjectArchive(project);
    });

    actions.append(renameButton, duplicateButton, archiveButton, deleteButton);

    card.append(thumb, title, meta, actions);
    const openProject = () => {
      activateProject(project.id, { hideDashboard: true }).catch((error) => {
        console.error(error);
        showToast("プロジェクトを開けませんでした", "error");
      });
    };
    card.addEventListener("click", openProject);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProject();
      }
    });
    elements.projectGrid.append(card);
  }
}

export function confirmDeleteProject(project) {
  const expectedName = project.title || project.id;
  state.projectDeleteTarget = project;
  elements.projectDeleteDescription.textContent = `削除するには「${expectedName}」または「${project.id}」と入力してください`;
  elements.projectDeleteConfirm.value = "";
  elements.confirmProjectDeleteButton.disabled = true;
  elements.projectDeleteDialog.showModal();
  requestAnimationFrame(() => {
    elements.projectDeleteConfirm.focus();
  });
}

export function closeProjectDeleteDialog() {
  elements.projectDeleteDialog.close();
  state.projectDeleteTarget = null;
  elements.projectDeleteConfirm.value = "";
  elements.confirmProjectDeleteButton.disabled = true;
}

export async function deleteProjectFromDialog() {
  const project = state.projectDeleteTarget;
  if (!project) {
    return;
  }
  const expectedName = project.title || project.id;
  const confirmation = elements.projectDeleteConfirm.value.trim();
  if (confirmation !== expectedName && confirmation !== project.id) {
    elements.confirmProjectDeleteButton.disabled = true;
    showToast("プロジェクト名が一致しません", "error");
    return;
  }
  // 削除対象が現アクティブと別なら、現アクティブの v2 GL canvas をサムネとして
  // 保存しておく (delete 後 reloadProjectData で別プロジェクトを load する場合
  // でも、旧アクティブの絵が次回まで残るように)。削除対象が現アクティブの場合は、
  // 削除直前の POST も project ディレクトリ撤去で消えるだけなので無害。
  await captureLeavingThumbnail();

  const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  closeProjectDeleteDialog();
  await loadProjects();
  if (result.activeProjectId || state.projects.length > 0) {
    await deps.reloadProjectData();
  } else {
    deps.clearProjectData();
  }
  // delete 直後の dashboard 表示は「離脱でない」(= 旧 scene は既に破棄済み or
  // 別プロジェクトに置き換わっている) ので capture をスキップ。
  await showProjectDashboard({ captureBeforeLeave: false });
  showToast(`プロジェクトを削除しました: ${result.deleted}`);
}

// 現在の view ("editor" / "dashboard") をサーバへ非同期保存する。
// リロード / 再起動でも最後に開いていた画面が復元できるよう ui_state.json に
// 書き出す。失敗しても画面遷移自体は止めないので fire-and-forget。
function persistUiView(view) {
  fetch("/api/ui-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view }),
    keepalive: true,
  }).catch(() => null);
}

export async function showProjectDashboard({ captureBeforeLeave = true } = {}) {
  // ダッシュボードを開くと「編集画面の絵」は不要になる。hard=true で
  // audio / BGM / video element の src / v2 GL scene まで完全停止する。
  // これを怠ると:
  //   - DOM <video> が裏で再生され続けて音が鳴る
  //   - VideoTexture / Pillow texture が古いプロジェクト素材を掴み続ける
  //   - 次プロジェクトを開いたとき token が衝突して旧 scene を reuse する
  // skipPreviewRefresh は hard で自動 true。
  //
  // captureBeforeLeave=true (既定): hard 停止で v2 scene が破棄される前に、
  //   現在の v2 GL canvas をサムネとして保存する (= プロジェクトを離れる瞬間
  //   の絵がそのままサムネ化される)。captureAndUploadThumbnail は内部で
  //   state.projects[].thumbnail を新しい URL に置き換えるため、後続の
  //   renderProjectDashboard だけで一覧カードに反映される。
  // captureBeforeLeave=false: アプリ初期化など「離脱ではない場合」用。
  if (captureBeforeLeave) {
    // 旧プロジェクトの編集を auto バックアップに記録 (scene 破棄前に scenarios/main.json
    // を保存しスナップショットを取る)。失敗は warn だけで遷移は止めない。
    await flushAutoBackupOnLeave(state.activeProjectId);
    await captureLeavingThumbnail();
  }
  stopPreviewPlayback({ hard: true });
  state.projectDashboardVisible = true;
  elements.projectDashboard.classList.remove("hidden");
  renderProjectDashboard();
  clearHistory();
  persistUiView("dashboard");
}

export function hideProjectDashboard() {
  state.projectDashboardVisible = false;
  elements.projectDashboard.classList.add("hidden");
  if (state.scenario && state.history.stack.length === 0) {
    recordHistory();
  }
  persistUiView("editor");
}

export async function loadProjects() {
  const response = await fetch("/api/projects");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  state.activeProjectId = result.activeProjectId || "";
  state.projects = result.projects || [];
  fillProjectSelect();
  renderProjectDashboard();
  return result;
}

export function openProjectForm(mode, project = null) {
  state.projectFormMode = mode;
  state.projectFormProjectId = project?.id || null;
  elements.projectFormTitle.textContent = mode === "rename" ? "プロジェクト名称変更" : "プロジェクト作成";
  elements.projectFormDescription.textContent =
    mode === "rename" ? "新しいプロジェクト名を入力してください" : "プロジェクト名を入力してください";
  elements.projectTitle.value = mode === "rename" ? project?.title || project?.id || "" : "";
  elements.projectFormDialog.showModal();
  window.setTimeout(() => {
    elements.projectTitle.focus();
    elements.projectTitle.select();
  }, 0);
}

export function closeProjectForm() {
  elements.projectFormDialog.close();
  state.projectFormMode = "create";
  state.projectFormProjectId = null;
}

export async function activateProject(projectId, options = {}) {
  // 旧プロジェクトを離れる前に、現在の v2 GL canvas をサムネとして保存する。
  // activate fetch → reloadProjectData の中で stopPreviewPlayback({hard:true}) が
  // 走って scene が破棄され、loadProjects で state.activeProjectId が新しい id に
  // 切り替わるため、capture はここ (旧 activeProjectId / 旧 scene が生きている
  // 状態) で済ませる必要がある。
  // 同様に scenario の auto バックアップも切替前 (= まだ activeProjectId が旧
  // プロジェクトを指している間) に flush する必要がある。
  //
  // ★ 未発火の自動保存タイマー (scheduleScenarioSave の 700ms debounce) を必ず
  //   止めて同期 flush する。これを忘れると、切替後に server active が新
  //   プロジェクトになった瞬間に旧 payload が `/api/scenario` 経由で新 active へ
  //   書き込まれ、新プロジェクトの main.json が旧 state で上書きされる事故になる
  //   (= dj2 の中身が動画テスト２のコピーに置換される現象の本命)。
  await cancelPendingScenarioSave({ flush: true });
  await flushAutoBackupOnLeave(state.activeProjectId);
  await captureLeavingThumbnail();

  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/activate`, { method: "POST" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json().catch(() => null);
  const activatedProjectId = result?.activeProjectId || projectId;
  state.activeProjectId = activatedProjectId;
  // ダッシュボードは reloadProjectData の前に閉じる。reloadProjectData は manifest /
  // scenario / loadCut / renderPreview まで走るので、await すると 1〜2 秒は遷移が
  // 始まらず「クリックしても何も起きない」と感じやすい。先に編集画面に切り替えて
  // しまえば、scene build 中は previewImage / 空 canvas が見えるだけで済む。
  if (options.hideDashboard) {
    hideProjectDashboard();
  }
  await deps.reloadProjectData({ projectId: activatedProjectId });
  showToast("プロジェクトを切り替えました");
}

export async function createProject(title) {
  if (!title) {
    return;
  }
  // 新規作成すると activeProjectId が新プロジェクトに切り替わるため、
  // 旧プロジェクトを離れる前に現在の v2 GL canvas をサムネとして保存しておく。
  // 自動保存タイマーも flush して race を防ぐ (activateProject と同じ理由)。
  await cancelPendingScenarioSave({ flush: true });
  await captureLeavingThumbnail();

  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json().catch(() => null);
  const createdProjectId = result?.id || result?.project?.id || state.activeProjectId || "";
  if (createdProjectId) state.activeProjectId = createdProjectId;
  await deps.reloadProjectData({ projectId: createdProjectId });
  hideProjectDashboard();
  showToast("プロジェクトを作成しました");
}

// ===========================================================================
// プロジェクト複製
// ===========================================================================

export function openProjectDuplicateDialog(project) {
  if (!elements.projectDuplicateDialog) return;
  state.projectDuplicateSource = project;
  elements.projectDuplicateDescription.textContent =
    `「${project.title || project.id}」を複製します。新しいプロジェクト名を入力してください（既存名は使用不可）`;
  elements.projectDuplicateTitleInput.value = `${project.title || project.id} のコピー`;
  elements.projectDuplicateError.hidden = true;
  elements.projectDuplicateError.textContent = "";
  elements.projectDuplicateDialog.showModal();
  requestAnimationFrame(() => {
    elements.projectDuplicateTitleInput.focus();
    elements.projectDuplicateTitleInput.select();
  });
}

export function closeProjectDuplicateDialog() {
  if (!elements.projectDuplicateDialog) return;
  elements.projectDuplicateDialog.close();
  state.projectDuplicateSource = null;
}

export async function submitProjectDuplicate() {
  const project = state.projectDuplicateSource;
  if (!project) return;
  const newTitle = elements.projectDuplicateTitleInput.value.trim();
  if (!newTitle) {
    elements.projectDuplicateError.hidden = false;
    elements.projectDuplicateError.textContent = "新しいプロジェクト名を入力してください";
    return;
  }
  // クライアント側で既存タイトル衝突チェック
  const conflict = (state.projects || []).some((p) => (p.title || p.id) === newTitle);
  if (conflict) {
    elements.projectDuplicateError.hidden = false;
    elements.projectDuplicateError.textContent = `プロジェクト名「${newTitle}」は既に使われています`;
    return;
  }
  const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: newTitle }),
  });
  if (!response.ok) {
    const errText = await response.text();
    elements.projectDuplicateError.hidden = false;
    elements.projectDuplicateError.textContent = errText || "複製に失敗しました";
    return;
  }
  closeProjectDuplicateDialog();
  await loadProjects();
  renderProjectDashboard();
  showToast(`プロジェクトを複製しました: ${newTitle}`);
}

// ===========================================================================
// プロジェクト ZIP 入出力 (詳細は app/project_archive.py / app/project_import.py)
// ===========================================================================

export function downloadProjectArchive(project) {
  if (!project?.id) return;
  // <a download> を介すと Content-Disposition のファイル名が尊重される。
  const url = `/api/projects/${encodeURIComponent(project.id)}/archive`;
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  // download 属性は同オリジンなのでファイル名上書き可。サーバ送出名を尊重する
  // ため空文字を指定 (これで Content-Disposition の filename が使われる)。
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  showToast(`「${project.title || project.id}」のアーカイブを生成中…`);
}

export async function importProjectFromFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  showToast(`「${file.name}」を取り込み中…`);
  let response;
  try {
    response = await fetch("/api/projects/import", { method: "POST", body: form });
  } catch (error) {
    console.error(error);
    showToast("取り込みに失敗しました（ネットワーク）", "error");
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(data?.detail || "ZIP の取り込みに失敗しました", "error");
    return;
  }
  await loadProjects();
  renderProjectDashboard();
  const warnings = (data.warnings || []).join(" / ");
  const versionNote =
    data.fromVersion && data.toVersion && data.fromVersion !== data.toVersion
      ? `（v${data.fromVersion} → v${data.toVersion}）`
      : "";
  showToast(
    `プロジェクトを取り込みました: ${data.title || data.id}${versionNote}${warnings ? " — " + warnings : ""}`,
  );
}

export async function renameProject(projectId, title) {
  const wasActive = state.activeProjectId === projectId;
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  await loadProjects();
  // 名称変更で active プロジェクトの ID (= ディスク上 slug) が変わると、編集側に
  // 残っている state.manifest 内の asset URL が古い `/assets/projects/<old_id>/...`
  // を指したままになる (ダッシュボードを閉じると素材が 404 する)。
  // active project が改名されたケースだけ editor 側を再フェッチして整合させる。
  if (wasActive && state.activeProjectId && state.activeProjectId !== projectId) {
    await deps.reloadProjectData();
  }
  showToast("プロジェクト名を変更しました");
}

export async function submitProjectForm() {
  const title = elements.projectTitle.value.trim();
  if (!title) {
    showToast("プロジェクト名を入力してください", "error");
    return;
  }
  if (state.projectFormMode === "rename" && state.projectFormProjectId) {
    await renameProject(state.projectFormProjectId, title);
  } else {
    await createProject(title);
  }
  closeProjectForm();
}
