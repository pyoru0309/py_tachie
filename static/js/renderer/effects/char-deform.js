// =============================================================================
// renderer/effects/char-deform.js
//
// キャラ板の頂点変形 (dev_docs/plans/character-deform.md)。キャラ本体 (under / eye /
// mouth / over) と光彩・影の tint plane が同じ GLSL と uniform を持ち、同じ変形を受ける。
//
// 座標はキャラのローカル座標 (板の中心が原点、+y が下 = Y-down カメラの world と同じ向き)。
// tint plane は padding 分だけ大きいが中心は同じなので、同じ式がそのまま当たる
// (影の offset は plane.position 側なので、ローカル座標には入らない)。
//
// 部分伸縮 (Phase A):
//   基準線 anchor より下は動かない。anchor〜top は anchor からの距離が (1 + k) 倍、
//   top より上は形を保って top と同じだけ平行移動。横は (1 - volume·k·w) 倍。
//   w(y) は「伸縮範囲にどれだけ入っているか」の重みで、境目を smoothstep 帯でつなぐ。
//   帯は範囲の内側 (基準線の上 2·band / 上端の下 2·band) に置くので、基準線より下と
//   上端より上は厳密に動かない / 形が変わらない。
//   縦の変位は -k · ∫_y^anchor w(u) du。smoothstep の積分は解析的に出せ、
//   2 つの帯が重ならなければ w = w_anchor + w_top - 1 なので、変位も閉じた式になる。
//
// 揺れピン (Phase B):
//   変位 = Σ 揺れピン { 向き·振れ幅 × falloff(u) × 波(φ) } × (1 - max 固定ピン falloff) × 強さ
//   u = 距離 / 半径、falloff = (1 - u²)²、φ = ωt + 位相 - 1.2u (外側ほど遅れて、なびく)、
//   波 = sin φ + 0.25 sin(2.3φ + 1.3)。揺らしてから部分伸縮を掛ける。
//   光彩・影の板は左右反転 Group の外にあるので、uPinFlipX = -1 で x と向きを反転して当てる。
//
// 同じ式の JS 版が static/js/char-deform-math.js (回帰テスト)。式を変えるときは両方を揃える。
// =============================================================================
import * as THREE from "three";

export const CHAR_DEFORM_MAX_PINS = 16;

export const CHAR_DEFORM_GLSL = /* glsl */ `
  uniform float uDeformOn;      // 0 = 部分伸縮なし (従来どおり)
  uniform float uStretchK;      // 伸縮率 - 1 (+ で伸びる)
  uniform float uStretchAnchor; // 基準線 (ローカル y, px)
  uniform float uStretchTop;    // 上端 (ローカル y, px)。uStretchHasTop=0 なら未使用
  uniform float uStretchHasTop;
  uniform float uStretchBand;   // 境目のなめらか帯の半幅 (px)
  uniform float uStretchVolume; // 体積の保持 0..1
  uniform float uPinCount;      // 0 = 揺れピンなし
  uniform vec4 uPinA[${CHAR_DEFORM_MAX_PINS}];    // x, y (ローカル px), 半径 px, 種類 (0 = 揺れ / 1 = 固定)
  uniform vec4 uPinB[${CHAR_DEFORM_MAX_PINS}];    // 振れ x, 振れ y (px), ω (rad/s), 位相 (rad)
  uniform float uSwayTime;      // シーン通算秒
  uniform float uSwayStrength;  // カット側の強さ (0 = 止める)
  uniform float uPinFlipX;      // 1 / -1 (左右反転の外にある光彩・影の板は -1)

  vec2 charSway(vec2 p) {
    if (uPinCount < 0.5 || uSwayStrength == 0.0) return vec2(0.0);
    vec2 d = vec2(0.0);
    float fixedW = 0.0;
    for (int i = 0; i < ${CHAR_DEFORM_MAX_PINS}; i++) {
      if (float(i) >= uPinCount) break;
      vec4 a = uPinA[i];
      float u = length(p - vec2(a.x * uPinFlipX, a.y)) / a.z;
      if (u >= 1.0) continue;
      float f = 1.0 - u * u;
      f *= f;
      if (a.w > 0.5) {
        fixedW = max(fixedW, f);
        continue;
      }
      vec4 b = uPinB[i];
      float ph = uSwayTime * b.z + b.w - 1.2 * u;
      float wave = sin(ph) + 0.25 * sin(2.3 * ph + 1.3);
      d += vec2(b.x * uPinFlipX, b.y) * (f * wave);
    }
    return d * uSwayStrength * (1.0 - fixedW);
  }

  // ∫_lo^y smoothstep(lo, hi, u) du
  float charDeformSsInt(float lo, float hi, float y) {
    if (y <= lo) return 0.0;
    float len = hi - lo;
    if (y >= hi) return len * 0.5 + (y - hi);
    float t = (y - lo) / len;
    return len * (t * t * t - 0.5 * t * t * t * t);
  }

  vec2 charDeform(vec2 p0) {
    vec2 p = p0 + charSway(p0);
    if (uDeformOn < 0.5 || uStretchK == 0.0) return p;
    float b = uStretchBand;
    float a0 = uStretchAnchor - 2.0 * b;
    float a1 = uStretchAnchor;
    float wA = 1.0 - smoothstep(a0, a1, p.y);
    // ∫_y^A (1 - S_a) - ... を「S_a の積分」と「S_t の積分」に分けて求める。
    float dist = -(charDeformSsInt(a0, a1, a1) - charDeformSsInt(a0, a1, p.y));
    float w = wA;
    if (uStretchHasTop > 0.5) {
      float t0 = uStretchTop;
      float t1 = uStretchTop + 2.0 * b;
      dist += charDeformSsInt(t0, t1, a1) - charDeformSsInt(t0, t1, p.y);
      w = wA + smoothstep(t0, t1, p.y) - 1.0;
    } else {
      dist += a1 - p.y;
    }
    float sx = 1.0 - uStretchVolume * uStretchK * w;
    return vec2(p.x * sx, p.y - uStretchK * dist);
  }
`;

export function createDeformUniforms() {
  return {
    uDeformOn: { value: 0 },
    uStretchK: { value: 0 },
    uStretchAnchor: { value: 0 },
    uStretchTop: { value: 0 },
    uStretchHasTop: { value: 0 },
    uStretchBand: { value: 1 },
    uStretchVolume: { value: 0 },
    uPinCount: { value: 0 },
    uPinA: { value: Array.from({ length: CHAR_DEFORM_MAX_PINS }, () => new THREE.Vector4()) },
    uPinB: { value: Array.from({ length: CHAR_DEFORM_MAX_PINS }, () => new THREE.Vector4()) },
    uSwayTime: { value: 0 },
    uSwayStrength: { value: 1 },
    uPinFlipX: { value: 1 },
  };
}

// 板を格子に割った PlaneGeometry。部分伸縮は行ごとに線形なので横 1 分割で足りるが、
// 揺れピンは 2D の変形なので、ピンのあるキャラだけ横も割る (withPins)。
export const CHAR_DEFORM_SEGMENTS_Y = 256;
export const CHAR_DEFORM_SEGMENTS_X_PINS = 64;
export function createDeformablePlaneGeometry(width, height, withPins = false) {
  return new THREE.PlaneGeometry(
    width, height, withPins ? CHAR_DEFORM_SEGMENTS_X_PINS : 1, CHAR_DEFORM_SEGMENTS_Y,
  );
}

// キャラ定義の deform.stretch (比率) + 板の高さ (px) → シェーダー用の固定パラメータ。
// 既定 (未定義) は足元基準・上端なし = 全身の伸縮。
export function resolveStretchRegion(rawStretch, layerHeight) {
  const h = Math.max(1, Number(layerHeight) || 1);
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const anchorY = Math.max(0, Math.min(1, num(rawStretch?.anchorY, 1)));
  const topRaw = rawStretch?.topY;
  const hasTop = topRaw != null && Number.isFinite(Number(topRaw)) && Number(topRaw) < anchorY;
  const topY = hasTop ? Math.max(0, Number(topRaw)) : 0;
  const volume = Math.max(0, Math.min(1, num(rawStretch?.volume, 0.5)));
  const anchor = (anchorY - 0.5) * h;
  const top = (topY - 0.5) * h;
  // 帯の半幅は高さの 1.5% (最低 2px)。2 つの帯 (各 2·band) が重ならないよう頭打ち。
  let band = Math.max(2, h * 0.015);
  band = Math.min(band, Math.max(0.5, (anchor - top) / (hasTop ? 4 : 2)));
  // 上端 (上端なしなら頭頂) が動く量 = k × 重みの積分。振幅 px をこれで割って k を出す。
  const regionHeight = Math.max(1, anchor - top - (hasTop ? 2 : 1) * band);
  return { anchor, top, hasTop, volume, band, regionHeight };
}

// stretchDy (px、+ が下 = 縮む。上端が何 px 動くか) → uniform に反映。
// scale はキャラ group の拡大率 (motion zoom)。ローカル座標に直すために割る。
export function applyStretchToMaterials(materials, region, stretchDy, scale = 1) {
  const dy = Number(stretchDy) || 0;
  const s = Number(scale) > 0 ? Number(scale) : 1;
  let k = region ? -(dy / s) / region.regionHeight : 0;
  // 裏返り・極端な伸びを防ぐ。
  k = Math.max(-0.6, Math.min(1.5, k));
  const on = region && k !== 0 ? 1 : 0;
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u?.uDeformOn) continue;
    u.uDeformOn.value = on;
    u.uStretchK.value = k;
    if (!region) continue;
    u.uStretchAnchor.value = region.anchor;
    u.uStretchTop.value = region.top;
    u.uStretchHasTop.value = region.hasTop ? 1 : 0;
    u.uStretchBand.value = region.band;
    u.uStretchVolume.value = region.volume;
  }
}

// キャラ定義の deform.pins (比率) + 板のサイズ (px) → シェーダー用の uniform 値。
// ピンが無ければ null。振れ幅は半径に対する比 (0〜0.4) で、絵が折り返さない範囲に収める。
export function resolveSwayPins(rawPins, layerWidth, layerHeight) {
  if (!Array.isArray(rawPins) || !rawPins.length) return null;
  const w = Math.max(1, Number(layerWidth) || 1);
  const h = Math.max(1, Number(layerHeight) || 1);
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const pins = [];
  for (const raw of rawPins.slice(0, CHAR_DEFORM_MAX_PINS)) {
    if (!raw || typeof raw !== "object") continue;
    const radius = Math.max(1, num(raw.radius, 0.08) * h);
    const fixed = raw.kind === "fixed";
    const amp = fixed ? 0 : Math.max(0, Math.min(0.4, num(raw.amount, 0.15))) * radius;
    const angle = (num(raw.angleDeg, 0) * Math.PI) / 180;
    const period = Math.max(0.2, num(raw.periodSec, 2));
    pins.push({
      a: [(num(raw.x, 0.5) - 0.5) * w, (num(raw.y, 0.5) - 0.5) * h, radius, fixed ? 1 : 0],
      b: [Math.cos(angle) * amp, Math.sin(angle) * amp, (2 * Math.PI) / period, num(raw.phase, 0) * 2 * Math.PI],
    });
  }
  return pins.length ? pins : null;
}

// ピンの固定値を material に書く (シーン組み立て時に 1 回)。flipX = 左右反転の外にある板。
export function applySwayPinsToMaterial(material, pins, { flipX = false } = {}) {
  const u = material?.uniforms;
  if (!u?.uPinCount) return;
  u.uPinCount.value = pins ? pins.length : 0;
  u.uPinFlipX.value = flipX ? -1 : 1;
  (pins || []).forEach((pin, i) => {
    u.uPinA.value[i].set(...pin.a);
    u.uPinB.value[i].set(...pin.b);
  });
}

// 毎フレーム: 時刻 (シーン通算秒) と強さ。
export function applySwayTimeToMaterials(materials, timeSec, strength = 1) {
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u?.uSwayTime) continue;
    u.uSwayTime.value = Number(timeSec) || 0;
    u.uSwayStrength.value = Number.isFinite(Number(strength)) ? Number(strength) : 1;
  }
}
