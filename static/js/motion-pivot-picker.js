// =============================================================================
// motion-pivot-picker.js
//
// 「移動」モーションの基準 (X, Y) ピボット指定モード。
//   - 「指定」ボタンを押すと state.motionPivotPickingMode = true に。
//     ラベルは「指定」→「決定」、ボタンに accent 色のスタイル。
//   - モード中、preview canvas のクリック / ドラッグで pivot X/Y input が更新される。
//   - pivot 位置は SVG 十字の indicator overlay で canvas 上に表示。
//   - 「決定」を再度押すとモード解除、indicator は隠れる。
//
// preview-interactions.js の通常キャラドラッグハンドラは、モード中は
// state.motionPivotPickingMode を見て早期 return する (= 共存)。
// =============================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";

let _canvasEl = null;
let _wired = false;
let _onChange = () => {};

// canvas 上の click event を 1920×1080 シーン座標に変換する。
function _clientToScene(event) {
  if (!_canvasEl) return { x: 0, y: 0 };
  const rect = _canvasEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const sx = Math.round(((event.clientX - rect.left) / rect.width) * 1920);
  const sy = Math.round(((event.clientY - rect.top) / rect.height) * 1080);
  return { x: sx, y: sy };
}

// シーン座標 → canvas 上の絶対 px (= 親 .preview-frame の中での位置)。
// indicator overlay は .preview-frame の中に置いてあるので、その内部座標で OK。
function _sceneToOverlayPx(sceneX, sceneY) {
  if (!_canvasEl) return { x: 0, y: 0 };
  const rect = _canvasEl.getBoundingClientRect();
  const parent = _canvasEl.parentElement;
  if (!parent) return { x: 0, y: 0 };
  const pRect = parent.getBoundingClientRect();
  const cx = rect.left - pRect.left + (sceneX / 1920) * rect.width;
  const cy = rect.top - pRect.top + (sceneY / 1080) * rect.height;
  return { x: cx, y: cy };
}

function _onPointerDown(event) {
  if (!state.motionPivotPickingMode) return;
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const { x, y } = _clientToScene(event);
  _writePivot(x, y);
  try { _canvasEl.setPointerCapture(event.pointerId); } catch (_e) {}
}

function _onPointerMove(event) {
  if (!state.motionPivotPickingMode) return;
  // 左ボタン押下中 (= ドラッグ) のみ追従。単なる hover では更新しない。
  if (event.buttons !== 1) return;
  const { x, y } = _clientToScene(event);
  _writePivot(x, y);
}

function _onPointerUp(event) {
  if (!state.motionPivotPickingMode) return;
  try { _canvasEl.releasePointerCapture(event.pointerId); } catch (_e) {}
}

function _writePivot(x, y) {
  if (elements.cutMotionMovePivotX) {
    elements.cutMotionMovePivotX.value = String(x);
    elements.cutMotionMovePivotX.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (elements.cutMotionMovePivotY) {
    elements.cutMotionMovePivotY.value = String(y);
    elements.cutMotionMovePivotY.dispatchEvent(new Event("input", { bubbles: true }));
  }
  _updateIndicator();
  _onChange();
}

function _updateButtonState() {
  const btn = elements.cutMotionMovePivotPickButton;
  if (!btn) return;
  const label = btn.querySelector(".motion-pivot-pick-label");
  if (state.motionPivotPickingMode) {
    btn.dataset.picking = "true";
    if (label) label.textContent = "決定";
  } else {
    btn.dataset.picking = "false";
    if (label) label.textContent = "指定";
  }
}

function _updateIndicator() {
  const indicator = elements.motionPivotIndicator;
  if (!indicator) return;
  if (!state.motionPivotPickingMode) {
    indicator.hidden = true;
    return;
  }
  const px = Number(elements.cutMotionMovePivotX?.value);
  const py = Number(elements.cutMotionMovePivotY?.value);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    indicator.hidden = true;
    return;
  }
  const { x, y } = _sceneToOverlayPx(px, py);
  indicator.style.left = `${x}px`;
  indicator.style.top = `${y}px`;
  indicator.hidden = false;
}

function _onPivotInputChange() {
  // input から手動で値が変わったとき indicator を追従させる。
  if (state.motionPivotPickingMode) _updateIndicator();
}

function _toggle() {
  state.motionPivotPickingMode = !state.motionPivotPickingMode;
  _updateButtonState();
  _updateIndicator();
  if (_canvasEl) {
    _canvasEl.style.cursor = state.motionPivotPickingMode ? "crosshair" : "";
  }
}

// 外部から強制終了 (= モード解除) するときに使う (cut 切替等で)。
export function exitMotionPivotPicking() {
  if (state.motionPivotPickingMode) {
    state.motionPivotPickingMode = false;
    _updateButtonState();
    _updateIndicator();
    if (_canvasEl) _canvasEl.style.cursor = "";
  }
}

export function bindMotionPivotPicker({ canvas, onChange }) {
  if (_wired) return;
  _canvasEl = canvas;
  _onChange = onChange || (() => {});
  if (!_canvasEl) return;
  _wired = true;

  // canvas 上の pointer event (capture phase で先取りはしない。
  // preview-interactions の handler が state.motionPivotPickingMode を見て skip する)。
  _canvasEl.addEventListener("pointerdown", _onPointerDown);
  _canvasEl.addEventListener("pointermove", _onPointerMove);
  _canvasEl.addEventListener("pointerup", _onPointerUp);
  _canvasEl.addEventListener("pointercancel", _onPointerUp);

  // 指定ボタンの toggle
  elements.cutMotionMovePivotPickButton?.addEventListener("click", _toggle);

  // input の手動編集で indicator を追従
  elements.cutMotionMovePivotX?.addEventListener("input", _onPivotInputChange);
  elements.cutMotionMovePivotY?.addEventListener("input", _onPivotInputChange);

  // ウィンドウサイズ変更で indicator 位置を再計算
  window.addEventListener("resize", _updateIndicator);

  // 初期状態を反映
  _updateButtonState();
}
