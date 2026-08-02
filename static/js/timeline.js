import { state } from "./state.js";
import { elements } from "./elements.js";
import {
  formatTimecode,
  formatTimecodeSec,
  parseTimecode,
  secToFrames,
  framesToSec,
  PROJECT_FPS,
} from "./timecode.js";
import {
  cutStartFrame,
  cutDurationFrame,
  cutStartSec,
  cutDurationSec,
  telopStartFrame,
  telopDurationFrame,
  telopStartSec,
  telopDurationSec,
  soundEffectStartFrame,
  soundEffectStartSec,
  soundEffectDurationFrame,
  videoLayerStartFrame,
  videoLayerStartSec,
  videoLayerDurationSec,
  videoLayerTrimStartSec,
  videoLayerTrimEndSec,
  itemLane,
  sceneLaneCount,
  cutTransition,
  recalcCutStartSec,
} from "./scenario.js";
import { recordHistory } from "./history.js";
import { resolveShortcutAction } from "./shortcuts.js";
import { characterColorById } from "./character.js";
import { showToast } from "./toast.js";

let deps = {
  selectTelop: () => {},
  clearTelopSelection: () => {},
  setMultiTelopSelection: () => {},
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  loadCut: async () => {},
  defaultTelop: () => ({}),
  renderTelopEditor: () => {},
  activeScene: () => null,
  schedulePlayheadSave: () => {},
  selectSoundEffect: () => {},
  clearSoundEffectSelection: () => {},
  setMultiSoundEffectSelection: () => {},
  renderSoundEffectEditor: () => {},
  selectVideoLayer: () => {},
  clearVideoLayerSelection: () => {},
  setMultiVideoLayerSelection: () => {},
  renderVideoLayerEditor: () => {},
  applyEditorTargetView: () => {},
  // R3: カット帯クリックの選択処理 (通常=単一/Shift=範囲/Cmd=トグル)。
  selectCutFromTimeline: () => {},
};

function isTelopSelected(telopId) {
  if (!telopId) return false;
  if (state.selectedTelopIds && state.selectedTelopIds.has(telopId)) return true;
  return state.selectedTelopId === telopId;
}

function selectedTelopIdSet() {
  // 複数選択 Set があればそれを優先、無ければ単一選択 ID で代用。
  if (state.selectedTelopIds && state.selectedTelopIds.size > 0) {
    return new Set(state.selectedTelopIds);
  }
  if (state.selectedTelopId) return new Set([state.selectedTelopId]);
  return new Set();
}

function selectedTelops() {
  const ids = selectedTelopIdSet();
  if (ids.size === 0) return [];
  const telops = state.scenario?.scenes?.[0]?.telops || [];
  return telops.filter((t) => t && ids.has(t.id));
}

export function bindTimeline(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
}

// レーンの基本寸法。複数レーン化 (R2) / カットレイヤー化 (R3) で動的にレイアウトを
// 組むため、固定 Y は computeTimelineLayout() で算出する。
const LANE_HEIGHT = 36;            // テロップ / 効果音 / 動画 / カット 1 レーンの高さ
const RULER_HEIGHT = 22;
const WAVE_HEIGHT = 46;
const PRERENDER_STRIP_HEIGHT = 3;
// 上部の固定ヘッダ領域 (ruler + wave + cut レーン) は縦スクロールしない。
// telop / se / vl レーン群だけが縦スクロールする。

// レーン構成を scene.laneCounts から動的に計算する。
// 並び順 (上→下): ruler → wave → cut(単一・常設) → telop[n] → se[n] → vl[n]
function computeTimelineLayout() {
  const scene = state.scenario?.scenes?.[0] || null;
  const telopLanes = sceneLaneCount(scene, "telop");
  const seLanes = sceneLaneCount(scene, "soundEffect");
  const vlLanes = sceneLaneCount(scene, "videoLayer");
  const rulerTop = 0;
  const waveTop = rulerTop + RULER_HEIGHT;
  const cutTop = waveTop + WAVE_HEIGHT;        // カットレーン (R3: 常設・単一・full height)
  const cutHeight = LANE_HEIGHT;
  const telopTop = cutTop + cutHeight;
  const seTop = telopTop + telopLanes * LANE_HEIGHT;
  const vlTop = seTop + seLanes * LANE_HEIGHT;
  const totalHeight = vlTop + vlLanes * LANE_HEIGHT;
  return {
    rulerTop, rulerHeight: RULER_HEIGHT,
    waveTop, waveHeight: WAVE_HEIGHT,
    cutTop, cutHeight,
    telopTop, telopHeight: LANE_HEIGHT, telopLanes,
    seTop, seHeight: LANE_HEIGHT, seLanes,
    vlTop, vlHeight: LANE_HEIGHT, vlLanes,
    laneHeight: LANE_HEIGHT,
    // 縦スクロールしない固定ヘッダ領域の下端 (= スクロール対象レーン群の開始 y)。
    headerBottom: telopTop,
    totalHeight,
    prerenderStripHeight: PRERENDER_STRIP_HEIGHT,
  };
}

// R2: コンテンツ y 座標 → その種別レーン群内のレーン番号 (0..laneCount-1)。範囲外は端にクランプ。
function laneFromPointerY(layout, kind, contentY) {
  let baseTop = layout.telopTop;
  let count = layout.telopLanes;
  if (kind === "soundEffect") { baseTop = layout.seTop; count = layout.seLanes; }
  else if (kind === "videoLayer") { baseTop = layout.vlTop; count = layout.vlLanes; }
  const idx = Math.floor((contentY - baseTop) / layout.laneHeight);
  return Math.max(0, Math.min(count - 1, idx));
}

// 種別 + レーン番号 → そのレーンの上端 y。
function laneTopFor(layout, kind, lane) {
  const i = Math.max(0, Math.round(Number(lane) || 0));
  if (kind === "telop") return layout.telopTop + i * layout.laneHeight;
  if (kind === "soundEffect") return layout.seTop + i * layout.laneHeight;
  if (kind === "videoLayer") return layout.vlTop + i * layout.laneHeight;
  if (kind === "cut") return layout.cutTop;
  return layout.telopTop;
}
const SOUND_EFFECT_CHIP_PX = 22;
const TIMELINE_ZOOM_STEPS = [25, 50, 100, 200, 400];
const TIMELINE_DEFAULT_PX_PER_SEC = 100;
const TIMELINE_HANDLE_PX = 6;
const TIMELINE_DRAG_THRESHOLD = 3;
const TIMELINE_MIN_TELOP_DURATION = 0.1;
const TIMELINE_MIN_VIDEO_LAYER_DURATION = 0.1;
// 編集タイムラインのフレーム単位 = プロジェクトの基準 fps (24)。
// 再生ヘッダの「MM:SS.FF / NNNf」表示や ◀ ▶ / Shift+←→ のステップに用いる。
const TIMELINE_FRAME_FPS = PROJECT_FPS;

export function timelineFrameFps() {
  return TIMELINE_FRAME_FPS;
}

// R2: 種別 ("telop" | "soundEffect" | "videoLayer") のレーンを 1 つ追加する。
export function addTimelineLane(kind) {
  const scene = state.scenario?.scenes?.[0];
  if (!scene) return;
  if (!scene.laneCounts || typeof scene.laneCounts !== "object") {
    scene.laneCounts = { telop: 1, soundEffect: 1, videoLayer: 1 };
  }
  const key = kind === "soundEffect" ? "soundEffect" : kind === "videoLayer" ? "videoLayer" : "telop";
  const cur = Math.max(1, Math.round(Number(scene.laneCounts[key]) || 1));
  scene.laneCounts[key] = cur + 1;
  deps.scheduleScenarioSave();
  drawTimeline();
  showToast(`${key === "telop" ? "テロップ" : key === "soundEffect" ? "効果音" : "動画"}レーンを追加しました`);
}

// R2: 末尾の空きレーンを 1 つ削除する (アイテムが乗っているレーンは消さない)。
export function removeEmptyTimelineLane(kind) {
  const scene = state.scenario?.scenes?.[0];
  if (!scene) return;
  const key = kind === "soundEffect" ? "soundEffect" : kind === "videoLayer" ? "videoLayer" : "telop";
  const cur = sceneLaneCount(scene, key);
  if (cur <= 1) {
    showToast("これ以上レーンを減らせません");
    return;
  }
  const listKey = key === "telop" ? "telops" : key === "soundEffect" ? "soundEffects" : "videoLayers";
  const items = Array.isArray(scene[listKey]) ? scene[listKey] : [];
  const lastLane = cur - 1;
  if (items.some((it) => itemLane(it) >= lastLane)) {
    showToast("最後のレーンにアイテムがあるため削除できません");
    return;
  }
  if (!scene.laneCounts || typeof scene.laneCounts !== "object") return;
  scene.laneCounts[key] = lastLane;
  deps.scheduleScenarioSave();
  drawTimeline();
}

state.timeline = {
  pxPerSec: TIMELINE_DEFAULT_PX_PER_SEC,
  currentSec: 0,
  drag: null,
  hoverCursor: "default",
  scrollTopV: 0,   // R2: telop/se/vl レーン群の縦スクロール量 (px)
};
state.timelineWaveform = null;        // { src, trimStartSec, msResolution, durationSec, peaks }
state.timelineWaveformLoading = false;
state.timelineWaveformToken = 0;

export function timelineEffectiveDurationSec() {
  const scene = state.scenario?.scenes?.[0];
  const cuts = state.scenario?.cuts || [];
  const telops = scene?.telops || [];
  let total = 0;
  for (const cut of cuts) {
    const end = cutStartSec(cut) + cutDurationSec(cut);
    if (end > total) total = end;
  }
  for (const telop of telops) {
    const end = telopStartSec(telop) + telopDurationSec(telop);
    if (end > total) total = end;
  }
  const videoTrim = scene?.videoTrack;
  if (videoTrim && videoTrim.trimEndSec != null) {
    const span = Math.max(0, Number(videoTrim.trimEndSec) - Number(videoTrim.trimStartSec || 0));
    if (span > total) total = span;
  }
  // 動画レイヤー (videoLayers): startSec + (trimEnd - trimStart) で終端を求める。
  // duration 未解決の素材は trim 値だけで暫定計算 (後で再描画される)。
  const videoLayers = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  for (const vl of videoLayers) {
    const meta = state.videoLayerDurations?.get(vl?.src);
    const dur = videoLayerDurationSec(vl, meta?.duration || 0);
    const end = videoLayerStartSec(vl) + dur;
    if (end > total) total = end;
  }
  const wave = state.timelineWaveform;
  if (wave) {
    const span = Math.max(0, (wave.durationSec || 0) - (wave.trimStartSec || 0));
    if (span > total) total = span;
  }
  return total > 0 ? total : 1;
}

export function renderTelopTrack() {
  // 旧 DOM 実装の置換。互換のため同名で公開し、波形ロードのトリガーを兼ねる。
  drawTimeline();
  ensureTimelineWaveform().catch((error) => {
    console.warn("waveform decode failed", error);
  });
}

export function drawTimeline() {
  const canvas = elements.telopTrackCanvas;
  const scrollEl = elements.timelineScroll;
  const spacer = elements.timelineSpacer;
  if (!canvas || !scrollEl) return;
  const dpr = window.devicePixelRatio || 1;
  const layout = computeTimelineLayout();
  const totalSec = timelineEffectiveDurationSec();
  const pxPerSec = state.timeline.pxPerSec;
  const contentW = Math.ceil(totalSec * pxPerSec) + 40;
  // R2: 縦スクロール。canvas の表示高さは可視領域 (clientHeight) に固定し、
  // spacer の width/height でスクロールバーを表現する (水平と同じ仮想スクロール方式)。
  const contentH = layout.totalHeight;
  if (spacer) {
    if (spacer.style.width !== `${contentW}px`) spacer.style.width = `${contentW}px`;
    if (spacer.style.height !== `${contentH}px`) spacer.style.height = `${contentH}px`;
  }
  const viewportW = Math.max(1, scrollEl.clientWidth);
  // 可視高さ = scroll コンテナの clientHeight (= canvas でコンテナを満たす)。
  // 内容が短いときは余白も canvas (surface) で塗って、コンテナ地色が覗かないようにする。
  const viewportH = Math.max(1, scrollEl.clientHeight || contentH);
  const scrollLeft = Math.max(0, Math.min(scrollEl.scrollLeft, Math.max(0, contentW - viewportW)));
  // 縦スクロール量。固定ヘッダ (headerBottom) より下のレーン群だけをスクロールさせる。
  const maxScrollV = Math.max(0, contentH - viewportH);
  const scrollTopV = Math.max(0, Math.min(Number(state.timeline.scrollTopV) || 0, maxScrollV));
  state.timeline.scrollTopV = scrollTopV;
  const cssH = viewportH;
  if (canvas.style.width !== `${viewportW}px`) canvas.style.width = `${viewportW}px`;
  if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`;
  const targetW = Math.max(1, Math.round(viewportW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewportW, cssH);
  const css = getComputedStyle(document.documentElement);
  const palette = {
    surface: (css.getPropertyValue("--surface") || "#fff").trim() || "#fff",
    surface2: (css.getPropertyValue("--surface-2") || "#f0f0f0").trim() || "#f0f0f0",
    border: (css.getPropertyValue("--border") || "#ccc").trim() || "#ccc",
    borderStrong: (css.getPropertyValue("--border-strong") || "#888").trim() || "#888",
    fg: (css.getPropertyValue("--fg") || "#000").trim() || "#000",
    fgMuted: (css.getPropertyValue("--fg-muted") || "#555").trim() || "#555",
    fgFaint: (css.getPropertyValue("--fg-faint") || "#888").trim() || "#888",
    accent: (css.getPropertyValue("--accent") || "#3b82f6").trim() || "#3b82f6",
    accentRing: (css.getPropertyValue("--accent-ring") || "#93c5fd").trim() || "#93c5fd",
    accentFg: (css.getPropertyValue("--accent-fg") || "#fff").trim() || "#fff",
    warn: (css.getPropertyValue("--warn") || "#f59e0b").trim() || "#f59e0b",
  };
  const view = { cssW: contentW, viewportW, scrollLeft, cssH, viewportH, scrollTopV, pxPerSec, totalSec, layout, palette };
  ctx.save();
  ctx.translate(-scrollLeft, 0);
  drawTimelineBackground(ctx, view);
  // 固定ヘッダ (縦スクロールしない): ruler / prerender / wave / cut レーン
  drawTimelineRuler(ctx, view);
  drawTimelinePrerenderStrip(ctx, view);
  drawTimelineWaveform(ctx, view);
  drawTimelineCuts(ctx, view);
  // レーン群 (縦スクロール対象): telop / se / vl を clip + 縦 translate して描く。
  ctx.save();
  ctx.beginPath();
  ctx.rect(scrollLeft, layout.headerBottom, viewportW, Math.max(0, viewportH - layout.headerBottom));
  ctx.clip();
  ctx.translate(0, -scrollTopV);
  drawTimelineTelops(ctx, view);
  drawTimelineSoundEffects(ctx, view);
  drawTimelineVideoLayers(ctx, view);
  ctx.restore();
  // カーソル類は全高にまたがる縦線なので最後に固定描画。
  drawTimelinePlaybackCursor(ctx, view);
  drawTimelineSnapIndicator(ctx, view);
  ctx.restore();
  updateTimelineZoomLabel();
  updateTimelinePlayheadInfo();
}

function drawTimelineBackground(ctx, view) {
  const { cssW, layout, palette, viewportH } = view;
  ctx.fillStyle = palette.surface2;
  // 内容が短くてもコンテナ全面を塗る (canvas はコンテナ高さに合わせてある)。
  ctx.fillRect(0, 0, cssW, Math.max(layout.totalHeight, viewportH || 0));
  // 固定ヘッダの境界線 (ruler/wave/cut)。レーン群の境界は各レーン描画側で引く。
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  for (const y of [layout.waveTop, layout.cutTop, layout.telopTop]) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(cssW, y + 0.5);
    ctx.stroke();
  }
}

function drawTimelineRuler(ctx, view) {
  const { cssW, viewportW, scrollLeft, layout, pxPerSec, totalSec, palette } = view;
  ctx.save();
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, cssW, layout.rulerHeight);
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.fillStyle = palette.fgFaint;

  // 主要グリッド: 表示密度から決める。pxPerSec=100 なら 1秒毎、25なら 5秒毎。
  const minLabelGapPx = 60;
  const candidates = [0.5, 1, 2, 5, 10, 20, 30, 60];
  let majorStep = 1;
  for (const c of candidates) {
    if (c * pxPerSec >= minLabelGapPx) { majorStep = c; break; }
    majorStep = c;
  }
  const minorStep = majorStep / 5;
  // 可視範囲だけ走査（仮想スクロール）
  const tStart = Math.max(0, scrollLeft / pxPerSec);
  const tEnd = Math.min(totalSec, (scrollLeft + viewportW) / pxPerSec);
  const minorBegin = Math.floor(tStart / minorStep) * minorStep;
  const majorBegin = Math.floor(tStart / majorStep) * majorStep;
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  // 細い目盛
  ctx.beginPath();
  for (let t = minorBegin; t <= tEnd + 1e-6; t += minorStep) {
    if (t < 0) continue;
    const x = Math.round(t * pxPerSec) + 0.5;
    ctx.moveTo(x, layout.rulerHeight - 4);
    ctx.lineTo(x, layout.rulerHeight);
  }
  ctx.stroke();
  // 太い目盛 + ラベル
  ctx.strokeStyle = palette.borderStrong;
  ctx.beginPath();
  for (let t = majorBegin; t <= tEnd + 1e-6; t += majorStep) {
    if (t < 0) continue;
    const x = Math.round(t * pxPerSec) + 0.5;
    ctx.moveTo(x, layout.rulerHeight - 8);
    ctx.lineTo(x, layout.rulerHeight);
  }
  ctx.stroke();
  ctx.fillStyle = palette.fgMuted;
  for (let t = majorBegin; t <= tEnd + 1e-6; t += majorStep) {
    if (t < 0) continue;
    const x = Math.round(t * pxPerSec);
    // 最上部 (y=0..prerenderStripHeight) は事前解析ストリップが重なるので、ラベルは
    // その下に逃がす。
    ctx.fillText(formatTimecodeSec(t), x + 3, (layout.prerenderStripHeight || 3) + 1);
  }
  // 拍 (BPM)
  const bpm = Number(state.scenario?.scenes?.[0]?.bpm) || 0;
  if (bpm > 0) {
    const beatSec = 60 / bpm;
    const beatBegin = Math.floor(tStart / beatSec) * beatSec;
    ctx.strokeStyle = palette.accentRing;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let t = beatBegin; t <= tEnd + 1e-6; t += beatSec) {
      if (t < 0) continue;
      const x = Math.round(t * pxPerSec) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, layout.rulerHeight);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// タイムライン最上部の事前解析 (プリレンダー) ステータスストリップ。
// per-cut に「解析済=緑 / 解析中=赤 / 未解析=薄グレー」を細いバンドで描く。
// drawTimeline 内で ruler の直後に呼び、ruler 背景の上 (y=0) に重ねる。状態は
// state.cutPrerenderStatus (prerender.js / playback.js が更新) を読む。
function drawTimelinePrerenderStrip(ctx, view) {
  const { layout, pxPerSec, palette } = view;
  const cuts = state.scenario?.cuts || [];
  if (cuts.length === 0) return;
  const map = state.cutPrerenderStatus instanceof Map ? state.cutPrerenderStatus : null;
  const h = layout.prerenderStripHeight || 3;
  for (const cut of cuts) {
    const dur = cutDurationSec(cut);
    if (!(dur > 0)) continue;
    const x = cutStartSec(cut) * pxPerSec;
    const w = Math.max(1, dur * pxPerSec);
    const status = map ? map.get(cut.id) : null;
    ctx.fillStyle = status === "ready" ? "#22c55e"
      : status === "analyzing" ? "#ef4444"
      : "rgba(148,163,184,0.45)";
    ctx.fillRect(x, 0, w, h);
    // カット境界に 1px の区切り (背景色) を入れて per-cut の粒度を見せる。
    ctx.fillStyle = palette.surface2;
    ctx.fillRect(x, 0, 1, h);
  }
}

function drawTimelineWaveform(ctx, view) {
  const { cssW, viewportW, scrollLeft, layout, pxPerSec, palette } = view;
  ctx.save();
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, layout.waveTop, cssW, layout.waveHeight);
  const wave = state.timelineWaveform;
  const midY = layout.waveTop + layout.waveHeight / 2;
  // ガイド: センターライン
  ctx.strokeStyle = palette.border;
  ctx.beginPath();
  ctx.moveTo(0, midY + 0.5);
  ctx.lineTo(cssW, midY + 0.5);
  ctx.stroke();

  if (!wave || !wave.peaks || wave.peaks.length < 2) {
    if (state.timelineWaveformLoading) {
      ctx.fillStyle = palette.fgFaint;
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("波形を解析中…", scrollLeft + 8, midY);
    } else {
      ctx.fillStyle = palette.fgFaint;
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "middle";
      const lipBgm = (state.scenario?.scenes?.[0]?.bgmTracks || []).find((b) => b && b.useForLipSync && b.src);
      ctx.fillText(lipBgm ? "（波形を読み込めませんでした）" : "（口パク用 BGM 未指定）", scrollLeft + 8, midY);
    }
    ctx.restore();
    return;
  }
  const halfH = layout.waveHeight / 2 - 2;
  const msPerPx = 1000 / pxPerSec;
  const trimStart = wave.trimStartSec || 0;
  ctx.fillStyle = palette.accent;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  // 仮想スクロール: 可視範囲のピクセル列だけを走査する。
  const pxStart = Math.max(0, Math.floor(scrollLeft));
  const pxEnd = Math.min(cssW, Math.ceil(scrollLeft + viewportW));
  for (let px = pxStart; px < pxEnd; px += 1) {
    const tStart = (px * msPerPx) / 1000 + trimStart;
    const tEnd = ((px + 1) * msPerPx) / 1000 + trimStart;
    if (tStart >= wave.durationSec) break;
    const bStart = Math.max(0, Math.floor((tStart * 1000) / wave.msResolution));
    const bEnd = Math.min(wave.peaks.length / 2, Math.ceil((tEnd * 1000) / wave.msResolution));
    if (bEnd <= bStart) continue;
    let mn = 0, mx = 0;
    for (let b = bStart; b < bEnd; b += 1) {
      const v0 = wave.peaks[b * 2];
      const v1 = wave.peaks[b * 2 + 1];
      if (v0 < mn) mn = v0;
      if (v1 > mx) mx = v1;
    }
    const yTop = midY + mn * halfH;
    const yBot = midY + mx * halfH;
    ctx.rect(px, yTop, 1, Math.max(1, yBot - yTop));
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function timelineTelopRect(telop, view) {
  const { layout, pxPerSec } = view;
  const start = telopStartSec(telop);
  const dur = telopDurationSec(telop);
  return {
    x: start * pxPerSec,
    y: laneTopFor(layout, "telop", itemLane(telop)) + 4,
    w: Math.max(2, dur * pxPerSec),
    h: layout.telopHeight - 8,
  };
}

// 種別レーン群の下地 (各レーンの塗り + 区切り線 + 左端ラベル) を描く共通ヘルパ。
function drawLaneBand(ctx, view, { baseTop, laneCount, fill, label }) {
  const { cssW, layout, palette, scrollLeft } = view;
  for (let i = 0; i < laneCount; i += 1) {
    const y = baseTop + i * layout.laneHeight;
    ctx.fillStyle = fill;
    ctx.fillRect(0, y, cssW, layout.laneHeight);
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(cssW, y + 0.5);
    ctx.stroke();
    if (label && laneCount > 1) {
      // レーン番号ラベルは横スクロールに追従させず左端に固定表示。
      ctx.fillStyle = palette.fgFaint;
      ctx.font = "9px sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(`${label}${i + 1}`, (scrollLeft || 0) + 3, y + 2);
    }
  }
}

function drawTimelineTelops(ctx, view) {
  const { cssW, layout, palette } = view;
  ctx.save();
  drawLaneBand(ctx, view, { baseTop: layout.telopTop, laneCount: layout.telopLanes, fill: palette.surface2, label: "T" });
  const scene = state.scenario?.scenes?.[0];
  const telops = scene?.telops || [];
  if (telops.length === 0) {
    ctx.fillStyle = palette.fgFaint;
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("（テロップ未配置）  空き領域をダブルクリックで追加", 8, layout.telopTop + layout.telopHeight / 2);
    ctx.restore();
    return;
  }
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "middle";
  const sorted = telops.slice().sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  // テロップを編集していないとき (= editorTarget !== "telop") は強調しない。
  // SE 編集中にテロップが同時にアクセントで光る排他バグの対策で editorTarget で
  // ハイライトを排他していたが、cross-type 選択 (Cmd+click で複数種別を同時選択)
  // ではすべての選択を可視化する必要がある。複数種別に選択が乗っているときは
  // 排他を解除する (= 1 種別だけ選択中なら従来通り editorTarget でゲート)。
  const allowTelopHighlight = state.editorTarget === "telop" || _isCrossTypeSelectionActive();
  // MV 文字 (kind=mv_text) は薄紫で塗って通常テロップと区別する。
  // CSS 変数化は Phase 2 で。Phase 1 では直書き。
  const MV_FILL = "#b48bff";
  for (const telop of sorted) {
    const r = timelineTelopRect(telop, view);
    if (r.w <= 0) continue;
    const isSelected = allowTelopHighlight && isTelopSelected(telop.id);
    const isPrimary = allowTelopHighlight && telop.id === state.selectedTelopId;
    const isMvText = String(telop.kind || "") === "mv_text";
    const baseColor = isMvText ? MV_FILL : palette.accent;
    ctx.fillStyle = baseColor;
    ctx.globalAlpha = isSelected ? 0.95 : 0.55;
    roundRect(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isSelected ? baseColor : palette.border;
    ctx.lineWidth = isSelected ? (isPrimary ? 2 : 1.5) : 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 4);
    ctx.stroke();
    // 端ハンドル（プライマリ選択時のみ）
    if (isPrimary) {
      ctx.fillStyle = palette.accentFg;
      ctx.fillRect(r.x, r.y + 4, 2, r.h - 8);
      ctx.fillRect(r.x + r.w - 2, r.y + 4, 2, r.h - 8);
    }
    // テキスト
    if (r.w >= 30) {
      ctx.fillStyle = isSelected ? palette.accentFg : palette.fg;
      const text = (telop.text || "").replace(/\n/g, " ");
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x + 4, r.y, Math.max(0, r.w - 8), r.h);
      ctx.clip();
      ctx.fillText(text || "(空)", r.x + 6, r.y + r.h / 2);
      ctx.restore();
    }
    // カットリンク表示: 左端に 3px 幅のリンク先カット speaker color の帯を載せる。
    _drawLinkedCutMarker(ctx, telop, r);
  }
  // マーキー（範囲選択）の矩形を最後に描画
  const drag = state.timeline.drag;
  if (drag && drag.type === "marquee" && drag.curX != null) {
    const x0 = Math.min(drag.startX, drag.curX);
    const x1 = Math.max(drag.startX, drag.curX);
    const bandH = layout.telopLanes * layout.laneHeight;
    ctx.save();
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x0, layout.telopTop, x1 - x0, bandH);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, layout.telopTop + 0.5, x1 - x0 - 1, bandH - 1);
    ctx.restore();
  }
  ctx.restore();
}

function soundEffectDurationSec(se) {
  // se.durationFrame を一次採用 (= ユーザ指定の終了時間)。0 のときは素材長で代用。
  // /api/audio-duration の結果を state.soundEffectDurations に memoize している。
  // 未取得 (null/undefined) を返したら呼び出し側でデフォルト幅にフォールバック。
  if (!se) return null;
  const rawDurFrames = Math.max(0, Math.round(Number(se?.durationFrame) || 0));
  if (rawDurFrames > 0) return rawDurFrames / PROJECT_FPS;
  if (!se.src) return null;
  const v = state.soundEffectDurations?.get(se.src);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function ensureSoundEffectDuration(src) {
  // SE アセット 1 つの長さを取得して state にキャッシュ。in-flight 重複呼び出し
  // を防ぐため state.soundEffectDurationFetching に src を入れて gate。
  if (!src) return;
  if (state.soundEffectDurations?.has(src)) return;
  if (state.soundEffectDurationFetching?.has(src)) return;
  state.soundEffectDurationFetching.add(src);
  fetch(`/api/audio-duration?path=${encodeURIComponent(src)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && Number.isFinite(data.duration) && data.duration > 0) {
        state.soundEffectDurations.set(src, Number(data.duration));
        drawTimeline();
      } else {
        // 取得失敗時も 0 を入れて再試行を抑制する。視覚的にはチップ幅を使う。
        state.soundEffectDurations.set(src, 0);
      }
    })
    .catch((error) => {
      console.warn("audio-duration fetch failed", src, error);
      state.soundEffectDurations.set(src, 0);
    })
    .finally(() => {
      state.soundEffectDurationFetching.delete(src);
    });
}

function timelineSoundEffectRect(se, view) {
  const { layout, pxPerSec } = view;
  const start = soundEffectStartSec(se);
  const x = start * pxPerSec;
  const durSec = soundEffectDurationSec(se);
  // duration が判明していれば波形相当の帯 (duration*pxPerSec)。判明していない、
  // または duration=0 (取得失敗) のときは SOUND_EFFECT_CHIP_PX に倒す。
  const w = durSec ? Math.max(SOUND_EFFECT_CHIP_PX, durSec * pxPerSec) : SOUND_EFFECT_CHIP_PX;
  return {
    x,
    y: laneTopFor(layout, "soundEffect", itemLane(se)) + 3,
    w,
    h: layout.seHeight - 6,
  };
}

function isSoundEffectSelected(seId) {
  if (!seId) return false;
  if (state.selectedSoundEffectId === seId) return true;
  if (state.selectedSoundEffectIds && state.selectedSoundEffectIds.has(seId)) return true;
  return false;
}

function _manifestAssetName(kind, path) {
  const p = String(path || "");
  if (!p) return "";
  const items = state.manifest?.[kind] || [];
  for (const it of items) {
    if (it?.path === p) return it.name || _basenameOf(p);
  }
  return _basenameOf(p);
}

function _basenameOf(p) {
  const m = String(p || "").match(/[^/]+$/);
  return m ? m[0] : (p || "");
}

function drawTimelineSoundEffects(ctx, view) {
  const { cssW, layout, palette } = view;
  ctx.save();
  drawLaneBand(ctx, view, { baseTop: layout.seTop, laneCount: layout.seLanes, fill: palette.surface, label: "S" });
  const scene = state.scenario?.scenes?.[0];
  const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
  if (list.length === 0) {
    ctx.fillStyle = palette.fgFaint;
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("（効果音 未配置）  空き領域をダブルクリックで追加", 8, layout.seTop + layout.seHeight / 2);
    ctx.restore();
    return;
  }
  // 重なり順は startFrame 昇順、選択中を最前面。
  const sorted = list.slice().sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
  const allowSeHighlight = state.editorTarget === "soundEffect" || _isCrossTypeSelectionActive();
  for (const se of sorted) {
    ensureSoundEffectDuration(se?.src);
    const r = timelineSoundEffectRect(se, view);
    const selected = allowSeHighlight && isSoundEffectSelected(se.id);
    // 色はテロップ / 動画と同じ accent (緑) に統一。種別は縦位置と中のラベルで区別。
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = selected ? 0.95 : 0.55;
    roundRect(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = selected ? palette.accent : palette.border;
    ctx.lineWidth = selected ? 1.5 : 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 4);
    ctx.stroke();
    // 選択中なら左右両端 (= 開始位置 / 終了時間) にリサイズハンドルを出す。
    // テロップ / 動画レイヤーと同じ流儀。
    if (selected && r.w >= TIMELINE_HANDLE_PX * 2) {
      ctx.fillStyle = palette.accentFg;
      ctx.fillRect(r.x, r.y + 4, 2, r.h - 8);
      ctx.fillRect(r.x + r.w - 2, r.y + 4, 2, r.h - 8);
    }
    // アイコン ♫ + アセット名 (clipping で overflow 切り)
    ctx.fillStyle = selected ? palette.accentFg : palette.fg;
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const ICON_PAD = 6;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 2, r.y, Math.max(0, r.w - 4), r.h);
    ctx.clip();
    const name = _manifestAssetName("soundEffects", se?.src);
    const label = name ? `♫ ${name}` : "♫";
    ctx.fillText(label, r.x + ICON_PAD, r.y + r.h / 2 + 1);
    ctx.restore();
    _drawLinkedCutMarker(ctx, se, r);
  }
  ctx.restore();
}

// ===========================================================================
// 動画レイヤー (videoLayers) — タイムライン描画 / ヒットテスト / メタ取得
// ===========================================================================
function ensureVideoLayerDuration(src) {
  if (!src) return;
  if (state.videoLayerDurations?.has(src)) return;
  if (state.videoLayerDurationFetching?.has(src)) return;
  state.videoLayerDurationFetching.add(src);
  fetch(`/api/video-duration?path=${encodeURIComponent(src)}`)
    .then((res) => res.ok ? res.json() : null)
    .then((data) => {
      if (data) {
        state.videoLayerDurations.set(src, {
          duration: Number(data.duration) || 0,
          width: Number(data.width) || 0,
          height: Number(data.height) || 0,
          hasAudio: !!data.hasAudio,
        });
        drawTimeline();
      }
    })
    .catch(() => { /* ignore */ })
    .finally(() => {
      state.videoLayerDurationFetching.delete(src);
    });
}

function videoLayerDurationSecFor(vl) {
  if (!vl) return 0;
  const meta = state.videoLayerDurations?.get(vl.src);
  return videoLayerDurationSec(vl, meta?.duration || 0);
}

function timelineVideoLayerRect(vl, view) {
  const { layout, pxPerSec } = view;
  const startSec = videoLayerStartSec(vl);
  const durSec = videoLayerDurationSecFor(vl);
  const x = startSec * pxPerSec;
  // duration 未解決時は最小幅で表示。trim 値も不明なので最小値 + 警告色。
  const w = durSec > 0
    ? Math.max(8, durSec * pxPerSec)
    : 8;
  return {
    x,
    y: laneTopFor(layout, "videoLayer", itemLane(vl)) + 3,
    w,
    h: layout.vlHeight - 6,
  };
}

function isVideoLayerSelected(vlId) {
  if (!vlId) return false;
  if (state.selectedVideoLayerId === vlId) return true;
  if (state.selectedVideoLayerIds && state.selectedVideoLayerIds.has(vlId)) return true;
  return false;
}

function drawTimelineVideoLayers(ctx, view) {
  const { cssW, layout, palette } = view;
  ctx.save();
  drawLaneBand(ctx, view, { baseTop: layout.vlTop, laneCount: layout.vlLanes, fill: palette.surface, label: "V" });
  const scene = state.scenario?.scenes?.[0];
  const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  if (list.length === 0) {
    ctx.fillStyle = palette.fgFaint;
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("（動画レイヤー 未配置）  空き領域をダブルクリックで追加", 8, layout.vlTop + layout.vlHeight / 2);
    ctx.restore();
    return;
  }
  const sorted = list.slice().sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
  const allowHighlight = state.editorTarget === "videoLayer" || _isCrossTypeSelectionActive();
  for (const vl of sorted) {
    ensureVideoLayerDuration(vl?.src);
    const r = timelineVideoLayerRect(vl, view);
    const selected = allowHighlight && isVideoLayerSelected(vl.id);
    // テロップ / SE / 動画レイヤーは色を accent (緑) に統一。z 区別 (BG / FG) は
    // 中のラベル接頭辞で識別する。
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = selected ? 0.95 : 0.55;
    roundRect(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = selected ? palette.accent : palette.border;
    ctx.lineWidth = selected ? 1.5 : 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 4);
    ctx.stroke();
    // 端ハンドル: 選択中のみ左右に縦線 (テロップと同じ流儀)
    if (selected && r.w >= TIMELINE_HANDLE_PX * 2) {
      ctx.fillStyle = palette.accentFg;
      ctx.fillRect(r.x, r.y + 4, 2, r.h - 8);
      ctx.fillRect(r.x + r.w - 2, r.y + 4, 2, r.h - 8);
    }
    // アイコン ▶ + 層接頭辞 (BG/FG) + アセット名
    ctx.fillStyle = selected ? palette.accentFg : palette.fg;
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 2, r.y, Math.max(0, r.w - 4), r.h);
    ctx.clip();
    const tag = vl.layer === "above_bg" ? "BG" : "FG";
    const name = _manifestAssetName("videos", vl?.src);
    const label = name ? `▶ ${tag} ${name}` : `▶ ${tag}`;
    ctx.fillText(label, r.x + 6, r.y + r.h / 2 + 1);
    ctx.restore();
    _drawLinkedCutMarker(ctx, vl, r);
  }
  ctx.restore();
}

// linkedCutId が設定されているアイテムのタイムラインバー右上に「鎖アイコン」を
// 載せる (= リンク状態の一目可視化)。アイコン背景はリンク先カットの speaker color
// で塗って、どのカットに紐付いているか色で見分けられるようにする。
// MaterialSymbols のグリフは Canvas でも描けるが、フォント読み込み有無に左右される
// ため、ベクター path で chain link 風の図形を 2D 描画する。
function _drawLinkedCutMarker(ctx, item, rect) {
  if (!item?.linkedCutId) return;
  const cuts = state.scenario?.cuts || [];
  const cut = cuts.find((c) => c?.id === item.linkedCutId);
  if (!cut) return;
  const color = cutSpeakerColor(cut) || "#7d99ff";
  // 右上にバッジ。bar が狭くてもクリッピングで適切に隠れる前提で、固定サイズ。
  const size = 14;
  const pad = 2;
  if (rect.w < size + 2 || rect.h < size + 2) return; // 小さすぎる bar はスキップ
  const cx = rect.x + rect.w - size - pad;
  const cy = rect.y + pad;
  ctx.save();
  // 背景の丸角矩形 (speaker color)
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.95;
  roundRect(ctx, cx, cy, size, size, 3);
  ctx.fill();
  ctx.globalAlpha = 1;
  // 白い鎖風の 2 つのリング (= 簡略化 link icon)
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  const r = size * 0.27;
  const ox = cx + size / 2;
  const oy = cy + size / 2;
  // 左上のリング (斜め半円)
  ctx.beginPath();
  ctx.arc(ox - r * 0.65, oy - r * 0.65, r, Math.PI * 0.25, Math.PI * 1.25, false);
  ctx.stroke();
  // 右下のリング
  ctx.beginPath();
  ctx.arc(ox + r * 0.65, oy + r * 0.65, r, Math.PI * 1.25, Math.PI * 0.25, false);
  ctx.stroke();
  // 中央の連結セグメント
  ctx.beginPath();
  ctx.moveTo(ox - r * 0.2, oy - r * 0.2);
  ctx.lineTo(ox + r * 0.2, oy + r * 0.2);
  ctx.stroke();
  ctx.restore();
}

// cross-type 選択中か (= テロップ / SE / VL のうち 2 種以上に選択が乗っているか)。
// 1 種だけのときは従来通り editorTarget でハイライトを排他、複数種別なら全部表示。
function _isCrossTypeSelectionActive() {
  let types = 0;
  if (state.selectedTelopIds instanceof Set && state.selectedTelopIds.size > 0) types += 1;
  if (state.selectedSoundEffectIds instanceof Set && state.selectedSoundEffectIds.size > 0) types += 1;
  if (state.selectedVideoLayerIds instanceof Set && state.selectedVideoLayerIds.size > 0) types += 1;
  return types >= 2;
}

function cutSpeakerColor(cut) {
  // 話者キャラ (cut.state.characters の中で id == speakerCharacterId のインスタンス) の
  // 定義色を返す。未指定なら null。タイムラインバーは null のとき palette.accent に
  // フォールバックして、これまで通りの見た目を維持する。
  const speakerId = cut?.state?.speakerCharacterId || "";
  if (!speakerId) return null;
  const speakerInst = (cut.state?.characters || []).find((c) => c && c.id === speakerId);
  if (!speakerInst) return null;
  return characterColorById(speakerInst.characterId || "");
}

// R3: カットレーンのバー矩形。他レーンと同じ太さの full レーン。
function timelineCutRect(cut, view) {
  const { layout, pxPerSec } = view;
  const start = cutStartSec(cut);
  const dur = cutDurationSec(cut);
  return {
    x: start * pxPerSec,
    y: layout.cutTop + 4,
    w: Math.max(1, dur * pxPerSec),
    h: layout.cutHeight - 8,
  };
}

function drawTimelineCuts(ctx, view) {
  const { cssW, layout, pxPerSec, palette, scrollLeft } = view;
  ctx.save();
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, layout.cutTop, cssW, layout.cutHeight);
  // レーンラベル (左端固定)
  ctx.fillStyle = palette.fgFaint;
  ctx.font = "9px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText("カット", (scrollLeft || 0) + 3, layout.cutTop + 2);
  const cuts = state.scenario?.cuts || [];
  // 群選択 (selectedCutIds) の強調は「カット編集中」または cross-type 選択時だけに
  // ゲートする (テロップ/効果音/動画と同じ流儀)。これをしないと複製/ペーストで
  // selectedCutIds に入った新カットが、他要素の編集に移っても濃いまま残る。
  const allowCutMultiHighlight = state.editorTarget === "cut" || _isCrossTypeSelectionActive();
  cuts.forEach((cut, index) => {
    const r = timelineCutRect(cut, view);
    if (r.w <= 0) return;
    const isPrimary = cut.id === state.selectedCutId;
    const isMultiMember = allowCutMultiHighlight
      && state.selectedCutIds instanceof Set && state.selectedCutIds.has(cut.id);
    const isActive = isPrimary || isMultiMember;
    const speakerColor = cutSpeakerColor(cut);
    const baseColor = speakerColor || palette.accent;
    ctx.fillStyle = baseColor;
    ctx.globalAlpha = isActive ? 0.85 : 0.4;
    roundRect(ctx, r.x, r.y, Math.max(1, r.w - 1), r.h, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isActive ? baseColor : palette.border;
    ctx.lineWidth = isActive ? (isPrimary ? 2 : 1.5) : 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1) - 1, r.h - 1, 4);
    ctx.stroke();
    // R3: プライマリ選択時のみ右端にリサイズハンドル (尺をドラッグ変更)。
    if (isPrimary && r.w >= TIMELINE_HANDLE_PX * 2) {
      ctx.fillStyle = palette.accentFg;
      ctx.fillRect(r.x + r.w - 2, r.y + 4, 2, r.h - 8);
    }
    if (r.w >= 14) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x + 3, r.y, Math.max(0, r.w - 6), r.h);
      ctx.clip();
      ctx.fillStyle = isActive ? palette.accentFg : palette.fg;
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "middle";
      // R3/R10: カット番号 + 本文先頭ラベル (cutList 撤去ぶんのナビ補完)。
      // トランジション設定があるカットは先頭に印を出す。
      const trans = cutTransition(cut);
      const mark = trans.type && trans.type !== "none" ? "⮂ " : "";
      const rawText = String(cut.state?.text || "").replace(/\n/g, " ").trim();
      const label = rawText ? `${index + 1}. ${rawText}` : `${index + 1}`;
      ctx.fillText(`${mark}${label}`, r.x + 6, r.y + r.h / 2 + 1);
      ctx.restore();
    }
  });
  ctx.restore();
}

function drawTimelinePlaybackCursor(ctx, view) {
  const { layout, pxPerSec, palette, viewportH } = view;
  const t = Number(state.timeline?.currentSec || 0);
  if (!Number.isFinite(t) || t < 0) return;
  const bottom = viewportH || layout.totalHeight;
  const x = Math.round(t * pxPerSec) + 0.5;
  ctx.save();
  ctx.strokeStyle = palette.warn;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  // 上端のヘッド
  ctx.fillStyle = palette.warn;
  ctx.beginPath();
  ctx.moveTo(x - 4, 0);
  ctx.lineTo(x + 4, 0);
  ctx.lineTo(x, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// drag 中、snap が効いた瞬間に「揃いました」の縦線を一本立てる。
// pointerup で _clearSnapIndicator が呼ばれて消える。
function drawTimelineSnapIndicator(ctx, view) {
  const sec = state.timeline?._snapIndicatorSec;
  if (sec == null || !Number.isFinite(sec)) return;
  const { layout, pxPerSec, palette, viewportH } = view;
  const x = Math.round(sec * pxPerSec) + 0.5;
  ctx.save();
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.65;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, viewportH || layout.totalHeight);
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function updateTimelineZoomLabel() {
  if (elements.timelineZoomLabel) {
    elements.timelineZoomLabel.textContent = `${Math.round(state.timeline.pxPerSec)} px/s`;
  }
}

function updateTimelinePlayheadInfo() {
  const el = elements.timelinePlayheadInfo;
  if (!el) return;
  // 編集中の入力に差し替えられている間は更新しない。
  if (el.dataset.editing === "1") return;
  const sec = Math.max(0, Number(state.timeline?.currentSec) || 0);
  const totalFrames = Math.max(0, Math.round(sec * TIMELINE_FRAME_FPS));
  el.textContent = `${formatTimecode(totalFrames)} / ${totalFrames}f`;
}

function jumpPlayheadToFrames(targetFrames) {
  const clamped = Math.max(0, Math.round(Number(targetFrames) || 0));
  const sec = clamped / TIMELINE_FRAME_FPS;
  state.timeline.currentSec = sec;
  drawTimeline();
  autoScrollTimelineToCursor();
  const targetCut = findCutAtSec(sec);
  if (targetCut && targetCut.id !== state.selectedCutId) {
    deps.loadCut(targetCut, { keepTelopSelection: true })
      .catch((error) => console.warn("loadCut after jump failed", error));
  } else {
    deps.renderPreview().catch((error) => console.warn("renderPreview after jump failed", error));
  }
  autoScrollCutListToActive();
}

export function bindPlayheadInfo() {
  const el = elements.timelinePlayheadInfo;
  if (!el) return;
  const open = () => {
    if (el.dataset.editing === "1") return;
    el.dataset.editing = "1";
    const sec = Math.max(0, Number(state.timeline?.currentSec) || 0);
    const currentFrames = Math.max(0, Math.round(sec * TIMELINE_FRAME_FPS));
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.className = "timeline-playhead-info-input";
    input.value = formatTimecode(currentFrames);
    input.title = "MM:SS.FF (Enter で確定 / Esc でキャンセル)";
    el.replaceWith(input);
    input.focus();
    input.select();
    let closed = false;
    const close = (commit) => {
      if (closed) return;
      closed = true;
      if (commit) {
        const parsed = parseTimecode(input.value);
        if (parsed != null) jumpPlayheadToFrames(parsed);
      }
      // 元の span を再構築 (id/class/属性を維持)
      el.dataset.editing = "0";
      input.replaceWith(el);
      updateTimelinePlayheadInfo();
    };
    input.addEventListener("blur", () => close(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      }
    });
  };
  el.addEventListener("dblclick", open);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
}

export function stepPlayheadFrame(direction) {
  stepPlayheadFrames(direction < 0 ? -1 : +1);
}

// 任意フレーム数で再生ヘッドを動かす。1 秒前/後 (= ±FPS frame) など。
// 内部で seekPlayheadToSec に委譲して、playhead 上のカット追従とフレーム
// 境界スナップを共有する。
export function stepPlayheadFrames(deltaFrames) {
  const cur = Math.max(0, Number(state.timeline?.currentSec) || 0);
  const next = cur + Number(deltaFrames || 0) / TIMELINE_FRAME_FPS;
  seekPlayheadToSec(next);
}

// 再生ヘッドを絶対秒に移動する。フレーム境界に丸めたあと、playhead 上の
// カットが現在編集中と異なれば loadCut で追従。`|<` `>|` ボタンや、将来的な
// シーク系 UI からも使う基本ヘルパ。
export function seekPlayheadToSec(targetSec) {
  const total = Math.max(0, timelineEffectiveDurationSec());
  const clamped = Math.max(0, Math.min(total, Number(targetSec) || 0));
  const snapped = Math.round(clamped * TIMELINE_FRAME_FPS) / TIMELINE_FRAME_FPS;
  state.timeline.currentSec = snapped;
  drawTimeline();
  autoScrollTimelineToCursor();
  const targetCut = findCutAtSec(snapped);
  if (targetCut && targetCut.id !== state.selectedCutId) {
    deps.loadCut(targetCut, { keepTelopSelection: true })
      .catch((error) => console.warn("loadCut after seek failed", error));
  } else {
    deps.renderPreview().catch((error) => console.warn("renderPreview after seek failed", error));
  }
  autoScrollCutListToActive();
}

// 先頭 / 終端へのシーク。`>|` の終端は scenario 全体の effective duration
// (= 最終カット末尾 + テロップ末尾の max)。
export function seekPlayheadToStart() {
  seekPlayheadToSec(0);
}
export function seekPlayheadToEnd() {
  seekPlayheadToSec(timelineEffectiveDurationSec());
}

export async function ensureTimelineWaveform() {
  const scene = state.scenario?.scenes?.[0];
  const lipBgm = (scene?.bgmTracks || []).find((b) => b && b.useForLipSync && b.src);
  if (!lipBgm) {
    if (state.timelineWaveform) {
      state.timelineWaveform = null;
      drawTimeline();
    }
    return null;
  }
  const src = lipBgm.src.startsWith("/") ? lipBgm.src : `/assets/${lipBgm.src}`;
  const trimStart = Math.max(0, Number(lipBgm.trimStartSec) || 0);
  const cur = state.timelineWaveform;
  if (cur && cur.src === src && cur.trimStartSec === trimStart) return cur;
  if (state.timelineWaveformLoading) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  state.timelineWaveformLoading = true;
  const token = ++state.timelineWaveformToken;
  drawTimeline();
  try {
    const arrayBuffer = await fetch(src).then((r) => {
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      return r.arrayBuffer();
    });
    if (token !== state.timelineWaveformToken) return null;
    const decCtx = new Ctx();
    let audioBuf;
    try {
      audioBuf = await decCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      try { decCtx.close(); } catch (_) { /* ignore */ }
    }
    if (token !== state.timelineWaveformToken) return null;
    const channels = audioBuf.numberOfChannels;
    const ch0 = audioBuf.getChannelData(0);
    let mixed;
    if (channels >= 2) {
      const ch1 = audioBuf.getChannelData(1);
      mixed = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i += 1) mixed[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      mixed = ch0;
    }
    const sr = audioBuf.sampleRate;
    // 目標 5ms/バケット で sample 整数を求める。44.1kHz では Math.floor(220.5)=220 →
    // 1 バケット = 220/44100 ≒ 4.9886ms と理論値からズレる。描画側で 5ms と仮定すると
    // 1 秒ごとに 0.0023 秒ずつ累積し、200 秒の位置で約 0.45 秒の波形ズレが発生する。
    // 実際の bucket 時間 (sample 数 / sr) を msResolution として保存し、描画側に渡す。
    const samplesPerBucket = Math.max(1, Math.round((sr * 5) / 1000));
    const msResolution = (samplesPerBucket / sr) * 1000;
    const totalBuckets = Math.ceil(mixed.length / samplesPerBucket);
    const peaks = new Float32Array(totalBuckets * 2);
    for (let b = 0; b < totalBuckets; b += 1) {
      const start = b * samplesPerBucket;
      const end = Math.min(mixed.length, start + samplesPerBucket);
      let mn = 0, mx = 0;
      for (let i = start; i < end; i += 1) {
        const v = mixed[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      peaks[b * 2] = mn;
      peaks[b * 2 + 1] = mx;
    }
    const result = {
      src,
      trimStartSec: trimStart,
      msResolution,
      durationSec: audioBuf.duration,
      peaks,
    };
    state.timelineWaveform = result;
    return result;
  } catch (error) {
    console.warn("waveform decode failed", error);
    state.timelineWaveform = null;
    return null;
  } finally {
    if (token === state.timelineWaveformToken) {
      state.timelineWaveformLoading = false;
      drawTimeline();
    }
  }
}

// ---- スナップ ---------------------------------------------------------------

// snap 対象の集約。priority 1 が最強。
//   1 = 再生カーソル (playhead) — 「いま見ている場所」に合わせたい意図が強い
//   2 = カット境界 (start / end) — 構造的な目印 (場面転換テロップ用)
//   3 = BPM 拍
//   4 = 他アイテム端 (telop / SE / VL の start + end, 自身は除外)
//   5 = フレームグリッド (1/24 秒) — fallback
// excludeIds: Set<string> | null — 自身や複数選択グループを除外するため
function timelineSnapTargets({ excludeIds = null } = {}) {
  const targets = [];
  const skip = excludeIds instanceof Set ? excludeIds : null;
  const _skip = (id) => skip && id != null && skip.has(id);

  // 1. 再生カーソル
  const cur = Number(state.timeline?.currentSec || 0);
  if (Number.isFinite(cur) && cur >= 0) targets.push({ sec: cur, priority: 1 });

  const scene = state.scenario?.scenes?.[0];

  // 2. カット境界 (start / end)
  const cuts = state.scenario?.cuts || [];
  for (const c of cuts) {
    if (_skip(c?.id)) continue;
    const s = cutStartSec(c);
    const d = cutDurationSec(c);
    targets.push({ sec: s, priority: 2 });
    targets.push({ sec: s + d, priority: 2 });
  }

  // 3. 拍 (BPM)
  const bpm = Number(scene?.bpm) || 0;
  if (bpm > 0) {
    const totalSec = timelineEffectiveDurationSec();
    const beatSec = 60 / bpm;
    for (let t = 0; t <= totalSec + 1e-6; t += beatSec) targets.push({ sec: t, priority: 3 });
  }

  // 4. 他アイテム端: テロップ / 効果音 / 動画レイヤー
  for (const t of (scene?.telops || [])) {
    if (_skip(t?.id)) continue;
    const s = telopStartSec(t);
    const d = telopDurationSec(t);
    targets.push({ sec: s, priority: 4 });
    targets.push({ sec: s + d, priority: 4 });
  }
  for (const se of (scene?.soundEffects || [])) {
    if (_skip(se?.id)) continue;
    const s = soundEffectStartSec(se);
    // SE の長さは /api/audio-duration 解決値から durSec を引く (= startFrame + durationFrame ベース)
    const durSec = soundEffectDurationFrame(se) / PROJECT_FPS;
    targets.push({ sec: s, priority: 4 });
    if (durSec > 0) targets.push({ sec: s + durSec, priority: 4 });
  }
  for (const vl of (scene?.videoLayers || [])) {
    if (_skip(vl?.id)) continue;
    const s = videoLayerStartSec(vl);
    const d = videoLayerDurationSecFor(vl);
    targets.push({ sec: s, priority: 4 });
    if (d > 0) targets.push({ sec: s + d, priority: 4 });
  }

  return targets;
}

function snapSec(sec, options = {}) {
  if (options.disabled) return sec;
  const tolPx = 8;
  const tol = tolPx / state.timeline.pxPerSec;
  // exclude を Set に統一。互換: excludeTelopId (単一 ID) も受ける。
  let excludeIds = options.excludeIds instanceof Set ? options.excludeIds : null;
  if (!excludeIds && options.excludeTelopId) {
    excludeIds = new Set([options.excludeTelopId]);
  }
  // 強い順 (1→5) に検索し、見つかった時点で確定。
  for (let pr = 1; pr <= 5; pr += 1) {
    if (pr === 5) {
      // フレームグリッド (1/24 秒、プロジェクト基準 fps) は fallback として最後
      const step = 1 / PROJECT_FPS;
      const cand = Math.round(sec / step) * step;
      if (Math.abs(cand - sec) <= tol) {
        _recordSnapIndicator(cand);
        return cand;
      }
      continue;
    }
    const list = timelineSnapTargets({ excludeIds });
    let best = null;
    for (const t of list) {
      if (t.priority !== pr) continue;
      const d = Math.abs(t.sec - sec);
      if (d <= tol && (best == null || d < best.d)) best = { sec: t.sec, d };
    }
    if (best) {
      _recordSnapIndicator(best.sec);
      return best.sec;
    }
  }
  _recordSnapIndicator(null);
  return sec;
}

// snap が効いた sec をタイムライン描画から拾えるよう記録 (drawTimeline で縦線描画)。
// drag 終了 (pointerup) で `_clearSnapIndicator()` を呼んで消す。
function _recordSnapIndicator(sec) {
  if (!state.timeline) return;
  if (sec == null) {
    state.timeline._snapIndicatorSec = null;
  } else {
    state.timeline._snapIndicatorSec = Number(sec);
  }
}

function _clearSnapIndicator() {
  if (state.timeline) state.timeline._snapIndicatorSec = null;
}

// Cmd (Mac) / Ctrl (Win) クリック時のクロスタイプ選択トグル。
// 種別 (telop / soundEffect / videoLayer) ごとの selectedXxxIds Set を独立に持つことで、
// 他種別の選択を消さずに「あちこちのアイテムをまとめて選択 → リンクボタン等で一括操作」
// が可能になる。editorTarget は今クリックされた種別に切替 (右パネルは最後に触った種別を表示)。
function _toggleCrossTypeSelection(kind, id) {
  if (!id) return;
  if (kind === "telop") {
    const ids = new Set(state.selectedTelopIds || []);
    if (ids.has(id)) {
      ids.delete(id);
      if (state.selectedTelopId === id) state.selectedTelopId = null;
    } else {
      ids.add(id);
      state.selectedTelopId = id;
    }
    state.selectedTelopIds = ids;
    if (ids.size > 0) state.editorTarget = "telop";
  } else if (kind === "soundEffect") {
    const ids = new Set(state.selectedSoundEffectIds || []);
    if (ids.has(id)) {
      ids.delete(id);
      if (state.selectedSoundEffectId === id) state.selectedSoundEffectId = null;
    } else {
      ids.add(id);
      state.selectedSoundEffectId = id;
    }
    state.selectedSoundEffectIds = ids;
    if (ids.size > 0) state.editorTarget = "soundEffect";
  } else if (kind === "videoLayer") {
    const ids = new Set(state.selectedVideoLayerIds || []);
    if (ids.has(id)) {
      ids.delete(id);
      if (state.selectedVideoLayerId === id) state.selectedVideoLayerId = null;
    } else {
      ids.add(id);
      state.selectedVideoLayerId = id;
    }
    state.selectedVideoLayerIds = ids;
    if (ids.size > 0) state.editorTarget = "videoLayer";
  }
  // editorTarget を更新したので右パネル切替 + タイムラインのハイライト再描画
  deps.applyEditorTargetView();
  drawTimeline();
}

// drag 対象 (主 + groupStartMap 全員) を snap exclude として返す。
// drag.telopId / drag.seId / drag.vlId が主 ID、groupStartMap (Map<id, originalStart>) があれば
// その全 key を追加する。
function _collectDragExcludeIds(drag) {
  const ids = new Set();
  if (!drag) return ids;
  const primary = drag.telopId || drag.seId || drag.vlId || null;
  if (primary) ids.add(primary);
  if (drag.groupStartMap instanceof Map) {
    for (const id of drag.groupStartMap.keys()) ids.add(id);
  }
  return ids;
}

// ---- ヒットテスト＋ポインタ -------------------------------------------------

function timelineLocalCoords(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scrollEl = elements.timelineScroll;
  const sl = scrollEl ? scrollEl.scrollLeft : 0;
  // canvas を viewport 幅に固定して仮想スクロール描画しているため、
  // ヒットテストのコンテンツ座標へは scrollLeft を足し戻す。
  const rawY = event.clientY - rect.top;
  // R2: 縦スクロール。ヘッダ (ruler/wave/cut) より下のレーン領域は scrollTopV を足し戻す。
  const layout = computeTimelineLayout();
  const scrollTopV = Math.max(0, Number(state.timeline?.scrollTopV) || 0);
  const y = rawY >= layout.headerBottom ? rawY + scrollTopV : rawY;
  return { x: event.clientX - rect.left + sl, y };
}

function timelineHitTest(x, y) {
  const layout = computeTimelineLayout();
  if (y < layout.rulerHeight) return { type: "ruler" };
  if (y < layout.cutTop) return { type: "wave" };
  // R3: カットレーン (full レーン)。右端 6px は尺リサイズハンドル。
  if (y < layout.telopTop) {
    const cuts = state.scenario?.cuts || [];
    for (let i = cuts.length - 1; i >= 0; i -= 1) {
      const cut = cuts[i];
      const r = timelineCutRect(cut, { layout, pxPerSec: state.timeline.pxPerSec });
      if (x < r.x || x > r.x + r.w) continue;
      if (y < r.y || y > r.y + r.h) continue;
      if (r.w >= TIMELINE_HANDLE_PX * 2 && x >= r.x + r.w - TIMELINE_HANDLE_PX) {
        return { type: "cutEdge", cutId: cut.id, edge: "end" };
      }
      return { type: "cutBar", cutId: cut.id };
    }
    return { type: "cutBarEmpty" };
  }
  if (y < layout.seTop) {
    const telopLane = Math.max(0, Math.min(layout.telopLanes - 1, Math.floor((y - layout.telopTop) / layout.laneHeight)));
    const telops = state.scenario?.scenes?.[0]?.telops || [];
    const sorted = telops.slice().sort((a, b) => {
      // プライマリ選択中を最前面に
      if (a.id === state.selectedTelopId) return 1;
      if (b.id === state.selectedTelopId) return -1;
      // 次点で複数選択中
      const aSel = isTelopSelected(a.id);
      const bSel = isTelopSelected(b.id);
      if (aSel !== bSel) return aSel ? 1 : -1;
      return telopStartFrame(a) - telopStartFrame(b);
    });
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const telop = sorted[i];
      const r = timelineTelopRect(telop, { layout, pxPerSec: state.timeline.pxPerSec });
      if (x < r.x || x > r.x + r.w) continue;
      if (y < r.y || y > r.y + r.h) continue;
      if (x <= r.x + TIMELINE_HANDLE_PX) return { type: "telopEdge", telopId: telop.id, edge: "start" };
      if (x >= r.x + r.w - TIMELINE_HANDLE_PX) return { type: "telopEdge", telopId: telop.id, edge: "end" };
      return { type: "telopBody", telopId: telop.id, lane: telopLane };
    }
    return { type: "telopEmpty", lane: telopLane };
  }
  if (y < layout.vlTop) {
    const seLane = Math.max(0, Math.min(layout.seLanes - 1, Math.floor((y - layout.seTop) / layout.laneHeight)));
    // 効果音帯: 選択中を最前面にして hit
    const list = state.scenario?.scenes?.[0]?.soundEffects || [];
    const sorted = list.slice().sort((a, b) => {
      if (a.id === state.selectedSoundEffectId) return 1;
      if (b.id === state.selectedSoundEffectId) return -1;
      return soundEffectStartFrame(a) - soundEffectStartFrame(b);
    });
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const se = sorted[i];
      const r = timelineSoundEffectRect(se, { layout, pxPerSec: state.timeline.pxPerSec });
      if (x < r.x || x > r.x + r.w) continue;
      if (y < r.y || y > r.y + r.h) continue;
      // 左右両端にリサイズハンドル (loop の有無に関わらず)。中央は移動 (= seBody)。
      // 左端: 開始位置を動かす (audioOffsetSec も連動して素材内頭出しが進む)
      // 右端: 終了時間 (durationFrame) を動かす
      if (r.w >= TIMELINE_HANDLE_PX * 2) {
        if (x <= r.x + TIMELINE_HANDLE_PX) {
          return { type: "seEdge", seId: se.id, edge: "start" };
        }
        if (x >= r.x + r.w - TIMELINE_HANDLE_PX) {
          return { type: "seEdge", seId: se.id, edge: "end" };
        }
      }
      return { type: "seBody", seId: se.id, lane: seLane };
    }
    return { type: "seEmpty", lane: seLane };
  }
  if (y < layout.totalHeight) {
    const vlLane = Math.max(0, Math.min(layout.vlLanes - 1, Math.floor((y - layout.vlTop) / layout.laneHeight)));
    // 動画レイヤー帯: 選択中を最前面にして hit。端 6px は edge (リサイズ)。
    const list = state.scenario?.scenes?.[0]?.videoLayers || [];
    const sorted = list.slice().sort((a, b) => {
      if (a.id === state.selectedVideoLayerId) return 1;
      if (b.id === state.selectedVideoLayerId) return -1;
      return videoLayerStartFrame(a) - videoLayerStartFrame(b);
    });
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const vl = sorted[i];
      const r = timelineVideoLayerRect(vl, { layout, pxPerSec: state.timeline.pxPerSec });
      if (x < r.x || x > r.x + r.w) continue;
      if (y < r.y || y > r.y + r.h) continue;
      // duration が解決していて十分幅があれば edge ハンドルを出す
      if (r.w > TIMELINE_HANDLE_PX * 2) {
        if (x <= r.x + TIMELINE_HANDLE_PX) return { type: "vlEdge", vlId: vl.id, edge: "start" };
        if (x >= r.x + r.w - TIMELINE_HANDLE_PX) return { type: "vlEdge", vlId: vl.id, edge: "end" };
      }
      return { type: "vlBody", vlId: vl.id, lane: vlLane };
    }
    return { type: "vlEmpty", lane: vlLane };
  }
  return { type: "outside" };
}

export function findTelopById(id) {
  if (!id) return null;
  const telops = state.scenario?.scenes?.[0]?.telops || [];
  return telops.find((t) => t && t.id === id) || null;
}

export function findCutAtSec(sec) {
  const cuts = state.scenario?.cuts || [];
  for (const cut of cuts) {
    const s = cutStartSec(cut);
    const e = s + cutDurationSec(cut);
    if (sec >= s && sec < e) return cut;
  }
  return null;
}

// telop の検索は frame (整数) で比較する。秒に直すと 193/24 + 7/24 のような分数計算で
// 浮動小数点誤差が生まれ、後半のフレーム ID で「前テロップの終端 == playhead」のはずが
// onHead にヒットしてしまうケースが発生する。(s/e キーで「前のテロップの開始位置が
// ヘッドにずれる」症状の原因)
function findTelopAtOrAfter(frame) {
  const telops = state.scenario?.scenes?.[0]?.telops || [];
  const onHead = telops.find((t) => {
    const s = telopStartFrame(t);
    const d = telopDurationFrame(t);
    return s <= frame && frame < s + d;
  });
  if (onHead) return onHead;
  const after = telops
    .filter((t) => telopStartFrame(t) >= frame)
    .sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  return after[0] || null;
}

function findTelopAtOrBefore(frame) {
  const telops = state.scenario?.scenes?.[0]?.telops || [];
  const onHead = telops.find((t) => {
    const s = telopStartFrame(t);
    const d = telopDurationFrame(t);
    return s <= frame && frame < s + d;
  });
  if (onHead) return onHead;
  const before = telops
    .filter((t) => (telopStartFrame(t) + telopDurationFrame(t)) <= frame)
    .sort((a, b) => (telopStartFrame(b) + telopDurationFrame(b))
                    - (telopStartFrame(a) + telopDurationFrame(a)));
  return before[0] || null;
}

function findNextTelop(sec) {
  const telops = state.scenario?.scenes?.[0]?.telops || [];
  const after = telops
    .filter((t) => telopStartSec(t) > sec + 1e-6)
    .sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  return after[0] || telops.slice().sort((a, b) => telopStartFrame(a) - telopStartFrame(b))[0] || null;
}

function findPrevTelop(sec) {
  const telops = state.scenario?.scenes?.[0]?.telops || [];
  const before = telops
    .filter((t) => telopStartSec(t) < sec - 1e-6)
    .sort((a, b) => telopStartFrame(b) - telopStartFrame(a));
  return before[0] || telops.slice().sort((a, b) => telopStartFrame(b) - telopStartFrame(a))[0] || null;
}

function setTimelineCursor(name) {
  if (state.timeline.hoverCursor === name) return;
  state.timeline.hoverCursor = name;
  if (elements.telopTrackCanvas) elements.telopTrackCanvas.style.cursor = name;
}

function timelineSecAtClientX(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  const scrollEl = elements.timelineScroll;
  const sl = scrollEl ? scrollEl.scrollLeft : 0;
  return Math.max(0, (clientX - rect.left + sl) / state.timeline.pxPerSec);
}

function setTimelinePxPerSec(px, anchorSec = null) {
  const clamped = Math.max(TIMELINE_ZOOM_STEPS[0], Math.min(TIMELINE_ZOOM_STEPS[TIMELINE_ZOOM_STEPS.length - 1], px));
  const scrollEl = elements.timelineScroll;
  const anchorClientOffsetPx = anchorSec != null && scrollEl
    ? anchorSec * state.timeline.pxPerSec - scrollEl.scrollLeft
    : null;
  state.timeline.pxPerSec = clamped;
  drawTimeline();
  if (anchorSec != null && anchorClientOffsetPx != null && scrollEl) {
    scrollEl.scrollLeft = Math.max(0, anchorSec * clamped - anchorClientOffsetPx);
  }
}

function nextTimelineZoomStep(direction) {
  const cur = state.timeline.pxPerSec;
  if (direction > 0) {
    for (const step of TIMELINE_ZOOM_STEPS) if (step > cur + 1e-6) return step;
    return TIMELINE_ZOOM_STEPS[TIMELINE_ZOOM_STEPS.length - 1];
  }
  for (let i = TIMELINE_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (TIMELINE_ZOOM_STEPS[i] < cur - 1e-6) return TIMELINE_ZOOM_STEPS[i];
  }
  return TIMELINE_ZOOM_STEPS[0];
}

export function autoScrollTimelineToCursor() {
  const scrollEl = elements.timelineScroll;
  if (!scrollEl) return;
  const x = (state.timeline.currentSec || 0) * state.timeline.pxPerSec;
  const left = scrollEl.scrollLeft;
  const right = left + scrollEl.clientWidth;
  if (x < left + 16) {
    scrollEl.scrollLeft = Math.max(0, x - 16);
  } else if (x > right - 32) {
    scrollEl.scrollLeft = Math.max(0, x - scrollEl.clientWidth + 80);
  }
}

// 再生中・シーク時に「現在カット」のカードを cut-list の可視範囲内に保つ。
// タイムラインの autoScrollTimelineToCursor と同じノリで、視界外に出たときだけ
// smooth scroll でカードを引き込む。state.selectedCutId が変わったときだけ
// 動かすため、ユーザが手動スクロールしたカット内位置はカット境界まで保持される。
let _lastCutListAutoScrollCutId = null;

export function resetCutListAutoScrollTracking() {
  _lastCutListAutoScrollCutId = null;
}

export function autoScrollCutListToActive() {
  const cutList = elements.cutList;
  if (!cutList) return;
  const cutId = state.selectedCutId;
  if (!cutId) return;
  if (cutId === _lastCutListAutoScrollCutId) return;
  const sel = `.cut-item[data-cut-id="${(typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(cutId) : cutId}"]`;
  const item = cutList.querySelector(sel);
  if (!item) return;
  _lastCutListAutoScrollCutId = cutId;
  const margin = 24;
  const viewW = cutList.clientWidth;
  const left = cutList.scrollLeft;
  const right = left + viewW;
  const itemLeft = item.offsetLeft;
  const itemRight = itemLeft + item.offsetWidth;
  const maxScroll = Math.max(0, cutList.scrollWidth - viewW);
  if (itemLeft < left + margin) {
    const target = Math.max(0, Math.min(maxScroll, itemLeft - margin));
    cutList.scrollTo({ left: target, behavior: "smooth" });
  } else if (itemRight > right - margin) {
    const target = Math.max(0, Math.min(maxScroll, itemRight - viewW + margin));
    cutList.scrollTo({ left: target, behavior: "smooth" });
  }
}

function tryDeleteSelectedTelop() {
  const ids = selectedTelopIdSet();
  if (ids.size === 0) return false;
  const scene = deps.activeScene();
  const list = scene?.telops;
  if (!Array.isArray(list)) return false;
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (ids.has(list[i]?.id)) {
      list.splice(i, 1);
      removed += 1;
    }
  }
  if (removed === 0) return false;
  deps.clearTelopSelection();
  deps.scheduleScenarioSave();
  recordHistory();
  deps.renderPreview();
  return true;
}

function timelineCreateTelopAt(sec, lane = 0) {
  const scene = deps.activeScene();
  if (!Array.isArray(scene.telops)) scene.telops = [];
  const tpl = deps.defaultTelop();
  tpl.startFrame = secToFrames(Math.max(0, Number(sec) || 0));
  tpl.lane = Math.max(0, Math.round(Number(lane) || 0));
  scene.telops.push(tpl);
  scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  deps.selectTelop(tpl.id);
  deps.renderPreview();
}

function timelineCreateSoundEffectAt(sec, lane = 0) {
  const scene = deps.activeScene();
  if (!Array.isArray(scene.soundEffects)) scene.soundEffects = [];
  // SE のテンプレ生成は sound-effect.js 側に持たせず、ここでは現状の playhead でなく
  // ダブルクリック位置を採用するため最小の構造を直接組む。アセット src は manifest 先頭。
  const seAssets = state.manifest?.soundEffects || [];
  const firstSrc = seAssets[0]?.path || "";
  const se = {
    id: `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    src: firstSrc,
    startFrame: secToFrames(Math.max(0, Number(sec) || 0)),
    lane: Math.max(0, Math.round(Number(lane) || 0)),
    volume: 1.0,
  };
  scene.soundEffects.push(se);
  scene.soundEffects.sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  deps.selectSoundEffect(se.id);
  deps.renderPreview();
}

function timelineCreateVideoLayerAt(sec, lane = 0) {
  const scene = deps.activeScene();
  const videos = state.manifest?.videos || [];
  if (videos.length === 0) {
    showToast("動画アセットがありません。アセット管理の「動画」に素材を追加してください。", "warn");
    return;
  }
  if (!Array.isArray(scene.videoLayers)) scene.videoLayers = [];
  const firstSrc = videos[0]?.path || "";
  const vl = {
    id: `vl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    src: firstSrc,
    startFrame: secToFrames(Math.max(0, Number(sec) || 0)),
    lane: Math.max(0, Math.round(Number(lane) || 0)),
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
  scene.videoLayers.push(vl);
  scene.videoLayers.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  if (firstSrc) ensureVideoLayerDuration(firstSrc);
  if (typeof deps.selectVideoLayer === "function") {
    deps.selectVideoLayer(vl.id);
  }
  deps.renderPreview();
}

function commitDragChanges({ historyTouched }) {
  deps.scheduleScenarioSave();
  if (historyTouched) recordHistory();
  deps.renderPreview();
}

// ---- canvas 上のショートカット ハンドラ ----
// 各 action は「成功 = true」を返したら呼び出し側が preventDefault する。
// 「成功 = false」を返した場合は呼び出し側が次の候補 action を試す。
// (例: ArrowLeft が telopMoveLeft / jumpToPrevTelop の双方に当たっていて、
//      テロップ未選択時は telopMoveLeft が false を返し、jumpToPrevTelop に進む)
function shortcutTelopMove(direction) {
  const selected = selectedTelops();
  if (selected.length === 0) return false;
  let deltaFrame = direction;
  let minStart = Number.POSITIVE_INFINITY;
  for (const t of selected) {
    const s = telopStartFrame(t);
    if (s < minStart) minStart = s;
  }
  if (!Number.isFinite(minStart)) minStart = 0;
  if (deltaFrame < -minStart) deltaFrame = -minStart;
  if (deltaFrame === 0) return true;
  for (const t of selected) {
    t.startFrame = Math.max(0, telopStartFrame(t) + deltaFrame);
  }
  const scene = deps.activeScene();
  if (Array.isArray(scene?.telops)) {
    scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  }
  deps.scheduleScenarioSave();
  recordHistory();
  drawTimeline();
  if (state.editorTarget === "telop") deps.renderTelopEditor();
  deps.renderPreview();
  return true;
}

function shortcutJumpToTelop(direction) {
  const playhead = Number(state.timeline?.currentSec) || 0;
  const next = direction > 0 ? findNextTelop(playhead) : findPrevTelop(playhead);
  if (!next) return false;
  const targetSec = Math.max(0, telopStartSec(next));
  state.timeline.currentSec = targetSec;
  const targetCut = findCutAtSec(targetSec);
  drawTimeline();
  autoScrollTimelineToCursor();
  if (targetCut && targetCut.id !== state.selectedCutId) {
    deps.loadCut(targetCut, { keepTelopSelection: true })
      .catch((error) => console.warn("loadCut after arrow nav failed", error));
  } else {
    deps.renderPreview().catch((error) => console.warn("renderPreview after arrow nav failed", error));
  }
  autoScrollCutListToActive();
  return true;
}

function shortcutSnapTelopStartToPlayhead() {
  const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const selected = selectedTelops();
  if (selected.length > 1) {
    let minStart = Number.POSITIVE_INFINITY;
    for (const t of selected) {
      const s = telopStartFrame(t);
      if (s < minStart) minStart = s;
    }
    if (!Number.isFinite(minStart)) minStart = 0;
    const delta = Math.max(playheadFrame - minStart, -minStart);
    if (delta !== 0) {
      for (const t of selected) {
        t.startFrame = Math.max(0, telopStartFrame(t) + delta);
      }
      const scene = deps.activeScene();
      if (Array.isArray(scene?.telops)) {
        scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
      }
      deps.scheduleScenarioSave();
      recordHistory();
      drawTimeline();
      if (state.editorTarget === "telop") deps.renderTelopEditor();
      deps.renderPreview();
    }
    return true;
  }
  let target = findTelopAtOrAfter(playheadFrame);
  const S_SNAP_ALLOWANCE_FRAMES = 1;
  if (target) {
    const start = telopStartFrame(target);
    const dur = telopDurationFrame(target);
    const insideTarget = start <= playheadFrame && playheadFrame < start + dur;
    if (insideTarget && (start + dur) - playheadFrame <= S_SNAP_ALLOWANCE_FRAMES) {
      const telops = state.scenario?.scenes?.[0]?.telops || [];
      const after = telops
        .filter((t) => t !== target && telopStartFrame(t) >= (start + dur))
        .sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
      target = after[0] || null;
    }
  }
  if (!target) return false;
  target.startFrame = playheadFrame;
  const scene = deps.activeScene();
  if (Array.isArray(scene?.telops)) {
    scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  }
  deps.scheduleScenarioSave();
  recordHistory();
  drawTimeline();
  if (state.editorTarget === "telop" && state.selectedTelopId === target.id) {
    deps.renderTelopEditor();
  }
  deps.renderPreview();
  return true;
}

function shortcutSnapTelopEndToPlayhead() {
  const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  let target = findTelopAtOrBefore(playheadFrame);
  const SNAP_ALLOWANCE_FRAMES = 1;
  if (target) {
    const start = telopStartFrame(target);
    const dur = telopDurationFrame(target);
    const insideTarget = start <= playheadFrame && playheadFrame < start + dur;
    if (insideTarget && playheadFrame - start <= SNAP_ALLOWANCE_FRAMES) {
      const telops = state.scenario?.scenes?.[0]?.telops || [];
      const before = telops
        .filter((t) => t !== target && (telopStartFrame(t) + telopDurationFrame(t)) <= start)
        .sort((a, b) => (telopStartFrame(b) + telopDurationFrame(b))
                        - (telopStartFrame(a) + telopDurationFrame(a)));
      target = before[0] || null;
    }
  }
  if (!target) return false;
  const start = telopStartFrame(target);
  const newDurFrame = Math.max(1, playheadFrame - start);
  target.durationFrame = newDurFrame;
  deps.scheduleScenarioSave();
  recordHistory();
  drawTimeline();
  if (state.editorTarget === "telop" && state.selectedTelopId === target.id) {
    deps.renderTelopEditor();
  }
  deps.renderPreview();
  return true;
}

function shortcutPlayheadHome() {
  // |< ボタンと同じく seekPlayheadToSec(0) に統一。playhead 上のカットが
  // 現在編集中と違えば自動 loadCut。
  seekPlayheadToSec(0);
  return true;
}

function shortcutPlayheadEnd() {
  seekPlayheadToSec(timelineEffectiveDurationSec());
  return true;
}

function handleCanvasShortcut(actionId, _event) {
  switch (actionId) {
    case "deleteSelection":
      return tryDeleteSelectedTelop();
    case "duplicateSelection":
      // canvas focus 中なら document 側 listener には届かないので、
      // ここでも複製を発火できるようにしておく (action としては general)。
      return false; // canvas keydown では発火させず、document の handler に任せる
    case "playheadHome":
      return shortcutPlayheadHome();
    case "playheadEnd":
      return shortcutPlayheadEnd();
    case "playheadStepBack":
      stepPlayheadFrame(-1);
      return true;
    case "playheadStepForward":
      stepPlayheadFrame(+1);
      return true;
    case "playheadJumpBack1Sec":
      stepPlayheadFrames(-PROJECT_FPS);
      return true;
    case "playheadJumpForward1Sec":
      stepPlayheadFrames(+PROJECT_FPS);
      return true;
    case "telopSnapStartToPlayhead":
      return shortcutSnapTelopStartToPlayhead();
    case "telopSnapEndToPlayhead":
      return shortcutSnapTelopEndToPlayhead();
    case "telopMoveLeft":
      return shortcutTelopMove(-1);
    case "telopMoveRight":
      return shortcutTelopMove(+1);
    case "jumpToPrevTelop":
      return shortcutJumpToTelop(-1);
    case "jumpToNextTelop":
      return shortcutJumpToTelop(+1);
    case "selectPrevTelop":
    case "selectNextTelop":
    case "selectPrevSoundEffect":
    case "selectNextSoundEffect":
    case "selectPrevVideoLayer":
    case "selectNextVideoLayer":
      // document 側の handler に任せる (state.editorTarget が "telop" / "soundEffect" / "videoLayer" のとき発火)。
      // canvas にフォーカスがあっても event は bubbling して document に届く。
      return false;
    default:
      // canvas が処理しない action (togglePlay / prevCut 等) は document に委ねる
      return false;
  }
}

export function setupTimelineCanvas() {
  const canvas = elements.telopTrackCanvas;
  const scrollEl = elements.timelineScroll;
  if (!canvas || !scrollEl) return;

  const onPointerMove = (event) => {
    const drag = state.timeline.drag;
    if (!drag) {
      const { x, y } = timelineLocalCoords(canvas, event);
      const hit = timelineHitTest(x, y);
      if (hit.type === "telopEdge") setTimelineCursor("ew-resize");
      else if (hit.type === "telopBody") setTimelineCursor("grab");
      else if (hit.type === "seEdge") setTimelineCursor("ew-resize");
      else if (hit.type === "seBody") setTimelineCursor("grab");
      else if (hit.type === "vlEdge") setTimelineCursor("ew-resize");
      else if (hit.type === "vlBody") setTimelineCursor("grab");
      else if (hit.type === "cutEdge") setTimelineCursor("ew-resize");
      else if (hit.type === "cutBar") setTimelineCursor("pointer");
      else if (hit.type === "ruler") setTimelineCursor("col-resize");
      else setTimelineCursor("default");
      return;
    }
    const dx = event.clientX - drag.startClientX;
    const dxSec = dx / state.timeline.pxPerSec;
    const snapDisabled = !!event.shiftKey;
    // drag 対象 (主 + グループ全員) を snap target から外す Set。
    // 自身に吸い付いて動かなくなる現象を防ぐ。
    const dragExcludeIds = _collectDragExcludeIds(drag);
    if (drag.type === "moveTelop") {
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      if (!drag.dirty) return;
      const primary = findTelopById(drag.telopId);
      if (!primary) return;
      let next = drag.startStartSec + dxSec;
      // 複数選択中はマイナス方向に過剰移動して先頭が 0 を割らないようにクランプ
      const minStartInGroup = drag.groupMinStart ?? drag.startStartSec;
      const minDelta = -minStartInGroup; // delta + minStartInGroup >= 0
      let delta = next - drag.startStartSec;
      if (delta < minDelta) delta = minDelta;
      next = drag.startStartSec + delta;
      next = snapSec(next, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      // 末尾もスナップ候補として揃える
      const endSec = next + drag.startDuration;
      const snappedEnd = snapSec(endSec, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      if (Math.abs(snappedEnd - endSec) < Math.abs(next - (drag.startStartSec + dxSec)) + 1e-6) {
        next = snappedEnd - drag.startDuration;
      }
      // 最終 delta（プライマリのスナップ後を基準に）。
      delta = next - drag.startStartSec;
      // クランプ: グループ全体が 0 以上に収まるよう delta を再制限。
      if (delta < -minStartInGroup) delta = -minStartInGroup;
      // グループ全体に delta を適用
      const startMap = drag.groupStartMap || new Map([[primary.id, drag.startStartSec]]);
      for (const [id, originalStart] of startMap) {
        const t = findTelopById(id);
        if (!t) continue;
        const ns = Math.max(0, originalStart + delta);
        t.startFrame = secToFrames(ns);
      }
      // R2: 単一ドラッグ時は縦移動でレーンを変更。
      if (startMap.size <= 1) {
        const pos = timelineLocalCoords(canvas, event);
        primary.lane = laneFromPointerY(computeTimelineLayout(), "telop", pos.y);
      }
      drawTimeline();
    } else if (drag.type === "marquee") {
      drag.curX = timelineLocalCoords(canvas, event).x;
      drawTimeline();
    } else if (drag.type === "resizeTelopStart") {
      const telop = findTelopById(drag.telopId);
      if (!telop) return;
      let nextStart = drag.startStartSec + dxSec;
      nextStart = Math.max(0, nextStart);
      const maxStart = drag.startStartSec + drag.startDuration - TIMELINE_MIN_TELOP_DURATION;
      nextStart = Math.min(maxStart, nextStart);
      nextStart = snapSec(nextStart, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      const newDuration = drag.startStartSec + drag.startDuration - nextStart;
      if (newDuration < TIMELINE_MIN_TELOP_DURATION) return;
      telop.startFrame = secToFrames(Math.max(0, nextStart));
      telop.durationFrame = Math.max(1, secToFrames(newDuration));
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      drawTimeline();
    } else if (drag.type === "resizeTelopEnd") {
      const telop = findTelopById(drag.telopId);
      if (!telop) return;
      let nextEnd = drag.startStartSec + drag.startDuration + dxSec;
      nextEnd = Math.max(drag.startStartSec + TIMELINE_MIN_TELOP_DURATION, nextEnd);
      nextEnd = snapSec(nextEnd, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      const newDuration = nextEnd - drag.startStartSec;
      if (newDuration < TIMELINE_MIN_TELOP_DURATION) return;
      telop.durationFrame = Math.max(1, secToFrames(newDuration));
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      drawTimeline();
    } else if (drag.type === "moveSoundEffect") {
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      if (!drag.dirty) return;
      const scene = deps.activeScene();
      const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
      const primary = list.find((s) => s && s.id === drag.seId);
      if (!primary) return;
      let next = drag.startStartSec + dxSec;
      // グループ移動: 先頭が 0 を割らないように clamp
      const minStartInGroup = drag.groupMinStart ?? drag.startStartSec;
      let delta = next - drag.startStartSec;
      if (delta < -minStartInGroup) delta = -minStartInGroup;
      next = drag.startStartSec + delta;
      next = snapSec(next, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      delta = next - drag.startStartSec;
      if (delta < -minStartInGroup) delta = -minStartInGroup;
      const startMap = drag.groupStartMap || new Map([[primary.id, drag.startStartSec]]);
      for (const [id, originalStart] of startMap) {
        const target = list.find((s) => s && s.id === id);
        if (!target) continue;
        const ns = Math.max(0, originalStart + delta);
        target.startFrame = secToFrames(ns);
      }
      if (startMap.size <= 1) {
        const pos = timelineLocalCoords(canvas, event);
        primary.lane = laneFromPointerY(computeTimelineLayout(), "soundEffect", pos.y);
      }
      drawTimeline();
    } else if (drag.type === "resizeSoundEffectStart") {
      const scene = deps.activeScene();
      const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
      const se = list.find((s) => s && s.id === drag.seId);
      if (!se) return;
      // 左端ドラッグ: 終端 (= startStartSec + startDurationSec) は固定、startSec を動かす。
      // 動画レイヤーと同じく、audioOffsetSec も同じ delta だけ進ませて「素材の頭を切る」挙動。
      let nextStart = drag.startStartSec + dxSec;
      nextStart = Math.max(0, nextStart);
      const fixedEndSec = drag.startStartSec + drag.startDurationSec;
      const maxStart = fixedEndSec - TIMELINE_MIN_TELOP_DURATION;
      nextStart = Math.min(maxStart, nextStart);
      nextStart = snapSec(nextStart, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      // audioOffsetSec が負にならないようガード (元 offset + 左へ伸ばした delta < 0 のとき)。
      const startDelta = nextStart - drag.startStartSec;
      let newAudioOffset = drag.startAudioOffsetSec + startDelta;
      if (newAudioOffset < 0) {
        // offset=0 になるところまでで止める
        const allowedDelta = -drag.startAudioOffsetSec;
        nextStart = drag.startStartSec + allowedDelta;
        newAudioOffset = 0;
      }
      const newDuration = fixedEndSec - nextStart;
      if (newDuration < TIMELINE_MIN_TELOP_DURATION) return;
      se.startFrame = Math.max(0, secToFrames(nextStart));
      se.durationFrame = Math.max(1, secToFrames(newDuration));
      se.audioOffsetSec = Math.max(0, newAudioOffset);
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      drawTimeline();
    } else if (drag.type === "resizeSoundEffectEnd") {
      const scene = deps.activeScene();
      const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
      const se = list.find((s) => s && s.id === drag.seId);
      if (!se) return;
      let nextEnd = drag.startStartSec + drag.startDurationSec + dxSec;
      nextEnd = Math.max(drag.startStartSec + TIMELINE_MIN_TELOP_DURATION, nextEnd);
      nextEnd = snapSec(nextEnd, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      const newDuration = nextEnd - drag.startStartSec;
      if (newDuration < TIMELINE_MIN_TELOP_DURATION) return;
      se.durationFrame = Math.max(1, secToFrames(newDuration));
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      drawTimeline();
    } else if (drag.type === "moveVideoLayer") {
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      if (!drag.dirty) return;
      const scene = deps.activeScene();
      const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
      const primary = list.find((v) => v && v.id === drag.vlId);
      if (!primary) return;
      // グループ移動の判定: groupStartMap が複数あれば、プライマリの snap 結果から
      // delta を確定し、グループ全員に同 delta を適用する。重なり禁止 snap は
      // 衝突調停が複雑なのでグループ移動時は素朴な 0 clamp のみで済ます (= 同 layer
      // 内 sibling との衝突は許容、ユーザに任せる)。
      const groupSize = drag.groupStartMap ? drag.groupStartMap.size : 1;
      let nextSec = Math.max(0, drag.startStartSec + dxSec);
      if (groupSize <= 1) {
        nextSec = snapSec(nextSec, { disabled: snapDisabled, excludeIds: dragExcludeIds });
        // 同一 layer 内の重なりは許容 (= クロスフェード用途で意図的に重ねるケース有り)。
        primary.startFrame = Math.max(0, secToFrames(nextSec));
        // R2: 単一ドラッグ時は縦移動でレーン変更。
        const pos = timelineLocalCoords(canvas, event);
        primary.lane = laneFromPointerY(computeTimelineLayout(), "videoLayer", pos.y);
      } else {
        // グループ全体を minStart >= 0 で clamp
        const minStartInGroup = drag.groupMinStart ?? drag.startStartSec;
        let delta = nextSec - drag.startStartSec;
        if (delta < -minStartInGroup) delta = -minStartInGroup;
        nextSec = drag.startStartSec + delta;
        nextSec = snapSec(nextSec, { disabled: snapDisabled, excludeIds: dragExcludeIds });
        delta = nextSec - drag.startStartSec;
        if (delta < -minStartInGroup) delta = -minStartInGroup;
        for (const [id, originalStart] of drag.groupStartMap) {
          const target = list.find((v) => v && v.id === id);
          if (!target) continue;
          const ns = Math.max(0, originalStart + delta);
          target.startFrame = secToFrames(ns);
        }
      }
      drawTimeline();
    } else if (drag.type === "resizeVideoLayerStart") {
      const scene = deps.activeScene();
      const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
      const vl = list.find((v) => v && v.id === drag.vlId);
      if (!vl) return;
      // 左端ドラッグ: 「タイムライン上の startSec を動かす」=
      //   - startFrame を動かす ＋ trimStartSec も同じ delta 分動かす (素材内の頭出し位置)
      //   - trimEnd は固定 (= 右端は変えない)
      let nextStart = Math.max(0, drag.startStartSec + dxSec);
      nextStart = snapSec(nextStart, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      // 同一 layer 内 sibling との重なりは許容 (= 衝突回避 snap は撤去済み)。
      // クランプ:
      //   - 最小 duration TIMELINE_MIN_VIDEO_LAYER_DURATION
      //   - trimStartSec + (nextStart - startStartSec) >= 0 (素材内の頭出しが負にならない)
      const startDelta = nextStart - drag.startStartSec; // 秒
      const newTrimStart = drag.startTrimStartSec + startDelta;
      if (newTrimStart < 0) {
        // trimStart=0 になるところまでで止める
        const allowedDelta = -drag.startTrimStartSec;
        nextStart = drag.startStartSec + allowedDelta;
      }
      const maxStartSec = drag.startStartSec + drag.startDuration - TIMELINE_MIN_VIDEO_LAYER_DURATION;
      if (nextStart > maxStartSec) nextStart = maxStartSec;
      const finalDelta = nextStart - drag.startStartSec;
      vl.startFrame = Math.max(0, secToFrames(nextStart));
      vl.trimStartSec = Math.max(0, drag.startTrimStartSec + finalDelta);
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      drawTimeline();
    } else if (drag.type === "resizeVideoLayerEnd") {
      const scene = deps.activeScene();
      const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
      const vl = list.find((v) => v && v.id === drag.vlId);
      if (!vl) return;
      // 右端ドラッグ: trimEndSec を動かす (startFrame / trimStartSec は固定)
      let nextEnd = drag.startStartSec + drag.startDuration + dxSec;
      nextEnd = snapSec(nextEnd, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      // 同一 layer 内 sibling との重なりは許容 (= 衝突回避 snap は撤去済み)。
      // クランプ: 最小 duration / 素材長
      const minEnd = drag.startStartSec + TIMELINE_MIN_VIDEO_LAYER_DURATION;
      if (nextEnd < minEnd) nextEnd = minEnd;
      const totalDuration = drag.videoDurationSec || 0;
      // 素材末尾 (= trimStart + totalDuration - trimStart) は startSec + (totalDuration - trimStart)
      if (totalDuration > 0) {
        const maxEnd = drag.startStartSec + Math.max(0, totalDuration - drag.startTrimStartSec);
        if (nextEnd > maxEnd) nextEnd = maxEnd;
      }
      const newDuration = nextEnd - drag.startStartSec;
      const newTrimEnd = drag.startTrimStartSec + newDuration;
      vl.trimEndSec = Math.max(drag.startTrimStartSec + 0.05, newTrimEnd);
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      drawTimeline();
    } else if (drag.type === "resizeCutEnd") {
      // R3: カット右端ドラッグで durationFrame を変更。後続カットと linkedItems は
      // pointerup で recalcCutStartSec が連番再計算 + delta 追従する。
      const cuts = state.scenario?.cuts || [];
      const cut = cuts.find((c) => c && c.id === drag.cutId);
      if (!cut) return;
      let nextEnd = drag.startStartSec + drag.startDurationSec + dxSec;
      nextEnd = Math.max(drag.startStartSec + TIMELINE_MIN_TELOP_DURATION, nextEnd);
      nextEnd = snapSec(nextEnd, { disabled: snapDisabled, excludeIds: dragExcludeIds });
      const newDuration = nextEnd - drag.startStartSec;
      if (newDuration < TIMELINE_MIN_TELOP_DURATION) return;
      cut.durationFrame = Math.max(1, secToFrames(newDuration));
      if (!drag.dirty && Math.abs(dx) >= TIMELINE_DRAG_THRESHOLD) drag.dirty = true;
      // ライブで後続カットの startFrame を連番再計算 (視覚追従)。
      recalcCutStartSec();
      drawTimeline();
    } else if (drag.type === "seek") {
      const sec = timelineSecAtClientX(canvas, event.clientX);
      state.timeline.currentSec = Math.max(0, snapSec(sec, { disabled: snapDisabled }));
      drawTimeline();
    }
  };

  const onPointerUp = (event) => {
    const drag = state.timeline.drag;
    if (!drag) return;
    canvas.releasePointerCapture?.(drag.pointerId);
    state.timeline.drag = null;
    canvas.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    // drag 終了で snap インジケータの縦線を消す
    _clearSnapIndicator();
    if (drag.type === "moveTelop" && !drag.dirty) {
      // クリック扱い: 単一選択へリセット (shift クリックは pointerdown で処理済み)
      deps.selectTelop(drag.telopId);
      return;
    }
    if (drag.type === "marquee") {
      const x0 = Math.min(drag.startX, drag.curX ?? drag.startX);
      const x1 = Math.max(drag.startX, drag.curX ?? drag.startX);
      const moved = Math.abs(x1 - x0) >= TIMELINE_DRAG_THRESHOLD;
      if (!moved) {
        // 単純クリック: 既存選択を解除
        if (state.selectedTelopIds && state.selectedTelopIds.size > 0) {
          deps.clearTelopSelection();
          deps.renderPreview();
        }
        return;
      }
      // 範囲に重なるテロップを選択
      const telops = state.scenario?.scenes?.[0]?.telops || [];
      const pxPerSec = state.timeline.pxPerSec;
      const hits = [];
      for (const t of telops) {
        const ts = telopStartSec(t) * pxPerSec;
        const te = ts + Math.max(2, telopDurationSec(t) * pxPerSec);
        if (te < x0 || ts > x1) continue;
        hits.push(t);
      }
      const additive = !!drag.additive;
      const baseIds = additive ? Array.from(state.selectedTelopIds || []) : [];
      const ids = new Set(baseIds);
      for (const t of hits) ids.add(t.id);
      if (ids.size === 0) {
        deps.clearTelopSelection();
        deps.renderPreview();
      } else {
        const primary = state.selectedTelopId && ids.has(state.selectedTelopId)
          ? state.selectedTelopId
          : hits[0]?.id;
        deps.setMultiTelopSelection(Array.from(ids), primary);
        deps.renderPreview();
      }
      drawTimeline();
      return;
    }
    if (drag.type === "moveSoundEffect"
        || drag.type === "resizeSoundEffectStart"
        || drag.type === "resizeSoundEffectEnd") {
      const scene = deps.activeScene();
      if (Array.isArray(scene?.soundEffects)) {
        scene.soundEffects.sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
      }
      if (drag.type === "moveSoundEffect" && !drag.dirty) {
        // クリック扱い: 選択のみ
        deps.selectSoundEffect(drag.seId);
        return;
      }
      commitDragChanges({ historyTouched: drag.dirty });
      if (state.editorTarget === "soundEffect" && state.selectedSoundEffectId === drag.seId) {
        deps.renderSoundEffectEditor();
      }
      return;
    }
    if (drag.type === "moveVideoLayer"
        || drag.type === "resizeVideoLayerStart"
        || drag.type === "resizeVideoLayerEnd") {
      const scene = deps.activeScene();
      if (Array.isArray(scene?.videoLayers)) {
        scene.videoLayers.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
      }
      if (drag.type === "moveVideoLayer" && !drag.dirty) {
        // クリック扱い: 選択のみ
        deps.selectVideoLayer(drag.vlId);
        return;
      }
      commitDragChanges({ historyTouched: drag.dirty });
      if (state.editorTarget === "videoLayer" && state.selectedVideoLayerId === drag.vlId) {
        deps.renderVideoLayerEditor?.();
      }
      return;
    }
    if (drag.type === "moveTelop" || drag.type === "resizeTelopStart" || drag.type === "resizeTelopEnd") {
      // 並び順を保持
      const scene = deps.activeScene();
      if (Array.isArray(scene?.telops)) {
        scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
      }
      commitDragChanges({ historyTouched: drag.dirty });
      // テロップ編集パネルの数値表示も更新
      if (state.editorTarget === "telop" && state.selectedTelopId === drag.telopId) {
        deps.renderTelopEditor();
      }
    }
    if (drag.type === "seek") {
      // シーク先のカットへ自動で切り替える。playhead が複数カットをまたいだとき、
      // 編集パネル/プレビューを「再生ヘッド上のカット」に追従させるため。
      // 該当カットが無い場合（カット間の隙間など）は既存カットのまま renderPreview だけ走らせる。
      const targetCut = findCutAtSec(state.timeline.currentSec);
      if (targetCut && targetCut.id !== state.selectedCutId) {
        deps.loadCut(targetCut, { keepTelopSelection: true })
          .catch((error) => console.warn("loadCut after seek failed", error));
      } else {
        deps.renderPreview().catch((error) => console.warn("renderPreview after seek failed", error));
      }
      // シーク完了後に playhead を永続化。loadCut 経路でも内部で保存されるが、
      // カットを切替えなかった場合 (同一カット内シーク) はここで明示的に呼ぶ必要がある。
      deps.schedulePlayheadSave();
    }
    if (drag.type === "resizeCutEnd") {
      // R3: カット尺変更を確定。後続カット + linkedItems は recalcCutStartSec が
      // 連番再計算済み。保存 + 履歴 + プレビュー更新。
      recalcCutStartSec();
      deps.scheduleScenarioSave();
      if (drag.dirty) recordHistory();
      const cut = (state.scenario?.cuts || []).find((c) => c && c.id === drag.cutId);
      if (cut) {
        deps.loadCut(cut, { keepTelopSelection: true })
          .catch((error) => console.warn("loadCut after cut resize failed", error));
      } else {
        deps.renderPreview().catch(() => {});
      }
    }
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.focus();
    const { x, y } = timelineLocalCoords(canvas, event);
    const hit = timelineHitTest(x, y);
    if (hit.type === "ruler") {
      const sec = timelineSecAtClientX(canvas, event.clientX);
      const snapDisabled = !!event.shiftKey;
      state.timeline.currentSec = Math.max(0, snapSec(sec, { disabled: snapDisabled }));
      state.timeline.drag = {
        type: "seek", pointerId: event.pointerId, startClientX: event.clientX, dirty: true,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      drawTimeline();
      event.preventDefault();
      return;
    }
    if (hit.type === "telopEdge") {
      const telop = findTelopById(hit.telopId);
      if (!telop) return;
      state.timeline.drag = {
        type: hit.edge === "start" ? "resizeTelopStart" : "resizeTelopEnd",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        telopId: telop.id,
        startStartSec: telopStartSec(telop),
        startDuration: Math.max(TIMELINE_MIN_TELOP_DURATION, telopDurationSec(telop)),
        dirty: false,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      // 編集対象として即時選択
      if (state.selectedTelopId !== telop.id) deps.selectTelop(telop.id);
      event.preventDefault();
      return;
    }
    if (hit.type === "telopBody") {
      const telop = findTelopById(hit.telopId);
      if (!telop) return;
      // Cmd (Mac) / Ctrl (Win/Linux) クリック: トグル選択 (種別をまたぐ複数選択を維持)
      if (event.metaKey || event.ctrlKey) {
        _toggleCrossTypeSelection("telop", telop.id);
        event.preventDefault();
        return;
      }
      // Shift クリック: プライマリ〜クリック対象までを範囲選択（連続）
      if (event.shiftKey) {
        const telops = state.scenario?.scenes?.[0]?.telops || [];
        const sorted = telops.slice().sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
        const primaryId = state.selectedTelopId;
        const targetIdx = sorted.findIndex((t) => t.id === telop.id);
        const primaryIdx = primaryId ? sorted.findIndex((t) => t.id === primaryId) : -1;
        const ids = new Set(state.selectedTelopIds || []);
        if (primaryIdx < 0) {
          // 既存プライマリが無い場合: 単純に追加
          ids.add(telop.id);
        } else {
          const lo = Math.min(primaryIdx, targetIdx);
          const hi = Math.max(primaryIdx, targetIdx);
          for (let i = lo; i <= hi; i += 1) ids.add(sorted[i].id);
        }
        deps.setMultiTelopSelection(Array.from(ids), primaryId || telop.id);
        deps.renderPreview();
        event.preventDefault();
        return;
      }
      // 通常クリック: 既存の複数選択に含まれていればグループ移動、含まれていなければ単一選択へリセット
      const groupIds = (state.selectedTelopIds && state.selectedTelopIds.has(telop.id)
        && state.selectedTelopIds.size > 1)
        ? Array.from(state.selectedTelopIds)
        : [telop.id];
      // 単一選択へ落とす場合はここで切替（プライマリを差し替えるが、グループ移動する場合は維持）
      if (groupIds.length === 1 && state.selectedTelopId !== telop.id) {
        // 既存複数選択のうち別テロップを掴んだら、単一選択にリセット
        if (state.selectedTelopIds && state.selectedTelopIds.size > 1) {
          deps.setMultiTelopSelection([telop.id], telop.id);
        }
      }
      const startMap = new Map();
      let groupMinStart = Number.POSITIVE_INFINITY;
      for (const id of groupIds) {
        const t = findTelopById(id);
        if (!t) continue;
        const s = telopStartSec(t);
        startMap.set(id, s);
        if (s < groupMinStart) groupMinStart = s;
      }
      if (!Number.isFinite(groupMinStart)) groupMinStart = 0;
      state.timeline.drag = {
        type: "moveTelop",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        telopId: telop.id,
        startStartSec: telopStartSec(telop),
        startDuration: Math.max(TIMELINE_MIN_TELOP_DURATION, telopDurationSec(telop)),
        dirty: false,
        groupStartMap: startMap,
        groupMinStart,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      event.preventDefault();
      return;
    }
    if (hit.type === "seEdge") {
      const list = state.scenario?.scenes?.[0]?.soundEffects || [];
      const se = list.find((s) => s && s.id === hit.seId);
      if (!se) return;
      const assetDurSec = Number(state.soundEffectDurations?.get(se.src)) || 0;
      const curDurFrames = soundEffectDurationFrame(se, assetDurSec);
      const startDurSec = Math.max(
        TIMELINE_MIN_TELOP_DURATION,
        curDurFrames > 0 ? curDurFrames / PROJECT_FPS : assetDurSec,
      );
      state.timeline.drag = {
        type: hit.edge === "start" ? "resizeSoundEffectStart" : "resizeSoundEffectEnd",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        seId: se.id,
        startStartSec: soundEffectStartSec(se),
        startDurationSec: startDurSec,
        // 左端ドラッグで素材内頭出しを同方向に動かす (= 動画レイヤーと同じ挙動)
        startAudioOffsetSec: Math.max(0, Number(se.audioOffsetSec) || 0),
        dirty: false,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      // 編集対象として即時選択 (telop の resizeTelopEdge と同じ挙動)
      if (state.selectedSoundEffectId !== se.id) deps.selectSoundEffect(se.id);
      event.preventDefault();
      return;
    }
    if (hit.type === "seBody") {
      const list = state.scenario?.scenes?.[0]?.soundEffects || [];
      const se = list.find((s) => s && s.id === hit.seId);
      if (!se) return;
      if (event.metaKey || event.ctrlKey) {
        _toggleCrossTypeSelection("soundEffect", se.id);
        event.preventDefault();
        return;
      }
      // Shift クリック: プライマリ〜クリック対象までを範囲選択（連続）
      if (event.shiftKey) {
        const sorted = list.slice().sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
        const primaryId = state.selectedSoundEffectId;
        const targetIdx = sorted.findIndex((s) => s.id === se.id);
        const primaryIdx = primaryId ? sorted.findIndex((s) => s.id === primaryId) : -1;
        const ids = new Set(state.selectedSoundEffectIds || []);
        if (primaryIdx < 0) {
          ids.add(se.id);
        } else {
          const lo = Math.min(primaryIdx, targetIdx);
          const hi = Math.max(primaryIdx, targetIdx);
          for (let i = lo; i <= hi; i += 1) ids.add(sorted[i].id);
        }
        deps.setMultiSoundEffectSelection(Array.from(ids), primaryId || se.id);
        deps.renderPreview();
        event.preventDefault();
        return;
      }
      // 通常クリック: 既存複数選択に含まれていればグループ移動、そうでなければ単一選択
      const groupIds = (state.selectedSoundEffectIds && state.selectedSoundEffectIds.has(se.id)
        && state.selectedSoundEffectIds.size > 1)
        ? Array.from(state.selectedSoundEffectIds)
        : [se.id];
      if (groupIds.length === 1
          && state.selectedSoundEffectIds && state.selectedSoundEffectIds.size > 1) {
        deps.setMultiSoundEffectSelection([se.id], se.id);
      }
      const startMap = new Map();
      let groupMinStart = Number.POSITIVE_INFINITY;
      for (const id of groupIds) {
        const s = list.find((x) => x && x.id === id);
        if (!s) continue;
        const ss = soundEffectStartSec(s);
        startMap.set(id, ss);
        if (ss < groupMinStart) groupMinStart = ss;
      }
      if (!Number.isFinite(groupMinStart)) groupMinStart = 0;
      state.timeline.drag = {
        type: "moveSoundEffect",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        seId: se.id,
        startStartSec: soundEffectStartSec(se),
        dirty: false,
        groupStartMap: startMap,
        groupMinStart,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      // クリック扱いの単一選択はドラッグ無し終了時 (pointerup) で確定する。
      event.preventDefault();
      return;
    }
    if (hit.type === "seEmpty") {
      // 効果音帯の空き領域クリック: 選択解除
      if (state.selectedSoundEffectId) {
        deps.clearSoundEffectSelection();
        deps.renderPreview();
      }
      event.preventDefault();
      return;
    }
    if (hit.type === "vlBody" || hit.type === "vlEdge") {
      const list = state.scenario?.scenes?.[0]?.videoLayers || [];
      const vl = list.find((v) => v && v.id === hit.vlId);
      if (!vl) return;
      if ((event.metaKey || event.ctrlKey) && hit.type === "vlBody") {
        _toggleCrossTypeSelection("videoLayer", vl.id);
        event.preventDefault();
        return;
      }
      // Shift クリック (= vlBody のみ): プライマリ〜クリック対象までを範囲選択
      if (event.shiftKey && hit.type === "vlBody") {
        const sorted = list.slice().sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
        const primaryId = state.selectedVideoLayerId;
        const targetIdx = sorted.findIndex((v) => v.id === vl.id);
        const primaryIdx = primaryId ? sorted.findIndex((v) => v.id === primaryId) : -1;
        const ids = new Set(state.selectedVideoLayerIds || []);
        if (primaryIdx < 0) {
          ids.add(vl.id);
        } else {
          const lo = Math.min(primaryIdx, targetIdx);
          const hi = Math.max(primaryIdx, targetIdx);
          for (let i = lo; i <= hi; i += 1) ids.add(sorted[i].id);
        }
        deps.setMultiVideoLayerSelection?.(Array.from(ids), primaryId || vl.id);
        deps.renderPreview();
        event.preventDefault();
        return;
      }
      const meta = state.videoLayerDurations?.get(vl.src);
      const totalDuration = Number(meta?.duration) || 0;
      const startDuration = videoLayerDurationSecFor(vl);
      const startStartSec = videoLayerStartSec(vl);
      const startTrimStartSec = videoLayerTrimStartSec(vl);
      const baseDrag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        vlId: vl.id,
        startStartSec,
        startTrimStartSec,
        startDuration,
        videoDurationSec: totalDuration,
        dirty: false,
      };
      if (hit.type === "vlEdge" && hit.edge === "start") {
        state.timeline.drag = { ...baseDrag, type: "resizeVideoLayerStart" };
      } else if (hit.type === "vlEdge" && hit.edge === "end") {
        state.timeline.drag = { ...baseDrag, type: "resizeVideoLayerEnd" };
      } else {
        // 通常クリック: 既存複数選択に含まれていればグループ移動、そうでなければ単一選択リセット
        const groupIds = (state.selectedVideoLayerIds && state.selectedVideoLayerIds.has(vl.id)
          && state.selectedVideoLayerIds.size > 1)
          ? Array.from(state.selectedVideoLayerIds)
          : [vl.id];
        if (groupIds.length === 1
            && state.selectedVideoLayerIds && state.selectedVideoLayerIds.size > 1) {
          deps.setMultiVideoLayerSelection?.([vl.id], vl.id);
        }
        const startMap = new Map();
        let groupMinStart = Number.POSITIVE_INFINITY;
        for (const id of groupIds) {
          const v = list.find((x) => x && x.id === id);
          if (!v) continue;
          const ss = videoLayerStartSec(v);
          startMap.set(id, ss);
          if (ss < groupMinStart) groupMinStart = ss;
        }
        if (!Number.isFinite(groupMinStart)) groupMinStart = 0;
        state.timeline.drag = {
          ...baseDrag,
          type: "moveVideoLayer",
          groupStartMap: startMap,
          groupMinStart,
        };
      }
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      event.preventDefault();
      return;
    }
    if (hit.type === "vlEmpty") {
      // 動画レイヤー帯の空き領域クリック: 選択解除
      if (state.selectedVideoLayerId) {
        deps.clearVideoLayerSelection?.();
        deps.renderPreview();
      }
      event.preventDefault();
      return;
    }
    if (hit.type === "cutEdge") {
      // R3: カット右端ドラッグで尺変更を開始。まず対象カットを単一選択する
      // (多重選択を解除して残留ハイライトを残さない)。
      const target = (state.scenario?.cuts || []).find((c) => c.id === hit.cutId);
      if (!target) return;
      if (state.selectedCutId !== target.id || (state.selectedCutIds && state.selectedCutIds.size > 1)) {
        deps.clearTelopSelection({ render: false });
        deps.clearSoundEffectSelection({ render: false });
        deps.clearVideoLayerSelection?.({ render: false });
        deps.selectCutFromTimeline(target, {});
      }
      state.timeline.drag = {
        type: "resizeCutEnd",
        pointerId: event.pointerId,
        cutId: target.id,
        startClientX: event.clientX,
        startStartSec: cutStartSec(target),
        startDurationSec: cutDurationSec(target),
        dirty: false,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      event.preventDefault();
      return;
    }
    if (hit.type === "cutBar") {
      const target = (state.scenario?.cuts || []).find((c) => c.id === hit.cutId);
      if (target) {
        deps.clearTelopSelection({ render: false });
        deps.clearSoundEffectSelection({ render: false });
        deps.clearVideoLayerSelection?.({ render: false });
        // R3: 通常クリックは多重選択を解除して単一選択 (複製/ペースト後の残留ハイライト対策)。
        deps.selectCutFromTimeline(target, {
          shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
        });
      }
      event.preventDefault();
      return;
    }
    // テロップ帯の空き領域: マーキー（範囲選択）開始。Shift で既存選択に追加。
    if (hit.type === "telopEmpty") {
      const localX = timelineLocalCoords(canvas, event).x;
      state.timeline.drag = {
        type: "marquee",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startX: localX,
        curX: localX,
        additive: !!event.shiftKey,
        dirty: false,
      };
      // Shift でない通常クリックなら、ドラッグ確定までは旧選択を保持しておく
      // （commit 時に置き換える）。
      canvas.setPointerCapture?.(event.pointerId);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      event.preventDefault();
      return;
    }
    // カット帯／波形帯の空き領域 → テロップ選択解除
    if (hit.type === "cutBarEmpty" || hit.type === "wave") {
      if (state.selectedTelopId || (state.selectedTelopIds && state.selectedTelopIds.size > 0)) {
        deps.clearTelopSelection();
        deps.renderPreview();
      }
      event.preventDefault();
      return;
    }
  });

  canvas.addEventListener("dblclick", (event) => {
    const { x, y } = timelineLocalCoords(canvas, event);
    const hit = timelineHitTest(x, y);
    const sec = timelineSecAtClientX(canvas, event.clientX);
    if (hit.type === "telopEmpty") {
      const snapDisabled = !!event.shiftKey;
      timelineCreateTelopAt(snapSec(sec, { disabled: snapDisabled }), hit.lane || 0);
      event.preventDefault();
    } else if (hit.type === "telopBody" || hit.type === "telopEdge") {
      // 既存テロップは select だけ（pointerdown ですでに選択されている）
      deps.selectTelop(hit.telopId);
      event.preventDefault();
    } else if (hit.type === "seEmpty") {
      const snapDisabled = !!event.shiftKey;
      timelineCreateSoundEffectAt(snapSec(sec, { disabled: snapDisabled }), hit.lane || 0);
      event.preventDefault();
    } else if (hit.type === "seBody") {
      deps.selectSoundEffect(hit.seId);
      event.preventDefault();
    } else if (hit.type === "vlEmpty") {
      // 動画レイヤー帯の空き領域ダブルクリック: その位置に新規追加
      const snapDisabled = !!event.shiftKey;
      timelineCreateVideoLayerAt(snapSec(sec, { disabled: snapDisabled }), hit.lane || 0);
      event.preventDefault();
    } else if (hit.type === "vlBody" || hit.type === "vlEdge") {
      deps.selectVideoLayer?.(hit.vlId);
      event.preventDefault();
    }
  });

  canvas.addEventListener("mousemove", (event) => {
    if (state.timeline.drag) return;
    const { x, y } = timelineLocalCoords(canvas, event);
    const hit = timelineHitTest(x, y);
    if (hit.type === "telopEdge") setTimelineCursor("ew-resize");
    else if (hit.type === "telopBody") setTimelineCursor("grab");
    else if (hit.type === "seEdge") setTimelineCursor("ew-resize");
    else if (hit.type === "seBody") setTimelineCursor("grab");
    else if (hit.type === "vlEdge") setTimelineCursor("ew-resize");
    else if (hit.type === "vlBody") setTimelineCursor("grab");
    else if (hit.type === "cutEdge") setTimelineCursor("ew-resize");
    else if (hit.type === "cutBar") setTimelineCursor("pointer");
    else if (hit.type === "ruler") setTimelineCursor("col-resize");
    else setTimelineCursor("default");
  });

  canvas.addEventListener("mouseleave", () => {
    if (!state.timeline.drag) setTimelineCursor("default");
  });

  // ホイール: Ctrl=ズーム / レーンが溢れているとき縦ホイール=縦スクロール / それ以外=水平スクロール
  scrollEl.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const direction = event.deltaY < 0 ? +1 : -1;
      const next = nextTimelineZoomStep(direction);
      const anchorSec = timelineSecAtClientX(canvas, event.clientX);
      setTimelinePxPerSec(next, anchorSec);
      return;
    }
    const contentH = computeTimelineLayout().totalHeight;
    const maxV = Math.max(0, contentH - scrollEl.clientHeight);
    if (!event.shiftKey && maxV > 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      // R2: レーンが縦に溢れているときは縦スクロール (scroll イベントで再描画)。
      event.preventDefault();
      scrollEl.scrollTop = Math.max(0, Math.min(maxV, scrollEl.scrollTop + event.deltaY));
    } else if (Math.abs(event.deltaX) < Math.abs(event.deltaY)) {
      // 縦ホイールを横スクロールに割り当てる (縦溢れ無しの従来挙動)。
      event.preventDefault();
      scrollEl.scrollLeft += event.deltaY;
    }
  }, { passive: false });

  // スクロール時に canvas を再描画（水平/垂直 仮想スクロール）。
  scrollEl.addEventListener("scroll", () => {
    state.timeline.scrollTopV = scrollEl.scrollTop || 0;
    drawTimeline();
  }, { passive: true });

  // キーボード操作（canvas に focus が当たっているとき）。
  // Space や Cmd/Ctrl 系ショートカットは document 側で処理するため、ここでは扱わない。
  // それ以外は SHORTCUT_ACTIONS で定義された action ID を順に試して、
  // 最初に成功したものを採用する (例: ArrowLeft は telopMoveLeft → jumpToPrevTelop の順)。
  canvas.addEventListener("keydown", (event) => {
    // 動作可能性チェック: シナリオが空ならどの action もスキップ
    if (!Array.isArray(state.scenario?.cuts) || state.scenario.cuts.length === 0) return;
    const matches = resolveShortcutAction(event);
    if (matches.length === 0) return;
    for (const actionId of matches) {
      if (handleCanvasShortcut(actionId, event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  });

  // ズームボタン
  elements.timelineZoomInButton?.addEventListener("click", () => {
    setTimelinePxPerSec(nextTimelineZoomStep(+1));
  });
  elements.timelineZoomOutButton?.addEventListener("click", () => {
    setTimelinePxPerSec(nextTimelineZoomStep(-1));
  });

  // ウィンドウリサイズ時の再描画
  window.addEventListener("resize", () => {
    drawTimeline();
  });

  // テーマ切替時に CSS 変数を読み直して再描画 (theme.js が dispatch する)。
  document.addEventListener("splite:theme-change", () => {
    drawTimeline();
  });

  updateTimelineZoomLabel();
}
