// =============================================================================
// visualizers/floating_particles.js
//
// _kit.js の使い方デモ用の最小サンプル。
//   - createCanvasPlane で plane を 1 行で生成
//   - hexToRgba / numParam / clamp01 で param パース
//   - sliceStreamRow / readStreamScalar で int8 圧縮 stream を 1 行で読む
//   - dispose は disposeCanvasPlane に任せる
//
// 動作: シード固定の N 粒子がふわふわ漂い、low (kick) で大きく拍動、high で点滅、
// onset 山で外側へ短く弾ける。
// =============================================================================
import {
  createCanvasPlane,
  disposeCanvasPlane,
  numParam,
  clamp01,
  hexToRgba,
  sliceStreamRow,
  readStreamScalar,
} from "/static/js/visualizers/_kit.js";

const TAU = Math.PI * 2;

// 32-bit LCG (deterministic、param.seed で粒子配置を再現可能に)。
function lcg(seed) {
  let s = (Number(seed) | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

function buildParticles(count, width, height, seed) {
  const rand = lcg(seed);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      hx: rand() * width,                    // home X
      hy: rand() * height,                   // home Y
      ax: 0.18 + rand() * 0.6,               // X drift 周波数
      ay: 0.16 + rand() * 0.5,               // Y drift 周波数
      px: rand() * TAU,                       // X drift 位相
      py: rand() * TAU,                       // Y drift 位相
      angle: rand() * TAU,                    // burst 方向
      sizeJitter: 0.7 + rand() * 0.6,         // 個体ごとのサイズばらつき
      mix: rand(),                            // 色 a/b ブレンド
    };
  }
  return out;
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, streamMeta, frameCount } = ctx;
  const plane = createCanvasPlane(THREE, width, height);
  const c2d = plane.c2d;

  // params 正規化 (numParam で 0 を有効値として扱う)。
  function normalize() {
    const p = params || {};
    return {
      color: String(p.color || "#9be7ff"),
      accent: String(p.accentColor || "#ffd166"),
      count: Math.max(1, Math.min(240, Math.round(numParam(p.particleCount, 80)))),
      baseSize: Math.max(1, numParam(p.baseSize, 14)),
      drift: Math.max(0, numParam(p.drift, 60)),
      burst: Math.max(0, numParam(p.burst, 140)),
      reactivity: Math.max(0, numParam(p.reactivity, 1.1)),
      seed: Math.max(0, Math.round(numParam(p.seed, 7))),
      opacity: clamp01(numParam(p.opacity, 0.85)),
    };
  }
  let p = normalize();
  let particles = buildParticles(p.count, width, height, p.seed);

  // stream meta は dev_tools / scene-builder が共通で渡してくれる。
  // sliceStreamRow / readStreamScalar が scale/offset 込みで復号する。
  const energyStream = streamMeta?.energy ?? null;
  const onsetStream = streamMeta?.onset ?? null;
  const energyBuf = new Float32Array(4);   // 行切り出しの再利用バッファ

  let lastFrameIdx = -1;
  let lastParamsKey = "";

  function paramsKey(p) {
    return [p.color, p.accent, p.count, p.baseSize, p.drift, p.burst,
            p.reactivity, p.seed, p.opacity].join("|");
  }

  function renderInto(frameIdx, elapsedSec) {
    c2d.clearRect(0, 0, width, height);
    if (p.opacity <= 0) return;

    // [full, lo, mid, hi] と onset を 1 行で取り出す。
    const energy = sliceStreamRow(energyStream, frameIdx, 4, energyBuf);
    const full = energy[0] || 0;
    const lo = energy[1] || 0;
    const hi = energy[3] || 0;
    const onset = readStreamScalar(onsetStream, frameIdx, 0);

    const tsec = Number(elapsedSec) || 0;
    const burstAmt = onset * p.burst * (0.6 + p.reactivity * 0.4);
    const sizePulse = 1 + lo * p.reactivity * 1.2;
    const flicker = 0.8 + hi * 0.4;

    for (let i = 0; i < particles.length; i++) {
      const q = particles[i];
      // ふわふわ: 2 軸の sin の和。位相と周波数は粒子ごとに微妙に違う。
      const dx = Math.sin(tsec * q.ax + q.px) * p.drift;
      const dy = Math.cos(tsec * q.ay + q.py) * p.drift * 0.85;
      // burst: onset の山で各粒子が自分の angle 方向へ短く飛ぶ。
      const bx = Math.cos(q.angle + i * 0.13) * burstAmt;
      const by = Math.sin(q.angle + i * 0.13) * burstAmt;
      const x = q.hx + dx + bx;
      const y = q.hy + dy + by;

      const radius = p.baseSize * q.sizeJitter * sizePulse * (0.9 + full * 0.4);
      // glow (柔らかい大きい円) → core (はっきり小さい円) の 2 段。
      const baseColor = q.mix < 0.5 ? p.color : p.accent;
      c2d.fillStyle = hexToRgba(baseColor, p.opacity * 0.18 * flicker);
      c2d.beginPath();
      c2d.arc(x, y, radius * 2.2, 0, TAU);
      c2d.fill();
      c2d.fillStyle = hexToRgba(baseColor, p.opacity * 0.85 * flicker);
      c2d.beginPath();
      c2d.arc(x, y, radius, 0, TAU);
      c2d.fill();
    }
    plane.texture.needsUpdate = true;
  }

  function update(frameState) {
    const np = normalize();
    const key = paramsKey(np);
    // count / seed が変わったら粒子配列を作り直す。それ以外は数値だけ差し替え。
    if (np.count !== p.count || np.seed !== p.seed) {
      particles = buildParticles(np.count, width, height, np.seed);
    }
    p = np;
    let idx = Math.max(0, Math.floor(Number(frameState?.frameIdx) || 0));
    const fmax = Math.max(0, (Number(frameCount) || 0) - 1);
    if (fmax >= 0 && idx > fmax) idx = fmax;
    // 同じ frame & 同じ params なら redraw skip (CanvasTexture upload は重い)
    if (idx === lastFrameIdx && key === lastParamsKey) return;
    lastFrameIdx = idx;
    lastParamsKey = key;
    renderInto(idx, Number(frameState?.elapsedSec) || 0);
  }

  // 初期 1 frame は焼いておく (透明のまま render される事故を防ぐ)
  update({ frameIdx: 0, elapsedSec: 0 });

  function dispose() { disposeCanvasPlane(plane); }
  return { object3D: plane.mesh, update, dispose };
}
