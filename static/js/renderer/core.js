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
// 出力 framebuffer サイズ。scene 内座標は CANVAS_WIDTH/HEIGHT 固定だが、
// 実際の rasterize 解像度は preview 表示時にここを下げて GL の rasterize / blend
// コストを軽減できる (= 動画ソフトのプロクシ的な仕組み)。PNG 出力 / 動画書き出し
// 時は呼び出し側で 1920×1080 に戻す。
let outputWidth = CANVAS_WIDTH;
let outputHeight = CANVAS_HEIGHT;

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
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer,
  });
  // 出力 framebuffer は preview/export で動的に切り替える (setRendererOutputSize)。
  // 初期値は scene 座標と同じ 1920×1080。CSS 表示サイズは container query が決めるので updateStyle=false。
  renderer.setPixelRatio(1);
  renderer.setSize(outputWidth, outputHeight, false);
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

// 出力 framebuffer サイズを変える。scene 内座標 (camera の ortho 範囲) は
// 変えないので、shader / mesh / texture には影響しない。GL の rasterize 段だけ
// 軽くなる (= preview のプロクシ化)。
//   - preview 経路: canvas の CSS サイズ × DPR (上限 CANVAS_WIDTH/HEIGHT) を渡す
//   - PNG / 動画書き出し: CANVAS_WIDTH / CANVAS_HEIGHT を渡してフル HD に戻す
// width/height は 1 以上の整数 (浮動小数点は round)、上限は CANVAS_WIDTH/HEIGHT。
export function setRendererOutputSize(width, height) {
  if (!renderer) return;
  const w = Math.max(1, Math.min(CANVAS_WIDTH, Math.round(Number(width) || CANVAS_WIDTH)));
  const h = Math.max(1, Math.min(CANVAS_HEIGHT, Math.round(Number(height) || CANVAS_HEIGHT)));
  if (w === outputWidth && h === outputHeight) return;
  outputWidth = w;
  outputHeight = h;
  // updateStyle=false: canvas の CSS は container 側が触る。framebuffer のみ変更。
  renderer.setSize(w, h, false);
}

export function getRendererOutputSize() {
  return { width: outputWidth, height: outputHeight };
}
