// =============================================================================
// visualizers/circle_spectrum.js
//
// サークルスペクトログラム GL プラグイン。Python 版
// plugins/visualizers/circle_spectrum.py の出力を canvas2d + CanvasTexture で
// 再現する。
//
// 戦略:
//   - サーバ側 gl_data_streams が per-frame の生 dB スペクトル (Float32) を
//     `spectrum` ストリームとして書き出す。shape = [frameCount, bands]。
//   - 各フレームで該当 bands 行を切り出し、(dbFloor..dbCeil) で [0..1] へ正規化、
//     中心 (cx, cy) から放射状にバーを引く。
//   - dbFloor / dbCeil / rotateDeg / mirror 等の見た目パラメータはブラウザ側で
//     扱うため、UI で値が変わってトークン再ベイクが走った直後も「ベイクされた
//     spectrum 行 × ブラウザ側の最新閾値」で表示が一致する。
// =============================================================================

const TAU = Math.PI * 2;

function numParam(value, fallback) {
  const raw = value ?? fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeParams(rawParams, width, height) {
  const p = rawParams || {};
  let dbFloor = numParam(p.dbFloor, -75);
  let dbCeil = numParam(p.dbCeil, -20);
  if (dbCeil <= dbFloor) dbCeil = dbFloor + 1;
  return {
    color: String(p.color || "#ffffff"),
    cx: numParam(p.centerX, width / 2),
    cy: numParam(p.centerY, height / 2),
    inner: Math.max(0, numParam(p.innerRadius, 220)),
    barMax: Math.max(1, numParam(p.barLength, 180)),
    lineWidth: Math.max(1, numParam(p.lineWidth, 4)),
    bands: Math.max(8, numParam(p.bands, 96)),
    dbFloor,
    dbCeil,
    rotateDeg: numParam(p.rotateDeg, -90),
    mirror: String(p.mirror || "outer"),
    opacity: Math.max(0, Math.min(1, numParam(p.opacity, 0.95))),
  };
}

function paramsCacheKey(p) {
  return [
    p.color, p.cx, p.cy, p.inner, p.barMax, p.lineWidth, p.bands,
    p.dbFloor, p.dbCeil, p.rotateDeg, p.mirror, p.opacity,
  ].join("|");
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, audioData, streamShapes, frameCount } = ctx;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const c2d = canvas.getContext("2d");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const geom = new THREE.PlaneGeometry(canvas.width, canvas.height);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(canvas.width / 2, canvas.height / 2, 0);
  mesh.frustumCulled = false;

  const specFlat = audioData?.spectrum || null;
  const specShape = streamShapes?.spectrum || null;
  // shape = [frameCount, bands]。バンド数はサーバが gl_data_streams で焼いた値が
  // 正で、UI の bands パラメータと一致する。フォールバックは flat 全長 / frameCount。
  const bandsBaked = (() => {
    if (Array.isArray(specShape) && specShape.length >= 2) return Math.max(1, Number(specShape[1]));
    if (specFlat && frameCount > 0) return Math.max(1, Math.floor(specFlat.length / frameCount));
    return 0;
  })();

  let lastFrameIdx = -1;
  let lastParamsKey = "";

  function drawFallbackCircle(p) {
    // 音源未指定時の表示。Python 版 (ctx.audio is None) と揃えて細い円だけ描く。
    c2d.save();
    c2d.globalAlpha = Math.max(0, Math.min(1, p.opacity * (60 / 255)));
    c2d.strokeStyle = p.color;
    c2d.lineWidth = Math.max(1, Math.floor(p.lineWidth / 2));
    c2d.beginPath();
    c2d.arc(p.cx, p.cy, p.inner, 0, TAU);
    c2d.stroke();
    c2d.restore();
  }

  function drawSpectrum(p, frameIdx) {
    if (!specFlat || bandsBaked <= 0) return;
    const off = frameIdx * bandsBaked;
    if (off + bandsBaked > specFlat.length) return;
    // バンド数 (UI 値) がベイク値と異なる場合は線形リサンプル。通常は一致する
    // (token に bands が含まれるので変更時は再ベイク)。
    const bandsOut = Math.max(1, Math.round(p.bands));
    const baseAngle = (p.rotateDeg * Math.PI) / 180;
    const range = p.dbCeil - p.dbFloor;

    c2d.save();
    c2d.globalAlpha = p.opacity;
    c2d.strokeStyle = p.color;
    c2d.lineWidth = p.lineWidth;
    c2d.lineCap = "butt";

    for (let i = 0; i < bandsOut; i++) {
      let dbValue;
      if (bandsOut === bandsBaked) {
        dbValue = specFlat[off + i];
      } else {
        // 線形補間。UI スライダで bands を変える → 再ベイク待ちの瞬間の見た目が
        // 多少崩れても良い、という割り切り。
        const f = (i / Math.max(1, bandsOut - 1)) * (bandsBaked - 1);
        const lo = Math.floor(f);
        const hi = Math.min(bandsBaked - 1, lo + 1);
        const t = f - lo;
        dbValue = specFlat[off + lo] * (1 - t) + specFlat[off + hi] * t;
      }
      let v = (dbValue - p.dbFloor) / range;
      if (v <= 0.001) continue;
      if (v > 1) v = 1;
      const a = baseAngle + (i / bandsOut) * TAU;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const barLen = v * p.barMax;
      const x1 = p.cx + cosA * p.inner;
      const y1 = p.cy + sinA * p.inner;
      const x2 = p.cx + cosA * (p.inner + barLen);
      const y2 = p.cy + sinA * (p.inner + barLen);
      c2d.beginPath();
      c2d.moveTo(x1, y1);
      c2d.lineTo(x2, y2);
      c2d.stroke();
      if (p.mirror === "both") {
        const innerBack = Math.max(0, p.inner - barLen);
        const xb = p.cx + cosA * innerBack;
        const yb = p.cy + sinA * innerBack;
        c2d.beginPath();
        c2d.moveTo(x1, y1);
        c2d.lineTo(xb, yb);
        c2d.stroke();
      }
    }
    c2d.restore();
  }

  function renderInto(p, frameIdx) {
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    if (p.opacity <= 0) return;
    if (!specFlat || frameCount <= 0 || bandsBaked <= 0) {
      drawFallbackCircle(p);
      return;
    }
    drawSpectrum(p, frameIdx);
  }

  function updateImpl(frameIdx) {
    const p = normalizeParams(params, canvas.width, canvas.height);
    const pk = paramsCacheKey(p);
    if (frameIdx === lastFrameIdx && pk === lastParamsKey) return;
    lastFrameIdx = frameIdx;
    lastParamsKey = pk;
    renderInto(p, frameIdx);
    texture.needsUpdate = true;
  }

  updateImpl(0);

  function update(frameState) {
    const idx = Math.max(0, Math.floor(Number(frameState?.frameIdx) || 0));
    updateImpl(idx);
  }
  function dispose() {
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  return { object3D: mesh, update, dispose };
}
