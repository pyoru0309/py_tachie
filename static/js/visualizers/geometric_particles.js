// =============================================================================
// visualizers/geometric_particles.js
//
// 音に反応する直線的な点群ネットワーク。環境差の出やすい Points/LineSegments
// ではなく、粒子もリンク線も InstancedMesh の小さな面で描く。
// =============================================================================
import {
  clamp01,
  hexToColor,
  numParam,
  readStreamScalar,
  sliceStreamRow,
} from "/static/js/visualizers/_kit.js";

function normalizeParams(rawParams) {
  const p = rawParams || {};
  let dbFloor = numParam(p.dbFloor, -80);
  let dbCeil = numParam(p.dbCeil, -20);
  if (dbCeil <= dbFloor) dbCeil = dbFloor + 1;
  return {
    color: String(p.color || "#7cf7ff"),
    accentColor: String(p.accentColor || "#ffe66d"),
    particleCount: Math.max(1, Math.min(300, Math.round(numParam(p.particleCount, 112)))),
    bands: Math.max(1, Math.min(96, Math.round(numParam(p.bands, 32)))),
    x: numParam(p.x, 160),
    y: numParam(p.y, 150),
    width: Math.max(1, numParam(p.width, 1600)),
    height: Math.max(1, numParam(p.height, 720)),
    motion: Math.max(0, numParam(p.motion, 190)),
    pointSize: Math.max(1, numParam(p.pointSize, 7)),
    lineOpacity: clamp01(numParam(p.lineOpacity, 0.42)),
    dbFloor,
    dbCeil,
    glow: clamp01(numParam(p.glow, 0.55)),
    opacity: clamp01(numParam(p.opacity, 0.88)),
  };
}

function makeInstancedMaterial(THREE, opacity, shape, blending) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending,
    vertexColors: true,
    uniforms: {
      uOpacity: { value: opacity },
      uShape: { value: shape },
    },
    vertexShader: `
      varying vec3 vColor;
      varying vec2 vUv;
      void main() {
        #ifdef USE_INSTANCING_COLOR
        vColor = instanceColor;
        #else
        vColor = vec3(1.0);
        #endif
        vUv = position.xy + vec2(0.5);
        vec4 transformed = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        transformed = instanceMatrix * transformed;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * transformed;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform float uShape;
      varying vec3 vColor;
      varying vec2 vUv;
      void main() {
        float mask;
        if (uShape < 0.5) {
          float d = abs(vUv.x - 0.5) + abs(vUv.y - 0.5);
          mask = 1.0 - smoothstep(0.42, 0.52, d);
        } else {
          float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
          mask = smoothstep(0.0, 0.14, edge);
        }
        gl_FragColor = vec4(vColor, mask * uOpacity);
      }
    `,
  });
}

export async function createVisualizerLayer(ctx) {
  const { THREE, params, streamMeta, streamShapes, frameCount } = ctx;
  const p = normalizeParams(params);
  // THREE.Group ではなく Object3D を使う。Group だと three.js の
  // projectObject が `groupOrder = group.renderOrder` を子孫に伝播させ、
  // reversePainterSortStable が groupOrder を renderOrder より優先するため、
  // scene-builder が Group に renderOrder=50 等を立てた瞬間に子孫が
  // groupOrder=50 となり、テロップ (groupOrder=0, renderOrder=3000) より
  // 後段にソートされて画面前面に出てしまう。
  const group = new THREE.Object3D();
  group.frustumCulled = false;

  const spectrumStream = streamMeta?.spectrum || null;
  const energyStream = streamMeta?.energy || null;
  const onsetStream = streamMeta?.onset || null;
  const specShape = streamShapes?.spectrum || null;
  const bandsBaked = (() => {
    if (Array.isArray(specShape) && specShape.length >= 2) return Math.max(1, Number(specShape[1]));
    if (spectrumStream?.array && frameCount > 0) return Math.max(1, Math.floor(spectrumStream.array.length / frameCount));
    return p.bands;
  })();
  const spectrumBuf = new Float32Array(bandsBaked);
  const energyBuf = new Float32Array(4);

  const count = p.particleCount;
  const stride = Math.max(3, Math.round(Math.sqrt(count)));
  const pairs = [];
  for (let i = 0; i < count - 1; i++) {
    pairs.push([i, i + 1]);
    if (i + stride < count) pairs.push([i, i + stride]);
  }

  const geom = new THREE.PlaneGeometry(1, 1);
  const nodeMat = makeInstancedMaterial(THREE, p.opacity, 0, THREE.NormalBlending);
  const glowMat = makeInstancedMaterial(THREE, p.opacity * p.glow * 0.25, 0, THREE.AdditiveBlending);
  const linkMat = makeInstancedMaterial(THREE, p.opacity * p.lineOpacity, 1, THREE.NormalBlending);

  const links = new THREE.InstancedMesh(geom, linkMat, pairs.length);
  const glow = new THREE.InstancedMesh(geom, glowMat, count);
  const nodes = new THREE.InstancedMesh(geom, nodeMat, count);
  links.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  nodes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  links.frustumCulled = false;
  glow.frustumCulled = false;
  nodes.frustumCulled = false;
  group.add(links);
  group.add(glow);
  group.add(nodes);

  const colorA = hexToColor(THREE, p.color);
  const colorB = hexToColor(THREE, p.accentColor);
  const tempColor = new THREE.Color();
  const dimColor = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const world = new Float32Array(count * 3);
  const weights = new Float32Array(count);
  let lastFrameIdx = -1;

  function setInstance(mesh, index, x, y, width, height, rotation, color) {
    pos.set(x, y, 0);
    quat.setFromAxisAngle(zAxis, rotation);
    scale.set(Math.max(0.001, width), Math.max(0.001, height), 1);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, color);
  }

  function updateImpl(frameIdx, elapsedSec) {
    // params は createVisualizerLayer 時点で snapshot されて以降不変 (UI 変更時は
    // シーンごと rebuild される) なので、旧 paramsCacheKey の比較は dead code
    // だった (毎フレーム string concat のコストだけ発生)。frameIdx の同一性のみで
    // skip 判定する。
    if (frameIdx === lastFrameIdx) return;
    lastFrameIdx = frameIdx;

    const spectrum = sliceStreamRow(spectrumStream, frameIdx, bandsBaked, spectrumBuf);
    const energy = sliceStreamRow(energyStream, frameIdx, 4, energyBuf);
    const full = Math.max(0.08, clamp01(energy[0] || 0));
    const low = Math.max(0.06, clamp01(energy[1] || 0));
    const mid = Math.max(0.06, clamp01(energy[2] || 0));
    const high = Math.max(0.06, clamp01(energy[3] || 0));
    const onset = clamp01(readStreamScalar(onsetStream, frameIdx, 0));
    const time = Number(elapsedSec) || 0;
    const onsetBoost = 1 + onset * (0.45 + p.glow * 0.55);

    for (let i = 0; i < count; i++) {
      const u = i / Math.max(1, count - 1);
      const lane = ((i * 7) % 13) / 12;
      const srcBand = i % bandsBaked;
      let band = clamp01(spectrum[srcBand] || 0);
      band = Math.max(0.12, Math.pow(band, 0.8));

      const sweep = Math.sin(time * (0.55 + high * 0.7) + i * 0.21);
      const cut = Math.sin(time * (1.2 + low) + u * Math.PI * 4);
      const punch = Math.sin(time * 4.6 + i * 0.37) * onset * p.motion * 0.075;
      const x = p.x + u * p.width + (lane - 0.5) * p.motion * (0.18 + low * 0.45) + sweep * p.motion * 0.08 + punch;
      const y = p.y + p.height * (0.14 + 0.72 * lane) + (band - 0.35) * p.motion * (0.45 + full) * onsetBoost + cut * p.motion * 0.12;
      const weight = 0.25 + 0.75 * band;
      const idx3 = i * 3;
      world[idx3] = x;
      world[idx3 + 1] = y;
      world[idx3 + 2] = 0;
      weights[i] = weight;

      tempColor.copy(colorA).lerp(colorB, Math.min(1, u * 0.35 + weight * 0.65));
      tempColor.multiplyScalar(0.65 + weight * 0.65);
      const size = p.pointSize * (1.0 + weight * (1.3 + p.glow * 0.8) + onset * 0.55);
      setInstance(nodes, i, x, y, size, size, Math.PI / 4, tempColor);
      dimColor.copy(tempColor).multiplyScalar(0.55);
      setInstance(glow, i, x, y, size * (2.1 + p.glow * 1.3), size * (2.1 + p.glow * 1.3), Math.PI / 4, dimColor);
    }

    for (let k = 0; k < pairs.length; k++) {
      const [a, b] = pairs[k];
      const ao = a * 3;
      const bo = b * 3;
      const x1 = world[ao];
      const y1 = world[ao + 1];
      const x2 = world[bo];
      const y2 = world[bo + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const weight = (weights[a] + weights[b]) * 0.5;
      tempColor.copy(colorA).lerp(colorB, Math.min(1, weight * 0.85));
      tempColor.multiplyScalar(0.35 + weight * 0.75);
      setInstance(
        links,
        k,
        (x1 + x2) * 0.5,
        (y1 + y2) * 0.5,
        len,
        1.2 + weight * 3.0 + onset * 1.4,
        Math.atan2(dy, dx),
        tempColor,
      );
    }

    nodes.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
    links.instanceMatrix.needsUpdate = true;
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
    if (links.instanceColor) links.instanceColor.needsUpdate = true;
    nodeMat.uniforms.uOpacity.value = p.opacity * (0.72 + full * 0.42);
    glowMat.uniforms.uOpacity.value = p.opacity * p.glow * (0.18 + full * 0.28);
    linkMat.uniforms.uOpacity.value = p.opacity * p.lineOpacity * (0.55 + full * 0.75);
  }

  updateImpl(0, 0);

  function update(frameState) {
    let idx = Math.max(0, Math.floor(Number(frameState?.frameIdx) || 0));
    const fmax = Math.max(0, (Number(frameCount) || 0) - 1);
    if (fmax >= 0 && idx > fmax) idx = fmax;
    updateImpl(idx, Number(frameState?.elapsedSec) || 0);
  }

  function dispose() {
    geom.dispose();
    nodeMat.dispose();
    glowMat.dispose();
    linkMat.dispose();
  }

  return { object3D: group, update, dispose };
}
