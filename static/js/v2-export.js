// =============================================================================
// v2-export.js
//
// /v2-export ページのエントリ。本体 UI とは状態を共有しない独立画面。
// プロジェクト/カット選択 + encoder + 解像度を受け取って、
// export/export-session.js の runExportSession を呼ぶだけ。
//
// Step 0 の最小成功条件:
//   - 1 cut / visualizer なし / videoTrack なし / 24fps
//   - h264_videotoolbox (mac) / h264_nvenc (win) で 10秒程度を ffmpeg 出力
//   - frame ロスなし、ws.extensions に permessage-deflate を含まない
// =============================================================================
import {
  runExportSession,
  runProjectExportSession,
} from "/static/js/export/export-session.js";

const el = (id) => document.getElementById(id);
const ui = {
  status: el("status"),
  projectSelect: el("projectSelect"),
  cutSelect: el("cutSelect"),
  totalFrames: el("totalFramesInput"),
  encoder: el("encoderSelect"),
  resolution: el("resolutionSelect"),
  fps: el("fpsSelect"),
  leadIn: el("leadInInput"),
  visualizer: el("visualizerToggle"),
  videoTrack: el("videoTrackToggle"),
  audioMux: el("audioMuxToggle"),
  monoToStereo: el("monoToStereoToggle"),
  outputPath: el("outputPathInput"),
  // target ラジオ (このカット / シナリオ全体)
  targetRadios: () => document.querySelectorAll('input[name="exportTarget"]'),
  readback: el("readbackSelect"),
  vflip: el("vflipSelect"),
  bpThreshold: el("bpThresholdInput"),
  startBtn: el("startBtn"),
  stopBtn: el("stopBtn"),
  progress: el("progress"),
  canvas: el("renderCanvas"),
  statsOut: el("statsOut"),
  logOut: el("logOut"),
};

function logLine(text, kind = "info") {
  const div = document.createElement("div");
  div.className = "line" + (kind === "err" ? " err" : kind === "warn" ? " warn" : "");
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${text}`;
  ui.logOut.appendChild(div);
  ui.logOut.scrollTop = ui.logOut.scrollHeight;
}

function setStatus(label, klass = "") {
  ui.status.textContent = label;
  ui.status.className = "pill" + (klass ? " " + klass : "");
}

// ----- capability 検出 -------------------------------------------------
// 起動時 1 回 /api/v2/export/capabilities を fetch して、実機で使える encoder
// だけを select に並べ、preferred を selected にする。失敗時は HTML 既定の
// 全候補を残す (= ユーザが手動選択)。
let capabilities = null;

async function loadCapabilities() {
  try {
    const res = await fetch("/api/v2/export/capabilities");
    if (!res.ok) throw new Error(`capabilities ${res.status}`);
    capabilities = await res.json();
  } catch (err) {
    logLine(`capabilities fetch failed: ${err?.message || err} (HTML 既定値で続行)`, "warn");
    return;
  }
  const ENCODER_LABEL = {
    h264_videotoolbox: "h264_videotoolbox (Apple HW)",
    h264_nvenc: "h264_nvenc (NVIDIA HW)",
    libx264_fast: "libx264 veryfast (CPU fallback)",
    prores_4444: "ProRes 4444 (透過 .mov, 素材用)",
    png_video: "QuickTime PNG (透過 .mov, 素材用 / 可逆)",
  };
  const list = Array.isArray(capabilities.encoders) ? capabilities.encoders : [];
  const preferred = capabilities.preferred;
  ui.encoder.innerHTML = "";
  for (const id of list) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = ENCODER_LABEL[id] || id;
    if (id === preferred) opt.selected = true;
    ui.encoder.appendChild(opt);
  }
  // null は計測用なので常に末尾に残す。
  const optNull = document.createElement("option");
  optNull.value = "null";
  optNull.textContent = "-f null - (パイプ消費だけ。ファイル無し)";
  ui.encoder.appendChild(optNull);
  logLine(`capabilities: platform=${capabilities.platform} encoders=[${list.join(", ")}] preferred=${preferred || "(none)"}`);
}

// ----- プロジェクト/カット ---------------------------------------------
let scenarioCache = null;

async function loadProjects() {
  const res = await fetch("/api/projects");
  const data = await res.json();
  const projects = data.projects || [];
  ui.projectSelect.innerHTML = "";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.title} (${p.id})`;
    if (p.active) opt.selected = true;
    ui.projectSelect.appendChild(opt);
  }
  await onProjectChange();
}

async function activateProject(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/activate`, { method: "POST" });
  if (!res.ok) throw new Error(`activate failed: ${res.status}`);
}

async function fetchScenario(projectId = "") {
  const url = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/scenario`
    : "/api/scenario";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`scenario ${res.status}`);
  return await res.json();
}

async function onProjectChange() {
  const projectId = ui.projectSelect.value;
  if (!projectId) return;
  await activateProject(projectId);
  // プロジェクトが変われば manifest / 登録済 fonts は別物なので、
  // export-session 側のキャッシュを明示的に invalidate する。
  // (export-session 側にも projectId 比較で同じ invalidate がある二重防御。)
  try {
    const stateMod = await import("/static/js/state.js");
    stateMod.state.manifest = null;
    stateMod.state.__exportFontsRegistered = false;
    stateMod.state.__exportProjectId = projectId;
  } catch (_) {}
  scenarioCache = await fetchScenario(projectId);
  const cuts = (scenarioCache?.scenes?.[0]?.cuts) || scenarioCache?.cuts || [];
  ui.cutSelect.innerHTML = "";
  cuts.forEach((cut, i) => {
    const opt = document.createElement("option");
    opt.value = cut.id;
    const dur = cut.durationFrame || 0;
    opt.textContent = `cut ${i + 1}: ${cut.id} (${dur}f / ${(dur / 24).toFixed(1)}s)`;
    ui.cutSelect.appendChild(opt);
  });
  const cut0 = cuts[0];
  if (cut0?.durationFrame) ui.totalFrames.value = String(cut0.durationFrame);
  applyTargetMode();
}

// target = "cut" / "project" の状態を UI に反映:
//   project のときは cut select / フレーム数入力を disable し、
//   /api/v2/export/plan の grandTotalFrames でフレーム数欄を表示更新する。
async function applyTargetMode() {
  const target = currentTarget();
  if (target === "project") {
    ui.cutSelect.disabled = true;
    ui.totalFrames.disabled = true;
    try {
      const res = await fetch("/api/v2/export/plan");
      if (res.ok) {
        const plan = await res.json();
        ui.totalFrames.value = String(plan.grandTotalFrames || 0);
      }
    } catch (_) {}
  } else {
    ui.cutSelect.disabled = false;
    ui.totalFrames.disabled = false;
    const cuts = (scenarioCache?.scenes?.[0]?.cuts) || [];
    const sel = cuts.find((c) => c.id === ui.cutSelect.value) || cuts[0];
    if (sel?.durationFrame) ui.totalFrames.value = String(sel.durationFrame);
  }
}

function currentTarget() {
  for (const r of ui.targetRadios()) if (r.checked) return r.value;
  return "cut";
}

ui.projectSelect.addEventListener("change", onProjectChange);
ui.cutSelect.addEventListener("change", () => {
  if (currentTarget() === "project") return;
  const cuts = (scenarioCache?.scenes?.[0]?.cuts) || [];
  const sel = cuts.find((c) => c.id === ui.cutSelect.value);
  if (sel?.durationFrame) ui.totalFrames.value = String(sel.durationFrame);
});
for (const r of document.querySelectorAll('input[name="exportTarget"]')) {
  r.addEventListener("change", applyTargetMode);
}

// ----- 開始/停止 -------------------------------------------------------
let running = false;
let abortRequested = false;

ui.startBtn.addEventListener("click", () => {
  runExport().catch((e) => {
    logLine(`error: ${e.message || e}`, "err");
    setStatus("error", "err");
  }).finally(() => {
    running = false;
    abortRequested = false;
    ui.startBtn.disabled = false;
    ui.stopBtn.disabled = true;
  });
});
ui.stopBtn.addEventListener("click", () => {
  abortRequested = true;
  logLine("stop 要求受付。次の frame で抜けます。", "warn");
});

async function runExport() {
  if (running) return;
  running = true;
  abortRequested = false;
  ui.startBtn.disabled = true;
  ui.stopBtn.disabled = false;
  ui.statsOut.textContent = "（書き出し中...）";
  setStatus("running", "run");

  const projectId = ui.projectSelect.value;
  const target = currentTarget();
  const [W, H] = ui.resolution.value.split("x").map((s) => parseInt(s, 10));
  const fps = parseInt(ui.fps.value, 10) || 24;
  const encoder = ui.encoder.value;
  const includeVisualizer = !!ui.visualizer.checked;
  const includeVideoTrack = !!ui.videoTrack?.checked;
  const leadInSec = Math.max(0, Math.min(10, parseFloat(ui.leadIn?.value || "0") || 0));
  const outputPath = (ui.outputPath?.value || "").trim() || null;
  const readbackMode = ui.readback.value;
  const vflipMode = ui.vflip.value;
  const bpThresholdMB = Math.max(0, parseFloat(ui.bpThreshold.value) || 0);

  const baseExportConfig = {
    width: W, height: H, fps, encoder,
    readbackMode, vflipMode, bpThresholdMB,
    includeVisualizer,
    includeVideoTrack,
    outputPath,
    leadInSec,
  };
  const onLog = (line, kind) => logLine(line, kind);
  const onProgress = ({ framesSent, totalFrames: total, browserFps, currentScene, totalScenes, currentCut, totalCuts }) => {
    let label = `${framesSent}/${total} frames, ${browserFps.toFixed(1)} fps`;
    if (currentScene) label += ` (scene ${currentScene}/${totalScenes}, cut ${currentCut}/${totalCuts})`;
    ui.progress.textContent = label;
  };

  let result;
  if (target === "project") {
    logLine(
      `start (project): project=${projectId} ${W}x${H}@${fps} `
      + `encoder=${encoder} readback=${readbackMode} bp=${bpThresholdMB}MB`,
    );
    result = await runProjectExportSession({
      canvas: ui.canvas,
      scenario: scenarioCache,
      projectId,
      exportConfig: baseExportConfig,
      onLog,
      onProgress,
      shouldAbort: () => abortRequested,
    });
  } else {
    const cutId = ui.cutSelect.value;
    const cuts = (scenarioCache?.scenes?.[0]?.cuts) || [];
    const cut = cuts.find((c) => c.id === cutId);
    if (!cut) throw new Error("cut not found");
    const totalFrames = Math.max(1, parseInt(ui.totalFrames.value, 10) || cut.durationFrame || 240);
    logLine(
      `start (cut): project=${projectId} cut=${cutId} ${W}x${H}@${fps} `
      + `frames=${totalFrames} encoder=${encoder} readback=${readbackMode} bp=${bpThresholdMB}MB`,
    );
    result = await runExportSession({
      canvas: ui.canvas,
      cut,
      projectId,
      exportConfig: { ...baseExportConfig, totalFrames },
      onLog,
      onProgress,
      shouldAbort: () => abortRequested,
    });
  }

  // 集計
  const totalFramesForStats = (result.plan?.grandTotalFrames) ?? result.framesSent;
  const targetLabel = target === "project"
    ? `target=project (scenes=${result.plan?.scenes?.length ?? "?"})`
    : `target=cut cut=${ui.cutSelect.value}`;
  const lines = [];
  lines.push(`## 設定`);
  lines.push(`project=${projectId} ${targetLabel} ${W}x${H}@${fps}`);
  lines.push(`encoder=${encoder} readback=${readbackMode} vflip=${vflipMode} bp=${bpThresholdMB}MB`);
  lines.push(``);
  lines.push(`## ブラウザ側`);
  lines.push(`framesSent = ${result.framesSent}/${totalFramesForStats}`);
  lines.push(`elapsed = ${result.elapsedSec.toFixed(2)} s`);
  lines.push(`browser fps = ${result.browserFps.toFixed(2)}`);
  lines.push(`stalls (PBO had to wait) = ${result.stallCount}`);
  lines.push(`sent bytes = ${(result.sentBytes / 1e6).toFixed(1)} MB`);
  lines.push(``);
  lines.push(`## サーバ側`);
  const done = result.done || {};
  if (done.fps !== undefined) {
    lines.push(`server fps = ${done.fps.toFixed(2)}`);
    if (done.throughputMBps) lines.push(`server throughput = ${done.throughputMBps.toFixed(1)} MB/s`);
    lines.push(`ffmpeg rc = ${done.ffmpegRc}`);
    if (done.outputPath) lines.push(`output = ${done.outputPath}`);
    // 「実際に圧縮されたか」は negotiated 側を見る (browser ws.extensions)。
    // offered (request header) は単にブラウザが提示しただけなので、
    // 通常 permessage-deflate を含むのが普通で、これだけでは赤信号ではない。
    lines.push(`ws.extensions negotiated = ${result.negotiatedExtensions || "(none)"}`);
    if (done.wsExtensionsOffered) lines.push(`ws.extensions offered (request header) = ${done.wsExtensionsOffered}`);
    if (done.stdinWriteMs) {
      const w = done.stdinWriteMs;
      lines.push(`stdin write ms: mean=${w.mean.toFixed(2)} p50=${w.p50.toFixed(2)} p95=${w.p95.toFixed(2)} max=${w.max.toFixed(2)}`);
    }
    if (done.drainMs) {
      const d = done.drainMs;
      lines.push(`stdin drain ms (ffmpeg backpressure): mean=${d.mean.toFixed(2)} p50=${d.p50.toFixed(2)} p95=${d.p95.toFixed(2)} max=${d.max.toFixed(2)}`);
    }
    if (done.ffmpegStderrTail) {
      lines.push(`-- ffmpeg stderr tail --`);
      lines.push(done.ffmpegStderrTail);
    }
  } else {
    lines.push(`(server done not received)`);
  }

  // 音声 mux: 映像書き出しが成功 (rc=0) かつ UI で ON なら自動 mux。
  // -c:v copy なので映像ストリームは bit-exact (preview md5 不変)。
  let muxResult = null;
  const wantMux = !!ui.audioMux?.checked;
  if (wantMux && done.ffmpegRc === 0 && done.outputPath) {
    setStatus("muxing", "run");
    logLine("音声を mux しています...");
    try {
      const muxBody = {
        videoPath: done.outputPath,
        scope: target === "project" ? "project" : "cut",
        monoToStereo: !!ui.monoToStereo?.checked,
        leadInSec,
        // outputPath 未指定: サーバが映像を atomic rename で上書き。
      };
      if (target === "cut") muxBody.cutId = ui.cutSelect.value;
      const res = await fetch("/api/v2/export/mux", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(muxBody),
      });
      muxResult = await res.json();
      if (muxResult.type === "error") {
        logLine(`mux error [${muxResult.code}]: ${muxResult.detail}`, "err");
      } else {
        logLine(`mux done: rc=${muxResult.ffmpegRc} audio=${muxResult.audioRendered} elapsed=${muxResult.elapsedSec?.toFixed?.(2)}s output=${muxResult.outputPath}`);
      }
    } catch (err) {
      logLine(`mux fetch failed: ${err?.message || err}`, "err");
    }
  }

  if (muxResult && muxResult.type !== "error") {
    lines.push(``);
    lines.push(`## 音声 mux`);
    lines.push(`mux elapsed = ${muxResult.elapsedSec?.toFixed?.(2) ?? "n/a"} s`);
    lines.push(`audioRendered = ${muxResult.audioRendered} (false なら anullsrc 無音)`);
    lines.push(`ffmpeg rc = ${muxResult.ffmpegRc}`);
    lines.push(`output (mux 後) = ${muxResult.outputPath}`);
    if (muxResult.ffmpegStderrTail) {
      lines.push(`-- mux ffmpeg stderr tail --`);
      lines.push(muxResult.ffmpegStderrTail);
    }
  } else if (muxResult && muxResult.type === "error") {
    lines.push(``);
    lines.push(`## 音声 mux (失敗)`);
    lines.push(`code = ${muxResult.code}`);
    lines.push(`detail = ${muxResult.detail}`);
    if (muxResult.ffmpegStderrTail) {
      lines.push(`-- mux ffmpeg stderr tail --`);
      lines.push(muxResult.ffmpegStderrTail);
    }
  } else if (!wantMux) {
    lines.push(``);
    lines.push(`## 音声 mux (スキップ)`);
    lines.push(`UI の「音声を含める」OFF`);
  }

  ui.statsOut.textContent = lines.join("\n");
  setStatus("done", "done");
  const finalOutput = (muxResult && muxResult.type !== "error" ? muxResult.outputPath : null) || done.outputPath;
  logLine(`書き出し完了: server fps=${done.fps?.toFixed?.(2) ?? "n/a"} output=${finalOutput || "(none)"}`);
}

// ----- 起動 ------------------------------------------------------------
(async () => {
  await loadCapabilities();
  await loadProjects().catch((e) => {
    logLine(`failed to load projects: ${e.message || e}`, "err");
  });
})();
