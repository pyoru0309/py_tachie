// =============================================================================
// renderer/core.js
//
// three.js の WebGLRenderer / OrthographicCamera を 1 つだけ生成して使い回す。
// 出力解像度は 1920×1080 固定 (CLAUDE.md の非機能事項)。
//
// 座標系は Pillow / Canvas2D に揃える: 原点 (0, 0) を左上、X 右、Y 下。
// OrthographicCamera を top=0 / bottom=H で初期化し、Texture.flipY を false
// にすることで「画像左上ピクセル = ワールド原点」を成立させる。
// =============================================================================
import * as THREE from "three";

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;

let renderer = null;
let camera = null;
let boundCanvas = null;
// 現 renderer を生成したときの options。同一 canvas でも options が変われば
// 作り直す必要があるので記録しておく (preview=antialias true / export=false の
// 切替で実際に再生成させるため)。
let rendererOpts = { antialias: null, preserveDrawingBuffer: null };

export function initRenderer(canvas, options = {}) {
  if (!canvas) throw new Error("initRenderer: canvas is required");
  // antialias: 既定 true。preview のポリゴンエッジ (キャラ silhouette /
  // dialogue box border / 動画レイヤーの矩形端 etc) のジャギー対策で MSAA を効かせる。
  // Windows Chrome (ANGLE) で見た目の効果が大きい一方、書き出しは frame ごとに
  // gl.readPixels するため MSAA resolve が readback を直列化させ著しく遅くなる
  // (2026-06-02 調査: stalls 多発・throughput 頭打ち)。そのため書き出し経路は
  // 明示的に antialias:false を渡し、preview だけ true を使う。出力はフル HD 等倍
  // 描画なので MSAA 無しでも品質は十分。
  const antialias = options.antialias !== undefined ? !!options.antialias : true;
  // preserveDrawingBuffer: 診断用に既定 true (render 後の readPixels が確実に
  // 書き込み済み pixel を返す)。書き出しは毎フレーム描画→読み出しを同期させて
  // いるので false で良く、余分な present コストを避けられる。options 優先、
  // 無指定なら従来の診断デフォルト (__splitePreserveDrawingBuffer で上書き可)。
  const preserveDrawingBuffer =
    options.preserveDrawingBuffer !== undefined
      ? !!options.preserveDrawingBuffer
      : ((typeof window === "undefined")
        ? true
        : (window.__splitePreserveDrawingBuffer !== false));

  if (
    renderer
    && boundCanvas === canvas
    && rendererOpts.antialias === antialias
    && rendererOpts.preserveDrawingBuffer === preserveDrawingBuffer
  ) {
    return { renderer, camera };
  }
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
  boundCanvas = canvas;
  rendererOpts = { antialias, preserveDrawingBuffer };
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias,
    premultipliedAlpha: false,
    preserveDrawingBuffer,
  });
  // 1920×1080 の出力固定。CSS 表示サイズは container query が決めるので updateStyle=false。
  renderer.setPixelRatio(1);
  renderer.setSize(CANVAS_WIDTH, CANVAS_HEIGHT, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0); // 透過。背景はシーン側の plane で塗る。
  // localClippingEnabled: Material 単位の clippingPlanes を有効にする。
  // B-2: マルチキャラレイアウトの crop で各キャラ mesh を矩形クリップするのに使う。
  // crop 未指定のキャラは clippingPlanes=[] (= 空配列) で素通し。
  renderer.localClippingEnabled = true;

  // Y-down: top=0, bottom=H にすることで world y=0 が NDC top=+1 にマップされる。
  // camera.up は既定 (0, 1, 0) のままで OK (反転すると X も反転してしまう)。
  // 画像は texture.flipY=false (texture-cache.js) と組み合わせ、PlaneGeometry の
  // BL 頂点 UV(0,0) が画像 top-left に対応する形で右向き正立する。
  camera = new THREE.OrthographicCamera(0, CANVAS_WIDTH, 0, CANVAS_HEIGHT, -1000, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  return { renderer, camera };
}

export function getRenderer() {
  return renderer;
}

export function getCamera() {
  return camera;
}

export function renderScene(scene) {
  if (!renderer || !camera || !scene) return;
  renderer.render(scene, camera);
}

export function disposeRenderer() {
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
  camera = null;
  boundCanvas = null;
  rendererOpts = { antialias: null, preserveDrawingBuffer: null };
}

export function isRendererReady() {
  return !!renderer;
}
