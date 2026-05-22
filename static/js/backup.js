// scenarios/main.json バックアップ機能。
//   - 周期 (global_config.backup.autoIntervalMinutes 分) で auto バックアップ
//   - プロジェクト切替 / ダッシュボード復帰時にも auto バックアップを取る
//   - 「バックアップ」ボタンクリックで manual バックアップ
//   - プロジェクト設定の「バックアップ」タブで一覧 / 復元 / 削除
//
// auto は古い順に削除されて (global_config.backup.autoRetentionCount 件保持)、
// manual / preRestore (= restore 直前の安全網) は設定 UI からのみ削除可。

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy } from "./toast.js";
import { saveScenario, updateSelectedCutFromCurrent } from "./scenario-actions.js";

let autoTimer = null;
let backupInFlight = null;

export async function fetchBackupList(projectId) {
  if (!projectId) return [];
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/backups`);
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return Array.isArray(data.backups) ? data.backups : [];
}

// 1 件作成。kind="auto" はサーバ側で前回と内容が同じならスキップ (returns {skipped:true})。
export async function createBackup(projectId, kind = "manual") {
  if (!projectId) return null;
  // 直前の作成と並走させない (同秒衝突や save 競合を避ける)
  if (backupInFlight) {
    try {
      await backupInFlight;
    } catch (_e) {
      // 直前の失敗は無視して新規 attempt
    }
  }
  const promise = (async () => {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/backups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  })();
  backupInFlight = promise;
  try {
    return await promise;
  } finally {
    if (backupInFlight === promise) backupInFlight = null;
  }
}

export async function restoreBackup(projectId, backupId) {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(backupId)}/restore`,
    { method: "POST" }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteBackupOnServer(projectId, backupId) {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(backupId)}`,
    { method: "DELETE" }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// auto バックアップを取る (バックアップ前に編集中状態を保存する)。
// 失敗は warn のみ。auto trigger に乗せるため例外を呼び出し側に投げない。
//
// ★ saveScenario / createBackup 両方とも引数で受けた projectId を明示的に対象とする。
//   以前は saveScenario が active project 依存で、backup は引数 projectId を使うため
//   「保存は active、backup は引数」のねじれが起きていた (= 切替中の race)。
async function takeAutoBackupSafely(projectId) {
  if (!projectId) return;
  try {
    // 編集中の cut state を scenario に反映してから save → backup
    try { updateSelectedCutFromCurrent(); } catch (_e) {}
    try {
      await saveScenario({ silent: true, projectId });
    } catch (error) {
      console.warn("[backup] scenario 保存に失敗したため auto バックアップをスキップ", error);
      return;
    }
    await createBackup(projectId, "auto");
  } catch (error) {
    console.warn("[backup] auto バックアップに失敗", error);
  }
}

// 周期タイマー。global_config.backup.autoIntervalMinutes (分) で起動。
// アクティブなプロジェクトがあり、編集画面 (ダッシュボードでない) のときだけ走る。
export function startAutoBackupTimer() {
  stopAutoBackupTimer();
  // state.globalConfig は API レスポンス全体 (= { config: {...}, ...meta })。
  // backup 設定は config.backup 配下。未取得時のフォールバックは 5 分。
  const interval = Math.max(
    1,
    Math.min(
      120,
      Number(state.globalConfig?.config?.backup?.autoIntervalMinutes ?? 5)
    )
  );
  const intervalMs = interval * 60 * 1000;
  autoTimer = window.setInterval(() => {
    const pid = state.activeProjectId;
    if (!pid) return;
    if (state.projectDashboardVisible) return;
    takeAutoBackupSafely(pid);
  }, intervalMs);
}

export function stopAutoBackupTimer() {
  if (autoTimer != null) {
    window.clearInterval(autoTimer);
    autoTimer = null;
  }
}

// プロジェクト切替 / ダッシュボード復帰の直前に呼び出す flush。
// 切替後に旧プロジェクトの編集が失われないよう、scenario を保存してから backup を作る。
export async function flushAutoBackupOnLeave(projectId) {
  if (!projectId) return;
  await takeAutoBackupSafely(projectId);
}

// ---- バックアップ一覧 UI (プロジェクト設定ダイアログ) ---------------------

function formatBackupCreatedAt(iso) {
  // 例: "2026-05-12T05:55:58" → "2026/05/12 05:55:58"
  try {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m) return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  } catch (_e) {}
  return iso || "";
}

function formatBackupSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const KIND_LABEL = {
  auto: { label: "自動", title: "周期 / プロジェクト切替時に自動取得" },
  manual: { label: "手動", title: "「バックアップ」ボタンで取得 (自動削除されません)" },
  preRestore: { label: "復元前", title: "Restore 直前に自動取得 (自動削除されません)" },
};

let manualRestoreHandler = null;

export function bindBackupRestoreHandler(handler) {
  manualRestoreHandler = handler;
}

function renderBackupList(backups) {
  const body = elements.backupListBody;
  const table = elements.backupList;
  const empty = elements.backupListEmpty;
  if (!body || !table || !empty) return;
  body.replaceChildren();
  if (!backups.length) {
    table.hidden = true;
    empty.hidden = false;
    return;
  }
  table.hidden = false;
  empty.hidden = true;
  for (const item of backups) {
    const tr = document.createElement("tr");
    tr.dataset.backupId = item.id;

    const cellTime = document.createElement("td");
    cellTime.textContent = formatBackupCreatedAt(item.createdAt);
    tr.appendChild(cellTime);

    const cellKind = document.createElement("td");
    const meta = KIND_LABEL[item.kind] || { label: item.kind, title: item.kind };
    const badge = document.createElement("span");
    badge.className = `backup-kind backup-kind-${item.kind}`;
    badge.textContent = meta.label;
    badge.title = meta.title;
    cellKind.appendChild(badge);
    tr.appendChild(cellKind);

    const cellSize = document.createElement("td");
    cellSize.textContent = formatBackupSize(item.size);
    tr.appendChild(cellSize);

    const cellActions = document.createElement("td");
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "link-button";
    restoreBtn.textContent = "復元";
    restoreBtn.addEventListener("click", () => onRestoreClick(item));
    cellActions.appendChild(restoreBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "link-button link-button-danger";
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", () => onDeleteClick(item));
    cellActions.appendChild(deleteBtn);

    tr.appendChild(cellActions);
    body.appendChild(tr);
  }
}

export async function refreshBackupList() {
  const pid = state.activeProjectId;
  if (!pid) {
    renderBackupList([]);
    return;
  }
  try {
    const list = await fetchBackupList(pid);
    renderBackupList(list);
  } catch (error) {
    console.warn("[backup] 一覧取得失敗", error);
    renderBackupList([]);
    showToast(`バックアップ一覧の取得に失敗しました: ${error?.message || error}`, "error");
  }
}

async function onRestoreClick(item) {
  const pid = state.activeProjectId;
  if (!pid) return;
  const label = KIND_LABEL[item.kind]?.label || item.kind;
  const when = formatBackupCreatedAt(item.createdAt);
  const ok = window.confirm(
    `${when} の「${label}」バックアップで現在の scenarios/main.json を上書きします。\n` +
    "現状は自動的に「復元前」バックアップに保存されます。\n\n復元を実行しますか？"
  );
  if (!ok) return;
  try {
    const result = await restoreBackup(pid, item.id);
    if (typeof manualRestoreHandler === "function") {
      await manualRestoreHandler(result);
    }
    await refreshBackupList();
    showToast("バックアップから復元しました", "success");
  } catch (error) {
    console.error(error);
    showToast(`復元に失敗しました: ${error?.message || error}`, "error");
  }
}

async function onDeleteClick(item) {
  const pid = state.activeProjectId;
  if (!pid) return;
  const label = KIND_LABEL[item.kind]?.label || item.kind;
  const when = formatBackupCreatedAt(item.createdAt);
  const ok = window.confirm(`${when} の「${label}」バックアップを削除します。よろしいですか？`);
  if (!ok) return;
  try {
    await deleteBackupOnServer(pid, item.id);
    await refreshBackupList();
    showToast("バックアップを削除しました", "success");
  } catch (error) {
    console.error(error);
    showToast(`削除に失敗しました: ${error?.message || error}`, "error");
  }
}

export function bindBackup() {
  elements.manualBackupButton?.addEventListener("click", () => {
    const pid = state.activeProjectId;
    if (!pid) {
      showToast("プロジェクトがアクティブではありません", "warning");
      return;
    }
    withBusy(elements.manualBackupButton, "バックアップ中", async () => {
      try { updateSelectedCutFromCurrent(); } catch (_e) {}
      // 手動バックアップでも project-scoped save に揃える (active project 依存を避ける)。
      await saveScenario({ silent: true, projectId: pid });
      const result = await createBackup(pid, "manual");
      if (result?.backup) {
        showToast("手動バックアップを作成しました", "success");
      } else {
        showToast("バックアップ対象のシナリオがありません", "warning");
      }
    }).catch((error) => {
      console.error(error);
      showToast(`手動バックアップに失敗しました: ${error?.message || error}`, "error");
    });
  });

  // プロジェクト設定ダイアログ「バックアップ」タブの操作 UI。
  // タブ切替時に list refresh するため、タブボタン側で別途 refreshBackupList() を呼ぶ。
  elements.refreshBackupListButton?.addEventListener("click", () => {
    refreshBackupList();
  });
  elements.createManualBackupButton?.addEventListener("click", () => {
    elements.manualBackupButton?.click();
    // 完了後に一覧を更新 (バックアップ作成が完了するまで少し待つ)
    setTimeout(() => refreshBackupList(), 500);
  });
}
