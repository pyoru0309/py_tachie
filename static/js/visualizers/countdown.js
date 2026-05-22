// =============================================================================
// visualizers/countdown.js
//
// カウントダウン GL プラグイン。Python 版 plugins/visualizers/countdown.py の
// 出力を canvas2d + CanvasTexture で再現する。
//
// 戦略:
//   - 1920x1080 オフスクリーン canvas に描画 (Python の empty_canvas と同サイズ)
//   - 表示テキストが変わった瞬間 (整数秒境界 / paramsKey 変更) のみ再描画 +
//     `texture.needsUpdate = true` で 1Hz 程度の upload に抑える。
//   - 1080p 連番 PNG (24fps × N frames) と比較して桁違いに軽い:
//       PNG: 24Hz × 8MB = 192MB/s
//       本実装: 1Hz × 8MB =   8MB/s (24x)
//   - 将来は表示領域だけのオフスクリーン canvas に縮小して 1MB 程度に落とせる
//     余地もあるが、現状でも十分。
// =============================================================================

function fontSpec(cssWeight, size, cssFamilyStack) {
  // canvas2d の font 文字列。cssWeight は CSS 数値 ("400" / "700" 等)、
  // cssFamilyStack は既に quote 済みの family stack (例: '"LINE Seed JP", sans-serif')。
  // resolver 経由で渡される前提なので、ここで再度クオートしない。
  const w = (cssWeight && String(cssWeight).trim()) || "400";
  const f = (cssFamilyStack && String(cssFamilyStack).trim()) || "sans-serif";
  return `${w} ${size}px ${f}`;
}

function formatTime(remainingSec, fmt, fps, freeze) {
  let r = remainingSec;
  if (freeze && r < 0) r = 0;
  const sign = r < 0 ? "-" : "";
  const rs = Math.abs(r);
  const totalSec = Math.floor(rs);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  let frames = Math.round((rs - totalSec) * Math.max(1, fps));
  if (frames >= Math.max(1, fps)) frames = Math.max(1, fps) - 1;
  const pad2 = (n) => String(n).padStart(2, "0");
  if (fmt === "MM:SS") return `${sign}${pad2(minutes)}:${pad2(seconds)}`;
  if (fmt === "M:SS") return `${sign}${minutes}:${pad2(seconds)}`;
  if (fmt === "SS") return `${sign}${pad2(totalSec)}`;
  if (fmt === "MM:SS.FF") return `${sign}${pad2(minutes)}:${pad2(seconds)}.${pad2(frames)}`;
  return `${sign}${pad2(minutes)}:${pad2(seconds)}`;
}

// 0 を有効値として保持する numeric 取り出し。`Number(v) || fallback` だと 0 が
// falsy 扱いで fallback に倒れて 0 を意図したユーザー設定が消えるため、
// `??` で undefined/null のときだけ fallback、Number 化後は有限性だけを判定する。
// Python の `int(p.get(key, default))` と等価な挙動。
function numParam(value, fallback) {
  const raw = value ?? fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// 与えられた params から表示用の正規化値を取り出す (Python plugin と同等の
// デフォルト・clip 規則)。
function normalizeParams(rawParams, width, height) {
  const p = rawParams || {};
  return {
    format: String(p.format || "MM:SS"),
    fontSize: Math.max(8, numParam(p.fontSize, 220)),
    subSize: Math.max(8, numParam(p.subTextSize, 56)),
    color: String(p.color || "#ffffff"),
    outlineColor: String(p.outlineColor || "#000000"),
    // ★ 0 が有効値: `|| 6` は 0 を 6 に戻してしまうので numParam を使う
    outlineWidth: Math.max(0, numParam(p.outlineWidth, 6)),
    cx: numParam(p.x, width / 2),
    cy: numParam(p.y, height / 2),
    prefix: String(p.prefixText || ""),
    suffix: String(p.suffixText || ""),
    fontFamily: String(p.fontFamily || ""),
    fontWeight: String(p.fontWeight || ""),
    opacity: Math.max(0, Math.min(1, numParam(p.opacity, 1.0))),
    freezeAtZero: String(p.freezeAtZero ?? "true") !== "false",
  };
}

function paramsCacheKey(p) {
  return [
    p.format, p.fontSize, p.subSize, p.color, p.outlineColor, p.outlineWidth,
    p.cx, p.cy, p.prefix, p.suffix, p.fontFamily, p.fontWeight, p.opacity,
  ].join("|");
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, sceneTotalSec, frameDurationSec, cutStartSec, fontResolver } = ctx;
  // scene-builder の update() は cut-local elapsedSec / sceneSec / frameIdx を渡す。
  // countdown は scene 内通算秒 (sceneSec) で remaining_sec を計算するため、
  // sceneSec が来ていればそれを優先、未提供 (古い contract) のときだけ
  // cutStartSec + elapsedSec で復元する。
  const cutStart = Number(cutStartSec) || 0;
  // fontResolver は scene-builder から注入される (state/manifest 依存を plugin に
  // 持ち込まないため)。未注入なら system fallback で動かす (PoC 等で minimal ctx の場合)。
  const resolveFont = typeof fontResolver === "function"
    ? fontResolver
    : (_family, weightId) => ({
        family: "sans-serif",
        weight: weightId === "bold" ? "700" : "400",
      });

  // オフスクリーン canvas: 1920x1080 RGBA。Pillow の empty_canvas と同じ前提で
  // 全画面 transparent → text 描画 → texture へ反映。
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

  // Y-down カメラ + DoubleSide。scene-builder の makePlane と同じ規約。
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

  // 表示テキストとパラメータのスナップショット (= 再描画判定キー)。
  let lastText = null;
  let lastParamsKey = "";

  function renderInto(p, mainText) {
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    if (p.opacity <= 0) return;

    // 内部 ID を CSS 値に解決。空文字 (= 既定書体) はプロジェクト既定にフォールバック
    // する責務が resolver にある。
    const cssFont = resolveFont(p.fontFamily, p.fontWeight);

    c2d.save();
    c2d.globalAlpha = p.opacity;
    c2d.textAlign = "center";

    // メインテキスト: 中央 (cx, cy) を視覚中心に置く。
    c2d.font = fontSpec(cssFont.weight, p.fontSize, cssFont.family);
    c2d.textBaseline = "middle";
    if (p.outlineWidth > 0) {
      c2d.strokeStyle = p.outlineColor;
      // canvas2d の lineWidth は中心線基準 (両側に lineWidth/2 ずつ伸びる)。
      // Pillow の stroke_width=W は片側 W px 描画なので、canvas で同じ
      // 太さを出すには lineWidth = W * 2 にする (telop 経路と同じ規約)。
      c2d.lineWidth = p.outlineWidth * 2;
      c2d.lineJoin = "round";
      c2d.miterLimit = 2;
      c2d.strokeText(mainText, p.cx, p.cy);
    }
    c2d.fillStyle = p.color;
    c2d.fillText(mainText, p.cx, p.cy);

    // prefix/suffix の上下オフセットを決めるため、実測 ascent/descent を取得。
    // 取れない実装では fontSize/2 で近似 (Python の textbbox に対する近似精度)。
    const mainMetrics = c2d.measureText(mainText);
    const mainAsc = mainMetrics.actualBoundingBoxAscent || p.fontSize * 0.5;
    const mainDsc = mainMetrics.actualBoundingBoxDescent || p.fontSize * 0.5;

    if (p.prefix) {
      c2d.font = fontSpec(cssFont.weight, p.subSize, cssFont.family);
      c2d.textBaseline = "alphabetic";
      const subOutline = Math.max(0, Math.floor(p.outlineWidth / 2));
      const py = p.cy - mainAsc - 8;
      if (subOutline > 0) {
        c2d.strokeStyle = p.outlineColor;
        c2d.lineWidth = subOutline * 2;
        c2d.strokeText(p.prefix, p.cx, py);
      }
      c2d.fillStyle = p.color;
      c2d.fillText(p.prefix, p.cx, py);
    }
    if (p.suffix) {
      c2d.font = fontSpec(cssFont.weight, p.subSize, cssFont.family);
      c2d.textBaseline = "hanging";
      const subOutline = Math.max(0, Math.floor(p.outlineWidth / 2));
      const sy = p.cy + mainDsc + 8;
      if (subOutline > 0) {
        c2d.strokeStyle = p.outlineColor;
        c2d.lineWidth = subOutline * 2;
        c2d.strokeText(p.suffix, p.cx, sy);
      }
      c2d.fillStyle = p.color;
      c2d.fillText(p.suffix, p.cx, sy);
    }

    c2d.restore();
  }

  function updateImpl(elapsedSecInCut, sceneSecOverride) {
    const p = normalizeParams(params, canvas.width, canvas.height);
    const total = Number(sceneTotalSec) || 0;
    const sceneSec = Number.isFinite(sceneSecOverride)
      ? Number(sceneSecOverride)
      : cutStart + (Number(elapsedSecInCut) || 0);
    const remaining = Math.max(-3600, total - sceneSec);
    // fps は visualizer 自身の更新粒度 (例 1/12 s ⇒ 12fps)。
    // MM:SS.FF 表示時に「.FF」桁が量子化される基準として使う。
    const vizFps = Math.max(1, Math.round(1 / Math.max(1e-6, Number(frameDurationSec) || (1 / 12))));
    const text = formatTime(remaining, p.format, vizFps, p.freezeAtZero);
    const pk = paramsCacheKey(p);
    if (text === lastText && pk === lastParamsKey) return;
    lastText = text;
    lastParamsKey = pk;
    renderInto(p, text);
    texture.needsUpdate = true;
  }

  // 初期描画 (空 canvas のままだと初フレームが透明になる)。
  updateImpl(0);

  function update(frameState) {
    updateImpl(
      Number(frameState?.elapsedSec) || 0,
      Number(frameState?.sceneSec),
    );
  }
  function dispose() {
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  return { object3D: mesh, update, dispose };
}
