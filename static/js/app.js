import { opacityToUi, debounce } from "./utils.js";
import { bindTimecodeInput, PROJECT_FPS } from "./timecode.js";
import { cutDurationFrame, cutStartSec, cutDurationSec } from "./scenario.js";
import {
  fillFontWeights,
  fillDefaultFontWeights,
  fillTelopDefaultFontWeights,
  registerProjectFonts,
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
import { fetchTtsState } from "./tts.js";
import {
  bindDialogueVoice,
  syncDialogueVoiceFromSpeaker,
} from "./voice-dialogue.js";
import { openCharacterLayerEditor, bindCharacterLayerEditor } from "./character-layer-editor.js";
import { bindPreviewInteractions } from "./preview-interactions.js";
import {
  getActiveScene as _v2GetActiveScene,
  redrawActiveScene as _v2RedrawActiveScene,
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
} from "./timeline.js";
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
} from "./playback.js";
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
  applyEffectCharacterToAllCuts,
  applyTelopDefaultsToAllTelops,
  promptBulkApply,
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
  scheduleScenarioSave,
  handleEditorChanged,
  saveScenario,
  bindAddCutBatchDialog,
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
} from "./scenario-actions.js";
import { duplicateSelectedTelop, deleteSelectedTelops, selectAdjacentTelop } from "./telop.js";
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
function _bindAddItemDropdown() {
  const dropdown = elements.addItemDropdown;
  const trigger = elements.addItemDropdownTrigger;
  if (!dropdown || !trigger) return;
  const menu = dropdown.querySelector(".dropdown-menu");
  if (!menu) return;
  const setOpen = (open) => {
    if (open) {
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
  });
  bindTelop({
    activeScene,
    scheduleScenarioSave,
    renderPreview,
    loadCut,
    applyEditorTargetView,
    applyTelopDefaultsToAllTelops,
    promptBulkApply,
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
    updateSelectedCutFromCurrent,
    scheduleScenarioSave,
    renderPreview,
    syncDialogueVoiceFromSpeaker,
    reloadCurrentCut: async () => {
      const cuts = state.scenario?.cuts || [];
      const cut = cuts.find((c) => c.id === state.selectedCutId);
      if (cut) await loadCut(cut, { keepTelopSelection: true });
    },
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
  });
  bindScenarioActions({
    applyEditorTargetView,
    syncPresetName,
    fillExpressionPresets,
    normalizeBoxOpacityInput,
    syncDialogueVoiceFromSpeaker,
  });
  bindDialogueVoice();
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
  ]) {
    if (!element) continue;
    element.addEventListener("input", debouncedEditorChanged);
    element.addEventListener("change", debouncedEditorChanged);
  }
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
  elements.splitCutAtPlayheadButton?.addEventListener("click", () => {
    // editorTarget に応じて分割対象を切替: 効果音 / 動画レイヤー / (それ以外) カット
    // 効果音 / 動画は新ファイルを生成せず、durationFrame・audioOffsetSec / trimStartSec・
    // trimEndSec の調整で疑似分割する (= 編集中の素材は触らない)。
    try {
      if (state.editorTarget === "soundEffect") {
        splitSelectedSoundEffect();
      } else if (state.editorTarget === "videoLayer") {
        splitSelectedVideoLayer();
      } else {
        splitCutAtPlayhead();
      }
    } catch (error) {
      console.error(error);
      showToast("分割に失敗しました", "error");
    }
  });
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
  const COLOR_INPUT_SWATCHES = [
    [elements.cutTextColor, elements.cutTextColorValue],
    [elements.cutTextOutlineColor, elements.cutTextOutlineColorValue],
    [elements.characterColorFilterColor, elements.characterColorFilterColorValue],
    [elements.characterGlowColor, elements.characterGlowColorValue],
    [elements.characterDropShadowColor, elements.characterDropShadowColorValue],
    [elements.cutDialogueGlowColor, elements.cutDialogueGlowColorValue],
    [elements.cutDialogueDropShadowColor, elements.cutDialogueDropShadowColorValue],
    [elements.backgroundColor, elements.backgroundColorValue],
  ];
  for (const [input, valueEl] of COLOR_INPUT_SWATCHES) {
    if (!input) continue;
    const sync = () => {
      if (valueEl) {
        valueEl.textContent = input.value;
        valueEl.style.setProperty("--color-value", input.value);
      }
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
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
