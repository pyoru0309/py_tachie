// プロジェクト切替/マニフェスト再取得まわりのアプリ状態管理。
// 「現在のプロジェクトの素材一覧をフォームに反映する」「素材再スキャン」
// 「プロジェクト切替時に state を作り直す」など、複数モジュールを横断する処理を集約。
import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { option, fillSelect } from "./utils.js";
import { attachScenarioCutsAlias, cutStartSec, cutDurationSec } from "./scenario.js";
import { PROJECT_FPS, formatTimecode, framesToSec, secToFrames } from "./timecode.js";
import { clearHistory, recordHistory } from "./history.js";
import {
  selectedCharacter,
  loadCharacterIntoControls,
  renderCharacterSelect,
  fillCharacterDefinitionAddSelect,
} from "./character.js";
import { renderPreview, stopPreviewPlayback, clearPreviewLayerCache } from "./playback.js";
import {
  loadProjects,
  fillProjectSelect,
  renderProjectDashboard,
} from "./project.js";
import { fillExpressionPresets } from "./character-manager.js";
import { fillConfigForm } from "./settings-form.js";
import { ensureSelectValue, loadCut, renderCutList } from "./scenario-actions.js";
import { drawTimeline, autoScrollTimelineToCursor } from "./timeline.js";

let _reloadProjectDataSeq = 0;

export function fillAudioSelect(selected = elements.audio.value) {
  fillSelect(elements.audioSelect, state.manifest.audio || [], true);
  ensureSelectValue(elements.audioSelect, selected);
  elements.audioPathDisplay.textContent = selected || "音声未選択";
}

function fillBackgroundSelect() {
  const select = elements.background;
  // select.innerHTML を入れ替えると現在値が空に飛ぶので、再構築の前後で保持する。
  const previous = select.value;
  select.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "なし（透過）";
  select.append(noneOption);
  for (const item of state.manifest.backgrounds || []) {
    select.append(option(item.name, item.path ?? item.id));
  }
  if (Array.from(select.options).some((opt) => opt.value === previous)) {
    select.value = previous;
  } else if (previous) {
    // manifest に存在しないパス (別プロジェクトから duplicate したカット等) でも
    // 値を失わないように「(欠落) <path>」option を追加して保持する。
    // この option の存在で payload() の elements.background.value が
    // 空文字に倒れず、その後の cut state save で値が消えなくなる。
    const missing = document.createElement("option");
    missing.value = previous;
    missing.textContent = `(欠落) ${previous}`;
    select.append(missing);
    select.value = previous;
  }
}

function fillForegroundSelect() {
  const select = elements.foreground;
  if (!select) return;
  const previous = select.value;
  select.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "なし";
  select.append(noneOption);
  for (const item of state.manifest.foregrounds || []) {
    select.append(option(item.name, item.path ?? item.id));
  }
  if (Array.from(select.options).some((opt) => opt.value === previous)) {
    select.value = previous;
  } else if (previous) {
    // manifest に無いパスは「(欠落)」付き option で保持 (背景と同様)。
    const missing = document.createElement("option");
    missing.value = previous;
    missing.textContent = `(欠落) ${previous}`;
    select.append(missing);
    select.value = previous;
  }
}

export function fillAssetControls() {
  // 注意: ここで elements.background / foreground の値を上書きしないこと。
  // アセット管理操作（キャラ追加など）で本関数が呼ばれた際に、編集中カットの
  // 前景・背景が消えて自動保存で空が書き戻されるバグの原因になる。
  // 値の復元は fillBackgroundSelect / fillForegroundSelect が現在値を保持して行う。
  fillBackgroundSelect();
  fillForegroundSelect();
  fillAudioSelect(elements.audio.value);
  fillSelect(elements.fontFamily, state.manifest.config.fonts, false);
  renderCharacterSelect();
  loadCharacterIntoControls(selectedCharacter());
  fillCharacterDefinitionAddSelect();
  fillExpressionPresets();
}

export async function rescanAssets() {
  const response = await fetch("/api/projects/rescan", { method: "POST" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  state.manifest = await response.json();
  fillAssetControls();
  fillConfigForm();
  showToast("素材を再スキャンしました");
}

export async function refreshManifest() {
  const projectId = state.activeProjectId || state.manifest?.projectId || "";
  const url = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/manifest`
    : "/api/manifest";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const manifest = await response.json();
  if (projectId && manifest?.projectId && manifest.projectId !== projectId) {
    throw new Error(`manifest project mismatch: expected ${projectId}, got ${manifest.projectId}`);
  }
  state.manifest = manifest;
  if (manifest?.projectId) state.activeProjectId = manifest.projectId;
  fillAssetControls();
  fillConfigForm();
  return state.manifest;
}

export async function updateDurationFromAudio(audioPath) {
  if (!audioPath) {
    return;
  }
  const response = await fetch(`/api/audio-duration?path=${encodeURIComponent(audioPath)}`);
  if (!response.ok) {
    return;
  }
  const result = await response.json();
  const seconds = Number(result.roundedDuration ?? result.duration ?? 0);
  const frames = Math.max(1, Math.round(seconds * PROJECT_FPS));
  elements.duration.value = formatTimecode(frames);
  elements.duration.dataset.frames = String(frames);
  showToast(`音声長から表示時間を ${formatTimecode(frames)} にしました`);
}

export function clearProjectData() {
  state.manifest = null;
  state.scenario = attachScenarioCutsAlias({ version: 4, title: "scenario", scenes: [] });
  state.loadedProjectId = "";
  state.selectedCutId = null;
  state.currentCharacters = [];
  state.selectedCharacterIndex = 0;
  state.characterLayerSizes?.clear?.();
  // 再生中 / GL scene を残したまま clearProjectData が呼ばれると、emptyPreview の
  // 半透明オーバーレイの下に直前プロジェクトの GL フレームが透けて見える。hard
  // 停止で video / GL scene / canvas をすべて畳む (audio / BGM も一緒に止まる)。
  stopPreviewPlayback({ hard: true });
  clearPreviewLayerCache();
  elements.cutList.innerHTML = "";
  elements.previewImage.removeAttribute("src");
  elements.emptyPreview.textContent = "プロジェクトを作成または選択してください";
  elements.emptyPreview.style.display = "grid";
  document.title = "立ち絵システム";
  fillProjectSelect();
}

export async function reloadProjectData(options = {}) {
  const reloadSeq = ++_reloadProjectDataSeq;
  const requestedProjectId = options.projectId || state.activeProjectId || "";
  // 再生中にプロジェクトが切り替えられると、playLiveCut のローカル変数 (古い
  // sceneTelops 配列など) が古いプロジェクト参照を保持したまま tick が回り続け、
  // 「直前のプロジェクトのテロップが残存」「描画が二重で重い」現象になる。
  // hard=true で audio / BGM / video element の src / v2 GL scene まで完全停止
  // する (= 旧プロジェクトのリソースをすべて切り離す)。skipPreviewRefresh も
  // hard で自動的に true 扱い (= 停止後の still render とサムネ取得は走らない)。
  stopPreviewPlayback({ hard: true });
  // キャラレイヤーサイズと scene-bundle / 音声 prefetch は project スコープなので、
  // 切替時に毎回クリアする (異なるプロジェクトで同じ id の素材があると壊れる)。
  state.characterLayerSizes?.clear?.();
  clearPreviewLayerCache();
  await loadProjects();
  if (reloadSeq !== _reloadProjectDataSeq) return;
  // loadProjects() は server global active を反映するが、プロジェクト切替直後の
  // reload では呼び出し元が指定した projectId を優先する。これにより別タブ等が
  // active pointer を動かしても、この reload は対象プロジェクトを読み続ける。
  const projectId = requestedProjectId || state.activeProjectId || "";
  if (requestedProjectId) state.activeProjectId = requestedProjectId;
  if (!state.activeProjectId && state.projects.length === 0) {
    clearProjectData();
    clearHistory();
    return;
  }
  const manifestUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/manifest`
    : "/api/manifest";
  const scenarioUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/scenario`
    : "/api/scenario";
  const [manifestResponse, scenarioResponse] = await Promise.all([
    fetch(manifestUrl),
    fetch(scenarioUrl),
  ]);
  if (!manifestResponse.ok) throw new Error(await manifestResponse.text());
  if (!scenarioResponse.ok) throw new Error(await scenarioResponse.text());
  const manifest = await manifestResponse.json();
  const scenario = await scenarioResponse.json();
  if (reloadSeq !== _reloadProjectDataSeq) return;
  if (projectId && manifest?.projectId && manifest.projectId !== projectId) {
    throw new Error(`manifest project mismatch: expected ${projectId}, got ${manifest.projectId}`);
  }
  state.manifest = manifest;
  state.activeProjectId = manifest?.projectId || projectId || state.activeProjectId;
  state.scenario = attachScenarioCutsAlias(scenario);
  state.loadedProjectId = state.activeProjectId || projectId || "";
  fillProjectSelect();
  renderProjectDashboard();
  fillAssetControls();
  fillConfigForm();
  renderCutList();
  if (state.scenario.cuts.length > 0) {
    // 前回終了時の playhead を復元する。lastPlayheadFrame=0 (= 未保存) や
    // シナリオ範囲外なら先頭カットへフォールバック。
    const activeProject = state.projects.find((p) => p.id === state.activeProjectId);
    const savedFrame = Math.max(0, Number(activeProject?.lastPlayheadFrame) || 0);
    const savedSec = framesToSec(savedFrame);
    let targetCut = state.scenario.cuts[0];
    if (savedFrame > 0) {
      const found = state.scenario.cuts.find((cut) => {
        const s = cutStartSec(cut);
        const e = s + cutDurationSec(cut);
        return savedSec >= s && savedSec < e;
      });
      if (found) targetCut = found;
    }
    state.timeline.currentSec = savedFrame > 0 ? savedSec : 0;
    state.isLoadingCut = true;
    await loadCut(targetCut);
    state.isLoadingCut = false;
    // 復元した playhead が timeline viewport の外にあると、リロード直後に再生バーが
    // 完全に隠れる (scrollLeft=0 のまま)。drawTimeline で layout が確定したあと
    // 1 frame 待って autoScrollTimelineToCursor を呼び、画面内に引き込む。
    requestAnimationFrame(() => {
      drawTimeline();
      autoScrollTimelineToCursor();
    });
  } else {
    await renderPreview();
  }
  clearHistory();
  if (!state.projectDashboardVisible) {
    recordHistory();
  }
}

// 再生ヘッドの永続化。updatedAt を巻き込まない軽量保存。
// 連打時は最新値だけ送信されるよう 400ms デバウンスする。
let _playheadSaveTimer = null;
let _playheadSavingFrame = -1;
export function schedulePlayheadSave() {
  if (!state.activeProjectId) return;
  if (_playheadSaveTimer) {
    clearTimeout(_playheadSaveTimer);
  }
  _playheadSaveTimer = setTimeout(() => {
    _playheadSaveTimer = null;
    const frame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
    if (frame === _playheadSavingFrame) return;
    _playheadSavingFrame = frame;
    fetch(`/api/projects/${encodeURIComponent(state.activeProjectId)}/playhead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame }),
    }).catch(() => {
      // 保存失敗は致命的でないので無視（次回保存で追い付く）
    });
  }, 400);
}

// ページ離脱時に最新の playhead を確実に送る (sendBeacon は keepalive 保証あり)。
export function flushPlayheadOnUnload() {
  if (!state.activeProjectId) return;
  const frame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const body = JSON.stringify({ frame });
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(
      `/api/projects/${encodeURIComponent(state.activeProjectId)}/playhead`,
      blob,
    );
  }
}
