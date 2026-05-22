// =============================================================================
// title-editor / draw.js
//
// canvas 描画ヘルパ。
// 描画は本体エディタと同じ drawTextClip + per-clip 静的キャッシュ経路
// (= getOrBakeStaticClipOffscreen) を通す。drawCaptionClip 直呼びだと
// effectPreset / animation の処理経路が分岐し、また clip ごとの canvas state
// (= 連続 drawCaptionClip の glow/dropShadow scratch 状態) を main canvas に
// 持ち越して subpixel な描写差が出ることがあるため、本体と同じ「offscreen に
// 焼いて drawImage で貼る」フローに統一する。
// =============================================================================

import {
  drawTextClip,
  resolveClipRuntimeFlags,
  makeClipOffscreenCache,
  getOrBakeStaticClipOffscreen,
  evictUnusedClipOffscreens,
} from "../renderer/text-clip-draw.js";
import { releaseTextScratch } from "../renderer/text-core.js";
import { inkBox } from "./bbox.js";

// per-clip 静的キャッシュ (= 本体の refreshTelopCanvas と同等)。clip.id 単位で
// 焼いた offscreen を保持し、同 fingerprint なら drawImage で再利用する。
const _staticCache = makeClipOffscreenCache();

// canvas を表示枠 (frame) に inscribe (= 16:9 を維持しつつ枠内に最大表示)
// 内部解像度は 1920×1080 を維持し、表示サイズだけ CSS で調整する。
export function fitCanvasToFrame(canvas, frame) {
  if (!canvas || !frame) return;
  const rect = frame.getBoundingClientRect();
  // frame は title-editor.css 側で 16:9 のアスペクトを保つので、ここでは
  // CSS の幅 = 枠の幅、高さは aspectRatio から決まる。canvas は内部解像度を
  // 1920×1080 のまま維持して toBlob で 1920×1080 PNG を取れる状態を保つ。
  // 上下マージンの計算はしない (CSS のレイアウトに任せる)。
  canvas.style.width = `${Math.floor(rect.width)}px`;
  canvas.style.height = `${Math.floor(rect.width * canvas.height / canvas.width)}px`;
}

// canvas にコンポジションを 1 回焼く。
//   options.selectedClipId: プライマリ選択 (= 角ハンドル付きで強調)
//   options.selectedClipIds: 複数選択集合 (= 破線枠だけ)
//   options.snapGuides: スナップガイド配列 [{kind:"vertical"|"horizontal", value:number}]
//   options.overrideTransparent: true なら背景描画をスキップ (= 透過 PNG 書き出し)
//   options.showGuides: false なら選択枠も描かない (= PNG 書き出し時)
export function drawComposition(canvas, composition, options = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !composition) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  // 背景
  const transparent = options.overrideTransparent ?? !!composition.background?.transparent;
  if (!transparent) {
    ctx.fillStyle = composition.background?.color || "#1e1e1e";
    ctx.fillRect(0, 0, w, h);
  }
  // clips を順に描画 (= 配列前方が奥)。
  // 本体エディタと同じ「per-clip offscreen を焼いて drawImage で貼る」経路。
  // - 静的 clip (= effect/animation の動きが無い) は 1920×1080 の offscreen に
  //   1 回だけ焼いて fingerprint キャッシュし、毎 redraw で drawImage 1 発で済ます
  // - 動的 clip は drawTextClip で main canvas へ直接描く (= 本体と同様)
  // タイトルエディタの timelineSec は窓 (startFrame=0, durationFrame=100000) の中なら
  // 何でもよく、0.5 で固定 (= 本体エディタの sceneSec と概念は別だが drawCaptionClip
  // 内の窓判定は通せる)。
  const sceneSec = 0.5;
  const drawCtx = { canvasW: w, canvasH: h, characterAnimationFps: 30 };
  const activeIds = [];
  for (const clip of composition.clips || []) {
    if (!clip || !String(clip.text || "")) continue;
    activeIds.push(clip.id);
    try {
      const flags = resolveClipRuntimeFlags(clip, sceneSec, drawCtx);
      const dynamic = flags.needsLayerComposite || flags.needsOffscreenRedraw;
      if (!dynamic) {
        const off = getOrBakeStaticClipOffscreen(_staticCache, clip, sceneSec, w, h, drawCtx);
        if (off) ctx.drawImage(off, 0, 0);
      } else {
        drawTextClip(ctx, clip, sceneSec, 0, drawCtx);
      }
    } catch (err) {
      console.error("[title-editor] drawTextClip failed", err, clip);
    }
  }
  // 動的 clip 経路で使った glow/dropShadow scratch を解放 (本体と同じ)
  releaseTextScratch();
  // active 集合に含まれない clip キャッシュは破棄 (メモリ節約)
  evictUnusedClipOffscreens(_staticCache, activeIds);
  if (options.showGuides === false) { ctx.restore(); return; }

  const selectedIds = options.selectedClipIds instanceof Set
    ? options.selectedClipIds
    : new Set(options.selectedClipId ? [options.selectedClipId] : []);

  // スナップガイド (= ドラッグ中の青破線)。レイヤー枠より下に描く方が読みやすい。
  if (Array.isArray(options.snapGuides) && options.snapGuides.length > 0) {
    ctx.save();
    ctx.strokeStyle = "#ff7e7e";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    for (const g of options.snapGuides) {
      ctx.beginPath();
      if (g.kind === "vertical") {
        ctx.moveTo(g.value, 0);
        ctx.lineTo(g.value, h);
      } else {
        ctx.moveTo(0, g.value);
        ctx.lineTo(w, g.value);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // 選択中の clip 全部に破線枠 (ink ベース)
  for (const clip of composition.clips || []) {
    if (!selectedIds.has(clip.id)) continue;
    const isPrimary = clip.id === options.selectedClipId;
    const b = inkBox(clip);
    const bw = b.w;
    const bh = b.h;
    const x = b.x;
    const y = b.y;
    ctx.save();
    ctx.strokeStyle = isPrimary ? "#5ad7ff" : "#8bdcff";
    ctx.lineWidth = isPrimary ? 2 : 1.5;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(x, y, bw, bh);
    if (isPrimary) {
      ctx.setLineDash([]);
      ctx.fillStyle = "#5ad7ff";
      const hs = 6;
      ctx.fillRect(x - hs/2, y - hs/2, hs, hs);
      ctx.fillRect(x + bw - hs/2, y - hs/2, hs, hs);
      ctx.fillRect(x - hs/2, y + bh - hs/2, hs, hs);
      ctx.fillRect(x + bw - hs/2, y + bh - hs/2, hs, hs);
    }
    ctx.restore();
  }
  ctx.restore();
}
