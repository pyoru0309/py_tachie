// =============================================================================
// renderer/effects/gaussian-blur.js
//
// Separable Gaussian blur (horizontal pass → vertical pass)。
// alpha チャネルだけブラーすれば良い (光彩・影は色を後で uniform で乗せる) ので、
// rgba 全部をブラーするより軽く出来る選択肢もあるが、Phase B-2 はシンプルに
// rgba をブラー (silhouette 自体が color × alpha = (0,0,0,a) で焼かれている)。
//
// 9-tap カーネル (sigma ≈ blurPx/2)。kernel は per-frame に動的計算する。
// 計算は cheap なので uniform 更新コストは無視できる。
// =============================================================================
import * as THREE from "three";

const VERT_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec2 uTexel;          // 1 / textureSize (px 単位の uv 増分)
  uniform vec2 uDirection;      // (1, 0) = horizontal, (0, 1) = vertical
  uniform float uWeights[9];
  uniform float uOffsets[9];
  varying vec2 vUv;

  // 9-tap separable Gaussian。i=0 が中心、i=1..8 が左右ペア。
  // 旧実装は末尾で acc -= sample(center) * w[0] をしていたが、ループ側は
  // (i > 0) で中心を 1 回しか足していないため、減算で「中心成分が完全に
  // 消える」バグになっていた。silhouette -> blur -> tint で輪郭外の薄い裾だけが
  // 残る = 光彩がキャラに隠れて見えない、背景 blur が大きく減衰する、と
  // いう症状の本命。
  void main() {
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 9; i++) {
      vec2 d = uDirection * uTexel * uOffsets[i];
      acc += texture2D(uMap, vUv + d) * uWeights[i];
      if (i > 0) acc += texture2D(uMap, vUv - d) * uWeights[i];
    }
    gl_FragColor = acc;
  }
`;

function buildKernel(sigma) {
  // 9-tap (中心 + 左右 4 つずつ)。サンプル間隔を sigma に追従させ、±3σ を
  // カバーする (Gaussian の有効範囲。これ以上は重みがほぼ 0)。
  // 旧実装は offsets=0..8 の固定値だったため、blurPx=50 (sigma=25) でも
  // 実サンプル参照範囲は最大 8px までで、Pillow の GaussianBlur(radius=50)
  // のような広がりにならず「光彩がほぼ見えない」状態になっていた。
  const offsets = [];
  const weights = [];
  let sum = 0;
  // ±3σ を 8 段階に分ける。step = 3σ / 8。ただし最小間隔は 1px 確保
  // (極小 blur のときでも縮退しないように)。
  const step = Math.max(1.0, (3.0 * sigma) / 8.0);
  for (let i = 0; i < 9; i++) {
    const off = i * step;
    offsets.push(off);
    const w = Math.exp(-(off * off) / (2 * sigma * sigma));
    weights.push(w);
    sum += i === 0 ? w : 2 * w;
  }
  // 正規化。中心は 1 倍、それ以外は左右 2 倍されるので正しく合算は 2*Σwᵢ - w₀。
  return { offsets, weights: weights.map((w) => w / sum) };
}

class GaussianBlur {
  constructor(rtA, rtB) {
    this.rtA = rtA;
    this.rtB = rtB;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uWeights: { value: new Array(9).fill(0) },
        uOffsets: { value: new Array(9).fill(0) },
      },
      vertexShader: VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      // ポストエフェクトの fullscreen pass は「合成」ではなく「計算結果を
      // そのまま RT へ上書き」したい。transparent + NormalBlending だと
      // SrcAlpha 因子が掛かって rgb が a 分だけ目減りし、blur の式と異なる
      // 結果が得られる。NoBlending に固定して shader 出力 = RT pixel に。
      transparent: false,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.quad);
  }

  // sourceTex (THREE.Texture) を blurPx 量ぼかして、結果テクスチャを返す。
  // rtA / rtB を ping-pong バッファとして使い、最終結果は rtB.texture。
  apply(renderer, sourceTexture, blurPx) {
    const sigma = Math.max(0.5, blurPx / 2.0);
    const { offsets, weights } = buildKernel(sigma);
    this.material.uniforms.uOffsets.value = offsets;
    this.material.uniforms.uWeights.value = weights;

    const w = this.rtA.width;
    const h = this.rtA.height;
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);

    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevClear = renderer.getClearColor(new THREE.Color()).clone();
    const prevAlpha = renderer.getClearAlpha();
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);

    // horizontal pass: source → rtA
    this.material.uniforms.uMap.value = sourceTexture;
    this.material.uniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(this.rtA);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // vertical pass: rtA → rtB
    this.material.uniforms.uMap.value = this.rtA.texture;
    this.material.uniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(this.rtB);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
    renderer.setClearColor(prevClear, prevAlpha);
    return this.rtB.texture;
  }

  dispose() {
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

export function createBlurPass(width, height) {
  const opts = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  };
  const rtA = new THREE.WebGLRenderTarget(width, height, opts);
  const rtB = new THREE.WebGLRenderTarget(width, height, opts);
  return {
    pass: new GaussianBlur(rtA, rtB),
    rtA,
    rtB,
    dispose() {
      this.pass.dispose();
      rtA.dispose();
      rtB.dispose();
    },
  };
}
