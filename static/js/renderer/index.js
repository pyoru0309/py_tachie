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
import { initRenderer, renderScene, isRendererReady, getRenderer, CANVAS_WIDTH, CANVAS_HEIGHT } from "./core.js";
import { buildScene } from "./scene-builder.js";

export { initRenderer, isRendererReady, CANVAS_WIDTH, CANVAS_HEIGHT };

// 現在描画中の SceneInstance。loadCut 等で differ なシーンに切り替わるたびに
// dispose して作り直す (Phase B でカット切替時の差分更新に最適化予定)。
let activeSceneInstance = null;

export async function buildSceneFromLayerData(
  layerData,
  videoProvider = null,
  videoLayerProvidersById = null,
  videoLayerDurations = null,
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
  return buildScene(
    layerData,
    getRenderer(),
    videoProvider,
    videoLayerProvidersById,
    videoLayerDurations,
  );
}

export function setActiveScene(instance) {
  if (activeSceneInstance && activeSceneInstance !== instance) {
    activeSceneInstance.dispose();
  }
  activeSceneInstance = instance;
}

export function getActiveScene() {
  return activeSceneInstance;
}

// 現在 active な SceneInstance の token (scene-bundle SHA1) を取り出す。
// playLiveCutV2 で「次カットの token と同じなら build を skip して再利用」する
// ための helper。一度も build していないとき / token 未指定のときは null。
export function getActiveSceneToken() {
  return activeSceneInstance?.token || null;
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

export function renderActiveScene(state = {}) {
  if (!activeSceneInstance) return;
  activeSceneInstance.update(state);
  renderScene(activeSceneInstance.scene);
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
