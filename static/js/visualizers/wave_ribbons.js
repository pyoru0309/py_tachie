// =============================================================================
// visualizers/wave_ribbons.js
//
// ジオメトリックな背景ウェーブ。複数の斜めリボンが緩やかに波打って重なる。
//
// フルスクリーン 1 plane + ShaderMaterial。各リボンは「中心点 + 角度 + 幅」と
// 「波長 / 振幅 / 位相 / 不透明度」の vec4 ペアで uniform 配列として渡し、
// fragment shader 内で N 本を順次合成する (over blending)。
//
// 位相は phase = phase0 + speed * sceneSec で一定速度に進むだけなので、
// シーク・書き出しでも同じフレームを再現する。音や BPM には連動しない。
// =============================================================================
import { clamp01, numParam } from "/static/js/visualizers/_kit.js";

const MAX_RIBBONS = 16;
const TAU = Math.PI * 2;

function lcg(seed) {
  let s = (Number(seed) | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

function normalizeParams(rawParams) {
  const p = rawParams || {};
  const minW = Math.max(10, numParam(p.minWidth, 220));
  const maxW = Math.max(minW, numParam(p.maxWidth, 620));
  return {
    baseColor: String(p.baseColor || "#0a3aab"),
    highlightColor: String(p.highlightColor || "#5cb3ff"),
    shadowColor: String(p.shadowColor || "#02195a"),
    ribbonCount: Math.max(1, Math.min(MAX_RIBBONS, Math.round(numParam(p.ribbonCount, 6)))),
    baseAngle: numParam(p.baseAngle, 24),
    angleSpread: Math.max(0, numParam(p.angleSpread, 6)),
    minWidth: minW,
    maxWidth: maxW,
    amplitude: Math.max(0, numParam(p.amplitude, 240)),
    wavelength: Math.max(50, numParam(p.wavelength, 1400)),
    speed: Math.max(0, numParam(p.speed, 0.25)),
    highlightRatio: clamp01(numParam(p.highlightRatio, 0.6)),
    ribbonOpacity: clamp01(numParam(p.ribbonOpacity, 0.4)),
    edgeSoftness: Math.max(0.05, Math.min(1, numParam(p.edgeSoftness, 0.65))),
    seed: Math.max(0, Math.round(numParam(p.seed, 7))),
    opacity: clamp01(numParam(p.opacity, 1.0)),
  };
}

function buildRibbons(p, width, height) {
  const rand = lcg(p.seed);
  const list = [];
  for (let i = 0; i < p.ribbonCount; i++) {
    const cx = (rand() - 0.5) * width * 0.6 + width / 2;
    // 縦方向は画面外 (-0.4h..1.4h) まで散らす。
    const cy = (rand() * 1.8 - 0.4) * height;
    const angleDeg = p.baseAngle + (rand() - 0.5) * 2 * p.angleSpread;
    const angle = (angleDeg * Math.PI) / 180;
    const wavelength = p.wavelength * (0.6 + rand() * 0.8);
    const amplitude = p.amplitude * (0.5 + rand() * 1.0);
    const widthPx = p.minWidth + rand() * (p.maxWidth - p.minWidth);
    const phase0 = rand() * TAU;
    // ハイライト / シャドウ振り分け
    const useHighlight = rand() < p.highlightRatio;
    const colorHex = useHighlight ? p.highlightColor : p.shadowColor;
    const opacity = p.ribbonOpacity * (0.7 + rand() * 0.6);
    list.push({
      cx,
      cy,
      angle,
      wavelength,
      amplitude,
      widthPx,
      phase0,
      colorHex,
      opacity,
    });
  }
  return list;
}

function colorVec3(THREE, hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, cutStartSec } = ctx;
  const p = normalizeParams(params);
  const ribbons = buildRibbons(p, width, height);

  // 16 個分の vec4 / vec3 uniform を毎フレーム位相だけ更新する。
  const geomArr = new Array(MAX_RIBBONS);
  const waveArr = new Array(MAX_RIBBONS);
  const colorArr = new Array(MAX_RIBBONS);
  for (let i = 0; i < MAX_RIBBONS; i++) {
    geomArr[i] = new THREE.Vector4(0, 0, 0, 0);
    waveArr[i] = new THREE.Vector4(0, 0, 0, 0);
    colorArr[i] = new THREE.Vector3(0, 0, 0);
  }
  for (let i = 0; i < p.ribbonCount; i++) {
    const r = ribbons[i];
    geomArr[i].set(r.cx, r.cy, r.angle, r.widthPx);
    waveArr[i].set(r.wavelength, r.amplitude, r.phase0, r.opacity);
    const c = new THREE.Color(r.colorHex);
    colorArr[i].set(c.r, c.g, c.b);
  }

  const baseColor = colorVec3(THREE, p.baseColor);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uBaseColor: { value: baseColor },
      uRibbonCount: { value: p.ribbonCount },
      uEdgeSoftness: { value: p.edgeSoftness },
      uOpacity: { value: p.opacity },
      uResolution: { value: new THREE.Vector2(width, height) },
      uRibbonGeom: { value: geomArr },
      uRibbonWave: { value: waveArr },
      uRibbonColor: { value: colorArr },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      #define MAX_RIBBONS ${MAX_RIBBONS}
      uniform vec3 uBaseColor;
      uniform int uRibbonCount;
      uniform float uEdgeSoftness;
      uniform float uOpacity;
      uniform vec2 uResolution;
      uniform vec4 uRibbonGeom[MAX_RIBBONS];   // (cx, cy, angle, width)
      uniform vec4 uRibbonWave[MAX_RIBBONS];   // (wavelength, amplitude, phase, opacity)
      uniform vec3 uRibbonColor[MAX_RIBBONS];
      varying vec2 vUv;

      void main() {
        vec2 pixel = vUv * uResolution;
        vec3 col = uBaseColor;
        for (int i = 0; i < MAX_RIBBONS; i++) {
          if (i >= uRibbonCount) break;
          vec4 g = uRibbonGeom[i];
          vec4 w = uRibbonWave[i];
          vec3 rc = uRibbonColor[i];
          // リボン中心点からの相対座標を、リボン軸 (tangent) と垂直軸 (normal) に投影
          float a = g.z;
          vec2 tangent = vec2(cos(a), sin(a));
          vec2 normal = vec2(-sin(a), cos(a));
          vec2 d = pixel - g.xy;
          float tProj = dot(d, tangent);
          // 中心線を sin で波打たせる
          float waveOffset = sin(tProj / max(50.0, w.x) + w.z) * w.y;
          float nDist = abs(dot(d, normal) - waveOffset);
          float halfW = g.w * 0.5;
          // ソフトエッジ: edgeSoftness=0 で hard、=1 でハーフ幅全体が fade
          float edge = halfW * uEdgeSoftness;
          float mask = 1.0 - smoothstep(halfW - edge, halfW + edge, nDist);
          col = mix(col, rc, mask * w.w);
        }
        gl_FragColor = vec4(col, uOpacity);
      }
    `,
  });

  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(width / 2, height / 2, 0);
  mesh.frustumCulled = false;

  const root = new THREE.Object3D();
  root.add(mesh);
  root.frustumCulled = false;

  function updateImpl(sceneSec) {
    const t = Number(sceneSec) || 0;
    // 位相だけが時間で進む。他のリボン属性は固定。
    for (let i = 0; i < p.ribbonCount; i++) {
      const r = ribbons[i];
      const phase = r.phase0 + t * p.speed;
      // waveArr[i] = (wavelength, amplitude, phase, opacity)
      waveArr[i].z = phase;
    }
  }

  updateImpl(0);

  function update(frameState) {
    const sceneSecRaw = Number(frameState?.sceneSec);
    const sceneSec = Number.isFinite(sceneSecRaw)
      ? sceneSecRaw
      : (Number(cutStartSec) || 0) + (Number(frameState?.elapsedSec) || 0);
    updateImpl(sceneSec);
  }

  function dispose() {
    geom.dispose();
    material.dispose();
  }

  return { object3D: root, update, dispose };
}
