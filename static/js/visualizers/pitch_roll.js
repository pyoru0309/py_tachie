// =============================================================================
// visualizers/pitch_roll.js
//
// 歌声ピッチロール GL プラグイン (plugins/visualizers/pitch_roll.py の描画側)。
//
// サーバが返すもの (カットの前後 20 秒ぶん):
//   pitch  [M, 2]  100 Hz の [ノート番号 (無声 -1), 音量 0..1]。先頭 = meta[0] 秒
//   notes  [K, 3]  [開始秒, 終了秒, ノート番号] (シーン秒)
//   lyrics [K, 4]  歌詞のコードポイント (0 = なし)
//   meta   [4]     [pitch 先頭秒, 解析 Hz, 曲の最低ノート, 最高ノート]
//
// 描画: 再生位置 (playheadPos) を固定し、ノートと音程線が右から左へ流れる
// ピアノロール。歌い終えた音程線は加算合成の多段ストロークで光らせ、再生位置に
// 光の玉を置く。時刻は frameState.sceneSec (連続値) を使うのでスクロールが滑らか。
// =============================================================================

function numParam(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function hexToRgb(hex, fallback = [255, 255, 255]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgba(rgb, a) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a))})`;
}

// 黒へ寄せた色 (歌い終えたノート用)。透明度でなく明度で区別するので、
// ノートの不透明度 1 なら背景は一切透けない。
function darken(rgb, t) {
  return rgb.map((c) => Math.round(c * (1 - t)));
}

// 白へ寄せた色 (光の芯用)。
function whiten(rgb, t) {
  return rgb.map((c) => Math.round(c + (255 - c) * t));
}

function normalizeParams(raw, width, height) {
  const p = raw || {};
  const x = Math.max(0, Math.min(width - 1, numParam(p.x, 0)));
  const y = Math.max(0, Math.min(height - 1, numParam(p.y, 0)));
  return {
    lineRgb: hexToRgb(p.lineColor, [127, 227, 255]),
    noteRgb: hexToRgb(p.noteColor, [61, 108, 255]),
    noteFlat: String(p.noteStyle || "bevel") === "flat",
    noteRadius: Math.max(0, numParam(p.noteRadius, 4)),
    noteOpacity: Math.max(0, Math.min(1, numParam(p.noteOpacity, 1))),
    gridRgb: hexToRgb(p.gridColor, [255, 255, 255]),
    // "keys" = 罫線 + 黒鍵の行の帯 / "lines" = 罫線のみ / "none" = 背景の罫線を描かない。
    gridStyle: ["keys", "lines", "none"].includes(p.gridStyle) ? p.gridStyle : "keys",
    playheadLine: String(p.playheadLine || "on") !== "off",
    x,
    y,
    w: Math.max(50, Math.min(width - x, numParam(p.width, width))),
    h: Math.max(50, Math.min(height - y, numParam(p.height, height))),
    playheadPos: Math.max(0.05, Math.min(0.95, numParam(p.playheadPos, 0.75))),
    pxPerSec: Math.max(20, numParam(p.pxPerSec, 320)),
    rangePadding: Math.max(0, numParam(p.rangePadding, 3)),
    lineWidth: Math.max(0.5, numParam(p.lineWidth, 3)),
    glow: Math.max(0, numParam(p.glow, 1)),
    trailSec: Math.max(0.1, numParam(p.trailSec, 4)),
    backdrop: Math.max(0, Math.min(1, numParam(p.backdrop, 0.6))),
    showFuture: String(p.showFuture || "dim") !== "hide",
    showLyrics: String(p.showLyrics || "on") !== "off",
    opacity: Math.max(0, Math.min(1, numParam(p.opacity, 1))),
  };
}

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, audioData, streamShapes, fontResolver } = ctx;

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

  // ---- ストリーム ----
  const pitch = audioData?.pitch || null;
  const meta = audioData?.meta || null;
  const notesFlat = audioData?.notes || null;
  const lyricsFlat = audioData?.lyrics || null;
  const pitchStart = meta ? meta[0] : 0;
  const hz = meta && meta[1] > 0 ? meta[1] : 100;
  const songLo = meta ? meta[2] : 57;
  const songHi = meta ? meta[3] : 81;
  const pitchCount = pitch ? Math.floor(pitch.length / 2) : 0;
  const lyricWidth = Array.isArray(streamShapes?.lyrics) && streamShapes.lyrics.length >= 2
    ? Number(streamShapes.lyrics[1]) : 4;
  const notes = [];
  if (notesFlat) {
    for (let i = 0; i + 2 < notesFlat.length; i += 3) {
      const start = notesFlat[i];
      const end = notesFlat[i + 1];
      if (!(end > start)) continue;
      let lyric = "";
      if (lyricsFlat) {
        const k = i / 3;
        for (let c = 0; c < lyricWidth; c++) {
          const code = lyricsFlat[k * lyricWidth + c];
          if (code > 0) lyric += String.fromCodePoint(code);
        }
      }
      notes.push({ start, end, pitch: notesFlat[i + 2], lyric });
    }
  }

  const font = (() => {
    try {
      const f = fontResolver ? fontResolver("", "bold") : null;
      return f?.family ? `${f.weight || 700} 18px ${f.family}` : "700 18px sans-serif";
    } catch {
      return "700 18px sans-serif";
    }
  })();

  // 時刻 t のノート番号 (無声は null)。100 Hz を線形補間。
  function pitchAt(t) {
    if (!pitch) return null;
    const f = (t - pitchStart) * hz;
    const i = Math.floor(f);
    if (i < 0 || i + 1 >= pitchCount) return null;
    const a = pitch[i * 2];
    const b = pitch[(i + 1) * 2];
    if (a < 0 || b < 0) return a >= 0 ? a : (b >= 0 ? b : null);
    return a + (b - a) * (f - i);
  }
  // 光の玉の位置: 無声になっても直前の音程に 0.3 秒かけて残す (ノートの切れ目で
  // 玉がぱっと消えないように)。戻り値 { pitch, fade } か null。
  function headAt(t) {
    for (let k = 0; k <= 30; k++) {
      const v = pitchAt(t - k / hz);
      if (v != null) return { pitch: v, fade: 1 - k / 30 };
    }
    return null;
  }
  function levelAt(t) {
    if (!pitch) return 0;
    const i = Math.round((t - pitchStart) * hz);
    if (i < 0 || i >= pitchCount) return 0;
    return pitch[i * 2 + 1];
  }

  // [t0, t1] の音程を折れ線の配列 (無声・大きな跳躍で分割) にする。
  function curveSegments(t0, t1, xOf, yOf) {
    const segs = [];
    if (!pitch) return segs;
    const i0 = Math.max(0, Math.floor((t0 - pitchStart) * hz));
    const i1 = Math.min(pitchCount - 1, Math.ceil((t1 - pitchStart) * hz));
    let cur = null;
    let prev = null;
    for (let i = i0; i <= i1; i++) {
      const v = pitch[i * 2];
      if (v < 0 || (prev != null && Math.abs(v - prev) > 4)) {
        if (cur && cur.length > 1) segs.push(cur);
        cur = null;
      }
      if (v >= 0) {
        const t = pitchStart + i / hz;
        if (!cur) cur = [];
        cur.push([xOf(t), yOf(v)]);
      }
      prev = v >= 0 ? v : null;
    }
    if (cur && cur.length > 1) segs.push(cur);
    return segs;
  }

  function strokeSegments(segs, style, lineWidth) {
    c2d.strokeStyle = style;
    c2d.lineWidth = lineWidth;
    c2d.beginPath();
    for (const seg of segs) {
      c2d.moveTo(seg[0][0], seg[0][1]);
      for (let k = 1; k < seg.length; k++) c2d.lineTo(seg[k][0], seg[k][1]);
    }
    c2d.stroke();
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    c2d.beginPath();
    c2d.moveTo(x + rr, y);
    c2d.arcTo(x + w, y, x + w, y + h, rr);
    c2d.arcTo(x + w, y + h, x, y + h, rr);
    c2d.arcTo(x, y + h, x, y, rr);
    c2d.arcTo(x, y, x + w, y, rr);
    c2d.closePath();
  }

  function render(p, now) {
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    if (p.opacity <= 0) return;
    const lo = Math.floor(songLo - p.rangePadding);
    const hi = Math.ceil(songHi + p.rangePadding);
    const rows = Math.max(1, hi - lo + 1);
    const rowH = p.h / rows;
    const playX = p.x + p.w * p.playheadPos;
    const xOf = (t) => playX + (t - now) * p.pxPerSec;
    // ノート番号 n の行の中心 Y (上が高音)。
    const yOf = (n) => p.y + p.h - (n - lo + 0.5) * rowH;
    const tL = now - (playX - p.x) / p.pxPerSec;
    const tR = now + (p.x + p.w - playX) / p.pxPerSec;

    c2d.save();
    c2d.beginPath();
    c2d.rect(p.x, p.y, p.w, p.h);
    c2d.clip();

    // ---- 暗幕 (左右の端はフェード) ----
    if (p.backdrop > 0) {
      const edge = Math.min(p.w * 0.12, 160);
      const g = c2d.createLinearGradient(p.x, 0, p.x + p.w, 0);
      g.addColorStop(0, rgba([0, 0, 0], 0));
      g.addColorStop(edge / p.w, rgba([0, 0, 0], p.backdrop));
      g.addColorStop(1 - edge / p.w, rgba([0, 0, 0], p.backdrop));
      g.addColorStop(1, rgba([0, 0, 0], 0));
      c2d.fillStyle = g;
      c2d.fillRect(p.x, p.y, p.w, p.h);
    }

    // ---- 罫線 (半音ごと。黒鍵の行は少し暗く、C の線は濃く) ----
    if (p.gridStyle !== "none") {
      for (let n = lo; n <= hi; n++) {
        const top = p.y + p.h - (n - lo + 1) * rowH;
        if (p.gridStyle === "keys" && BLACK_KEYS.has(((n % 12) + 12) % 12)) {
          c2d.fillStyle = rgba(p.gridRgb, 0.025);
          c2d.fillRect(p.x, top, p.w, rowH);
        }
        c2d.fillStyle = rgba(p.gridRgb, ((n % 12) + 12) % 12 === 0 ? 0.16 : 0.05);
        c2d.fillRect(p.x, Math.round(top + rowH) - 0.5, p.w, 1);
      }
      // 1 秒ごとの縦線 (流れる)。
      c2d.fillStyle = rgba(p.gridRgb, 0.05);
      for (let s = Math.ceil(tL); s <= tR; s++) {
        c2d.fillRect(Math.round(xOf(s)) - 0.5, p.y, 1, p.h);
      }
    }

    // ---- ノート ----
    const noteH = Math.max(4, rowH * 0.62);
    c2d.font = font;
    c2d.textBaseline = "bottom";
    for (const note of notes) {
      if (note.end < tL || note.start > tR) continue;
      const x0 = xOf(note.start);
      const x1 = xOf(note.end);
      const cy = yOf(note.pitch);
      const active = note.start <= now && now < note.end;
      const past = note.end <= now;
      const alpha = p.noteOpacity;
      const fill = active ? whiten(p.noteRgb, 0.25) : (past ? darken(p.noteRgb, 0.45) : p.noteRgb);
      const noteW = Math.max(2, x1 - x0 - 1);
      const top = cy - noteH / 2;
      if (alpha > 0) {
        if (active && p.glow > 0) {
          c2d.shadowColor = rgba(p.noteRgb, 0.9);
          c2d.shadowBlur = 18 * p.glow;
        }
        roundRect(x0, top, noteW, noteH, p.noteRadius);
        c2d.fillStyle = rgba(fill, alpha);
        c2d.fill();
        c2d.shadowBlur = 0;
        if (!p.noteFlat) {
          // 立体: 上辺のハイライト (角丸の内側に収めるため同じ形でクリップ)。
          c2d.save();
          roundRect(x0, top, noteW, noteH, p.noteRadius);
          c2d.clip();
          c2d.fillStyle = rgba(whiten(fill, 0.6), alpha * 0.6);
          c2d.fillRect(x0, top, noteW, Math.max(1, noteH * 0.14));
          c2d.restore();
        }
      }
      if (p.showLyrics && note.lyric) {
        c2d.fillStyle = rgba([255, 255, 255], past ? 0.4 : 0.75);
        c2d.fillText(note.lyric, x0 + 2, cy - noteH / 2 - 3);
      }
    }

    // ---- これから歌う音程 (うっすら) ----
    if (p.showFuture) {
      const fut = curveSegments(now, tR, xOf, yOf);
      c2d.lineJoin = "round";
      c2d.lineCap = "round";
      strokeSegments(fut, rgba(p.lineRgb, 0.16), Math.max(1, p.lineWidth * 0.5));
    }

    // ---- 歌い終えた音程線 (多段の加算発光 + 尾のフェード) ----
    const past = curveSegments(tL, now, xOf, yOf);
    if (past.length) {
      const trailX = xOf(now - p.trailSec);
      const grad = (rgb, a) => {
        const g = c2d.createLinearGradient(Math.min(trailX, playX - 1), 0, playX, 0);
        g.addColorStop(0, rgba(rgb, a * 0.35));
        g.addColorStop(1, rgba(rgb, a));
        return g;
      };
      c2d.lineJoin = "round";
      c2d.lineCap = "round";
      c2d.globalCompositeOperation = "lighter";
      const lw = p.lineWidth;
      if (p.glow > 0) {
        strokeSegments(past, grad(p.lineRgb, 0.10 * p.glow), lw * 10);
        strokeSegments(past, grad(p.lineRgb, 0.22 * p.glow), lw * 5);
        strokeSegments(past, grad(p.lineRgb, 0.55 * p.glow), lw * 2.4);
      }
      c2d.globalCompositeOperation = "source-over";
      strokeSegments(past, grad(whiten(p.lineRgb, 0.75), 1), lw);
    }

    // ---- 再生位置の線と光の玉 ----
    if (p.playheadLine) {
      c2d.fillStyle = rgba(p.gridRgb, 0.35);
      c2d.fillRect(Math.round(playX) - 0.5, p.y, 1, p.h);
    }
    const head = headAt(now);
    if (head && p.glow > 0) {
      const lvl = levelAt(now);
      const hy = yOf(head.pitch);
      const r = (30 + 80 * lvl) * p.glow * (0.4 + 0.6 * head.fade);
      c2d.globalCompositeOperation = "lighter";
      c2d.globalAlpha = head.fade;
      const g = c2d.createRadialGradient(playX, hy, 0, playX, hy, r);
      g.addColorStop(0, rgba([255, 255, 255], 0.95));
      g.addColorStop(0.18, rgba(whiten(p.lineRgb, 0.4), 0.8));
      g.addColorStop(0.5, rgba(p.lineRgb, 0.28));
      g.addColorStop(1, rgba(p.lineRgb, 0));
      c2d.fillStyle = g;
      c2d.fillRect(playX - r, hy - r, r * 2, r * 2);
      // 横に伸びるレンズの光条
      const sw = r * 2.6;
      const sg = c2d.createLinearGradient(playX - sw, 0, playX + sw, 0);
      sg.addColorStop(0, rgba(p.lineRgb, 0));
      sg.addColorStop(0.5, rgba(whiten(p.lineRgb, 0.6), 0.55 * Math.min(1, 0.4 + lvl)));
      sg.addColorStop(1, rgba(p.lineRgb, 0));
      c2d.fillStyle = sg;
      c2d.fillRect(playX - sw, hy - 1.5, sw * 2, 3);
      c2d.globalAlpha = 1;
      c2d.globalCompositeOperation = "source-over";
    }
    c2d.restore();
  }

  let lastKey = "";
  function update(frameState) {
    const now = Number(frameState?.sceneSec);
    const t = Number.isFinite(now) ? now : (Number(ctx.cutStartSec) || 0) + (Number(frameState?.elapsedSec) || 0);
    const p = normalizeParams(params, canvas.width, canvas.height);
    const key = `${t.toFixed(4)}`;
    if (key === lastKey) return;
    lastKey = key;
    mat.opacity = p.opacity;
    render(p, t);
    texture.needsUpdate = true;
  }
  update({ sceneSec: Number(ctx.cutStartSec) || 0, elapsedSec: 0, frameIdx: 0 });

  function dispose() {
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }
  return { object3D: mesh, update, dispose };
}
