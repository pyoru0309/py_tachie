// =============================================================================
// visualizers/wave.js
//
// オーディオ波形 GL プラグイン。Python 版 plugins/visualizers/wave.py の
// 出力を canvas2d + CanvasTexture で再現する。
//
// 戦略:
//   - サーバ側 gl_data_streams が per-frame の peak 正規化済み波形 (Float32) を
//     `pcm` ストリームとして書き出す。shape = [frameCount, sampleW]。
//   - 各 frame で行を切り出し、(0..sampleW-1) を canvas 横幅にマップして折れ線を
//     描画 → texture.needsUpdate で 1 回 upload。
//   - 連番 PNG (24 Hz × 8MB = 192MB/s) と比較して、本実装は 1080p RGBA upload を
//     1 回 / frame にとどめつつ、ストリームは float32 平面で軽量 (1920 × frames × 4
//     bytes ≒ 24 fps × 10 s で 1.8MB)。
// =============================================================================

// 0 を有効値として保持する numeric 取り出し。countdown.js と同じ規約。
function numParam(value, fallback) {
  const raw = value ?? fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeParams(rawParams, height) {
  const p = rawParams || {};
  return {
    color: String(p.color || "#ffffff"),
    lineWidth: Math.max(1, numParam(p.lineWidth, 4)),
    amplitude: Math.max(0, numParam(p.amplitude, 320)),
    centerY: numParam(p.centerY, height / 2),
    opacity: Math.max(0, Math.min(1, numParam(p.opacity, 0.9))),
  };
}

function paramsCacheKey(p) {
  return [p.color, p.lineWidth, p.amplitude, p.centerY, p.opacity].join("|");
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

  // Y-down カメラ + DoubleSide。countdown.js と同じ規約。
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

  // ストリーム取り出し。pcm shape = [frameCount, sampleW]、peak shape = [frameCount]。
  const pcmFlat = audioData?.pcm || null;
  const peakFlat = audioData?.peak || null;
  const pcmShape = streamShapes?.pcm || null;
  // shape[1] が無いときは flat 全長 / frameCount でフォールバック (defensive)。
  const sampleW = (() => {
    if (Array.isArray(pcmShape) && pcmShape.length >= 2) return Math.max(1, Number(pcmShape[1]));
    if (pcmFlat && frameCount > 0) return Math.max(1, Math.floor(pcmFlat.length / frameCount));
    return canvas.width;
  })();

  let lastFrameIdx = -1;
  let lastParamsKey = "";

  function drawCenterLine(p) {
    // 音源未指定 / 無音時の表示。Python 版 (ctx.audio is None) と揃える。
    const cy = Math.round(p.centerY);
    c2d.save();
    c2d.globalAlpha = Math.max(0, Math.min(1, p.opacity * (60 / 255)));
    c2d.strokeStyle = p.color;
    c2d.lineWidth = Math.max(1, Math.floor(p.lineWidth / 2));
    c2d.beginPath();
    c2d.moveTo(0, cy + 0.5);
    c2d.lineTo(canvas.width, cy + 0.5);
    c2d.stroke();
    c2d.restore();
  }

  function drawWave(p, frameIdx) {
    const peak = peakFlat ? peakFlat[frameIdx] || 0 : 0;
    // Python 版と同じく peak が極端に小さいフレームは描画しない。
    if (!pcmFlat || peak <= 1e-4) return;
    const off = frameIdx * sampleW;
    if (off + sampleW > pcmFlat.length) return;

    c2d.save();
    c2d.globalAlpha = p.opacity;
    c2d.strokeStyle = p.color;
    c2d.lineWidth = p.lineWidth;
    c2d.lineJoin = "round";
    c2d.lineCap = "round";
    c2d.beginPath();
    // sampleW を canvas.width にマッピング。Python は canvas 幅で resample 済みで
    // ship する規約 (GL_OUTPUT_WIDTH = 1920) なので、ここでは線形に並べるだけ。
    if (sampleW === canvas.width) {
      const y0 = p.centerY - pcmFlat[off] * p.amplitude;
      c2d.moveTo(0, y0);
      for (let x = 1; x < sampleW; x++) {
        const y = p.centerY - pcmFlat[off + x] * p.amplitude;
        c2d.lineTo(x, y);
      }
    } else {
      // フォールバック: sampleW != canvas.width のときは線形補間。
      const ratio = (sampleW - 1) / Math.max(1, canvas.width - 1);
      const y0 = p.centerY - pcmFlat[off] * p.amplitude;
      c2d.moveTo(0, y0);
      for (let x = 1; x < canvas.width; x++) {
        const sf = x * ratio;
        const si = Math.floor(sf);
        const sj = Math.min(sampleW - 1, si + 1);
        const t = sf - si;
        const v = pcmFlat[off + si] * (1 - t) + pcmFlat[off + sj] * t;
        c2d.lineTo(x, p.centerY - v * p.amplitude);
      }
    }
    c2d.stroke();
    c2d.restore();
  }

  function renderInto(p, frameIdx) {
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    if (p.opacity <= 0 || p.amplitude <= 0) return;
    if (!pcmFlat || frameCount <= 0) {
      drawCenterLine(p);
      return;
    }
    const peak = peakFlat ? peakFlat[frameIdx] || 0 : 0;
    if (peak <= 1e-4) {
      // Python は無音時は空の canvas を返す (中央線も出さない)。挙動を揃える。
      return;
    }
    drawWave(p, frameIdx);
  }

  function updateImpl(frameIdx) {
    const p = normalizeParams(params, canvas.height);
    const pk = paramsCacheKey(p);
    if (frameIdx === lastFrameIdx && pk === lastParamsKey) return;
    lastFrameIdx = frameIdx;
    lastParamsKey = pk;
    renderInto(p, frameIdx);
    texture.needsUpdate = true;
  }

  // 初期描画 (空 canvas のままだと最初の 1 frame が透明になるので、frame 0 を焼く)。
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
