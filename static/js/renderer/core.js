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

export function initRenderer(canvas) {
  if (!canvas) throw new Error("initRenderer: canvas is required");
  if (renderer && boundCanvas === canvas) {
    return { renderer, camera };
  }
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
  boundCanvas = canvas;
  // 診断モード中: preserveDrawingBuffer=true を既定にする。これで render 後の
  // readPixels が確実に「実際に書き込まれた pixel」を返す (false だと一部
  // ブラウザで present 直後にクリアされる)。原因切り分けが終わったら false に
  // 戻す。__splitePreserveDrawingBuffer=false を明示すれば旧挙動。
  const preserveDrawingBuffer =
    (typeof window === "undefined")
      ? true
      : (window.__splitePreserveDrawingBuffer !== false);
  // antialias: true は WebGL の MSAA を有効化する。preview のポリゴンエッジ
  // (キャラ silhouette / dialogue box border / 動画レイヤーの矩形端 etc) が
  // ジャギーに見えていた問題への対処。Windows Chrome (ANGLE) で特に効果が大きい。
  // GPU の fragment 処理コストは数倍になるが、preview は static 描画寄り (= 多数の
  // texture plane を 1 度焼くだけ) なので体感差は小さい。動画書き出しは frame ごとに
  // 大量 render するので影響を受けるが、出力品質に効くので維持。
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer,
  });
  // 1920×1080 の出力固定。CSS 表示サイズは container query が決めるので updateStyle=false。
  renderer.setPixelRatio(1);
  renderer.setSize(CANVAS_WIDTH, CANVAS_HEIGHT, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0); // 透過。背景はシーン側の plane で塗る。

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
}

export function isRendererReady() {
  return !!renderer;
}
