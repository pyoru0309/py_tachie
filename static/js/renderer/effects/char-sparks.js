// =============================================================================
// renderer/effects/char-sparks.js
//
// キャラの特殊効果 Phase B: 雷と光の筋 (dev_docs/plans/character-aura.md)。
//
// 座標はキャラのローカル座標 (キャラ group の原点 = 絵の中心、+y が下)。メッシュは
// 左右反転 Group の外 (光彩・影・オーラと同じ group 直下) に置くので、輪郭の点は
// 反転済みの向きで作る。形は時刻 (シーン通算秒) と乱数シードだけで決まるので、
// シーク / 書き出しで同じ絵になる。
//
//   輪郭の点: キャラの絵を小さく縮めて透明度を読み、縁のマスの中心と外向きの法線を拾う。
//   雷     : 枠 (本数ぶん) ごとに「光る時間 + 次に光るまでの間」で繰り返し光る。外へ伸びる形と、
//            体に沿って曲がる形 (くの字、両端が体に向く) がある。輪郭の点から外へ、
//            大きく角ばった折れ線に枝と途切れを足し、太さを大きく変えたリボンにする。
//            中央が太く両端が尖る形、太い白い芯 + 細い色の帯 + 薄いグロー (加算)。伸びながら出る。
//   光の筋 : インスタンスごとに x・開始の高さ・速さ・長さ・位相を決め、頂点シェーダーで
//            時刻から位置を出して上へ流す (先端が明るく、尾は消える)。
// どちらも後ろ用 (キャラより奥) と前用 (キャラより手前) の 2 枚。加算合成。
// =============================================================================
import * as THREE from "three";

const OUTLINE_COLS = 48;
const MAX_BOLTS = 60;
const MAIN_LEVELS = 4;      // 2^4 + 1 = 17 点 (大きく角ばった折れ線)
const BRANCH_LEVELS = 3;    // 2^3 + 1 = 9 点
const MAX_BRANCHES = 4;
// 1 本 = 本体 + 枝 (途切れで 2 本に分かれる分と、両端のグロー延長 2 点ずつを見込む)
const POINTS_PER_BOLT = (2 ** MAIN_LEVELS + 1 + 8) + MAX_BRANCHES * (2 ** BRANCH_LEVELS + 1 + 4);
const MAX_STREAKS = 60;

// ---- 乱数 ---------------------------------------------------------------------

function hash(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 設定の正規化 -----------------------------------------------------------------

const num = (v, fallback, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const color = (v, fallback) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

export function normalizeLightning(raw) {
  if (!raw || typeof raw !== "object" || !raw.enabled) return null;
  return {
    color: color(raw.color, "#7fd4ff"),
    count: Math.round(num(raw.count, 6, 1, MAX_BOLTS)),
    length: num(raw.length, 220, 20, 1200),
    width: num(raw.width, 8, 0.5, 40),
    duration: num(raw.duration, 0.3, 0.03, 2),
    // 次に光るまでの間 (秒)。旧データ (光る頻度 frequency) は 1/frequency - duration に読み替える
    gap: raw.gap != null
      ? num(raw.gap, 0.15, 0, 5)
      : (Number(raw.frequency) > 0 ? Math.max(0, 1 / Number(raw.frequency) - num(raw.duration, 0.25, 0.03, 2)) : 0.15),
    shape: raw.shape === "hug" || raw.shape === "mix" ? raw.shape : "outward",
    // 体との間隔 (px)。稲妻の始点 (くの字なら両端) を輪郭から外へこの距離だけ離す
    margin: num(raw.margin, 0, 0, 400),
    branches: Math.round(num(raw.branches, 2, 0, MAX_BRANCHES)),
    jitter: num(raw.jitter, 0.5, 0, 1),
    front: num(raw.front, 0.5, 0, 1),
    when: raw.when === "speaking" ? "speaking" : "always",
    fadeSec: num(raw.fadeSec, 0.3, 0, 5),
  };
}

export function normalizeStreaks(raw) {
  if (!raw || typeof raw !== "object" || !raw.enabled) return null;
  return {
    color: color(raw.color, "#ffe14a"),
    count: Math.round(num(raw.count, 16, 1, MAX_STREAKS)),
    length: num(raw.length, 160, 10, 1200),
    width: num(raw.width, 6, 1, 60),
    speed: num(raw.speed, 900, 20, 6000),
    spread: num(raw.spread, 1.1, 0.2, 3),
    front: num(raw.front, 0.3, 0, 1),
    when: raw.when === "speaking" ? "speaking" : "always",
    fadeSec: num(raw.fadeSec, 0.3, 0, 5),
  };
}

// ---- 輪郭の点 -----------------------------------------------------------------

// images: キャラの絵 (under / over 等、どれも同じ大きさ)。w / h: 表示サイズ (px)。
// 返値: { points: [{ x, y, nx, ny }], cx, cy, minX, maxX, minY, maxY } (ローカル座標)。取れなければ null。
export function extractOutline(images, w, h, { flipX = false } = {}) {
  const list = images.filter(Boolean);
  if (!list.length) return null;
  const iw = list[0].naturalWidth || list[0].videoWidth || list[0].width;
  const ih = list[0].naturalHeight || list[0].videoHeight || list[0].height;
  if (!(iw > 0) || !(ih > 0)) return null;
  const gw = OUTLINE_COLS;
  const gh = Math.max(8, Math.round((gw * ih) / iw));
  let data;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = gw;
    canvas.height = gh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    for (const img of list) ctx.drawImage(img, 0, 0, gw, gh);
    data = ctx.getImageData(0, 0, gw, gh).data;
  } catch (_err) {
    return null;
  }
  const solid = (x, y) => x >= 0 && y >= 0 && x < gw && y < gh && data[(y * gw + x) * 4 + 3] > 80;
  const points = [];
  let sx = 0;
  let sy = 0;
  let n = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const toLocal = (gx, gy) => {
    let x = ((gx + 0.5) / gw - 0.5) * w;
    if (flipX) x = -x;
    return [x, ((gy + 0.5) / gh - 0.5) * h];
  };
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      if (!solid(x, y)) continue;
      const [lx, ly] = toLocal(x, y);
      sx += lx;
      sy += ly;
      n += 1;
      minX = Math.min(minX, lx);
      maxX = Math.max(maxX, lx);
      minY = Math.min(minY, ly);
      maxY = Math.max(maxY, ly);
      // 外向きの法線 = 空いている隣のマスの向きの和
      let nx = 0;
      let ny = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!solid(x + dx, y + dy)) {
          nx += dx;
          ny += dy;
        }
      }
      if (nx === 0 && ny === 0) continue; // 内側
      const len = Math.hypot(nx, ny);
      points.push({ x: lx, y: ly, nx: (flipX ? -nx : nx) / len, ny: ny / len });
    }
  }
  if (!points.length) return null;
  return { points, cx: sx / n, cy: sy / n, minX, maxX, minY, maxY };
}

// ---- 雷 -------------------------------------------------------------------------
//
// アニメ調の稲妻。参考にしたのは 2 つ: 細い芯から太い層を重ねて太い所と細い所の差を大きく・
// 先端を鋭く・ところどころ途切れさせる (vfxfreak) と、1 本を「細長く潰した円」(中央が太く
// 両端が尖る) にして折れ線に沿わせ、0→100% に伸ばしながら出す (AviUtl の作例)。
//   形   : 中点変位は 4 段だけ (大きく角ばった折れ線)。区間はまっすぐ、折れ目で鋭く曲がる。
//   太さ : 1 本ごとに中央が太く両端が尖る (sin の山)。途切れた先・枝もそれぞれ尖らせる。
//   塗り : 太い白い芯 (帯の 7 割) + 細い色の帯 + 薄いグロー。加算合成でしっかり光らせる。
//   動き : 光り始めの 25% で根元から先へ伸びる。細部と太さは 12 コマ/秒 (コマ打ち)。

// 中点変位で折れ線を細かくする。大筋 (lvl < 2) は rngMain、細部は rngFine。
function displace(pts0, length, levels, jitter, rngMain, rngFine) {
  let pts = pts0;
  let disp = length * 0.34 * (0.35 + jitter);
  for (let lvl = 0; lvl < levels; lvl += 1) {
    const rng = lvl < 2 ? rngMain : rngFine;
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      // 片側に大きく振る (0 付近を避けると、角ばったジグザグになる)
      const sgn = rng() < 0.5 ? -1 : 1;
      const off = sgn * (0.35 + 0.65 * rng()) * disp;
      next.push([(a[0] + b[0]) / 2 + (-dy / len) * off, (a[1] + b[1]) / 2 + (dx / len) * off]);
      next.push(b);
    }
    pts = next;
    disp *= 0.5;
  }
  return pts;
}

// 外へ伸びる稲妻: start から dir へ length。
function boltPath(start, dir, length, levels, jitter, rngMain, rngFine) {
  const end = [start[0] + dir[0] * length, start[1] + dir[1] * length];
  return displace([start, end], length, levels, jitter, rngMain, rngFine);
}

// 体に沿って曲がる稲妻 (くの字): 輪郭の 2 点 A・B を結び、その中点を外向きにふくらませた
// 頂点を通る。両端が体に向き、中央 (頂点) が外へ張り出す。
function hugPath(outline, a, length, levels, jitter, rngMain, rngFine, margin = 0) {
  const pts = outline.points;
  // A からの距離が length の 0.7〜1.05 倍の輪郭点を候補にする (無ければいちばん近い長さの点)
  const cands = [];
  let best = pts[0];
  let bestErr = Infinity;
  for (let k = 0; k < pts.length; k += 1) {
    const d = Math.hypot(pts[k].x - a.x, pts[k].y - a.y);
    if (d > length * 0.7 && d < length * 1.05) cands.push(pts[k]);
    const err = Math.abs(d - length * 0.85);
    if (err < bestErr) {
      bestErr = err;
      best = pts[k];
    }
  }
  const b = cands.length ? cands[Math.floor(rngMain() * cands.length)] : best;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // 外向き = 2 点の法線の平均 + 重心から中点への向き (どちらかが弱くても外へ張り出すように)
  const gx = mx - outline.cx;
  const gy = my - outline.cy;
  const gl = Math.hypot(gx, gy) || 1;
  let nx = a.nx + b.nx + (gx / gl) * 0.8;
  let ny = a.ny + b.ny + (gy / gl) * 0.8;
  const nl = Math.hypot(nx, ny) || 1;
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const bulge = Math.max(span, length * 0.5) * (0.32 + 0.16 * rngMain());
  // 体との間隔: 両端をそれぞれの法線方向へ、頂点も同じだけ外へずらす
  const ax = a.x + a.nx * margin;
  const ay = a.y + a.ny * margin;
  const bx = b.x + b.nx * margin;
  const by = b.y + b.ny * margin;
  const apex = [mx + (nx / nl) * (bulge + margin), my + (ny / nl) * (bulge + margin)];
  nx /= nl;
  ny /= nl;
  return {
    // ギザギザは 2 辺の長さに対して控えめに (強いと「く」の字が崩れて塊に見える)
    pts: displace([[ax, ay], apex, [bx, by]], Math.max(span, bulge) * 0.45, levels - 1, jitter, rngMain, rngFine),
    outAngle: Math.atan2(ny, nx),
  };
}

// 点ごとの芯の太さ (半幅 px)。「細長く潰した円」のように中央が太く両端が尖る。
// 折れ目ごとの太い・細いは 0.7〜1.3 倍の乱数を隣と平均してなめらかに。
function boltWidths(pts, width, rngFine) {
  const n = pts.length;
  // 折れ線に沿った長さで山を作る (点の間隔がばらついても形が崩れないように)
  const acc = [0];
  for (let i = 1; i < n; i += 1) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[n - 1] || 1;
  const raw = [];
  for (let i = 0; i < n; i += 1) raw.push(0.7 + 0.6 * rngFine());
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = acc[i] / total;
    const lens = Math.pow(Math.sin(Math.PI * t), 0.6);
    const chunk = (raw[Math.max(0, i - 1)] + raw[i] * 2 + raw[Math.min(n - 1, i + 1)]) / 4;
    out.push(Math.max(0.35, (width / 2) * lens * chunk));
  }
  out[0] = 0.35; // 両端は尖らせる
  out[n - 1] = 0.35;
  return out;
}

// 折れ線を先頭から frac (0..1、長さの割合) まで切り出す (伸びながら出る動き)。
function truncatePath(pts, frac) {
  if (frac >= 1) return pts;
  const acc = [0];
  for (let i = 1; i < pts.length; i += 1) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const target = acc[acc.length - 1] * Math.max(0, frac);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) {
    if (acc[i] <= target) {
      out.push(pts[i]);
      continue;
    }
    const seg = acc[i] - acc[i - 1] || 1;
    const k = (target - acc[i - 1]) / seg;
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]);
    break;
  }
  return out;
}

function createRibbonMesh(maxPoints) {
  const geometry = new THREE.BufferGeometry();
  const maxVerts = maxPoints * 2;
  const attr = (size) => new THREE.BufferAttribute(new Float32Array(maxVerts * size), size).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", attr(3));
  geometry.setAttribute("aSide", attr(1));
  geometry.setAttribute("aBright", attr(1));
  geometry.setAttribute("aHalf", attr(1));
  geometry.setAttribute("aCore", attr(1));
  geometry.setAttribute("aFade", attr(1));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(maxPoints * 6), 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color("#7fd4ff") },
      uLevel: { value: 1 },
      uClipRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    vertexShader: /* glsl */ `
      attribute float aSide;
      attribute float aBright;
      attribute float aHalf;
      attribute float aCore;
      attribute float aFade;
      varying float vFade;
      varying float vSide;
      varying float vBright;
      varying float vHalf;
      varying float vCore;
      varying vec2 vWorldXY;
      void main() {
        vSide = aSide;
        vBright = aBright;
        vHalf = aHalf;
        vCore = aCore;
        vFade = aFade;
        vWorldXY = (modelMatrix * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uLevel;
      uniform vec4 uClipRect;
      varying float vSide;
      varying float vBright;
      varying float vHalf;
      varying float vCore;
      varying float vFade;
      varying vec2 vWorldXY;
      void main() {
        if (uClipRect.z > 0.0 && uClipRect.w > 0.0) {
          if (vWorldXY.x < uClipRect.x || vWorldXY.x > uClipRect.x + uClipRect.z
              || vWorldXY.y < uClipRect.y || vWorldXY.y > uClipRect.y + uClipRect.w) discard;
        }
        float d = abs(vSide) * vHalf;                 // 中心からの距離 (px)
        float aa = 0.8;                               // 縁のアンチエイリアス幅 (px)
        // 太い白い芯 (帯の内側 70%) → 細い色の帯 をくっきりした縁で、外側に薄いグロー (2 層)。
        // 延長部分 (vFade < 1) には芯と帯を描かない (先端から細い線がはみ出さないように)
        float tip = smoothstep(0.85, 1.0, vFade);
        float white = (1.0 - smoothstep(vCore * 0.7 - aa, vCore * 0.7 + aa, d)) * tip;
        float band = (1.0 - smoothstep(vCore - aa, vCore + aa, d)) * tip;
        // グロー: 帯の外側から、外へ向かってなめらかにぼけて 0 になる (帯の端で途切れない)
        float out1 = max(d - vCore, 0.0);
        float g = clamp(1.0 - out1 / max(vHalf - vCore, 1.0), 0.0, 1.0);
        // 両端の延長部分 (vFade 1→0) でグローも消えていく (端が四角く切れない)
        float glow = (g * g * (3.0 - 2.0 * g) * 0.28 + pow(g, 4.0) * 0.22) * vFade * vFade;
        vec3 col = uColor * (band * 1.1 + glow * (1.0 - band)) + vec3(1.0) * white * 1.2;
        gl_FragColor = vec4(col * vBright * uLevel, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

// 折れ線をリボンにしてバッファへ積む。cores = 点ごとの芯の半幅、glowPx = グローの外側の幅。
function pushRibbon(buf, pts0, cores0, glowPx, bright) {
  const { pos, side, br, half, core, fade, idx } = buf.arrays;
  // 両端を接線方向に glowPx だけ延ばし、そこで芯 0・グローが消える点を足す
  const m = pts0.length;
  const ext = (p, q) => {
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / l) * glowPx, p[1] + (dy / l) * glowPx];
  };
  const pts = [ext(pts0[0], pts0[1]), ...pts0, ext(pts0[m - 1], pts0[m - 2])];
  const cores = [0, ...cores0, 0];
  const fades = [0, ...pts0.map(() => 1), 0];
  const base = buf.verts;
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const hw = cores[i] + glowPx;
    for (const s of [1, -1]) {
      const v = buf.verts;
      pos[v * 3] = pts[i][0] + -ty * hw * s;
      pos[v * 3 + 1] = pts[i][1] + tx * hw * s;
      pos[v * 3 + 2] = 0;
      side[v] = s;
      br[v] = bright;
      half[v] = hw;
      core[v] = cores[i];
      fade[v] = fades[i];
      buf.verts += 1;
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    const a = base + i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], buf.indices);
    buf.indices += 6;
  }
}

function beginBuffer(mesh) {
  const g = mesh.geometry;
  return {
    verts: 0,
    indices: 0,
    arrays: {
      pos: g.attributes.position.array,
      side: g.attributes.aSide.array,
      br: g.attributes.aBright.array,
      half: g.attributes.aHalf.array,
      core: g.attributes.aCore.array,
      fade: g.attributes.aFade.array,
      idx: g.index.array,
    },
  };
}

function endBuffer(mesh, buf) {
  const g = mesh.geometry;
  for (const name of ["position", "aSide", "aBright", "aHalf", "aCore", "aFade"]) g.attributes[name].needsUpdate = true;
  g.index.needsUpdate = true;
  g.setDrawRange(0, buf.indices);
  mesh.visible = buf.indices > 0;
}

// 折れ線を途中で途切れさせる (隙間)。区間 k を抜いて 2 本に分ける。
function splitWithGap(pts, rng) {
  if (pts.length < 7 || rng() > 0.4) return [pts];
  const k = 2 + Math.floor(rng() * (pts.length - 5));
  return [pts.slice(0, k + 1), pts.slice(k + 1)];
}

function updateLightning(fx, timeSec, level) {
  const cfg = fx.lightning;
  const outline = fx.outline;
  const back = beginBuffer(fx.boltBack);
  const front = beginBuffer(fx.boltFront);
  if (outline && level > 0.001) {
    const koma = Math.floor(timeSec * 12); // 12 コマ/秒で細部と太さを切り替える
    const glowPx = Math.max(4, cfg.width * 2.2);
    for (let i = 0; i < cfg.count; i += 1) {
      // 1 本の枠は「光る時間 + 次に光るまでの間 (枠ごとに 0.6〜1.4 倍)」で繰り返す
      const p = cfg.duration + cfg.gap * (0.6 + 0.8 * hash(fx.seed, i, 1));
      const t = timeSec + hash(fx.seed, i, 2) * p;
      const cyc = Math.floor(t / p);
      const u = (t - cyc * p) / cfg.duration;
      if (u < 0 || u >= 1) continue;
      const rngMain = mulberry32(Math.floor(hash(fx.seed, i, cyc + 1000) * 4294967296));
      const rngFine = mulberry32(Math.floor(hash(fx.seed + 7, i * 977 + cyc, koma) * 4294967296));
      const pt = outline.points[Math.floor(rngMain() * outline.points.length)];
      // 外向き (輪郭の法線) をランダムに振る。少し上向きに寄せる
      const ang = Math.atan2(pt.ny - 0.25, pt.nx) + (rngMain() - 0.5) * 1.3;
      const dir = [Math.cos(ang), Math.sin(ang)];
      const length = cfg.length * (0.6 + 0.55 * rngMain());
      const isFront = rngMain() < cfg.front;
      // アニメ調: 光っている間はほぼ一定の明るさで、最後にすっと消える。たまに 1 コマ暗く瞬く
      const env = (u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25) * (rngFine() < 0.12 ? 0.55 : 1);
      // 光り始めの 25% で根元から先へ伸びる (伸びている先端も尖る)
      const grow = Math.min(1, u / 0.25);
      const buf = isFront ? front : back;
      const hug = cfg.shape === "hug" || (cfg.shape === "mix" && rngMain() < 0.5);
      let full;
      let branchBase = ang;
      if (hug) {
        const h = hugPath(outline, pt, length, MAIN_LEVELS, cfg.jitter, rngMain, rngFine, cfg.margin);
        full = h.pts;
        branchBase = h.outAngle;
      } else {
        const off = cfg.margin > 0 ? cfg.margin : -cfg.width * 0.5;
        const start = [pt.x + pt.nx * off, pt.y + pt.ny * off];
        full = boltPath(start, dir, length, MAIN_LEVELS, cfg.jitter, rngMain, rngFine);
      }
      const main = truncatePath(full, grow);
      for (const pts of splitWithGap(main, rngFine)) {
        if (pts.length >= 2) pushRibbon(buf, pts, boltWidths(pts, cfg.width, rngFine), glowPx, env);
      }
      for (let k = 0; k < cfg.branches; k += 1) {
        const at = full[Math.floor(full.length * (0.2 + 0.55 * rngMain()))];
        const bang = branchBase + (rngMain() < 0.5 ? -1 : 1) * (0.4 + 0.6 * rngMain());
        const branchFull = boltPath(at, [Math.cos(bang), Math.sin(bang)], length * (0.25 + 0.35 * rngMain()),
          BRANCH_LEVELS, cfg.jitter, rngMain, rngFine);
        // 枝は本体がそこまで伸びてから出る
        const branchGrow = Math.max(0, Math.min(1, (u - 0.12) / 0.25));
        const branch = truncatePath(branchFull, branchGrow);
        if (branch.length >= 2 && branchGrow > 0) {
          pushRibbon(buf, branch, boltWidths(branch, cfg.width * 0.6, rngFine), glowPx * 0.7, env * 0.9);
        }
      }
    }
  }
  endBuffer(fx.boltBack, back);
  endBuffer(fx.boltFront, front);
}

// ---- 光の筋 -----------------------------------------------------------------------

function createStreakMesh(instances) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.attributes.position);
  geometry.setAttribute("uv", quad.attributes.uv);
  const n = Math.max(1, instances.length);
  const data = new Float32Array(n * 4);
  const data2 = new Float32Array(n * 2);
  instances.forEach((s, i) => {
    data.set([s.x, s.y0, s.speedMul, s.phase], i * 4);
    data2.set([s.lenMul, s.widthMul], i * 2);
  });
  geometry.setAttribute("aInst", new THREE.InstancedBufferAttribute(data, 4));
  geometry.setAttribute("aInst2", new THREE.InstancedBufferAttribute(data2, 2));
  geometry.instanceCount = instances.length;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color("#ffe14a") },
      uTime: { value: 0 },
      uSpeed: { value: 900 },
      uLength: { value: 160 },
      uWidth: { value: 6 },
      uTravel: { value: 600 },
      uLevel: { value: 1 },
      uClipRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aInst;   // x, 開始 y, 速さの倍率, 位相
      attribute vec2 aInst2;  // 長さの倍率, 太さの倍率
      uniform float uTime;
      uniform float uSpeed;
      uniform float uLength;
      uniform float uWidth;
      uniform float uTravel;
      varying vec2 vUv;
      varying float vProg;
      varying vec2 vWorldXY;
      void main() {
        float len = uLength * aInst2.x;
        float travel = uTravel + len;
        float prog = fract(uTime * uSpeed * aInst.z / travel + aInst.w);
        // +y が下。position.y = -0.5 が先端 (上)
        float cy = aInst.y - prog * travel + len * 0.5;
        vec3 p = vec3(aInst.x + position.x * uWidth * aInst2.y, cy + position.y * len, 0.0);
        vUv = uv;
        vProg = prog;
        vWorldXY = (modelMatrix * vec4(p, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uLevel;
      uniform vec4 uClipRect;
      varying vec2 vUv;
      varying float vProg;
      varying vec2 vWorldXY;
      void main() {
        if (uClipRect.z > 0.0 && uClipRect.w > 0.0) {
          if (vWorldXY.x < uClipRect.x || vWorldXY.x > uClipRect.x + uClipRect.z
              || vWorldXY.y < uClipRect.y || vWorldXY.y > uClipRect.y + uClipRect.w) discard;
        }
        // PlaneGeometry は position.y = -0.5 の側が uv.y = 0。+y が下なので uv.y = 0 が先端 (上)。
        // 先端ほど明るく、尾 (下) は消える
        float along = pow(1.0 - vUv.y, 1.6);
        float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float soft = pow(across, 1.4);
        float fade = sin(3.14159265 * vProg);
        vec3 col = mix(uColor, vec3(1.0), pow(across, 4.0) * 0.6 * along);
        gl_FragColor = vec4(col * soft * along * fade * uLevel * 1.4, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = instances.length > 0;
  return mesh;
}

function buildStreakInstances(cfg, outline, seed) {
  const rng = mulberry32(seed * 7919 + 17);
  const back = [];
  const front = [];
  const cx = (outline.minX + outline.maxX) / 2;
  const bw = Math.max(20, outline.maxX - outline.minX);
  const bh = Math.max(20, outline.maxY - outline.minY);
  for (let i = 0; i < cfg.count; i += 1) {
    const inst = {
      x: cx + (rng() - 0.5) * bw * cfg.spread,
      // 体の下半分のどこかから上がる
      y0: outline.maxY - rng() * bh * 0.55,
      speedMul: 0.6 + 0.8 * rng(),
      phase: rng(),
      lenMul: 0.5 + 0.9 * rng(),
      widthMul: 0.5 + 0.9 * rng(),
    };
    (rng() < cfg.front ? front : back).push(inst);
  }
  return { back, front, travel: bh * 0.9 };
}

// ---- 組み立て / 毎フレーム ------------------------------------------------------------

// 雷・光の筋のどちらかが有効なときに作る。outline が取れなければ null。
export function createCharSparks({ lightning, streaks, outline, seed = 0 }) {
  if (!outline || (!lightning && !streaks)) return null;
  const fx = { lightning, streaks, outline, seed, meshes: [] };
  if (lightning) {
    const maxPoints = MAX_BOLTS * POINTS_PER_BOLT;
    fx.boltBack = createRibbonMesh(maxPoints);
    fx.boltFront = createRibbonMesh(maxPoints);
    for (const m of [fx.boltBack, fx.boltFront]) {
      m.material.uniforms.uColor.value.set(lightning.color);
    }
    fx.meshes.push(fx.boltBack, fx.boltFront);
  }
  if (streaks) {
    const inst = buildStreakInstances(streaks, outline, seed);
    fx.streakBack = createStreakMesh(inst.back);
    fx.streakFront = createStreakMesh(inst.front);
    for (const m of [fx.streakBack, fx.streakFront]) {
      const u = m.material.uniforms;
      u.uColor.value.set(streaks.color);
      u.uSpeed.value = streaks.speed;
      u.uLength.value = streaks.length;
      u.uWidth.value = streaks.width;
      u.uTravel.value = inst.travel;
    }
    fx.meshes.push(fx.streakBack, fx.streakFront);
  }
  return fx;
}

// 後ろ用 / 前用のメッシュ (scene-builder が renderOrder を付けて group に足す)。
export function sparkMeshes(fx) {
  return {
    back: [fx.boltBack, fx.streakBack].filter(Boolean),
    front: [fx.boltFront, fx.streakFront].filter(Boolean),
  };
}

// levels: { lightning: 0..1, streaks: 0..1 } (口パク連動の明るさ)。
export function updateCharSparks(fx, { timeSec, levels }) {
  if (fx.lightning) {
    const lv = levels?.lightning ?? 1;
    updateLightning(fx, timeSec, lv);
    fx.boltBack.material.uniforms.uLevel.value = lv;
    fx.boltFront.material.uniforms.uLevel.value = lv;
  }
  if (fx.streaks) {
    const lv = levels?.streaks ?? 1;
    for (const m of [fx.streakBack, fx.streakFront]) {
      m.material.uniforms.uTime.value = timeSec;
      m.material.uniforms.uLevel.value = lv;
      m.visible = m.geometry.instanceCount > 0 && lv > 0.001;
    }
  }
}

export function disposeCharSparks(fx) {
  for (const m of fx?.meshes || []) {
    m.geometry.dispose();
    m.material.dispose();
  }
}
