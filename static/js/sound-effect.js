// ===========================================================================
// 効果音 (scene.soundEffects[]) の編集・追加・複製・削除と編集パネル描画。
// テロップ (telop.js) と同じ scene 単位アイテムなので構造を踏襲しているが、
// 効果音は「開始時間」と「音量」だけのシンプルなモデル。長さはアセット側で決まる。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { fillSelect, generateSoundEffectId } from "./utils.js";
import {
  formatTimecode,
  parseTimecode,
  secToFrames,
  bindTimecodeInput,
  PROJECT_FPS,
} from "./timecode.js";
import {
  cutStartFrame,
  cutDurationFrame,
  soundEffectStartFrame,
  soundEffectStartSec,
  soundEffectDurationFrame,
} from "./scenario.js";
import { showToast } from "./toast.js";
import { recordHistory } from "./history.js";
import { renderTelopTrack } from "./timeline.js";

let deps = {
  activeScene: () => null,
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  loadCut: async () => {},
  applyEditorTargetView: () => {},
};

export function bindSoundEffect(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
}

export function findSoundEffectById(seId) {
  if (!seId) return null;
  const scene = deps.activeScene();
  const list = scene?.soundEffects;
  if (!Array.isArray(list)) return null;
  return list.find((se) => se && se.id === seId) || null;
}

export function defaultSoundEffect() {
  // 再生ヘッド位置に挿入。マニフェストにある最初の効果音アセットを既定で選ぶ。
  const cursorFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const seAssets = state.manifest?.soundEffects || [];
  const firstSrc = seAssets[0]?.path || "";
  return {
    id: generateSoundEffectId(),
    src: firstSrc,
    startFrame: cursorFrame,
    // durationFrame=0 は「素材長そのまま」のセンチネル。ユーザが「終了時間」を
    // 弄ったタイミングで実値が入る。
    durationFrame: 0,
    loop: false,
    fadeInSec: 0,
    fadeOutSec: 0,
    audioOffsetSec: 0,
    volume: 1.0,
  };
}

export function selectSoundEffect(seId, options = {}) {
  const se = findSoundEffectById(seId);
  if (!se) return;
  state.editorTarget = "soundEffect";
  state.selectedSoundEffectId = se.id;
  if (options.preserveMultiSelection) {
    if (!state.selectedSoundEffectIds) state.selectedSoundEffectIds = new Set();
    state.selectedSoundEffectIds.add(se.id);
  } else {
    state.selectedSoundEffectIds = new Set([se.id]);
  }
  // 選択時に playhead 自動移動はしない (= 編集中の再生位置を保つ)。
  // 効果音開始位置を含むカットへの切替だけは行い、編集パネルのカット文脈を保つ。
  const startFrame = soundEffectStartFrame(se);
  const cuts = state.scenario?.cuts || [];
  const targetCut = cuts.find((c) => {
    const cs = cutStartFrame(c);
    const cd = cutDurationFrame(c);
    return cs <= startFrame && startFrame < cs + cd;
  });
  if (targetCut && targetCut.id !== state.selectedCutId) {
    deps.loadCut(targetCut, { keepSoundEffectSelection: true })
      .then(() => {
        deps.applyEditorTargetView();
        renderSoundEffectEditor();
        renderTelopTrack();
      })
      .catch((error) => console.warn("loadCut on soundEffect select failed", error));
    return;
  }
  deps.applyEditorTargetView();
  renderSoundEffectEditor();
  renderTelopTrack();
  deps.renderPreview().catch((error) => console.warn("renderPreview on soundEffect select failed", error));
}

export function clearSoundEffectSelection({ render = true } = {}) {
  const hadMulti = state.selectedSoundEffectIds && state.selectedSoundEffectIds.size > 0;
  if (state.editorTarget === "cut" && !state.selectedSoundEffectId && !hadMulti) return;
  state.editorTarget = "cut";
  state.selectedSoundEffectId = null;
  state.selectedSoundEffectIds = new Set();
  deps.applyEditorTargetView();
  if (render) renderTelopTrack();
}

// 複数選択を一括で差し替える。primaryId は編集パネルが追従する「主」の効果音。
// ids が空のときは全解除 (clearSoundEffectSelection 相当)。
export function setMultiSoundEffectSelection(ids, primaryId) {
  const normalized = new Set();
  for (const id of ids || []) if (id) normalized.add(id);
  if (normalized.size === 0) {
    clearSoundEffectSelection();
    return;
  }
  state.selectedSoundEffectIds = normalized;
  const primary = primaryId && normalized.has(primaryId)
    ? primaryId
    : Array.from(normalized)[0];
  state.editorTarget = "soundEffect";
  state.selectedSoundEffectId = primary;
  deps.applyEditorTargetView();
  renderTelopTrack();
  renderSoundEffectEditor();
}

export function addSoundEffect() {
  const scene = deps.activeScene();
  if (!scene) return;
  if (!Array.isArray(scene.soundEffects)) scene.soundEffects = [];
  const se = defaultSoundEffect();
  scene.soundEffects.push(se);
  scene.soundEffects.sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  selectSoundEffect(se.id);
  deps.renderPreview();
}

export function duplicateSelectedSoundEffect() {
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
  if (list.length === 0) return;
  const ids = Array.from(state.selectedSoundEffectIds && state.selectedSoundEffectIds.size > 0
    ? state.selectedSoundEffectIds
    : (state.selectedSoundEffectId ? [state.selectedSoundEffectId] : []));
  if (ids.length === 0) return;
  const cloned = [];
  let primaryCloneId = null;
  for (const id of ids) {
    const src = list.find((s) => s && s.id === id);
    if (!src) continue;
    const clone = { ...src, id: generateSoundEffectId() };
    // 重なるのは許容する仕様。1フレームだけずらして見分けやすくする (テロップと同じ思想)。
    clone.startFrame = Math.max(0, soundEffectStartFrame(src) + 1);
    scene.soundEffects.push(clone);
    cloned.push(clone);
    if (state.selectedSoundEffectId === id || primaryCloneId === null) {
      primaryCloneId = clone.id;
    }
  }
  if (cloned.length === 0) return;
  scene.soundEffects.sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  if (cloned.length === 1) {
    selectSoundEffect(cloned[0].id);
  } else {
    setMultiSoundEffectSelection(cloned.map((c) => c.id), primaryCloneId);
  }
  deps.renderPreview();
  showToast(cloned.length > 1
    ? `効果音を ${cloned.length} 件複製しました`
    : "効果音を複製しました");
}

export function selectAdjacentSoundEffect(direction) {
  // SE 編集中だけ呼ばれる前提。startFrame 昇順で隣接の SE を選択。
  // 端 (先頭で -1 / 末尾で +1) は何もしない。
  const id = state.selectedSoundEffectId;
  if (!id) return;
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects.slice() : [];
  if (list.length === 0) return;
  list.sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
  const i = list.findIndex((s) => s && s.id === id);
  if (i < 0) return;
  const j = i + (direction > 0 ? 1 : -1);
  if (j < 0 || j >= list.length) return;
  const next = list[j];
  if (next && next.id !== id) selectSoundEffect(next.id);
}

export function deleteSelectedSoundEffect() {
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
  if (list.length === 0) return;
  const ids = new Set(state.selectedSoundEffectIds && state.selectedSoundEffectIds.size > 0
    ? state.selectedSoundEffectIds
    : (state.selectedSoundEffectId ? [state.selectedSoundEffectId] : []));
  if (ids.size === 0) return;
  const before = list.length;
  scene.soundEffects = list.filter((s) => !(s && ids.has(s.id)));
  const removedCount = before - scene.soundEffects.length;
  if (removedCount === 0) return;
  clearSoundEffectSelection({ render: false });
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  deps.renderPreview();
  showToast(removedCount > 1
    ? `効果音を ${removedCount} 件削除しました`
    : "効果音を削除しました");
}

export function renderSoundEffectEditor() {
  const panel = elements.soundEffectEditorPanel;
  const empty = elements.soundEffectEditorEmpty;
  if (!panel) return;
  const seId = state.selectedSoundEffectId;
  const se = findSoundEffectById(seId);
  panel.innerHTML = "";
  if (!se) {
    panel.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  panel.hidden = false;
  if (empty) empty.hidden = true;

  // saveScenario が state.scenario を置き換えうるため、handler 側では
  // 毎回 seId で活きたオブジェクトを引き直す (telop.js と同じパターン)。
  const live = () => findSoundEffectById(seId);

  // 効果音アセット選択
  const srcLabel = document.createElement("label");
  srcLabel.append(document.createTextNode("効果音アセット"));
  const srcSelect = document.createElement("select");
  const assets = (state.manifest?.soundEffects || []).map((item) => ({
    id: item.path,
    name: item.name || item.path,
    path: item.path,
  }));
  fillSelect(srcSelect, assets, /* allowNone */ true);
  srcSelect.value = se.src || "";
  srcSelect.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.src = srcSelect.value || "";
    deps.scheduleScenarioSave();
    renderTelopTrack();
    deps.renderPreview();
  });
  srcLabel.append(srcSelect);
  panel.append(srcLabel);

  const hint1 = document.createElement("p");
  hint1.className = "asset-hint";
  hint1.textContent = "アセット管理の「効果音」に追加した素材から選択できます。";
  panel.append(hint1);

  // 素材長 (durationFrame=0 のときの実効値表示用)
  const assetDurSec = Number(state.soundEffectDurations?.get(se.src)) || 0;
  const assetDurFrames = assetDurSec > 0 ? Math.max(1, Math.round(assetDurSec * PROJECT_FPS)) : 0;

  // 開始時間 / 終了時間
  const row = document.createElement("div");
  row.className = "inline-fields";

  const startLabel = document.createElement("label");
  startLabel.append(document.createTextNode("開始時間"));
  const startInput = document.createElement("input");
  startInput.type = "text";
  bindTimecodeInput(startInput, {
    getFrames: () => soundEffectStartFrame(live() || se),
    setFrames: (frames) => {
      const cur = live();
      if (!cur) return;
      cur.startFrame = Math.max(0, frames | 0);
      deps.scheduleScenarioSave();
      renderTelopTrack();
      deps.renderPreview();
    },
  });
  startLabel.append(startInput);
  row.append(startLabel);

  const endLabel = document.createElement("label");
  endLabel.append(document.createTextNode("終了時間"));
  const endInput = document.createElement("input");
  endInput.type = "text";
  bindTimecodeInput(endInput, {
    // 終了 frame = start + duration。空 (= 素材長そのまま) でも実効値を表示する。
    getFrames: () => {
      const cur = live() || se;
      const s = soundEffectStartFrame(cur);
      const d = soundEffectDurationFrame(cur, assetDurSec);
      return s + d;
    },
    setFrames: (frames) => {
      const cur = live();
      if (!cur) return;
      const s = soundEffectStartFrame(cur);
      // 終了 <= 開始 はガード (最低 1 フレーム)
      const newEnd = Math.max(s + 1, frames | 0);
      cur.durationFrame = newEnd - s;
      deps.scheduleScenarioSave();
      renderTelopTrack();
      deps.renderPreview();
    },
  });
  endLabel.append(endInput);
  row.append(endLabel);
  panel.append(row);

  const endHint = document.createElement("p");
  endHint.className = "asset-hint";
  if (assetDurSec > 0) {
    endHint.textContent = `素材長: ${assetDurSec.toFixed(2)} 秒。終了時間が素材より長い場合は「ループ再生」をオンにすると最後まで埋まります。`;
  } else {
    endHint.textContent = "終了時間が素材より長い場合は「ループ再生」をオンにしてください。";
  }
  panel.append(endHint);

  // ループ / 音量
  const row2 = document.createElement("div");
  row2.className = "inline-fields";

  const loopLabel = document.createElement("label");
  loopLabel.className = "checkbox-row";
  loopLabel.title = "終了時間が素材より長い場合に素材を繰り返す";
  const loopInput = document.createElement("input");
  loopInput.type = "checkbox";
  loopInput.checked = !!se.loop;
  loopInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.loop = loopInput.checked;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  const loopText = document.createElement("span");
  loopText.textContent = "ループ再生";
  loopLabel.append(loopInput, loopText);
  row2.append(loopLabel);

  const volLabel = document.createElement("label");
  volLabel.append(document.createTextNode("音量"));
  const volInput = document.createElement("input");
  volInput.type = "number";
  volInput.min = "0";
  volInput.max = "2";
  volInput.step = "0.05";
  volInput.value = String(se.volume ?? 1.0);
  volInput.addEventListener("input", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(volInput.value);
    cur.volume = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1.0;
    deps.scheduleScenarioSave();
  });
  volLabel.append(volInput);
  row2.append(volLabel);
  panel.append(row2);

  // フェードイン / フェードアウト (秒)
  const row3 = document.createElement("div");
  row3.className = "inline-fields";

  const fadeInLabel = document.createElement("label");
  fadeInLabel.append(document.createTextNode("フェードイン (秒)"));
  const fadeInInput = document.createElement("input");
  fadeInInput.type = "number";
  fadeInInput.min = "0";
  fadeInInput.step = "0.1";
  fadeInInput.value = String(se.fadeInSec ?? 0);
  fadeInInput.addEventListener("input", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(fadeInInput.value);
    cur.fadeInSec = Number.isFinite(v) && v >= 0 ? v : 0;
    deps.scheduleScenarioSave();
  });
  fadeInLabel.append(fadeInInput);
  row3.append(fadeInLabel);

  const fadeOutLabel = document.createElement("label");
  fadeOutLabel.append(document.createTextNode("フェードアウト (秒)"));
  const fadeOutInput = document.createElement("input");
  fadeOutInput.type = "number";
  fadeOutInput.min = "0";
  fadeOutInput.step = "0.1";
  fadeOutInput.value = String(se.fadeOutSec ?? 0);
  fadeOutInput.addEventListener("input", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(fadeOutInput.value);
    cur.fadeOutSec = Number.isFinite(v) && v >= 0 ? v : 0;
    deps.scheduleScenarioSave();
  });
  fadeOutLabel.append(fadeOutInput);
  row3.append(fadeOutLabel);
  panel.append(row3);

  const hint2 = document.createElement("p");
  hint2.className = "asset-hint";
  hint2.textContent = "フェードは区間全体の最初と最後だけに適用されます (ループ反復の境目には掛かりません)。";
  panel.append(hint2);
}
