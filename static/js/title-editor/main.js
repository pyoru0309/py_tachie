// =============================================================================
// title-editor / main.js
//
// Phase 7 MVP — タイトル組版エディタ (/title-editor)。
// プロジェクト非依存の単体ユーティリティ。16:9 キャンバスに複数の TextClip を
// 配置し、静的 PNG として書き出す。データは PROJECT_ROOT/title_compositions/<id>.json
// に保存する (= 全プロジェクト横断で共有)。
//
// 依存:
//   - 既存の text-core.js (drawCaptionClip) と font.js (registerProjectFonts) を
//     そのまま使うため、グローバル state を import して manifest を埋める。
//   - state の他フィールド (scenario / selectedCutId / ...) は使わない。
// =============================================================================

import { state } from "../state.js";
import { registerProjectFonts, weightItemsForFamily } from "../font.js";
import { clearTextLayoutCache } from "../renderer/text-layout.js";
import { showToast } from "../toast.js";
import { initTheme } from "../theme.js";

import { drawComposition, fitCanvasToFrame } from "./draw.js";
import { buildColorSwatch } from "./color-input.js";
import { measureClipBBox, inkBox } from "./bbox.js";
import { resolveShortcutAction } from "../shortcuts.js";

// ---------------------------------------------------------------------------
// 専用 state (title-editor 内に閉じる)
// ---------------------------------------------------------------------------
const editor = {
  compositionId: null,
  composition: null,     // { id, name, width, height, background, clips: TextClip[] }
  selectedClipId: null,                // プライマリ選択 (= 単一フォーカス)
  selectedClipIds: new Set(),          // 複数選択集合 (= 単一選択時もこの Set に含まれる)
  // pointer drag 中の追従用 (複数選択時は drags[] に複数 origin を保持)
  dragging: null,        // { primaryId, startX, startY, origs: Map<id, {x,y}>, snapGuides } | null
  // スナップガイドを描画するための一時情報 (= 直近のスナップ判定結果)
  snapGuides: [],        // [{ kind: "vertical"|"horizontal", value: number }]
  // ★ Phase 7-R: タイトルエディタ独自の Undo/Redo 履歴。編集画面の history.js とは分離。
  //   stack[pointer] が「現在の状態」。push 時はそれより後ろを捨てる。画面遷移で
  //   module instance ごと消えるので明示クリア不要。
  history: { stack: [], pointer: -1 },
};
const HISTORY_MAX = 80;
let _historyTimer = null;

// DOM 参照
const els = {
  canvas: document.getElementById("titleCanvas"),
  canvasFrame: document.getElementById("canvasFrame"),
  canvasInfo: document.getElementById("canvasInfo"),
  backgroundColorSwatchHost: document.getElementById("backgroundColorSwatchHost"),
  backgroundTransparent: document.getElementById("backgroundTransparentInput"),

  compositionNameInput: document.getElementById("compositionNameInput"),
  compositionPicker: document.getElementById("compositionPicker"),
  newCompositionButton: document.getElementById("newCompositionButton"),
  saveCompositionButton: document.getElementById("saveCompositionButton"),
  deleteCompositionButton: document.getElementById("deleteCompositionButton"),
  exportTargetSelect: document.getElementById("exportTargetSelect"),
  exportPngButton: document.getElementById("exportPngButton"),

  layerParamPane: document.getElementById("layerParamPane"),
  layerParamEmpty: document.getElementById("layerParamEmpty"),
  layerList: document.getElementById("layerList"),
  addLayerButton: document.getElementById("addLayerButton"),
  duplicateLayerButton: document.getElementById("duplicateLayerButton"),
  moveLayerUpButton: document.getElementById("moveLayerUpButton"),
  moveLayerDownButton: document.getElementById("moveLayerDownButton"),
  deleteLayerButton: document.getElementById("deleteLayerButton"),

  alignToolbar: document.getElementById("alignToolbar"),
  alignToolbarHint: document.getElementById("alignToolbarHint"),
};

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
async function init() {
  // 既存テーマ初期化 (data-theme は <head> の inline script で既に当たっているが、
  // 念のため preferredTheme → applyTheme で揃える)
  try { initTheme(); } catch (_) {}

  // 1. manifest (= フォント定義) をロード
  await loadManifest();

  // 1b. グローバル設定 (= ユーザ定義ショートカット) をロードしておく。失敗しても OK
  //     (= shortcutFor() が default にフォールバックする)。
  try {
    const res = await fetch("/api/global-config");
    if (res.ok) state.globalConfig = await res.json();
  } catch (_) {}

  // 2. composition 一覧をピッカーに流す
  await refreshPicker(/*selectFirstIfAny=*/true);

  // 3. キャンバスサイズ追従
  fitCanvasToFrame(els.canvas, els.canvasFrame);
  window.addEventListener("resize", () => {
    fitCanvasToFrame(els.canvas, els.canvasFrame);
    redraw();
  });

  // 4. UI イベント bind
  bindEvents();

  // 5. もし composition が無ければ新規 1 つ作って始める
  if (!editor.composition) {
    newComposition();
  }
  redraw();
}

async function loadManifest() {
  try {
    const res = await fetch("/api/title-editor/manifest");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    // text-core / font.js は state.manifest.config.fonts 等を読むので、互換構造で埋める。
    state.manifest = {
      config: {
        fonts: data.fonts || [],
        fontWeights: data.fontWeights || [],
        defaultFont: data.defaultFont || "",
        defaultFontWeight: data.defaultFontWeight || "regular",
      },
    };
    await registerProjectFonts();
    // FontFace を add しただけでは「次の paint で使える」状態であり、measureText が
    // fallback メトリクスを返す瞬間がある。bbox.js が初回スキャンを fallback で焼くと
    // フォント差し替え後も古いキャッシュが残るので、ここで ready を待ち合わせる。
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }
    // text-layout の glyph / pair-shift / profile キャッシュは fontSpec キーで動くが、
    // モジュールロード時に他経路 (= 本体エディタの init 中) から間に合わせ measureText で
    // 焼かれた fallback メトリクスが残ったまま title-editor の描画に流れ込むケースがある
    // (= サブアプリのフォント warmup 順序差)。fonts.ready 後にキャッシュを全クリアして、
    // 次の drawCaptionClip 経路で Shippori 等の実フォントで再計測させる。
    try { clearTextLayoutCache(); } catch (_) {}
  } catch (err) {
    console.error("[title-editor] manifest load failed", err);
    showToast("フォント定義の読み込みに失敗しました", "error");
  }
}

async function refreshPicker(selectFirstIfAny = false) {
  let list = [];
  try {
    const res = await fetch("/api/title-compositions");
    const data = await res.json();
    list = Array.isArray(data.compositions) ? data.compositions : [];
  } catch (err) {
    console.error(err);
  }
  els.compositionPicker.innerHTML = "";
  const newOpt = document.createElement("option");
  newOpt.value = "";
  newOpt.textContent = "— 開く —";
  els.compositionPicker.append(newOpt);
  for (const item of list) {
    const o = document.createElement("option");
    o.value = item.id;
    o.textContent = `${item.name} (${item.clipCount} 枚)`;
    els.compositionPicker.append(o);
  }
  if (selectFirstIfAny && list.length > 0) {
    els.compositionPicker.value = list[0].id;
    await openComposition(list[0].id);
  }
}

// ---------------------------------------------------------------------------
// composition CRUD
// ---------------------------------------------------------------------------
function defaultClip() {
  // text-core が読む TextClip 最低限。startFrame / durationFrame は時間軸を持たない
  // タイトルエディタでも drawCaptionClip の窓判定を通すため十分長く取る。
  const fontFamily = state.manifest?.config?.defaultFont || "";
  return {
    id: `clip_${Math.random().toString(36).slice(2, 10)}`,
    kind: "caption",
    startFrame: 0,
    durationFrame: 100000,
    text: "新規テキスト",
    position: "custom",
    x: 200,
    y: 200,
    style: {
      fontSize: 96,
      fontFamily,
      fontWeight: state.manifest?.config?.defaultFontWeight || "regular",
      color: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 0,
      align: "center",
      letterSpacing: 0,
      lineSpacing: 0,
      glow: { enabled: false, color: "#ffffff", blurPx: 12, opacity: 0.8 },
      dropShadow: { enabled: false, color: "#000000", blurPx: 6, offsetX: 4, offsetY: 4, opacity: 0.7 },
    },
    renderLayer: "overlay",
    effectPreset: null,
    effectParams: {},
    animation: { in: {preset:null,params:{}}, out: {preset:null,params:{}}, body: {preset:null,params:{}} },
    occlusion: { mode: "none", target: "characters", targetCharacterIds: [], partMode: "all", targetPartIds: [] },
  };
}

function mountBackgroundSwatch() {
  if (!els.backgroundColorSwatchHost || !editor.composition) return;
  els.backgroundColorSwatchHost.innerHTML = "";
  const swatch = buildColorSwatch(
    editor.composition.background?.color || "#1e1e1e",
    "#1e1e1e",
    (v) => {
      if (!editor.composition.background) editor.composition.background = {};
      editor.composition.background.color = v;
      redraw();
    },
  );
  els.backgroundColorSwatchHost.append(swatch);
}

function newComposition() {
  editor.compositionId = null;
  editor.composition = {
    id: null,
    name: "未命名タイトル",
    width: 1920,
    height: 1080,
    background: { color: "#1e1e1e", transparent: false },
    clips: [defaultClip()],
  };
  editor.selectedClipId = editor.composition.clips[0]?.id || null;
  editor.selectedClipIds = new Set(editor.selectedClipId ? [editor.selectedClipId] : []);
  els.compositionNameInput.value = editor.composition.name;
  els.backgroundTransparent.checked = editor.composition.background.transparent;
  els.compositionPicker.value = "";
  mountBackgroundSwatch();
  refreshLayerList();
  refreshParamPane();
  refreshAlignToolbar();
  redraw();
  resetHistory();
}

async function openComposition(id) {
  if (!id) return;
  try {
    const res = await fetch(`/api/title-compositions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    editor.compositionId = data.id;
    editor.composition = data;
    editor.selectedClipId = data.clips?.[0]?.id || null;
    editor.selectedClipIds = new Set(editor.selectedClipId ? [editor.selectedClipId] : []);
    els.compositionNameInput.value = data.name || "";
    els.backgroundTransparent.checked = !!data.background?.transparent;
    mountBackgroundSwatch();
    refreshLayerList();
    refreshParamPane();
    refreshAlignToolbar();
    redraw();
    resetHistory();
  } catch (err) {
    console.error(err);
    showToast("組版の読み込みに失敗しました", "error");
  }
}

async function saveComposition() {
  if (!editor.composition) return;
  // 名前は input から、背景色は composition.background.color (= swatch onChange で常に最新)。
  // transparent チェックは input から拾う。
  editor.composition.name = els.compositionNameInput.value.trim() || "未命名タイトル";
  editor.composition.background = {
    color: editor.composition.background?.color || "#1e1e1e",
    transparent: !!els.backgroundTransparent.checked,
  };
  const payload = editor.composition;
  try {
    let res;
    if (editor.compositionId) {
      res = await fetch(`/api/title-compositions/${encodeURIComponent(editor.compositionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch("/api/title-compositions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const saved = await res.json();
    editor.compositionId = saved.id;
    editor.composition = saved;
    editor.selectedClipId = saved.clips?.[0]?.id || editor.selectedClipId;
    await refreshPicker();
    els.compositionPicker.value = saved.id;
    refreshLayerList();
    refreshParamPane();
    showToast("保存しました");
  } catch (err) {
    console.error(err);
    showToast("保存に失敗しました", "error");
  }
}

async function deleteComposition() {
  if (!editor.compositionId) {
    // 未保存の新規はクライアント側で破棄するだけ
    newComposition();
    return;
  }
  if (!confirm(`「${editor.composition.name}」を削除しますか？`)) return;
  try {
    const res = await fetch(`/api/title-compositions/${encodeURIComponent(editor.compositionId)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    await refreshPicker();
    newComposition();
    showToast("削除しました");
  } catch (err) {
    console.error(err);
    showToast("削除に失敗しました", "error");
  }
}

// ---------------------------------------------------------------------------
// PNG 書き出し
// ---------------------------------------------------------------------------
async function exportPng() {
  if (!editor.composition) return;
  // canvas は表示用にスケール表示されているが、内部解像度は 1920×1080 を維持。
  // toBlob で書き出せばそのまま 1920×1080 の PNG が得られる。
  // 透過モード時のみ、書き出し直前に再描画して背景なしの canvas を作る。
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = editor.composition.width;
  exportCanvas.height = editor.composition.height;
  const transparent = !!els.backgroundTransparent.checked;
  drawComposition(exportCanvas, editor.composition, {
    selectedClipId: null,
    overrideTransparent: transparent,
    showGuides: false,
  });
  const target = els.exportTargetSelect?.value || "local";
  const safeName = (String(editor.composition.name || "title")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 80) || "title");
  exportCanvas.toBlob(async (blob) => {
    if (!blob) { showToast("PNG 書き出しに失敗しました", "error"); return; }
    if (target === "local") {
      // ブラウザの save dialog (= 既定ダウンロード) にダウンロード
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("PNG をダウンロードしました");
      return;
    }
    // サーバ保存 (shared / project)。base64 化して POST する。
    try {
      const base64 = await blobToBase64(blob);
      const res = await fetch("/api/title-editor/export-png", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          filename: safeName,
          pngBase64: base64,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `status ${res.status}`);
      }
      const data = await res.json();
      showToast(`保存しました: ${data.savedPath}`);
    } catch (err) {
      console.error(err);
      showToast(`PNG 保存に失敗: ${err?.message || err}`, "error");
    }
  }, "image/png");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// レイヤー操作
// ---------------------------------------------------------------------------
function addLayer() {
  if (!editor.composition) return;
  const clip = defaultClip();
  // 中央付近に配置
  clip.x = Math.round(editor.composition.width / 2 - 200);
  clip.y = Math.round(editor.composition.height / 2);
  editor.composition.clips.push(clip);
  editor.selectedClipId = clip.id;
  editor.selectedClipIds = new Set([clip.id]);
  refreshLayerList();
  refreshParamPane();
  refreshAlignToolbar();
  redraw();
}

function deleteLayer() {
  if (!editor.composition || editor.selectedClipIds.size === 0) return;
  const ids = new Set(editor.selectedClipIds);
  editor.composition.clips = editor.composition.clips.filter((c) => !ids.has(c.id));
  // 残り 1 つを選択
  const remaining = editor.composition.clips[editor.composition.clips.length - 1];
  editor.selectedClipId = remaining?.id || null;
  editor.selectedClipIds = new Set(editor.selectedClipId ? [editor.selectedClipId] : []);
  refreshLayerList();
  refreshParamPane();
  refreshAlignToolbar();
  redraw();
}

// 選択中のレイヤーを複写する。複数選択にも対応 (= 元のすぐ後ろに同じ順序で挿入)。
// 複写後の clip は (+24, +24) ずらして配置し、複写群を選択状態にする。
function duplicateLayer() {
  if (!editor.composition || editor.selectedClipIds.size === 0) return;
  const selectedIds = new Set(editor.selectedClipIds);
  const newIds = [];
  const next = [];
  for (const c of editor.composition.clips) {
    next.push(c);
    if (selectedIds.has(c.id)) {
      const cloned = JSON.parse(JSON.stringify(c));
      cloned.id = `clip_${Math.random().toString(36).slice(2, 10)}`;
      cloned.x = (Number(cloned.x) || 0) + 24;
      cloned.y = (Number(cloned.y) || 0) + 24;
      next.push(cloned);
      newIds.push(cloned.id);
    }
  }
  if (newIds.length === 0) return;
  editor.composition.clips = next;
  // 複写群を選択状態にする (プライマリは最後に挿入されたもの)
  editor.selectedClipIds = new Set(newIds);
  editor.selectedClipId = newIds[newIds.length - 1];
  refreshLayerList();
  refreshParamPane();
  refreshAlignToolbar();
  redraw();
  scheduleRecordHistory();
}

function moveLayer(direction) {
  if (!editor.composition || !editor.selectedClipId) return;
  const clips = editor.composition.clips;
  const idx = clips.findIndex((c) => c.id === editor.selectedClipId);
  if (idx < 0) return;
  const j = idx + direction;
  if (j < 0 || j >= clips.length) return;
  [clips[idx], clips[j]] = [clips[j], clips[idx]];
  refreshLayerList();
  redraw();
}

// 選択操作: mode = "single" (= クリック) / "toggle" (= Shift/Ctrl+クリック)
function selectLayer(id, mode = "single") {
  if (!id) {
    editor.selectedClipId = null;
    editor.selectedClipIds = new Set();
  } else if (mode === "toggle") {
    if (editor.selectedClipIds.has(id)) {
      editor.selectedClipIds.delete(id);
      if (editor.selectedClipId === id) {
        editor.selectedClipId = editor.selectedClipIds.values().next().value || null;
      }
    } else {
      editor.selectedClipIds.add(id);
      editor.selectedClipId = id;
    }
  } else {
    editor.selectedClipId = id;
    editor.selectedClipIds = new Set([id]);
  }
  refreshLayerList();
  refreshParamPane();
  refreshAlignToolbar();
  redraw();
}

function refreshLayerList() {
  els.layerList.innerHTML = "";
  if (!editor.composition) return;
  // 描画順は配列順 (= 後ろほど手前)。レイヤーパネルでは「手前を上に」表示するため reverse。
  const clips = editor.composition.clips.slice().reverse();
  for (const clip of clips) {
    const li = document.createElement("li");
    const isSelected = editor.selectedClipIds.has(clip.id);
    const isPrimary = clip.id === editor.selectedClipId;
    li.className = "layer-item"
      + (isSelected ? " selected" : "")
      + (isPrimary ? " active" : "");
    li.dataset.clipId = clip.id;
    const label = String(clip.text || "（空）").split("\n")[0].slice(0, 14);
    li.innerHTML = `<span class="layer-item-label">${label || "（空）"}</span>`;
    li.addEventListener("click", (ev) => {
      const mode = (ev.shiftKey || ev.metaKey || ev.ctrlKey) ? "toggle" : "single";
      selectLayer(clip.id, mode);
    });
    els.layerList.append(li);
  }
}

function selectedClip() {
  if (!editor.composition || !editor.selectedClipId) return null;
  return editor.composition.clips.find((c) => c.id === editor.selectedClipId) || null;
}

function selectedClips() {
  if (!editor.composition || editor.selectedClipIds.size === 0) return [];
  return editor.composition.clips.filter((c) => editor.selectedClipIds.has(c.id));
}

// 整列ツールバーの有効/無効状態を更新
function refreshAlignToolbar() {
  if (!els.alignToolbar) return;
  const n = editor.selectedClipIds.size;
  for (const btn of els.alignToolbar.querySelectorAll("button[data-align]")) {
    const op = btn.dataset.align;
    const needsThree = op === "distH" || op === "distV";
    btn.disabled = needsThree ? n < 3 : n < 2;
  }
  if (els.alignToolbarHint) {
    if (n === 0) els.alignToolbarHint.textContent = "2 つ以上選択で有効";
    else if (n === 1) els.alignToolbarHint.textContent = "もう 1 つ選択";
    else els.alignToolbarHint.textContent = `${n} 個選択中`;
  }
}

// 整列処理本体: op に応じて選択中 clip の x/y を再計算する。
function alignSelected(op) {
  const clips = selectedClips();
  if (clips.length < 2) return;
  // ink ベースの bbox を使う (= 視覚的な揃え)。各 item は ink 矩形と「ink 原点 ↔ clip 原点」
  // のオフセット (ox, oy) を保持し、整列計算後に「clip.x = 目標 ink x - ox」で逆算する。
  const items = clips.map((c) => {
    const m = measureClipBBox(c);
    const ox = m.inkX;            // clip.x からの ink 左端オフセット
    const oy = m.inkY;
    const ix = (c.x ?? 0) + ox;   // ink 左端 (絶対座標)
    const iy = (c.y ?? 0) + oy;
    return {
      clip: c, ox, oy,
      left: ix, right: ix + m.inkW,
      top: iy, bottom: iy + m.inkH,
      w: m.inkW, h: m.inkH,
      cx: ix + m.inkW / 2, cy: iy + m.inkH / 2,
    };
  });
  const setInkX = (i, inkX) => { i.clip.x = Math.round(inkX - i.ox); };
  const setInkY = (i, inkY) => { i.clip.y = Math.round(inkY - i.oy); };
  if (op === "hLeft") {
    const minLeft = Math.min(...items.map((i) => i.left));
    for (const i of items) setInkX(i, minLeft);
  } else if (op === "hRight") {
    const maxRight = Math.max(...items.map((i) => i.right));
    for (const i of items) setInkX(i, maxRight - i.w);
  } else if (op === "hCenter") {
    const minLeft = Math.min(...items.map((i) => i.left));
    const maxRight = Math.max(...items.map((i) => i.right));
    const center = (minLeft + maxRight) / 2;
    for (const i of items) setInkX(i, center - i.w / 2);
  } else if (op === "vTop") {
    const minTop = Math.min(...items.map((i) => i.top));
    for (const i of items) setInkY(i, minTop);
  } else if (op === "vBottom") {
    const maxBottom = Math.max(...items.map((i) => i.bottom));
    for (const i of items) setInkY(i, maxBottom - i.h);
  } else if (op === "vMiddle") {
    const minTop = Math.min(...items.map((i) => i.top));
    const maxBottom = Math.max(...items.map((i) => i.bottom));
    const center = (minTop + maxBottom) / 2;
    for (const i of items) setInkY(i, center - i.h / 2);
  } else if (op === "distH") {
    if (items.length < 3) return;
    const sorted = items.slice().sort((a, b) => a.cx - b.cx);
    const cxMin = sorted[0].cx;
    const cxMax = sorted[sorted.length - 1].cx;
    const step = (cxMax - cxMin) / (sorted.length - 1);
    for (let i = 1; i < sorted.length - 1; i += 1) {
      const targetCx = cxMin + step * i;
      setInkX(sorted[i], targetCx - sorted[i].w / 2);
    }
  } else if (op === "distV") {
    if (items.length < 3) return;
    const sorted = items.slice().sort((a, b) => a.cy - b.cy);
    const cyMin = sorted[0].cy;
    const cyMax = sorted[sorted.length - 1].cy;
    const step = (cyMax - cyMin) / (sorted.length - 1);
    for (let i = 1; i < sorted.length - 1; i += 1) {
      const targetCy = cyMin + step * i;
      setInkY(sorted[i], targetCy - sorted[i].h / 2);
    }
  }
  refreshParamPane();
  redraw();
}

// ---------------------------------------------------------------------------
// パラメータフォーム (右上ペイン)
// ---------------------------------------------------------------------------
// 全選択中の clip に style 系の変更を一括適用するヘルパ。setter は clip ごとに 1 回呼ぶ。
// 個別性が強いキー (text / x / y) は applyToPrimaryOnly で 1 件だけ更新。
function applyToSelected(setter) {
  const clips = selectedClips();
  if (clips.length === 0) {
    const p = selectedClip();
    if (p) setter(p);
  } else {
    for (const c of clips) setter(c);
  }
}

function refreshParamPane() {
  const pane = els.layerParamPane;
  pane.innerHTML = "";
  const clip = selectedClip();
  if (!clip) {
    pane.append(els.layerParamEmpty);
    return;
  }
  const multi = editor.selectedClipIds.size > 1;
  if (multi) {
    const banner = document.createElement("p");
    banner.className = "title-editor-multi-banner";
    banner.textContent = `${editor.selectedClipIds.size} 個のレイヤーを選択中。書体・サイズ・色などの変更は選択全部に反映されます (テキスト・位置はプライマリのみ)。`;
    pane.append(banner);
  }
  // 1. テキスト (textarea) — プライマリのみ
  pane.append(buildField("テキスト" + (multi ? " (プライマリのみ)" : ""), () => {
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.value = clip.text || "";
    ta.addEventListener("input", () => {
      clip.text = ta.value;
      refreshLayerList();
      redraw();
    });
    return ta;
  }));
  // 2. 位置 (x, y) — プライマリのみ
  pane.append(buildRow([
    buildField("X" + (multi ? " (プライマリ)" : ""), () => buildNumberInput(clip.x ?? 0, (v) => { clip.x = v; redraw(); }, { step: 1 })),
    buildField("Y" + (multi ? " (プライマリ)" : ""), () => buildNumberInput(clip.y ?? 0, (v) => { clip.y = v; redraw(); }, { step: 1 })),
  ]));
  // 3. 文字サイズ / 書体 / 太さ (3 列)
  pane.append(buildRow3([
    buildField("文字サイズ", () => buildNumberInput(
      clip.style.fontSize ?? 48,
      (v) => { applyToSelected((c) => { c.style.fontSize = Math.max(8, v); }); redraw(); },
      { min: 8, max: 600, step: 1 },
    )),
    buildField("書体", () => buildFontSelect(clip.style.fontFamily || "", (v) => {
      applyToSelected((c) => {
        c.style.fontFamily = v;
        const items = weightItemsForFamily(v);
        if (!items.some((it) => it.id === c.style.fontWeight)) {
          c.style.fontWeight = items[0]?.id || "regular";
        }
      });
      refreshParamPane();
      redraw();
    })),
    buildField("太さ", () => buildWeightSelect(clip.style.fontFamily || "", clip.style.fontWeight || "regular", (v) => {
      applyToSelected((c) => { c.style.fontWeight = v; });
      redraw();
    })),
  ]));
  // 4. 文字色 / アウトライン色 / アウトライン太さ (3 列)
  pane.append(buildRow3([
    buildField("文字色", () => buildColorSwatch(clip.style.color || "#ffffff", "#ffffff", (v) => {
      applyToSelected((c) => { c.style.color = v; }); redraw();
    })),
    buildField("アウトライン色", () => buildColorSwatch(clip.style.outlineColor || "#000000", "#000000", (v) => {
      applyToSelected((c) => { c.style.outlineColor = v; }); redraw();
    })),
    buildField("アウトライン太さ", () => buildNumberInput(
      clip.style.outlineWidth ?? 0,
      (v) => { applyToSelected((c) => { c.style.outlineWidth = Math.max(0, v); }); redraw(); },
      { min: 0, max: 30, step: 0.5 },
    )),
  ]));
  // 5. 文字揃え / 文字間 (2 列)
  pane.append(buildRow([
    buildField("文字揃え", () => {
      const sel = document.createElement("select");
      for (const [v, l] of [["left", "左"], ["center", "中央"], ["right", "右"]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = l; sel.append(o);
      }
      sel.value = clip.style.align || "center";
      applyMixedToSelect(sel, isStyleMixed((c) => c.style?.align || "center"));
      sel.addEventListener("change", () => {
        if (sel.value === MIXED_VALUE) return;
        applyToSelected((c) => { c.style.align = sel.value; });
        redraw();
      });
      return sel;
    }),
    buildField("文字間 (1/1000em)", () => buildNumberInput(
      clip.style.letterSpacing ?? 0,
      (v) => { applyToSelected((c) => { c.style.letterSpacing = v; }); redraw(); },
      { min: -500, max: 1000, step: 10 },
    )),
  ]));
  // 6b. オプティカルカーニング (= 既存実装を流用)
  pane.append(buildField("カーニング", () => {
    const wrap = document.createElement("div");
    wrap.className = "title-editor-checkbox-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!clip.style.enableOpticalKerning;
    cb.addEventListener("change", () => {
      applyToSelected((c) => { c.style.enableOpticalKerning = cb.checked; });
      refreshParamPane();
      redraw();
    });
    const label = document.createElement("span");
    label.textContent = "オプティカルカーニングを有効にする";
    wrap.append(cb, label);
    return wrap;
  }));
  if (clip.style.enableOpticalKerning) {
    pane.append(buildField("カーニング精度", () => {
      const wrap = document.createElement("div");
      wrap.className = "title-editor-checkbox-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!clip.style.opticalKerningHighQuality;
      cb.addEventListener("change", () => {
        applyToSelected((c) => { c.style.opticalKerningHighQuality = cb.checked; });
        redraw();
      });
      const label = document.createElement("span");
      label.textContent = "高精度モード (低速)";
      wrap.append(cb, label);
      return wrap;
    }));
  }
  // 7. 光彩 (glow)
  const glow = clip.style.glow || (clip.style.glow = { enabled: false, color: "#ffffff", blurPx: 12, opacity: 0.8 });
  // 全選択 clip の glow を保証する小ヘルパ
  const ensureGlow = (c) => (c.style.glow || (c.style.glow = { enabled: false, color: "#ffffff", blurPx: 12, opacity: 0.8 }));
  pane.append(buildField("光彩", () => {
    const wrap = document.createElement("div");
    wrap.className = "title-editor-checkbox-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!glow.enabled;
    cb.addEventListener("change", () => {
      applyToSelected((c) => { ensureGlow(c).enabled = cb.checked; });
      refreshParamPane();
      redraw();
    });
    const label = document.createElement("span");
    label.textContent = "光彩を有効にする";
    wrap.append(cb, label);
    return wrap;
  }));
  if (glow.enabled) {
    pane.append(buildRow([
      buildField("光彩色", () => buildColorSwatch(glow.color || "#ffffff", "#ffffff", (v) => {
        applyToSelected((c) => { ensureGlow(c).color = v; }); redraw();
      })),
      buildField("ぼかし (px)", () => buildNumberInput(
        glow.blurPx ?? 12,
        (v) => { applyToSelected((c) => { ensureGlow(c).blurPx = Math.max(0, v); }); redraw(); },
        { min: 0, max: 120, step: 1 },
      )),
    ]));
    pane.append(buildField("光彩 不透明度", () => buildNumberInput(
      glow.opacity ?? 0.8,
      (v) => { applyToSelected((c) => { ensureGlow(c).opacity = Math.max(0, Math.min(1, v)); }); redraw(); },
      { min: 0, max: 1, step: 0.05 },
    )));
  }

  // 8. ドロップシャドウ
  const ds = clip.style.dropShadow || (clip.style.dropShadow = {
    enabled: false, color: "#000000", blurPx: 6, offsetX: 4, offsetY: 4, opacity: 0.7,
  });
  const ensureShadow = (c) => (c.style.dropShadow || (c.style.dropShadow = {
    enabled: false, color: "#000000", blurPx: 6, offsetX: 4, offsetY: 4, opacity: 0.7,
  }));
  pane.append(buildField("ドロップシャドウ", () => {
    const wrap = document.createElement("div");
    wrap.className = "title-editor-checkbox-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!ds.enabled;
    cb.addEventListener("change", () => {
      applyToSelected((c) => { ensureShadow(c).enabled = cb.checked; });
      refreshParamPane();
      redraw();
    });
    const label = document.createElement("span");
    label.textContent = "ドロップシャドウを有効にする";
    wrap.append(cb, label);
    return wrap;
  }));
  if (ds.enabled) {
    pane.append(buildRow([
      buildField("影の色", () => buildColorSwatch(ds.color || "#000000", "#000000", (v) => {
        applyToSelected((c) => { ensureShadow(c).color = v; }); redraw();
      })),
      buildField("ぼかし (px)", () => buildNumberInput(
        ds.blurPx ?? 6,
        (v) => { applyToSelected((c) => { ensureShadow(c).blurPx = Math.max(0, v); }); redraw(); },
        { min: 0, max: 60, step: 1 },
      )),
    ]));
    pane.append(buildRow([
      buildField("X オフセット", () => buildNumberInput(
        ds.offsetX ?? 4,
        (v) => { applyToSelected((c) => { ensureShadow(c).offsetX = v; }); redraw(); },
        { min: -100, max: 100, step: 1 },
      )),
      buildField("Y オフセット", () => buildNumberInput(
        ds.offsetY ?? 4,
        (v) => { applyToSelected((c) => { ensureShadow(c).offsetY = v; }); redraw(); },
        { min: -100, max: 100, step: 1 },
      )),
    ]));
    pane.append(buildField("影の不透明度", () => buildNumberInput(
      ds.opacity ?? 0.7,
      (v) => { applyToSelected((c) => { ensureShadow(c).opacity = Math.max(0, Math.min(1, v)); }); redraw(); },
      { min: 0, max: 1, step: 0.05 },
    )));
  }

  // 9. 位置プリセット (3×3)
  pane.append(buildField("位置プリセット", () => {
    const grid = document.createElement("div");
    grid.className = "title-editor-pos-grid";
    const labels = [
      ["left", "top",    "↖", "左上"], ["center", "top",    "↑", "上中央"], ["right", "top",    "↗", "右上"],
      ["left", "middle", "←", "左中央"], ["center", "middle", "●", "中央"],   ["right", "middle", "→", "右中央"],
      ["left", "bottom", "↙", "左下"], ["center", "bottom", "↓", "下中央"], ["right", "bottom", "↘", "右下"],
    ];
    for (const [h, v, sym, tip] of labels) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "title-editor-pos-cell";
      b.textContent = sym;
      b.title = tip;
      b.addEventListener("click", () => applyPositionPreset(clip, h, v));
      grid.append(b);
    }
    return grid;
  }));
}

// 位置プリセット: clip の **ink** bbox + 画面端マージンで x/y を再計算する。
// ink ベースなので、文字の視覚的境界が画面端から margin の位置にぴったり揃う。
// hAlign = "left" | "center" | "right" / vAlign = "top" | "middle" | "bottom"
function applyPositionPreset(clip, hAlign, vAlign) {
  if (!editor.composition || !clip) return;
  const canvasW = editor.composition.width;
  const canvasH = editor.composition.height;
  const margin = 40;
  // 現在の ink box を測り、その offset を clip.x/y との差分として扱う。
  const m = measureClipBBox(clip);
  // ink 左上の clip 相対 offset
  const offX = m.inkX;
  const offY = m.inkY;
  const inkW = m.inkW;
  const inkH = m.inkH;
  // ink box の左上が「画面端 margin」 / 「画面中央 - inkW/2」 になるよう clip.x/y を逆算する。
  let x = clip.x ?? 0;
  let y = clip.y ?? 0;
  if (hAlign === "left")   x = Math.round(margin - offX);
  if (hAlign === "center") x = Math.round((canvasW - inkW) / 2 - offX);
  if (hAlign === "right")  x = Math.round(canvasW - inkW - margin - offX);
  if (vAlign === "top")    y = Math.round(margin - offY);
  if (vAlign === "middle") y = Math.round((canvasH - inkH) / 2 - offY);
  if (vAlign === "bottom") y = Math.round(canvasH - inkH - margin - offY);
  clip.x = x;
  clip.y = y;
  refreshParamPane();
  redraw();
}

// 小ヘルパ
function buildField(label, makeInput) {
  const wrap = document.createElement("label");
  wrap.className = "title-editor-field";
  const cap = document.createElement("span");
  cap.className = "title-editor-field-label";
  cap.textContent = label;
  wrap.append(cap);
  wrap.append(makeInput());
  return wrap;
}

function buildRow(nodes) {
  const row = document.createElement("div");
  row.className = "title-editor-field-row";
  for (const n of nodes) row.append(n);
  return row;
}

function buildRow3(nodes) {
  const row = document.createElement("div");
  row.className = "title-editor-field-row-3";
  for (const n of nodes) row.append(n);
  return row;
}

function buildNumberInput(value, onChange, { min, max, step } = {}) {
  const i = document.createElement("input");
  i.type = "number";
  if (min != null) i.min = String(min);
  if (max != null) i.max = String(max);
  if (step != null) i.step = String(step);
  i.value = String(value);
  i.addEventListener("input", () => {
    const n = Number(i.value);
    if (Number.isFinite(n)) onChange(n);
  });
  return i;
}

// 「混在」検出: editor.selectedClipIds の clip の中で valueGetter の戻り値が
//  プライマリと異なるものがあれば true。複数選択時のみ判定する (= 単一選択は混在しない)。
function isStyleMixed(valueGetter) {
  const clips = selectedClips();
  if (clips.length <= 1) return false;
  const primary = selectedClip();
  if (!primary) return false;
  const primaryVal = valueGetter(primary);
  return clips.some((c) => valueGetter(c) !== primaryVal);
}

const MIXED_VALUE = "__mixed__";

// 混在対応の select 共通ロジック。混在時は冒頭に "— 混在 —" placeholder option を入れ、
// value=__mixed__ にする。change で __mixed__ なら無視 (= ユーザーが値を選び直したときだけ反映)。
function applyMixedToSelect(sel, mixed) {
  // 既存の placeholder option を取り除く (= 再描画時にダブらないように)
  for (const o of Array.from(sel.querySelectorAll(`option[value="${MIXED_VALUE}"]`))) o.remove();
  if (mixed) {
    const o = document.createElement("option");
    o.value = MIXED_VALUE;
    o.textContent = "— 混在 —";
    sel.insertBefore(o, sel.firstChild);
    sel.value = MIXED_VALUE;
  }
}

function buildFontSelect(currentId, onChange) {
  const sel = document.createElement("select");
  const fonts = state.manifest?.config?.fonts || [];
  for (const f of fonts) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.name || f.id;
    sel.append(o);
  }
  sel.value = currentId || (fonts[0]?.id ?? "");
  const mixed = isStyleMixed((c) => c.style?.fontFamily || "");
  applyMixedToSelect(sel, mixed);
  sel.addEventListener("change", () => {
    if (sel.value === MIXED_VALUE) return;
    onChange(sel.value);
  });
  return sel;
}

function buildWeightSelect(familyId, currentWeight, onChange) {
  const sel = document.createElement("select");
  const items = weightItemsForFamily(familyId);
  for (const w of items) {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = w.name;
    sel.append(o);
  }
  sel.value = items.some((w) => w.id === currentWeight) ? currentWeight : (items[0]?.id || "regular");
  const mixed = isStyleMixed((c) => c.style?.fontWeight || "regular");
  applyMixedToSelect(sel, mixed);
  sel.addEventListener("change", () => {
    if (sel.value === MIXED_VALUE) return;
    onChange(sel.value);
  });
  return sel;
}

// ---------------------------------------------------------------------------
// canvas 上の pointer 操作 (= 選択中レイヤーをドラッグ移動)
// ---------------------------------------------------------------------------
function bindPointerOnCanvas() {
  const canvas = els.canvas;
  // クライアント座標 → canvas 内座標 (1920×1080 空間)
  function localCoord(ev) {
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return { cx, cy };
  }
  // hit-test: ink bbox の矩形に当たるか (= 視覚的にクリック対象に見える領域)。
  // クリック余裕として ink 矩形を 4px ずつ膨らませる (= 小さい文字でも掴みやすい)。
  function hitTest(cx, cy) {
    if (!editor.composition) return null;
    const clips = editor.composition.clips;
    for (let i = clips.length - 1; i >= 0; i -= 1) {
      const c = clips[i];
      if (!String(c.text || "")) continue;
      const b = inkBox(c);
      const pad = 4;
      if (cx >= b.x - pad && cx <= b.x + b.w + pad
          && cy >= b.y - pad && cy <= b.y + b.h + pad) {
        return c;
      }
    }
    return null;
  }
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const { cx, cy } = localCoord(ev);
    const hit = hitTest(cx, cy);
    const toggle = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    if (hit) {
      // クリック対象が既に選択集合に入っていればそのまま、入っていなければ追加 (toggle) or 単独選択
      if (!editor.selectedClipIds.has(hit.id)) {
        selectLayer(hit.id, toggle ? "toggle" : "single");
      } else if (toggle) {
        // Shift+クリックで既に選択中のものを再度クリック → 選択解除 (ドラッグ開始しない)
        selectLayer(hit.id, "toggle");
        return;
      } else {
        editor.selectedClipId = hit.id;   // プライマリだけ差し替え (= 複数選択は維持)
        refreshAlignToolbar();
        refreshParamPane();
        refreshLayerList();
      }
      // ドラッグ準備: 選択中の全 clip の元位置を保持
      const origs = new Map();
      for (const id of editor.selectedClipIds) {
        const c = editor.composition.clips.find((cc) => cc.id === id);
        if (c) origs.set(id, { x: c.x ?? 0, y: c.y ?? 0 });
      }
      editor.dragging = { primaryId: hit.id, startX: cx, startY: cy, origs };
      canvas.setPointerCapture(ev.pointerId);
      redraw();
    } else {
      if (!toggle) selectLayer(null, "single");
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!editor.dragging) return;
    const { cx, cy } = localCoord(ev);
    let dx = cx - editor.dragging.startX;
    let dy = cy - editor.dragging.startY;
    // プライマリ clip にスナップ計算をかけ、その補正値を全選択 clip に同じだけ適用
    const primaryClip = editor.composition.clips.find((c) => c.id === editor.dragging.primaryId);
    const origPrimary = editor.dragging.origs.get(editor.dragging.primaryId) || { x: 0, y: 0 };
    if (primaryClip) {
      const candX = origPrimary.x + dx;
      const candY = origPrimary.y + dy;
      const snap = computeSnap(primaryClip, candX, candY);
      dx = snap.x - origPrimary.x;
      dy = snap.y - origPrimary.y;
      editor.snapGuides = snap.guides;
    }
    for (const [id, orig] of editor.dragging.origs) {
      const c = editor.composition.clips.find((cc) => cc.id === id);
      if (!c) continue;
      c.x = Math.round(orig.x + dx);
      c.y = Math.round(orig.y + dy);
    }
    refreshParamPane();
    redraw();
  });
  const endDrag = (ev) => {
    if (!editor.dragging) return;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    editor.dragging = null;
    editor.snapGuides = [];
    redraw();
    // ドラッグ確定時にもう 1 回履歴を確実に積む (= 上の redraw 内で積まれるはずだが念のため)
    scheduleRecordHistory();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
}

// ---------------------------------------------------------------------------
// スナップ計算 (Phase 7-H)
// ---------------------------------------------------------------------------
const SNAP_THRESHOLD = 8;  // px (= 1920 空間)

// drag 中のプライマリ clip について、ink ベースで近いスナップターゲットに吸い付かせる。
// 候補は「キャンバスの中央線」と「他レイヤーの ink 左/中央/右 と上/中央/下」。
function computeSnap(clip, candX, candY) {
  if (!editor.composition) return { x: candX, y: candY, guides: [] };
  const m = measureClipBBox(clip);
  const myOX = m.inkX;     // clip.x からの ink 左端オフセット
  const myOY = m.inkY;
  const myW = m.inkW;
  const myH = m.inkH;
  const draggedIds = editor.dragging?.origs ? Array.from(editor.dragging.origs.keys()) : [clip.id];
  const otherEdgesX = [];
  const otherEdgesY = [];
  const cw = editor.composition.width;
  const ch = editor.composition.height;
  otherEdgesX.push({ value: cw / 2, kind: "canvas-center" });
  otherEdgesY.push({ value: ch / 2, kind: "canvas-center" });
  for (const other of editor.composition.clips) {
    if (draggedIds.includes(other.id)) continue;
    const ob = measureClipBBox(other);
    const oxBase = (other.x ?? 0) + ob.inkX;
    const oyBase = (other.y ?? 0) + ob.inkY;
    otherEdgesX.push({ value: oxBase, kind: "other-left" });
    otherEdgesX.push({ value: oxBase + ob.inkW, kind: "other-right" });
    otherEdgesX.push({ value: oxBase + ob.inkW / 2, kind: "other-center" });
    otherEdgesY.push({ value: oyBase, kind: "other-top" });
    otherEdgesY.push({ value: oyBase + ob.inkH, kind: "other-bottom" });
    otherEdgesY.push({ value: oyBase + ob.inkH / 2, kind: "other-center" });
  }
  // candX/Y は clip.x の候補。ink 範囲は (candX + myOX, candX + myOX + myW)
  const myInkLeft = candX + myOX;
  const myInkRight = myInkLeft + myW;
  const myInkCenterX = myInkLeft + myW / 2;
  const myInkTop = candY + myOY;
  const myInkBottom = myInkTop + myH;
  const myInkCenterY = myInkTop + myH / 2;

  let bestX = { delta: SNAP_THRESHOLD + 1, target: null, mine: null };
  for (const e of otherEdgesX) {
    for (const [mineKind, mineVal] of [["left", myInkLeft], ["center", myInkCenterX], ["right", myInkRight]]) {
      const diff = Math.abs(mineVal - e.value);
      if (diff < bestX.delta) bestX = { delta: diff, target: e, mine: mineKind };
    }
  }
  let bestY = { delta: SNAP_THRESHOLD + 1, target: null, mine: null };
  for (const e of otherEdgesY) {
    for (const [mineKind, mineVal] of [["top", myInkTop], ["center", myInkCenterY], ["bottom", myInkBottom]]) {
      const diff = Math.abs(mineVal - e.value);
      if (diff < bestY.delta) bestY = { delta: diff, target: e, mine: mineKind };
    }
  }

  let finalX = candX;
  let finalY = candY;
  const guides = [];
  if (bestX.delta <= SNAP_THRESHOLD && bestX.target) {
    const off = bestX.mine === "left" ? 0 : (bestX.mine === "center" ? myW / 2 : myW);
    // ink 左端を target.value - off に置きたいので、clip.x = target.value - off - myOX
    finalX = Math.round(bestX.target.value - off - myOX);
    guides.push({ kind: "vertical", value: bestX.target.value });
  }
  if (bestY.delta <= SNAP_THRESHOLD && bestY.target) {
    const off = bestY.mine === "top" ? 0 : (bestY.mine === "center" ? myH / 2 : myH);
    finalY = Math.round(bestY.target.value - off - myOY);
    guides.push({ kind: "horizontal", value: bestY.target.value });
  }
  return { x: finalX, y: finalY, guides };
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Undo / Redo (Phase 7-R) — タイトルエディタ独自の履歴
// ---------------------------------------------------------------------------

function _snapshot() {
  if (!editor.composition) return null;
  return JSON.stringify(editor.composition);
}

// 履歴の起点。composition 切替時 (新規 / 開く) は履歴をリセットして「初期状態」だけ
// stack に入れる。これ以降の編集は scheduleRecordHistory 経由で積まれる。
function resetHistory() {
  if (_historyTimer) { clearTimeout(_historyTimer); _historyTimer = null; }
  const snap = _snapshot();
  if (!snap) {
    editor.history.stack = [];
    editor.history.pointer = -1;
    return;
  }
  editor.history.stack = [snap];
  editor.history.pointer = 0;
}

// 編集後に呼ぶ (= debounce 付き)。連続するスライダや入力でスナップショットが
// 大量に積まれないよう、最後の変更から 250ms 後にまとめて 1 つ push する。
function scheduleRecordHistory() {
  if (_historyTimer) clearTimeout(_historyTimer);
  _historyTimer = setTimeout(() => {
    _historyTimer = null;
    const snap = _snapshot();
    if (snap == null) return;
    // 同 snapshot が既に末尾にあるなら積まない
    if (editor.history.stack[editor.history.pointer] === snap) return;
    // pointer より後ろの redo 履歴は捨てる
    editor.history.stack = editor.history.stack.slice(0, editor.history.pointer + 1);
    editor.history.stack.push(snap);
    editor.history.pointer = editor.history.stack.length - 1;
    if (editor.history.stack.length > HISTORY_MAX) {
      const drop = editor.history.stack.length - HISTORY_MAX;
      editor.history.stack.splice(0, drop);
      editor.history.pointer -= drop;
    }
  }, 250);
}

function _restoreFromSnapshot(snap) {
  try {
    editor.composition = JSON.parse(snap);
    // selectedClipId が新 composition に存在しなければ最初の clip にフォールバック
    const exists = editor.composition.clips.find((c) => c.id === editor.selectedClipId);
    if (!exists) {
      editor.selectedClipId = editor.composition.clips[0]?.id || null;
      editor.selectedClipIds = new Set(editor.selectedClipId ? [editor.selectedClipId] : []);
    } else {
      // 選択集合のうち、存在しない id は外す
      editor.selectedClipIds = new Set(
        Array.from(editor.selectedClipIds).filter((id) => editor.composition.clips.some((c) => c.id === id)),
      );
    }
    els.compositionNameInput.value = editor.composition.name || "";
    els.backgroundTransparent.checked = !!editor.composition.background?.transparent;
    mountBackgroundSwatch();
    refreshLayerList();
    refreshParamPane();
    refreshAlignToolbar();
    redraw();
  } catch (err) {
    console.error("[title-editor] restore failed", err);
  }
}

function undo() {
  // pending 中の record があれば先に flush
  if (_historyTimer) { clearTimeout(_historyTimer); _historyTimer = null; }
  if (editor.history.pointer <= 0) return;
  editor.history.pointer -= 1;
  const snap = editor.history.stack[editor.history.pointer];
  if (snap) _restoreFromSnapshot(snap);
}

function redo() {
  if (_historyTimer) { clearTimeout(_historyTimer); _historyTimer = null; }
  if (editor.history.pointer >= editor.history.stack.length - 1) return;
  editor.history.pointer += 1;
  const snap = editor.history.stack[editor.history.pointer];
  if (snap) _restoreFromSnapshot(snap);
}

function redraw() {
  if (!editor.composition) return;
  // 背景透明モードでも編集中はチェッカー柄で「透明領域」を見せたいが、MVP では
  // 背景色をそのまま描画する (= ユーザーが背景色を選んだ色でプレビュー)。書き出し時のみ
  // overrideTransparent=true で透過 PNG として出す。
  drawComposition(els.canvas, editor.composition, {
    selectedClipId: editor.selectedClipId,
    selectedClipIds: editor.selectedClipIds,
    snapGuides: editor.snapGuides,
    showGuides: true,
  });
  els.canvasInfo.textContent = `${editor.composition.width} × ${editor.composition.height}`;
  // ドラッグ中はスナップガイドの揺らぎで履歴が膨れるので、pointer up 後にのみ
  // 履歴を積む方が綺麗。ただし debounce 250ms + 重複 snap スキップで概ね問題ない。
  // ドラッグ中の中間 snapshot は短時間に上書きされ、最終位置だけ残る。
  if (!editor.dragging) scheduleRecordHistory();
}

// ---------------------------------------------------------------------------
// 全体 bind
// ---------------------------------------------------------------------------
function bindEvents() {
  els.compositionNameInput.addEventListener("input", () => {
    if (editor.composition) editor.composition.name = els.compositionNameInput.value;
  });
  els.compositionPicker.addEventListener("change", () => {
    const id = els.compositionPicker.value;
    if (id) openComposition(id);
  });
  els.newCompositionButton.addEventListener("click", () => newComposition());
  els.saveCompositionButton.addEventListener("click", () => saveComposition());
  els.deleteCompositionButton.addEventListener("click", () => deleteComposition());
  els.exportPngButton.addEventListener("click", () => exportPng());

  els.backgroundTransparent.addEventListener("change", () => {
    if (editor.composition) {
      editor.composition.background.transparent = els.backgroundTransparent.checked;
      redraw();
    }
  });

  els.addLayerButton.addEventListener("click", () => addLayer());
  els.duplicateLayerButton?.addEventListener("click", () => duplicateLayer());
  els.deleteLayerButton.addEventListener("click", () => deleteLayer());
  els.moveLayerUpButton.addEventListener("click", () => moveLayer(+1));   // 「上」= 手前 (配列後方)
  els.moveLayerDownButton.addEventListener("click", () => moveLayer(-1)); // 「下」= 奥 (配列前方)

  // 整列ツールバー
  if (els.alignToolbar) {
    for (const btn of els.alignToolbar.querySelectorAll("button[data-align]")) {
      btn.addEventListener("click", () => alignSelected(btn.dataset.align));
    }
  }

  bindPointerOnCanvas();

  // キーボードショートカット
  document.addEventListener("keydown", (ev) => {
    // 入力中 (input / textarea / select) は Undo/Redo / Shift+D 等を取りに行かない
    const tag = ev.target?.tagName;
    const isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const metaOrCtrl = ev.metaKey || ev.ctrlKey;
    if (metaOrCtrl && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      saveComposition();
      return;
    }
    if (metaOrCtrl && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
      if (isTyping) return;     // textarea のネイティブ undo に任せる
      ev.preventDefault();
      undo();
      return;
    }
    if ((metaOrCtrl && ev.key.toLowerCase() === "z" && ev.shiftKey)
        || (metaOrCtrl && ev.key.toLowerCase() === "y")) {
      if (isTyping) return;
      ev.preventDefault();
      redo();
      return;
    }
    // 全体設定で配線されたショートカットを引き当てる
    // (= 編集画面と同じ「duplicateSelection」「deleteSelection」を共通化)
    if (isTyping) return;
    const actions = resolveShortcutAction(ev);
    if (actions.includes("duplicateSelection")) {
      ev.preventDefault();
      duplicateLayer();
      return;
    }
    if (actions.includes("deleteSelection")) {
      ev.preventDefault();
      deleteLayer();
      return;
    }
  });
}

init();
