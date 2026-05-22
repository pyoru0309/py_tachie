// =============================================================================
// renderer/effects/cover.js
//
// 入力テクスチャを 1920x1080 (任意 dst サイズ) の RT に「cover」配置で焼く
// 単段パス。cover = max-scale + center crop で Pillow の `cover_image()` と
// 視覚的に一致させる。
//
// 背景 blur 経路は blur shader が ShaderMaterial で texture.matrix を honor
// しないため、`texture.repeat/offset` だけだと blur パスが原寸全体を読んで
// しまう。本パスで先に cover 済 RT を作っておけば、blur パスは uv [0,1] を
// そのまま読むだけで「cover 後の絵に対する blur」になる。
//
// blur が無い場合は scene-builder 側で `texture.repeat/offset` を MeshBasicMaterial
// に渡せば済むので、本パスを通す必要はない (RT 1 枚分のメモリ・帯域を浮かせる)。
// =============================================================================
import * as THREE from "three";

const VERT_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec2 uOffset;
  uniform vec2 uRepeat;
  varying vec2 vUv;
  void main() {
    vec2 transformed = vUv * uRepeat + uOffset;
    gl_FragColor = texture2D(uMap, transformed);
  }
`;

function computeCover(srcW, srcH, dstW, dstH) {
  // aspectSrc > aspectDst: 横長すぎ → 左右トリム (repeat.x < 1)
  // aspectSrc < aspectDst: 縦長すぎ → 上下トリム (repeat.y < 1)
  // 同値なら identity。
  const aspectSrc = srcW / srcH;
  const aspectDst = dstW / dstH;
  if (aspectSrc > aspectDst) {
    const r = aspectDst / aspectSrc;
    return { repeatX: r, repeatY: 1, offsetX: (1 - r) / 2, offsetY: 0 };
  }
  const r = aspectSrc / aspectDst;
  return { repeatX: 1, repeatY: r, offsetX: 0, offsetY: (1 - r) / 2 };
}

export function createCoverPass(width, height) {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  // colorSpace は **設定しない**。`effects/gaussian-blur.js` の RT がデフォルト
  // (= LinearSRGBColorSpace) なのに合わせる。素材 PNG は SRGBColorSpace なので
  // GPU が cover shader 内のサンプリング時に自動で linear へデコードし、cover RT
  // には raw linear 8bit が書き込まれる。後段 (blur or bg plane) は LinearSRGB
  // としてそのまま読めるので、renderer.outputColorSpace=SRGB の最終 encode に
  // 一回だけ乗る (二重 encode/decode を避ける) 構造。
  rt.texture.flipY = false;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uOffset: { value: new THREE.Vector2(0, 0) },
      uRepeat: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);

  return {
    rt,
    apply(renderer, sourceTex, srcW, srcH, dstW = width, dstH = height) {
      const { repeatX, repeatY, offsetX, offsetY } = computeCover(srcW, srcH, dstW, dstH);
      // texture-cache が clamp していないケースに備え、cover 入力では必ず edge clamp。
      sourceTex.wrapS = THREE.ClampToEdgeWrapping;
      sourceTex.wrapT = THREE.ClampToEdgeWrapping;
      material.uniforms.uMap.value = sourceTex;
      material.uniforms.uOffset.value.set(offsetX, offsetY);
      material.uniforms.uRepeat.value.set(repeatX, repeatY);

      const prev = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      const prevClear = renderer.getClearColor(new THREE.Color()).clone();
      const prevAlpha = renderer.getClearAlpha();
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);
      return rt.texture;
    },
    dispose() {
      rt.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
