// キャラの「体の変形」エディタ (dev_docs/plans/character-deform.md)。
//
// キャラ詳細ダイアログには概要と「変形を編集…」ボタンだけを置き、編集は大きな専用ダイアログ
// (characterDeformDialog) で行う。「反映して閉じる」で値を持ち帰り、キャラ詳細の「保存」で確定。
// 「キャンセル」/ Esc は開いたときの状態に戻す。
//
// 絵は WebGL で描き、本番と同じキャラ材質 + 変形シェーダー (renderer/effects/char-deform.js) を
// 通すので、「試しに動かす」の見た目は実際の描画と一致する。線・ピンは上に重ねた 2D キャンバス。
//
//   伸縮範囲: 基準線 (腰) / 上端 (首) の横線をドラッグ。deform.stretch (比率) に保存。
//   揺れピン: 何も無い所をクリックで追加、ピンをドラッグで移動、選択中のピンのつまみで大きさ。
//             Shift / ⌘ クリックで複数選択し、欄の値を選択中すべてに入れる。deform.pins (最大 16)。
//
// 表示: view = { zoom, cx, cy }。cx / cy は絵の中心を原点にした絵の px (表示の中心)。
//   画面倍率 s = fitScale × zoom。ピンチ / Ctrl(⌘)+ホイールで拡大縮小、2 本指スクロール /
//   スペース+ドラッグ / 中ボタンドラッグで移動。

import * as THREE from "three";

import { elements } from "./elements.js";
import { createCharacterMaterial } from "./renderer/effects/character-material.js";
import {
  CHAR_DEFORM_MAX_PINS,
  createDeformablePlaneGeometry,
  resolveStretchRegion,
  applyStretchToMaterials,
  resolveSwayPins,
  applySwayPinsToMaterial,
  applySwayTimeToMaterials,
} from "./renderer/effects/char-deform.js";

const DEFAULT_STRETCH = { anchorY: 1, topY: null, volume: 0.5 };
const HIT_PX = 12;
const RING_HIT_PX = 8;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 16;
const SWAY_COLOR_FALLBACK = "#3b82f6";
const FIXED_COLOR = "#e5484d";
const MIXED = "__mixed__";

const editor = {
  mode: "stretch",      // "stretch" | "pins"
  stretch: { ...DEFAULT_STRETCH },
  pins: [],
  selected: new Set(),  // 選択中のピン id
  primaryId: null,      // 最後に触ったピン (大きさのつまみを出す)
  loaded: "",           // 読み込んだ時点の deform (JSON)。未保存の変更の判定用
  snapshot: null,       // 編集ダイアログを開いた時点の状態 (キャンセルで戻す)
  characterName: "",
  image: null,          // 合成済みのキャラ絵 (offscreen canvas)
  imageState: "none",   // "loading" | "ready" | "failed" | "none"
  loadToken: 0,
  view: { zoom: 1, cx: 0, cy: 0 },
  dragging: null,
  spaceDown: false,
  animating: false,
  animStart: 0,
  rafId: 0,
  gl: null,             // { renderer, scene, camera, mesh, material, texture, w, h }
  resizeObserver: null,
};

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function pct(v) {
  return Math.round(v * 1000) / 10;
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ---- 絵の読み込み ----------------------------------------------------------

function layerUrl(path) {
  if (!path) return null;
  return encodeURI(path.startsWith("/") ? path : `/assets/${path}`);
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// 後ろ髪 → ベース → 前髪 を重ねた絵を作る (どれも同じキャンバスサイズの PNG/AVIF)。
async function composeCharacterImage(character) {
  const pick = (list, id) => (list || []).find((item) => item.id === id) || (list || [])[0] || null;
  const defaults = character.defaults || {};
  const layers = [
    pick(character.backHairs),
    pick(character.bases, defaults.baseId),
    pick(character.bangs),
  ].filter(Boolean);
  const images = (await Promise.all(layers.map((item) => loadImage(layerUrl(item.path))))).filter(Boolean);
  if (!images.length) return null;
  const w = images[0].naturalWidth;
  const h = images[0].naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  for (const img of images) ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

// ---- 表示 (拡大縮小・移動) --------------------------------------------------

function stageSize() {
  const stage = elements.characterDeformStage;
  return { w: Math.max(1, stage?.clientWidth || 1), h: Math.max(1, stage?.clientHeight || 1) };
}

function imageSize() {
  return { iw: editor.image?.width || 1, ih: editor.image?.height || 1 };
}

function fitScale() {
  const { w, h } = stageSize();
  const { iw, ih } = imageSize();
  return Math.min(w / iw, h / ih) * 0.94;
}

function viewScale() {
  return fitScale() * editor.view.zoom;
}

// 比率 (0..1、左上原点) → 画面 px
function toScreen(rx, ry) {
  const { w, h } = stageSize();
  const { iw, ih } = imageSize();
  const s = viewScale();
  return [w / 2 + ((rx - 0.5) * iw - editor.view.cx) * s, h / 2 + ((ry - 0.5) * ih - editor.view.cy) * s];
}

// 画面 px → 比率
function toRatio(sx, sy) {
  const { w, h } = stageSize();
  const { iw, ih } = imageSize();
  const s = viewScale();
  return [(editor.view.cx + (sx - w / 2) / s) / iw + 0.5, (editor.view.cy + (sy - h / 2) / s) / ih + 0.5];
}

function setZoom(zoom, anchor = null) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  if (anchor) {
    // カーソル位置の絵の点が動かないように表示の中心をずらす。
    const { w, h } = stageSize();
    const before = viewScale();
    const ix = editor.view.cx + (anchor[0] - w / 2) / before;
    const iy = editor.view.cy + (anchor[1] - h / 2) / before;
    editor.view.zoom = next;
    const after = viewScale();
    editor.view.cx = ix - (anchor[0] - w / 2) / after;
    editor.view.cy = iy - (anchor[1] - h / 2) / after;
  } else {
    editor.view.zoom = next;
  }
  syncZoomLabel();
  draw();
}

function fitView() {
  editor.view = { zoom: 1, cx: 0, cy: 0 };
  syncZoomLabel();
  draw();
}

function syncZoomLabel() {
  if (elements.characterDeformZoomLabel) {
    // 絵の実寸に対する表示倍率
    elements.characterDeformZoomLabel.textContent = `${Math.round(viewScale() * 100)}%`;
  }
}

// ---- WebGL (本番と同じ材質 + 変形) -----------------------------------------

function ensureGl() {
  const canvas = elements.characterDeformGlCanvas;
  if (!canvas || !editor.image) return null;
  const img = editor.image;
  if (!editor.gl) {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch (err) {
      console.warn("[deform-editor] WebGL を初期化できません", err);
      return null;
    }
    renderer.setClearColor(0x000000, 0);
    editor.gl = { renderer, scene: new THREE.Scene(), camera: null, mesh: null, material: null, texture: null, w: 0, h: 0 };
  }
  const gl = editor.gl;
  if (gl.texture?.image !== img) {
    // 絵が変わったら板を作り直す (板のサイズ = 絵のサイズ、ローカル座標の単位は絵の px)。
    if (gl.mesh) {
      gl.scene.remove(gl.mesh);
      gl.mesh.geometry.dispose();
      gl.material.dispose();
      gl.texture.dispose();
    }
    const texture = new THREE.CanvasTexture(img);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false; // 本番 (texture-cache.js) と同じ: Y-down カメラと組み合わせる
    const material = createCharacterMaterial(texture, null);
    const mesh = new THREE.Mesh(createDeformablePlaneGeometry(img.width, img.height, true), material);
    mesh.frustumCulled = false;
    gl.scene.add(mesh);
    gl.camera = new THREE.OrthographicCamera(-1, 1, -1, 1, -10, 10);
    Object.assign(gl, { mesh, material, texture, w: img.width, h: img.height });
  }
  return gl;
}

// t: 経過秒。stretchLift: 上端が動く量 (絵の高さ比、+ で伸びる)。sway: 揺れピンを動かすか。
function renderGl({ t = 0, stretchLift = 0, sway = false } = {}) {
  const gl = ensureGl();
  if (!gl) return;
  const { w, h } = stageSize();
  gl.renderer.setPixelRatio(window.devicePixelRatio || 1);
  gl.renderer.setSize(w, h, false);
  // Y-down の正射影 (本番と同じ向き)。表示の中心と倍率に合わせる。
  const s = viewScale();
  const { cx, cy } = editor.view;
  Object.assign(gl.camera, {
    left: cx - w / (2 * s), right: cx + w / (2 * s), top: cy - h / (2 * s), bottom: cy + h / (2 * s),
  });
  gl.camera.updateProjectionMatrix();
  const region = resolveStretchRegion(editor.stretch, gl.h);
  applyStretchToMaterials([gl.material], region, -stretchLift * gl.h);
  applySwayPinsToMaterial(gl.material, resolveSwayPins(editor.pins, gl.w, gl.h));
  applySwayTimeToMaterials([gl.material], t, sway ? 1 : 0);
  gl.renderer.render(gl.scene, gl.camera);
}

// ---- 重ね描き (線・ピン) ---------------------------------------------------

function prepareOverlay() {
  const canvas = elements.characterDeformCanvas;
  if (!canvas) return null;
  const { w, h } = stageSize();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawStretchOverlay(ctx, w, h) {
  const stretch = editor.stretch;
  const accent = cssVar("--accent", SWAY_COLOR_FALLBACK);
  const [left] = toScreen(0, 0);
  const [right] = toScreen(1, 0);
  const x0 = Math.max(0, left);
  const x1 = Math.min(w, right);
  const anchorPx = toScreen(0, stretch.anchorY)[1];
  const hasTop = stretch.topY != null;
  const topPx = toScreen(0, hasTop ? stretch.topY : 0)[1];
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(x0, topPx, x1 - x0, Math.max(0, anchorPx - topPx));
  ctx.globalAlpha = 1;
  // ラベルは 基準線 = 線の下、上端 = 線の上 に出す (線が近くても重ならない)。
  const line = (y, label, dashed, below) => {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.restore();
    ctx.font = "bold 12px sans-serif";
    const tw = ctx.measureText(label).width;
    const ly = Math.min(h - 4, Math.max(16, below ? y + 18 : y - 5));
    ctx.fillStyle = accent;
    ctx.fillRect(x0 + 2, ly - 13, tw + 10, 17);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x0 + 7, ly);
  };
  line(anchorPx, `基準線（腰） ${pct(stretch.anchorY)}%`, false, true);
  if (hasTop) line(topPx, `上端（首） ${pct(stretch.topY)}%`, true, false);
}

function drawPinsOverlay(ctx) {
  const accent = cssVar("--accent", SWAY_COLOR_FALLBACK);
  const { ih } = imageSize();
  const s = viewScale();
  for (const pin of editor.pins) {
    const selected = editor.selected.has(pin.id);
    const fixed = pin.kind === "fixed";
    const color = fixed ? FIXED_COLOR : accent;
    const [cx, cy] = toScreen(pin.x, pin.y);
    const r = pin.radius * ih * s;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    if (fixed) ctx.setLineDash([6, 4]);
    ctx.globalAlpha = selected ? 0.22 : 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    if (fixed) {
      ctx.fillRect(cx - 5, cy - 5, 10, 10); // 固定ピン = 中心に四角
    } else {
      // 揺れピン = 中心の点 + 揺れる向きの両矢印 (振れ幅の分)
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      const a = (pin.angleDeg * Math.PI) / 180;
      const len = Math.max(10, pin.amount * r);
      const dx = Math.cos(a) * len;
      const dy = Math.sin(a) * len;
      ctx.beginPath();
      ctx.moveTo(cx - dx, cy - dy);
      ctx.lineTo(cx + dx, cy + dy);
      for (const sgn of [1, -1]) {
        const tx = cx + sgn * dx;
        const ty = cy + sgn * dy;
        const back = a + (sgn > 0 ? Math.PI : 0);
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + Math.cos(back + 0.5) * 7, ty + Math.sin(back + 0.5) * 7);
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + Math.cos(back - 0.5) * 7, ty + Math.sin(back - 0.5) * 7);
      }
      ctx.stroke();
    }
    if (pin.id === editor.primaryId && selected) {
      // 大きさを変えるつまみ (円の右端)
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx + r, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

function draw() {
  renderGl();
  const overlay = prepareOverlay();
  if (!overlay) return;
  const { ctx, w, h } = overlay;
  if (!editor.image) {
    ctx.fillStyle = cssVar("--fg-faint", "#999");
    ctx.font = "13px sans-serif";
    ctx.fillText(editor.imageState === "loading" ? "キャラの絵を読み込み中…" : "キャラの絵を読み込めませんでした", 12, 24);
    return;
  }
  if (editor.mode === "stretch") drawStretchOverlay(ctx, w, h);
  else drawPinsOverlay(ctx);
}

// ---- 入力欄 -----------------------------------------------------------------

function selectedPins() {
  return editor.pins.filter((pin) => editor.selected.has(pin.id));
}

function syncStretchInputs() {
  const s = editor.stretch;
  if (elements.characterDeformAnchor) elements.characterDeformAnchor.value = String(pct(s.anchorY));
  const hasTop = s.topY != null;
  if (elements.characterDeformTopEnabled) elements.characterDeformTopEnabled.checked = hasTop;
  if (elements.characterDeformTop) {
    elements.characterDeformTop.disabled = !hasTop;
    elements.characterDeformTop.value = hasTop ? String(pct(s.topY)) : "";
  }
  if (elements.characterDeformVolume) elements.characterDeformVolume.value = String(Math.round(s.volume * 100));
}

// 選択中の値が揃っていればその値、ばらばらなら空欄 (placeholder「混在」)。
function sharedValue(pins, read) {
  if (!pins.length) return "";
  const first = read(pins[0]);
  return pins.every((pin) => read(pin) === first) ? String(first) : null;
}

function setField(el, value) {
  if (!el) return;
  el.value = value == null ? "" : value;
  el.placeholder = value == null ? "混在" : "";
}

function syncKindSelect(pins) {
  const select = elements.characterDeformPinKind;
  if (!select) return;
  select.querySelector(`option[value="${MIXED}"]`)?.remove();
  const kind = sharedValue(pins, (pin) => pin.kind);
  if (kind == null) {
    // 同値の再選択で change が出ないので、混在中は先頭に「混在」を置いてそれを選ぶ。
    const opt = document.createElement("option");
    opt.value = MIXED;
    opt.textContent = "— 混在 —";
    select.prepend(opt);
    select.value = MIXED;
  } else {
    select.value = kind || "sway";
  }
}

function syncPinInputs() {
  const pins = selectedPins();
  if (elements.characterDeformPinFields) elements.characterDeformPinFields.disabled = !pins.length;
  if (elements.characterDeformPinSelectionLabel) {
    elements.characterDeformPinSelectionLabel.textContent = pins.length > 1
      ? `選択中のピン（${pins.length} 本をまとめて変更）`
      : "選択中のピン";
  }
  syncKindSelect(pins);
  setField(elements.characterDeformPinRadius, sharedValue(pins, (pin) => pct(pin.radius)));
  setField(elements.characterDeformPinAmount, sharedValue(pins, (pin) => Math.round(pin.amount * 100)));
  setField(elements.characterDeformPinAngle, sharedValue(pins, (pin) => Math.round(pin.angleDeg)));
  setField(elements.characterDeformPinPeriod, sharedValue(pins, (pin) => pin.periodSec));
  setField(elements.characterDeformPinPhase, sharedValue(pins, (pin) => Math.round(pin.phase * 100)));
  // 固定ピンしか選んでいなければ、揺れ方の欄は使わない。
  const allFixed = pins.length > 0 && pins.every((pin) => pin.kind === "fixed");
  for (const el of [
    elements.characterDeformPinAmount,
    elements.characterDeformPinAngle,
    elements.characterDeformPinPeriod,
    elements.characterDeformPinPhase,
    elements.characterDeformPinSpreadPhase,
  ]) {
    if (el) el.disabled = !pins.length || allFixed;
  }
  if (elements.characterDeformPinCount) {
    const n = editor.pins.length;
    elements.characterDeformPinCount.textContent = `ピン ${n} / ${CHAR_DEFORM_MAX_PINS}`;
    elements.characterDeformPinCount.classList.toggle("is-full", n >= CHAR_DEFORM_MAX_PINS);
  }
}

function syncMode() {
  for (const button of elements.characterDeformModeButtons || []) {
    const active = button.dataset.deformMode === editor.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  for (const panel of elements.characterDeformPanels || []) {
    panel.hidden = panel.dataset.deformPanel !== editor.mode;
  }
}

function setStretch(next) {
  const s = { ...editor.stretch, ...next };
  s.anchorY = clamp01(Number(s.anchorY));
  s.volume = clamp01(Number(s.volume));
  if (s.topY != null) {
    // 上端は基準線より 2% 以上上に置く
    s.topY = Math.min(clamp01(Number(s.topY)), Math.max(0, s.anchorY - 0.02));
  }
  editor.stretch = s;
  syncStretchInputs();
  draw();
}

function clampPin(pin) {
  pin.x = clamp01(pin.x);
  pin.y = clamp01(pin.y);
  pin.radius = Math.max(0.005, Math.min(0.6, Number(pin.radius) || 0.08));
  pin.amount = Math.max(0, Math.min(0.4, Number(pin.amount) || 0));
  pin.angleDeg = Math.max(-360, Math.min(360, Number(pin.angleDeg) || 0));
  pin.periodSec = Math.max(0.2, Math.min(20, Number(pin.periodSec) || 2));
  pin.phase = clamp01(Number(pin.phase) || 0);
}

// 選択中のピンすべてに同じ値を入れる (一括変更)。
function updateSelectedPins(patch) {
  for (const pin of selectedPins()) {
    Object.assign(pin, patch);
    clampPin(pin);
  }
  syncPinInputs();
  draw();
}

function selectOnly(id) {
  editor.selected = new Set(id ? [id] : []);
  editor.primaryId = id || null;
}

function addPin(rx, ry) {
  if (editor.pins.length >= CHAR_DEFORM_MAX_PINS) return null;
  const kind = elements.characterDeformPinAddKind?.value === "fixed" ? "fixed" : "sway";
  const n = editor.pins.length;
  const pin = {
    id: `pin_${Date.now().toString(36)}_${n}`,
    kind,
    x: clamp01(rx),
    y: clamp01(ry),
    // 画面上でおよそ 80px (固定ピンは少し大きめ) になる大きさで置く。拡大して髪先に
    // 打つときは小さく、全体表示なら大きくなる。
    radius: Math.round(Math.max(0.01, Math.min(0.15, ((kind === "fixed" ? 110 : 80) / (imageSize().ih * viewScale())))) * 10000) / 10000,
    amount: 0.15,
    angleDeg: 0,
    periodSec: 2,
    // ピンごとに位相を少しずつずらして、なびくように見せる。
    phase: Math.round(((n * 0.17) % 1) * 1000) / 1000,
  };
  editor.pins.push(pin);
  selectOnly(pin.id);
  syncPinInputs();
  return pin;
}

function deleteSelectedPins() {
  if (!editor.selected.size) return;
  editor.pins = editor.pins.filter((pin) => !editor.selected.has(pin.id));
  selectOnly(null);
  syncPinInputs();
  draw();
}

// 選択中の揺れピンの位相を、上から順に少しずつずらす (上が先に揺れ、下ほど遅れる)。
function spreadPhase() {
  const pins = selectedPins().filter((pin) => pin.kind !== "fixed")
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  pins.forEach((pin, i) => { pin.phase = Math.round(((i * 0.12) % 1) * 1000) / 1000; });
  syncPinInputs();
  draw();
}

// ---- ポインタ ---------------------------------------------------------------

function pointerPos(event) {
  const rect = elements.characterDeformCanvas.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const [rx, ry] = toRatio(sx, sy);
  return { sx, sy, rx, ry };
}

// 掴める対象: 主選択ピンのつまみ → いずれかのピンの縁 → ピンの内側 (小さい円を優先)。
function hitPin(pos) {
  const { ih } = imageSize();
  const s = viewScale();
  const ring = [];
  const inside = [];
  for (const pin of editor.pins) {
    const [cx, cy] = toScreen(pin.x, pin.y);
    const r = pin.radius * ih * s;
    const d = Math.hypot(pos.sx - cx, pos.sy - cy);
    if (pin.id === editor.primaryId && editor.selected.has(pin.id)
      && Math.hypot(pos.sx - (cx + r), pos.sy - cy) <= RING_HIT_PX + 2) {
      return { pin, kind: "radius" };
    }
    if (Math.abs(d - r) <= RING_HIT_PX && r > RING_HIT_PX * 2) ring.push({ pin, r });
    if (d < r) inside.push({ pin, r });
  }
  if (inside.length) {
    const pin = inside.sort((a, b) => a.r - b.r)[0].pin;
    // 縁の近くを掴んだら大きさ、内側なら移動
    const onRing = ring.find((item) => item.pin === pin);
    return { pin, kind: onRing ? "radius" : "move" };
  }
  if (ring.length) return { pin: ring.sort((a, b) => a.r - b.r)[0].pin, kind: "radius" };
  return null;
}

function onPointerDown(event) {
  if (editor.animating) stopAnimation();
  const canvas = elements.characterDeformCanvas;
  elements.characterDeformStage?.focus({ preventScroll: true });
  const pos = pointerPos(event);
  canvas.setPointerCapture(event.pointerId);
  // 表示の移動: 中ボタン / スペース+ドラッグ
  if (event.button === 1 || editor.spaceDown) {
    event.preventDefault();
    editor.dragging = { kind: "pan", sx: pos.sx, sy: pos.sy, cx: editor.view.cx, cy: editor.view.cy };
    canvas.style.cursor = "grabbing";
    return;
  }
  if (event.button !== 0) return;
  if (editor.mode === "stretch") {
    const s = editor.stretch;
    const dAnchor = Math.abs(pos.sy - toScreen(0, s.anchorY)[1]);
    const dTop = s.topY != null ? Math.abs(pos.sy - toScreen(0, s.topY)[1]) : Infinity;
    // 近い方の線を掴む (線から離れた所を押したら、近い方の線をそこへ動かす)。
    editor.dragging = { kind: dTop < dAnchor ? "top" : "anchor" };
    setStretch(editor.dragging.kind === "top" ? { topY: pos.ry } : { anchorY: pos.ry });
    return;
  }
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  const hit = hitPin(pos);
  if (hit && additive) {
    // 選択に足す / 外す (ドラッグはしない)
    if (editor.selected.has(hit.pin.id)) {
      editor.selected.delete(hit.pin.id);
      if (editor.primaryId === hit.pin.id) editor.primaryId = [...editor.selected].pop() || null;
    } else {
      editor.selected.add(hit.pin.id);
      editor.primaryId = hit.pin.id;
    }
    syncPinInputs();
    draw();
    return;
  }
  if (!hit && additive) return;
  let pin = hit?.pin;
  let kind = hit?.kind || "move";
  if (!pin) {
    pin = addPin(pos.rx, pos.ry);
    kind = "move";
    if (!pin) {
      draw();
      return;
    }
  } else if (!editor.selected.has(pin.id)) {
    selectOnly(pin.id);
  } else {
    editor.primaryId = pin.id;
  }
  // 移動は選択中のピンをまとめて動かす。大きさは掴んだピンだけ。
  editor.dragging = {
    kind,
    pinId: pin.id,
    startRx: pos.rx,
    startRy: pos.ry,
    origins: selectedPins().map((item) => ({ pin: item, x: item.x, y: item.y })),
  };
  syncPinInputs();
  draw();
}

function onPointerMove(event) {
  const canvas = elements.characterDeformCanvas;
  const pos = pointerPos(event);
  const drag = editor.dragging;
  if (drag) {
    if (drag.kind === "pan") {
      const s = viewScale();
      editor.view.cx = drag.cx - (pos.sx - drag.sx) / s;
      editor.view.cy = drag.cy - (pos.sy - drag.sy) / s;
      draw();
    } else if (drag.kind === "anchor" || drag.kind === "top") {
      setStretch(drag.kind === "top" ? { topY: pos.ry } : { anchorY: pos.ry });
    } else if (drag.kind === "move") {
      const dx = pos.rx - drag.startRx;
      const dy = pos.ry - drag.startRy;
      for (const { pin, x, y } of drag.origins) {
        pin.x = x + dx;
        pin.y = y + dy;
        clampPin(pin);
      }
      draw();
    } else {
      const pin = editor.pins.find((item) => item.id === drag.pinId);
      if (pin) {
        const { iw, ih } = imageSize();
        const d = Math.hypot((pos.rx - pin.x) * iw, (pos.ry - pin.y) * ih);
        pin.radius = d / ih;
        clampPin(pin);
        syncPinInputs();
        draw();
      }
    }
    return;
  }
  if (editor.spaceDown) {
    canvas.style.cursor = "grab";
  } else if (editor.mode === "stretch") {
    const s = editor.stretch;
    const near = Math.abs(pos.sy - toScreen(0, s.anchorY)[1]) <= HIT_PX
      || (s.topY != null && Math.abs(pos.sy - toScreen(0, s.topY)[1]) <= HIT_PX);
    canvas.style.cursor = near ? "ns-resize" : "pointer";
  } else {
    const hit = hitPin(pos);
    canvas.style.cursor = hit ? (hit.kind === "radius" ? "ew-resize" : "move") : "crosshair";
  }
}

function onPointerUp() {
  const wasMove = editor.dragging?.kind === "move";
  editor.dragging = null;
  if (wasMove) syncPinInputs();
  elements.characterDeformCanvas.style.cursor = editor.spaceDown ? "grab" : "";
}

// ピンチ (ctrlKey 付きの wheel) / Ctrl(⌘)+ホイール = 拡大縮小、それ以外のスクロール = 表示の移動。
function onWheel(event) {
  event.preventDefault();
  const rect = elements.characterDeformCanvas.getBoundingClientRect();
  const anchor = [event.clientX - rect.left, event.clientY - rect.top];
  if (event.ctrlKey || event.metaKey) {
    setZoom(editor.view.zoom * Math.exp(-event.deltaY * 0.0025), anchor);
    return;
  }
  const s = viewScale();
  editor.view.cx += event.deltaX / s;
  editor.view.cy += event.deltaY / s;
  draw();
}

function onKeyDown(event) {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName || "");
  if (event.code === "Space" && !typing) {
    event.preventDefault();
    editor.spaceDown = true;
    elements.characterDeformCanvas.style.cursor = "grab";
    return;
  }
  if (typing || editor.mode !== "pins") return;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelectedPins();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    editor.selected = new Set(editor.pins.map((pin) => pin.id));
    editor.primaryId = editor.pins[editor.pins.length - 1]?.id || null;
    syncPinInputs();
    draw();
  }
}

function onKeyUp(event) {
  if (event.code === "Space") {
    editor.spaceDown = false;
    if (!editor.dragging) elements.characterDeformCanvas.style.cursor = "";
  }
}

// ---- 試しに動かす -----------------------------------------------------------

function setPlayButtonLabel() {
  const button = elements.characterDeformPlayButton;
  if (!button) return;
  const label = button.querySelector("[data-label]");
  const icon = button.querySelector(".msym");
  if (label) label.textContent = editor.animating ? "止める" : "試しに動かす";
  if (icon) icon.textContent = editor.animating ? "stop" : "play_arrow";
}

// 伸縮範囲: 120 BPM のなめらかな跳ね。範囲が分かれば十分なので控えめ (上端が絵の高さの
// 2% 動く程度)。実際の大きさはカット側の振幅で決まる。
// 揺れピン: キャラ定義どおりの振れ幅 (= カット側の強さ 100%) で揺らす。
function startAnimation() {
  editor.animating = true;
  editor.animStart = performance.now();
  setPlayButtonLabel();
  prepareOverlay(); // 動かしている間は線・ピンを消して絵だけ見せる
  const tick = (now) => {
    if (!editor.animating) return;
    const t = (now - editor.animStart) / 1000;
    if (editor.mode === "stretch") {
      const p = ((t / 0.5) % 1 + 1) % 1;
      renderGl({ stretchLift: Math.sin(Math.PI * p) * 0.02 });
    } else {
      renderGl({ t, sway: true });
    }
    editor.rafId = requestAnimationFrame(tick);
  };
  editor.rafId = requestAnimationFrame(tick);
}

function stopAnimation() {
  if (!editor.animating) return;
  editor.animating = false;
  cancelAnimationFrame(editor.rafId);
  setPlayButtonLabel();
  draw();
}

// ---- 概要 (キャラ詳細ダイアログ) -------------------------------------------

function updateSummary() {
  const el = elements.characterDeformSummary;
  if (!el) return;
  const parts = [];
  const s = editor.stretch;
  if (s.anchorY >= 1 && s.topY == null) {
    parts.push("伸縮範囲: 既定（足元基準で全身）");
  } else {
    parts.push(`伸縮範囲: 基準線 ${pct(s.anchorY)}%${s.topY != null ? ` / 上端 ${pct(s.topY)}%` : ""}`);
  }
  const sway = editor.pins.filter((pin) => pin.kind !== "fixed").length;
  const fixed = editor.pins.length - sway;
  parts.push(editor.pins.length ? `揺れピン ${sway} 本・固定ピン ${fixed} 本` : "揺れピンなし");
  el.textContent = parts.join("　");
  if (JSON.stringify(collectCharacterDeform()) !== editor.loaded) {
    const dirty = document.createElement("span");
    dirty.className = "is-dirty";
    dirty.textContent = "（未保存の変更あり）";
    el.append(" ", dirty);
  }
}

// ---- 編集ダイアログの開閉 ---------------------------------------------------

function cloneState() {
  return { stretch: { ...editor.stretch }, pins: editor.pins.map((pin) => ({ ...pin })) };
}

function openDeformDialog() {
  const dialog = elements.characterDeformDialog;
  if (!dialog) return;
  editor.snapshot = cloneState();
  if (elements.characterDeformHeading) {
    elements.characterDeformHeading.textContent = editor.characterName
      ? `${editor.characterName} の体の変形`
      : "体の変形";
  }
  syncMode();
  syncStretchInputs();
  syncPinInputs();
  dialog.showModal();
  // 開いてからでないとステージの大きさが取れない。
  requestAnimationFrame(() => {
    fitView();
    elements.characterDeformStage?.focus({ preventScroll: true });
  });
}

function closeDeformDialog({ apply }) {
  stopAnimation();
  if (!apply && editor.snapshot) {
    editor.stretch = editor.snapshot.stretch;
    editor.pins = editor.snapshot.pins;
    selectOnly(editor.pins[0]?.id || null);
  }
  editor.snapshot = null;
  editor.spaceDown = false;
  if (elements.characterDeformDialog?.open) elements.characterDeformDialog.close();
  updateSummary();
}

// ---- イベント登録 -----------------------------------------------------------

function bindNumber(el, apply) {
  el?.addEventListener("input", () => {
    if (el.value === "") return;
    const v = Number(el.value);
    if (Number.isFinite(v)) apply(v);
  });
}

function bindEditorEvents() {
  const canvas = elements.characterDeformCanvas;
  if (!canvas || canvas.dataset.bound === "1") return;
  canvas.dataset.bound = "1";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("auxclick", (event) => event.preventDefault());
  elements.characterDeformDialog?.addEventListener("keydown", onKeyDown);
  elements.characterDeformDialog?.addEventListener("keyup", onKeyUp);
  if (elements.characterDeformStage && "ResizeObserver" in window) {
    editor.resizeObserver = new ResizeObserver(() => {
      if (elements.characterDeformDialog?.open) {
        syncZoomLabel();
        draw();
      }
    });
    editor.resizeObserver.observe(elements.characterDeformStage);
  }

  for (const button of elements.characterDeformModeButtons || []) {
    button.addEventListener("click", () => {
      stopAnimation();
      editor.mode = button.dataset.deformMode === "pins" ? "pins" : "stretch";
      syncMode();
      draw();
    });
  }
  elements.characterDeformZoomIn?.addEventListener("click", () => setZoom(editor.view.zoom * 1.25));
  elements.characterDeformZoomOut?.addEventListener("click", () => setZoom(editor.view.zoom / 1.25));
  elements.characterDeformZoomFit?.addEventListener("click", fitView);

  bindNumber(elements.characterDeformAnchor, (v) => setStretch({ anchorY: v / 100 }));
  bindNumber(elements.characterDeformTop, (v) => setStretch({ topY: v / 100 }));
  elements.characterDeformTopEnabled?.addEventListener("change", () => {
    const on = elements.characterDeformTopEnabled.checked;
    // 立ち絵の首はおおむね上から 15〜20% あたり。基準線がそれより上なら基準線の少し上。
    setStretch({ topY: on ? Math.max(0, Math.min(0.18, editor.stretch.anchorY - 0.05)) : null });
  });
  bindNumber(elements.characterDeformVolume, (v) => setStretch({ volume: v / 100 }));
  elements.characterDeformResetButton?.addEventListener("click", () => {
    stopAnimation();
    setStretch({ ...DEFAULT_STRETCH });
  });

  elements.characterDeformPinKind?.addEventListener("change", () => {
    const value = elements.characterDeformPinKind.value;
    if (value === MIXED) return;
    updateSelectedPins({ kind: value === "fixed" ? "fixed" : "sway" });
  });
  bindNumber(elements.characterDeformPinRadius, (v) => updateSelectedPins({ radius: v / 100 }));
  bindNumber(elements.characterDeformPinAmount, (v) => updateSelectedPins({ amount: v / 100 }));
  bindNumber(elements.characterDeformPinAngle, (v) => updateSelectedPins({ angleDeg: v }));
  bindNumber(elements.characterDeformPinPeriod, (v) => updateSelectedPins({ periodSec: v }));
  bindNumber(elements.characterDeformPinPhase, (v) => updateSelectedPins({ phase: v / 100 }));
  elements.characterDeformPinSelectAll?.addEventListener("click", () => {
    editor.selected = new Set(editor.pins.map((pin) => pin.id));
    editor.primaryId = editor.pins[editor.pins.length - 1]?.id || null;
    syncPinInputs();
    draw();
  });
  elements.characterDeformPinSelectSway?.addEventListener("click", () => {
    const sway = editor.pins.filter((pin) => pin.kind !== "fixed");
    editor.selected = new Set(sway.map((pin) => pin.id));
    editor.primaryId = sway[sway.length - 1]?.id || null;
    syncPinInputs();
    draw();
  });
  elements.characterDeformPinSelectNone?.addEventListener("click", () => {
    selectOnly(null);
    syncPinInputs();
    draw();
  });
  elements.characterDeformPinSpreadPhase?.addEventListener("click", spreadPhase);
  elements.characterDeformPinDelete?.addEventListener("click", deleteSelectedPins);
  elements.characterDeformPinClear?.addEventListener("click", () => {
    if (!editor.pins.length) return;
    if (!window.confirm("揺れピンをすべて消します。よろしいですか？（キャラ詳細の「保存」を押すまでは確定しません）")) return;
    stopAnimation();
    editor.pins = [];
    selectOnly(null);
    syncPinInputs();
    draw();
  });

  elements.characterDeformPlayButton?.addEventListener("click", () => {
    if (editor.animating) stopAnimation();
    else startAnimation();
  });
  elements.openCharacterDeformButton?.addEventListener("click", openDeformDialog);
  elements.applyCharacterDeformButton?.addEventListener("click", () => closeDeformDialog({ apply: true }));
  elements.cancelCharacterDeformButton?.addEventListener("click", () => closeDeformDialog({ apply: false }));
  // Esc はキャンセル扱い (開いたときの状態に戻す)。
  elements.characterDeformDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeformDialog({ apply: false });
  });
  // キャラ詳細を閉じたら、編集ダイアログも一緒に閉じる。
  elements.characterManagerDialog?.addEventListener("close", () => {
    if (elements.characterDeformDialog?.open) closeDeformDialog({ apply: false });
  });
}

// ---- 公開 API --------------------------------------------------------------

export function loadCharacterDeformEditor(character) {
  bindEditorEvents();
  stopAnimation();
  const raw = character?.deform?.stretch;
  editor.stretch = raw
    ? {
      anchorY: clamp01(Number(raw.anchorY ?? 1)),
      topY: raw.topY == null ? null : clamp01(Number(raw.topY)),
      volume: clamp01(Number(raw.volume ?? 0.5)),
    }
    : { ...DEFAULT_STRETCH };
  editor.pins = (character?.deform?.pins || []).map((pin) => ({ ...pin }));
  selectOnly(editor.pins[0]?.id || null);
  editor.characterName = character?.name || character?.id || "";
  editor.loaded = JSON.stringify(collectCharacterDeform());
  if (elements.openCharacterDeformButton) elements.openCharacterDeformButton.disabled = !character;
  updateSummary();
  const token = ++editor.loadToken;
  editor.image = null;
  editor.imageState = character ? "loading" : "none";
  if (!character) return;
  composeCharacterImage(character).then((image) => {
    if (token !== editor.loadToken) return;
    editor.image = image;
    editor.imageState = image ? "ready" : "failed";
    if (elements.characterDeformDialog?.open) fitView();
  });
}

// 保存用。伸縮範囲が既定のまま (足元基準・上端なし・体積 50%) なら stretch は持たない。
export function collectCharacterDeform() {
  const out = {};
  const s = editor.stretch;
  const isDefault = s.anchorY >= 1 && s.topY == null && Math.abs(s.volume - 0.5) < 1e-6;
  if (!isDefault) {
    out.stretch = {
      anchorY: Math.round(s.anchorY * 10000) / 10000,
      topY: s.topY == null ? null : Math.round(s.topY * 10000) / 10000,
      volume: Math.round(s.volume * 100) / 100,
    };
  }
  if (editor.pins.length) {
    const r4 = (v) => Math.round(v * 10000) / 10000;
    out.pins = editor.pins.map((pin) => ({
      id: pin.id,
      kind: pin.kind,
      x: r4(pin.x),
      y: r4(pin.y),
      radius: r4(pin.radius),
      amount: Math.round(pin.amount * 1000) / 1000,
      angleDeg: Math.round(pin.angleDeg * 10) / 10,
      periodSec: Math.round(pin.periodSec * 100) / 100,
      phase: Math.round(pin.phase * 1000) / 1000,
    }));
  }
  return out;
}
