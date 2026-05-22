// ===========================================================================
// 動画レイヤー (scene.videoLayers[]) の編集・追加・複製・削除と編集パネル描画。
// SE (sound-effect.js) と類似の構造を踏襲しているが:
//   - startFrame + 派生 durationFrame (= (trimEnd - trimStart) * fps) の区間モデル
//   - fit / scale / layer (above_bg / above_fg) の指定
//   - 同一 layer 内の重なりは **許容** (= クロスフェード用途)。z 順は配列順。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { fillSelect, generateVideoLayerId } from "./utils.js";
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
  videoLayerStartFrame,
  videoLayerStartSec,
  videoLayerTrimStartSec,
  videoLayerTrimEndSec,
  videoLayerDurationSec,
} from "./scenario.js";
import { showToast } from "./toast.js";
import { recordHistory } from "./history.js";
import { renderTelopTrack } from "./timeline.js";
import { invalidateRendererCachesForConfigChange } from "./playback.js";

let deps = {
  activeScene: () => null,
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  loadCut: async () => {},
  applyEditorTargetView: () => {},
  refreshManifest: async () => {},
};

export function bindVideoLayer(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
}

// ===========================================================================
// PTS gap 素材の検査 & 再エンコード フロー (2026-05-21)
//
// NVIDIA ShadowPlay 等で録画した素材は frame drop による PTS gap を含むことが
// あり、source-time 駆動の編集経路では映像と音がズレる (= 物理的に音 sample が
// 足りない)。VL の src が決まる経路で probe-gaps を走らせ、検出されたらユーザに
// 再エンコードを促して `.fixed.mp4` (CFR + silence 埋め) に差し替える。
//
// 入力: rel asset path (例 "projects/<id>/assets/videos/foo.mp4")
// 出力: Promise<string | null>
//   - 検査通過 (gap 無し)         → そのまま入力 path を返す
//   - 既に fixed 版が cache 済み  → fixed 版の path を返す
//   - 再エンコード完了             → fixed 版の path を返す
//   - キャンセル / 失敗            → null (= VL attach 中止 or ロールバック)
// ===========================================================================
export async function ensureFixedVideoSource(srcPath) {
  if (!srcPath || !srcPath.trim()) return srcPath || null;
  let probeData;
  try {
    const res = await fetch("/api/video/probe-gaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: srcPath }),
    });
    if (!res.ok) {
      // probe 自体失敗 (= audio stream 無し等) はそのまま使う。後段の VL audio mux
      // が hasAudio=False と判定して amix から除外する経路に乗る。
      console.warn(`[video-fix] probe failed (${res.status}); using src as-is`);
      return srcPath;
    }
    probeData = await res.json();
  } catch (err) {
    console.warn("[video-fix] probe network error; using src as-is", err);
    return srcPath;
  }

  // 既に fixed 版あり + 元 SHA 一致 → 黙って差し替え
  const existing = probeData.existingFixed;
  if (existing && existing.fixedPath) {
    showToast("検査済み: 変換済の素材を使用します", "info");
    return existing.fixedPath;
  }

  if (!probeData.needsFix) return srcPath;

  // 検査ダイアログ
  const choice = await _showFixCheckDialog(srcPath, probeData.probe, probeData.availableEncoders);
  if (!choice) return null;

  // 進捗ダイアログ + SSE
  const fixedPath = await _runReencode(srcPath, choice.encoderKind, choice.targetFps);
  if (!fixedPath) return null;

  // manifest を再 fetch して .fixed.mp4 を select に出せるようにする
  try { await deps.refreshManifest(); } catch (_) { /* ignore */ }
  return fixedPath;
}

function _showFixCheckDialog(srcPath, probe, availableEncoders) {
  return new Promise((resolve) => {
    const dialog = elements.videoFixCheckDialog;
    if (!dialog) {
      // ダイアログが無ければキャンセル扱い (= 安全側)
      resolve(null);
      return;
    }
    const fileName = String(srcPath).split("/").pop() || srcPath;
    if (elements.videoFixCheckFile) elements.videoFixCheckFile.textContent = fileName;
    const audioSec = Number(probe?.audioDurationSec || 0);
    const sourceSec = Number(probe?.sourceDurationSec || 0);
    const totalGap = Number(probe?.totalGapSec || 0);
    const gapCount = (probe?.gaps || []).length;
    if (elements.videoFixCheckDuration) {
      elements.videoFixCheckDuration.textContent =
        `名目 ${_fmtSec(sourceSec)} / 実音長 ${_fmtSec(audioSec)}`;
    }
    if (elements.videoFixCheckGapInfo) {
      elements.videoFixCheckGapInfo.textContent =
        `${gapCount} 箇所 / 合計 ${totalGap.toFixed(2)} 秒`;
    }

    // HW エンコーダ可用性に応じて HW ラジオを表示/非表示。
    // 表示するときは default 選択も HW にする (= 推奨)。
    const hwLabel = elements.videoFixPresetHwLabel;
    const hwName = elements.videoFixPresetHwName;
    const hwHint = elements.videoFixPresetHwHint;
    const preferredHw = availableEncoders?.preferredHw || null;
    const radios = dialog.querySelectorAll('input[name="videoFixPreset"]');
    for (const r of radios) r.checked = false;
    if (preferredHw && hwLabel) {
      hwLabel.hidden = false;
      const label = _HW_DISPLAY[preferredHw] || "ハードウェア";
      const hint = _HW_HINT[preferredHw] || "";
      if (hwName) hwName.textContent = label;
      if (hwHint) hwHint.textContent = hint;
      const hwRadio = dialog.querySelector('input[name="videoFixPreset"][value="hw"]');
      if (hwRadio) hwRadio.checked = true;
    } else {
      if (hwLabel) hwLabel.hidden = true;
      const balancedRadio = dialog.querySelector('input[name="videoFixPreset"][value="balanced"]');
      if (balancedRadio) balancedRadio.checked = true;
    }

    let resolved = false;
    const cleanup = (decision) => {
      if (resolved) return;
      resolved = true;
      elements.videoFixCheckConfirmButton.removeEventListener("click", onConfirm);
      elements.videoFixCheckCancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(decision);
    };
    const onConfirm = (event) => {
      event.preventDefault();
      let selected = "balanced";
      for (const r of radios) if (r.checked) { selected = r.value; break; }
      cleanup({ encoderKind: selected, targetFps: 60 });
    };
    const onCancel = () => cleanup(null);
    const onClose = () => cleanup(null);
    elements.videoFixCheckConfirmButton.addEventListener("click", onConfirm);
    elements.videoFixCheckCancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

const _HW_DISPLAY = {
  videotoolbox: "VideoToolbox (Apple)",
  nvenc: "NVENC (NVIDIA)",
  qsv: "Intel QSV",
  vaapi: "VA-API",
};
const _HW_HINT = {
  videotoolbox: "— Apple Silicon の H.264 専用回路を使用",
  nvenc: "— NVIDIA GPU の H.264 専用回路を使用",
  qsv: "— Intel iGPU の H.264 専用回路を使用",
  vaapi: "— Linux 上の GPU/iGPU の H.264 専用回路を使用",
};

async function _runReencode(srcPath, encoderKind, targetFps) {
  const dialog = elements.videoFixProgressDialog;
  if (!dialog) return null;
  const closeButton = elements.videoFixProgressCloseButton;
  const bar = elements.videoFixProgressBar;
  const text = elements.videoFixProgressText;
  const errorEl = elements.videoFixProgressError;
  if (closeButton) closeButton.disabled = true;
  if (bar) { bar.value = 0; }
  if (text) text.textContent = "0%";
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
  dialog.showModal();

  let fixedPath = null;
  let errorMsg = null;
  try {
    const res = await fetch("/api/video/reencode-fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: srcPath, encoderKind, targetFps }),
    });
    if (!res.ok || !res.body) {
      errorMsg = `サーバ応答エラー (${res.status})`;
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let payload;
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch (_) {
            continue;
          }
          if (typeof payload.progress === "number" && bar) {
            bar.value = payload.progress;
            if (text) text.textContent = `${Math.round(payload.progress * 100)}%`;
          }
          if (payload.error && errorEl) {
            errorEl.hidden = false;
            errorEl.textContent = String(payload.error).slice(-500);
          }
          if (payload.done) {
            if (payload.ok && payload.fixedPath) {
              fixedPath = String(payload.fixedPath);
              if (bar) bar.value = 1;
              if (text) text.textContent = "100%";
            } else {
              errorMsg = errorMsg || "再エンコードに失敗しました";
            }
          }
        }
      }
    }
  } catch (err) {
    errorMsg = `通信エラー: ${err?.message || err}`;
  }

  if (errorMsg) {
    if (errorEl) { errorEl.hidden = false; errorEl.textContent = errorMsg; }
    if (closeButton) {
      closeButton.disabled = false;
      // ユーザが閉じるまで待つ
      await new Promise((resolve) => {
        const onClose = () => { dialog.removeEventListener("close", onClose); resolve(); };
        const onClick = (e) => { e.preventDefault(); dialog.close(); };
        closeButton.addEventListener("click", onClick, { once: true });
        dialog.addEventListener("close", onClose, { once: true });
      });
    }
    return null;
  }

  // 成功: 自動で閉じる
  if (dialog.open) dialog.close();
  showToast("再エンコードが完了しました");
  return fixedPath;
}

function _fmtSec(sec) {
  const v = Number(sec) || 0;
  return `${v.toFixed(2)} 秒`;
}

export function findVideoLayerById(vlId) {
  if (!vlId) return null;
  const scene = deps.activeScene();
  const list = scene?.videoLayers;
  if (!Array.isArray(list)) return null;
  return list.find((vl) => vl && vl.id === vlId) || null;
}

function _videoDurationSecFor(layer) {
  if (!layer?.src) return 0;
  const meta = state.videoLayerDurations.get(layer.src);
  return Number(meta?.duration) || 0;
}

// 動画レイヤーのタイムライン上の長さ (frame)。trim 範囲を frame に変換した派生値。
// duration 未解決時 (= 素材長不明) は最低 1 frame として扱う。
function _videoLayerDurationFrameFor(vl) {
  const totalSec = _videoDurationSecFor(vl);
  const spanSec = videoLayerDurationSec(vl, totalSec);
  return Math.max(1, Math.round(spanSec * PROJECT_FPS));
}

// 複製時の配置先 frame: 元レイヤーの終端 (= startFrame + durationFrame) に置く。
// 同一 layer 内の重なりは許容するので、sibling との衝突回避ロジックは持たない。
// (重なって欲しくないときはユーザがドラッグ / 数値入力で動かす)
function _placeCloneAfterSource(srcLayer) {
  return videoLayerStartFrame(srcLayer) + _videoLayerDurationFrameFor(srcLayer);
}

// 同一 layer (above_bg / above_fg) 内で z 順を 1 つずらす。direction>0 で手前
// (= 配列の後ろへ、scene.add 順で後)、direction<0 で奥。layer 間は跨がない。
function _moveVideoLayerOrder(vlId, direction) {
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : null;
  if (!list) return;
  const idx = list.findIndex((v) => v && v.id === vlId);
  if (idx < 0) return;
  const me = list[idx];
  const sameLayer = (other) => other && other.id !== vlId
    && (other.layer || "above_fg") === (me.layer || "above_fg");
  let swapWith = -1;
  if (direction > 0) {
    for (let i = idx + 1; i < list.length; i += 1) {
      if (sameLayer(list[i])) { swapWith = i; break; }
    }
  } else {
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (sameLayer(list[i])) { swapWith = i; break; }
    }
  }
  if (swapWith < 0) {
    showToast("これ以上動かせません", "info");
    return;
  }
  const tmp = list[idx];
  list[idx] = list[swapWith];
  list[swapWith] = tmp;
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  renderVideoLayerEditor();
  invalidateRendererCachesForConfigChange();
  deps.renderPreview();
}

export function defaultVideoLayer() {
  // 再生ヘッド位置に挿入。manifest.videos の先頭アセットを既定で選ぶ。
  const cursorFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const videos = state.manifest?.videos || [];
  const firstSrc = videos[0]?.path || "";
  return {
    id: generateVideoLayerId(),
    src: firstSrc,
    startFrame: cursorFrame,
    trimStartSec: 0,
    trimEndSec: null,
    fit: "contain",
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    layer: "above_fg",
    opacity: 1.0,
    fadeInEnabled: false,
    fadeInSec: 0.5,
    fadeOutEnabled: false,
    fadeOutSec: 0.5,
    muted: false,
    volume: 1.0,
  };
}

export function selectVideoLayer(vlId, options = {}) {
  const vl = findVideoLayerById(vlId);
  if (!vl) return;
  state.editorTarget = "videoLayer";
  state.selectedVideoLayerId = vl.id;
  if (options.preserveMultiSelection) {
    if (!state.selectedVideoLayerIds) state.selectedVideoLayerIds = new Set();
    state.selectedVideoLayerIds.add(vl.id);
  } else {
    state.selectedVideoLayerIds = new Set([vl.id]);
  }
  // 選択時に playhead 自動移動はしない (= 編集中の再生位置を保つ)。
  // 動画レイヤー開始位置を含むカットへの切替だけ行う。
  const startFrame = videoLayerStartFrame(vl);
  const cuts = state.scenario?.cuts || [];
  const targetCut = cuts.find((c) => {
    const cs = cutStartFrame(c);
    const cd = cutDurationFrame(c);
    return cs <= startFrame && startFrame < cs + cd;
  });
  if (targetCut && targetCut.id !== state.selectedCutId) {
    deps.loadCut(targetCut, { keepVideoLayerSelection: true })
      .then(() => {
        deps.applyEditorTargetView();
        renderVideoLayerEditor();
        renderTelopTrack();
      })
      .catch((error) => console.warn("loadCut on videoLayer select failed", error));
    return;
  }
  deps.applyEditorTargetView();
  renderVideoLayerEditor();
  renderTelopTrack();
  deps.renderPreview().catch((error) => console.warn("renderPreview on videoLayer select failed", error));
}

export function clearVideoLayerSelection({ render = true } = {}) {
  const hadMulti = state.selectedVideoLayerIds && state.selectedVideoLayerIds.size > 0;
  if (state.editorTarget === "cut" && !state.selectedVideoLayerId && !hadMulti) return;
  state.editorTarget = "cut";
  state.selectedVideoLayerId = null;
  state.selectedVideoLayerIds = new Set();
  deps.applyEditorTargetView();
  if (render) renderTelopTrack();
}

// 複数選択を一括で差し替える。primaryId は編集パネルが追従する「主」の動画レイヤー。
// ids が空のときは全解除 (clearVideoLayerSelection 相当)。
export function setMultiVideoLayerSelection(ids, primaryId) {
  const normalized = new Set();
  for (const id of ids || []) if (id) normalized.add(id);
  if (normalized.size === 0) {
    clearVideoLayerSelection();
    return;
  }
  state.selectedVideoLayerIds = normalized;
  const primary = primaryId && normalized.has(primaryId)
    ? primaryId
    : Array.from(normalized)[0];
  state.editorTarget = "videoLayer";
  state.selectedVideoLayerId = primary;
  deps.applyEditorTargetView();
  renderTelopTrack();
  renderVideoLayerEditor();
}

export async function addVideoLayer() {
  const scene = deps.activeScene();
  if (!scene) return;
  const videos = state.manifest?.videos || [];
  if (videos.length === 0) {
    showToast("動画アセットがありません。アセット管理の「動画」に素材を追加してください。", "warn");
    return;
  }
  if (!Array.isArray(scene.videoLayers)) scene.videoLayers = [];
  const vl = defaultVideoLayer();
  // 既定の src を probe & 必要なら再エンコードしてから VL に流す。
  // キャンセル時は VL 追加自体を中止する (= ユーザは「壊れた素材を諦める / 別素材を
  // 用意する」を選択したと解釈)。
  if (vl.src) {
    const ensured = await ensureFixedVideoSource(vl.src);
    if (ensured == null) return;
    vl.src = ensured;
  }
  scene.videoLayers.push(vl);
  scene.videoLayers.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  selectVideoLayer(vl.id);
  // scene-bundle token は cut payload のみ → VL 追加で token は変わらず、active scene
  // の reuse 経路だと新 VL の plane が GL に出ない。明示的に active scene を破棄して
  // 次の renderPreview で再 build させる。
  invalidateRendererCachesForConfigChange();
  deps.renderPreview();
}

export async function duplicateSelectedVideoLayer() {
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  if (list.length === 0) return;
  const ids = Array.from(state.selectedVideoLayerIds && state.selectedVideoLayerIds.size > 0
    ? state.selectedVideoLayerIds
    : (state.selectedVideoLayerId ? [state.selectedVideoLayerId] : []));
  if (ids.length === 0) return;
  // 複数選択: 各項目を個別に複製。配置はそれぞれ元レイヤーの直後 (= _findFreeStartFrameAfter)。
  if (ids.length > 1) {
    // duration 未解決チェックは複製ループ内で個別に走る
    const cloned = [];
    let primaryCloneId = null;
    for (const id of ids) {
      const src = list.find((v) => v && v.id === id);
      if (!src) continue;
      if (src.src && !state.videoLayerDurations.has(src.src)) {
        try {
          const res = await fetch(`/api/video-duration?path=${encodeURIComponent(src.src)}`);
          if (!res.ok) throw new Error(`status ${res.status}`);
          const data = await res.json();
          if (!Number.isFinite(data.duration) || data.duration <= 0) {
            throw new Error("duration invalid");
          }
          state.videoLayerDurations.set(src.src, {
            duration: Number(data.duration),
            width: Number(data.width) || 0,
            height: Number(data.height) || 0,
            hasAudio: !!data.hasAudio,
          });
        } catch (err) {
          console.warn("duplicate video layer (multi): duration fetch failed", err);
          showToast("一部の動画の素材長を取得できませんでした", "error");
          return;
        }
      }
      const clone = { ...src, id: generateVideoLayerId() };
      clone.startFrame = _placeCloneAfterSource(src);
      scene.videoLayers.push(clone);
      cloned.push(clone);
      if (state.selectedVideoLayerId === id || primaryCloneId === null) {
        primaryCloneId = clone.id;
      }
    }
    if (cloned.length === 0) return;
    scene.videoLayers.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
    deps.scheduleScenarioSave();
    recordHistory();
    renderTelopTrack();
    setMultiVideoLayerSelection(cloned.map((c) => c.id), primaryCloneId);
    invalidateRendererCachesForConfigChange();
    deps.renderPreview();
    showToast(`動画レイヤーを ${cloned.length} 件複製しました`);
    return;
  }
  // 単一選択: 既存挙動を維持
  const id = ids[0];
  const src = list.find((v) => v && v.id === id);
  if (!src) return;
  // 配置位置の計算に「動画素材の長さ」が必要。未取得だと _videoLayerDurationFrameFor が
  // 1 frame に倒れて、clone が元レイヤー終端の 1 frame 後に置かれてしまう (素材長が
  // 解決した瞬間に重なり / タイミング不一致が起きる) ので、ここで await する。
  if (src.src && !state.videoLayerDurations.has(src.src)) {
    try {
      const res = await fetch(`/api/video-duration?path=${encodeURIComponent(src.src)}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      if (!Number.isFinite(data.duration) || data.duration <= 0) {
        throw new Error("duration invalid");
      }
      state.videoLayerDurations.set(src.src, {
        duration: Number(data.duration),
        width: Number(data.width) || 0,
        height: Number(data.height) || 0,
        hasAudio: !!data.hasAudio,
      });
    } catch (err) {
      console.warn("duplicate video layer: duration fetch failed", err);
      showToast("動画の素材長を取得できませんでした", "error");
      return;
    }
  }
  const clone = { ...src, id: generateVideoLayerId() };
  // 元レイヤーの終端に配置 (重なりは許容するので衝突回避は不要)。
  clone.startFrame = _placeCloneAfterSource(src);
  scene.videoLayers.push(clone);
  scene.videoLayers.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  selectVideoLayer(clone.id);
  invalidateRendererCachesForConfigChange();
  deps.renderPreview();
  showToast("動画レイヤーを複製しました");
}

export function selectAdjacentVideoLayer(direction) {
  const id = state.selectedVideoLayerId;
  if (!id) return;
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers.slice() : [];
  if (list.length === 0) return;
  list.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
  const i = list.findIndex((v) => v && v.id === id);
  if (i < 0) return;
  const j = i + (direction > 0 ? 1 : -1);
  if (j < 0 || j >= list.length) return;
  const next = list[j];
  if (next && next.id !== id) selectVideoLayer(next.id);
}

export function deleteSelectedVideoLayer() {
  const scene = deps.activeScene();
  const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  if (list.length === 0) return;
  const ids = new Set(state.selectedVideoLayerIds && state.selectedVideoLayerIds.size > 0
    ? state.selectedVideoLayerIds
    : (state.selectedVideoLayerId ? [state.selectedVideoLayerId] : []));
  if (ids.size === 0) return;
  const before = list.length;
  scene.videoLayers = list.filter((v) => !(v && ids.has(v.id)));
  const removedCount = before - scene.videoLayers.length;
  if (removedCount === 0) return;
  clearVideoLayerSelection({ render: false });
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  invalidateRendererCachesForConfigChange();
  deps.renderPreview();
  showToast(removedCount > 1
    ? `動画レイヤーを ${removedCount} 件削除しました`
    : "動画レイヤーを削除しました");
}

// /api/video-duration を引いて state.videoLayerDurations に memoize する。
// 編集パネル展開時に未解決なら fetch、解決済みなら何もしない。
async function _ensureVideoLayerMeta(src) {
  if (!src) return null;
  if (state.videoLayerDurations.has(src)) return state.videoLayerDurations.get(src);
  if (state.videoLayerDurationFetching.has(src)) return null;
  state.videoLayerDurationFetching.add(src);
  try {
    const res = await fetch(`/api/video-duration?path=${encodeURIComponent(src)}`);
    if (res.ok) {
      const data = await res.json();
      const meta = {
        duration: Number(data.duration) || 0,
        width: Number(data.width) || 0,
        height: Number(data.height) || 0,
        hasAudio: !!data.hasAudio,
      };
      state.videoLayerDurations.set(src, meta);
      return meta;
    }
  } catch (_) {
    /* ignore */
  } finally {
    state.videoLayerDurationFetching.delete(src);
  }
  return null;
}

export function renderVideoLayerEditor() {
  const panel = elements.videoLayerEditorPanel;
  const empty = elements.videoLayerEditorEmpty;
  if (!panel) return;
  const vlId = state.selectedVideoLayerId;
  const vl = findVideoLayerById(vlId);
  panel.innerHTML = "";
  if (!vl) {
    panel.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  panel.hidden = false;
  if (empty) empty.hidden = true;

  const live = () => findVideoLayerById(vlId);
  const refreshPanel = () => {
    // duration が後から fetch されてきた場合に trim 入力の最大値を更新するため
    // 編集パネル全体を再描画。
    renderVideoLayerEditor();
  };
  // meta が取れたときだけ refresh する (null = fetching 中 / 失敗 → refresh しない)。
  // null でも refresh すると _ensureVideoLayerMeta → null → refreshPanel → ...の
  // microtask 無限ループでブラウザがフリーズする (playback.js 側が同じ src を先に
  // fetching set へ入れているケースで特に発生)。
  const refreshIfMeta = (m) => { if (m) refreshPanel(); };

  // 動画アセット選択
  const srcLabel = document.createElement("label");
  srcLabel.append(document.createTextNode("動画アセット"));
  const srcSelect = document.createElement("select");
  const assets = (state.manifest?.videos || []).map((item) => ({
    id: item.path,
    name: item.name || item.path,
    path: item.path,
  }));
  fillSelect(srcSelect, assets, /* allowNone */ true);
  srcSelect.value = vl.src || "";
  srcSelect.addEventListener("change", async () => {
    const cur = live();
    if (!cur) return;
    const prevSrc = cur.src || "";
    const requestedSrc = srcSelect.value || "";
    // 検査 → 必要なら再エンコード → fixed 版に差し替え。キャンセルなら旧 src 維持
    // (select の値も巻き戻す)。
    const ensured = await ensureFixedVideoSource(requestedSrc);
    if (ensured == null) {
      srcSelect.value = prevSrc;
      return;
    }
    cur.src = ensured;
    // src が select の値と異なる場合 (= fixed 版に差し替えた場合) は manifest を refresh
    // 済みなので、選択肢を作り直して新 src を表示。
    if (ensured !== requestedSrc) {
      const newAssets = (state.manifest?.videos || []).map((item) => ({
        id: item.path,
        name: item.name || item.path,
        path: item.path,
      }));
      fillSelect(srcSelect, newAssets, /* allowNone */ true);
      srcSelect.value = ensured;
    }
    // trim 値は新素材の duration を見るまでクランプできない。null に戻して
    // 末尾までを使うデフォルトにする。
    cur.trimStartSec = 0;
    cur.trimEndSec = null;
    deps.scheduleScenarioSave();
    renderTelopTrack();
    // src 変更でテクスチャ / provider / audio が変わるので active scene を捨てる。
    invalidateRendererCachesForConfigChange();
    deps.renderPreview();
    _ensureVideoLayerMeta(cur.src).then(refreshIfMeta);
  });
  srcLabel.append(srcSelect);
  panel.append(srcLabel);

  const hint1 = document.createElement("p");
  hint1.className = "asset-hint";
  hint1.textContent = "アセット管理の「動画」に追加した素材から選択できます。";
  panel.append(hint1);

  // duration を表示 + 未解決なら fetch
  const meta = state.videoLayerDurations.get(vl.src) || null;
  if (vl.src && !meta) {
    _ensureVideoLayerMeta(vl.src).then(refreshIfMeta);
  }
  const metaP = document.createElement("p");
  metaP.className = "asset-hint";
  if (meta) {
    metaP.textContent = `素材長: ${meta.duration.toFixed(2)} 秒 / ${meta.width}×${meta.height}${meta.hasAudio ? " / 音声あり" : " / 音声なし"}`;
  } else if (vl.src) {
    metaP.textContent = "素材情報を取得中...";
  } else {
    metaP.textContent = "動画アセットを選択してください。";
  }
  panel.append(metaP);

  // 開始時間
  const row1 = document.createElement("div");
  row1.className = "inline-fields";

  const startLabel = document.createElement("label");
  startLabel.append(document.createTextNode("開始時間"));
  const startInput = document.createElement("input");
  startInput.type = "text";
  bindTimecodeInput(startInput, {
    getFrames: () => videoLayerStartFrame(live() || vl),
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
  row1.append(startLabel);
  panel.append(row1);

  // trim 編集
  const trimRow = document.createElement("div");
  trimRow.className = "inline-fields";
  const trimStartLabel = document.createElement("label");
  trimStartLabel.append(document.createTextNode("素材内 開始秒 (trim)"));
  const trimStartInput = document.createElement("input");
  trimStartInput.type = "number";
  trimStartInput.min = "0";
  trimStartInput.step = "0.05";
  if (meta) trimStartInput.max = String(Math.max(0, meta.duration - 0.05));
  trimStartInput.value = String(vl.trimStartSec ?? 0);
  trimStartInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(trimStartInput.value);
    if (!Number.isFinite(v)) return;
    const dur = _videoDurationSecFor(cur);
    const trimEnd = videoLayerTrimEndSec(cur, dur);
    cur.trimStartSec = Math.max(0, Math.min(trimEnd - 0.05, v));
    deps.scheduleScenarioSave();
    renderTelopTrack();
    deps.renderPreview();
  });
  trimStartLabel.append(trimStartInput);
  trimRow.append(trimStartLabel);

  const trimEndLabel = document.createElement("label");
  trimEndLabel.append(document.createTextNode("素材内 終了秒 (trim)"));
  const trimEndInput = document.createElement("input");
  trimEndInput.type = "number";
  trimEndInput.min = "0";
  trimEndInput.step = "0.05";
  if (meta) trimEndInput.max = String(meta.duration);
  // 表示は trimEndSec が null なら duration をプレースホルダ表示
  const resolvedTrimEnd = vl.trimEndSec != null
    ? Number(vl.trimEndSec)
    : (meta?.duration ?? 0);
  trimEndInput.value = String(resolvedTrimEnd);
  trimEndInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(trimEndInput.value);
    if (!Number.isFinite(v)) return;
    const dur = _videoDurationSecFor(cur);
    const max = dur > 0 ? dur : v;
    cur.trimEndSec = Math.max((cur.trimStartSec ?? 0) + 0.05, Math.min(max, v));
    deps.scheduleScenarioSave();
    renderTelopTrack();
    deps.renderPreview();
  });
  trimEndLabel.append(trimEndInput);
  trimRow.append(trimEndLabel);
  panel.append(trimRow);

  // 派生 duration の表示 (タイムライン上での長さ = trim 区間長)
  const durHint = document.createElement("p");
  durHint.className = "asset-hint";
  const layerDur = videoLayerDurationSec(vl, _videoDurationSecFor(vl));
  durHint.textContent = `タイムライン上の長さ: ${layerDur.toFixed(2)} 秒`;
  panel.append(durHint);

  // fit / scale
  const row2 = document.createElement("div");
  row2.className = "inline-fields";
  const fitLabel = document.createElement("label");
  fitLabel.append(document.createTextNode("アスペクト処理 (fit)"));
  const fitSelect = document.createElement("select");
  for (const opt of [
    { value: "contain", label: "contain (内接 / 余白あり)" },
    { value: "cover", label: "cover (全面 / クロップ)" },
    { value: "fill", label: "fill (引き伸ばし)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    fitSelect.append(o);
  }
  fitSelect.value = vl.fit || "contain";
  fitSelect.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.fit = fitSelect.value;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  fitLabel.append(fitSelect);
  row2.append(fitLabel);

  const scaleLabel = document.createElement("label");
  scaleLabel.append(document.createTextNode("縮尺率 (縦横比維持)"));
  const scaleInput = document.createElement("input");
  scaleInput.type = "number";
  scaleInput.min = "0.05";
  scaleInput.max = "4";
  scaleInput.step = "0.05";
  scaleInput.value = String(vl.scale ?? 1.0);
  scaleInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(scaleInput.value);
    cur.scale = Number.isFinite(v) ? Math.max(0.05, Math.min(4, v)) : 1.0;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  scaleLabel.append(scaleInput);
  row2.append(scaleLabel);
  panel.append(row2);

  // 位置オフセット (中央アンカーからのピクセル)。+X=右、+Y=下 (Y-down 座標)
  const posRow = document.createElement("div");
  posRow.className = "inline-fields";
  const offXLabel = document.createElement("label");
  offXLabel.append(document.createTextNode("位置 X (px・中央=0)"));
  const offXInput = document.createElement("input");
  offXInput.type = "number";
  offXInput.min = "-2000";
  offXInput.max = "2000";
  offXInput.step = "1";
  offXInput.value = String(vl.offsetX ?? 0);
  offXInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(offXInput.value);
    cur.offsetX = Number.isFinite(v) ? Math.max(-2000, Math.min(2000, v)) : 0;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  offXLabel.append(offXInput);
  posRow.append(offXLabel);

  const offYLabel = document.createElement("label");
  offYLabel.append(document.createTextNode("位置 Y (px・中央=0)"));
  const offYInput = document.createElement("input");
  offYInput.type = "number";
  offYInput.min = "-2000";
  offYInput.max = "2000";
  offYInput.step = "1";
  offYInput.value = String(vl.offsetY ?? 0);
  offYInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(offYInput.value);
    cur.offsetY = Number.isFinite(v) ? Math.max(-2000, Math.min(2000, v)) : 0;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  offYLabel.append(offYInput);
  posRow.append(offYLabel);
  panel.append(posRow);

  // layer (z 位置)
  const layerLabel = document.createElement("label");
  layerLabel.append(document.createTextNode("レイヤー (z 位置)"));
  const layerSelect = document.createElement("select");
  for (const opt of [
    { value: "above_fg", label: "前景の上 (キャラ・前景イラストの手前)" },
    { value: "above_bg", label: "背景の上 (キャラの後ろ)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    layerSelect.append(o);
  }
  layerSelect.value = vl.layer || "above_fg";
  layerSelect.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.layer = layerSelect.value;
    deps.scheduleScenarioSave();
    renderTelopTrack();
    // z-stack 変更で plane の renderLayer が変わるので active scene を捨てて再 build
    invalidateRendererCachesForConfigChange();
    deps.renderPreview();
  });
  layerLabel.append(layerSelect);
  panel.append(layerLabel);

  // z 順 (= 同一 layer 内で重なったときの手前/奥)。重なりが許容されたので、
  // 配列順を「前へ / 後ろへ」で調整できるようにする。後ろの要素ほど描画が後 = 手前。
  const zRow = document.createElement("div");
  zRow.className = "inline-fields";
  const zLabel = document.createElement("span");
  zLabel.className = "field-label";
  zLabel.textContent = "重なり順 (同レイヤー内)";
  zRow.append(zLabel);
  const zBackBtn = document.createElement("button");
  zBackBtn.type = "button";
  zBackBtn.className = "ghost-button";
  zBackBtn.innerHTML = `<span class="msym button-icon" aria-hidden="true">arrow_back</span><span>後ろへ</span>`;
  zBackBtn.title = "同レイヤー内で 1 つ奥へ下げる";
  zBackBtn.addEventListener("click", () => _moveVideoLayerOrder(vlId, -1));
  const zFwdBtn = document.createElement("button");
  zFwdBtn.type = "button";
  zFwdBtn.className = "ghost-button";
  zFwdBtn.innerHTML = `<span>前へ</span><span class="msym button-icon" aria-hidden="true">arrow_forward</span>`;
  zFwdBtn.title = "同レイヤー内で 1 つ手前へ上げる";
  zFwdBtn.addEventListener("click", () => _moveVideoLayerOrder(vlId, +1));
  zRow.append(zBackBtn, zFwdBtn);
  panel.append(zRow);

  // 不透明度 + フェードイン / フェードアウト
  const opacityRow = document.createElement("div");
  opacityRow.className = "inline-fields";
  const opacityLabel = document.createElement("label");
  opacityLabel.append(document.createTextNode("不透明度 (0〜1)"));
  const opacityInput = document.createElement("input");
  opacityInput.type = "number";
  opacityInput.min = "0";
  opacityInput.max = "1";
  opacityInput.step = "0.05";
  opacityInput.value = String(vl.opacity ?? 1.0);
  opacityInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(opacityInput.value);
    cur.opacity = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1.0;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  opacityLabel.append(opacityInput);
  opacityRow.append(opacityLabel);
  panel.append(opacityRow);

  // フェードイン
  const fadeInRow = document.createElement("div");
  fadeInRow.className = "inline-fields";
  const fadeInToggleLabel = document.createElement("label");
  fadeInToggleLabel.className = "checkbox-row";
  const fadeInToggle = document.createElement("input");
  fadeInToggle.type = "checkbox";
  fadeInToggle.checked = !!vl.fadeInEnabled;
  fadeInToggle.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.fadeInEnabled = fadeInToggle.checked;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  fadeInToggleLabel.append(fadeInToggle, document.createTextNode(" フェードイン"));
  fadeInRow.append(fadeInToggleLabel);
  const fadeInSecLabel = document.createElement("label");
  fadeInSecLabel.append(document.createTextNode("秒数"));
  const fadeInSecInput = document.createElement("input");
  fadeInSecInput.type = "number";
  fadeInSecInput.min = "0";
  fadeInSecInput.max = "60";
  fadeInSecInput.step = "0.05";
  fadeInSecInput.value = String(vl.fadeInSec ?? 0.5);
  fadeInSecInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(fadeInSecInput.value);
    cur.fadeInSec = Number.isFinite(v) ? Math.max(0, Math.min(60, v)) : 0;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  fadeInSecLabel.append(fadeInSecInput);
  fadeInRow.append(fadeInSecLabel);
  panel.append(fadeInRow);

  // フェードアウト
  const fadeOutRow = document.createElement("div");
  fadeOutRow.className = "inline-fields";
  const fadeOutToggleLabel = document.createElement("label");
  fadeOutToggleLabel.className = "checkbox-row";
  const fadeOutToggle = document.createElement("input");
  fadeOutToggle.type = "checkbox";
  fadeOutToggle.checked = !!vl.fadeOutEnabled;
  fadeOutToggle.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.fadeOutEnabled = fadeOutToggle.checked;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  fadeOutToggleLabel.append(fadeOutToggle, document.createTextNode(" フェードアウト"));
  fadeOutRow.append(fadeOutToggleLabel);
  const fadeOutSecLabel = document.createElement("label");
  fadeOutSecLabel.append(document.createTextNode("秒数"));
  const fadeOutSecInput = document.createElement("input");
  fadeOutSecInput.type = "number";
  fadeOutSecInput.min = "0";
  fadeOutSecInput.max = "60";
  fadeOutSecInput.step = "0.05";
  fadeOutSecInput.value = String(vl.fadeOutSec ?? 0.5);
  fadeOutSecInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(fadeOutSecInput.value);
    cur.fadeOutSec = Number.isFinite(v) ? Math.max(0, Math.min(60, v)) : 0;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  fadeOutSecLabel.append(fadeOutSecInput);
  fadeOutRow.append(fadeOutSecLabel);
  panel.append(fadeOutRow);

  // 音声: muted + volume
  const audioRow = document.createElement("div");
  audioRow.className = "inline-fields";
  const mutedLabel = document.createElement("label");
  mutedLabel.className = "checkbox-row";
  const mutedInput = document.createElement("input");
  mutedInput.type = "checkbox";
  mutedInput.checked = !!vl.muted;
  mutedInput.addEventListener("change", () => {
    const cur = live();
    if (!cur) return;
    cur.muted = mutedInput.checked;
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  mutedLabel.append(mutedInput, document.createTextNode(" 音声をミュート"));
  audioRow.append(mutedLabel);

  const volLabel = document.createElement("label");
  volLabel.append(document.createTextNode("音量"));
  const volInput = document.createElement("input");
  volInput.type = "number";
  volInput.min = "0";
  volInput.max = "2";
  volInput.step = "0.05";
  volInput.value = String(vl.volume ?? 1.0);
  volInput.addEventListener("input", () => {
    const cur = live();
    if (!cur) return;
    const v = Number(volInput.value);
    cur.volume = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1.0;
    deps.scheduleScenarioSave();
  });
  volLabel.append(volInput);
  audioRow.append(volLabel);
  panel.append(audioRow);

  const audioHint = document.createElement("p");
  audioHint.className = "asset-hint";
  if (meta && !meta.hasAudio) {
    audioHint.textContent = "この動画には音声トラックがありません。書き出し時は自動的に映像のみが使われます。";
  } else {
    audioHint.textContent = "書き出し時は ffmpeg で BGM/効果音/動画レイヤー音声を amix します。";
  }
  panel.append(audioHint);
}
