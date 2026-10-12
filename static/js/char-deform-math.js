// キャラ変形 (部分伸縮) の式の JS 版。描画本線は renderer/effects/char-deform.js の
// GLSL で、これは同じ式をキャラ詳細ダイアログのプレビューと回帰テスト
// (tools/check_body_bob.mjs) で使うためのもの。式を変えるときは両方を揃えること。

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(lo, hi, x) {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

function ssInt(lo, hi, y) {
  if (y <= lo) return 0;
  const len = hi - lo;
  if (y >= hi) return len * 0.5 + (y - hi);
  const t = (y - lo) / len;
  return len * (t * t * t - 0.5 * t * t * t * t);
}

// h = 絵の高さ (px)。返値: 行 y (上端 0) → { y: 変形後の行位置, sx: 横倍率 }。
export function makeDeformRow(stretch, h, k) {
  const anchorY = clamp01(Number(stretch.anchorY ?? 1));
  const hasTop = stretch.topY != null && stretch.topY < anchorY;
  const anchor = anchorY * h;
  const top = hasTop ? stretch.topY * h : 0;
  let band = Math.max(2, h * 0.015);
  band = Math.min(band, Math.max(0.5, (anchor - top) / (hasTop ? 4 : 2)));
  const volume = clamp01(Number(stretch.volume ?? 0.5));
  const a0 = anchor - 2 * band;
  const a1 = anchor;
  return (y) => {
    const wA = 1 - smoothstep(a0, a1, y);
    let dist = -(ssInt(a0, a1, a1) - ssInt(a0, a1, y));
    let w = wA;
    if (hasTop) {
      const t0 = top;
      const t1 = top + 2 * band;
      dist += ssInt(t0, t1, a1) - ssInt(t0, t1, y);
      w = wA + smoothstep(t0, t1, y) - 1;
    } else {
      dist += a1 - y;
    }
    return { y: y - k * dist, sx: 1 - volume * k * w };
  };
}

// 揺れピンの変位 (GLSL charSway と同じ式)。pins は resolveSwayPins (char-deform.js) と
// 同じ形 ({ a: [x, y, 半径, 種類], b: [振れx, 振れy, ω, 位相] }、ローカル px)。
export function swayDisplacement(pins, p, t, strength = 1, flipX = 1) {
  if (!pins?.length || strength === 0) return [0, 0];
  let dx = 0;
  let dy = 0;
  let fixedW = 0;
  for (const { a, b } of pins) {
    const u = Math.hypot(p[0] - a[0] * flipX, p[1] - a[1]) / a[2];
    if (u >= 1) continue;
    const f = (1 - u * u) ** 2;
    if (a[3] > 0.5) {
      fixedW = Math.max(fixedW, f);
      continue;
    }
    const ph = t * b[2] + b[3] - 1.2 * u;
    const wave = Math.sin(ph) + 0.25 * Math.sin(2.3 * ph + 1.3);
    dx += b[0] * flipX * f * wave;
    dy += b[1] * f * wave;
  }
  const k = strength * (1 - fixedW);
  return [dx * k, dy * k];
}
