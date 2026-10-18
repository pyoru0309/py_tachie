// =============================================================================
// renderer/effects/aura.js
//
// キャラのオーラ (dev_docs/plans/character-aura.md Phase A)。
//
// 入力は光彩・影と同じ「キャラの輪郭 RT」を size でぼかした「場」(uField、alpha 0..1)。
// 板は silhouette と同じ大きさ (padding 込み)・同じ中心なので、vUv がそのまま場の uv。
// vUv.y = 0 が上 (Y-down カメラ + 場の RT の向きは tint plane と同じ)。
//
//   flame: 場を、上へ流れる値ノイズでずらして読み、ノイズを掛けた値をしきい値で切って
//          炎の舌を作る。下からサンプルする量 (uRise) を増やすと上へ伸びる。
//          uOutward を上げると、伸ばす向きが真上から体の輪郭の外向き (法線方向) へ移り、
//          ゆらぎも体から外へ放射状に流れる (鋭い筋も体の周りに放射状に並ぶ)。
//   glow : 場をそのまま使い、ゆっくり明滅させる。
//   spike: 細い三角の光の筋がまっすぐ上へ伸び、筋ごとに長さがばらばらに伸び縮みする
//          (鋭いオーラ)。筋の中心ほど下からサンプルする量を増やして、先を尖らせる。
//
// 体との間隔 (margin): 場は「間隔 + 広がり」でぼかしてあり、ガウスぼかしの式
// (直線の縁で f(d) = 0.5·erfc(d / (σ√2))) から、間隔の位置の値 uFMargin と外側の端の値
// uFOuter を JS で求めて渡す。シェーダーは場の値を remap() で「間隔 0・ぼかし = 広がり」の
// ときと同じ尺度に直してから形を作り、間隔の内側 (場の値 > uFMargin) は描かない。
//
// 体に近いほど uColor、先端ほど uColor2。加算合成 (出力 alpha = 1、rgb に明るさを掛ける)。
// 頂点は char-deform.js の変形 (部分伸縮 / 揺れピン) を光彩・影と同じく受ける。
// =============================================================================
import * as THREE from "three";
import { CHAR_DEFORM_GLSL, createDeformUniforms, createDeformablePlaneGeometry } from "./char-deform.js";

const VERT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vWorldXY;
  ${CHAR_DEFORM_GLSL}
  void main() {
    vUv = uv;
    vec3 pos = vec3(charDeform(position.xy), position.z);
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldXY = wp.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uField;    // 輪郭をぼかした場 (alpha)
  uniform vec2 uSize;          // 板の大きさ (px)
  uniform vec3 uColor;         // 内側の色
  uniform vec3 uColor2;        // 外側 (先端) の色
  uniform float uStyle;        // 0 = flame, 1 = glow, 2 = spike
  uniform float uSizePx;       // 広がる幅 (px)
  uniform float uRise;         // 立ちのぼり (size の倍率)
  uniform float uOutward;      // 外へ広がる割合: 0 = 真上 / 1 = 体の中心から放射状
  uniform float uDensity;      // 鋭い筋の本数の倍率 (小さいほど少なく太い)
  uniform float uLines;        // 1 = 集中線の板 (上に塗る合成)
  uniform vec3 uLineColor;
  uniform float uLineProb;     // 集中線の箇所が出る確率 (箇所の数 / 並びの区画数)
  uniform float uIntensity;    // 明るさ × 口パク連動の明るさ × 前面の割合
  uniform float uSpeed;
  uniform float uDetail;       // 0..1
  uniform float uTime;         // シーン通算秒
  uniform float uSeed;
  uniform vec4 uClipRect;      // x, y, w, h (world)。w<=0 なら切らない
  uniform float uFront;        // 1 = キャラの前に重ねる板 (体の内側は光らせない)
  uniform float uFMargin;      // 体との間隔の位置の場の値
  uniform float uFOuter;       // オーラの外側の端の場の値
  uniform float uMarginOn;     // 1 = 間隔の内側を抜く
  varying vec2 vUv;
  varying vec2 vWorldXY;

  float hash2(vec2 p) {
    return fract(sin(dot(p + uSeed * 0.731, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
               mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.1, 9.3);
      a *= 0.5;
    }
    return v;
  }

  // 場の値を「間隔 0・ぼかし = 広がり」のときの尺度 (縁 0.5、外側の端 ≒ 0.023) に直す。
  float remap(float f) {
    return clamp(0.023 + 0.477 * (f - uFOuter) / max(uFMargin - uFOuter, 1e-4), 0.0, 1.0);
  }

  void main() {
    if (uClipRect.z > 0.0 && uClipRect.w > 0.0) {
      if (vWorldXY.x < uClipRect.x || vWorldXY.x > uClipRect.x + uClipRect.z
          || vWorldXY.y < uClipRect.y || vWorldXY.y > uClipRect.y + uClipRect.w) {
        discard;
      }
    }
    vec2 p = vUv * uSize;                       // px (y 下向き)
    float s = max(uSizePx, 4.0);
    float t = uTime * uSpeed;
    // ノイズの粒の大きさ: detail 0 → 幅の 1.6 倍、1 → 0.4 倍
    float cell = s * mix(1.6, 0.4, uDetail);
    float a;
    float inner;
    float raw0 = texture2D(uField, vUv).a;
    float f0 = remap(raw0);
    // 伸ばす向き。炎・鋭い筋は「伸ばしたい向きの反対側から場を拾う」ことで伸びる。
    // 「放射の中心」vc をキャラの中心の真下 D の所に置き、vc から外へ伸ばす (= vc の方から拾う)。
    // 外へ広がる割合 o が小さいほど vc は遠く (D 大) → ほぼ平行に真上、o = 1 で vc = 中心 → 放射状。
    // o に応じて開き角が連続的に広がる。ゆらぎ・筋の並びの座標 P も vc まわりの (弧の長さ, 距離) に揃える
    // (o → 0 で (x, y) に一致するので、0% のときは従来と同じ)。
    float rref = max(uSize.x, uSize.y) * 0.35;
    vec2 sdir = vec2(0.0, 1.0);
    vec2 P = p;
    if (uOutward > 0.001) {
      float D = rref * (1.0 / max(uOutward, 0.02) - 1.0);
      vec2 rel2 = p - (uSize * 0.5 + vec2(0.0, D));
      float rlen = max(length(rel2), 1e-3);
      sdir = -rel2 / rlen;
      P = vec2(atan(rel2.x, -rel2.y) * (D + rref), D - rlen);
    }
    vec2 sperp = vec2(-sdir.y, sdir.x);
    if (uLines > 0.5) {
      // 集中線: 同じ向きの細い線を、狭い範囲 (箇所) にまとめて出す。箇所と線は約 1/3 秒ごとに入れ替わる。
      float slot = floor(t * 3.0);
      float clusterW = s * 2.5;
      float cpos = P.x / clusterW;
      float cid = floor(cpos);
      float act = step(hash2(vec2(cid, slot + 77.0)), uLineProb);
      float cf = fract(cpos);
      float edge = smoothstep(0.0, 0.2, cf) * smoothstep(1.0, 0.8, cf);
      float pitch = max(4.0, s * 0.16);
      float lx = P.x / pitch;
      float lid = floor(lx);
      float present = step(0.4, hash2(vec2(lid, slot + 5.0)));
      float len = s * uRise * (0.9 + 2.2 * hash2(vec2(lid, slot + 9.0)));
      float fS = remap(texture2D(uField, (p + sdir * len) / uSize).a);
      // 根元 (帯に近い) ほど太く、先へ行くほど細い
      float reach = smoothstep(0.1, 0.45, fS);
      float halfW = (0.35 + 0.9 * reach) / pitch;
      float line = 1.0 - smoothstep(halfW * 0.6, halfW * 1.4, abs(fract(lx) - 0.5));
      float la = line * reach * present * act * edge;
      if (uMarginOn > 0.5) la *= 1.0 - smoothstep(uFMargin * 0.55, uFMargin, raw0);
      la *= 1.0 - smoothstep(0.55, 0.85, f0);  // 体の上には出さない
      gl_FragColor = vec4(uLineColor, clamp(la * uIntensity, 0.0, 1.0));
      #include <colorspace_fragment>
      return;
    }
    if (uStyle > 1.5) {
      // 鋭い: 幅の違う 3 層の「筋」を重ねる。筋は横に細い三角で、中心ほど下からサンプルする
      // 量 (= 上へ伸びる長さ) が大きいので先が尖る。長さは筋ごと・時間ごとの乱数をなめらかに補間。
      float sp = 0.0;
      float core = 0.0;
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float colW = s * mix(1.5, 0.55, uDetail) * (1.0 + fk * 0.5) / max(uDensity, 0.05);
        float x = P.x / colW + fk * 0.37;
        float id = floor(x);
        float fr = fract(x);
        float jit = (hash2(vec2(id, fk + 5.0)) - 0.5) * 0.4;
        float tri = clamp(1.0 - abs((fr - 0.5 - jit) * 2.0), 0.0, 1.0);
        float sharp = pow(tri, 1.6 + 0.6 * fk);
        float tt = t * (1.2 + hash2(vec2(id, fk + 9.0)) * 1.6) + hash2(vec2(id, fk + 3.0)) * 10.0;
        float k0 = floor(tt);
        float len = mix(hash2(vec2(id, k0 + fk * 31.0)), hash2(vec2(id, k0 + 1.0 + fk * 31.0)),
                        smoothstep(0.0, 1.0, fract(tt)));
        float L = s * uRise * (0.3 + 1.7 * len * len);
        float fS = remap(texture2D(uField, (p + sdir * (L * sharp)) / uSize).a);
        float v = smoothstep(0.12, 0.45, fS) * sharp * (1.0 - fk * 0.2);
        // 筋の周りのやわらかいにじみ
        float halo = smoothstep(0.1, 0.45, fS) * pow(tri, 1.2) * 0.16 * (1.0 - fk * 0.3);
        sp = max(sp, max(v, halo));
        core = max(core, v * sharp);
      }
      a = sp * 1.25;
      // 帯そのもの (筋の根元) はごく薄く (強いと間隔の内側が暗く見える)
      a = max(a, smoothstep(0.35, 0.8, f0) * 0.06);
      a *= 0.85 + 0.15 * vnoise(vec2(t * 9.0, P.x / s));
      inner = clamp(core * 1.6 + smoothstep(0.5, 0.95, f0) * 0.5, 0.0, 1.0);
    } else if (uStyle < 0.5) {
      // 炎: 縦に引き伸ばしたノイズが上へ流れる (サンプル位置の y に時間を足すと模様は上へ動く)
      vec2 q = vec2(P.x / cell, P.y / (cell * 2.2) + t * 1.4);
      float n1 = fbm(q);
      float n2 = fbm(vec2(P.x / (cell * 0.55), P.y / (cell * 1.3) + t * 2.3) + 7.0);
      // 下からサンプルして上へ伸ばす。n1 で伸び方をばらつかせて炎の舌にする
      float lift = s * uRise * pow(n1, 1.5) * 1.8;
      vec2 off = sdir * lift + sperp * ((n2 - 0.5) * s * 0.5);
      float f = remap(texture2D(uField, (p + off) / uSize).a);
      float v = f * (0.35 + 1.25 * n2);
      float tongue = smoothstep(0.14, 0.55, v);
      // 先端 (場の薄い所) ほど透ける
      a = tongue * (0.3 + 0.7 * smoothstep(0.08, 0.6, f));
      // 体のすぐ外側 (間隔があればその外側) の根元の光 (控えめ)
      a = max(a, smoothstep(0.3, 0.75, f0) * 0.45);
      // ちらつき
      a *= 0.82 + 0.18 * vnoise(vec2(t * 7.0, P.y / cell));
      inner = smoothstep(0.3, 0.9, max(f0, f * 0.8));
    } else {
      // 発光: 場をそのまま、ゆっくり明滅 + うっすらゆらぎ
      vec2 q = p / cell + vec2(0.0, t * 0.4);
      float pulse = 0.78 + 0.22 * sin(t * 2.4);
      a = smoothstep(0.02, 0.6, f0) * pulse * (0.85 + 0.3 * fbm(q));
      inner = smoothstep(0.4, 0.95, f0);
    }
    if (uMarginOn > 0.5) {
      // 体との間隔の内側は描かない。縁は急に切らず、外へ向かってなだらかに出す
      // (急に切ると、周りだけ明るくなって人の形の暗い穴に見える)。
      a *= 1.0 - smoothstep(uFMargin * 0.55, uFMargin, raw0);
    }
    if (uFront > 0.5) {
      // 前面は体の内側を抑え、縁にかかる炎だけを残す
      float body = texture2D(uField, vUv).a;
      a *= 1.0 - smoothstep(0.45, 0.8, body);
    }
    vec3 col = mix(uColor2, uColor, inner);
    // 根元は白っぽく (加算で飛びすぎない程度)
    if (uFront < 0.5) col = mix(col, vec3(1.0), inner * inner * 0.15);
    gl_FragColor = vec4(col * a * uIntensity, 1.0);
    #include <colorspace_fragment>
  }
`;

function createAuraMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uField: { value: null },
      uSize: { value: new THREE.Vector2(1, 1) },
      uColor: { value: new THREE.Color("#ffe14a") },
      uColor2: { value: new THREE.Color("#ff9d1a") },
      uStyle: { value: 0 },
      uSizePx: { value: 40 },
      uRise: { value: 1.5 },
      uOutward: { value: 0 },
      uDensity: { value: 1 },
      uLines: { value: 0 },
      uLineColor: { value: new THREE.Color("#000000") },
      uLineProb: { value: 0 },
      uIntensity: { value: 0 },
      uSpeed: { value: 1 },
      uDetail: { value: 0.5 },
      uTime: { value: 0 },
      uSeed: { value: 0 },
      uClipRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFront: { value: 0 },
      uFMargin: { value: 0.5 },
      uFOuter: { value: 0.023 },
      uMarginOn: { value: 0 },
      ...createDeformUniforms(),
    },
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
    // Y-down カメラの裏面カリング対策 (scene-builder.js makeMaterial と同じ)。
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
}

// オーラの設定 (カットのキャラ設定 aura) の正規化。無効なら null。
export function normalizeAura(raw) {
  if (!raw || typeof raw !== "object" || !raw.enabled) return null;
  const num = (v, fallback, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  return {
    style: ["glow", "spike"].includes(raw.style) ? raw.style : "flame",
    color: typeof raw.color === "string" && raw.color ? raw.color : "#ffe14a",
    color2: typeof raw.color2 === "string" && raw.color2 ? raw.color2 : "#ff9d1a",
    size: num(raw.size, 40, 4, 300),
    margin: num(raw.margin, 0, 0, 400),
    rise: num(raw.rise, 1.5, 0, 6),
    // 伸ばす向き: 0 = 真上 (炎のように) / 1 = 体の輪郭の外向き
    outward: num(raw.outward, 0, 0, 1),
    // 鋭い筋の本数の倍率 (0.2〜3)
    density: num(raw.density, 1, 0.2, 3),
    // 集中線: 箇所の数 (0 = 出さない) と色
    lineCount: Math.round(num(raw.lineCount, 0, 0, 8)),
    lineColor: typeof raw.lineColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.lineColor) ? raw.lineColor : "#000000",
    intensity: num(raw.intensity, 1, 0, 3),
    speed: num(raw.speed, 1, 0, 20),
    detail: num(raw.detail, 0.5, 0, 1),
    front: num(raw.front, 0.15, 0, 1),
    when: raw.when === "speaking" ? "speaking" : "always",
    fadeSec: num(raw.fadeSec, 0.3, 0, 5),
  };
}

// オーラが必要とする silhouette の余白 (間隔 + 幅 + 立ちのぼり分)。
export function auraPadding(cfg) {
  if (!cfg) return 0;
  const reach = cfg.margin + cfg.size;
  const rise = cfg.style === "spike" ? cfg.size * cfg.rise * 2 : (cfg.style === "flame" ? cfg.size * cfg.rise * 1.8 : 0);
  return Math.ceil(reach * 1.6 + rise + 8);
}

// 場を作るぼかしの量 (gaussian-blur.js の blurPx、σ = blurPx / 2)。間隔の外まで届かせる。
export function auraBlurPx(cfg) {
  return cfg.margin + cfg.size;
}

// 相補誤差関数 (Abramowitz-Stegun 7.1.26 系の近似、誤差 1e-7 程度)。
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// 直線の縁を σ でぼかしたとき、縁から外へ d px の位置の場の値。
function fieldAt(d, sigma) {
  return 0.5 * erfc(d / (sigma * Math.SQRT2));
}

// 後ろ用 (キャラより奥) と前用 (キャラの上に薄く) の 2 枚を作る。front = 0 なら前用は作らない。
export function createAuraMeshes(width, height, cfg, { withPins = false, seed = 0 } = {}) {
  const make = (front, lines = false) => {
    const material = createAuraMaterial();
    const u = material.uniforms;
    u.uFront.value = front ? 1 : 0;
    if (lines) {
      // 集中線は黒も出せるよう「上に塗る」合成
      material.blending = THREE.NormalBlending;
      u.uLines.value = 1;
      u.uLineColor.value.set(cfg.lineColor);
      // 箇所の数 → 並びの区画 (幅 = 広がり × 2.5) ごとに出る確率。並びの全長は、真上なら板の幅、
      // 放射状なら中心まわりの周 (2π × 0.35 × 板の長辺) を目安に混ぜる。
      const along = width * (1 - cfg.outward) + 2 * Math.PI * Math.max(width, height) * 0.35 * cfg.outward;
      u.uLineProb.value = Math.min(1, cfg.lineCount / Math.max(1, along / (cfg.size * 2.5)));
    }
    u.uSize.value.set(width, height);
    u.uColor.value.set(cfg.color);
    u.uColor2.value.set(cfg.color2);
    u.uStyle.value = cfg.style === "glow" ? 1 : (cfg.style === "spike" ? 2 : 0);
    const sigma = Math.max(1, auraBlurPx(cfg) / 2);
    u.uFMargin.value = fieldAt(cfg.margin, sigma);
    u.uFOuter.value = fieldAt(cfg.margin + cfg.size, sigma);
    u.uMarginOn.value = cfg.margin > 0 ? 1 : 0;
    u.uSizePx.value = cfg.size;
    u.uRise.value = cfg.rise;
    u.uOutward.value = cfg.outward;
    u.uDensity.value = cfg.density;
    u.uSpeed.value = cfg.speed;
    u.uDetail.value = cfg.detail;
    u.uSeed.value = seed;
    const mesh = new THREE.Mesh(createDeformablePlaneGeometry(width, height, withPins), material);
    mesh.frustumCulled = false;
    mesh.visible = false; // 場ができてから見せる
    return mesh;
  };
  return {
    back: make(false),
    front: cfg.front > 0 ? make(true) : null,
    lines: cfg.lineCount > 0 ? make(false, true) : null,
  };
}

// 毎フレーム: 時刻と明るさ (intensity × 口パク連動の level)。
export function updateAuraMeshes(aura, { timeSec, level }) {
  const set = (mesh, value) => {
    if (!mesh) return;
    const u = mesh.material.uniforms;
    u.uTime.value = timeSec;
    u.uIntensity.value = value;
    mesh.visible = !!u.uField.value && level > 0.001;
  };
  set(aura.back, aura.cfg.intensity * level);
  set(aura.front, aura.cfg.intensity * level * aura.cfg.front);
  // 集中線は不透明度として使う (明るさの設定には連動させない)
  set(aura.lines, Math.min(1, level));
}

export function setAuraField(aura, texture) {
  for (const mesh of [aura.back, aura.front, aura.lines]) {
    if (mesh) mesh.material.uniforms.uField.value = texture;
  }
}
