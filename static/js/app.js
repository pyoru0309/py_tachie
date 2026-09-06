import { opacityToUi, debounce, normalizeColorValue } from "./utils.js";
import { bindTimecodeInput, PROJECT_FPS, parseTimecode } from "./timecode.js";
import { cutDurationFrame, cutStartSec, cutDurationSec, recalcCutStartSec, cutTransition } from "./scenario.js";
import { recordHistory } from "./history.js";
import {
  fillFontWeights,
  fillDefaultFontWeights,
  fillTelopDefaultFontWeights,
  registerProjectFonts,
  watchSystemFontsReady,
} from "./font.js";
import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy } from "./toast.js";
import { initTheme } from "./theme.js";
import { attachScenarioCutsAlias } from "./scenario.js";
import { bindExport } from "./export.js";
import {
  bindBackup,
  bindBackupRestoreHandler,
  refreshBackupList,
  startAutoBackupTimer,
  stopAutoBackupTimer,
  flushAutoBackupOnLeave,
} from "./backup.js";
import { bindPsdImporter } from "./psd-importer.js";
import { fetchGlobalConfig, bindGlobalSettings } from "./global-settings.js";
import { bindAllToolbarOverflow } from "./toolbar-overflow.js";
import { fetchTtsState } from "./tts.js";
import {
  bindDialogueVoice,
  syncDialogueVoiceFromSpeaker,
} from "./voice-dialogue.js";
import { openCharacterLayerEditor, bindCharacterLayerEditor } from "./character-layer-editor.js";
import { bindCharacterLayoutDialog } from "./character-layout-dialog.js";
import {
  fillPlacementPresets,
  applySelectedPlacementPreset,
  saveCurrentPlacementPreset,
  deleteCurrentPlacementPreset,
  bindPlacementPresets,
} from "./character-placement-presets.js";
import { bindMotionPivotPicker, exitMotionPivotPicking } from "./motion-pivot-picker.js";
import { bindPreviewInteractions } from "./preview-interactions.js";
import {
  getActiveScene as _v2GetActiveScene,
  redrawActiveScene as _v2RedrawActiveScene,
  getActiveWorldTransform as _v2GetActiveWorldTransform,
} from "./renderer/index.js";
import {
  openAssetExpressionPresets,
  bindAssetExpressionPresets,
} from "./asset-expression-presets.js";
import {
  openAssetHairstylePresets,
  bindAssetHairstylePresets,
} from "./asset-hairstyle-presets.js";
import {
  bindTimeline,
  bindPlayheadInfo,
  setupTimelineCanvas,
  stepPlayheadFrame,
  stepPlayheadFrames,
  seekPlayheadToStart,
  seekPlayheadToEnd,
  addTimelineLane,
  removeEmptyTimelineLane,
  renderTelopTrack,
} from "./timeline.js";
import { shiftCharKerningForEdit } from "./renderer/text-layout.js";
import {
  bindTelop,
  defaultTelop,
  selectTelop,
  clearTelopSelection,
  setMultiTelopSelection,
  selectAllTelops,
  addTelop,
  openAddTelopBatchDialog,
  bindAddTelopBatchDialog,
  renderTelopEditor,
} from "./telop.js";
import {
  bindCharacter,
  selectedCharacter,
  characterDefinitionById,
  loadCharacterIntoControls,
  renderCharacterSelect,
  centerCharacter,
  resetCharacter,
  selectCutCharacter,
  addCharacter,
  deleteCharacter,
  moveCharacter,
  replaceCharacterAcrossAllCuts,
} from "./character.js";
import {
  bindPlayback,
  renderPreview,
  stopPreviewPlayback,
  playPreviewPlayback,
  setTogglePlayUi,
  warmSceneBundleForPrerender,
} from "./playback.js";
import {
  bindPrerender,
  runPrerenderAll,
  cancelPrerender,
  isPrerendering,
} from "./prerender.js";
import {
  bindProject,
  fillProjectSelect,
  renderProjectDashboard,
  closeProjectDeleteDialog,
  deleteProjectFromDialog,
  showProjectDashboard,
  hideProjectDashboard,
  loadProjects,
  openProjectForm,
  closeProjectForm,
  activateProject,
  closeProjectDuplicateDialog,
  submitProjectDuplicate,
  submitProjectForm,
} from "./project.js";
import {
  bindAssets,
  refreshAssetManager,
  ensureCommonInventoryLoaded,
  ensureProjectInventoryLoaded,
  bindAssetManager,
} from "./assets.js";
import {
  bindDialog,
  commitSceneFromDialog,
  applySceneFieldsFromDialog,
  fillSceneDialog,
  addSceneBgmTrack,
  openSceneDialog,
  closeSceneDialog,
  applyCharacterToAllCuts,
  applyDialogTextStyleToAllCuts,
  applyDialogBoxStyleToAllCuts,
  applyEffectSceneToAllCuts,
  applyKenBurnsToAllCuts,
  openProjectSettingsDialog,
  applyEffectCharacterToAllCuts,
  applyTelopDefaultsToAllTelops,
  promptBulkApply,
  promptApplyScope,
} from "./dialog.js";
import {
  bindScenarioActions,
  ensureSelectValue,
  setAudioPath,
  activeScene,
  missingMaterialMessage,
  payload,
  loadCut,
  renderCutList,
  addCutFromCurrent,
  updateSelectedCutFromCurrent,
  selectCutFromTimeline,
  scheduleScenarioSave,
  handleEditorChanged,
  saveScenario,
  bindAddCutBatchDialog,
  openAddCutBatchDialog,
  undoEdit,
  redoEdit,
  splitCutAtPlayhead,
  splitSelectedSoundEffect,
  splitSelectedVideoLayer,
  ensureCutSelectionState,
  clearMultiCutSelection,
  selectedCutIdSet,
  moveSelectedCutsBy,
  duplicateSelectedCuts,
  deleteSelectedCuts,
  linkSelectedItemsToCurrentCut,
  unlinkSelectedItems,
  toggleLinkForSelection,
  updateLinkToggleButton,
  syncMotionParamsVisibility,
  collectCutMotionSettings,
  applyCutMotionSettingsToControls,
  applyKenBurnsToControls,
} from "./scenario-actions.js";
// 「移動」モーションのピボット指定モードはカット切替で持ち越したくない。
// loadCut の中で exit を呼ぶようにすることもできるが、シンプルに app.js から
// elements.motionType の change で「move 以外」になったらモード解除する。
function _exitPivotPickingOnMotionChange() {
  if (elements.motionType?.value !== "move") exitMotionPivotPicking();
}
import { duplicateSelectedTelop, deleteSelectedTelops, selectAdjacentTelop, splitSelectedTelop } from "./telop.js";
import { openPosterTypographyDialog } from "./poster-typography-dialog.js";
import {
  bindSoundEffect,
  addSoundEffect,
  duplicateSelectedSoundEffect,
  deleteSelectedSoundEffect,
  renderSoundEffectEditor,
  clearSoundEffectSelection,
  selectSoundEffect,
  selectAdjacentSoundEffect,
  setMultiSoundEffectSelection,
} from "./sound-effect.js";
import {
  bindVideoLayer,
  addVideoLayer,
  duplicateSelectedVideoLayer,
  deleteSelectedVideoLayer,
  renderVideoLayerEditor,
  clearVideoLayerSelection,
  selectVideoLayer,
  selectAdjacentVideoLayer,
  setMultiVideoLayerSelection,
} from "./video-layer.js";
import { resolveShortcutAction } from "./shortcuts.js";
import {
  bindCharacterManager,
  fillExpressionPresets,
  syncPresetName,
  openCharacterManager,
  saveCharacterManager,
  deleteCharacterManagerCharacter,
  saveCurrentPreset,
  deleteCurrentPreset,
} from "./character-manager.js";
import {
  activateSettingsTab,
  activateControlTab,
  applyEditorTargetView,
  positionSettingsDialog,
  centerSettingsDialog,
  centerDialog,
  bindSettingsDrag,
} from "./dialog-helpers.js";
import {
  fillConfigForm,
  syncColorDisplays,
  updateSpeechPreview,
  normalizeBoxOpacityInput,
  saveConfig,
} from "./settings-form.js";
import {
  fillAssetControls,
  rescanAssets,
  refreshManifest,
  updateDurationFromAudio,
  clearProjectData,
  reloadProjectData,
  schedulePlayheadSave,
  flushPlayheadOnUnload,
} from "./app-state.js";
import { flushThumbnailOnUnload } from "./thumbnail.js";

state.globalConfig = null;

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

state.characterLayerEditor = {
  assetRoot: "",
  manifest: null,
  hasImportYaml: false,
  draftRenames: new Map(),  // key = `${category}|${oldId}` → desired newId
  draftDeletes: new Set(),  // key = `${category}|${oldId}`
  draftFlags: new Map(),    // key = `${category}|${oldId}` → { flagName: boolean }
  draftNames: new Map(),    // key = `${category}|${oldId}` → desired display name
};

state.assetInventory = { common: null, project: null };
state.characterLayerSizes = new Map();
state.assetMissing = [];
state.assetSelected = { scope: "common", category: "characters", view: "category" };
state.history = { stack: [], index: -1, maxSize: 50 };
state.isUndoRedoing = false;




function updateLoopModeUi() {
  const btn = elements.loopModeButton;
  if (!btn) return;
  const mode = state.loopMode || "off";
  btn.dataset.loopMode = mode;
  const icon = btn.querySelector(".msym");
  if (icon) {
    // Material Symbols: "repeat" (シーン全体 / なし) / "repeat_one" (カット内)
    icon.textContent = mode === "cut" ? "repeat_one" : "repeat";
  }
  btn.title =
    mode === "cut"
      ? "ループ: カット内 (クリックで シーン全体 → なし)"
      : mode === "scene"
        ? "ループ: シーン全体 (クリックで なし → カット内)"
        : "ループ: なし (クリックで カット内 → シーン全体)";
  btn.setAttribute(
    "aria-pressed",
    mode === "off" ? "false" : "true",
  );
}

function moveCutSelection(direction, options = {}) {
  // direction = -1 (左) / +1 (右)。
  // options.extend = true なら shift+矢印 同等で範囲選択を広げる。
  const cuts = state.scenario?.cuts || [];
  if (cuts.length === 0) return;
  const currentIndex = cuts.findIndex((cut) => cut.id === state.selectedCutId);
  const startIdx = currentIndex < 0 ? 0 : currentIndex;
  const nextIndex = direction < 0
    ? Math.max(0, startIdx - 1)
    : Math.min(cuts.length - 1, startIdx + 1);
  const nextCut = cuts[nextIndex];
  if (!nextCut) return;
  if (options.extend) {
    ensureCutSelectionState();
    const anchor = state.cutSelectionAnchorId
      || state.selectedCutId
      || nextCut.id;
    state.selectedCutId = nextCut.id;
    // setRangeSelection は scenario-actions 内の private なのでここで簡易再現
    const ai = cuts.findIndex((c) => c.id === anchor);
    const bi = nextIndex;
    if (ai >= 0 && bi >= 0) {
      const lo = Math.min(ai, bi);
      const hi = Math.max(ai, bi);
      const ids = new Set();
      for (let i = lo; i <= hi; i += 1) ids.add(cuts[i].id);
      state.selectedCutIds = ids;
      state.cutSelectionAnchorId = anchor;
    }
    loadCut(nextCut, { keepTelopSelection: true }).catch((error) => console.error(error));
  } else {
    clearMultiCutSelection();
    state.cutSelectionAnchorId = nextCut.id;
    if (nextIndex !== currentIndex) {
      loadCut(nextCut).catch((error) => console.error(error));
    }
  }
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target?.closest?.("dialog[open]")) {
      return;
    }
    const inEditableField = target?.matches?.("input, textarea, [contenteditable='true']");

    // Cmd/Ctrl+Z / Cmd+Shift+Z / Cmd+Y は Undo/Redo（テキスト入力中は OS native に委譲）
    if (event.metaKey || event.ctrlKey) {
      if (inEditableField) return;
      const key = event.key.toLowerCase();
      // Cmd+A: タイムライン canvas にフォーカスがあれば全テロップ選択
      if (key === "a" && !event.shiftKey) {
        if (target === elements.telopTrackCanvas) {
          event.preventDefault();
          selectAllTelops();
        }
        return;
      }
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoEdit().catch((error) => console.error(error));
        return;
      }
      if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redoEdit().catch((error) => console.error(error));
        return;
      }
      // Cmd/Ctrl+C / +V: 項目のコピー & ペースト。入力欄では既に return 済み (= OS の
      // 通常コピペ)。ページ上のテキスト選択があるときはブラウザのコピーに委譲する。
      if (key === "c" && !event.shiftKey) {
        if (state.projectDashboardVisible || !state.activeProjectId) return;
        const sel = window.getSelection?.();
        if (sel && String(sel).length > 0) return; // テキスト選択中はブラウザのコピーを優先
        event.preventDefault();
        copySelectionToClipboard();
        return;
      }
      if (key === "v" && !event.shiftKey) {
        if (state.projectDashboardVisible || !state.activeProjectId) return;
        event.preventDefault();
        pasteFromClipboard();
        return;
      }
      return;
    }

    if (inEditableField || target?.matches?.("select")) return;

    const actions = resolveShortcutAction(event);
    if (actions.length === 0) return;

    const editingNotAvailable = state.projectDashboardVisible
      || !state.activeProjectId
      || !(state.scenario?.cuts?.length > 0);

    for (const actionId of actions) {
      switch (actionId) {
        case "togglePlay":
          if (editingNotAvailable) return;
          event.preventDefault();
          elements.togglePreviewButton?.click();
          return;
        case "toggleLoopMode":
          if (event.repeat) return;
          if (editingNotAvailable) return;
          event.preventDefault();
          // ループトグル本体のクリックハンドラに委譲し、サイクル定義を一元化。
          elements.loopModeButton?.click();
          return;
        case "prevCut":
          if (editingNotAvailable) return;
          event.preventDefault();
          moveCutSelection(-1);
          return;
        case "nextCut":
          if (editingNotAvailable) return;
          event.preventDefault();
          moveCutSelection(+1);
          return;
        case "extendSelectionLeft":
          if (editingNotAvailable) return;
          event.preventDefault();
          moveCutSelection(-1, { extend: true });
          return;
        case "extendSelectionRight":
          if (editingNotAvailable) return;
          event.preventDefault();
          moveCutSelection(+1, { extend: true });
          return;
        case "moveCutsLeft":
          if (editingNotAvailable) return;
          event.preventDefault();
          moveSelectedCutsBy(-1);
          return;
        case "moveCutsRight":
          if (editingNotAvailable) return;
          event.preventDefault();
          moveSelectedCutsBy(+1);
          return;
        case "selectPrevTelop":
          // editorTarget が違う場合は次の候補へ (resolveShortcutAction は
          // ArrowUp に selectPrevTelop / selectPrevSoundEffect の両方を返す)。
          // ここで return すると後続の SE 用 case に到達しないバグになる。
          if (state.editorTarget !== "telop") break;
          event.preventDefault();
          selectAdjacentTelop(-1);
          return;
        case "selectNextTelop":
          if (state.editorTarget !== "telop") break;
          event.preventDefault();
          selectAdjacentTelop(+1);
          return;
        case "selectPrevSoundEffect":
          if (state.editorTarget !== "soundEffect") break;
          event.preventDefault();
          selectAdjacentSoundEffect(-1);
          return;
        case "selectNextSoundEffect":
          if (state.editorTarget !== "soundEffect") break;
          event.preventDefault();
          selectAdjacentSoundEffect(+1);
          return;
        case "selectPrevVideoLayer":
          if (state.editorTarget !== "videoLayer") break;
          event.preventDefault();
          selectAdjacentVideoLayer(-1);
          return;
        case "selectNextVideoLayer":
          if (state.editorTarget !== "videoLayer") break;
          event.preventDefault();
          selectAdjacentVideoLayer(+1);
          return;
        case "duplicateSelection":
          if (event.repeat) return;
          if (editingNotAvailable) return;
          event.preventDefault();
          if (state.editorTarget === "telop") {
            duplicateSelectedTelop();
          } else if (state.editorTarget === "soundEffect") {
            duplicateSelectedSoundEffect();
          } else if (state.editorTarget === "videoLayer") {
            duplicateSelectedVideoLayer();
          } else {
            duplicateSelectedCuts();
          }
          return;
        case "deleteSelection":
          if (event.repeat) return;
          if (editingNotAvailable) return;
          event.preventDefault();
          if (state.editorTarget === "telop") {
            deleteSelectedTelops();
          } else if (state.editorTarget === "soundEffect") {
            deleteSelectedSoundEffect();
          } else if (state.editorTarget === "videoLayer") {
            deleteSelectedVideoLayer();
          } else {
            deleteSelectedCuts();
          }
          return;
        case "addCut":
          if (event.repeat) return;
          if (editingNotAvailable) return;
          event.preventDefault();
          addCutFromCurrent();
          return;
        default:
          break;
      }
    }
  });
}

// 「アイテムを追加 ▼」ドロップダウンの開閉。trigger クリックで toggle、
// メニュー項目クリック・外側クリック・Esc で閉じる。メニュー項目側の click は
// 既に bind 済みハンドラ (addTelop / openPosterTypographyDialog / addSoundEffect /
// addVideoLayer) が走るので、ここでは「クリック後に閉じる」だけを足す。
// 汎用ドロップダウン開閉。onOpen(menu) を渡すと開く直前に項目の出し分け等ができる。
function _bindGenericDropdown(dropdown, trigger, { onOpen } = {}) {
  if (!dropdown || !trigger) return;
  const menu = dropdown.querySelector(".dropdown-menu");
  if (!menu) return;
  const setOpen = (open) => {
    if (open) {
      if (typeof onOpen === "function") onOpen(menu);
      menu.removeAttribute("hidden");
      dropdown.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    } else {
      menu.setAttribute("hidden", "");
      dropdown.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    }
  };
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = trigger.getAttribute("aria-expanded") === "true";
    setOpen(!open);
  });
  for (const item of menu.querySelectorAll(".dropdown-menu-item")) {
    item.addEventListener("click", () => setOpen(false));
  }
  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
}

function _bindAddItemDropdown() {
  _bindGenericDropdown(elements.addItemDropdown, elements.addItemDropdownTrigger);
}

// R4: 操作プルダウン (選択種別で動的に内容が変わる) を配線する。
function _dispatchDuplicate() {
  if (state.editorTarget === "telop") duplicateSelectedTelop();
  else if (state.editorTarget === "soundEffect") duplicateSelectedSoundEffect();
  else if (state.editorTarget === "videoLayer") duplicateSelectedVideoLayer();
  else duplicateSelectedCuts();
}
function _dispatchDelete() {
  if (state.editorTarget === "telop") deleteSelectedTelops();
  else if (state.editorTarget === "soundEffect") deleteSelectedSoundEffect();
  else if (state.editorTarget === "videoLayer") deleteSelectedVideoLayer();
  else deleteSelectedCuts();
}
function _dispatchSplit() {
  try {
    if (state.editorTarget === "soundEffect") splitSelectedSoundEffect();
    else if (state.editorTarget === "videoLayer") splitSelectedVideoLayer();
    else if (state.editorTarget === "telop") splitSelectedTelop();
    else splitCutAtPlayhead();
  } catch (error) {
    console.error(error);
    showToast("分割に失敗しました", "error");
  }
}
// 現在の選択種別ラベル。
function _editorTargetLabel() {
  switch (state.editorTarget) {
    case "telop": return "テロップ";
    case "soundEffect": return "効果音";
    case "videoLayer": return "動画";
    default: return "カット";
  }
}
function _bindActionDropdown() {
  const onOpen = () => {
    const target = state.editorTarget || "cut";
    if (elements.actionDropdownLabel) {
      elements.actionDropdownLabel.textContent = `操作: ${_editorTargetLabel()}`;
    }
    const show = (el, visible) => { if (el) el.hidden = !visible; };
    // 複製 / 削除 / コピー は全種別共通。
    show(elements.actionDuplicateButton, true);
    show(elements.actionDeleteButton, true);
    show(elements.actionCopyButton, true);
    // 貼り付けはクリップボードに項目があるときのみ。
    show(elements.actionPasteButton, !!(state.clipboard && state.clipboard.items?.length));
    // 分割はカット / テロップ / 効果音 / 動画のすべてで可能。
    show(elements.actionSplitButton, true);
    // 一括追加は種別に応じて。カット選択時=カット一括追加、テロップ選択時=テロップ一括追加。
    show(elements.actionAddCutBatchButton, target === "cut");
    show(elements.actionAddTelopBatchButton, target === "telop");
  };
  _bindGenericDropdown(elements.actionDropdown, elements.actionDropdownTrigger, { onOpen });
  elements.actionDuplicateButton?.addEventListener("click", _dispatchDuplicate);
  elements.actionCopyButton?.addEventListener("click", copySelectionToClipboard);
  elements.actionPasteButton?.addEventListener("click", pasteFromClipboard);
  elements.actionDeleteButton?.addEventListener("click", _dispatchDelete);
  elements.actionSplitButton?.addEventListener("click", _dispatchSplit);
  elements.actionAddCutBatchButton?.addEventListener("click", openAddCutBatchDialog);
  elements.actionAddTelopBatchButton?.addEventListener("click", openAddTelopBatchDialog);
}

// R2: レイヤー(レーン)追加プルダウンを配線する。
function _bindAddLaneDropdown() {
  _bindGenericDropdown(elements.addLaneDropdown, elements.addLaneDropdownTrigger);
  elements.addTelopLaneButton?.addEventListener("click", () => addTimelineLane("telop"));
  elements.addSoundEffectLaneButton?.addEventListener("click", () => addTimelineLane("soundEffect"));
  elements.addVideoLaneButton?.addEventListener("click", () => addTimelineLane("videoLayer"));
  elements.removeEmptyLaneButton?.addEventListener("click", () => {
    const target = state.editorTarget;
    const kind = target === "soundEffect" ? "soundEffect" : target === "videoLayer" ? "videoLayer" : "telop";
    removeEmptyTimelineLane(kind);
  });
}

// =========================================================================
// 項目のコピー & ペースト (cut / telop / soundEffect / videoLayer)。
// アプリ内クリップボード (state.clipboard) に deep clone を保持し、貼り付け時に
// 新しい ID を採番して挿入する。OS クリップボードは使わない (アプリ専用オブジェクト)。
// =========================================================================
function _newItemId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function _itemListForKind(scene, kind) {
  if (kind === "telop") return scene.telops;
  if (kind === "soundEffect") return scene.soundEffects;
  if (kind === "videoLayer") return scene.videoLayers;
  return null;
}
function _selectedIdsForKind(kind) {
  if (kind === "telop") {
    if (state.selectedTelopIds?.size) return Array.from(state.selectedTelopIds);
    return state.selectedTelopId ? [state.selectedTelopId] : [];
  }
  if (kind === "soundEffect") {
    if (state.selectedSoundEffectIds?.size) return Array.from(state.selectedSoundEffectIds);
    return state.selectedSoundEffectId ? [state.selectedSoundEffectId] : [];
  }
  if (kind === "videoLayer") {
    if (state.selectedVideoLayerIds?.size) return Array.from(state.selectedVideoLayerIds);
    return state.selectedVideoLayerId ? [state.selectedVideoLayerId] : [];
  }
  return Array.from(selectedCutIdSet());
}
function _editorTargetKind() {
  return state.editorTarget === "telop" ? "telop"
    : state.editorTarget === "soundEffect" ? "soundEffect"
    : state.editorTarget === "videoLayer" ? "videoLayer" : "cut";
}
const _KIND_LABEL = { cut: "カット", telop: "テロップ", soundEffect: "効果音", videoLayer: "動画" };

function copySelectionToClipboard() {
  const scene = activeScene();
  if (!scene) return;
  const kind = _editorTargetKind();
  const ids = _selectedIdsForKind(kind);
  if (ids.length === 0) { showToast("コピーする項目が選択されていません"); return; }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  if (kind === "cut") {
    const cuts = state.scenario?.cuts || [];
    const idSet = new Set(ids);
    const items = cuts.filter((c) => idSet.has(c.id)).map(clone);
    if (items.length === 0) return;
    // 紐づくテロップ/効果音/動画も一緒にコピーする (複製と同じ挙動)。
    const linked = {
      telops: (scene.telops || []).filter((t) => idSet.has(t.linkedCutId)).map(clone),
      soundEffects: (scene.soundEffects || []).filter((s) => idSet.has(s.linkedCutId)).map(clone),
      videoLayers: (scene.videoLayers || []).filter((v) => idSet.has(v.linkedCutId)).map(clone),
    };
    state.clipboard = { kind, items, linked };
    showToast(`カットを${items.length}件コピーしました`);
    return;
  }
  const list = _itemListForKind(scene, kind) || [];
  const idSet = new Set(ids);
  const items = list.filter((x) => idSet.has(x.id)).map(clone);
  if (items.length === 0) return;
  state.clipboard = { kind, items };
  showToast(`${_KIND_LABEL[kind]}を${items.length}件コピーしました`);
}

function _pasteCutsFromClipboard(scene, clip) {
  const cuts = state.scenario?.cuts;
  if (!Array.isArray(cuts)) return;
  // 挿入位置: 選択中カットの直後、無ければ末尾。
  let insertIdx = cuts.length;
  const curIdx = cuts.findIndex((c) => c.id === state.selectedCutId);
  if (curIdx >= 0) insertIdx = curIdx + 1;
  // 元 startFrame (コピー時のスナップショット) を控える。リンクアイテムのシフト計算用。
  const srcOldStart = new Map();
  const sourceToCloneId = new Map();
  const cloneCuts = clip.items.map((src) => {
    srcOldStart.set(src.id, Math.max(0, Math.round(Number(src.startFrame) || 0)));
    const c = JSON.parse(JSON.stringify(src));
    const newId = _newItemId("cut");
    sourceToCloneId.set(src.id, newId);
    c.id = newId;
    return c;
  });
  cuts.splice(insertIdx, 0, ...cloneCuts);
  state.selectedCutId = cloneCuts[cloneCuts.length - 1].id;
  state.selectedCutIds = new Set(cloneCuts.map((c) => c.id));
  state.cutSelectionAnchorId = cloneCuts[0].id;
  recalcCutStartSec();
  // リンクアイテムを複製して clone カットへ張り替え (複製と同じロジック)。
  const linked = clip.linked || { telops: [], soundEffects: [], videoLayers: [] };
  const dupLinked = (item, prefix) => {
    const sourceId = item.linkedCutId;
    const cloneId = sourceToCloneId.get(sourceId);
    if (!cloneId) return null;
    const cloneCut = cuts.find((c) => c.id === cloneId);
    const oldStart = srcOldStart.get(sourceId) ?? 0;
    const shift = (Number(cloneCut?.startFrame) || 0) - oldStart;
    const dup = JSON.parse(JSON.stringify(item));
    dup.id = _newItemId(prefix);
    dup.linkedCutId = cloneId;
    dup.startFrame = Math.max(0, (Number(item.startFrame) || 0) + shift);
    return dup;
  };
  if (Array.isArray(scene.telops)) {
    for (const t of linked.telops || []) { const d = dupLinked(t, "telop"); if (d) scene.telops.push(d); }
  }
  if (Array.isArray(scene.soundEffects)) {
    for (const s of linked.soundEffects || []) { const d = dupLinked(s, "se"); if (d) scene.soundEffects.push(d); }
  }
  if (Array.isArray(scene.videoLayers)) {
    for (const v of linked.videoLayers || []) { const d = dupLinked(v, "vl"); if (d) scene.videoLayers.push(d); }
  }
  loadCut(cloneCuts[cloneCuts.length - 1]).catch((error) => console.error(error));
  scheduleScenarioSave();
  recordHistory();
  showToast(`カットを${cloneCuts.length}件貼り付けました`);
}

function pasteFromClipboard() {
  const clip = state.clipboard;
  if (!clip || !Array.isArray(clip.items) || clip.items.length === 0) {
    showToast("コピーされた項目がありません");
    return;
  }
  const scene = activeScene();
  if (!scene) return;
  if (clip.kind === "cut") { _pasteCutsFromClipboard(scene, clip); return; }
  const list = _itemListForKind(scene, clip.kind);
  if (!Array.isArray(list)) return;
  const prefix = clip.kind === "telop" ? "telop" : clip.kind === "soundEffect" ? "se" : "vl";
  // グループ全体を再生ヘッドへ移動 (相対オフセット・レーンは保持)。
  const playFrame = Math.max(0, Math.round((Number(state.timeline?.currentSec) || 0) * PROJECT_FPS));
  const earliest = Math.min(
    ...clip.items.map((it) => Math.max(0, Math.round(Number(it.startFrame) || 0))),
  );
  const delta = playFrame - earliest;
  const created = [];
  for (const it of clip.items) {
    const c = JSON.parse(JSON.stringify(it));
    c.id = _newItemId(prefix);
    c.startFrame = Math.max(0, (Math.round(Number(it.startFrame) || 0)) + delta);
    // 貼り付けは位置が明示されるのでカットリンクは解除する。
    c.linkedCutId = null;
    list.push(c);
    created.push(c);
  }
  list.sort((a, b) => (Number(a.startFrame) || 0) - (Number(b.startFrame) || 0));
  state.editorTarget = clip.kind;
  const ids = created.map((c) => c.id);
  const primary = ids[ids.length - 1];
  if (clip.kind === "telop") setMultiTelopSelection(ids, primary);
  else if (clip.kind === "soundEffect") setMultiSoundEffectSelection(ids, primary);
  else setMultiVideoLayerSelection(ids, primary);
  applyEditorTargetView();
  scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  renderPreview();
  showToast(`${_KIND_LABEL[clip.kind]}を${created.length}件貼り付けました`);
}

// R10: カット入りトランジションは「カット先頭の 0.5 秒」効果なので、編集中の停止
// プレビュー (再生ヘッドが窓外) では見えない。設定変更時に遷移の中間地点へシークして
// 「半分かかった状態」を即プレビューし、変更が反映されることを確認できるようにする。
function _bindCutTransitionPreview() {
  const onChange = () => {
    // ワイプ方向セレクトは type=wipe のときだけ表示。
    if (elements.cutTransitionWipeDirLabel) {
      elements.cutTransitionWipeDirLabel.hidden = elements.cutTransitionTypeSelect?.value !== "wipe";
    }
    updateSelectedCutFromCurrent(); // トランジション (+他入力) を現在カットへ確定。
    const cut = state.scenario?.cuts?.find((c) => c.id === state.selectedCutId);
    if (cut) {
      const tr = cutTransition(cut);
      if (tr.type !== "none" && tr.durationFrame > 0) {
        // 遷移の中間 = overlay 不透明度 ~0.5 (半分かかった状態) を表示。
        state.timeline.currentSec = cutStartSec(cut) + (tr.durationFrame / 2) / PROJECT_FPS;
        schedulePlayheadSave();
      }
    }
    scheduleScenarioSave();
    renderTelopTrack();
    renderPreview();
  };
  elements.cutTransitionTypeSelect?.addEventListener("change", onChange);
  elements.cutTransitionDurationInput?.addEventListener("change", onChange);
  elements.cutTransitionWipeDirSelect?.addEventListener("change", onChange);
  // 発話ディレイは音声タイミングだけの変更なので、確定 + 保存のみ (シーク不要)。
  elements.cutAudioDelayInput?.addEventListener("change", () => {
    updateSelectedCutFromCurrent();
    scheduleScenarioSave();
  });
}

// R8: セリフ本文の個別文字間カーニング UI + テキスト編集追従シフト。
function _bindDialogueKerning() {
  const ta = elements.dialogue;
  if (!ta) return;
  const curCut = () => state.scenario?.cuts?.find((c) => c && c.id === state.selectedCutId) || null;
  const gapAtCursor = () => {
    const pos = ta.selectionStart ?? 0;
    const before = Array.from(ta.value.slice(0, pos)).length;
    const total = Array.from(ta.value).length;
    const gap = before - 1;
    return gap >= 0 && gap <= total - 2 ? gap : -1;
  };
  const refresh = () => {
    if (!elements.dialogueKerningReadout) return;
    const gap = gapAtCursor();
    if (gap < 0) {
      elements.dialogueKerningReadout.textContent = "本文の文字間にカーソルを置いて調整";
      return;
    }
    const cur = Number(curCut()?.state?.textStyle?.charKerning?.[gap]) || 0;
    elements.dialogueKerningReadout.textContent = `${gap + 1}↔${gap + 2} 文字目: ${cur} (1/1000em)`;
  };
  const apply = (delta, reset = false) => {
    const gap = gapAtCursor();
    if (gap < 0) { showToast("文字と文字の間にカーソルを置いてください"); return; }
    const cut = curCut();
    if (!cut) return;
    cut.state = cut.state || {};
    cut.state.textStyle = cut.state.textStyle || {};
    const ck = { ...(cut.state.textStyle.charKerning || {}) };
    const next = reset ? 0 : Math.max(-2000, Math.min(2000, (Number(ck[gap]) || 0) + delta));
    if (next === 0) delete ck[gap];
    else ck[gap] = next;
    if (Object.keys(ck).length > 0) cut.state.textStyle.charKerning = ck;
    else delete cut.state.textStyle.charKerning;
    scheduleScenarioSave();
    renderPreview();
    refresh();
  };
  elements.dialogueKerningMinusButton?.addEventListener("click", () => apply(-100));
  elements.dialogueKerningMinus10Button?.addEventListener("click", () => apply(-10));
  elements.dialogueKerningPlus10Button?.addEventListener("click", () => apply(10));
  elements.dialogueKerningPlusButton?.addEventListener("click", () => apply(100));
  elements.dialogueKerningResetButton?.addEventListener("click", () => apply(0, true));
  ta.addEventListener("keyup", refresh);
  ta.addEventListener("click", refresh);
  ta.addEventListener("select", refresh);
  // edit-shift: 直前テキストと比較して charKerning キーをシフト。
  let prev = ta.value;
  ta.addEventListener("focus", () => { prev = ta.value; });
  ta.addEventListener("input", () => {
    const cut = curCut();
    const ck = cut?.state?.textStyle?.charKerning;
    if (ck && Object.keys(ck).length > 0) {
      const oldArr = Array.from(prev);
      const newArr = Array.from(ta.value);
      let p = 0;
      while (p < oldArr.length && p < newArr.length && oldArr[p] === newArr[p]) p += 1;
      let s = 0;
      while (s < oldArr.length - p && s < newArr.length - p
        && oldArr[oldArr.length - 1 - s] === newArr[newArr.length - 1 - s]) s += 1;
      const removed = oldArr.length - p - s;
      const inserted = newArr.length - p - s;
      if (removed || inserted) {
        const shifted = shiftCharKerningForEdit(ck, p, removed, inserted);
        if (Object.keys(shifted).length > 0) cut.state.textStyle.charKerning = shifted;
        else delete cut.state.textStyle.charKerning;
      }
    }
    prev = ta.value;
    refresh();
  });
}

function bindControls() {
  bindAssetManager();
  bindGlobalSettings({
    reloadProjectData,
    restartAutoBackupTimer: () => {
      stopAutoBackupTimer();
      startAutoBackupTimer();
    },
  });
  bindPsdImporter({
    ensureCommonInventoryLoaded,
    ensureProjectInventoryLoaded,
    refreshManifest,
    refreshAssetManager,
    openCharacterLayerEditor,
  });
  bindCharacterLayerEditor({ refreshManifest, refreshAssetManager });
  bindAssetExpressionPresets({ refreshManifest });
  bindAssetHairstylePresets({ refreshManifest });
  bindTimeline({
    selectTelop,
    clearTelopSelection,
    setMultiTelopSelection,
    scheduleScenarioSave,
    renderPreview,
    loadCut,
    defaultTelop,
    renderTelopEditor,
    activeScene,
    schedulePlayheadSave,
    selectSoundEffect,
    clearSoundEffectSelection,
    setMultiSoundEffectSelection,
    renderSoundEffectEditor,
    selectVideoLayer,
    clearVideoLayerSelection,
    setMultiVideoLayerSelection,
    renderVideoLayerEditor,
    applyEditorTargetView,
    selectCutFromTimeline,
  });
  bindTelop({
    activeScene,
    scheduleScenarioSave,
    renderPreview,
    loadCut,
    applyEditorTargetView,
    applyTelopDefaultsToAllTelops,
    promptBulkApply,
    promptApplyScope,
  });
  bindSoundEffect({
    activeScene,
    scheduleScenarioSave,
    renderPreview,
    loadCut,
    applyEditorTargetView,
  });
  bindVideoLayer({
    activeScene,
    scheduleScenarioSave,
    renderPreview,
    loadCut,
    applyEditorTargetView,
    refreshManifest,
  });
  bindCharacter({
    handleEditorChanged,
    ensureSelectValue,
    syncPresetName,
    fillExpressionPresets,
    fillPlacementPresets,
    updateSelectedCutFromCurrent,
    scheduleScenarioSave,
    renderPreview,
    syncDialogueVoiceFromSpeaker,
    reloadCurrentCut: async () => {
      const cuts = state.scenario?.cuts || [];
      const cut = cuts.find((c) => c.id === state.selectedCutId);
      if (cut) await loadCut(cut, { keepTelopSelection: true });
    },
    collectCutMotionSettings,
    applyCutMotionSettingsToControls,
    syncMotionParamsVisibility,
  });
  bindPlayback({
    loadCut,
    payload,
    missingMaterialMessage,
    renderCutList,
  });
  bindProject({
    reloadProjectData,
    clearProjectData,
  });
  bindAssets({
    openCharacterManager,
    reloadProjectData,
  });
  bindDialog({
    saveScenario,
    loadCut,
    scheduleScenarioSave,
    updateSelectedCutFromCurrent,
    activeScene,
    selectedCutIdSet,
  });
  bindScenarioActions({
    applyEditorTargetView,
    syncPresetName,
    fillExpressionPresets,
    normalizeBoxOpacityInput,
    syncDialogueVoiceFromSpeaker,
  });
  bindDialogueVoice();
  bindPlacementPresets({ handleEditorChanged });
  bindCharacterManager({
    fillAssetControls,
    fillConfigForm,
    centerDialog,
    syncDialogueVoiceFromSpeaker,
  });
  bindKeyboardShortcuts();
  setupTimelineCanvas();
  bindPlayheadInfo();
  bindPreviewInteractions({
    getActiveScene: _v2GetActiveScene,
    redrawActiveScene: _v2RedrawActiveScene,
    getActiveWorldTransform: _v2GetActiveWorldTransform,
    updateSelectedCutFromCurrent,
    scheduleScenarioSave,
    renderPreview,
    fillExpressionPresets,
  });
  // 髪型プリセット選択時はベースセレクタを preset.baseId に同期する。
  // server 側 resolve_character_paths は cut.state.baseId を権威とするため、
  // preset 切替に追随させるにはここで elements.base.value を更新する必要がある。
  if (elements.hairstylePreset) {
    elements.hairstylePreset.addEventListener("change", () => {
      const character = selectedCharacter();
      if (!character) return;
      const def = characterDefinitionById(character.characterId);
      const preset = (def?.hairstylePresets || []).find(
        (p) => p.id === elements.hairstylePreset.value,
      );
      if (preset && preset.baseId && elements.base) {
        ensureSelectValue(elements.base, preset.baseId);
      }
    });
  }
  const debouncedEditorChanged = debounce(handleEditorChanged, 250);
  for (const element of [
    elements.background,
    elements.backgroundBlurPx,
    elements.backgroundColor,
    elements.backgroundColorOpacity,
    elements.foreground,
    elements.foregroundX,
    elements.foregroundY,
    elements.foregroundScale,
    elements.backgroundX,
    elements.backgroundY,
    elements.backgroundScale,
    elements.kenBurnsEnabled,
    elements.kenBurnsStartScale,
    elements.kenBurnsStartX,
    elements.kenBurnsStartY,
    elements.kenBurnsEndScale,
    elements.kenBurnsEndX,
    elements.kenBurnsEndY,
    elements.kenBurnsEasing,
    elements.base,
    elements.expressionPreset,
    elements.cheek,
    elements.eye,
    elements.mouth,
    elements.hairstylePreset,
    elements.eyeAboveBangs,
    elements.characterFlipX,
    elements.speakerCharacter,
    elements.characterRemoveWhite,
    elements.characterX,
    elements.characterY,
    elements.characterScale,
    elements.characterBobBpm,
    elements.characterBobAmplitude,
    elements.dialogue,
    elements.fontSize,
    elements.fontFamily,
    elements.fontWeight,
    elements.align,
    elements.speechPlacement,
    elements.lines,
    elements.boxOpacity,
    elements.cutTextColor,
    elements.cutTextOutlineWidth,
    elements.cutTextOutlineColor,
    elements.cutLetterSpacing,
    elements.cutLineSpacing,
    elements.cutDialogueGlowEnabled,
    elements.cutDialogueGlowColor,
    elements.cutDialogueGlowBlur,
    elements.cutDialogueGlowOpacity,
    elements.cutDialogueDropShadowEnabled,
    elements.cutDialogueDropShadowColor,
    elements.cutDialogueDropShadowBlur,
    elements.cutDialogueDropShadowOpacity,
    elements.cutDialogueDropShadowOffsetX,
    elements.cutDialogueDropShadowOffsetY,
    elements.showSpeechBox,
    elements.showSpeakerName,
    elements.showCharacter,
    elements.duration,
    elements.audio,
    elements.motionType,
    elements.characterColorFilterEnabled,
    elements.characterColorFilterColor,
    elements.characterColorFilterOpacity,
    elements.characterGlowEnabled,
    elements.characterGlowColor,
    elements.characterGlowBlur,
    elements.characterGlowOpacity,
    elements.characterDropShadowEnabled,
    elements.characterDropShadowColor,
    elements.characterDropShadowBlur,
    elements.characterDropShadowOpacity,
    elements.characterDropShadowOffsetX,
    elements.characterDropShadowOffsetY,
    // 演出タブのモーション cut 単位 override
    elements.cutMotionShakeXAmplitude,
    elements.cutMotionShakeXCount,
    elements.cutMotionShakeXDuration,
    elements.cutMotionShakeYAmplitude,
    elements.cutMotionShakeYCount,
    elements.cutMotionShakeYDuration,
    elements.cutMotionZoomScale,
    elements.cutMotionZoomOrigin,
    elements.cutMotionMoveStartFrame,
    elements.cutMotionMoveDurationFrame,
    elements.cutMotionMoveStartX,
    elements.cutMotionMoveStartY,
    elements.cutMotionMoveEndX,
    elements.cutMotionMoveEndY,
    elements.cutMotionMoveStartOpacity,
    elements.cutMotionMoveEndOpacity,
    elements.cutMotionMoveStartRotation,
    elements.cutMotionMoveEndRotation,
    elements.cutMotionMoveStartScale,
    elements.cutMotionMoveEndScale,
    elements.cutMotionMovePivotX,
    elements.cutMotionMovePivotY,
    elements.cutMotionMoveEasing,
  ]) {
    if (!element) continue;
    element.addEventListener("input", debouncedEditorChanged);
    element.addEventListener("change", debouncedEditorChanged);
  }
  // motionType の値が変わったら、対応する .motion-params セクションだけ可視化。
  elements.motionType?.addEventListener("change", () => {
    syncMotionParamsVisibility();
    _exitPivotPickingOnMotionChange();
  });
  elements.boxOpacity.addEventListener("change", normalizeBoxOpacityInput);
  if (elements.duration) {
    bindTimecodeInput(elements.duration, {
      minFrames: 1,
      getFrames: () => {
        const ds = Number(elements.duration.dataset.frames);
        return Number.isFinite(ds) && ds > 0 ? ds : PROJECT_FPS * 3;
      },
      setFrames: (frames) => {
        elements.duration.dataset.frames = String(frames);
      },
    });
    // ▲▼ ボタンは内蔵 ArrowUp/Down ハンドラに合成 KeyboardEvent を送って
    // 同じロジックを通す (Shift で 1 秒単位)。
    const spinnerWrap = elements.duration.closest(".timecode-spinner");
    if (spinnerWrap) {
      for (const btn of spinnerWrap.querySelectorAll(".timecode-spinner-btn")) {
        btn.addEventListener("click", (event) => {
          const direction = btn.dataset.spinner === "up" ? "ArrowUp" : "ArrowDown";
          elements.duration.focus();
          elements.duration.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: direction,
              shiftKey: event.shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      }
    }
  }
  elements.cutCharacter.addEventListener("change", () => {
    selectCutCharacter(Number(elements.cutCharacter.value) || 0);
  });
  // 「登場キャラ」横の character_XXXXX 表示をクリックでクリップボードへ。
  elements.cutCharacterInstanceId?.addEventListener("click", async () => {
    const text = elements.cutCharacterInstanceId.textContent || "";
    if (!text || text === "—") return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(`コピーしました: ${text}`);
    } catch (_e) {
      // clipboard API が拒否された場合のフォールバック (Firefox HTTP 等)
      const range = document.createRange();
      range.selectNodeContents(elements.cutCharacterInstanceId);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  });
  elements.addCharacterButton.addEventListener("click", addCharacter);
  elements.deleteCharacterButton.addEventListener("click", deleteCharacter);
  elements.moveCharacterUpButton.addEventListener("click", () => moveCharacter(-1));
  elements.moveCharacterDownButton.addEventListener("click", () => moveCharacter(1));
  elements.addCutButton?.addEventListener("click", addCutFromCurrent);
  elements.addTelopButton?.addEventListener("click", addTelop);
  elements.addTelopBatchButton?.addEventListener("click", openAddTelopBatchDialog);
  elements.addPosterTemplateButton?.addEventListener("click", () => {
    openPosterTypographyDialog();
  });
  elements.addSoundEffectButton?.addEventListener("click", addSoundEffect);
  elements.addVideoLayerButton?.addEventListener("click", addVideoLayer);
  elements.openTitleEditorButton?.addEventListener("click", async () => {
    // タイトル組版エディタへ抜ける。ダッシュボードへの離脱と同様、現シナリオを
    // 保存してから遷移する。失敗してもユーザーを引き止めず遷移は実行する。
    try { await saveScenario(); } catch (err) { console.error(err); }
    try { await flushAutoBackupOnLeave(state.activeProjectId); } catch (err) { console.error(err); }
    window.location.href = "/title-editor";
  });
  _bindAddItemDropdown();
  _bindActionDropdown();
  _bindAddLaneDropdown();
  _bindGenericDropdown(elements.exportDropdown, elements.exportDropdownTrigger);
  _bindDialogueKerning();
  _bindCutTransitionPreview();
  bindAddTelopBatchDialog();
  bindAddCutBatchDialog();
  elements.applyCharacterToAllCutsButton?.addEventListener("click", () => {
    applyCharacterToAllCuts().catch((error) => {
      console.error(error);
      showToast("一括適用に失敗しました", "error");
    });
  });
  elements.replaceCharacterButton?.addEventListener("click", () => {
    replaceCharacterAcrossAllCuts().catch((error) => {
      console.error(error);
      showToast("キャラ置換に失敗しました", "error");
    });
  });
  elements.applyDialogTextStyleButton?.addEventListener("click", () => {
    applyDialogTextStyleToAllCuts("all").catch((error) => {
      console.error(error);
      showToast("一括反映に失敗しました", "error");
    });
  });
  elements.applyDialogTextStyleToSameSpeakerButton?.addEventListener("click", () => {
    applyDialogTextStyleToAllCuts("same-speaker").catch((error) => {
      console.error(error);
      showToast("一括反映に失敗しました", "error");
    });
  });
  elements.applyDialogBoxStyleButton?.addEventListener("click", () => {
    applyDialogBoxStyleToAllCuts().catch((error) => {
      console.error(error);
      showToast("一括反映に失敗しました", "error");
    });
  });
  elements.applyEffectSceneToAllCutsButton?.addEventListener("click", () => {
    applyEffectSceneToAllCuts().catch((error) => {
      console.error(error);
      showToast("一括反映に失敗しました", "error");
    });
  });
  elements.applyEffectCharacterToAllCutsButton?.addEventListener("click", () => {
    applyEffectCharacterToAllCuts().catch((error) => {
      console.error(error);
      showToast("一括反映に失敗しました", "error");
    });
  });
  elements.closeTelopEditorButton?.addEventListener("click", () => clearTelopSelection());
  elements.openSceneDialogButton?.addEventListener("click", openSceneDialog);
  elements.openProjectSettingsDialogButton?.addEventListener("click", openProjectSettingsDialog);
  elements.linkToggleButton?.addEventListener("click", () => toggleLinkForSelection());
  elements.duplicateSelectedCutsButton?.addEventListener("click", () => {
    if (state.editorTarget === "telop") {
      duplicateSelectedTelop();
    } else if (state.editorTarget === "soundEffect") {
      duplicateSelectedSoundEffect();
    } else if (state.editorTarget === "videoLayer") {
      duplicateSelectedVideoLayer();
    } else {
      duplicateSelectedCuts();
    }
  });
  elements.deleteSelectedCutsButton?.addEventListener("click", () => {
    if (state.editorTarget === "telop") {
      deleteSelectedTelops();
    } else if (state.editorTarget === "soundEffect") {
      deleteSelectedSoundEffect();
    } else if (state.editorTarget === "videoLayer") {
      deleteSelectedVideoLayer();
    } else {
      deleteSelectedCuts();
    }
  });
  // 事前解析 (プリレンダー): 全カットのサーバ側キャッシュを温めて書き出しを高速化。
  // 実行中はボタンが進捗表示 + 中止ボタンに変わる。warm 実体は playback の
  // warmSceneBundleForPrerender を bindPrerender で注入済み。
  bindPrerender({ warmCut: warmSceneBundleForPrerender });
  const _setPrerenderButtonUi = ({ done, total, running, cancelled } = {}) => {
    const btn = elements.prerenderButton;
    const label = elements.prerenderButtonLabel;
    if (!btn) return;
    if (running) {
      btn.classList.add("is-running");
      btn.title = "事前解析を中止";
      if (label) label.textContent = `解析中 ${done}/${total}（中止）`;
    } else {
      btn.classList.remove("is-running");
      btn.title = "全カットの解析キャッシュを事前生成して書き出しを高速化します。タイムライン最上部の帯が 緑=解析済 / 赤=解析中 / 灰=未解析。";
      if (label) label.textContent = "事前解析";
      if (cancelled) showToast("事前解析を中止しました");
      else if (total > 0) showToast(`事前解析が完了しました（${total} カット）`);
    }
  };
  elements.prerenderButton?.addEventListener("click", () => {
    if (isPrerendering()) {
      cancelPrerender();
      return;
    }
    runPrerenderAll({ onProgress: _setPrerenderButtonUi });
  });
  // editorTarget に応じて分割対象を切替 (操作プルダウンと同じ _dispatchSplit を共有)。
  // テロップ / 効果音 / 動画は新ファイルを生成せず、durationFrame・audioOffsetSec /
  // trimStartSec・trimEndSec の調整で疑似分割する (= 編集中の素材は触らない)。
  elements.splitCutAtPlayheadButton?.addEventListener("click", _dispatchSplit);
  // ★ シーン設定ダイアログはモーダルでプレビューが遮られている (リアルタイム
  // プレビュー不可)。よってダイアログ内の input イベントは
  // applySceneFieldsFromDialog (= ローカル state 更新だけ、軽量) に留め、
  // 重い副作用 (renderPreview / drawTimeline / scheduleScenarioSave) は
  // 「閉じるボタン」「ESC」「外側クリック」全てを統合する <dialog> の close event
  // で 1 回だけ commitSceneFromDialog を実行する。
  // → bar_spectrum / wave_ribbon 等 param 数が多いプラグインで操作中の固まり / 飛ばされ
  //   現象を完全に解消する。
  elements.closeSceneDialogButton?.addEventListener("click", () => {
    closeSceneDialog();   // commit は close イベントが受け持つ
  });
  elements.sceneDialog?.addEventListener("close", () => {
    commitSceneFromDialog();
  });
  elements.addSceneBgmButton?.addEventListener("click", addSceneBgmTrack);
  elements.sceneVideoEnabled?.addEventListener("change", () => {
    if (elements.sceneVideoFields) {
      elements.sceneVideoFields.hidden = !elements.sceneVideoEnabled.checked;
    }
    applySceneFieldsFromDialog();
  });
  for (const el of [
    elements.sceneTitle,
    elements.sceneBpm,
    elements.sceneVideoSrc,
    elements.sceneVideoFit,
    elements.sceneVideoLoop,
    elements.sceneVideoSpeed,
    elements.sceneVideoTrimStart,
    elements.sceneVideoTrimEnd,
    elements.sceneVideoMuted,
    elements.sceneBreathAmplitude,
    elements.sceneBreathPeriod,
    elements.sceneBpmBobAmplitude,
    elements.sceneVisualizerEnabled,
    elements.sceneVisualizerAudio,
    elements.sceneVisualizerLayer,
  ]) {
    el?.addEventListener("change", applySceneFieldsFromDialog);
  }
  // ビジュアライザは select 変更でパラメータ UI が変わるので、apply → fillSceneDialog で再描画。
  // 副作用 (preview / save) は close 時にまとめて。
  elements.sceneVisualizerPlugin?.addEventListener("change", () => {
    applySceneFieldsFromDialog();
    fillSceneDialog();
  });
  // パラメータ入力 (動的生成) は event delegation で apply を呼ぶ。debounce 不要
  // (副作用なしの軽量更新で、close 時に 1 回だけ heavy commit する設計のため)。
  elements.sceneVisualizerParams?.addEventListener("input", applySceneFieldsFromDialog);
  elements.sceneVisualizerParams?.addEventListener("change", applySceneFieldsFromDialog);
  elements.expressionPreset.addEventListener("change", () => {
    const character = selectedCharacter();
    if (!character) {
      return;
    }
    const characterId = character.characterId;
    const preset = (state.manifest.expressionPresets || []).find(
      (item) => item.id === elements.expressionPreset.value && (!item.characterId || item.characterId === characterId)
    );
    if (preset) {
      // v4 では cheekId/eyeId/mouthId に揃える
      elements.eye.value = preset.eyeId || "";
      elements.mouth.value = preset.mouthId || "";
      if (Object.hasOwn(preset, "cheekId")) {
        elements.cheek.value = preset.cheekId || "";
      }
    }
    syncPresetName();
    handleEditorChanged();
  });
  elements.fontFamily.addEventListener("change", () => {
    fillFontWeights(elements.fontWeight.value);
    handleEditorChanged();
  });
  elements.audioSelect.addEventListener("change", () => {
    setAudioPath(elements.audioSelect.value);
    updateDurationFromAudio(elements.audio.value).finally(handleEditorChanged);
  });
  elements.projectSelect.addEventListener("change", () => {
    activateProject(elements.projectSelect.value, { hideDashboard: true }).catch((error) => {
      console.error(error);
      showToast("プロジェクト切替に失敗しました", "error");
    });
  });
  elements.createProjectButton.addEventListener("click", () => {
    openProjectForm("create");
  });
  elements.openDashboardButton.addEventListener("click", () => {
    // showProjectDashboard は async になり、離脱直前の v2 サムネ保存を内包する。
    // ここでは catch だけ拾って UI スレッドを落とさない。
    showProjectDashboard().catch((err) => console.error(err));
  });
  elements.dashboardCloseButton.addEventListener("click", hideProjectDashboard);
  elements.dashboardCreateProjectButton.addEventListener("click", () => {
    openProjectForm("create");
  });
  elements.projectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(elements.saveProjectFormButton, "保存中", submitProjectForm).catch((error) => {
      console.error(error);
      showToast(
        state.projectFormMode === "rename" ? "プロジェクト名変更に失敗しました" : "プロジェクト作成に失敗しました",
        "error"
      );
    });
  });
  elements.cancelProjectFormButton.addEventListener("click", closeProjectForm);
  elements.projectDeleteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(elements.confirmProjectDeleteButton, "削除中", deleteProjectFromDialog)
      .catch((error) => {
        console.error(error);
        showToast("プロジェクト削除に失敗しました", "error");
      })
      .finally(() => {
        if (elements.projectDeleteDialog.open) {
          const expectedName = state.projectDeleteTarget?.title || state.projectDeleteTarget?.id || "";
          const expectedId = state.projectDeleteTarget?.id || "";
          const confirmation = elements.projectDeleteConfirm.value.trim();
          elements.confirmProjectDeleteButton.disabled = confirmation !== expectedName && confirmation !== expectedId;
        }
      });
  });
  elements.projectDeleteConfirm.addEventListener("input", () => {
    const expectedName = state.projectDeleteTarget?.title || state.projectDeleteTarget?.id || "";
    const expectedId = state.projectDeleteTarget?.id || "";
    const confirmation = elements.projectDeleteConfirm.value.trim();
    elements.confirmProjectDeleteButton.disabled = confirmation !== expectedName && confirmation !== expectedId;
  });
  elements.cancelProjectDeleteButton.addEventListener("click", closeProjectDeleteDialog);
  for (const element of [elements.projectNameFilter, elements.projectDateFilter, elements.projectSort]) {
    element.addEventListener("input", renderProjectDashboard);
    element.addEventListener("change", renderProjectDashboard);
  }
  elements.rescanAssetsButton.addEventListener("click", () => {
    withBusy(elements.rescanAssetsButton, "スキャン中", rescanAssets).catch((error) => {
      console.error(error);
      showToast("素材再スキャンに失敗しました", "error");
    });
  });
  elements.renderButton.addEventListener("click", () => renderPreview({ saveOutput: true }));
  elements.centerCharacterButton.addEventListener("click", centerCharacter);
  elements.resetCharacterButton.addEventListener("click", resetCharacter);
  // 前景 / 背景の「左右中央」「上下中央」。座標を空欄に戻すと scene-builder が
  // 拡大率適用後のサイズで中央寄せするので、拡大率を後から変えても中央のままになる。
  const _centerAxis = (input) => {
    if (!input) return;
    input.value = "";
    handleEditorChanged();
  };
  elements.centerForegroundXButton?.addEventListener("click", () => _centerAxis(elements.foregroundX));
  elements.centerForegroundYButton?.addEventListener("click", () => _centerAxis(elements.foregroundY));
  elements.centerBackgroundXButton?.addEventListener("click", () => _centerAxis(elements.backgroundX));
  elements.centerBackgroundYButton?.addEventListener("click", () => _centerAxis(elements.backgroundY));
  // ケンバーンズ: 開始/終了の入替・リセット。
  elements.kenBurnsSwapButton?.addEventListener("click", () => {
    const swap = (a, b) => {
      if (!a || !b) return;
      const tmp = a.value;
      a.value = b.value;
      b.value = tmp;
    };
    swap(elements.kenBurnsStartScale, elements.kenBurnsEndScale);
    swap(elements.kenBurnsStartX, elements.kenBurnsEndX);
    swap(elements.kenBurnsStartY, elements.kenBurnsEndY);
    handleEditorChanged();
  });
  elements.kenBurnsResetButton?.addEventListener("click", () => {
    applyKenBurnsToControls(null);
    handleEditorChanged();
  });
  elements.applyKenBurnsToAllCutsButton?.addEventListener("click", () => {
    applyKenBurnsToAllCuts().catch((error) => showToast(error.message, "error"));
  });
  // 配置プリセット (キャラ 1 体の X / Y / 拡大率)。表情プリセットとは独立系統。
  elements.placementPreset?.addEventListener("change", () => {
    applySelectedPlacementPreset();
  });
  elements.savePlacementPresetButton?.addEventListener("click", () => {
    withBusy(elements.savePlacementPresetButton, "保存中", saveCurrentPlacementPreset).catch((error) => {
      showToast(error.message, "error");
    });
  });
  elements.deletePlacementPresetButton?.addEventListener("click", () => {
    withBusy(elements.deletePlacementPresetButton, "削除中", deleteCurrentPlacementPreset).catch((error) => {
      showToast(error.message, "error");
    });
  });
  bindCharacterLayoutDialog();
  // ピボット指定モード: preview canvas のクリック/ドラッグで pivot X/Y を更新。
  // 値変更時に handleEditorChanged を発火 (= scenario save + 再描画)。
  bindMotionPivotPicker({
    canvas: elements.livePreviewWebglCanvas,
    onChange: handleEditorChanged,
  });
  elements.togglePreviewButton.addEventListener("click", () => {
    if (state.isPlaying) {
      stopPreviewPlayback();
    } else {
      playPreviewPlayback().catch((error) => {
        console.error(error);
        stopPreviewPlayback();
      });
    }
  });
  elements.stepBackPreviewButton?.addEventListener("click", () => stepPlayheadFrame(-1));
  elements.stepForwardPreviewButton?.addEventListener("click", () => stepPlayheadFrame(+1));
  elements.jumpBack1SecButton?.addEventListener("click", () => stepPlayheadFrames(-PROJECT_FPS));
  elements.jumpForward1SecButton?.addEventListener("click", () => stepPlayheadFrames(+PROJECT_FPS));
  elements.seekStartButton?.addEventListener("click", () => seekPlayheadToStart());
  elements.seekEndButton?.addEventListener("click", () => seekPlayheadToEnd());
  // ループトグル: off → cut → scene → off の 3 状態を循環。状態は state.loopMode と
  // ボタンの data-loop-mode 属性 + アイコン (Repeat / Repeat One) で表現。
  // CSS は data-loop-mode 属性で accent カラーかグレーかを切り替える。
  elements.loopModeButton?.addEventListener("click", () => {
    const cycle = ["off", "cut", "scene"];
    const cur = state.loopMode || "off";
    const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
    state.loopMode = next;
    updateLoopModeUi();
  });
  updateLoopModeUi();
  bindExport();
  bindBackup();
  // 復元が完了したら manifest / scenario を再フェッチして編集画面を作り直す。
  // /restore レスポンスにも manifest / scenario が乗っているが、attachScenarioCutsAlias
  // 等を通す共通経路を踏むため、ここでは reloadProjectData() に委ねる。
  bindBackupRestoreHandler(async () => {
    await reloadProjectData();
  });
  elements.dashboardHelpButton?.addEventListener("click", () => {
    // FastAPI が /docs を Swagger UI に予約しているため、ヘルプは /help/ で配信。
    window.open("/help/", "_blank", "noopener,noreferrer");
  });
  elements.projectDuplicateForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(elements.confirmProjectDuplicateButton, "複製中", submitProjectDuplicate).catch((error) => {
      console.error(error);
      showToast("プロジェクト複製に失敗しました", "error");
    });
  });
  elements.cancelProjectDuplicateButton?.addEventListener("click", closeProjectDuplicateDialog);
  elements.openSettingsButton.addEventListener("click", () => {
    // ダイアログを開くたびにフォームを保存済み値で再構築する。
    // 前回未保存のまま「閉じる」で閉じた場合、DOM 上に残った入力値が「保存されている」
    // ように見えるバグ対策。fillConfigForm は内部で fillMotionConfigForm /
    // fillTelopDefaultsForm / updateSpeechPreview まで呼ぶので、全タブが一括リセットされる。
    fillConfigForm();
    elements.settingsDialog.showModal();
    centerSettingsDialog();
  });
  elements.defaultFontFamily.addEventListener("change", () => {
    fillDefaultFontWeights(elements.defaultFontWeight.value);
  });
  elements.telopDefaultFontFamily?.addEventListener("change", () => {
    fillTelopDefaultFontWeights(elements.telopDefaultFontWeight?.value || "regular");
  });
  for (const input of [
    elements.boxBorderColor,
    elements.boxBackgroundColor,
    elements.textColor,
    elements.textOutlineColor,
    elements.telopDefaultColor,
    elements.telopDefaultOutlineColor,
    elements.telopDefaultGlowColor,
    elements.telopDefaultDropShadowColor,
  ]) {
    if (!input) continue;
    input.addEventListener("input", syncColorDisplays);
    input.addEventListener("change", syncColorDisplays);
  }
  for (const input of [
    elements.defaultBoxOpacity,
    elements.boxBorderWidth,
    elements.textOutlineWidth,
    elements.defaultFontFamily,
    elements.defaultFontWeight,
    elements.defaultFontSize,
    elements.speakerNameFontSize,
    elements.defaultShowSpeakerName,
    elements.boxBorderColor,
    elements.boxBackgroundColor,
    elements.textColor,
    elements.textOutlineColor,
    elements.boxBorderRadiusTL,
    elements.boxBorderRadiusTR,
    elements.boxBorderRadiusBL,
    elements.boxBorderRadiusBR,
    elements.speechOffsetX,
    elements.speechOffsetY,
    elements.speechPaddingX,
    elements.speechPaddingY,
    elements.boxOverlayImage,
  ]) {
    if (!input) continue;
    input.addEventListener("input", updateSpeechPreview);
    input.addEventListener("change", updateSpeechPreview);
  }
  // 文字色などのカラー入力: スウォッチ (input[type=color]) 隣の HEX 表示 (span) を
  // 編集可能なテキスト入力に格上げする (= ネイティブのカラーパレットを開かずに
  // #rrggbb を直接打ち替えられる)。確定 (change) 時に input[type=color] へ書き戻し、
  // input/change を再発火させることで既存の debouncedEditorChanged 経路を通して
  // シナリオへ反映する。差し替えた input は elements[<valueKey>] に再代入して、
  // scenario-actions の同期コード (setColorInputWithSwatch 等) が新ノードを参照する
  // ようにする。
  const COLOR_SWATCH_KEYS = [
    ["cutTextColor", "cutTextColorValue", "#ffffff"],
    ["cutTextOutlineColor", "cutTextOutlineColorValue", "#666666"],
    ["characterColorFilterColor", "characterColorFilterColorValue", "#ffe8f9"],
    ["characterGlowColor", "characterGlowColorValue", "#ffffff"],
    ["characterDropShadowColor", "characterDropShadowColorValue", "#000000"],
    ["cutDialogueGlowColor", "cutDialogueGlowColorValue", "#ffffff"],
    ["cutDialogueDropShadowColor", "cutDialogueDropShadowColorValue", "#000000"],
    ["backgroundColor", "backgroundColorValue", "#000000"],
    // 全体設定ダイアログ (テロップ/セリフ既定) + セリフ枠
    ["boxBorderColor", "boxBorderColorValue", "#ffffff"],
    ["boxBackgroundColor", "boxBackgroundColorValue", "#000000"],
    ["textColor", "textColorValue", "#ffffff"],
    ["textOutlineColor", "textOutlineColorValue", "#666666"],
    ["telopDefaultColor", "telopDefaultColorValue", "#ffffff"],
    ["telopDefaultOutlineColor", "telopDefaultOutlineColorValue", "#000000"],
    ["telopDefaultGlowColor", "telopDefaultGlowColorValue", "#ffffff"],
    ["telopDefaultDropShadowColor", "telopDefaultDropShadowColorValue", "#000000"],
    ["defaultDialogueGlowColor", "defaultDialogueGlowColorValue", "#ffffff"],
    ["defaultDialogueDropShadowColor", "defaultDialogueDropShadowColorValue", "#000000"],
  ];
  const parseHexInput = (raw, fallback) => {
    let t = String(raw || "").trim();
    if (t && t[0] !== "#") t = `#${t}`;
    if (/^#[0-9a-f]{3}$/i.test(t) || /^#[0-9a-f]{6}$/i.test(t)) {
      return normalizeColorValue(t, fallback);
    }
    return null;
  };
  for (const [inputKey, valueKey, fallback] of COLOR_SWATCH_KEYS) {
    const input = elements[inputKey];
    const span = elements[valueKey];
    if (!input || !span || span.tagName === "INPUT") continue;
    const text = document.createElement("input");
    text.type = "text";
    text.id = span.id;
    text.className = span.className;
    text.spellcheck = false;
    text.maxLength = 7;
    text.setAttribute("aria-label", "色 (HEX)");
    const initial = normalizeColorValue(input.value, fallback);
    text.value = initial;
    text.style.setProperty("--color-value", initial);
    span.replaceWith(text);
    elements[valueKey] = text;
    // picker (input[type=color]) → text 同期。プログラム的な change でも追従させる。
    const syncFromPicker = () => {
      const v = normalizeColorValue(input.value, fallback);
      text.value = v;
      text.style.setProperty("--color-value", v);
    };
    input.addEventListener("input", syncFromPicker);
    input.addEventListener("change", syncFromPicker);
    // 入力中 (input) は live プレビューのみ、確定 (change) で picker へ書き戻す。
    text.addEventListener("input", () => {
      const v = parseHexInput(text.value, fallback);
      if (v) text.style.setProperty("--color-value", v);
    });
    text.addEventListener("change", () => {
      const v = parseHexInput(text.value, fallback) || normalizeColorValue(input.value, fallback);
      text.value = v;
      text.style.setProperty("--color-value", v);
      if (input.value !== v) {
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  // 移動モーション「計算」: カットの表示時間 (お芝居タブの duration) を frame に
  // 直し、開始フレームを引いた残り (= 表示終端までの尺) を持続フレームへ自動入力する。
  if (elements.cutMotionMoveDurationCalcButton) {
    elements.cutMotionMoveDurationCalcButton.addEventListener("click", () => {
      // duration 入力は bindTimecodeInput が dataset.frames に確定値を保持する。
      // 未確定の編集中でも拾えるよう、dataset → 表示値の parse の順でフォールバック。
      const dsFrames = Number(elements.duration?.dataset?.frames);
      const totalFrames = Number.isFinite(dsFrames) && dsFrames > 0
        ? Math.round(dsFrames)
        : parseTimecode(elements.duration?.value, PROJECT_FPS);
      if (totalFrames == null) {
        showToast("カットの表示時間を読み取れませんでした", "error");
        return;
      }
      const startFrame = Math.max(0, Math.floor(Number(elements.cutMotionMoveStartFrame?.value) || 0));
      const durationFrame = Math.max(1, totalFrames - startFrame);
      if (!elements.cutMotionMoveDurationFrame) return;
      elements.cutMotionMoveDurationFrame.value = String(durationFrame);
      // change を発火して既存の編集反映 (debouncedEditorChanged) 経路へ載せる。
      elements.cutMotionMoveDurationFrame.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  elements.closeSettingsButton.addEventListener("click", () => {
    elements.settingsDialog.close();
  });
  elements.closeCharacterManagerButton.addEventListener("click", () => {
    elements.characterManagerDialog.close();
  });
  window.addEventListener("resize", () => {
    if (elements.settingsDialog.open) {
      const rect = elements.settingsDialog.getBoundingClientRect();
      positionSettingsDialog(rect.left, rect.top);
    }
    if (elements.characterManagerDialog.open) {
      centerDialog(elements.characterManagerDialog);
    }
  });
  // ページ離脱時に再生ヘッドを sendBeacon で確実に送る（タブ閉じ・リロード両対応）。
  window.addEventListener("pagehide", flushPlayheadOnUnload);
  window.addEventListener("pagehide", flushThumbnailOnUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPlayheadOnUnload();
      flushThumbnailOnUnload();
    }
  });
  elements.saveConfigButton.addEventListener("click", () => {
    withBusy(elements.saveConfigButton, "保存中", saveConfig).catch((error) => {
      console.error(error);
      showToast("設定保存に失敗しました", "error");
    });
  });
  elements.saveCharacterManagerButton.addEventListener("click", () => {
    withBusy(elements.saveCharacterManagerButton, "保存中", saveCharacterManager).catch((error) => {
      console.error(error);
      showToast("キャラクター定義の保存に失敗しました", "error");
    });
  });
  elements.deleteCharacterManagerButton.addEventListener("click", () => {
    withBusy(elements.deleteCharacterManagerButton, "削除中", deleteCharacterManagerCharacter).catch((error) => {
      console.error(error);
      showToast("キャラクター削除に失敗しました", "error");
    });
  });
  for (const tab of elements.settingsTabs) {
    tab.addEventListener("click", () => {
      activateSettingsTab(tab.dataset.tab);
      // バックアップタブを開いたら一覧を即時 fetch して表示する。
      if (tab.dataset.tab === "backup") {
        refreshBackupList();
      }
    });
  }
  for (const tab of elements.controlTabs) {
    tab.addEventListener("click", () => activateControlTab(tab.dataset.controlTab));
  }
  applyEditorTargetView();
  bindSettingsDrag();
  elements.savePresetButton.addEventListener("click", () => {
    withBusy(elements.savePresetButton, "保存中", saveCurrentPreset).catch((error) => {
      console.error(error);
      showToast("表情プリセット保存に失敗しました", "error");
    });
  });
  elements.deletePresetButton.addEventListener("click", () => {
    withBusy(elements.deletePresetButton, "削除中", deleteCurrentPreset).catch((error) => {
      console.error(error);
      showToast("表情プリセット削除に失敗しました", "error");
    });
  });
  // ツールバー overflow (>>) の動的振り分けを起動。
  bindAllToolbarOverflow();
}

async function init() {
  // ui-state は他の取得と並行して投げるが、init の早い段階で結果が必要なので
  // 先に dispatch して後で await する。
  const uiStatePromise = fetch("/api/ui-state")
    .then((r) => (r.ok ? r.json() : { view: "editor" }))
    .catch(() => ({ view: "editor" }));

  await loadProjects();
  if (!state.activeProjectId && state.projects.length === 0) {
    bindControls();
    clearProjectData();
    // 初回起動 (アクティブな scene が無い) なので「離脱直前のサムネ保存」は
    // 不要 + そもそも撮るべき GL canvas が無い。captureBeforeLeave=false で skip。
    await showProjectDashboard({ captureBeforeLeave: false });
    return;
  }
  const initProjectId = state.activeProjectId || "";
  const initManifestUrl = initProjectId
    ? `/api/projects/${encodeURIComponent(initProjectId)}/manifest`
    : "/api/manifest";
  const initScenarioUrl = initProjectId
    ? `/api/projects/${encodeURIComponent(initProjectId)}/scenario`
    : "/api/scenario";
  const [manifestResponse, scenarioResponse, globalConfigData, , uiState] = await Promise.all([
    fetch(initManifestUrl),
    fetch(initScenarioUrl),
    fetchGlobalConfig().catch(() => null),
    fetchTtsState().catch((err) => {
      console.warn("tts state 取得失敗", err);
      return null;
    }),
    uiStatePromise,
  ]);
  const desiredView = uiState?.view === "editor" ? "editor" : "dashboard";
  state.manifest = await manifestResponse.json();
  if (initProjectId && state.manifest?.projectId && state.manifest.projectId !== initProjectId) {
    throw new Error(`manifest project mismatch: expected ${initProjectId}, got ${state.manifest.projectId}`);
  }
  if (state.manifest?.projectId) state.activeProjectId = state.manifest.projectId;
  state.scenario = attachScenarioCutsAlias(await scenarioResponse.json());
  state.loadedProjectId = state.activeProjectId || initProjectId || "";
  if (globalConfigData) {
    state.globalConfig = globalConfigData;
    state.history.maxSize = globalConfigData.config?.editorHistorySize ?? 50;
  }
  // 自動バックアップタイマー起動 (globalConfig.backup.autoIntervalMinutes 間隔)。
  // activeProject が無い間は no-op で空回りするだけなので無条件に起動 OK。
  startAutoBackupTimer();
  // FontFace API でプロジェクトの実フォントを canvas に届ける（書き出しと描画を一致させる）
  state.projectFontsReady = registerProjectFonts().catch((err) =>
    console.warn("registerProjectFonts failed", err),
  );
  // PC インストール済みフォントのスキャン完了を待ってフォント一覧へ反映する
  watchSystemFontsReady(refreshManifest);
  const defaults = state.manifest.defaults;

  fillProjectSelect();
  fillAssetControls();

  state.currentCharacters = [];
  renderCharacterSelect();
  elements.background.value = defaults.background;
  loadCharacterIntoControls(selectedCharacter());
  elements.fontSize.value = defaults.textStyle.fontSize;
  elements.align.value = defaults.textStyle.align;
  elements.speechPlacement.value = defaults.textStyle.speechPlacement || "bottom";
  elements.lines.value = defaults.textStyle.lines;
  elements.boxOpacity.value = opacityToUi(defaults.textStyle.boxOpacity);
  elements.showSpeechBox.checked = true;
  elements.showCharacter.checked = true;
  elements.duration.value = "00:03.00";
  elements.duration.dataset.frames = String(24 * 3);
  setAudioPath("");
  elements.fontFamily.value = defaults.textStyle.fontFamily || state.manifest.config.defaultFont;
  fillFontWeights(defaults.textStyle.fontWeight || state.manifest.config.defaultFontWeight || "regular");
  fillConfigForm();
  setTogglePlayUi(false);

  bindControls();
  renderCutList();
  if (state.scenario.cuts.length > 0) {
    // 前回終了時の再生ヘッド (project.json の lastPlayheadFrame) を復元する。
    // reloadProjectData() と同じロジック。未保存 (=0) や範囲外なら cuts[0] へ
    // フォールバック。
    const activeProject = state.projects.find((p) => p.id === state.activeProjectId);
    const savedFrame = Math.max(0, Number(activeProject?.lastPlayheadFrame) || 0);
    const savedSec = savedFrame / PROJECT_FPS;
    let targetCut = state.scenario.cuts[0];
    if (savedFrame > 0) {
      const found = state.scenario.cuts.find((cut) => {
        const s = cutStartSec(cut);
        return savedSec >= s && savedSec < s + cutDurationSec(cut);
      });
      if (found) targetCut = found;
    }
    state.timeline.currentSec = savedFrame > 0 ? savedSec : 0;
    state.isLoadingCut = true;
    await loadCut(targetCut);
    state.isLoadingCut = false;
  } else {
    await renderPreview();
  }
  // 前回最後に表示していた画面を復元する。
  // - desiredView === "editor" + アクティブプロジェクトあり → 編集画面に直行
  //   (HTML 上 #projectDashboard は既定 visible なので hideProjectDashboard で
  //   `.hidden` を付ける)
  // - それ以外 → 従来どおりダッシュボード表示
  // 初回起動 (= 「離脱」ではない) なのでサムネ撮影はどちらの経路でも skip。
  if (desiredView === "editor" && state.activeProjectId) {
    hideProjectDashboard();
  } else {
    await showProjectDashboard({ captureBeforeLeave: false });
  }
}

initTheme();
init();
