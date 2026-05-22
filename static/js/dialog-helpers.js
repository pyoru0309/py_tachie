// 設定ダイアログ／キャラクター管理ダイアログ／コントロールタブの位置・タブ切替に関する純粋なヘルパ群。
// 設定フォームの fillConfigForm / saveConfig / fillTelopDefaultsForm / fillMotionConfigForm /
// collectMotionConfig は別途 app.js 残置（依存が広いため）。

import { state } from "./state.js";
import { elements } from "./elements.js";
import { clamp } from "./utils.js";
import { updateSpeechPreview } from "./settings-form.js";

export function activateSettingsTab(tabId) {
  for (const tab of elements.settingsTabs) {
    tab.classList.toggle("active", tab.dataset.tab === tabId);
  }
  for (const panel of elements.settingsPanels) {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== tabId);
  }
  // セリフ枠タブが新たに見えるようになったら preview を再計算する。display:none の間は
  // stage.clientWidth=0 で計算が初期化スキップされるため、表示直後に 1 回計算し直さないと
  // 装飾画像 / band の位置がゼロサイズのまま残る。
  if (tabId === "speech") {
    // class 切替直後はまだ layout が確定していないので 1 frame 待つ。
    requestAnimationFrame(() => updateSpeechPreview());
  }
  if (elements.settingsDialog?.open) {
    requestAnimationFrame(() => centerSettingsDialog());
  }
}

export function activateControlTab(tabId) {
  for (const tab of elements.controlTabs) {
    tab.classList.toggle("active", tab.dataset.controlTab === tabId);
  }
  // テロップ / 効果音 / 動画レイヤー編集中はカット用タブの選択肢には従わず、
  // 専用ペインを優先表示する。
  if (state.editorTarget === "telop"
      || state.editorTarget === "soundEffect"
      || state.editorTarget === "videoLayer") {
    applyEditorTargetView();
    return;
  }
  for (const pane of elements.controlPanes) {
    pane.classList.toggle("hidden", pane.dataset.controlPane !== tabId);
  }
}

export function applyEditorTargetView() {
  let target = "cut";
  if (state.editorTarget === "telop") target = "telop";
  else if (state.editorTarget === "soundEffect") target = "soundEffect";
  else if (state.editorTarget === "videoLayer") target = "videoLayer";
  document.querySelectorAll(".control-tabs[data-target]").forEach((bar) => {
    bar.classList.toggle("hidden", bar.dataset.target !== target);
  });
  // タイムライン上の「選択◯◯を複製/削除」ボタンのラベルを editor target に同期。
  // ボタンの id は cut 向けの命名のままだが、編集対象に応じてラベル / ツールチップを
  // 差し替える (実処理は app.js 側で dispatch)。
  updateTimelineDuplicateDeleteButtons(target);
  // 「カットへリンク」トグルボタンも選択状態に追従させる。
  // (動的 import で循環依存を回避: dialog-helpers ← scenario-actions ← dialog-helpers)
  import("./scenario-actions.js").then((m) => m.updateLinkToggleButton?.()).catch(() => {});
  if (target === "telop") {
    for (const pane of elements.controlPanes) {
      pane.classList.toggle("hidden", pane.dataset.controlPane !== "telop");
    }
    return;
  }
  if (target === "soundEffect") {
    for (const pane of elements.controlPanes) {
      pane.classList.toggle("hidden", pane.dataset.controlPane !== "soundEffect");
    }
    return;
  }
  if (target === "videoLayer") {
    for (const pane of elements.controlPanes) {
      pane.classList.toggle("hidden", pane.dataset.controlPane !== "videoLayer");
    }
    return;
  }
  // カット編集モード: アクティブな control-tab に従う。
  const activeTab = document.querySelector(".control-tabs[data-target='cut'] .control-tab.active");
  const tabId = activeTab?.dataset?.controlTab || "character";
  for (const pane of elements.controlPanes) {
    pane.classList.toggle("hidden", pane.dataset.controlPane !== tabId);
  }
}

function updateTimelineDuplicateDeleteButtons(target) {
  const duplicateBtn = elements.duplicateSelectedCutsButton;
  const deleteBtn = elements.deleteSelectedCutsButton;
  const labels = {
    cut: { dup: "選択カットを複製", del: "選択カットを削除", dupTip: "選択カットを複製", delTip: "選択カットを削除" },
    telop: { dup: "選択テロップを複製", del: "選択テロップを削除", dupTip: "選択テロップを複製 (Shift+D)", delTip: "選択テロップを削除 (Backspace)" },
    soundEffect: { dup: "選択効果音を複製", del: "選択効果音を削除", dupTip: "選択効果音を複製 (Shift+D)", delTip: "選択効果音を削除 (Backspace)" },
    videoLayer: { dup: "選択動画を複製", del: "選択動画を削除", dupTip: "選択動画を複製 (Shift+D)", delTip: "選択動画を削除 (Backspace)" },
  };
  const set = labels[target] || labels.cut;
  if (duplicateBtn) {
    const label = duplicateBtn.querySelector("span:not(.msym)");
    if (label) label.textContent = set.dup;
    duplicateBtn.title = set.dupTip;
  }
  if (deleteBtn) {
    const label = deleteBtn.querySelector("span:not(.msym)");
    if (label) label.textContent = set.del;
    deleteBtn.title = set.delTip;
  }
  // 「再生位置で分割」ボタンも編集対象に合わせてラベル / tooltip を切替。
  // 効果音 / 動画は新しい素材ファイルを作らず durationFrame・audioOffsetSec /
  // trimStartSec・trimEndSec の調整で疑似分割する。
  const splitBtn = elements.splitCutAtPlayheadButton;
  if (splitBtn) {
    const splitLabels = {
      cut: { text: "再生位置でカット分割", tip: "再生位置でカットを 2 つに分割します（後半は音声・セリフ空）" },
      soundEffect: { text: "再生位置で音声分割", tip: "再生位置で効果音を 2 つに疑似分割します（同じ素材の続きとして開始位置をずらす）" },
      videoLayer: { text: "再生位置で動画分割", tip: "再生位置で動画レイヤーを 2 つに疑似分割します（trim 範囲を分けて新素材は作らない）" },
    };
    // テロップは分割非対応 → カット分割の文言にフォールバック
    const sp = splitLabels[target] || splitLabels.cut;
    const splitLabel = splitBtn.querySelector("span:not(.msym)");
    if (splitLabel) splitLabel.textContent = sp.text;
    splitBtn.title = sp.tip;
  }
}

export function clampDialogPosition(left, top) {
  const rect = elements.settingsDialog.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  return {
    left: clamp(left, 0, maxLeft),
    top: clamp(top, 0, maxTop),
  };
}

export function positionSettingsDialog(left, top) {
  const position = clampDialogPosition(left, top);
  elements.settingsDialog.style.left = `${position.left}px`;
  elements.settingsDialog.style.top = `${position.top}px`;
  elements.settingsDialog.style.margin = "0";
}

export function centerSettingsDialog() {
  const rect = elements.settingsDialog.getBoundingClientRect();
  positionSettingsDialog((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
}

export function centerDialog(dialog) {
  const rect = dialog.getBoundingClientRect();
  dialog.style.left = `${Math.max(0, (window.innerWidth - rect.width) / 2)}px`;
  dialog.style.top = `${Math.max(0, (window.innerHeight - rect.height) / 2)}px`;
  dialog.style.margin = "0";
}

export function bindSettingsDrag() {
  const header = elements.settingsDialog.querySelector(".dialog-header");
  if (!header) {
    return;
  }
  let drag = null;
  header.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, input, select, textarea")) {
      return;
    }
    const rect = elements.settingsDialog.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    header.setPointerCapture(event.pointerId);
  });
  header.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    positionSettingsDialog(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
  });
  header.addEventListener("pointerup", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    drag = null;
    header.releasePointerCapture(event.pointerId);
  });
}
