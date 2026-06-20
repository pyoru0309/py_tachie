// =============================================================================
// export/export-session.js
//
// WebGL export の orchestrator。`runExportSession` (= 1 cut) と
// `runProjectExportSession` (= シナリオ全体) を提供する。両者は内部 helper
// (renderer/manifest/WS/readback/cut frame loop/gap frame loop) を共有する。
//
// 設計上の絶対ルール:
//   - 時間は frameIdx / fps だけで進める。performance.now() / AudioContext
//     currentTime / HTMLVideoElement currentTime はこの経路に絶対入れない
//   - PBO ring は session 全体で **連続運用**。cut/scene/gap 境界で
//     flushRemaining を呼ばない (二重回収バグ。dev_docs/v2_export_multi_cut.md §3.4)
//   - cut ごとに scene rebuild を前提 (token 再利用は現行 payload-hash では
//     基本効かない)。fetch/build オーバーヘッドは PBO では吸収されないので
//     落ち幅は実測する
// =============================================================================
import {
  initRenderer,
  buildSceneFromLayerData,
  setActiveScene,
  disposeActiveScene,
  renderActiveScene,
  getActiveScene,
} from "/static/js/renderer/index.js";
import * as THREE from "three";
import { getRenderer, renderScene } from "/static/js/renderer/core.js";
import {
  preloadVisualizerImages,
  buildGapScene,
} from "/static/js/renderer/scene-builder.js";
import { state } from "/static/js/state.js";
import { registerProjectFonts } from "/static/js/font.js";
import { createReadback } from "./pbo-readback.js";
import { createH264FrameEncoder, computeBitrate } from "./webcodecs-encoder.js";
import { FrameSender } from "./frame-sender.js";

const FONT_READY_TIMEOUT_MS = 5000;
const PROJECT_FPS = 24;

// =============================================================================
// 口パク / まばたき / モーションの deterministic 計算
// =============================================================================
// preview (playback.js) は real-time AudioContext + AnalyserNode で口パクを
// 動かすが、export では determinism を壊すので使えない。代わりに:
//   - server がカット毎の per-frame Float32 levels (= 正規化 + smoothing 済) と
//     blink 開始 frame indices (deterministic seed) を scene-bundle に同梱
//   - export 側は frameIdx で levels[frameIdx] を引き、blink は frame index で
//     active 区間を判定する
// 数式は playback.js の eyeKeyForTime / mouthKeyFromVolume と一致させる。

// 目パチパターン (playback.js の blinkPattern と一致させる)。
//   algorithm="anime"   : 「開き→閉じ→中→開き」のスナップ閉じ + 段階開き。
//   algorithm="uniform" : 各 fps で均等な短い目パチ。中目なしキャラは更に短くなる。
function blinkPatternForExport(animationFps, algorithm = "anime", hasHalf = true) {
  const fps = Number(animationFps) || 12;
  if (algorithm === "uniform") {
    if (hasHalf) {
      if (fps <= 8) return ["closed", "half"];
      if (fps <= 12) return ["closed", "half"];
      return ["closed", "closed", "closed", "half", "half", "half"];
    }
    if (fps <= 8) return ["closed"];
    if (fps <= 12) return ["closed", "closed"];
    return ["closed", "closed", "closed"];
  }
  if (fps <= 8) return ["closed", "half"];
  if (fps <= 12) return ["closed", "closed", "half"];
  return ["closed", "closed", "closed", "half", "half", "half"];
}

function eyeKeyForElapsed(elapsedSec, blinkStartsSec, animationFps, algorithm = "anime", hasHalf = true) {
  const fps = Number(animationFps) || 12;
  const frameIdx = Math.floor(elapsedSec * fps + 1e-6);
  const pattern = blinkPatternForExport(fps, algorithm, hasHalf);
  for (const startSec of blinkStartsSec) {
    const startFrame = Math.round(startSec * fps);
    const offset = frameIdx - startFrame;
    if (offset >= 0 && offset < pattern.length) return pattern[offset];
  }
  return "open";
}

function mouthKeyFromVolume(volume, lipSync) {
  // analyser 未準備 / silence → "default" (= カット選択の口)。playback.js と一致。
  if (volume == null) return "default";
  const silence = Number(lipSync?.silenceThreshold ?? 0.08);
  const open = Number(lipSync?.openThreshold ?? 0.42);
  if (volume < silence) return "default";
  if (volume < open) return "mid";
  return "open";
}

// 呼吸 (breath) と BPM bob: scene-level の連続関数。`timelineSec` は scene 内
// 通算秒 (= cutStartSec + cutFrameIdx / fps)。playback.js computeIdleMotionOffset
// と数式を一致させる (= 同じ scene のシーン跨ぎカットでも位相が連続する)。
function computeIdleMotionOffset(idleMotion, timelineSec) {
  let dy = 0;
  const t = Number(timelineSec) || 0;
  const breath = idleMotion?.breath;
  if (breath) {
    const amp = Math.max(0, Number(breath.amplitudePx) || 0);
    const period = Math.max(0.05, Number(breath.periodSec) || 4);
    if (amp > 0 && period > 0) {
      dy += amp * Math.sin((2 * Math.PI * t) / period);
    }
  }
  const bpm = Number(idleMotion?.bpm) || 0;
  const bob = idleMotion?.bpmBob;
  if (bpm > 0 && bob) {
    const amp = Math.max(0, Number(bob.amplitudePx) || 0);
    if (amp > 0) {
      const period = 60.0 / bpm;
      dy += amp * Math.sin((2 * Math.PI * t) / period);
    }
  }
  return { dx: 0, dy };
}

// shake_x / shake_y: amp * sin(2π * count * t / duration) (cut-local)。
// move: startFrame〜startFrame+durationFrame の間で startX/Y → endX/Y へ補間。
function computeShakeOffset(motionType, motionSettings, elapsedSec) {
  if (motionType === "shake_x" || motionType === "shake_y") {
    const cfg = motionType === "shake_x"
      ? (motionSettings?.shakeX || {})
      : (motionSettings?.shakeY || {});
    const amp = Number(cfg.amplitude || 0);
    const count = Number(cfg.count || 0);
    const duration = Number(cfg.duration || 0);
    if (amp > 0 && count > 0 && duration > 0 && elapsedSec < duration) {
      const offset = amp * Math.sin((2 * Math.PI * count * elapsedSec) / duration);
      if (motionType === "shake_x") return { dx: offset, dy: 0 };
      return { dx: 0, dy: offset };
    }
    return { dx: 0, dy: 0 };
  }
  if (motionType === "move") {
    return _computeMoveOffsetForExport(motionSettings?.move, elapsedSec);
  }
  return { dx: 0, dy: 0 };
}

// M-2: 各キャラの character.motion から { dx, dy, scale? } の motionOffsetByChar を構築。
function _computePerCharacterMotionOffsetsForExport(characters, localElapsedSec) {
  const result = {};
  for (const char of characters || []) {
    if (!char.id || !char.motion?.type || char.motion.type === "none") continue;
    const mt = char.motion.type;
    const settings = char.motion.settings || {};
    if (mt === "shake_x" || mt === "shake_y") {
      const cfg = mt === "shake_x" ? (settings.shakeX || {}) : (settings.shakeY || {});
      const amp = Number(cfg.amplitude || 0);
      const count = Number(cfg.count || 0);
      const dur = Number(cfg.duration || 0);
      if (amp > 0 && count > 0 && dur > 0 && localElapsedSec < dur) {
        const offset = amp * Math.sin((2 * Math.PI * count * localElapsedSec) / dur);
        result[char.id] = mt === "shake_x" ? { dx: offset, dy: 0 } : { dx: 0, dy: offset };
      }
    } else if (mt === "move") {
      const mo = _computeMoveOffsetForExport(settings.move, localElapsedSec);
      if (mo.dx !== 0 || mo.dy !== 0 || mo.opacity !== 1
          || mo.rotationDeg !== 0 || mo.scaleMul !== 1) {
        const rawPivotX = Number(settings.move?.pivotX);
        const rawPivotY = Number(settings.move?.pivotY);
        result[char.id] = {
          dx: mo.dx, dy: mo.dy,
          scale: mo.scaleMul,
          rotationDeg: mo.rotationDeg,
          opacity: mo.opacity,
          pivotX: Number.isFinite(rawPivotX) ? rawPivotX : null,
          pivotY: Number.isFinite(rawPivotY) ? rawPivotY : null,
        };
      }
    } else if (mt === "zoom") {
      const sc = Number(settings.zoom?.scale || 1);
      if (sc > 0 && sc !== 1) result[char.id] = { dx: 0, dy: 0, scale: sc };
    }
  }
  return result;
}

// Phase 1: 移動モーション (linear / easeIn / easeOut / easeInOut)。
// startFrame / durationFrame は PROJECT_FPS (= 24fps) 基準のフレーム数。
// 戻り値: { dx, dy, opacity, rotationDeg, scaleMul }
function _computeMoveOffsetForExport(move, elapsedSec) {
  const identity = { dx: 0, dy: 0, opacity: 1, rotationDeg: 0, scaleMul: 1 };
  if (!move) return identity;
  const FPS = 24; // PROJECT_FPS は timecode.js 由来だが export 経路では定数で十分
  const startFrame = Math.max(0, Number(move.startFrame) || 0);
  const durationFrame = Math.max(1, Number(move.durationFrame) || 1);
  const startX = Number(move.startX) || 0;
  const startY = Number(move.startY) || 0;
  const endX = Number(move.endX) || 0;
  const endY = Number(move.endY) || 0;
  const clampOpacity = (v, f) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : f;
  };
  const clampScale = (v, f) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : f;
  };
  const startOpacity = clampOpacity(move.startOpacity, 1);
  const endOpacity = clampOpacity(move.endOpacity, 1);
  const startRot = Number(move.startRotation) || 0;
  const endRot = Number(move.endRotation) || 0;
  const startScale = clampScale(move.startScale, 1);
  const endScale = clampScale(move.endScale, 1);
  const easing = move.easing || "linear";
  const currentFrame = (Number(elapsedSec) || 0) * FPS;
  if (currentFrame < startFrame) {
    return {
      dx: startX, dy: startY,
      opacity: startOpacity, rotationDeg: startRot, scaleMul: startScale,
    };
  }
  if (currentFrame >= startFrame + durationFrame) {
    return {
      dx: endX, dy: endY,
      opacity: endOpacity, rotationDeg: endRot, scaleMul: endScale,
    };
  }
  const tRaw = (currentFrame - startFrame) / durationFrame;
  const t = (() => {
    const x = Math.max(0, Math.min(1, tRaw));
    switch (easing) {
      case "easeIn":  return x * x;
      case "easeOut": return 1 - (1 - x) * (1 - x);
      case "easeInOut":
        return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) * (-2 * x + 2)) / 2;
      default:        return x;
    }
  })();
  return {
    dx: startX + (endX - startX) * t,
    dy: startY + (endY - startY) * t,
    opacity: startOpacity + (endOpacity - startOpacity) * t,
    rotationDeg: startRot + (endRot - startRot) * t,
    scaleMul: startScale + (endScale - startScale) * t,
  };
}

// scene-bundle の lipSyncLevels.url を Float32Array で fetch。
async function fetchLipSyncLevels(meta) {
  if (!meta?.url) return null;
  const res = await fetch(meta.url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`lipSyncLevels ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Float32Array(buf);
}

// videoTrack provider の lifecycle 管理 (1 つの export session で複数カット
// が同じ videoTrack を共有する場合、re-init を避ける)。
//
// acquire(videoTrackInfo) は同じ src なら現在の provider を返し、違う src なら
// 古いものを dispose して新規 init する。dispose() で全解放。
function createVideoProviderManager() {
  let current = null;
  let currentSrc = null;
  return {
    async acquire(videoTrackInfo, onLog = () => {}) {
      if (!videoTrackInfo?.src) return null;
      if (currentSrc === videoTrackInfo.src && current) return current;
      if (current) {
        try { current.dispose(); } catch (_) {}
        current = null;
        currentSrc = null;
      }
      const mod = await import("/static/js/renderer/video-provider.js");
      const p = new mod.WebCodecsVideoProvider();
      onLog(`videoProvider init: ${videoTrackInfo.src} (WebCodecs)`);
      const t0 = performance.now();
      await p.init(videoTrackInfo);
      onLog(`videoProvider init done in ${(performance.now() - t0).toFixed(0)}ms`);
      current = p;
      currentSrc = videoTrackInfo.src;
      return p;
    },
    dispose() {
      if (current) {
        try { current.dispose(); } catch (_) {}
        current = null;
        currentSrc = null;
      }
    },
  };
}

// =============================================================================
// 共有 helper
// =============================================================================

// /v2-export ページは独自の state インスタンスを持つ (各 HTML が別 module graph)。
// telop / dialogue は state.manifest.config.fonts から書体を解決するので、
// scene build の前に manifest を取って FontFace.load() を完了させておく必要がある。
//
// 重要: プロジェクト切替時は cache を invalidate する。state.__exportProjectId
// に最後に読み込んだ projectId を記録し、引数の projectId と異なれば必ず
// 再 fetch + 再 register。これを怠ると、別プロジェクトの fonts が登録された
// まま新プロジェクトの telop を描いて fallback font に落ちる。
async function ensureManifestAndFontsLoaded(onLog, projectId) {
  const projectChanged =
    !!projectId && state.__exportProjectId && state.__exportProjectId !== projectId;
  if (projectChanged) {
    onLog(`project changed (${state.__exportProjectId} → ${projectId}): manifest/fonts invalidate`);
    state.manifest = null;
    state.__exportFontsRegistered = false;
  }
  if (!state.manifest) {
    const manifestUrl = projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/manifest`
      : "/api/manifest";
    onLog(`fetching ${manifestUrl} ...`);
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    state.manifest = await res.json();
    if (projectId && state.manifest?.projectId && state.manifest.projectId !== projectId) {
      throw new Error(`manifest project mismatch: expected ${projectId}, got ${state.manifest.projectId}`);
    }
    state.__exportProjectId = projectId || state.__exportProjectId || "";
  }
  if (!state.__exportFontsRegistered) {
    onLog("registering project fonts ...");
    try {
      await registerProjectFonts();
    } catch (err) {
      onLog(`registerProjectFonts failed: ${err?.message || err}`, "warn");
    }
    state.__exportFontsRegistered = true;
  }
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, FONT_READY_TIMEOUT_MS)),
      ]);
    } catch (err) {
      onLog(`document.fonts.ready 失敗: ${err?.message || err}`, "warn");
    }
  }
}

function setupRendererAndCanvas(canvas, width, height, readbackMode, onLog) {
  canvas.width = width;
  canvas.height = height;
  // 書き出しは毎フレーム gl.readPixels する経路。Windows ANGLE(D3D11) では MSAA
  // (antialias:true) の resolve が readback を直列化させ著しく遅くなる (2026-06-02
  // 調査で stalls 多発・throughput 頭打ちを確認)。書き出しは専用 canvas で renderer
  // を作り直すため、ここで antialias:false を渡しても preview (別 canvas で
  // antialias:true) には影響しない。preserveDrawingBuffer も書き出しでは不要なので
  // false にして present コストを削る。出力はフル HD 等倍描画で品質は十分。
  initRenderer(canvas, { antialias: false, preserveDrawingBuffer: false });
  const renderer = getRenderer();
  renderer.setSize(width, height, false);
  // ★ clearColor を毎回 (0,0,0,0) に reset。renderer は singleton で preview /
  //   bench / 別 export session 間で持ち回されるため、過去に setClearColor 経由で
  //   alpha=1 が立っていると透明 codec 出力で「全面不透明」になる。
  //   bg plane を描く通常 cut では bg が opaque なので alpha=0 clear でも問題なく、
  //   透明 codec 出力では alpha=0 が必須。defensive に統一する。
  renderer.setClearColor(new THREE.Color(0, 0, 0), 0);
  renderer.clear(true, true, true);
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext) && readbackMode !== "sync") {
    throw new Error("PBO readback には WebGL2 が必要です (readbackMode=sync で再試行してください)");
  }
  onLog(`renderer ready (WebGL${gl instanceof WebGL2RenderingContext ? "2" : "1"})`);
  return { renderer, gl };
}

async function fetchSceneBundle(cut, projectId = "") {
  const cutState = cut.state || {};
  const body = {
    ...cutState,
    cutId: cut.id,
    duration: (cut.durationFrame || 0) / PROJECT_FPS,
    audio: cut.audio,
  };
  const sceneBundleUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/v2/scene-bundle`
    : "/api/v2/scene-bundle";
  const res = await fetch(sceneBundleUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`scene-bundle ${res.status}`);
  const data = await res.json();
  if (projectId && data?.projectId && data.projectId !== projectId) {
    throw new Error(`scene-bundle project mismatch: expected ${projectId}, got ${data.projectId}`);
  }
  return data;
}

async function fetchExportPlan() {
  const res = await fetch("/api/v2/export/plan");
  if (!res.ok) throw new Error(`plan ${res.status}`);
  return await res.json();
}

// 透過 codec (alpha 保持出力) は bg を WebGL 側で描かず alpha=0 で抜く。
// renderCutFrames / renderGapFrames で layerData.background を null にし、
// renderer の clearColor を (0,0,0,0) にすることで readPixels の alpha=0 が
// ffmpeg yuva444p10le / rgba にそのまま流れる。
const TRANSPARENT_ENCODERS = new Set(["prores_4444", "png_video"]);
function isTransparentEncoder(encoder) {
  return TRANSPARENT_ENCODERS.has(encoder);
}

// 本線 UI は v1 preset 経由 (videoPresetId) で書き出すため、encoder 文字列だけ
// では透過判定できない (encoder は handshake のダミー)。exportConfig.transparent
// を明示的に渡せば encoder 推定をスキップする。
function resolveTransparentFlag(exportConfig) {
  if (typeof exportConfig.transparent === "boolean") return exportConfig.transparent;
  return isTransparentEncoder(exportConfig.encoder);
}

// 先頭プリロール (leadInSec) ぶんの blank frame を発射する。中身は
// 透過 codec なら alpha=0、そうでなければ黒。scene を build せず GL clear だけ。
async function renderLeadInFrames({
  count, transparent, width, height, vflipMode,
  renderer, readback, sender, ctx, onLog, shouldAbort,
}) {
  if (!count) return;
  const black = new THREE.Color(0, 0, 0);
  renderer.setClearColor(black, transparent ? 0 : 1);
  // 空の Scene を 1 つ用意して clear+render だけ繰り返す。setActiveScene は呼ばず、
  // 通常の active scene には影響させない。
  const emptyScene = new THREE.Scene();
  for (let i = 0; i < count; i++) {
    if (shouldAbort && shouldAbort()) {
      onLog("aborted by user (leadIn loop)", "warn");
      break;
    }
    const _tGl = performance.now();
    renderScene(emptyScene);
    if (ctx) ctx.glRenderMs = (ctx.glRenderMs || 0) + (performance.now() - _tGl);
    await _readbackAndSend(readback, sender, vflipMode, width, height, ctx);
  }
  // 通常 cut の clear は (0,0,0,0) に統一。透明 codec なら bg plane 抑止で
  // alpha=0 が抜ける、不透明 codec なら bg plane が opaque で塗るため clear alpha
  // は不問。alpha=1 を残すと gap や透過 export を即座に汚すので必ず 0 に戻す。
  renderer.setClearColor(black, 0);
}

function cpuVerticalFlip(bytes, width, height) {
  const rowBytes = width * 4;
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < height >> 1; y++) {
    const top = y * rowBytes;
    const bot = (height - 1 - y) * rowBytes;
    tmp.set(bytes.subarray(top, top + rowBytes));
    bytes.copyWithin(top, bot, bot + rowBytes);
    bytes.set(tmp, bot);
  }
}

// readback + send を 1 frame ぶん回す共通ループ。
// stalled / send 失敗を caller に返す。warmup 中は bytes=null で送信 skip。
//
// ctx.diagAlphaRemaining > 0 のとき、readback 直後の RGBA から alpha 統計を
// ログに出して残数を 1 減らす (= 透明 codec の切り分け診断用)。
async function _readbackAndSend(readback, sender, vflipMode, width, height, ctx) {
  // WebCodecs 高速経路: readback (生 RGBA) せず、canvas を直接 H.264 エンコードして
  // 圧縮チャンクを送る。VideoFrame は描画直後の同期点で取り込む (encodeCanvas 内で
  // yield 前にキャプチャ済み)。送信は onChunk → sender.sendFrame を再利用。
  if (ctx.frameEncoder) {
    await ctx.frameEncoder.encodeCanvas(ctx.canvas, ctx.globalFrameIdx);
    ctx.globalFrameIdx += 1;
    return;
  }
  const rb = await readback.readback();
  if (rb.stalled) ctx.stallCount += 1;
  let bytesToSend = rb.bytes;
  if (bytesToSend && vflipMode === "cpu") {
    cpuVerticalFlip(bytesToSend, width, height);
  }
  if (bytesToSend && ctx.diagAlphaRemaining > 0) {
    ctx.diagAlphaRemaining -= 1;
    const stats = _alphaStats(bytesToSend, width, height);
    ctx.onLog?.(
      `alpha diag (frame ~${ctx.framesDiagSeen ?? 0}): `
      + `min=${stats.min} max=${stats.max} `
      + `zero=${stats.zero}/${stats.total} (${(stats.zero / stats.total * 100).toFixed(1)}%) `
      + `full=${stats.full}/${stats.total} (${(stats.full / stats.total * 100).toFixed(1)}%)`,
    );
    ctx.framesDiagSeen = (ctx.framesDiagSeen ?? 0) + 1;
  }
  if (bytesToSend) {
    await sender.sendFrame(bytesToSend);
  }
  if (readback.advance) readback.advance();
}

// transport=webcodecs-h264 のとき frameEncoder を生成して frameCtx に載せる。
// rawrgba (= 従来経路) のときは何もせず null を返す。チャンクは output コールバック
// から sender.sendBytesNow で同期送信する。生成できなかった例外は caller へ伝播。
function _setupFrameEncoder(exportConfig, dims, sender, canvas, frameCtx, onLog) {
  if (exportConfig.transport !== "webcodecs-h264") return null;
  const { width, height, fps } = dims;
  const bitrate = computeBitrate(width, height, fps, exportConfig.presetOptions?.maxrate);
  const frameEncoder = createH264FrameEncoder({
    width, height, fps, bitrate,
    onChunk: (bytes) => { sender.sendBytesNow(bytes); },
    onError: (e) => { onLog(`WebCodecs encoder error: ${e?.message || e}`, "err"); },
  });
  frameCtx.frameEncoder = frameEncoder;
  frameCtx.canvas = canvas;
  frameCtx.globalFrameIdx = 0;
  onLog(
    `WebCodecs H.264 エンコード有効: bitrate=${(bitrate / 1e6).toFixed(1)}Mbps`
    + ` (転送=圧縮チャンク / server=copy)`,
  );
  return frameEncoder;
}

// RGBA bytes (Uint8Array, 長さ=W*H*4) から alpha チャネル統計を返す。
// O(N) だが 1080p で ~2M pixel、診断は 3 frame だけなのでコスト微小。
function _alphaStats(bytes, width, height) {
  const total = width * height;
  let min = 255, max = 0, zero = 0, full = 0;
  for (let i = 0; i < total; i++) {
    const a = bytes[i * 4 + 3];
    if (a < min) min = a;
    if (a > max) max = a;
    if (a === 0) zero += 1;
    if (a === 255) full += 1;
  }
  return { min, max, zero, full, total };
}

// =============================================================================
// cut frame loop / gap frame loop
// =============================================================================

/**
 * 1 つのカットを N frame だけ render → readback → send。PBO ring は外から
 * 渡される (= session 全体で連続運用。境界で flush しない)。
 *
 * @returns {Promise<number>} このカットで render したフレーム数
 */
async function renderCutFrames({
  cut,
  fps,
  width,
  height,
  vflipMode,
  includeVisualizer,
  includeVideoTrack,
  transparent,                  // 透過 codec のとき true: bg plane を抑止して alpha=0 を抜く
  readback,
  sender,
  ctx,
  onLog,
  shouldAbort,
  // 動画レイヤー (per-scene で init 済み): provider Map と duration Map を渡す。
  // null のときは videoLayer を描画しない (= MVP の旧挙動)。
  videoLayerProvidersById = null,
  videoLayerDurations = null,
  projectId = "",
}) {
  // ★ カット境界コスト計測 (律速診断): fetchSceneBundle (HTTP + サーバ bundle 焼き) と
  //   buildSceneFromLayerData (キャラ PNG decode + GPU texture upload + scene 構築) を
  //   分離累積する。per-frame render ではなく「カット切替コスト × cut 数」が律速かを見る。
  const _tFetch = performance.now();
  const layerData = await fetchSceneBundle(cut, projectId);
  if (ctx) {
    ctx.fetchBundleMs = (ctx.fetchBundleMs || 0) + (performance.now() - _tFetch);
    // サーバが返す bundle 生成コスト内訳 (_timing) を累積 → fetch の 849ms/cut の正体
    // (lipsync ffmpeg / viz / その他) を export サマリで分解する。
    const _t = layerData && layerData._timing;
    if (_t) {
      ctx.srvTotalMs = (ctx.srvTotalMs || 0) + (Number(_t.total) || 0);
      ctx.srvLipsyncMs = (ctx.srvLipsyncMs || 0) + (Number(_t.lipsync) || 0);
      ctx.srvVizMs = (ctx.srvVizMs || 0) + (Number(_t.viz) || 0);
    }
  }
  if (!includeVisualizer) layerData.visualizer = null;

  // 透過 export: bg plane を描かない (画像 / videoTrack いずれも)。alpha=0 が
  // GL canvas → readPixels → ffmpeg yuva444p10le/rgba に流れて、編集アプリで
  // キャラ・テロップだけが切り抜かれた素材になる。
  if (transparent) {
    layerData.background = null;
    layerData.hasVideoTrack = false;
  }

  // videoLayer の per-cut 初期化 (provider を呼び出し側が渡さなかった場合のみ)。
  // 単一カット書き出し経路では runExportSession から呼ばれ、provider 引数が無い。
  // ここで layerData.videoLayers (scene-bundle が乗せた scene 全体の動画レイヤー)
  // から init し、関数末尾で必ず dispose する。
  let _ownedVideoLayerProviders = null;
  let _ownedVideoLayerDurations = null;
  const _ownVideoLayerProviders = !videoLayerProvidersById;
  if (_ownVideoLayerProviders && !transparent && includeVideoTrack
      && Array.isArray(layerData.videoLayers) && layerData.videoLayers.length > 0) {
    _ownedVideoLayerProviders = new Map();
    _ownedVideoLayerDurations = new Map();
    try {
      const { WebCodecsVideoProvider } = await import("/static/js/renderer/video-provider.js");
      const { mapVideoLayerSec } = await import("/static/js/renderer/video-layer-time.js");
      // demux 結果共有: 同一 src を持つ複数 VL (= 分割で生まれた続きレイヤー等) で
      // fetch + mp4box demux + sample sort を 1 回で済ませる。Promise<DemuxResult>
      // を cache に入れているので、Promise.all 内の並列 init でも 1 本だけ走る。
      const demuxCache = new Map();
      // 1) duration metadata を並列 fetch
      await Promise.all(layerData.videoLayers.map(async (vl) => {
        if (!vl?.src || _ownedVideoLayerDurations.has(vl.src)) return;
        try {
          const res = await fetch(`/api/video-duration?path=${encodeURIComponent(vl.src)}`);
          if (res.ok) {
            const data = await res.json();
            _ownedVideoLayerDurations.set(vl.src, {
              duration: Number(data.duration) || 0,
              width: Number(data.width) || 0,
              height: Number(data.height) || 0,
              hasAudio: !!data.hasAudio,
            });
          }
        } catch (err) {
          onLog(`videoLayer duration fetch failed (${vl.src}): ${err?.message || err}`, "warn");
        }
      }));
      // 2) per-layer provider を並列 init
      await Promise.all(layerData.videoLayers.map(async (vl) => {
        if (!vl?.id || !vl?.src) return;
        const dur = Number(_ownedVideoLayerDurations.get(vl.src)?.duration) || 0;
        if (dur <= 0) {
          onLog(`videoLayer ${vl.id} skipped (duration unresolved)`, "warn");
          return;
        }
        try {
          const mapFn = (sec) => mapVideoLayerSec(vl, sec, fps, dur);
          const p = new WebCodecsVideoProvider({ mapFn, demuxCache });
          await p.init(vl);
          _ownedVideoLayerProviders.set(vl.id, p);
        } catch (err) {
          onLog(`videoLayer provider init failed (${vl.id}): ${err?.message || err}`, "warn");
        }
      }));
      videoLayerProvidersById = _ownedVideoLayerProviders;
      videoLayerDurations = _ownedVideoLayerDurations;
      if (_ownedVideoLayerProviders.size > 0) {
        onLog(`videoLayer providers ready (per-cut): ${_ownedVideoLayerProviders.size}/${layerData.videoLayers.length}`);
      }
    } catch (err) {
      onLog(`videoLayer init (per-cut) failed: ${err?.message || err}`, "warn");
    }
  }

  // videoTrack: includeVideoTrack=true かつ scene が videoTrack を持つときだけ
  // WebCodecsVideoProvider を起動。MVP は per-cut で fresh init (= multi-cut で
  // 同一 src のときも重複 init する)。最適化は後段。scene の dispose で provider
  // も dispose されるので、各カット末で WebCodecs decoder は閉じられる。
  // 透過モードでは videoTrack も外す。
  let videoProvider = null;
  if (!transparent && includeVideoTrack && layerData.videoTrack?.src) {
    try {
      const mod = await import("/static/js/renderer/video-provider.js");
      videoProvider = new mod.WebCodecsVideoProvider();
      const t0 = performance.now();
      onLog(`videoProvider init (WebCodecs): ${layerData.videoTrack.src}`);
      await videoProvider.init(layerData.videoTrack);
      onLog(`videoProvider init done in ${(performance.now() - t0).toFixed(0)}ms`);
    } catch (err) {
      onLog(`videoProvider init failed: ${err?.message || err} → 透過 bg fallback`, "err");
      try { videoProvider?.dispose(); } catch (_) {}
      videoProvider = null;
    }
  }
  // hasVideoTrack は provider が用意できたときだけ true。bg plane は
  // videoProvider.getTexture() (= VideoFrameTexture or CanvasTexture) を貼る。
  layerData.hasVideoTrack = !!videoProvider;

  const _tBuild = performance.now();
  const sceneInstance = await buildSceneFromLayerData(
    layerData, videoProvider,
    videoLayerProvidersById, videoLayerDurations,
  );
  if (ctx) {
    ctx.buildSceneMs = (ctx.buildSceneMs || 0) + (performance.now() - _tBuild);
    ctx.cutBuildCount = (ctx.cutBuildCount || 0) + 1;
  }
  setActiveScene(sceneInstance);

  if (includeVisualizer && sceneInstance.meshes?.visualizer) {
    try {
      const n = await preloadVisualizerImages(sceneInstance);
      if (n > 0) onLog(`visualizer preload: ${n} png frames`);
    } catch (err) {
      onLog(`preloadVisualizerImages failed: ${err?.message || err}`, "warn");
    }
  }

  // animation timeline: blinkFrames (int frame indices) と lipSyncLevels (Float32 URL)
  // は scene-bundle 同梱。preview の AnalyserNode 経路を使わず、cut-local frame
  // index で deterministic に解決する。
  const blinkEnabled = layerData.blinkEnabled !== false;
  const lipSyncEnabled = layerData.lipSyncEnabled !== false;
  const blinkAlgorithm = layerData.blinkAlgorithm || "anime";
  const speakerId = layerData.speakerId || null;
  const lipSyncCfg = layerData.lipSync || {};
  const motionType = layerData.motion?.type || "none";
  const motionSettings = layerData.motion?.settings || {};
  // idleMotion は scene-level (breath / bpm / bpmBob)。位相は scene 内通算秒
  // (cutStartSec + cutFrameIdx/fps) で計算するため、シーン跨ぎカットで波が連続する。
  const idleMotion = layerData.idleMotion || null;
  const cutStartSec = Number(layerData.cutStartSec) || 0;
  // blinkFramesByChar: { [charId]: [frame indices] } → { [charId]: [sec...] }。
  // キャラごとに独立な schedule (server-side で char_id を seed に含めて生成) を秒換算
  // する。古い bundle (blinkFramesByChar 無し) でも layerData.blinkFrames に fallback
  // して旧挙動 (全員同タイミング) で動かす。
  const blinkStartsSecByChar = {};
  const rawBlinkByChar = layerData.blinkFramesByChar;
  if (rawBlinkByChar && typeof rawBlinkByChar === "object") {
    for (const [cid, arr] of Object.entries(rawBlinkByChar)) {
      if (!cid || !Array.isArray(arr)) continue;
      blinkStartsSecByChar[cid] = arr.map((f) => Number(f) / PROJECT_FPS);
    }
  }
  const blinkStartsSecFallback = (Array.isArray(layerData.blinkFrames) ? layerData.blinkFrames : [])
    .map((f) => Number(f) / PROJECT_FPS);
  // characterAnimationFps: 8 / 12 / 24。eye blink パターンの量子化基準。
  // scene-bundle に乗っている (preview と export で同じ値)。
  const animationFps = Number(layerData.characterAnimationFps) || 12;
  // lipSyncLevels.url を Float32Array で fetch (PNG visualizer streams と同じ流儀)。
  let levels = null;
  if (lipSyncEnabled && layerData.lipSyncLevels) {
    try {
      levels = await fetchLipSyncLevels(layerData.lipSyncLevels);
    } catch (err) {
      onLog(`lipSyncLevels fetch failed: ${err?.message || err}`, "warn");
    }
  }

  const total = Math.max(1, Number(cut.durationFrame) || 0);
  let rendered = 0;
  for (let f = 0; f < total; f++) {
    if (shouldAbort && shouldAbort()) {
      onLog("aborted by user (cut frame loop)", "warn");
      break;
    }
    const localElapsedSec = f / fps;
    const sceneSec = cutStartSec + localElapsedSec;

    // videoTrack: WebCodecs から target sceneSec の VideoFrame を bind。
    // sceneSec を渡すと provider 側で trimStartSec/speed/loop を適用する。
    if (videoProvider) {
      try {
        await videoProvider.updateForFrame({ sceneFrameIdx: f, sceneSec, fps });
      } catch (err) {
        onLog(`videoProvider.updateForFrame failed: ${err?.message || err}`, "warn");
      }
    }
    // 動画レイヤー: 各 provider に同じ sceneSec を渡す。inactive 範囲でも
    // updateForFrame は呼ぶ (= 末尾 frame の hold / 次の active 範囲への
    // 連続性を保つ)。並列化はせず、決定的な decode 順序を保証する。
    if (videoLayerProvidersById && videoLayerProvidersById.size > 0) {
      for (const [, p] of videoLayerProvidersById) {
        try {
          await p.updateForFrame({ sceneFrameIdx: f, sceneSec, fps });
        } catch (err) {
          onLog(`videoLayer updateForFrame failed: ${err?.message || err}`, "warn");
        }
      }
    }

    // mouthKey: speaker かつ levels あれば levels[f] から、なければ "default"
    // (= カット選択の口)。lipSync OFF のときも "default"。
    let mouthKey = "default";
    if (speakerId && lipSyncEnabled && levels && f < levels.length) {
      mouthKey = mouthKeyFromVolume(levels[f], lipSyncCfg);
    }
    // eyeKey: blink 有効なら blinkStartsSec で計算。均等方式は per-char で
    // 「中目あり/なし」によりパターン長が変わるため、キャラ単位に解決して
    // eyeKeyByChar として渡す。
    let eyeKeyByChar = null;
    if (blinkEnabled) {
      eyeKeyByChar = {};
      for (const char of layerData.characters || []) {
        if (!char.id || char.blinkEligible === false) continue;
        const hasHalf = !!char.eyeUrls?.half;
        // per-char schedule があればそれを優先 (== キャラ間で同期しない)。
        // 無ければ旧挙動 (cut 全体で 1 本) にフォールバック。
        const startsForChar = blinkStartsSecByChar[char.id] || blinkStartsSecFallback;
        eyeKeyByChar[char.id] = eyeKeyForElapsed(
          localElapsedSec, startsForChar, animationFps, blinkAlgorithm, hasHalf,
        );
      }
    }
    // shake / move / zoom: M-2 で per-character 化。各キャラの character.motion から
    // motionOffsetByChar を計算 (= scene global の旧経路は server normalize で
    // 話者キャラへ migrate 済みなのでここではほぼ no-op)。
    const shake = computeShakeOffset(motionType, motionSettings, localElapsedSec);
    const motionOffsetByChar = _computePerCharacterMotionOffsetsForExport(
      layerData.characters, localElapsedSec,
    );
    // idle (呼吸 / BPM bob): scene 内通算秒 (= sceneSec) で計算することで、
    // シーン跨ぎカットでも sin の位相が連続する。
    const idle = idleMotion
      ? computeIdleMotionOffset(idleMotion, sceneSec)
      : { dx: 0, dy: 0 };

    // GL render (= scene.update の per-frame JS: telop refresh / per-char texture /
    // motion 計算 + draw call 発行) の壁時計時間を累積する。律速診断用。WebGL は
    // deferred なので実 GPU 実行は encode (VideoFrame 化の同期点) に乗る = glRenderMs が
    // 大なら per-frame JS 律速、小さいのに fps 低なら GPU/encode 律速、と読める。
    const _tGl = performance.now();
    renderActiveScene({
      eyeKey: "open",
      eyeKeyByChar,
      mouthKey,
      speakerId,
      shakeDx: shake.dx,
      shakeDy: shake.dy,
      idleDx: idle.dx,
      idleDy: idle.dy,
      motionOffsetByChar,
      elapsedSec: localElapsedSec,
      animationFps: 12,
      frameIdx: f,
    });
    if (ctx) ctx.glRenderMs = (ctx.glRenderMs || 0) + (performance.now() - _tGl);
    await _readbackAndSend(readback, sender, vflipMode, width, height, ctx);
    rendered += 1;
    ctx.onCutFrameSent?.();
  }
  // 注意: ここで disposeActiveScene() しない。次のカット rebuild 時に setActiveScene
  // が古い instance を dispose する。今 dispose すると次の renderActiveScene までの
  // PBO ring fetch (前カットの絵) が壊れる。

  // per-cut で内部 init した videoLayer provider はここで必ず dispose。
  // (provider が呼び出し側から渡された場合は呼び出し側責任なので touch しない)
  if (_ownVideoLayerProviders && _ownedVideoLayerProviders) {
    for (const [, p] of _ownedVideoLayerProviders) {
      try { p.dispose(); } catch (_) { /* ignore */ }
    }
    _ownedVideoLayerProviders.clear();
  }
  return rendered;
}

/**
 * gap frame を N frame 描く。`gapInstance` はシーン単位で 1 回 build したものを
 * 渡す (sceneSec で telops を update)。bg が無いシーンは renderer.clearColor
 * を (0,0,0,0) にする (透過)。
 */
async function renderGapFrames({
  gapInstance,
  count,
  startSceneFrameIdx,
  fps,
  width,
  height,
  vflipMode,
  renderer,
  readback,
  sender,
  ctx,
  onLog,
  shouldAbort,
  // 動画レイヤー: gap 区間でも provider の updateForFrame を呼んで連続性を保つ。
  videoLayerProvidersById = null,
}) {
  const baseClear = new THREE.Color(0, 0, 0);
  if (gapInstance.isTransparent) {
    renderer.setClearColor(baseClear, 0);
  } else {
    renderer.setClearColor(baseClear, 1);
  }
  let rendered = 0;
  for (let i = 0; i < count; i++) {
    if (shouldAbort && shouldAbort()) {
      onLog("aborted by user (gap frame loop)", "warn");
      break;
    }
    const sceneSec = (startSceneFrameIdx + i) / fps;
    if (videoLayerProvidersById && videoLayerProvidersById.size > 0) {
      for (const [, p] of videoLayerProvidersById) {
        try {
          await p.updateForFrame({ sceneFrameIdx: i, sceneSec, fps });
        } catch (err) {
          onLog(`videoLayer updateForFrame (gap) failed: ${err?.message || err}`, "warn");
        }
      }
    }
    gapInstance.update({ sceneSec });
    const _tGl = performance.now();
    renderScene(gapInstance.scene);
    if (ctx) ctx.glRenderMs = (ctx.glRenderMs || 0) + (performance.now() - _tGl);
    await _readbackAndSend(readback, sender, vflipMode, width, height, ctx);
    rendered += 1;
    ctx.onCutFrameSent?.();
  }
  // 通常 cut の clear color に戻す (renderActiveScene の透過維持のため alpha=0)
  renderer.setClearColor(baseClear, 0);
  return rendered;
}

// =============================================================================
// runExportSession (= 1 cut export)
// =============================================================================
/**
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {Object} opts.cut
 * @param {string} opts.projectId
 * @param {Object} opts.exportConfig
 */
export async function runExportSession({
  canvas,
  cut,
  projectId,
  exportConfig,
  onLog = () => {},
  onProgress = () => {},
  onPhase = () => {},
  onEncoderProgress = () => {},
  shouldAbort = () => false,
}) {
  const {
    width, height, fps, encoder,
    readbackMode, vflipMode, bpThresholdMB,
    includeVisualizer = false,
    includeVideoTrack = false,
    outputPath = null,
    leadInSec = 0,
  } = exportConfig;
  const cutFrames = Math.max(
    1, Number(exportConfig.totalFrames) || Number(cut.durationFrame) || 0,
  );
  if (!cutFrames) throw new Error("totalFrames が決定できません (cut.durationFrame が空)");
  const transparent = resolveTransparentFlag(exportConfig);
  const leadInFrames = Math.max(0, Math.round((Number(leadInSec) || 0) * fps));
  const totalFrames = leadInFrames + cutFrames;

  const { renderer, gl } = setupRendererAndCanvas(canvas, width, height, readbackMode, onLog);
  await ensureManifestAndFontsLoaded(onLog, projectId);

  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const sender = new FrameSender({
    url: `${wsProto}//${location.host}/api/v2/export/ws`,
    handshake: {
      width, height, fps, encoder,
      vflip: vflipMode === "ffmpeg",
      totalFrames, projectId, cutId: cut.id,
      mode: "cut",
      ...(outputPath ? { outputPath } : {}),
      ...(exportConfig.transport ? { transport: exportConfig.transport } : {}),
      ...(exportConfig.videoPresetId ? { videoPresetId: exportConfig.videoPresetId } : {}),
      ...(exportConfig.presetOptions ? { presetOptions: exportConfig.presetOptions } : {}),
    },
    bpThresholdMB,
    onLog,
    onEncoderProgress,
  });
  await sender.open();

  const readback = createReadback(readbackMode, gl, width, height);
  if (readback.maxClientWaitTimeout != null) {
    onLog(`MAX_CLIENT_WAIT_TIMEOUT_WEBGL = ${readback.maxClientWaitTimeout}`);
  }

  const tStart = performance.now();
  const frameCtx = {
    stallCount: 0,
    glRenderMs: 0,  // GL render (per-frame JS update + draw call 発行) の累積壁時計 ms。律速診断用。
    fetchBundleMs: 0,  // カット境界の scene-bundle fetch 累積 ms (律速診断)。
    buildSceneMs: 0,   // カット境界の buildSceneFromLayerData (PNG decode + texture upload) 累積 ms。
    cutBuildCount: 0,  // build したカット数 (per-cut 平均算出用)。
    srvTotalMs: 0, srvLipsyncMs: 0, srvVizMs: 0,  // サーバ bundle 生成コストの内訳 (_timing 集計)。
    // 透明 codec のときだけ最初の 3 frame で alpha 統計をログに出す。
    // min=0 なら readPixels に透明 pixel が乗っている (= GL 側 OK)、
    // min=255 なら GL 側で alpha=255 になっており codec ではなく上流が原因。
    diagAlphaRemaining: transparent ? 3 : 0,
    onLog,
    onCutFrameSent: () => {
      if (sender.framesSent % 30 === 0) {
        const dt = (performance.now() - tStart) / 1000;
        onProgress({
          framesRendered: sender.framesSent,  // cut モードでは差は warmup 分だけ
          framesSent: sender.framesSent,
          totalFrames,
          browserFps: sender.framesSent / Math.max(dt, 1e-6),
        });
      }
    },
  };
  const frameEncoder = _setupFrameEncoder(
    exportConfig, { width, height, fps }, sender, canvas, frameCtx, onLog,
  );

  // 1) 先頭プリロール (透過なら alpha=0、不透明なら黒)
  if (leadInFrames > 0) {
    onLog(`leadIn: ${leadInFrames} frames (${leadInSec.toFixed(2)}s, transparent=${transparent})`);
    await renderLeadInFrames({
      count: leadInFrames, transparent,
      width, height, vflipMode,
      renderer, readback, sender, ctx: frameCtx, onLog, shouldAbort,
    });
  }
  // 2) cut の duration を override する (= UI で短縮テスト可能)
  const cutForLoop = cutFrames === Number(cut.durationFrame)
    ? cut
    : { ...cut, durationFrame: cutFrames };
  await renderCutFrames({
    cut: cutForLoop,
    fps, width, height, vflipMode,
    includeVisualizer, includeVideoTrack, transparent,
    readback, sender, ctx: frameCtx, onLog, shouldAbort,
    projectId,
  });

  // 全フレーム送信完了。残るは PBO drain → ffmpeg の EOF 待ち + ファイル close。
  // ここから先は browser 側からは「ffmpeg がエンコード/書き込みを仕上げる時間」。
  onPhase("finalizing");

  let encodeStats = null;
  if (frameEncoder) {
    // WebCodecs: 残りフレームを encode しきってから finish。flush で全 output
    // コールバック (= sendBytesNow) が走り切る。
    await frameEncoder.flush();
    encodeStats = frameEncoder.getStats();
    frameEncoder.close();
  } else if (readback.flushRemaining) {
    // PBO 残り flush (session 終端)
    await readback.flushRemaining(async (bytes) => {
      let b = bytes;
      if (vflipMode === "cpu") cpuVerticalFlip(b, width, height);
      await sender.sendFrame(b);
    });
  }
  readback.dispose();

  const done = await sender.finishAndWait(60_000);
  sender.close();
  const tEnd = performance.now();
  const elapsedSec = (tEnd - tStart) / 1000;
  const producedFrames = frameEncoder ? frameCtx.globalFrameIdx : sender.framesSent;
  const browserFps = sender.framesSent / Math.max(elapsedSec, 1e-6);

  disposeActiveScene();

  onLog(
    `finished: framesSent=${sender.framesSent}/${totalFrames} `
    + `browserFps=${browserFps.toFixed(2)} stalls=${frameCtx.stallCount} `
    + `serverFps=${done?.fps?.toFixed?.(2) ?? "n/a"}`,
  );

  return {
    done,
    browserFps,
    framesSent: sender.framesSent,
    sentBytes: sender.sentBytes,
    framesRendered: producedFrames,
    elapsedSec,
    stallCount: frameCtx.stallCount,
    glRenderMs: frameCtx.glRenderMs,
    fetchBundleMs: frameCtx.fetchBundleMs,
    buildSceneMs: frameCtx.buildSceneMs,
    cutBuildCount: frameCtx.cutBuildCount,
    srvTotalMs: frameCtx.srvTotalMs,
    srvLipsyncMs: frameCtx.srvLipsyncMs,
    srvVizMs: frameCtx.srvVizMs,
    encodeStats,
    negotiatedExtensions: sender.negotiatedExtensions || "",
  };
}

// =============================================================================
// runProjectExportSession (= シナリオ全体 export)
// =============================================================================
/**
 * シナリオ内の全シーン × 全カット + gap を 1 つの mp4 に書き出す。
 * 単一 WS + 単一 ffmpeg + 単一 PBO ring。境界で flush しない。
 */
export async function runProjectExportSession({
  canvas,
  scenario,           // /api/scenario の戻り (scenes[i].cuts[j] を直接使う)
  projectId,
  exportConfig,
  onLog = () => {},
  onProgress = () => {},
  onPhase = () => {},
  onEncoderProgress = () => {},
  shouldAbort = () => false,
}) {
  const {
    width, height, fps, encoder,
    readbackMode, vflipMode, bpThresholdMB,
    includeVisualizer = false,
    includeVideoTrack = false,
    outputPath = null,
    leadInSec = 0,
  } = exportConfig;
  const transparent = resolveTransparentFlag(exportConfig);
  const leadInFrames = Math.max(0, Math.round((Number(leadInSec) || 0) * fps));

  const { renderer, gl } = setupRendererAndCanvas(canvas, width, height, readbackMode, onLog);
  await ensureManifestAndFontsLoaded(onLog, projectId);

  // plan API: シーン total / sceneBackground / cuts のメタを取得
  onLog("fetching /api/v2/export/plan ...");
  const plan = await fetchExportPlan();
  onLog(`plan: scenes=${plan.scenes.length} grandTotalFrames=${plan.grandTotalFrames}`);
  if (plan.fps !== fps) {
    onLog(`WARN: plan fps=${plan.fps} != export fps=${fps}。当面は同値前提。`, "warn");
  }
  const contentFrames = plan.grandTotalFrames;
  const totalFrames = leadInFrames + contentFrames;
  if (!contentFrames) throw new Error("plan.grandTotalFrames=0 (シーンが空)");

  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const sender = new FrameSender({
    url: `${wsProto}//${location.host}/api/v2/export/ws`,
    handshake: {
      width, height, fps, encoder,
      vflip: vflipMode === "ffmpeg",
      totalFrames, projectId, cutId: "scenario",
      mode: "project",
      ...(outputPath ? { outputPath } : {}),
      ...(exportConfig.transport ? { transport: exportConfig.transport } : {}),
      ...(exportConfig.videoPresetId ? { videoPresetId: exportConfig.videoPresetId } : {}),
      ...(exportConfig.presetOptions ? { presetOptions: exportConfig.presetOptions } : {}),
    },
    bpThresholdMB,
    onLog,
    onEncoderProgress,
  });
  await sender.open();

  // PBO ring は全 session 共通で 1 つだけ。cut/scene/gap 境界で flush しない。
  const readback = createReadback(readbackMode, gl, width, height);

  const tStart = performance.now();
  const frameCtx = {
    stallCount: 0,
    glRenderMs: 0,  // GL render (per-frame JS update + draw call 発行) の累積壁時計 ms。律速診断用。
    fetchBundleMs: 0,  // カット境界の scene-bundle fetch 累積 ms (律速診断)。
    buildSceneMs: 0,   // カット境界の buildSceneFromLayerData (PNG decode + texture upload) 累積 ms。
    cutBuildCount: 0,  // build したカット数 (per-cut 平均算出用)。
    srvTotalMs: 0, srvLipsyncMs: 0, srvVizMs: 0,  // サーバ bundle 生成コストの内訳 (_timing 集計)。
    // 透明 codec のときだけ最初の 3 frame で alpha 統計をログに出す。
    // min=0 なら readPixels に透明 pixel が乗っている (= GL 側 OK)、
    // min=255 なら GL 側で alpha=255 になっており codec ではなく上流が原因。
    diagAlphaRemaining: transparent ? 3 : 0,
    onLog,
    onCutFrameSent: () => {
      if (sender.framesSent % 30 === 0) {
        const dt = (performance.now() - tStart) / 1000;
        onProgress({
          framesRendered: sender.framesSent,
          framesSent: sender.framesSent,
          totalFrames,
          browserFps: sender.framesSent / Math.max(dt, 1e-6),
          currentScene: progressState.currentScene,
          totalScenes: plan.scenes.length,
          currentCut: progressState.currentCut,
          totalCuts: progressState.totalCuts,
        });
      }
    },
  };
  const progressState = { currentScene: 0, currentCut: 0, totalCuts: 0 };
  // 全シーンの cut 総数 (進捗 UI 表示用)
  progressState.totalCuts = plan.scenes.reduce((s, sc) => s + sc.cuts.length, 0);
  const frameEncoder = _setupFrameEncoder(
    exportConfig, { width, height, fps }, sender, canvas, frameCtx, onLog,
  );

  // 0) 先頭プリロール (透過なら alpha=0、不透明なら黒)。シーン loop 開始前に
  //    1 回だけ走る。映像側はここで leadInFrames 個の blank を出し、音声は mux 段で
  //    adelay によって同じだけ後ろへずらす (= 映像 / 音声で leadIn が一致)。
  if (leadInFrames > 0) {
    onLog(`leadIn: ${leadInFrames} frames (${leadInSec.toFixed(2)}s, transparent=${transparent})`);
    await renderLeadInFrames({
      count: leadInFrames, transparent,
      width, height, vflipMode,
      renderer, readback, sender, ctx: frameCtx, onLog, shouldAbort,
    });
  }

  // シナリオ scenes / cuts を plan の順番で参照する。scenario 入力との突合は
  // scenes[].cuts[] の id ベースで取る (フィールド配置が一致する前提)。
  const scenarioScenes = scenario.scenes || [];

  outer: for (let sIdx = 0; sIdx < plan.scenes.length; sIdx++) {
    const planScene = plan.scenes[sIdx];
    const scenarioScene = scenarioScenes[sIdx] || {};
    progressState.currentScene = sIdx + 1;
    onLog(`scene ${sIdx + 1}/${plan.scenes.length}: cuts=${planScene.cuts.length} totalFrames=${planScene.sceneTotalFrames}`);

    // ---- per-scene の videoLayer provider / duration metadata 準備 -------------
    // 透過 export や includeVideoTrack=false では videoLayer も skip する
    // (videoTrack の挙動と揃える)。
    const videoLayerProvidersById = new Map();
    const videoLayerDurations = new Map();
    const sceneVideoLayers = Array.isArray(scenarioScene.videoLayers)
      ? scenarioScene.videoLayers
      : [];
    if (!transparent && includeVideoTrack && sceneVideoLayers.length > 0) {
      const { WebCodecsVideoProvider } = await import("/static/js/renderer/video-provider.js");
      const { mapVideoLayerSec } = await import("/static/js/renderer/video-layer-time.js");
      // demux 結果共有: 同一 src を持つ複数 VL (= 分割で生まれた続きレイヤー等) で
      // fetch + mp4box demux + sample sort を 1 回で済ませる。
      const demuxCache = new Map();

      // 1) duration metadata を /api/video-duration から並列取得
      const metaPromises = sceneVideoLayers.map(async (vl) => {
        if (!vl?.src || videoLayerDurations.has(vl.src)) return;
        try {
          const res = await fetch(`/api/video-duration?path=${encodeURIComponent(vl.src)}`);
          if (res.ok) {
            const data = await res.json();
            videoLayerDurations.set(vl.src, {
              duration: Number(data.duration) || 0,
              width: Number(data.width) || 0,
              height: Number(data.height) || 0,
              hasAudio: !!data.hasAudio,
            });
          }
        } catch (err) {
          onLog(`videoLayer duration fetch failed (${vl.src}): ${err?.message || err}`, "warn");
        }
      });
      await Promise.all(metaPromises);

      // 2) per-layer WebCodecsVideoProvider を並列 init。
      //    mapFn = videoLayer 用の時間写像 (loop なし / freeze 末尾フレーム)。
      const initPromises = sceneVideoLayers.map(async (vl) => {
        if (!vl?.id || !vl?.src) return;
        const dur = Number(videoLayerDurations.get(vl.src)?.duration) || 0;
        if (dur <= 0) {
          onLog(`videoLayer ${vl.id} skipped (duration unresolved)`, "warn");
          return;
        }
        try {
          const mapFn = (sec) => mapVideoLayerSec(vl, sec, fps, dur);
          const p = new WebCodecsVideoProvider({ mapFn, demuxCache });
          await p.init(vl);
          videoLayerProvidersById.set(vl.id, p);
          onLog(`videoLayer provider init: ${vl.id} src=${vl.src}`);
        } catch (err) {
          onLog(`videoLayer provider init failed (${vl.id}): ${err?.message || err}`, "warn");
        }
      });
      await Promise.all(initPromises);
      if (videoLayerProvidersById.size > 0) {
        onLog(`videoLayer providers ready: ${videoLayerProvidersById.size}/${sceneVideoLayers.length}`);
      }
    }

    // gap 用 scene を 1 シーンにつき 1 回 build。
    // scene-level telops は scene-bundle が乗せてくるので最初の cut の bundle
    // から取り出す (同じシーンの全 cut bundle に同じ telops 配列が入っている)。
    let gapInstance = null;
    let sceneTelopsCache = null;
    const buildGapForScene = async () => {
      if (gapInstance) return gapInstance;
      // 最初の cut の bundle を fetch して scene telops を取得 (cut frame 用に
      // どうせ後で fetch するので、結果を使い回せると重複しないが、別 fetch でも
      // server cache が効く)
      if (!sceneTelopsCache) {
        const firstCut = scenarioScene.cuts?.[0];
        if (firstCut) {
          try {
            const bundle = await fetchSceneBundle(firstCut, projectId);
            sceneTelopsCache = Array.isArray(bundle.telops) ? bundle.telops : [];
          } catch (err) {
            onLog(`scene telops fetch failed: ${err?.message || err}`, "warn");
            sceneTelopsCache = [];
          }
        } else {
          sceneTelopsCache = [];
        }
      }
      gapInstance = await buildGapScene({
        // 透明 codec のときは scene background も描かない (= alpha=0 で抜く)。
        // これを null にしないと renderGapFrames 内で setClearColor alpha=1 が
        // 効いて gap 区間だけ alpha=255 で塗りつぶされ、ProRes/PNG 出力で
        // 「カット内は透過するが gap だけ黒/白」になる症状が出る。
        sceneBackground: transparent ? null : planScene.sceneBackground,
        sceneTelops: sceneTelopsCache,
        sceneVideoLayers,
        videoLayerProvidersById,
        videoLayerDurations,
        fps,
        renderer,
      });
      return gapInstance;
    };

    let sceneFrameIdx = 0;  // このシーン先頭からの frame 番号
    for (let cIdx = 0; cIdx < planScene.cuts.length; cIdx++) {
      if (shouldAbort()) {
        onLog("aborted by user (scene loop)", "warn");
        break outer;
      }
      const planCut = planScene.cuts[cIdx];
      progressState.currentCut += 1;

      // 1) gap (前カット終端 → このカット先頭) を埋める
      const gapBefore = planCut.startFrame - sceneFrameIdx;
      if (gapBefore > 0) {
        await buildGapForScene();
        await renderGapFrames({
          gapInstance,
          count: gapBefore,
          startSceneFrameIdx: sceneFrameIdx,
          fps, width, height, vflipMode,
          renderer, readback, sender, ctx: frameCtx, onLog, shouldAbort,
          videoLayerProvidersById,
        });
        sceneFrameIdx += gapBefore;
      }

      // 2) このカットを render
      const scenarioCut = (scenarioScene.cuts || [])[cIdx]
        || (scenarioScene.cuts || []).find((c) => c.id === planCut.id);
      if (!scenarioCut) {
        onLog(`cut ${planCut.id} が scenario に見つかりません, skip`, "warn");
        continue;
      }
      // plan が示す durationFrame に合わせる
      const cutForLoop = {
        ...scenarioCut,
        durationFrame: planCut.durationFrame,
      };
      await renderCutFrames({
        cut: cutForLoop,
        fps, width, height, vflipMode,
        includeVisualizer, includeVideoTrack, transparent,
        readback, sender, ctx: frameCtx, onLog, shouldAbort,
        videoLayerProvidersById,
        videoLayerDurations,
        projectId,
      });
      sceneFrameIdx += planCut.durationFrame;
    }

    // 3) post-roll (telop が cuts より後ろまで伸びている場合)
    const postRoll = planScene.sceneTotalFrames - sceneFrameIdx;
    if (postRoll > 0 && !shouldAbort()) {
      await buildGapForScene();
      await renderGapFrames({
        gapInstance,
        count: postRoll,
        startSceneFrameIdx: sceneFrameIdx,
        fps, width, height, vflipMode,
        renderer, readback, sender, ctx: frameCtx, onLog, shouldAbort,
        videoLayerProvidersById,
      });
      sceneFrameIdx += postRoll;
    }

    // シーン跨ぎでも PBO は flush しない (§3.4)。
    // gap scene は次シーンで使い回さない (sceneBackground / telops が違う) ので
    // ここで dispose。
    if (gapInstance) {
      gapInstance.dispose();
      gapInstance = null;
    }
    // per-scene の videoLayer provider を全解放 (WebCodecs decoder を閉じる)。
    // scene を跨いで素材が共通でも、scene 単位で再 init する MVP 設計。
    for (const [, p] of videoLayerProvidersById) {
      try { p.dispose(); } catch (_) { /* ignore */ }
    }
    videoLayerProvidersById.clear();
  }

  // 全シーン送信完了。ここから先は ffmpeg のエンコード仕上げ + ファイル close。
  onPhase("finalizing");

  // 全シーン送信後にだけ PBO ring を吐き切る (= warmup 分の残り)
  let encodeStats = null;
  if (frameEncoder) {
    await frameEncoder.flush();
    encodeStats = frameEncoder.getStats();
    frameEncoder.close();
  } else if (readback.flushRemaining) {
    await readback.flushRemaining(async (bytes) => {
      let b = bytes;
      if (vflipMode === "cpu") cpuVerticalFlip(b, width, height);
      await sender.sendFrame(b);
    });
  }
  readback.dispose();

  const done = await sender.finishAndWait(120_000);
  sender.close();
  const tEnd = performance.now();
  const elapsedSec = (tEnd - tStart) / 1000;
  const producedFrames = frameEncoder ? frameCtx.globalFrameIdx : sender.framesSent;
  const browserFps = sender.framesSent / Math.max(elapsedSec, 1e-6);

  disposeActiveScene();

  onLog(
    `project export finished: framesSent=${sender.framesSent}/${totalFrames} `
    + `browserFps=${browserFps.toFixed(2)} stalls=${frameCtx.stallCount} `
    + `serverFps=${done?.fps?.toFixed?.(2) ?? "n/a"}`,
  );

  return {
    done,
    browserFps,
    framesSent: sender.framesSent,
    sentBytes: sender.sentBytes,
    framesRendered: producedFrames,
    elapsedSec,
    stallCount: frameCtx.stallCount,
    glRenderMs: frameCtx.glRenderMs,
    fetchBundleMs: frameCtx.fetchBundleMs,
    buildSceneMs: frameCtx.buildSceneMs,
    cutBuildCount: frameCtx.cutBuildCount,
    srvTotalMs: frameCtx.srvTotalMs,
    srvLipsyncMs: frameCtx.srvLipsyncMs,
    srvVizMs: frameCtx.srvVizMs,
    encodeStats,
    negotiatedExtensions: sender.negotiatedExtensions || "",
    plan,
  };
}
