// ===========================================================================
// トースト通知と busy 状態のボタン制御
// ===========================================================================

import { elements } from "./elements.js";
import { escapeHtml } from "./utils.js";

export function migrateInDialogToasts() {
  // 新しい <dialog> が showModal() で前面に出てきた場合、既存の in-dialog トーストは
  // 下層ダイアログに残り ::backdrop に隠れてしまう。最前面のダイアログへ移し替える。
  const openDialogs = Array.from(document.querySelectorAll("dialog[open]"));
  if (openDialogs.length < 2) return;
  const topDialog = openDialogs[openDialogs.length - 1];
  let topRegion = topDialog.querySelector(":scope > .toast-region.in-dialog");
  for (const dlg of openDialogs) {
    if (dlg === topDialog) continue;
    const old = dlg.querySelector(":scope > .toast-region.in-dialog");
    if (!old) continue;
    if (!topRegion) {
      topRegion = document.createElement("div");
      topRegion.className = "toast-region in-dialog";
      topDialog.append(topRegion);
    }
    while (old.firstChild) topRegion.append(old.firstChild);
    old.remove();
  }
}

export function showToast(message, tone = "ok") {
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  // <dialog>がshowModal()で開かれている間はその top-layer 内に配置しないと
  // ::backdrop の下に隠れるため、最前面の open ダイアログを宿主にする。
  const openDialogs = document.querySelectorAll("dialog[open]");
  const topDialog = openDialogs.length ? openDialogs[openDialogs.length - 1] : null;
  if (topDialog) {
    let region = topDialog.querySelector(":scope > .toast-region.in-dialog");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region in-dialog";
      topDialog.append(region);
    }
    region.append(toast);
  } else {
    elements.toastRegion.append(toast);
  }
  window.setTimeout(() => toast.classList.add("show"), 10);
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 220);
  }, 2600);
}

export async function withBusy(button, label, task) {
  const previousHtml = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="msym button-icon spin" aria-hidden="true">progress_activity</span><span>${escapeHtml(label)}</span>`;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.innerHTML = previousHtml;
  }
}
