// =============================================================================
// renderer/effects/silhouette.js
//
// キャラの 4 レイヤー (under/eye/mouth/over) を 1 枚の RenderTarget に焼く。
// silhouette = レイヤーの色まで含めた合成結果。glow / shadow を作るときに
// この alpha を blur して tint で乗せる。
//
// なぜ alpha だけでなく rgb まで取るのか:
// - tint で完全置換するなら alpha だけで足りる (Phase B-2 はこの方式)
// - rgb を保つと「キャラそのものを blurして発光させる (色を残した glow)」
//   という拡張ができる。Phase B-2 では alpha のみ参照するので情報冗長だが、
//   ブランチを増やさず素直に rgba 通す
//
// 各キャラ独立の RT を持つ。GPU メモリは layerSize×4byte×3 (silhouette+blurA+blurB)
// = 1024×1536×4×3 ≒ 18MB / char。8 キャラまでなら 150MB 弱で実用。
// =============================================================================
import * as THREE from "three";

export function createSilhouettePass(width, height, padding = 80) {
  // padding は blur の境界が欠けないようにする余白 (最大 blur 半径より大きく)。
  const w = Math.ceil(width + padding * 2);
  const h = Math.ceil(height + padding * 2);

  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });

  // 専用 Scene と OrthographicCamera。キャラの 4 レイヤーをこの Scene に
  // 別 Mesh として add し、RT へ render する。メイン Scene と Group は共有しない
  // (three.js の Scene は parent 1 つ縛りがあるため別 Mesh を作る)。
  const scene = new THREE.Scene();
  const halfW = w / 2;
  const halfH = h / 2;
  // ★ Y orientation 注意 ★
  // main scene は Y-down camera (top=0, bottom=H) + texture.flipY=false で
  // 「画像の row 0 を画面 top に表示」する状態。silhouette を RT に書いて
  // main scene で sample するとき、RT の row 0 が「シーン下端 (画像 bottom)」に
  // なる必要がある (= main scene の UV(0,0) = row 0 = 画像 top で正立する条件)。
  // そのため silhouette camera は Y-up (top=halfH, bottom=-halfH) で構築する。
  // これで silhouette plane の vertex BL (UV(0,0) = 画像 top-left) は
  // 画面 bottom (small y) に置かれ、RT の row 0 に画像 top が書かれる。
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -100, 100);
  camera.position.set(0, 0, 10);

  return {
    rt,
    scene,
    camera,
    width: w,
    height: h,
    paddingX: padding,
    paddingY: padding,
    dispose() {
      rt.dispose();
      scene.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry?.dispose();
          obj.material?.dispose();
        }
      });
    },
  };
}

// 4 レイヤーのテクスチャを silhouette scene 内の 4 plane material に bind する。
// テクスチャ差し替え (eye / mouth swap) は per-frame で呼んでも安価。
export function bindSilhouetteLayers(silhouette, planes, eyeTexture, mouthTexture) {
  // planes: { under, eye, mouth, over } の THREE.Mesh
  if (planes.eye) {
    planes.eye.material.map = eyeTexture || null;
    planes.eye.material.needsUpdate = true;
    planes.eye.visible = !!eyeTexture;
  }
  if (planes.mouth) {
    planes.mouth.material.map = mouthTexture || null;
    planes.mouth.material.needsUpdate = true;
    planes.mouth.visible = !!mouthTexture;
  }
}

export function renderSilhouetteRT(renderer, silhouette) {
  const prev = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()).clone();
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(silhouette.rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(silhouette.scene, silhouette.camera);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevClear, prevAlpha);
}
