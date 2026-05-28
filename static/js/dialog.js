// シーン設定ダイアログ・一括反映系ダイアログを担当する。
// ・シーンタイトル / BPM / 呼吸 / videoTrack / BGM トラック編集
// ・キャラ配置／お芝居の「同一キャラ」「文字設定」「文字枠」一括反映
// ・テキスト/テロップ既定値の差分一括反映
// ・promptBulkApply / promptApplyToAllCuts / promptApplyToAllTelops（共通ダイアログ）

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, migrateInDialogToasts } from "./toast.js";
import { recordHistory } from "./history.js";
import { buttonMarkup, opacityToRender } from "./utils.js";
import { fontDisplayName, globalWeightLabel, weightItemsForFamily } from "./font.js";
import { TEXT_DEFAULT_LABELS, TELOP_DEFAULT_LABELS, TELOP_TOP_LEVEL_KEYS } from "./bulk-apply.js";
import { renderPreview } from "./playback.js";
import { renderTelopTrack, drawTimeline } from "./timeline.js";
import { renderTelopEditor } from "./telop.js";
import {
  selectedCharacter,
  updateSelectedCharacterFromControls,
} from "./character.js";

const deps = {
  saveScenario: async () => {},
  loadCut: async () => {},
  scheduleScenarioSave: () => {},
  updateSelectedCutFromCurrent: () => {},
  activeScene: () => null,
};

export function bindDialog(injected = {}) {
  Object.assign(deps, injected);
}

// =========================================================================
// シーン設定ダイアログ
// =========================================================================

export function populateAssetSelect(select, items, currentValue, { emptyLabel = "なし" } = {}) {
  if (!select) return;
  select.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = emptyLabel;
  select.append(noneOption);
  for (const item of items || []) {
    const opt = document.createElement("option");
    opt.value = item.path || item.id || "";
    opt.textContent = item.name || item.id || opt.value;
    select.append(opt);
  }
  if (currentValue && !Array.from(select.options).some((opt) => opt.value === currentValue)) {
    const opt = document.createElement("option");
    opt.value = currentValue;
    opt.textContent = `${currentValue}（未スキャン）`;
    select.append(opt);
  }
  select.value = currentValue || "";
}

// F5a: ビジュアライザプラグイン一覧 (起動後 1 回だけ取得)
let visualizerPluginsPromise = null;
function loadVisualizerPlugins() {
  if (!visualizerPluginsPromise) {
    visualizerPluginsPromise = fetch("/api/visualizer/plugins")
      .then((r) => r.ok ? r.json() : { plugins: [] })
      .then((data) => Array.isArray(data?.plugins) ? data.plugins : [])
      .catch(() => []);
  }
  return visualizerPluginsPromise;
}

export function fillSceneDialog() {
  const scene = deps.activeScene();
  if (elements.sceneTitle) elements.sceneTitle.value = scene.title || "";
  if (elements.sceneBpm) elements.sceneBpm.value = scene.bpm == null ? "" : Number(scene.bpm);
  const breath = scene.breath || {};
  if (elements.sceneBreathAmplitude)
    elements.sceneBreathAmplitude.value = Number(breath.amplitudePx ?? 0);
  if (elements.sceneBreathPeriod)
    elements.sceneBreathPeriod.value = Number(breath.periodSec ?? 4);
  const bpmBob = scene.bpmBob || {};
  if (elements.sceneBpmBobAmplitude)
    elements.sceneBpmBobAmplitude.value = Number(bpmBob.amplitudePx ?? 0);
  const video = scene.videoTrack;
  const enabled = !!(video && video.src);
  if (elements.sceneVideoEnabled) elements.sceneVideoEnabled.checked = enabled;
  if (elements.sceneVideoFields) elements.sceneVideoFields.hidden = !enabled;
  populateAssetSelect(elements.sceneVideoSrc, state.manifest?.videos || [], video?.src || "");
  if (elements.sceneVideoFit) elements.sceneVideoFit.value = video?.fit || "cover";
  if (elements.sceneVideoLoop) elements.sceneVideoLoop.value = video?.loop || "loop";
  if (elements.sceneVideoSpeed) elements.sceneVideoSpeed.value = video?.speed ?? 1.0;
  if (elements.sceneVideoTrimStart) elements.sceneVideoTrimStart.value = video?.trimStartSec ?? 0;
  if (elements.sceneVideoTrimEnd) elements.sceneVideoTrimEnd.value = video?.trimEndSec ?? "";
  if (elements.sceneVideoMuted) elements.sceneVideoMuted.checked = video?.muted ?? true;
  renderSceneBgmList();
  fillSceneVisualizerSection();
}

// =============================================================================
// F5a: シーンの「オーディオビジュアライザー」セクション
// =============================================================================

async function fillSceneVisualizerSection() {
  const scene = deps.activeScene();
  if (!scene.visualizer || typeof scene.visualizer !== "object") {
    scene.visualizer = { enabled: false, pluginKey: "", audioTrackId: "", layer: "above_bg", params: {} };
  }
  const viz = scene.visualizer;
  if (elements.sceneVisualizerEnabled) elements.sceneVisualizerEnabled.checked = !!viz.enabled;
  if (elements.sceneVisualizerLayer) {
    const allowed = new Set(["above_bg", "above_chars", "above_fg"]);
    elements.sceneVisualizerLayer.value = allowed.has(viz.layer) ? viz.layer : "above_bg";
  }

  // 音源 BGM トラック select
  if (elements.sceneVisualizerAudio) {
    elements.sceneVisualizerAudio.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "音源なし (時間駆動のみ)";
    elements.sceneVisualizerAudio.append(noneOpt);
    for (const track of scene.bgmTracks || []) {
      if (!track || !track.src) continue;
      const opt = document.createElement("option");
      opt.value = track.src;
      opt.textContent = track.src;
      elements.sceneVisualizerAudio.append(opt);
    }
    elements.sceneVisualizerAudio.value = viz.audioTrackId || "";
  }

  // プラグイン select (非同期で /api 取得)
  const plugins = await loadVisualizerPlugins();
  if (elements.sceneVisualizerPlugin) {
    elements.sceneVisualizerPlugin.innerHTML = "";
    if (plugins.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(プラグインが見つかりません)";
      elements.sceneVisualizerPlugin.append(opt);
    } else {
      for (const p of plugins) {
        const opt = document.createElement("option");
        opt.value = p.key;
        opt.textContent = p.name || p.key;
        elements.sceneVisualizerPlugin.append(opt);
      }
      const desired = viz.pluginKey && plugins.some((p) => p.key === viz.pluginKey)
        ? viz.pluginKey
        : plugins[0].key;
      elements.sceneVisualizerPlugin.value = desired;
      if (!viz.pluginKey) viz.pluginKey = desired;
    }
  }

  renderSceneVisualizerParams(plugins, viz);
}

function renderSceneVisualizerParams(plugins, viz) {
  const container = elements.sceneVisualizerParams;
  if (!container) return;
  container.innerHTML = "";
  const plugin = plugins.find((p) => p.key === viz.pluginKey);
  if (!plugin) return;
  const params = Array.isArray(plugin.params) ? plugin.params : [];
  if (params.length === 0) {
    const note = document.createElement("p");
    note.className = "asset-hint";
    note.textContent = "このプラグインには調整パラメータがありません";
    container.append(note);
    return;
  }
  for (const spec of params) {
    const value = (viz.params && Object.hasOwn(viz.params, spec.key))
      ? viz.params[spec.key]
      : spec.default;
    const label = document.createElement("label");
    label.className = "visualizer-param";
    const labelText = document.createElement("span");
    labelText.className = "visualizer-param-label";
    labelText.textContent = spec.label || spec.key;
    label.append(labelText);

    let input;
    const type = String(spec.type || "number");
    if (type === "color") {
      const wrap = document.createElement("span");
      wrap.className = "color-control";
      input = document.createElement("input");
      input.type = "color";
      input.value = String(value || "#ffffff");
      const swatch = document.createElement("span");
      swatch.className = "color-value";
      swatch.textContent = input.value;
      swatch.style.setProperty("--color-value", input.value);
      input.addEventListener("input", () => {
        swatch.textContent = input.value;
        swatch.style.setProperty("--color-value", input.value);
      });
      wrap.append(input, swatch);
      label.append(wrap);
    } else if (type === "select") {
      input = document.createElement("select");
      const options = Array.isArray(spec.options) ? spec.options : [];
      for (const opt of options) {
        const optionEl = document.createElement("option");
        if (typeof opt === "string") {
          optionEl.value = opt;
          optionEl.textContent = opt;
        } else {
          optionEl.value = String(opt.value ?? opt.key ?? "");
          optionEl.textContent = String(opt.label ?? opt.value ?? opt.key ?? "");
        }
        input.append(optionEl);
      }
      input.value = String(value ?? "");
      label.append(input);
    } else if (type === "font") {
      // プロジェクトの manifest.config.fonts から自動生成。
      // 空オプション = "(プロジェクト既定)"。
      input = document.createElement("select");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "(プロジェクト既定)";
      input.append(empty);
      const fonts = (state.manifest?.config?.fonts) || [];
      for (const f of fonts) {
        const opt = document.createElement("option");
        opt.value = String(f.id || "");
        opt.textContent = String(f.name || f.id || "");
        input.append(opt);
      }
      input.value = String(value ?? "");
      label.append(input);
    } else if (type === "font_weight") {
      // 中身は family が決まってから container 側で再構築する。初期は全 weight。
      input = document.createElement("select");
      _fillVizFontWeightSelect(input, "", String(value ?? ""));
      label.append(input);
    } else {
      input = document.createElement("input");
      input.type = "number";
      if (spec.min != null) input.min = String(spec.min);
      if (spec.max != null) input.max = String(spec.max);
      if (spec.step != null) input.step = String(spec.step);
      input.value = String(value ?? spec.default ?? 0);
      label.append(input);
    }
    input.dataset.paramKey = spec.key;
    input.dataset.paramType = type;
    // family を変えたら同じ container 内の font_weight セレクタを書体が持つ
     // weight だけに絞る (本体 telop / dialogue と同じ整合)。
    if (type === "font") {
      input.addEventListener("change", () => {
        const familyId = input.value;
        for (const wsel of container.querySelectorAll('select[data-param-type="font_weight"]')) {
          _fillVizFontWeightSelect(wsel, familyId, wsel.value);
        }
      });
    }
    container.append(label);
  }
  // 全 param 描画後、現在の family 値で weight セレクタを絞り込む。
  const fontSel = container.querySelector('select[data-param-type="font"]');
  const familyId = fontSel ? fontSel.value : "";
  for (const wsel of container.querySelectorAll('select[data-param-type="font_weight"]')) {
    _fillVizFontWeightSelect(wsel, familyId, wsel.value);
  }
}

// 書体が持つ weight だけを option として詰める。先頭は "(プロジェクト既定)"。
// preferredValue が新リストに無ければ regular → 先頭、空文字の順でフォールバック。
function _fillVizFontWeightSelect(selectEl, familyId, preferredValue) {
  selectEl.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "(プロジェクト既定)";
  selectEl.append(empty);
  // family 未指定 (= プロジェクト既定) のときは全 weight を見せる。指定済なら
  // weightItemsForFamily で絞り込み (= 書体が持つ weight だけ)。
  let items;
  if (!familyId) {
    items = (state.manifest?.config?.fontWeights) || [
      { id: "regular", name: "Regular" },
      { id: "medium", name: "Medium" },
      { id: "bold", name: "Bold" },
      { id: "black", name: "Black" },
    ];
  } else {
    items = weightItemsForFamily(familyId);
  }
  for (const w of items) {
    const opt = document.createElement("option");
    opt.value = String(w.id || "");
    opt.textContent = String(w.name || w.id || "");
    selectEl.append(opt);
  }
  let next = String(preferredValue ?? "");
  const exists = items.some((w) => String(w.id) === next);
  if (!exists) {
    if (items.some((w) => w.id === "regular")) next = "regular";
    else if (items[0]) next = String(items[0].id);
    else next = "";
  }
  selectEl.value = next;
}

function readVisualizerParamsFromControls() {
  const out = {};
  const container = elements.sceneVisualizerParams;
  if (!container) return out;
  for (const el of container.querySelectorAll("[data-param-key]")) {
    const key = el.dataset.paramKey;
    const type = el.dataset.paramType;
    if (type === "color" || type === "select" || type === "font" || type === "font_weight") {
      out[key] = el.value;
    } else {
      const n = Number(el.value);
      out[key] = Number.isFinite(n) ? n : 0;
    }
  }
  return out;
}

export function readSceneVideoTrack() {
  if (!elements.sceneVideoEnabled?.checked) return null;
  const src = String(elements.sceneVideoSrc?.value || "").trim();
  if (!src) return null;
  const trimEndRaw = elements.sceneVideoTrimEnd?.value;
  return {
    src,
    fit: elements.sceneVideoFit?.value || "cover",
    loop: elements.sceneVideoLoop?.value || "loop",
    speed: Math.max(0.05, Number(elements.sceneVideoSpeed?.value) || 1.0),
    trimStartSec: Math.max(0, Number(elements.sceneVideoTrimStart?.value) || 0),
    trimEndSec: trimEndRaw === "" ? null : Math.max(0, Number(trimEndRaw) || 0),
    muted: !!elements.sceneVideoMuted?.checked,
  };
}

// シーン設定ダイアログの DOM 値を state.scenario の該当 scene にだけ反映する。
// 副作用 (scheduleScenarioSave / renderPreview / drawTimeline) は **意図的に呼ばない**。
//
// 理由: シーン設定ダイアログはモーダルでプレビューが遮られている。input ごとに
// scene-bundle 取得 + scene rebuild + timeline redraw を走らせると、param 数の多い
// visualizer (bar_spectrum / wave_ribbon / geometric_particles 等) で操作が顕著に
// 重くなる (= 既知バグ報告)。リアルタイムプレビューは見えないので操作中に行う
// 価値がない。重い副作用は ``commitSceneFromDialog()`` (= ダイアログを閉じるとき)
// にまとめて 1 回だけ実行する設計に変更した。
export function applySceneFieldsFromDialog() {
  const scene = deps.activeScene();
  if (!scene) return;
  scene.title = String(elements.sceneTitle?.value || "シーン1");
  const bpmRaw = elements.sceneBpm?.value;
  scene.bpm = bpmRaw === "" ? null : Math.max(0, Number(bpmRaw) || 0);
  scene.videoTrack = readSceneVideoTrack();
  scene.breath = {
    amplitudePx: Math.max(0, Number(elements.sceneBreathAmplitude?.value) || 0),
    periodSec: Math.max(0.5, Number(elements.sceneBreathPeriod?.value) || 4),
  };
  scene.bpmBob = {
    amplitudePx: Math.max(0, Number(elements.sceneBpmBobAmplitude?.value) || 0),
  };
  // F5a: ビジュアライザ設定の書き戻し
  if (!scene.visualizer || typeof scene.visualizer !== "object") scene.visualizer = {};
  scene.visualizer.enabled = !!elements.sceneVisualizerEnabled?.checked;
  scene.visualizer.pluginKey = String(elements.sceneVisualizerPlugin?.value || "");
  scene.visualizer.audioTrackId = String(elements.sceneVisualizerAudio?.value || "");
  const layerVal = String(elements.sceneVisualizerLayer?.value || "above_bg");
  scene.visualizer.layer = ["below_bg", "above_bg", "above_chars", "above_fg"].includes(layerVal) ? layerVal : "above_bg";
  scene.visualizer.params = readVisualizerParamsFromControls();
}

export function commitSceneFromDialog() {
  applySceneFieldsFromDialog();
  deps.scheduleScenarioSave();
  renderPreview();
  // bpm／videoTrack 等はタイムラインの長さ・拍ガイドに直結するので再描画。
  drawTimeline();
}

export function renderSceneBgmList() {
  if (!elements.sceneBgmList) return;
  const scene = deps.activeScene();
  if (!Array.isArray(scene.bgmTracks)) scene.bgmTracks = [];
  const tracks = scene.bgmTracks;
  elements.sceneBgmList.innerHTML = "";
  if (tracks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "telop-empty";
    empty.textContent = "BGM 未登録。「BGM を追加」から作成してください。";
    elements.sceneBgmList.append(empty);
    return;
  }
  tracks.forEach((track, index) => {
    const card = document.createElement("div");
    card.className = "telop-card";
    const header = document.createElement("div");
    header.className = "telop-card-header";
    const title = document.createElement("strong");
    title.textContent = `BGM #${index + 1}`;
    header.append(title);
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "compact-action-button";
    removeButton.innerHTML = buttonMarkup("delete", "削除");
    removeButton.addEventListener("click", () => {
      tracks.splice(index, 1);
      renderSceneBgmList();
      deps.scheduleScenarioSave();
      recordHistory();
      renderTelopTrack();
    });
    header.append(removeButton);
    card.append(header);
    const body = document.createElement("div");
    body.className = "telop-card-body";

    const srcSelect = document.createElement("select");
    populateAssetSelect(srcSelect, state.manifest?.audio || [], track.src || "");
    const srcLabel = document.createElement("label");
    srcLabel.append("ソース", srcSelect);
    srcSelect.addEventListener("change", () => {
      track.src = srcSelect.value || "";
      deps.scheduleScenarioSave();
      recordHistory();
      renderTelopTrack();
    });
    body.append(srcLabel);

    const row = document.createElement("div");
    row.className = "inline-fields";
    const volInput = document.createElement("input");
    volInput.type = "number";
    volInput.min = "0";
    volInput.max = "2";
    volInput.step = "0.05";
    volInput.value = Number(track.volume ?? 1.0);
    const volLabel = document.createElement("label");
    volLabel.append("音量(0〜2)", volInput);
    volInput.addEventListener("change", () => {
      track.volume = Math.max(0, Math.min(2, Number(volInput.value) || 1));
      deps.scheduleScenarioSave();
    });
    row.append(volLabel);

    const trimInput = document.createElement("input");
    trimInput.type = "number";
    trimInput.min = "0";
    trimInput.step = "0.1";
    trimInput.value = Number(track.trimStartSec ?? 0);
    const trimLabel = document.createElement("label");
    trimLabel.append("トリム開始", trimInput);
    trimInput.addEventListener("change", () => {
      track.trimStartSec = Math.max(0, Number(trimInput.value) || 0);
      deps.scheduleScenarioSave();
      renderTelopTrack();
    });
    row.append(trimLabel);

    const fadeInInput = document.createElement("input");
    fadeInInput.type = "number";
    fadeInInput.min = "0";
    fadeInInput.step = "0.1";
    fadeInInput.value = Number(track.fadeInSec ?? 0);
    const fadeInLabel = document.createElement("label");
    fadeInLabel.append("フェードイン", fadeInInput);
    fadeInInput.addEventListener("change", () => {
      track.fadeInSec = Math.max(0, Number(fadeInInput.value) || 0);
      deps.scheduleScenarioSave();
    });
    row.append(fadeInLabel);

    const fadeOutInput = document.createElement("input");
    fadeOutInput.type = "number";
    fadeOutInput.min = "0";
    fadeOutInput.step = "0.1";
    fadeOutInput.value = Number(track.fadeOutSec ?? 0);
    const fadeOutLabel = document.createElement("label");
    fadeOutLabel.append("フェードアウト", fadeOutInput);
    fadeOutInput.addEventListener("change", () => {
      track.fadeOutSec = Math.max(0, Number(fadeOutInput.value) || 0);
      deps.scheduleScenarioSave();
    });
    row.append(fadeOutLabel);
    body.append(row);

    // ループ再生。複数 BGM 同時 ON は排他ではない (それぞれ独立に loop する)。
    const loopRow = document.createElement("label");
    loopRow.className = "checkbox-row";
    loopRow.title = "scene 終端までこのトラックを繰り返し再生する";
    const loopInput = document.createElement("input");
    loopInput.type = "checkbox";
    loopInput.checked = !!track.loop;
    loopInput.addEventListener("change", () => {
      track.loop = !!loopInput.checked;
      deps.scheduleScenarioSave();
      recordHistory();
    });
    const loopText = document.createElement("span");
    loopText.textContent = "このトラックをループする";
    loopRow.append(loopInput, loopText);
    body.append(loopRow);

    // 口パク用入力ソース指定。シーン内 1 トラックのみ ON にできる（仕様上ラジオ式）。
    const lipRow = document.createElement("label");
    lipRow.className = "checkbox-row";
    lipRow.title = "出力ミックスから外し、口パクメーター・口パク振幅判定の入力ソースとして使う";
    const lipInput = document.createElement("input");
    lipInput.type = "checkbox";
    lipInput.checked = !!track.useForLipSync;
    lipInput.addEventListener("change", () => {
      if (lipInput.checked) {
        tracks.forEach((other, idx) => {
          other.useForLipSync = idx === index;
        });
      } else {
        track.useForLipSync = false;
      }
      renderSceneBgmList();
      deps.scheduleScenarioSave();
      recordHistory();
      renderTelopTrack();
    });
    const lipText = document.createElement("span");
    lipText.textContent = "このトラックを口パク入力に使う（出力には流さない）";
    lipRow.append(lipInput, lipText);
    body.append(lipRow);

    card.append(body);
    elements.sceneBgmList.append(card);
  });
}

export function addSceneBgmTrack() {
  const scene = deps.activeScene();
  if (!Array.isArray(scene.bgmTracks)) scene.bgmTracks = [];
  scene.bgmTracks.push({
    src: "",
    volume: 0.6,
    trimStartSec: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    useForLipSync: false,
    loop: false,
  });
  renderSceneBgmList();
  deps.scheduleScenarioSave();
  recordHistory();
}

function setSceneDialogTab(tabId) {
  for (const tab of elements.sceneDialogTabs || []) {
    const active = tab.dataset.sceneTab === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of elements.sceneDialogTabPanels || []) {
    panel.classList.toggle("hidden", panel.dataset.sceneTabPanel !== tabId);
  }
}

let sceneDialogTabsBound = false;
function ensureSceneDialogTabsBound() {
  if (sceneDialogTabsBound) return;
  sceneDialogTabsBound = true;
  for (const tab of elements.sceneDialogTabs || []) {
    tab.addEventListener("click", () => {
      if (tab.disabled) return;
      setSceneDialogTab(tab.dataset.sceneTab);
    });
  }
}

export function openSceneDialog() {
  if (!elements.sceneDialog) return;
  ensureSceneDialogTabsBound();
  setSceneDialogTab("basic");
  fillSceneDialog();
  if (typeof elements.sceneDialog.showModal === "function") {
    elements.sceneDialog.showModal();
  } else {
    elements.sceneDialog.setAttribute("open", "");
  }
}

export function closeSceneDialog() {
  if (!elements.sceneDialog) return;
  if (typeof elements.sceneDialog.close === "function") {
    elements.sceneDialog.close();
  } else {
    elements.sceneDialog.removeAttribute("open");
  }
}

// =========================================================================
// 一括反映ダイアログ／キャラ配置・お芝居の一括適用
// =========================================================================

// ===== キャラ配置「同一キャラに一括適用」 =====
export async function applyCharacterToAllCuts() {
  updateSelectedCharacterFromControls();
  deps.updateSelectedCutFromCurrent();
  const character = selectedCharacter();
  if (!character) {
    showToast("キャラクターが選択されていません");
    return;
  }
  const characterId = character.characterId;
  if (!characterId) {
    showToast("対象キャラのIDが解決できません");
    return;
  }
  const cuts = state.scenario?.cuts || [];
  // 現在のカット以外で同じ characterId を持つキャラ数を数える
  let targetCount = 0;
  for (const cut of cuts) {
    if (cut.id === state.selectedCutId) continue;
    const list = (cut.state?.characters || []);
    if (list.some((c) => c && c.characterId === characterId)) targetCount += 1;
  }
  if (targetCount === 0) {
    showToast("他のカットに同じキャラがいません");
    return;
  }
  const sourceCharacter = {
    x: Number(character.character?.x ?? 0),
    y: Number(character.character?.y ?? 0),
    scale: Number(character.character?.scale ?? 1),
    removeWhite: Boolean(character.removeWhite),
  };
  const items = [
    { key: "x", label: "X 座標", valueText: `${sourceCharacter.x}` },
    { key: "y", label: "Y 座標", valueText: `${sourceCharacter.y}` },
    { key: "scale", label: "拡大率", valueText: sourceCharacter.scale.toFixed(2) },
    { key: "removeWhite", label: "白背景を透過扱いにする", valueText: sourceCharacter.removeWhite ? "ON" : "OFF" },
  ];
  const charLabel = character.name || characterId;
  const result = await promptBulkApply({
    title: "同一キャラに一括適用",
    description: `「${charLabel}」と同じキャラ（characterId=${characterId}）が登場する他の ${targetCount} カットに、チェックを入れた項目を反映します。表情系（ベース・目・口・前髪など）は変更しません。`,
    items,
  });
  if (!result.confirmed || result.selectedKeys.size === 0) return;
  let appliedCount = 0;
  for (const cut of cuts) {
    if (cut.id === state.selectedCutId) continue;
    const list = (cut.state?.characters || []);
    let touched = false;
    for (const target of list) {
      if (!target || target.characterId !== characterId) continue;
      target.character = { ...(target.character || {}) };
      if (result.selectedKeys.has("x")) target.character.x = sourceCharacter.x;
      if (result.selectedKeys.has("y")) target.character.y = sourceCharacter.y;
      if (result.selectedKeys.has("scale")) target.character.scale = sourceCharacter.scale;
      if (result.selectedKeys.has("removeWhite")) target.removeWhite = sourceCharacter.removeWhite;
      touched = true;
    }
    if (touched) appliedCount += 1;
  }
  deps.scheduleScenarioSave();
  recordHistory();
  await renderPreview();
  showToast(`${appliedCount} 件のカットの「${charLabel}」に反映しました`);
}

// ===== お芝居「文字設定を一括反映」 =====
// scope = "all" → 全カット、scope = "same-speaker" → 同一 characterId の話者を持つカットのみ。
// 同一話者反映は「セリフ枠 (showSpeechBox / boxBorder*) は対象外、文字スタイル + glow/dropShadow のみ」を反映。
export async function applyDialogTextStyleToAllCuts(scope = "all") {
  // 入力欄の値で payload() が更新されるため一度呼ぶ
  deps.updateSelectedCutFromCurrent();
  const cuts = state.scenario?.cuts || [];
  if (cuts.length <= 1) {
    showToast("他のカットがありません");
    return;
  }
  const currentCut = cuts.find((c) => c.id === state.selectedCutId);
  const ts = currentCut?.state?.textStyle || {};
  const sourceSpeakerCharId = String(currentCut?.state?.speakerCharacterId || "");
  // 同一話者モードのとき、対象カットを事前に絞り込む。話者キャラ自体の characterId
  // (= state.currentCharacters の中で id === speakerCharacterId のものの characterId) を
  // 比較する。manifest 上のキャラ素材 ID 単位で「同じ人物」を判定。
  const speakerCharacterIdOf = (cut) => {
    if (!cut?.state?.speakerCharacterId) return "";
    const speaker = (cut.state.characters || []).find(
      (c) => c && c.id === cut.state.speakerCharacterId,
    );
    return String(speaker?.characterId || "");
  };
  const sourceCharacterId = speakerCharacterIdOf(currentCut);
  let targetCuts = cuts.filter((c) => c.id !== state.selectedCutId);
  if (scope === "same-speaker") {
    if (!sourceCharacterId) {
      showToast("現在のカットに話者が設定されていません");
      return;
    }
    targetCuts = targetCuts.filter((c) => speakerCharacterIdOf(c) === sourceCharacterId);
    if (targetCuts.length === 0) {
      showToast("同じ話者のカットが他にありません");
      return;
    }
  }
  const source = {
    fontSize: Number(ts.fontSize ?? 0),
    fontFamily: String(ts.fontFamily ?? ""),
    fontWeight: String(ts.fontWeight ?? "regular"),
    textColor: String(ts.textColor ?? "#ffffff"),
    textOutlineWidth: Number(ts.textOutlineWidth ?? 0),
    textOutlineColor: String(ts.textOutlineColor ?? "#666666"),
    align: String(ts.align ?? "left"),
    letterSpacing: Number(ts.letterSpacing ?? 0),
    dialogueGlow: ts.dialogueGlow ? { ...ts.dialogueGlow } : null,
    dialogueDropShadow: ts.dialogueDropShadow ? { ...ts.dialogueDropShadow } : null,
  };
  const otherCount = targetCuts.length;
  const onOff = (v) => (v ? "ON" : "OFF");
  const items = [
    { key: "fontSize", label: "文字サイズ", valueText: `${source.fontSize}px` },
    { key: "fontFamily", label: "書体", valueText: fontDisplayName(source.fontFamily) || source.fontFamily },
    { key: "fontWeight", label: "太さ", valueText: globalWeightLabel(source.fontWeight) },
    { key: "textColor", label: "文字色", valueText: source.textColor },
    { key: "textOutlineWidth", label: "アウトライン", valueText: `${source.textOutlineWidth}px` },
    { key: "textOutlineColor", label: "アウトライン色", valueText: source.textOutlineColor },
    { key: "align", label: "文字揃え", valueText: source.align === "center" ? "中央揃え" : "左揃え" },
    { key: "letterSpacing", label: "文字間", valueText: `${source.letterSpacing} (1/1000em)` },
    { key: "dialogueGlow", label: "セリフ光彩", valueText: onOff(source.dialogueGlow?.enabled) },
    { key: "dialogueDropShadow", label: "セリフドロップシャドウ", valueText: onOff(source.dialogueDropShadow?.enabled) },
  ];
  const title = scope === "same-speaker"
    ? "同一話者の文字設定を一括反映"
    : "セリフの文字設定を一括反映";
  const description = scope === "same-speaker"
    ? `現在のカットと同じ話者 (characterId=${sourceCharacterId}) を持つ他の ${otherCount} カットに、チェックを入れた項目を反映します。セリフ枠は対象外です。`
    : `現在のカットのセリフ文字設定を、他の ${otherCount} カットに反映します。チェックを入れた項目だけが反映されます。`;
  const result = await promptBulkApply({ title, description, items });
  if (!result.confirmed || result.selectedKeys.size === 0) return;
  let count = 0;
  for (const cut of targetCuts) {
    cut.state = cut.state || {};
    cut.state.textStyle = { ...(cut.state.textStyle || {}) };
    for (const k of result.selectedKeys) {
      const v = source[k];
      cut.state.textStyle[k] = (v && typeof v === "object") ? { ...v } : v;
    }
    count += 1;
  }
  deps.scheduleScenarioSave();
  recordHistory();
  await renderPreview();
  showToast(`${count} 件のカットに反映しました`);
}

// ===== 演出「背景・場面を一括適用」 =====
export async function applyEffectSceneToAllCuts() {
  deps.updateSelectedCutFromCurrent();
  const cuts = state.scenario?.cuts || [];
  if (cuts.length <= 1) {
    showToast("他のカットがありません");
    return;
  }
  const currentCut = cuts.find((c) => c.id === state.selectedCutId);
  const cs = currentCut?.state || {};
  const source = {
    background: String(cs.background ?? ""),
    backgroundBlurPx: Math.max(0, Number(cs.backgroundBlurPx) || 0),
    backgroundColor: String(cs.backgroundColor || "#000000"),
    backgroundColorOpacity: Math.max(0, Math.min(1, Number(cs.backgroundColorOpacity) || 0)),
    foreground: String(cs.foreground ?? ""),
  };
  // M-1 で motion は per-character へ移行したため、この「背景・場面の一括適用」
  // からは motion を扱わない (= 各キャラのモーションは「同一キャラに一括適用」
  // 経由でコピーされる)。
  const bgItem = (state.manifest?.backgrounds || []).find((b) => (b.path ?? b.id) === source.background);
  const fgItem = (state.manifest?.foregrounds || []).find((b) => (b.path ?? b.id) === source.foreground);
  const otherCount = cuts.length - 1;
  // 背景色+不透明度はセットで適用 (片方だけ反映する意味がほぼ無いので 1 項目に集約)。
  const bgColorText = source.backgroundColorOpacity > 0
    ? `${source.backgroundColor} (${Math.round(source.backgroundColorOpacity * 100)}%)`
    : "なし（透過）";
  const items = [
    { key: "background", label: "背景", valueText: source.background ? (bgItem?.name || source.background) : "なし（透過）" },
    { key: "backgroundBlurPx", label: "背景ぼかし", valueText: `${source.backgroundBlurPx}px` },
    { key: "backgroundColorPair", label: "背景色 / 不透明度", valueText: bgColorText },
    { key: "foreground", label: "前景", valueText: source.foreground ? (fgItem?.name || source.foreground) : "なし" },
  ];
  const result = await promptBulkApply({
    title: "背景・場面を一括適用",
    description: `現在のカットの背景・場面設定を、他の ${otherCount} カットに反映します。チェックを入れた項目だけが反映されます。`,
    items,
  });
  if (!result.confirmed || result.selectedKeys.size === 0) return;
  let count = 0;
  for (const cut of cuts) {
    if (cut.id === state.selectedCutId) continue;
    cut.state = cut.state || {};
    for (const k of result.selectedKeys) {
      if (k === "backgroundColorPair") {
        // 色 + 不透明度はペアで反映 (片方だけ反映すると意味が崩れる)
        cut.state.backgroundColor = source.backgroundColor;
        cut.state.backgroundColorOpacity = source.backgroundColorOpacity;
      } else {
        cut.state[k] = source[k];
      }
    }
    count += 1;
  }
  deps.scheduleScenarioSave();
  recordHistory();
  await renderPreview();
  showToast(`${count} 件のカットに反映しました`);
}

// ===== 演出「キャラクター効果を一括適用」 =====
export async function applyEffectCharacterToAllCuts() {
  deps.updateSelectedCutFromCurrent();
  const cuts = state.scenario?.cuts || [];
  if (cuts.length <= 1) {
    showToast("他のカットがありません");
    return;
  }
  const currentCut = cuts.find((c) => c.id === state.selectedCutId);
  const eff = (currentCut?.state?.characterEffects && typeof currentCut.state.characterEffects === "object")
    ? currentCut.state.characterEffects
    : {};
  const source = {
    colorFilter: { ...(eff.colorFilter || {}) },
    glow: { ...(eff.glow || {}) },
    dropShadow: { ...(eff.dropShadow || {}) },
  };
  const onOff = (v) => (v ? "ON" : "OFF");
  const otherCount = cuts.length - 1;
  const items = [
    { key: "colorFilter", label: "色フィルター（乗算）", valueText: onOff(source.colorFilter.enabled) },
    { key: "glow", label: "光彩", valueText: onOff(source.glow.enabled) },
    { key: "dropShadow", label: "ドロップシャドウ", valueText: onOff(source.dropShadow.enabled) },
  ];
  const result = await promptBulkApply({
    title: "キャラクター効果を一括適用",
    description: `現在のカットのキャラクター効果（有効/無効・色・強度・オフセットなど）を、他の ${otherCount} カットに反映します。チェックを入れた項目だけが反映されます。`,
    items,
  });
  if (!result.confirmed || result.selectedKeys.size === 0) return;
  let count = 0;
  for (const cut of cuts) {
    if (cut.id === state.selectedCutId) continue;
    cut.state = cut.state || {};
    cut.state.characterEffects = { ...(cut.state.characterEffects || {}) };
    for (const k of result.selectedKeys) {
      // 効果ブロックごと丸ごと差し替え (enabled / color / blurPx / opacity / offsetX / offsetY を含む)
      cut.state.characterEffects[k] = { ...source[k] };
    }
    count += 1;
  }
  deps.scheduleScenarioSave();
  recordHistory();
  await renderPreview();
  showToast(`${count} 件のカットに反映しました`);
}

// ===== お芝居「文字枠を一括設定」 =====
export async function applyDialogBoxStyleToAllCuts() {
  deps.updateSelectedCutFromCurrent();
  const cuts = state.scenario?.cuts || [];
  if (cuts.length <= 1) {
    showToast("他のカットがありません");
    return;
  }
  const currentCut = cuts.find((c) => c.id === state.selectedCutId);
  const ts = currentCut?.state?.textStyle || {};
  const source = {
    speechPlacement: String(ts.speechPlacement || "bottom"),
    lineGap: Number(ts.lineGap ?? 16),
    lines: Number(ts.lines ?? 2),
    showSpeechBox: Boolean(currentCut?.state?.showSpeechBox ?? true),
    showSpeakerName: Boolean(ts.showSpeakerName ?? true),
  };
  const otherCount = cuts.length - 1;
  const placementLabel = ({ bottom: "下", top: "上", left: "左", right: "右", center: "中央" }[source.speechPlacement] || source.speechPlacement);
  const items = [
    { key: "speechPlacement", label: "枠位置", valueText: placementLabel },
    { key: "lineGap", label: "行間", valueText: `${source.lineGap}px` },
    { key: "lines", label: "帯の高さ（行数）", valueText: `${source.lines}段` },
    { key: "showSpeechBox", label: "セリフ枠を表示", valueText: source.showSpeechBox ? "ON" : "OFF" },
    { key: "showSpeakerName", label: "話者名を表示", valueText: source.showSpeakerName ? "ON" : "OFF" },
  ];
  const result = await promptBulkApply({
    title: "セリフの文字枠を一括設定",
    description: `現在のカットの文字枠設定を、他の ${otherCount} カットに反映します。チェックを入れた項目だけが反映されます。`,
    items,
  });
  if (!result.confirmed || result.selectedKeys.size === 0) return;
  let count = 0;
  for (const cut of cuts) {
    if (cut.id === state.selectedCutId) continue;
    cut.state = cut.state || {};
    cut.state.textStyle = { ...(cut.state.textStyle || {}) };
    if (result.selectedKeys.has("speechPlacement")) cut.state.textStyle.speechPlacement = source.speechPlacement;
    if (result.selectedKeys.has("lineGap")) cut.state.textStyle.lineGap = source.lineGap;
    if (result.selectedKeys.has("lines")) cut.state.textStyle.lines = source.lines;
    if (result.selectedKeys.has("showSpeechBox")) cut.state.showSpeechBox = source.showSpeechBox;
    if (result.selectedKeys.has("showSpeakerName")) cut.state.textStyle.showSpeakerName = source.showSpeakerName;
    count += 1;
  }
  deps.scheduleScenarioSave();
  recordHistory();
  await renderPreview();
  showToast(`${count} 件のカットに反映しました`);
}

export async function applyTextDefaultsToAllCuts(diff) {
  const cuts = state.scenario?.cuts || [];
  if (cuts.length === 0 || Object.keys(diff).length === 0) return;
  const update = { ...diff };
  if ("boxOpacity" in update) {
    update.boxOpacity = opacityToRender(update.boxOpacity);
  }
  for (const cut of cuts) {
    cut.state = cut.state || {};
    cut.state.textStyle = { ...(cut.state.textStyle || {}), ...update };
  }
  await deps.saveScenario({ silent: true, projectId: state.activeProjectId });
  const targetId = state.selectedCutId || state.scenario.cuts[0]?.id || null;
  if (targetId) {
    const cut = state.scenario.cuts.find((c) => c.id === targetId);
    if (cut) {
      state.isLoadingCut = true;
      try {
        await deps.loadCut(cut);
      } catch (error) {
        console.error(error);
      } finally {
        state.isLoadingCut = false;
      }
    }
  }
  const labels = Object.keys(diff).map((key) => TEXT_DEFAULT_LABELS[key] || key).join("・");
  showToast(`${cuts.length} 件のカットに ${labels} を反映しました`);
}

export async function applyTelopDefaultsToAllTelops(diff) {
  const scene = deps.activeScene();
  const telops = scene?.telops || [];
  if (!Array.isArray(scene?.telops) || telops.length === 0 || Object.keys(diff).length === 0) return;
  // diff.__sourceKind が指定されていれば、それと kind が一致するテロップのみ反映先にする
  // (= caption の effect 設定を mv_text にコピーしない、Phase 3 仕様)。
  const sourceKind = diff.__sourceKind || null;
  let appliedCount = 0;
  for (const telop of telops) {
    if (!telop || typeof telop !== "object") continue;
    if (sourceKind && String(telop.kind || "caption") !== sourceKind) continue;
    telop.style = telop.style || {};
    for (const [key, value] of Object.entries(diff)) {
      if (key === "__sourceKind") continue;
      if (TELOP_TOP_LEVEL_KEYS.has(key)) {
        // top-level (renderLayer / effectPreset / effectParams / animation) は telop 直下に書く。
        // object は deep copy (= 参照共有を避ける、別 telop の編集が源に波及しないように)。
        telop[key] = (value && typeof value === "object")
          ? JSON.parse(JSON.stringify(value))
          : value;
      } else if (key === "glow" || key === "dropShadow") {
        telop.style[key] = { ...(telop.style[key] || {}), ...(value || {}) };
      } else {
        telop.style[key] = value;
      }
    }
    appliedCount += 1;
  }
  deps.scheduleScenarioSave();
  recordHistory();
  if (state.editorTarget === "telop") renderTelopEditor();
  renderTelopTrack();
  await renderPreview();
  const labelKeys = Object.keys(diff).filter((k) => k !== "__sourceKind");
  const labels = labelKeys.map((key) => TELOP_DEFAULT_LABELS[key] || key).join("・");
  showToast(`${appliedCount} 件のテロップに ${labels} を反映しました`);
}

export function promptApplyToAllTelops({ description } = {}) {
  return new Promise((resolve) => {
    const dialog = elements.applyToAllTelopsDialog;
    const scene = deps.activeScene();
    const telops = scene?.telops || [];
    if (!dialog || telops.length === 0) {
      resolve(false);
      return;
    }
    if (elements.applyToAllTelopsDescription) {
      elements.applyToAllTelopsDescription.textContent =
        description || `シーン内 ${telops.length} 件のテロップに反映しますか？（個別の値を上書きします）`;
    }
    let resolved = false;
    const cleanup = (decision) => {
      if (resolved) return;
      resolved = true;
      elements.applyToAllTelopsConfirmButton.removeEventListener("click", onConfirm);
      elements.applyToAllTelopsCancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(decision);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onClose = () => cleanup(false);
    elements.applyToAllTelopsConfirmButton.addEventListener("click", onConfirm);
    elements.applyToAllTelopsCancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    // 設定ダイアログのトーストを最前面に移す（最前面ダイアログが入れ替わるため）
    migrateInDialogToasts();
  });
}

// 共通バルク反映ダイアログ。
// items: [{ key, label, valueText }] / すべてチェック ON でスタート。
// 戻り値: { confirmed: boolean, selectedKeys: Set<string> }
export function promptBulkApply({ title, description, items, applyLabel, defaultChecked = true } = {}) {
  return new Promise((resolve) => {
    const dialog = elements.bulkApplyDialog;
    if (!dialog || !Array.isArray(items) || items.length === 0) {
      resolve({ confirmed: false, selectedKeys: new Set() });
      return;
    }
    if (elements.bulkApplyTitle) elements.bulkApplyTitle.textContent = title || "一括反映";
    if (elements.bulkApplyDescription) {
      elements.bulkApplyDescription.textContent =
        description || "反映する項目にチェックを入れて、すべてに適用します。";
    }
    if (elements.bulkApplyConfirmButton) {
      const span = elements.bulkApplyConfirmButton.querySelector("span:last-child");
      if (span) span.textContent = applyLabel || "選択した項目を反映";
    }
    const list = elements.bulkApplyList;
    list.innerHTML = "";
    const checkboxes = new Map();
    for (const item of items) {
      const row = document.createElement("label");
      row.className = "bulk-apply-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = defaultChecked;
      cb.dataset.key = item.key;
      const labelSpan = document.createElement("span");
      labelSpan.className = "bulk-apply-item-label";
      labelSpan.textContent = item.label || item.key;
      const valueSpan = document.createElement("span");
      valueSpan.className = "bulk-apply-item-value";
      valueSpan.textContent = item.valueText != null ? String(item.valueText) : "";
      row.append(cb, labelSpan, valueSpan);
      list.append(row);
      checkboxes.set(item.key, cb);
    }
    let resolved = false;
    const cleanup = (decision) => {
      if (resolved) return;
      resolved = true;
      elements.bulkApplyConfirmButton.removeEventListener("click", onConfirm);
      elements.bulkApplyCancelButton.removeEventListener("click", onCancel);
      elements.bulkApplyCheckAllButton.removeEventListener("click", onCheckAll);
      elements.bulkApplyUncheckAllButton.removeEventListener("click", onUncheckAll);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      if (!decision) {
        resolve({ confirmed: false, selectedKeys: new Set() });
        return;
      }
      const selected = new Set();
      for (const [key, cb] of checkboxes) {
        if (cb.checked) selected.add(key);
      }
      resolve({ confirmed: true, selectedKeys: selected });
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onClose = () => cleanup(false);
    const onCheckAll = (event) => {
      event.preventDefault();
      for (const cb of checkboxes.values()) cb.checked = true;
    };
    const onUncheckAll = (event) => {
      event.preventDefault();
      for (const cb of checkboxes.values()) cb.checked = false;
    };
    elements.bulkApplyConfirmButton.addEventListener("click", onConfirm);
    elements.bulkApplyCancelButton.addEventListener("click", onCancel);
    elements.bulkApplyCheckAllButton.addEventListener("click", onCheckAll);
    elements.bulkApplyUncheckAllButton.addEventListener("click", onUncheckAll);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    migrateInDialogToasts();
  });
}

export function promptApplyToAllCuts(diff) {
  return new Promise((resolve) => {
    const cuts = state.scenario?.cuts || [];
    const dialog = elements.applyToAllCutsDialog;
    if (!dialog || cuts.length === 0) {
      resolve(false);
      return;
    }
    const labels = diff && typeof diff === "object"
      ? Object.keys(diff).map((key) => TEXT_DEFAULT_LABELS[key] || key)
      : [];
    const labelText = labels.length > 0 ? labels.join("・") : "デフォルト設定";
    elements.applyToAllCutsDescription.textContent =
      `${labelText} を、プロジェクト内 ${cuts.length} 件のカットに反映しますか？（カット個別の値を上書きします）`;
    let resolved = false;
    const cleanup = (decision) => {
      if (resolved) return;
      resolved = true;
      elements.applyToAllCutsConfirmButton.removeEventListener("click", onConfirm);
      elements.applyToAllCutsCancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(decision);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onClose = () => cleanup(false);
    elements.applyToAllCutsConfirmButton.addEventListener("click", onConfirm);
    elements.applyToAllCutsCancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    // 既に下層ダイアログ（設定ダイアログ等）に乗っていたトーストを最前面に移す
    migrateInDialogToasts();
  });
}

export async function applyDefaultsToAllCuts() {
  const cfg = state.manifest?.config?.textDefaults;
  if (!cfg || !state.scenario?.cuts || state.scenario.cuts.length === 0) return;
  const newTextStyle = {
    fontFamily: cfg.fontFamily,
    fontWeight: cfg.fontWeight,
    fontSize: cfg.fontSize,
    boxOpacity: opacityToRender(cfg.boxOpacity),
    speechPlacement: cfg.speechPlacement,
    boxBorderWidth: cfg.boxBorderWidth,
    boxBorderColor: cfg.boxBorderColor,
    boxBackgroundColor: cfg.boxBackgroundColor,
    textColor: cfg.textColor,
    textOutlineWidth: cfg.textOutlineWidth,
    textOutlineColor: cfg.textOutlineColor,
    boxOverlayImage: cfg.boxOverlayImage,
    speechOffsetX: cfg.speechOffsetX,
    speechOffsetY: cfg.speechOffsetY,
    speechPaddingX: cfg.speechPaddingX,
    speechPaddingY: cfg.speechPaddingY,
    lineGap: cfg.lineGap,
    speakerNameFontSize: cfg.speakerNameFontSize,
    showSpeakerName: cfg.showSpeakerName ?? true,
    inactiveCharacterOpacity: cfg.inactiveCharacterOpacity,
    dialogueGlow: cfg.dialogueGlow ? { ...cfg.dialogueGlow } : null,
    dialogueDropShadow: cfg.dialogueDropShadow ? { ...cfg.dialogueDropShadow } : null,
  };
  for (const cut of state.scenario.cuts) {
    cut.state = cut.state || {};
    cut.state.textStyle = { ...(cut.state.textStyle || {}), ...newTextStyle };
  }
  await deps.saveScenario({ silent: true, projectId: state.activeProjectId });
  if (state.selectedCutId) {
    const cut = state.scenario.cuts.find((c) => c.id === state.selectedCutId);
    if (cut) {
      state.isLoadingCut = true;
      try {
        await deps.loadCut(cut);
      } finally {
        state.isLoadingCut = false;
      }
    }
  } else {
    await renderPreview();
  }
  recordHistory();
  showToast(`${state.scenario.cuts.length} 件のカットに反映しました`);
}
