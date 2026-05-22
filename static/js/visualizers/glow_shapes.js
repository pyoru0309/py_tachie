// =============================================================================
// visualizers/glow_shapes.js
//
// ネオン風に光る図形 (角丸四角 / 円 / 三角 / 星) が一定方向に流れる。
// 背景に水玉・格子・縦横ラインなどの固定模様を置ける (オプション)。
//
// 構成:
//   - 背景パターン: フルスクリーン 1 plane の ShaderMaterial
//   - パーティクル: InstancedMesh + per-instance (shapeId, color, alpha)
// 動きは「進行方向 direction を主軸とした 1D 落下」+「垂直軸の固定オフセット」。
// ランダム方向ではなく方向は固定で、速度だけ粒子ごとにばらつく。
// =============================================================================
import { clamp01, numParam } from "/static/js/visualizers/_kit.js";

const SHAPE_ID = { square: 0, circle: 1, triangle: 2, star: 3 };
const PATTERN_ID = { none: 0, dots: 1, grid: 2, horizontal: 3, vertical: 4 };
const TAU = Math.PI * 2;

function lcg(seed) {
  let s = (Number(seed) | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

function _lineWidthRange(p) {
  const legacy = p.lineWidth != null ? numParam(p.lineWidth, null) : null;
  const legacyValid = Number.isFinite(legacy) ? legacy : null;
  const minRaw = numParam(p.lineWidthMin, legacyValid != null ? legacyValid : 0.05);
  const maxRaw = numParam(p.lineWidthMax, legacyValid != null ? legacyValid : 0.14);
  let lwMin = Math.max(0.005, Math.min(0.5, minRaw));
  let lwMax = Math.max(0.005, Math.min(0.5, maxRaw));
  if (lwMax < lwMin) lwMax = lwMin;
  return { lineWidthMin: lwMin, lineWidthMax: lwMax };
}

function normalizeParams(rawParams) {
  const p = rawParams || {};
  const minSize = Math.max(2, numParam(p.minSize, 40));
  const maxSize = Math.max(minSize, numParam(p.maxSize, 140));
  let minAlpha = clamp01(numParam(p.minAlpha, 0.85));
  let maxAlpha = clamp01(numParam(p.maxAlpha, 1.0));
  if (maxAlpha < minAlpha) maxAlpha = minAlpha;
  const shapesRaw = String(p.shapes || "all").toLowerCase();
  const shapes = (shapesRaw === "all" || SHAPE_ID[shapesRaw] != null) ? shapesRaw : "all";
  const bgPatternRaw = String(p.bgPattern || "none").toLowerCase();
  const bgPattern = PATTERN_ID[bgPatternRaw] != null ? bgPatternRaw : "none";
  return {
    shapes,
    direction: numParam(p.direction, 65),
    baseSpeed: Math.max(0, numParam(p.baseSpeed, 70)),
    speedJitter: clamp01(numParam(p.speedJitter, 0.4)),
    count: Math.max(1, Math.min(400, Math.round(numParam(p.count, 28)))),
    minSize,
    maxSize,
    color1: String(p.color1 || "#ffe66d"),
    color2: String(p.color2 || "#ff5dcd"),
    color3: String(p.color3 || "#5ab7ff"),
    color4: String(p.color4 || "#7cf4a2"),
    // 旧 `lineWidth` は新 min/max のフォールバック値として使う (旧シーン互換)。
    ..._lineWidthRange(p),
    glowSoftness: clamp01(numParam(p.glowSoftness, 0.55)),
    rotationSpeed: numParam(p.rotationSpeed, 0),
    twinkleSpeed: Math.max(0, numParam(p.twinkleSpeed, 0.6)),
    minAlpha,
    maxAlpha,
    seed: Math.max(0, Math.round(numParam(p.seed, 11))),
    bgPattern,
    bgColor: String(p.bgColor || "#1a1740"),
    bgColorOpacity: clamp01(numParam(p.bgColorOpacity, 0)),
    patternColor: String(p.patternColor || "#5fa9ff"),
    patternOpacity: clamp01(numParam(p.patternOpacity, 0.7)),
    patternSize: Math.max(0.5, numParam(p.patternSize, 4)),
    patternSpacing: Math.max(4, numParam(p.patternSpacing, 28)),
    opacity: clamp01(numParam(p.opacity, 1.0)),
  };
}

function buildParticles(p, width, height, dirX, dirY, perpX, perpY, span, perpSpan) {
  const rand = lcg(p.seed);
  const palette = [p.color1, p.color2, p.color3, p.color4];

  // 「全種類ミックス」では LCG の特定 stride で偏りが出るのを避けるため、
  // 各形状を count/4 個ずつ均等に割り当ててから Fisher-Yates でシャッフルする。
  // count が 4 で割り切れないときも、最大で 1 個差以内に収まる。
  let shapeIds;
  if (p.shapes === "all") {
    shapeIds = new Array(p.count);
    for (let i = 0; i < p.count; i++) shapeIds[i] = i % 4;
    for (let i = shapeIds.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = shapeIds[i];
      shapeIds[i] = shapeIds[j];
      shapeIds[j] = tmp;
    }
  } else {
    const fixed = SHAPE_ID[p.shapes] ?? 0;
    shapeIds = new Array(p.count).fill(fixed);
  }

  const list = [];
  for (let i = 0; i < p.count; i++) {
    const size = p.minSize + rand() * (p.maxSize - p.minSize);
    const speedMul = 1 - p.speedJitter + rand() * p.speedJitter * 2;
    const phase = rand();
    const perpOffset = (rand() - 0.5) * perpSpan;
    const colorIdx = Math.floor(rand() * palette.length) % palette.length;
    const lineWidth = p.lineWidthMin + rand() * (p.lineWidthMax - p.lineWidthMin);
    list.push({
      size,
      speed: p.baseSpeed * Math.max(0.1, speedMul),
      phase,
      perpOffset,
      colorHex: palette[colorIdx],
      shapeId: shapeIds[i],
      lineWidth,
      rotation0: rand() * TAU,
      twinkleFreq: p.twinkleSpeed * (0.4 + rand() * 1.4),
      twinklePhase: rand() * TAU,
      baseAlpha: p.minAlpha + rand() * (p.maxAlpha - p.minAlpha),
      alphaAmp: (p.maxAlpha - p.minAlpha) * 0.5,
    });
  }
  return list;
}

function colorVec3(THREE, hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

// 共通 SDF 関数群 (Inigo Quilez 流)。中心 (0,0), 外接円ほぼ r。
const SDF_GLSL = `
float sdRoundedBox(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdCircle(vec2 p, float r) {
  return length(p) - r;
}
float sdEquilateralTriangle(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) {
    p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994374947, -0.587785252292473);
  const vec2 k2 = vec2(-0.809016994374947, -0.587785252292473);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
`;

function createParticleMaterial(THREE, p) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uOpacity: { value: p.opacity },
      uGlowSoftness: { value: p.glowSoftness },
    },
    vertexShader: `
      attribute float aInstShapeId;
      attribute vec3 aInstColor;
      attribute float aInstAlpha;
      attribute float aInstLineWidth;
      varying vec2 vUv;
      varying float vShapeId;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vLineWidth;
      void main() {
        vUv = uv;
        vShapeId = aInstShapeId;
        vColor = aInstColor;
        vAlpha = aInstAlpha;
        vLineWidth = aInstLineWidth;
        vec4 transformed = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        transformed = instanceMatrix * transformed;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * transformed;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform float uGlowSoftness;
      varying vec2 vUv;
      varying float vShapeId;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vLineWidth;
      ${SDF_GLSL}
      void main() {
        vec2 uv = vUv * 2.0 - 1.0;
        // 各形状を半径 ~0.7 として描画 (周囲に glow 余白)
        float d;
        if (vShapeId < 0.5) {
          d = sdRoundedBox(uv, vec2(0.7), 0.18);
        } else if (vShapeId < 1.5) {
          d = sdCircle(uv, 0.72);
        } else if (vShapeId < 2.5) {
          // 三角は外接円に対し縦に少し縮むので係数調整
          d = sdEquilateralTriangle(uv * 1.05, 0.72);
        } else {
          d = sdStar5(uv, 0.85, 0.42);
        }
        float ad = abs(d);
        // 線の中心が一番明るく、vLineWidth 外で fade out
        float line = 1.0 - smoothstep(vLineWidth * 0.5, vLineWidth, ad);
        // 外側 glow (ガウシアン的減衰)
        float gk = mix(18.0, 3.0, uGlowSoftness);
        float glow = exp(-ad * gk);
        float a = max(line, glow * (0.35 + uGlowSoftness * 0.45));
        if (a <= 0.002) discard;
        // 線の中心は白に寄せて「ネオン管」っぽくする
        vec3 col = mix(vColor, vec3(1.0), line * 0.55);
        gl_FragColor = vec4(col, a * vAlpha * uOpacity);
      }
    `,
  });
}

function createBackgroundMaterial(THREE, p, width, height) {
  const bgColor = colorVec3(THREE, p.bgColor);
  const pColor = colorVec3(THREE, p.patternColor);
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uBgColor: { value: bgColor },
      uBgColorOpacity: { value: p.bgColorOpacity },
      uPatternColor: { value: pColor },
      uPatternOpacity: { value: p.patternOpacity },
      uPatternSize: { value: p.patternSize },
      uPatternSpacing: { value: p.patternSpacing },
      uPattern: { value: PATTERN_ID[p.bgPattern] },
      uOpacity: { value: p.opacity },
      uResolution: { value: new THREE.Vector2(width, height) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uBgColor;
      uniform float uBgColorOpacity;
      uniform vec3 uPatternColor;
      uniform float uPatternOpacity;
      uniform float uPatternSize;
      uniform float uPatternSpacing;
      uniform int uPattern;
      uniform float uOpacity;
      uniform vec2 uResolution;
      varying vec2 vUv;
      void main() {
        vec2 pixel = vUv * uResolution;
        float pattern = 0.0;
        float spacing = max(2.0, uPatternSpacing);
        float sz = max(0.5, uPatternSize);
        if (uPattern == 1) {
          // 水玉: 各セルの中心に円
          vec2 cell = mod(pixel, spacing) - spacing * 0.5;
          float dist = length(cell);
          pattern = 1.0 - smoothstep(sz * 0.5 - 1.0, sz * 0.5 + 1.0, dist);
        } else if (uPattern == 2) {
          // 格子: 縦横の細線
          vec2 cell = mod(pixel + spacing * 0.5, spacing) - spacing * 0.5;
          float lx = 1.0 - smoothstep(sz * 0.5 - 0.5, sz * 0.5 + 0.5, abs(cell.x));
          float ly = 1.0 - smoothstep(sz * 0.5 - 0.5, sz * 0.5 + 0.5, abs(cell.y));
          pattern = max(lx, ly);
        } else if (uPattern == 3) {
          float cy = mod(pixel.y + spacing * 0.5, spacing) - spacing * 0.5;
          pattern = 1.0 - smoothstep(sz * 0.5 - 0.5, sz * 0.5 + 0.5, abs(cy));
        } else if (uPattern == 4) {
          float cx = mod(pixel.x + spacing * 0.5, spacing) - spacing * 0.5;
          pattern = 1.0 - smoothstep(sz * 0.5 - 0.5, sz * 0.5 + 0.5, abs(cx));
        }
        vec3 col = uBgColor;
        float base = uBgColorOpacity;
        float pAlpha = pattern * uPatternOpacity;
        col = mix(col, uPatternColor, pAlpha / max(0.0001, base + pAlpha));
        float a = max(base, pAlpha);
        if (a <= 0.001) discard;
        gl_FragColor = vec4(col, a * uOpacity);
      }
    `,
  });
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, cutStartSec } = ctx;
  const p = normalizeParams(params);

  // 進行方向ベクトル
  const angleRad = (p.direction * Math.PI) / 180;
  const dirX = Math.cos(angleRad);
  const dirY = Math.sin(angleRad);
  const perpX = -dirY;
  const perpY = dirX;

  // 進行軸に画面を投影した長さ + 余白 (粒子サイズ × 2)
  const span = Math.abs(width * dirX) + Math.abs(height * dirY) + p.maxSize * 4;
  const perpSpan = Math.abs(width * perpX) + Math.abs(height * perpY) + p.maxSize * 2;

  const particles = buildParticles(p, width, height, dirX, dirY, perpX, perpY, span, perpSpan);

  const root = new THREE.Object3D();
  root.frustumCulled = false;

  // --- 背景パターン (uPattern == 0 のときは描画 plane を作らない) ---
  let bgMesh = null;
  let bgGeom = null;
  let bgMat = null;
  if (p.bgPattern !== "none" || p.bgColorOpacity > 0) {
    bgMat = createBackgroundMaterial(THREE, p, width, height);
    bgGeom = new THREE.PlaneGeometry(width, height);
    bgMesh = new THREE.Mesh(bgGeom, bgMat);
    bgMesh.position.set(width / 2, height / 2, 0);
    bgMesh.frustumCulled = false;
    root.add(bgMesh);
  }

  // --- パーティクル ---
  const geom = new THREE.PlaneGeometry(1, 1);
  const shapeIdArr = new Float32Array(p.count);
  const colorArr = new Float32Array(p.count * 3);
  const alphaArr = new Float32Array(p.count);
  const lineWidthArr = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const a = particles[i];
    shapeIdArr[i] = a.shapeId;
    const c = new THREE.Color(a.colorHex);
    colorArr[i * 3 + 0] = c.r;
    colorArr[i * 3 + 1] = c.g;
    colorArr[i * 3 + 2] = c.b;
    alphaArr[i] = a.baseAlpha;
    lineWidthArr[i] = a.lineWidth;
  }
  const shapeAttr = new THREE.InstancedBufferAttribute(shapeIdArr, 1);
  const colorAttr = new THREE.InstancedBufferAttribute(colorArr, 3);
  const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
  const lineWidthAttr = new THREE.InstancedBufferAttribute(lineWidthArr, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("aInstShapeId", shapeAttr);
  geom.setAttribute("aInstColor", colorAttr);
  geom.setAttribute("aInstAlpha", alphaAttr);
  geom.setAttribute("aInstLineWidth", lineWidthAttr);

  const material = createParticleMaterial(THREE, p);
  const mesh = new THREE.InstancedMesh(geom, material, p.count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  root.add(mesh);

  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _zAxis = new THREE.Vector3(0, 0, 1);
  const _scale = new THREE.Vector3();
  const rotSpeedRad = (p.rotationSpeed * Math.PI) / 180;

  function updateImpl(sceneSec) {
    const t = Number(sceneSec) || 0;
    for (let i = 0; i < p.count; i++) {
      const a = particles[i];
      // 進行軸上の位置 (0..span) を mod で wrap
      const raw = t * a.speed + a.phase * span;
      const cycle = ((raw % span) + span) % span;
      const dPos = cycle - span / 2;       // -span/2..span/2
      const cx = width / 2 + dirX * dPos + perpX * a.perpOffset;
      const cy = height / 2 + dirY * dPos + perpY * a.perpOffset;
      const rot = a.rotation0 + t * rotSpeedRad;
      let alpha = a.baseAlpha + a.alphaAmp * Math.sin(t * a.twinkleFreq + a.twinklePhase);
      if (alpha < p.minAlpha) alpha = p.minAlpha;
      else if (alpha > p.maxAlpha) alpha = p.maxAlpha;
      _pos.set(cx, cy, 0);
      _scale.set(a.size, a.size, 1);
      _quat.setFromAxisAngle(_zAxis, rot);
      _mat.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _mat);
      alphaArr[i] = alpha;
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.needsUpdate = true;
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
    if (bgGeom) bgGeom.dispose();
    if (bgMat) bgMat.dispose();
  }

  return { object3D: root, update, dispose };
}
