// =============================================================================
// renderer/index.js
//
// v2 (WebGL / three.js) レンダラの公開 API。
// playback.js から globalConfig.config.renderer.version === "v2" のときに
// dispatch される（全プロジェクト共通の全体設定）。
//
// 全レイヤー (bg / chars / fg / dialogue / telop / visualizer) が WebGL scene 内
// plane として組み込まれる。preview / 一時停止 / サムネ / 動画書き出しはすべて
// WebGL canvas 1 枚で完結 (旧 v1 Pillow 経路は撤去済み)。
// =============================================================================
import * as THREE from "three";
import { initRenderer, renderScene, isRendererReady, getRenderer, getCamera, isPreserveDrawingBuffer, CANVAS_WIDTH, CANVAS_HEIGHT } from "./core.js";
import { buildScene } from "./scene-builder.js";
import { renderTransitionComposite } from "./transition-composite.js";

export { initRenderer, isRendererReady, CANVAS_WIDTH, CANVAS_HEIGHT };

// R10: トランジションの「前カット最終フレーム」テクスチャ。setActiveScene で
// 切替直前の canvas (= 退場するカットの絵) をスナップショットして保持する。
let _lastFrameTexture = null;
// 直近にスナップショットを撮った供給元 (preview canvas)。export は別経路。
let _explicitFromTexture = null; // 明示指定 (export 用) があれば優先。

function _captureCanvasTexture() {
  const renderer = getRenderer();
  const src = renderer && renderer.domElement;
  if (!src || !src.width || !src.height) return null;
  try {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    return tex;
  } catch (_e) {
    return null;
  }
}

// 現在描画中の SceneInstance。loadCut 等で differ なシーンに切り替わるたびに
// dispose して作り直す (Phase B でカット切替時の差分更新に最適化予定)。
let activeSceneInstance = null;

export async function buildSceneFromLayerData(
  layerData,
  videoProvider = null,
  videoLayerProvidersById = null,
  videoLayerDurations = null,
  vlWindowKey = "",
) {
  // エフェクト (silhouette → blur) は WebGLRenderer 経由で RT に書く必要があるので、
  // 構築時に renderer を渡す (update 時に保持参照を使う)。
  // videoProvider は videoTrack の frame 取り出し抽象 (preview = VideoTextureProvider、
  // export = WebCodecsVideoProvider)。getTexture()/updateForFrame()/dispose() の
  // 3 メソッドだけを使う (renderer/video-provider.js)。
  //
  // videoLayerProvidersById は videoLayers (per-layer) 用の provider Map。
  // preview では HTMLVideoElement + VideoTextureProvider、export では
  // WebCodecsVideoProvider per-layer instance を渡す。
  // videoLayerDurations は /api/video-duration から解決した Map (fit 計算 / 終端判定用)。
  // vlWindowKey は VL 時間窓キー (A1)。SceneInstance に持たせて、setActiveScene の
  // reuse 判定で「同 token でも窓が変われば rebuild」を可能にする。
  const inst = await buildScene(
    layerData,
    getRenderer(),
    videoProvider,
    videoLayerProvidersById,
    videoLayerDurations,
  );
  if (inst) {
    inst.vlWindowKey = vlWindowKey || "";
  }
  return inst;
}

export function setActiveScene(instance) {
  if (activeSceneInstance && activeSceneInstance !== instance) {
    // R10: 切替直前の canvas (= 退場するカットの絵) をトランジション用に捕捉する。
    // preview は preserveDrawingBuffer=true なので drawImage で読める。export は
    // false で空になるため捕捉しない (export は別途 setExportFromFrame で供給予定)。
    if (!_explicitFromTexture && isPreserveDrawingBuffer()) {
      const cap = _captureCanvasTexture();
      if (cap) {
        if (_lastFrameTexture) _lastFrameTexture.dispose();
        _lastFrameTexture = cap;
      }
    }
    activeSceneInstance.dispose();
  }
  activeSceneInstance = instance;
}

// R10: export 経路から「前カット最終フレーム」テクスチャを明示供給する
// (export canvas は preserveDrawingBuffer=false で canvas 捕捉できないため)。
// null を渡すと明示供給を解除して preview の自動捕捉に戻す。
export function setExportFromFrame(tex) {
  _explicitFromTexture = tex || null;
}

// R10: export 用。現在アクティブなシーン (= このカットの最終フレーム) を RenderTarget へ
// 焼いて texture を返す。次カットのトランジション from-frame に使う。
// overlay は焼かない (素のカット画を撮る)。RT texture は v=0=画面下 → uFlipY=1 と整合。
let _exportCaptureRT = null;
export function captureActiveSceneToTexture(width, height) {
  const renderer = getRenderer();
  if (!renderer || !activeSceneInstance) return null;
  const w = Math.max(1, Math.round(width || CANVAS_WIDTH));
  const h = Math.max(1, Math.round(height || CANVAS_HEIGHT));
  if (!_exportCaptureRT || _exportCaptureRT.width !== w || _exportCaptureRT.height !== h) {
    if (_exportCaptureRT) _exportCaptureRT.dispose();
    _exportCaptureRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });
    _exportCaptureRT.texture.colorSpace = THREE.SRGBColorSpace;
  }
  const tmesh = activeSceneInstance.meshes && activeSceneInstance.meshes.transition;
  const wasVisible = tmesh ? tmesh.visible : false;
  if (tmesh) tmesh.visible = false; // overlay 自身を焼き込まない
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(_exportCaptureRT);
  renderScene(activeSceneInstance.scene);
  renderer.setRenderTarget(prevTarget);
  if (tmesh) tmesh.visible = wasVisible;
  return _exportCaptureRT.texture;
}

export function getActiveScene() {
  return activeSceneInstance;
}

// フルライブ境界またぎ: active scene を dispose せずに detach して返す。
// 退場する前カット (A) を「次カット (B) の先頭 D/2 の間」生かしておき、B-side の
// dual-RT 合成で live 描画してから (= 口パク/目パチ/モーション継続) dispose する。
export function detachActiveSceneNoDispose() {
  const inst = activeSceneInstance;
  activeSceneInstance = null;
  return inst;
}

// フルライブ境界またぎの合成描画。transition-composite に委譲。
// 前カット (from) と現カット (to) を毎フレーム両方 RT へ描画して progress で混ぜる。
export function renderSceneTransitionComposite(opts) {
  try {
    return renderTransitionComposite(opts);
  } catch (_e) {
    return false;
  }
}

// A-side 用: 指定 SceneInstance を指定 state で 1 枚 RT に焼いてテクスチャを返す。
// 次カット B の「先頭フレーム」(= 境界前はまだ始まっていないので静止が正) を捕捉して、
// 前カット A の尾で B が徐々に現れる A-side 合成に使う。RT は使い回す。
let _frameCaptureRT = null;
export function captureInstanceFrameToTexture(inst, state) {
  const renderer = getRenderer();
  if (!renderer || !inst) return null;
  const w = CANVAS_WIDTH;
  const h = CANVAS_HEIGHT;
  if (!_frameCaptureRT) {
    _frameCaptureRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });
    _frameCaptureRT.texture.colorSpace = THREE.SRGBColorSpace;
  }
  try {
    if (typeof inst.update === "function") inst.update(state || {});
  } catch (_e) { /* ignore */ }
  const tmesh = inst.meshes && inst.meshes.transition;
  const wasVisible = tmesh ? tmesh.visible : false;
  if (tmesh) tmesh.visible = false;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(_frameCaptureRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderScene(inst.scene);
  renderer.setRenderTarget(prevTarget);
  if (tmesh) tmesh.visible = wasVisible;
  return _frameCaptureRT.texture;
}

// R10: アクティブシーンのカット入りトランジション設定を反映する。
// cfg = { type, durationFrame } | null。playback / export が現在カットから渡す。
export function setActiveSceneTransition(cfg) {
  if (activeSceneInstance && typeof activeSceneInstance.setTransition === "function") {
    // export (preserveDrawingBuffer=false) では自動捕捉した preview フレームは使わず、
    // 明示供給 (setExportFromFrame) のみ。無ければ from=null → 単色フォールバック。
    const fromTex = _explicitFromTexture
      || (isPreserveDrawingBuffer() ? _lastFrameTexture : null)
      || null;
    activeSceneInstance.setTransition(cfg, fromTex);
  }
}

// 現在 active な SceneInstance の token (scene-bundle SHA1) を取り出す。
// playLiveCutV2 で「次カットの token と同じなら build を skip して再利用」する
// ための helper。一度も build していないとき / token 未指定のときは null。
export function getActiveSceneToken() {
  return activeSceneInstance?.token || null;
}

// 現在 active な SceneInstance の VL window key (A1)。reuse 判定で
// 「同 token でも窓構成が違うなら rebuild」するのに使う。空文字は「窓 = 空」。
export function getActiveVlWindowKey() {
  return activeSceneInstance?.vlWindowKey || "";
}

export function disposeActiveScene() {
  if (activeSceneInstance) {
    activeSceneInstance.dispose();
    activeSceneInstance = null;
  }
  // ★ canvas framebuffer もクリアする。preserveDrawingBuffer=true (core.js) のため
  // dispose しただけでは前回 render したピクセルが canvas に残り、プロジェクト
  // 切替直後に「前プロジェクトの最後のフレームが一瞬見える」現象になる。
  // 透明クリアで安全 (next renderActiveScene で新シーンが上書きするので破棄して問題なし)。
  // captureSceneSnapshot は project 切替前の captureLeavingThumbnail で先に呼ばれるため、
  // dispose 後の clear と衝突しない。
  const renderer = getRenderer();
  if (renderer) {
    try {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.setRenderTarget(prev);
    } catch (_err) {
      /* ignore: clear 失敗は致命的ではない */
    }
  }
}

// R10: crosszoom のとき現カット(シーン)をカメラズームで拡大→settle する。
// transition overlay が userData.camZoom を毎フレーム更新するので、それを
// 共有カメラへ一時適用して render し、直後に等倍へ戻す (他経路へ漏らさない)。
function _renderSceneWithTransitionZoom(inst) {
  const camZoom = inst?.meshes?.transition?.userData?.camZoom || 1;
  const cam = getCamera();
  if (cam && camZoom !== 1) {
    const prevZoom = cam.zoom;
    cam.zoom = camZoom;
    cam.updateProjectionMatrix();
    renderScene(inst.scene);
    cam.zoom = prevZoom;
    cam.updateProjectionMatrix();
  } else {
    renderScene(inst.scene);
  }
}

// ケンバーンズ適用後の world 変換を返す。プレビュー上のキャラ pick / ドラッグが
// 「canvas 座標 → シーン座標」の逆変換に使う (変換が無いカットでは恒等)。
export function getActiveWorldTransform() {
  const t = activeSceneInstance?.getWorldTransform?.();
  if (!t || !(Number(t.scale) > 0)) return { scale: 1, x: 0, y: 0 };
  return { scale: Number(t.scale), x: Number(t.x) || 0, y: Number(t.y) || 0 };
}

export function renderActiveScene(state = {}) {
  if (!activeSceneInstance) return;
  activeSceneInstance.update(state);
  _renderSceneWithTransitionZoom(activeSceneInstance);
}

// scene.update() を呼ばずに「現在の per-frame state を保ったまま」再描画する。
// ドラッグ中のキャラ座標 (basePos / group.position) 変更を即時反映するための
// 軽量パスとして使う。update() を回避すれば silhouette + blur のホット計算も
// 走らない (drag 中の連続レンダで重くなる主因)。
export function redrawActiveScene() {
  if (!activeSceneInstance) return;
  renderScene(activeSceneInstance.scene);
}

// 現在の GL canvas をそのまま blob にして返す。トップページサムネイル等の
// 静的キャプチャ用。preserveDrawingBuffer=true (core.js) を前提にしているので、
// 直前に renderActiveScene を 1 回でも呼んでいれば、再 render しなくても
// canvas には絵が残っている。再生中・停止中のどちらからでも呼べる。
//
// テロップ・セリフ・ビジュアライザはすべて scene 内 plane (CanvasTexture / Texture)
// に取り込まれているので、GL canvas を toBlob するだけで十分。
//
// active scene / renderer がまだ無いとき、または canvas が 0×0 のときは
// null を返す (呼び出し側で skip 判定)。
export async function captureSceneSnapshot({
  format = "image/webp",
  quality = 0.85,
} = {}) {
  if (!isRendererReady() || !activeSceneInstance) return null;
  const renderer = getRenderer();
  const baseCanvas = renderer?.domElement || null;
  if (!baseCanvas || !baseCanvas.width || !baseCanvas.height) return null;

  // toBlob は Chromium で webp/png を返す。Safari は webp 非対応なので caller が
  // 失敗時に png に retry する想定。
  return new Promise((resolve) => {
    try {
      baseCanvas.toBlob((blob) => resolve(blob || null), format, quality);
    } catch (err) {
      console.warn("[renderer] captureSceneSnapshot toBlob failed:", err);
      resolve(null);
    }
  });
}
