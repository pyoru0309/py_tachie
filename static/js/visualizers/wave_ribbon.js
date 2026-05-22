// =============================================================================
// visualizers/wave_ribbon.js
//
// 太い波線を三角形リボンとして生成し、ShaderMaterial でエッジを柔らかくする。
//
// 構造 (最適化後):
//   strand あたり 1 BufferGeometry を作り、shade / glow / main の 3 レイヤー
//   (3 Mesh) は同じ geometry を共有する。レイヤーごとに position 配列を
//   持つ代わりに、頂点には「中心線 (aCenter)」「法線 (aNormal)」「タペル係数
//   (aTaper = strandScale × taper(u))」を持たせて、レイヤー固有の half は
//   vertex shader 側で `max(2.0, uHalfBase * uHalfMult * aTaper)` で合成する。
//
//   ベネフィット:
//     - cx / cy / nx / ny / sqrt の per-vertex 計算が strand あたり 1 回に
//       (旧: shade / glow / main の 3 回)
//     - 毎フレームの GPU upload が strand × {aCenter, aNormal} の 2 attribute
//       (旧: 3 mesh × position attribute)
//     - BufferGeometry 数: 9 → 3 (strand 単位)
//
//   draw call 数は維持 (9): shade=NormalBlending, glow=AdditiveBlending,
//   main=NormalBlending を混在させたいため、blending を merge しない。
// =============================================================================
import {
  clamp01,
  hexToColor,
  numParam,
  readStreamScalar,
  sliceStreamRow,
} from "/static/js/visualizers/_kit.js";

const SEGMENTS = 180;
const TAU = Math.PI * 2;

function normalizeParams(rawParams) {
  const p = rawParams || {};
  return {
    color: String(p.color || "#8ffcff"),
    accentColor: String(p.accentColor || "#a970ff"),
    x: numParam(p.x, -120),
    width: Math.max(1, numParam(p.width, 2160)),
    centerY: numParam(p.centerY, 540),
    amplitude: Math.max(0, numParam(p.amplitude, 210)),
    thickness: Math.max(1, numParam(p.thickness, 64)),
    strandCount: Math.max(1, Math.min(4, Math.round(numParam(p.strandCount, 3)))),
    frequency: Math.max(0.01, numParam(p.frequency, 1.35)),
    speed: numParam(p.speed, 1.15),
    reactivity: Math.max(0, numParam(p.reactivity, 1.2)),
    glow: clamp01(numParam(p.glow, 0.72)),
    softness: Math.max(0.45, Math.min(3, numParam(p.softness, 0.85))),
    opacity: clamp01(numParam(p.opacity, 0.82)),
  };
}

// per-strand BufferGeometry。aTaper は strandScale × taper(u) を init で焼く。
// aCenter / aNormal は毎フレーム書き込み、aSide / aMix / aTaper は静的。
function makeRibbonGeometry(THREE, strandScale) {
  const vertexCount = (SEGMENTS + 1) * 2;
  const aCenter = new Float32Array(vertexCount * 2);
  const aNormal = new Float32Array(vertexCount * 2);
  const aSide = new Float32Array(vertexCount);
  const aMix = new Float32Array(vertexCount);
  const aTaper = new Float32Array(vertexCount);
  const indices = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const lo = i * 2;
    const u = i / SEGMENTS;
    const t = strandScale * (0.56 + 0.44 * Math.sin(Math.PI * u));
    aSide[lo] = -1;
    aSide[lo + 1] = 1;
    aMix[lo] = u;
    aMix[lo + 1] = u;
    aTaper[lo] = t;
    aTaper[lo + 1] = t;
    if (i < SEGMENTS) {
      const a = lo;
      const b = lo + 1;
      const c = lo + 2;
      const d = lo + 3;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  const centerAttr = new THREE.BufferAttribute(aCenter, 2).setUsage(THREE.DynamicDrawUsage);
  const normalAttr = new THREE.BufferAttribute(aNormal, 2).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("aCenter", centerAttr);
  geom.setAttribute("aNormal", normalAttr);
  geom.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
  geom.setAttribute("aMix", new THREE.BufferAttribute(aMix, 1));
  geom.setAttribute("aTaper", new THREE.BufferAttribute(aTaper, 1));
  geom.setIndex(indices);
  // position attribute は使わないが、three.js の dispose / bound check で
  // 参照される場合があるので 0 長で空欄を埋めずに済むよう何も設定しない
  // (BufferGeometry は position が無くても問題なく動く — index と attribute だけで描画される)。
  return { geom, aCenter, aNormal, centerAttr, normalAttr };
}

function makeRibbonMaterial(
  THREE,
  colorA,
  colorB,
  halfMult,
  opacity,
  softness,
  colorShift,
  blending,
  coreBoost = 1.0,
) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending,
    uniforms: {
      uColorA: { value: colorA.clone() },
      uColorB: { value: colorB.clone() },
      uOpacity: { value: opacity },
      uSoftness: { value: softness },
      uColorShift: { value: colorShift },
      uCoreBoost: { value: coreBoost },
      // uHalfBase は毎フレーム更新 (per-strand, 3 layer で共有値)、
      // uHalfMult はレイヤー固有の定数 (shade=1.42 / glow=1.78 / main=1.0)。
      uHalfBase: { value: 0.0 },
      uHalfMult: { value: halfMult },
    },
    vertexShader: `
      attribute vec2 aCenter;
      attribute vec2 aNormal;
      attribute float aSide;
      attribute float aMix;
      attribute float aTaper;
      uniform float uHalfBase;
      uniform float uHalfMult;
      varying float vSide;
      varying float vMix;
      void main() {
        vSide = aSide;
        vMix = aMix;
        // ★ "half" は GLSL の予約語 (半精度型 — 拡張限定で実装されることがある)
        //   なので変数名に使えない。halfW (ribbon の半幅) で逃がす。
        float halfW = max(2.0, uHalfBase * uHalfMult * aTaper);
        vec3 pos = vec3(
          aCenter.x + aNormal.x * aSide * halfW,
          aCenter.y + aNormal.y * aSide * halfW,
          0.0
        );
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;
      uniform float uSoftness;
      uniform float uColorShift;
      uniform float uCoreBoost;
      varying float vSide;
      varying float vMix;
      void main() {
        float center = max(0.0, 1.0 - abs(vSide));
        float alpha = pow(center, uSoftness);
        float m = clamp(vMix * 0.78 + uColorShift, 0.0, 1.0);
        vec3 color = mix(uColorA, uColorB, m);
        color = clamp(color * uCoreBoost, 0.0, 1.0);
        gl_FragColor = vec4(color, clamp(alpha * uOpacity, 0.0, 1.0));
      }
    `,
  });
}

export async function createVisualizerLayer(ctx) {
  const { THREE, params, streamMeta, frameCount } = ctx;
  const p = normalizeParams(params);
  // THREE.Group ではなく Object3D を使う。Group だと three.js の
  // projectObject が `groupOrder = group.renderOrder` を子孫に伝播させ、
  // reversePainterSortStable が groupOrder を renderOrder より優先するため、
  // scene-builder が Group に renderOrder=50 等を立てた瞬間に子孫が
  // groupOrder=50 となり、テロップ (groupOrder=0, renderOrder=3000) より
  // 後段にソートされて画面前面に出てしまう。
  const group = new THREE.Object3D();
  group.frustumCulled = false;

  const energyStream = streamMeta?.energy || null;
  const onsetStream = streamMeta?.onset || null;
  const energyBuf = new Float32Array(4);
  const colorA = hexToColor(THREE, p.color);
  const colorB = hexToColor(THREE, p.accentColor);
  const contrastA = colorA.clone().multiplyScalar(0.34);
  const contrastB = colorB.clone().multiplyScalar(0.34);
  const ribbons = [];

  for (let s = 0; s < p.strandCount; s++) {
    const strandMix = s / Math.max(1, p.strandCount - 1);
    const strandScale = 1.0 - strandMix * 0.11;
    const { geom, aCenter, aNormal, centerAttr, normalAttr } =
      makeRibbonGeometry(THREE, strandScale);

    const shadeMaterial = makeRibbonMaterial(
      THREE, contrastA, contrastB,
      1.42,
      p.opacity * 0.16,
      Math.max(0.65, p.softness * 1.35),
      strandMix * 0.23,
      THREE.NormalBlending,
      1.0,
    );
    const mainMaterial = makeRibbonMaterial(
      THREE, colorA, colorB,
      1.0,
      p.opacity * (0.76 + strandMix * 0.1),
      p.softness,
      strandMix * 0.23,
      THREE.NormalBlending,
      1.14,
    );
    const glowMaterial = makeRibbonMaterial(
      THREE, colorA, colorB,
      1.78,
      p.opacity * p.glow * 0.18,
      Math.max(0.45, p.softness * 0.72),
      strandMix * 0.23,
      THREE.AdditiveBlending,
      1.0,
    );
    // 同一 geom を 3 Mesh で共有する。dispose は geom を 1 回だけ呼ぶ。
    // renderOrder は scene-builder が viz.layer の値に統一するので
    // 同 renderOrder 内のソートは three.js id (= add 順) ベース。
    // 旧コードと同じく shade → glow → main の add 順を維持する。
    const shadeMesh = new THREE.Mesh(geom, shadeMaterial);
    const glowMesh = new THREE.Mesh(geom, glowMaterial);
    const mainMesh = new THREE.Mesh(geom, mainMaterial);
    shadeMesh.frustumCulled = false;
    glowMesh.frustumCulled = false;
    mainMesh.frustumCulled = false;
    group.add(shadeMesh);
    group.add(glowMesh);
    group.add(mainMesh);
    ribbons.push({
      geom,
      aCenter,
      aNormal,
      centerAttr,
      normalAttr,
      shadeMaterial,
      mainMaterial,
      glowMaterial,
      strand: s,
      strandMix,
    });
  }

  // 中心線の一時バッファ (strand 内で使い回し)。
  const cx = new Float32Array(SEGMENTS + 1);
  const cy = new Float32Array(SEGMENTS + 1);
  let lastFrameIdx = -1;

  function centerYAt(u, strand, energy, onset, elapsedSec) {
    const [full, low, mid, high] = energy;
    const offset = (strand - (p.strandCount - 1) / 2) * p.thickness * (1.05 + 0.35 * p.reactivity);
    const phase = strand * 1.27 + elapsedSec * p.speed * TAU * 0.18;
    const transient = onset * (0.28 + p.reactivity * 0.42);
    const ampEff = p.amplitude * (0.38 + full * p.reactivity + transient);
    let y = p.centerY + offset;
    y += Math.sin(u * TAU * p.frequency + phase + low * 1.6 + onset * 0.7) * ampEff;
    y += Math.sin(u * TAU * (p.frequency * 0.47 + 0.17) - phase * 0.7 + mid * 2.1) * p.amplitude * (0.16 + mid * 0.34);
    y += Math.sin(u * TAU * (p.frequency * 2.05 + 0.3) + phase * 1.5 + high * 2.7) * p.amplitude * (0.04 + high * 0.10);
    return y;
  }

  function updateRibbon(ribbon, energy, onset, elapsedSec) {
    const [full] = energy;
    // 中心線 (cx, cy) を per-vertex 計算。旧実装はこの後 shade / glow / main の
    // 3 回 writeRibbonPositions を呼び、毎回 dx/dy/sqrt/sin を再計算していたが、
    // 共有 geometry 化したので strand あたり 1 周だけで済む。
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      cx[i] = p.x + u * p.width;
      cy[i] = centerYAt(u, ribbon.strand, energy, onset, elapsedSec);
    }

    const aCenter = ribbon.aCenter;
    const aNormal = ribbon.aNormal;
    for (let i = 0; i <= SEGMENTS; i++) {
      const prev = i > 0 ? i - 1 : 0;
      const next = i < SEGMENTS ? i + 1 : SEGMENTS;
      const dx = cx[next] - cx[prev];
      const dy = cy[next] - cy[prev];
      const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
      const nx = -dy / len;
      const ny = dx / len;
      // 両側の頂点 (aSide=-1, +1) は同じ aCenter / aNormal を持つ (shader で
      // aSide を符号として展開する)。
      const lo = i * 2 * 2;
      aCenter[lo] = cx[i];
      aCenter[lo + 1] = cy[i];
      aCenter[lo + 2] = cx[i];
      aCenter[lo + 3] = cy[i];
      aNormal[lo] = nx;
      aNormal[lo + 1] = ny;
      aNormal[lo + 2] = nx;
      aNormal[lo + 3] = ny;
    }
    ribbon.centerAttr.needsUpdate = true;
    ribbon.normalAttr.needsUpdate = true;

    // uniform 更新 (per-frame)。
    // halfBase は 3 layer 共通、uHalfMult はレイヤー固有定数。
    const halfBase = p.thickness * (0.35 + full * p.reactivity * 0.55 + onset * 0.24) * (1.0 + p.glow * 0.62);
    ribbon.shadeMaterial.uniforms.uHalfBase.value = halfBase;
    ribbon.glowMaterial.uniforms.uHalfBase.value = halfBase;
    ribbon.mainMaterial.uniforms.uHalfBase.value = halfBase;

    ribbon.shadeMaterial.uniforms.uOpacity.value = p.opacity * (0.08 + full * 0.08 + onset * 0.04) * (0.92 - ribbon.strandMix * 0.12);
    ribbon.glowMaterial.uniforms.uOpacity.value = p.opacity * p.glow * (0.08 + full * 0.16 + onset * 0.08) * (0.95 - ribbon.strandMix * 0.14);
    ribbon.mainMaterial.uniforms.uOpacity.value = Math.min(0.98, p.opacity * (0.58 + full * 0.55 + onset * 0.22) * (0.95 - ribbon.strandMix * 0.12));

    ribbon.mainMaterial.uniforms.uSoftness.value = p.softness;
    ribbon.glowMaterial.uniforms.uSoftness.value = Math.max(0.45, p.softness * 0.72);
    ribbon.shadeMaterial.uniforms.uSoftness.value = Math.max(0.65, p.softness * 1.35);
  }

  function updateImpl(frameIdx, elapsedSec) {
    // params は createVisualizerLayer 時点の snapshot で以降不変 (UI から
    // 変更されればシーンごと rebuild される) なので、旧 paramsCacheKey チェックは
    // 毎フレーム string concat するだけの dead code だった。frameIdx の同一性だけ
    // 見れば十分。
    if (frameIdx === lastFrameIdx) return;
    lastFrameIdx = frameIdx;
    const row = sliceStreamRow(energyStream, frameIdx, 4, energyBuf);
    const energy = [
      clamp01(row[0] || 0),
      clamp01(row[1] || 0),
      clamp01(row[2] || 0),
      clamp01(row[3] || 0),
    ];
    const onset = clamp01(readStreamScalar(onsetStream, frameIdx, 0));
    for (const ribbon of ribbons) updateRibbon(ribbon, energy, onset, Number(elapsedSec) || 0);
  }

  updateImpl(0, 0);

  function update(frameState) {
    let idx = Math.max(0, Math.floor(Number(frameState?.frameIdx) || 0));
    const fmax = Math.max(0, (Number(frameCount) || 0) - 1);
    if (fmax >= 0 && idx > fmax) idx = fmax;
    updateImpl(idx, Number(frameState?.elapsedSec) || 0);
  }

  function dispose() {
    for (const ribbon of ribbons) {
      // geom は 3 Mesh で共有しているので 1 回だけ dispose。
      ribbon.geom.dispose();
      ribbon.shadeMaterial.dispose();
      ribbon.glowMaterial.dispose();
      ribbon.mainMaterial.dispose();
    }
  }

  return { object3D: group, update, dispose };
}
