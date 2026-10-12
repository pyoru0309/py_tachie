// =============================================================================
// visualizers/laser_beams.js
//
// ライブステージのレーザー光線。光源 (1 列目最大 8 + 2 列目最大 8) は設定位置から動かず、各光源から扇形に
// ビームが出る。扇の「向き・開き・面らしさ・明るさ・色」を光源ごとに JS で毎フレーム
// 求めて uniform に流し、フルスクリーン 1 plane の ShaderMaterial で描く。
//
// 画素ごとの計算は「光源から見た角度 → 扇の中で一番近いビーム → そのビームまでの垂直距離」
// なのでビーム数によらず O(光源数)。ビームは遠くほど少し太く (divergence) 薄く (beamLength)、
// スモークのむら (値ノイズ) で明るさがゆらぐ。
//
// 動き: 拍 = シーン秒 × BPM / 60。phraseBeats 拍ごとのフレーズで、動きのパターンと描き方
// (細いビーム / ぼんやり広がる面) を乱数シードのハッシュで選ぶ (おまかせ時)。フレーズの
// 変わり目は 1 拍かけて前のフレーズの状態から補間するので、動きは途切れない。
// すべてシーン秒だけで決まるので、シーク / 書き出しでも同じフレームになる。
// =============================================================================
import { clamp01, numParam } from "/static/js/visualizers/_kit.js";

const MAX_PER_ROW = 8;
const MAX_SOURCES = MAX_PER_ROW * 2;
const AUTO_PATTERNS = ["sweep", "cross", "breathe", "scan", "drift"];
const MOTIONS = new Set(["auto", "still", ...AUTO_PATTERNS]);
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

function normalizeParams(raw) {
  const p = raw || {};
  const pick = (value, allowed, fallback) => (allowed.includes(String(value)) ? String(value) : fallback);
  const phraseBeats = parseInt(String(p.phraseBeats || "8"), 10);
  return {
    sourceCount: Math.max(1, Math.min(MAX_PER_ROW, Math.round(numParam(p.sourceCount, 4)))),
    sourceY: numParam(p.sourceY, 140),
    sourceXStart: numParam(p.sourceXStart, 260),
    sourceXEnd: numParam(p.sourceXEnd, 1660),
    direction: numParam(p.direction, 90),
    aimSpread: numParam(p.aimSpread, 0),
    row2Count: Math.max(0, Math.min(MAX_PER_ROW, Math.round(numParam(p.row2Count, 0)))),
    row2Y: numParam(p.row2Y, 1000),
    row2XStart: numParam(p.row2XStart, 120),
    row2XEnd: numParam(p.row2XEnd, 1800),
    row2Direction: numParam(p.row2Direction, 270),
    row2AimSpread: numParam(p.row2AimSpread, -40),
    beamCount: Math.max(1, Math.min(48, Math.round(numParam(p.beamCount, 12)))),
    spread: Math.max(0, Math.min(170, numParam(p.spread, 50))),
    beamWidth: Math.max(0.3, numParam(p.beamWidth, 2.5)),
    divergence: Math.max(0, numParam(p.divergence, 0.006)),
    glow: clamp01(numParam(p.glow, 0.5)),
    beamLength: Math.max(50, numParam(p.beamLength, 1500)),
    style: pick(p.style, ["mix", "beams", "sheet"], "mix"),
    sheetRatio: clamp01(numParam(p.sheetRatio, 0.35)),
    motion: MOTIONS.has(String(p.motion)) ? String(p.motion) : "auto",
    swing: Math.max(0, numParam(p.swing, 25)),
    speed: Math.max(0.05, numParam(p.speed, 1)),
    bpm: Math.max(0, numParam(p.bpm, 0)),
    phraseBeats: [4, 8, 16, 32].includes(phraseBeats) ? phraseBeats : 8,
    beatPulse: clamp01(numParam(p.beatPulse, 0.3)),
    colors: [p.color1 || "#2f6bff", p.color2 || "#22e07a", p.color3 || "#8a3cff"],
    colorMode: pick(p.colorMode, ["source", "phrase", "rotate"], "source"),
    haze: clamp01(numParam(p.haze, 0.4)),
    hotspot: clamp01(numParam(p.hotspot, 0.6)),
    intensity: Math.max(0, numParam(p.intensity, 1)),
    blend: pick(p.blend, ["add", "normal"], "add"),
    seed: Math.max(0, Math.round(numParam(p.seed, 7))),
    opacity: clamp01(numParam(p.opacity, 1)),
  };
}

// ---- 決定的な乱数 -------------------------------------------------------------

function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// なめらかな 1D 値ノイズ (-1..1)
function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i) * 2 - 1;
  const b = hash(i + 1) * 2 - 1;
  return a + (b - a) * u;
}

function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

// ---- 光源ごとの状態 -----------------------------------------------------------

// フレーズ phrase の光源 src (i = 全体の通し番号、src.k = 列の中の番号)。
// t = 動きの時間 (拍 × 速さ)。角度は度。
function sourceState(p, phrase, src, t) {
  const i = src.index;
  const seed = p.seed * 0.618;
  const pattern = p.motion === "auto"
    ? AUTO_PATTERNS[Math.floor(hash(phrase * 3.1 + seed) * AUTO_PATTERNS.length) % AUTO_PATTERNS.length]
    : p.motion;
  const sheet = p.style === "sheet" || (p.style === "mix" && hash(phrase * 7.7 + seed + 1.3) < p.sheetRatio);
  const ph = hash(phrase * 5.3 + seed + 2.1) * TAU;
  const base = src.base;
  const bar = (beats) => (TAU * t) / beats; // beats 拍で 1 周
  let center = base;
  let spread = p.spread;
  switch (pattern) {
    case "sweep":
      center = base + p.swing * Math.sin(bar(4) + ph + i * 0.35);
      break;
    case "cross":
      // 列の中で交互に逆へ振る (列ごとに独立して交差する)
      center = base + p.swing * Math.sin(bar(4) + ph + src.row * 0.8) * (src.k % 2 ? -1 : 1);
      break;
    case "breathe":
      center = base + p.swing * 0.3 * Math.sin(bar(8) + ph + i);
      spread = p.spread * (0.15 + 0.85 * (0.5 + 0.5 * Math.sin(bar(4) + ph)));
      break;
    case "scan":
      center = base + p.swing * 1.4 * Math.sin(bar(8) + ph + i * 0.9);
      spread = p.spread * 0.12;
      break;
    case "drift":
      center = base + p.swing * noise1(t / 2 + i * 17.3 + phrase * 3.7 + seed);
      spread = p.spread * (0.45 + 0.55 * (0.5 + 0.5 * noise1(t / 3 + i * 5.1 + 99 + seed)));
      break;
    default:
      break;
  }
  let colorIndex = i % 3;
  if (p.colorMode === "phrase") colorIndex = Math.floor(hash(phrase * 2.9 + seed + 3.7) * 3) % 3;
  else if (p.colorMode === "rotate") colorIndex = (i + phrase) % 3;
  return { center, spread, fill: sheet ? 1 : 0, colorIndex };
}

// ---- シェーダー ---------------------------------------------------------------

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  #define MAX_SOURCES ${MAX_SOURCES}
  #define PI 3.14159265
  uniform vec2 uSize;
  uniform float uCount;
  uniform vec4 uSrcA[MAX_SOURCES];   // x, y, 向き (rad), 扇の開き (rad)
  uniform vec4 uSrcB[MAX_SOURCES];   // ビーム数, 面らしさ 0..1, 明るさ, -
  uniform vec3 uSrcColor[MAX_SOURCES];
  uniform float uBeamWidth;
  uniform float uDivergence;
  uniform float uGlow;
  uniform float uLength;
  uniform float uHaze;
  uniform float uHotspot;
  uniform float uTime;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uAdditive;
  varying vec2 vUv;

  float hash2(vec2 p) {
    return fract(sin(dot(p + uSeed * 0.37, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // 画面座標 (px、左上原点・下向き)。Y-down カメラなので uv.y = 1 が画面下。
    vec2 P = vec2(vUv.x * uSize.x, vUv.y * uSize.y);
    // スモークのむら: ゆっくり流れる 2 オクターブの値ノイズ
    float smoke = vnoise(P * 0.004 + vec2(uTime * 0.06, uTime * 0.02)) * 0.65
      + vnoise(P * 0.011 - vec2(uTime * 0.04, 0.0)) * 0.35;
    float smokeMul = 1.0 - uHaze * 0.75 + uHaze * 0.75 * smoke * 1.4;

    vec3 acc = vec3(0.0);
    for (int i = 0; i < MAX_SOURCES; i++) {
      if (float(i) >= uCount) break;
      vec4 A = uSrcA[i];
      vec4 B = uSrcB[i];
      vec2 d = P - A.xy;
      float r = length(d);
      float ang = atan(d.y, d.x);
      float da = mod(ang - A.z + PI, 2.0 * PI) - PI;
      float n = B.x;
      float sp = A.w;
      // 一番近いビームとの角度差
      float dd = da;
      if (n > 1.5) {
        float stepA = sp / (n - 1.0);
        float k = clamp(floor(da / max(stepA, 1e-5) + (n - 1.0) * 0.5 + 0.5), 0.0, n - 1.0);
        dd = da - (k - (n - 1.0) * 0.5) * stepA;
      }
      float pd = r * abs(sin(dd));
      float w = uBeamWidth + r * uDivergence;
      float front = step(0.0, cos(dd));
      float core = exp(-(pd * pd) / (w * w));
      float halo = exp(-pd / (w * 7.0)) * uGlow * 0.35;
      float beam = (core + halo) * front;
      // ぼんやり広がる面: 扇の内側をやわらかく塗り、ビームの筋をうっすら残す
      float halfA = sp * 0.5;
      float mask = 1.0 - smoothstep(halfA * 0.55, halfA + 0.08, abs(da));
      float sheet = mask * (0.22 + 0.35 * core) * step(0.0, cos(da));
      float v = mix(beam, sheet, B.y);
      float fall = exp(-r / uLength);
      // 光源の輝き (中心の白っぽい点 + 周りのにじみ)
      float hotR = 10.0 + 26.0 * uHotspot;
      float hot = (exp(-(r * r) / (hotR * hotR)) * 1.6 + exp(-r / 70.0) * 0.25) * uHotspot;
      vec3 col = uSrcColor[i];
      acc += col * (v * fall * smokeMul) * B.z + mix(col, vec3(1.0), 0.6) * hot * B.z;
    }
    acc *= uOpacity;
    if (uAdditive > 0.5) {
      gl_FragColor = vec4(acc, 1.0);
    } else {
      float a = clamp(max(acc.r, max(acc.g, acc.b)), 0.0, 1.0);
      gl_FragColor = vec4(a > 0.0001 ? acc / a : vec3(0.0), a);
    }
    #include <colorspace_fragment>
  }
`;

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, cutStartSec, sceneBpm } = ctx;
  const p = normalizeParams(params);
  const sceneBpmNum = Number(sceneBpm) || 0;
  const bpm = p.bpm > 0 ? p.bpm : (sceneBpmNum > 0 ? sceneBpmNum : 120);
  const colors = p.colors.map((hex) => {
    try {
      return new THREE.Color(hex);
    } catch (_err) {
      return new THREE.Color("#ffffff");
    }
  });

  // 光源の位置は固定 (列ごとに左端〜右端へ等間隔)。base = その光源の基本の向き (度)。
  const rows = [
    { count: p.sourceCount, y: p.sourceY, x0: p.sourceXStart, x1: p.sourceXEnd, dir: p.direction, aim: p.aimSpread },
    { count: p.row2Count, y: p.row2Y, x0: p.row2XStart, x1: p.row2XEnd, dir: p.row2Direction, aim: p.row2AimSpread },
  ];
  const sources = [];
  rows.forEach((row, r) => {
    for (let k = 0; k < row.count; k += 1) {
      const u = row.count > 1 ? k / (row.count - 1) : 0.5;
      sources.push({
        index: sources.length,
        row: r,
        k,
        x: row.x0 + (row.x1 - row.x0) * u,
        y: row.y,
        base: row.dir + row.aim * (u - 0.5),
      });
    }
  });

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: p.blend === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uSize: { value: new THREE.Vector2(width, height) },
      uCount: { value: sources.length },
      uSrcA: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
      uSrcB: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
      uSrcColor: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Color()) },
      uBeamWidth: { value: p.beamWidth },
      uDivergence: { value: p.divergence },
      uGlow: { value: p.glow },
      uLength: { value: p.beamLength },
      uHaze: { value: p.haze },
      uHotspot: { value: p.hotspot },
      uTime: { value: 0 },
      uSeed: { value: p.seed },
      uOpacity: { value: p.opacity },
      uAdditive: { value: p.blend === "add" ? 1 : 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(width / 2, height / 2, 0);
  mesh.frustumCulled = false;
  const root = new THREE.Object3D();
  root.add(mesh);
  root.frustumCulled = false;

  const tmpColor = new THREE.Color();
  function updateImpl(sceneSec) {
    const u = material.uniforms;
    const beat = (Math.max(0, sceneSec) * bpm) / 60;
    const t = beat * p.speed;
    const phrase = Math.floor(beat / p.phraseBeats);
    const inPhrase = beat - phrase * p.phraseBeats;
    // フレーズの変わり目は 1 拍かけて前のフレーズから補間する (最初のフレーズは補間しない)。
    const w = phrase > 0 ? smoothstep01(inPhrase) : 1;
    const beatFrac = beat - Math.floor(beat);
    const pulse = (1 - p.beatPulse) + p.beatPulse * Math.exp(-beatFrac * 5);
    u.uTime.value = sceneSec;
    sources.forEach((src, i) => {
      const cur = sourceState(p, phrase, src, t);
      const prev = w < 1 ? sourceState(p, phrase - 1, src, t) : cur;
      const mix = (a, b) => a + (b - a) * w;
      u.uSrcA.value[i].set(src.x, src.y, mix(prev.center, cur.center) * DEG, mix(prev.spread, cur.spread) * DEG);
      u.uSrcB.value[i].set(p.beamCount, mix(prev.fill, cur.fill), p.intensity * pulse, 0);
      tmpColor.copy(colors[prev.colorIndex]).lerp(colors[cur.colorIndex], w);
      u.uSrcColor.value[i].copy(tmpColor);
    });
  }

  updateImpl(Number(cutStartSec) || 0);

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
