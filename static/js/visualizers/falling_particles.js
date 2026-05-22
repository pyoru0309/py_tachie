// =============================================================================
// visualizers/falling_particles.js
//
// 星屑 / 雪 / 雨のパーティクルが降る (or 浮遊する) ビジュアライザ。背景は透過。
//
// 1 つの InstancedMesh (PlaneGeometry 1x1) を per-instance scale + alpha で描画。
// 形状はフラグメントシェーダ内で uShape 分岐:
//   0 = star: 中心の明るい点 + 4 本の cross flare (キラキラ)
//   1 = snow: 中心が濃い柔らかい円
//   2 = rain: 縦長 scale + 細い縦線
//
// 位置は sceneSec の closed-form (mod 計算で wrap)。乱数シードで再現可能。
// =============================================================================
import {
  clamp01,
  numParam,
} from "/static/js/visualizers/_kit.js";

const TAU = Math.PI * 2;

function lcg(seed) {
  let s = (Number(seed) | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

const SHAPE_INDEX = { star: 0, snow: 1, rain: 2 };

function normalizeParams(rawParams) {
  const p = rawParams || {};
  const minSize = Math.max(0.5, numParam(p.minSize, 4));
  const maxSize = Math.max(minSize, numParam(p.maxSize, 22));
  let minAlpha = clamp01(numParam(p.minAlpha, 0.3));
  let maxAlpha = clamp01(numParam(p.maxAlpha, 1.0));
  if (maxAlpha < minAlpha) maxAlpha = minAlpha;
  const shapeRaw = String(p.shape || "star").toLowerCase();
  const shape = SHAPE_INDEX[shapeRaw] != null ? shapeRaw : "star";
  const directionRaw = String(p.direction || "down").toLowerCase();
  const direction = directionRaw === "up" ? "up" : "down";
  return {
    shape,
    direction,
    angle: Math.max(-89, Math.min(89, numParam(p.angle, 0))),
    color: String(p.color || "#ffffff"),
    count: Math.max(1, Math.min(400, Math.round(numParam(p.count, 80)))),
    minSize,
    maxSize,
    fallSpeed: Math.max(0, numParam(p.fallSpeed, 60)),
    swayAmp: Math.max(0, numParam(p.swayAmp, 60)),
    swaySpeed: Math.max(0, numParam(p.swaySpeed, 0.4)),
    minAlpha,
    maxAlpha,
    twinkleSpeed: Math.max(0, numParam(p.twinkleSpeed, 2.0)),
    seed: Math.max(0, Math.round(numParam(p.seed, 42))),
    opacity: clamp01(numParam(p.opacity, 1.0)),
  };
}

function buildParticles(p, width, height) {
  const rand = lcg(p.seed);
  const list = [];
  for (let i = 0; i < p.count; i++) {
    const size = p.minSize + rand() * (p.maxSize - p.minSize);
    const hx = rand() * width;
    const phaseY = rand();                 // 落下サイクル内の位相 (0..1)
    const swayPhase = rand() * TAU;
    const swayFreq = p.swaySpeed * (0.6 + rand() * 0.8);
    const baseAlpha = p.minAlpha + rand() * (p.maxAlpha - p.minAlpha);
    const twinkleFreq = p.twinkleSpeed * (0.5 + rand() * 1.5);
    const twinklePhase = rand() * TAU;
    list.push({
      hx,
      size,
      phaseY,
      swayFreq,
      swayPhase,
      baseAlpha,
      alphaAmp: (p.maxAlpha - p.minAlpha) * 0.5,
      twinkleFreq,
      twinklePhase,
    });
  }
  return list;
}

function shapeScale(shape, size) {
  // 雨だけ縦長。star / snow は正方形。
  if (shape === "rain") return { sx: Math.max(1.5, size * 0.18), sy: size * 5 };
  return { sx: size, sy: size };
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, cutStartSec } = ctx;
  const p = normalizeParams(params);
  const particles = buildParticles(p, width, height);

  const geom = new THREE.PlaneGeometry(1, 1);
  const alphaArr = new Float32Array(p.count);
  const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("aInstAlpha", alphaAttr);

  const colorC = new THREE.Color(p.color);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uColor: { value: new THREE.Vector3(colorC.r, colorC.g, colorC.b) },
      uOpacity: { value: p.opacity },
      uShape: { value: SHAPE_INDEX[p.shape] },
    },
    vertexShader: `
      attribute float aInstAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = aInstAlpha;
        vec4 transformed = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        transformed = instanceMatrix * transformed;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * transformed;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform int uShape;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec2 uv = vUv * 2.0 - 1.0;
        float r = length(uv);
        float a = 0.0;
        if (uShape == 0) {
          // 星屑: 中心ドット + 縦横 cross flare。
          float core = 1.0 - smoothstep(0.0, 0.18, r);
          float armX = (1.0 - smoothstep(0.0, 0.05, abs(uv.y)))
                     * (1.0 - smoothstep(0.55, 1.0, abs(uv.x)));
          float armY = (1.0 - smoothstep(0.0, 0.05, abs(uv.x)))
                     * (1.0 - smoothstep(0.55, 1.0, abs(uv.y)));
          a = max(core, max(armX, armY) * 0.85);
        } else if (uShape == 1) {
          // 雪: 中心が濃く外側がふんわり消える円。
          if (r >= 1.0) discard;
          float disk = 1.0 - smoothstep(0.0, 1.0, r);
          a = pow(disk, 1.6);
        } else {
          // 雨: 縦長 scale 内の細い縦線。両端 (y=±1) でフェード。
          float across = 1.0 - smoothstep(0.0, 1.0, abs(uv.x));
          float along = 1.0 - smoothstep(0.5, 1.0, abs(uv.y));
          a = across * along;
        }
        if (a <= 0.001) discard;
        gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geom, material, p.count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;

  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _identQuat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();

  const root = new THREE.Object3D();
  root.add(mesh);
  root.frustumCulled = false;

  // 落下サイクルの全長。最大サイズの分だけ画面外に余白を取って端で消失感を出す。
  const distSpan = height + p.maxSize * 4;
  // 雨は物理的に左右に揺れない (重力で真下に落ちる) ので swayAmp を無効化。
  const effectiveSway = p.shape === "rain" ? 0 : p.swayAmp;
  // 傾き: y 進行量に応じて x を tan(angle) 倍ずらす (= 風で流される降雨)。
  // y-down 座標系で angle 正のとき右下に流す。
  const angleRad = (p.angle * Math.PI) / 180;
  const tanAngle = Math.tan(angleRad);
  // 雨粒は線そのものを angle だけ傾ける (粒の長軸が流線方向を向くように)。
  // それ以外の形状 (星屑/雪) はパーティクル自身を回転しても見栄えが変わらない
  // (snow は等方、star の cross flare は回転で方角が変わってしまう) ので回転しない。
  //
  // y-down カメラ (OrthographicCamera top=0 / bottom=H) では projection で Y が
  // 反転されるため、world で z+ 回転を入れると画面上は反時計回りに見える。
  // slopeX は angle>0 で「右下に流れる (\)」方向に作用するので、plane の長軸も
  // 同じ \ 向きにするには Z 軸回転の符号を反転して clockwise に回す必要がある。
  const _rainQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), -angleRad,
  );
  const useRainRotation = p.shape === "rain";

  function updateImpl(sceneSec) {
    const t = Number(sceneSec) || 0;
    for (let i = 0; i < p.count; i++) {
      const a = particles[i];
      // y 位相: 各パーティクルが独自タイミングで画面外 → 画面内 → 画面外
      const raw = t * p.fallSpeed + a.phaseY * distSpan;
      // 正の mod (JS の % は負の値を返しうる)
      const cycle = ((raw % distSpan) + distSpan) % distSpan;
      let y = -a.size * 2 + cycle;            // -size*2 .. (height + size*2)
      if (p.direction === "up") y = height - y;
      // 風 (angle) で y 進行に比例した水平オフセットを与える。h/2 を基準に
      // することで画面中央の x は変化しないため、見た目の偏りが出にくい。
      const slopeX = (y - height / 2) * tanAngle;
      const x = a.hx + Math.sin(t * a.swayFreq + a.swayPhase) * effectiveSway + slopeX;
      let alpha = a.baseAlpha + a.alphaAmp * Math.sin(t * a.twinkleFreq + a.twinklePhase);
      if (alpha < p.minAlpha) alpha = p.minAlpha;
      else if (alpha > p.maxAlpha) alpha = p.maxAlpha;
      const { sx, sy } = shapeScale(p.shape, a.size);
      _pos.set(x, y, 0);
      _scale.set(sx, sy, 1);
      _mat.compose(_pos, useRainRotation ? _rainQuat : _identQuat, _scale);
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
  }

  return { object3D: root, update, dispose };
}
