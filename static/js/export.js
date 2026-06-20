// 動画 / テキスト書き出しの orchestration。
// 本線 UI の「動画書き出し」ボタンは、設定+プレビュー+進捗+ログを統合した
// `#exportOptionsDialog` を開き、v2 GL export pipeline (export/export-session.js,
// WebSocket `/api/v2/export/ws` + ffmpeg) で書き出す。
// 旧 v1 (Pillow + ProcessPool) 書き出し経路はサーバ側からも撤去済み。

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, withBusy } from "./toast.js";
import {
  fillExportOptionsDialog,
  applyExportOptionsPresetUI,
  readExportFormValues,
  setExportProgress,
  clearExportProgress,
  appendExportLog,
  clearExportLog,
  setExportDialogRunning,
  updateEncoderEngineHintFromPreset,
  findPreset,
} from "./export-ui.js";
import { fetchGlobalConfig } from "./global-settings.js";
import { updateSelectedCutFromCurrent, saveScenario } from "./scenario-actions.js";
import { isWebcodecsH264Supported } from "./export/webcodecs-encoder.js";

// WebCodecs 高速経路を使う transport を決める。H.264 mp4 preset かつ「高速書き出し」
// ON かつブラウザが H.264 エンコード対応のときだけ "webcodecs-h264"。それ以外
// (透過/ProRes/PNG, H.265, 非対応ブラウザ, トグル OFF) は従来の "rawrgba"。
// フォールバック理由は onLog に出して切り分けやすくする。
async function _decideTransport(formValues, width, height, onLog) {
  if (formValues.fastWebcodecs === false) {
    onLog("高速書き出し OFF: 従来方式 (生 RGBA) で書き出します");
    return "rawrgba";
  }
  const preset = formValues.preset || {};
  const isH264Mp4 =
    String(preset.videoCodec || "") === "libx264"
    && !preset.alpha
    && String(preset.extension || ".mp4").toLowerCase() === ".mp4";
  if (!isH264Mp4) {
    onLog("このプリセットは高速書き出し非対応 (H.264 mp4 以外): 従来方式で書き出します");
    return "rawrgba";
  }
  const supported = await isWebcodecsH264Supported(width, height);
  if (!supported) {
    onLog("このブラウザは WebCodecs H.264 エンコード非対応: 従来方式で書き出します");
    return "rawrgba";
  }
  return "webcodecs-h264";
}

async function ensureGlobalConfigLoaded() {
  if (state.globalConfig) return state.globalConfig;
  try {
    state.globalConfig = await fetchGlobalConfig();
  } catch (error) {
    console.warn("global config 取得失敗", error);
  }
  return state.globalConfig;
}

export async function exportText() {
  // 現在編集中の状態をシナリオに反映してからサーバへ送る（自動保存待ちを回避）
  try { updateSelectedCutFromCurrent(); } catch (_e) {}
  const payload = {
    scenario: state.scenario || {},
  };
  const response = await fetch("/api/export/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text();
    showToast(`エクスポートに失敗しました: ${errText}`, "error");
    return;
  }
  const result = await response.json();
  showToast(
    `エクスポートしました: セリフ ${result.serifCount} / テロップ ${result.telopCount} → ${result.exportDir}`,
    "success",
  );
}

// ---- 書き出しダイアログのライフサイクル -----------------------------------
//
// 1 つの session 状態を closure に閉じ込める (multiple click / 競合防止)。
//   running: true の間は startExport を再入させない。
//   aborted: cancel ボタン押下フラグ。runExportSession の shouldAbort で参照。
//   prevWebglCanvas: 書き出し前の renderer bind 先 (= live preview canvas)。
//     書き出し終了後に renderer を戻すため記録しておく。

const exportSession = {
  running: false,
  aborted: false,
};

function selectedCutFromScenario(scenario, cutId) {
  if (!scenario || !cutId) return null;
  const scenes = Array.isArray(scenario.scenes) ? scenario.scenes : [];
  for (const scene of scenes) {
    if (!scene) continue;
    const cuts = Array.isArray(scene.cuts) ? scene.cuts : [];
    for (const cut of cuts) {
      if (cut && String(cut.id) === String(cutId)) return cut;
    }
  }
  return null;
}

async function restoreRendererToPreview() {
  // 書き出しが終わったら renderer を main app の live preview canvas に戻し、
  // 編集中カットを再描画してダイアログを閉じても以前の絵が見えるようにする。
  try {
    const playback = await import("./playback.js");
    if (typeof playback.renderPreview === "function") {
      await playback.renderPreview();
    } else if (typeof playback.renderPreviewV2 === "function") {
      await playback.renderPreviewV2();
    }
  } catch (err) {
    console.warn("preview render restore failed", err);
  }
}

async function runV2Export(formValues) {
  // 動的 import: export-session は three.js に依存しているのでメイン UI 起動時に
  // 同期 import するとコールドスタートが重い。書き出し開始時に初回ロード。
  const sessionMod = await import("/static/js/export/export-session.js");
  const { runExportSession, runProjectExportSession } = sessionMod;

  const canvas = elements.exportPreviewCanvas;
  if (!canvas) throw new Error("exportPreviewCanvas not found");

  const projectId = state.activeProjectId || "";
  const fps = formValues.fps;
  const includeVisualizer = true;
  // v1 互換: alpha プリセット (QT PNG / ProRes 4444) でも bg / videoTrack はそのまま描く。
  // 「背景を抜いた素材」が欲しいときはカット側で背景を外す運用 (= layerData.background が
  // null になり、GL 出力の透過領域は alpha=0 で yuva444p10le / rgba にそのまま流れる)。
  const includeVideoTrack = true;
  const handshakeExtra = {
    videoPresetId: formValues.presetId,
    presetOptions: formValues.presetOptions,
  };
  const onLog = (line, kind = "info") => appendExportLog(line, kind);
  // フレーム転送方式の決定 (出力は常に 1920x1080)。
  const transport = await _decideTransport(formValues, 1920, 1080, onLog);
  const t0 = performance.now();
  // phase が "finalizing" 以降になったら、onProgress (frame counter 更新) で
  // ラベルを上書きしないようにする。GL 側のフレーム送信は既に完了しているので
  // 「ffmpeg でエンコーディング中...」を維持して、ユーザーに「動いている」と
  // 伝える。phase は単調に rendering → finalizing → muxing → done と進む。
  let exportPhase = "rendering";
  const onProgress = (p) => {
    if (exportPhase !== "rendering") return;
    const fpsBrowser = Number(p.browserFps) || 0;
    const total = Number(p.totalFrames) || 0;
    const sent = Number(p.framesSent) || 0;
    const ratio = total > 0 ? sent / total : 0;
    let label = `${sent}/${total} frames`;
    if (fpsBrowser > 0) label += `, ${fpsBrowser.toFixed(1)} fps`;
    if (p.currentScene) label += ` (scene ${p.currentScene}/${p.totalScenes})`;
    setExportProgress({ label, ratio });
  };
  const onPhase = (name) => {
    exportPhase = name;
    if (name === "finalizing") {
      setExportProgress({ label: "ffmpeg でエンコーディング中...", ratio: 1 });
      appendExportLog("全フレーム送信完了。ffmpeg のエンコード/書き込みを待機中...");
    }
  };
  // ffmpeg `-progress pipe:1` の 1 秒ごとブロックがサーバ経由で届く。
  // rendering 段では browser 側 frame counter を見せた方が「何 fps で生成しているか」
  // の体感に直結するので gate して非表示。finalizing 段に入ったら ffmpeg の
  // frame / outTime / speed を見せて、止まっていないことを示す。
  const onEncoderProgress = (p) => {
    if (exportPhase !== "finalizing") return;
    const fps = Number(p.fps) || 0;
    const speed = (p.speed || "").trim();
    const rawTime = (p.outTime || "").trim();
    // ffmpeg の HH:MM:SS.uuuuuu を秒以下 1 桁に丸める (見た目)。
    const time = rawTime ? rawTime.replace(/(\.\d{2})\d+$/, "$1") : "";
    const parts = ["ffmpeg エンコード中"];
    if (time) parts.push(time);
    if (fps > 0) parts.push(`${fps.toFixed(1)} fps`);
    if (speed) parts.push(speed);
    setExportProgress({ label: parts.join(" · "), ratio: 1 });
  };
  const shouldAbort = () => exportSession.aborted;

  // 書き出し canvas の表示サイズはCSS、drawing buffer は 1920x1080 (HTML 属性)。
  // initRenderer が cooperate して setSize する。
  const baseExportConfig = {
    width: 1920,
    height: 1080,
    fps,
    // encoder は preset 経路でサーバ側に無視されるが、Pydantic Literal を通すため
    // デフォルト値を一応載せる (handshake validation を通す)。
    encoder: "h264_videotoolbox",
    // フレーム転送方式 ("rawrgba" or "webcodecs-h264")。webcodecs はサーバで
    // ffmpeg copy になり preset codec は無視される。
    transport,
    // 本線 UI では bg / videoTrack は常に描く (v1 互換)。alpha プリセットで GL 透過
    // を抜きたい場合はカット側の背景を外す。export-session 内の transparent フラグは
    // false 固定 (= layerData.background を消さない、hasVideoTrack を残す)。
    transparent: false,
    // 透過 codec で readback を高速化する PBO (WebGL2)。fallback は sync。
    // /v2-export 開発ページの既定 (= 完走実績ある組合せ) に合わせる。pbo3 は GPU 側
    // バッファ depth が深く writeback が後ろにずれる分、bpThresholdMB=0 と組むと
    // WS bufferedAmount が前進せず Chromium の送信キューに RGBA 8.29MB/frame が
    // 詰まり続け、長尺 (例: dj2 約 5500 frame) で 2000 frame 過ぎにタブが落ちる。
    readbackMode: "pbo2",
    vflipMode: "ffmpeg",
    // 全体設定から取得 (= 16/32/64 で速度を試せる)。default 16 は完走実績ある安全側。
    bpThresholdMB: (() => {
      const v = Number(state.globalConfig?.config?.videoExport?.bpThresholdMB);
      return Number.isFinite(v) && v >= 1 ? Math.min(1024, v) : 16;
    })(),
    includeVisualizer,
    includeVideoTrack,
    leadInSec: 0,
    ...handshakeExtra,
  };

  appendExportLog(
    `start: preset=${formValues.presetId} target=${formValues.target} fps=${fps} `
    + `alphaPreset=${formValues.transparent} (bg/videoTrack は常に描く)`,
  );

  let result;
  if (formValues.target === "project") {
    result = await runProjectExportSession({
      canvas,
      scenario: state.scenario || {},
      projectId,
      exportConfig: baseExportConfig,
      onLog,
      onProgress,
      onPhase,
      onEncoderProgress,
      shouldAbort,
    });
  } else {
    const cut = selectedCutFromScenario(state.scenario, formValues.selectedCutId);
    if (!cut) throw new Error("選択中のカットが見つかりません");
    const totalFrames = Math.max(1, Number(cut.durationFrame) || 0);
    result = await runExportSession({
      canvas,
      cut,
      projectId,
      exportConfig: { ...baseExportConfig, totalFrames },
      onLog,
      onProgress,
      onPhase,
      onEncoderProgress,
      shouldAbort,
    });
  }

  const done = result.done || {};
  if (exportSession.aborted) {
    appendExportLog("中止しました", "warn");
    return { aborted: true };
  }
  if (done.ffmpegRc !== 0) {
    appendExportLog(
      `ffmpeg failed (rc=${done.ffmpegRc}): ${done.ffmpegStderrTail || ""}`,
      "err",
    );
    throw new Error(`ffmpeg 終了コード ${done.ffmpegRc}`);
  }

  // 音声 mux (映像のみの mp4/mov に音声トラックを乗せる)。
  // 「音声を含める」が OFF のときはこの工程を完全に skip し、ffmpeg encoder が
  // 書き出した video-only ファイル (done.outputPath) をそのまま最終出力にする。
  // 透過素材をカット単位で書き出して動画編集ソフトに取り込む用途を想定。
  let muxResult = null;
  if (formValues.includeAudio === false) {
    appendExportLog("音声を含めない設定のため mux を skip");
  } else {
    const muxBody = {
      videoPath: done.outputPath,
      scope: formValues.target === "project" ? "project" : "cut",
      monoToStereo: !!formValues.monoToStereo,
      leadInSec: 0,
    };
    if (formValues.target === "cut") muxBody.cutId = formValues.selectedCutId;
    exportPhase = "muxing";
    setExportProgress({ label: "音声を mux 中...", ratio: 1 });
    appendExportLog("音声を mux 中...");
    const muxRes = await fetch("/api/v2/export/mux", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(muxBody),
    });
    muxResult = await muxRes.json();
    if (muxResult.type === "error") {
      appendExportLog(`mux error [${muxResult.code}]: ${muxResult.detail}`, "err");
      throw new Error(`mux failed: ${muxResult.detail}`);
    }
    appendExportLog(
      `mux done: rc=${muxResult.ffmpegRc} audio=${muxResult.audioRendered} `
      + `output=${muxResult.outputPath}`,
    );
  }

  // /v2-export 開発ページと同じ形式のサマリブロックを末尾に出す。
  // フォーマットは static/js/v2-export.js:295-389 と一致。
  emitExportSummary({
    formValues,
    baseExportConfig,
    result,
    done,
    muxResult,
  });

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  return {
    aborted: false,
    outputPath: (muxResult?.outputPath) || done.outputPath,
    elapsedSec: elapsed,
    framesSent: result.framesSent,
    totalFrames: result.framesSent,
  };
}

// /v2-export と同じ書式のサマリブロックを export ログに出力する。
// 計測値は result (export-session の戻り) と done (server から受け取った最終 message)、
// muxResult (mux endpoint の戻り) から組み立てる。区切りは空行 1 行。
function emitExportSummary({ formValues, baseExportConfig, result, done, muxResult }) {
  const W = baseExportConfig.width;
  const H = baseExportConfig.height;
  const fps = baseExportConfig.fps;
  // baseExportConfig.encoder は preset 経路ではサーバに無視されるダミー値
  // ("h264_videotoolbox" 固定) なので、サマリにそのまま出すと NVENC を選んでいても
  // videotoolbox と誤表示される。実際に使う preset id と選択エンジンを出す。
  const presetId = formValues.presetId || baseExportConfig.videoPresetId || "";
  const presetEngine = formValues.presetOptions?.videoEncoder || "";
  const encoderLabel = presetId
    ? `preset=${presetId}${presetEngine ? ` engine=${presetEngine}` : ""}`
    : `encoder=${baseExportConfig.encoder}`;
  const readbackMode = baseExportConfig.readbackMode;
  const vflipMode = baseExportConfig.vflipMode;
  const bpThresholdMB = baseExportConfig.bpThresholdMB;
  const projectId = state.activeProjectId || "";
  const targetLabel = formValues.target === "project"
    ? `target=project (scenes=${result.plan?.scenes?.length ?? "?"})`
    : `target=cut cut=${formValues.selectedCutId}`;
  const totalFramesForStats = (result.plan?.grandTotalFrames) ?? result.framesSent;

  const transport = baseExportConfig.transport || "rawrgba";
  const lines = [];
  lines.push(`## 設定`);
  lines.push(`project=${projectId} ${targetLabel} ${W}x${H}@${fps}`);
  if (transport === "webcodecs-h264") {
    // WebCodecs 経路はブラウザで H.264 圧縮 → サーバ ffmpeg copy。preset codec /
    // readback / vflip は使わないので転送方式を明示する。
    lines.push(`transport=webcodecs-h264 (browser H.264 → ffmpeg copy) bp=${bpThresholdMB}MB`);
  } else {
    lines.push(`${encoderLabel} readback=${readbackMode} vflip=${vflipMode} bp=${bpThresholdMB}MB`);
  }
  lines.push(``);
  lines.push(`## ブラウザ側`);
  lines.push(`framesSent = ${result.framesSent}/${totalFramesForStats}`);
  lines.push(`elapsed = ${result.elapsedSec.toFixed(2)} s`);
  lines.push(`browser fps = ${result.browserFps.toFixed(2)}`);
  lines.push(`stalls (PBO had to wait) = ${result.stallCount}`);
  lines.push(`sent bytes = ${(result.sentBytes / 1e6).toFixed(1)} MB`);
  // WebCodecs 律速診断: produce(render+decode) fps と encode backpressure 待ち。
  // encode wait が elapsed に近い → エンコーダ律速 (Win ブラウザ実装が遅い)。
  // ≈0 なのに fps が低い → render / videoLayer decode が律速。
  if (result.encodeStats) {
    const es = result.encodeStats;
    const elapsed = result.elapsedSec || 0;
    const renderFps = elapsed > 0 ? (result.framesRendered / elapsed) : 0;
    const waitSec = (es.encodeWaitTotalMs || 0) / 1000;
    const waitPct = elapsed > 0 ? (waitSec / elapsed * 100) : 0;
    lines.push(`render(produce) fps = ${renderFps.toFixed(2)} (produced ${result.framesRendered} frames)`);
    lines.push(
      `encode backpressure wait = ${waitSec.toFixed(1)}s / ${elapsed.toFixed(1)}s `
      + `(${waitPct.toFixed(0)}%) maxQueue=${es.maxQueue} bitrate=${(es.bitrate / 1e6).toFixed(1)}Mbps`,
    );
    lines.push(`  ↑ wait% が高い=エンコーダ律速 / 低いのに遅い=render or videoLayer decode 律速`);
  }
  // GL render (per-frame の scene.update JS = telop refresh / per-char texture / motion
  // 計算 + draw call 発行) の累積時間。これが elapsed の大半なら「キャラアニメ等の
  // per-frame JS が律速」、小さいのに fps が低いなら GPU draw / readback / encode が律速。
  if (typeof result.glRenderMs === "number" && result.glRenderMs > 0 && result.elapsedSec > 0) {
    const glSec = result.glRenderMs / 1000;
    const glPct = glSec / result.elapsedSec * 100;
    const glPerFrameMs = result.framesRendered > 0 ? (result.glRenderMs / result.framesRendered) : 0;
    lines.push(
      `render(GL JS) = ${glSec.toFixed(1)}s / ${result.elapsedSec.toFixed(1)}s `
      + `(${glPct.toFixed(0)}%) = ${glPerFrameMs.toFixed(2)}ms/frame`,
    );
    lines.push(`  ↑ % が高い=per-frame JS(scene.update: telop/キャラ/motion) 律速 / 低いのに遅い=GPU描画 or readback or encode 律速`);
  }
  // カット境界コスト: scene-bundle fetch (HTTP + サーバ bundle 焼き) + buildScene
  // (キャラ PNG decode + GPU texture upload + scene 構築)。これが大半なら「カット切替の
  // 立ち上げ」が律速 = cut 数 × build コスト (per-frame render ではない)。export は preview と
  // 違い次カットの先行 build が無く各カット境界で直列ブロックするため、cut 数が多いと効く。
  if (typeof result.buildSceneMs === "number" && result.elapsedSec > 0
      && ((result.fetchBundleMs || 0) + (result.buildSceneMs || 0)) > 0) {
    const fetchSec = (result.fetchBundleMs || 0) / 1000;
    const buildSec = (result.buildSceneMs || 0) / 1000;
    const cutBoundarySec = fetchSec + buildSec;
    const pct = cutBoundarySec / result.elapsedSec * 100;
    const nCuts = result.cutBuildCount || 0;
    const perCutMs = nCuts > 0 ? ((result.fetchBundleMs + result.buildSceneMs) / nCuts) : 0;
    lines.push(
      `cut境界 (fetch+build) = ${cutBoundarySec.toFixed(1)}s / ${result.elapsedSec.toFixed(1)}s `
      + `(${pct.toFixed(0)}%) — fetch=${fetchSec.toFixed(1)}s build=${buildSec.toFixed(1)}s `
      + `× ${nCuts}cuts = ${perCutMs.toFixed(0)}ms/cut`,
    );
    lines.push(`  ↑ % が高い=カット切替の立ち上げ(bundle fetch + キャラtexture upload)が律速 → 次カット先行buildで隠せる`);
    // fetch (= サーバ bundle 生成) の内訳。lipsync (ffmpeg astats, export 専用) / viz /
    // その他 (bake + dialogue layout + scenario 読み) に分解して 849ms/cut の正体を特定する。
    if (typeof result.srvTotalMs === "number" && result.srvTotalMs > 0) {
      const srvLip = (result.srvLipsyncMs || 0) / 1000;
      const srvViz = (result.srvVizMs || 0) / 1000;
      const srvTotal = result.srvTotalMs / 1000;
      const srvOther = Math.max(0, srvTotal - srvLip - srvViz);
      const lipPerCut = nCuts > 0 ? (result.srvLipsyncMs / nCuts) : 0;
      lines.push(
        `  └ サーバ内訳: lipsync(ffmpeg)=${srvLip.toFixed(1)}s viz=${srvViz.toFixed(1)}s `
        + `その他(bake/layout)=${srvOther.toFixed(1)}s — サーバ合計=${srvTotal.toFixed(1)}s `
        + `(lipsync ${lipPerCut.toFixed(0)}ms/cut)`,
      );
      // その他(bake/layout/scenario) の分解。bake=キャラPNG焼き/読み, scenario=シナリオ
      // 再読込(カット毎), layout=セリフ組版。残り=char払い出し/fg/bg 等のオーバーヘッド。
      if (typeof result.srvBakeMs === "number") {
        const bake = (result.srvBakeMs || 0) / 1000;
        const scn = (result.srvScenarioMs || 0) / 1000;
        const lay = (result.srvLayoutMs || 0) / 1000;
        const rest = Math.max(0, srvOther - bake - scn - lay);
        lines.push(
          `     └ その他分解: bake=${bake.toFixed(1)}s scenario=${scn.toFixed(1)}s `
          + `layout=${lay.toFixed(1)}s 残り(char/fg/bg)=${rest.toFixed(1)}s`,
        );
      }
    }
  }
  lines.push(``);
  lines.push(`## サーバ側`);
  if (done && done.fps !== undefined) {
    lines.push(`server fps = ${done.fps.toFixed(2)}`);
    if (done.throughputMBps) lines.push(`server throughput = ${done.throughputMBps.toFixed(1)} MB/s`);
    lines.push(`ffmpeg rc = ${done.ffmpegRc}`);
    if (done.outputPath) lines.push(`output = ${done.outputPath}`);
    // negotiated は実際に圧縮が成立した拡張、offered は単にブラウザが提示した request header。
    // 圧縮判定は negotiated 側を見る (offered は permessage-deflate を含むのが普通)。
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
  } else {
    lines.push(`(server done not received)`);
  }

  if (muxResult && muxResult.type !== "error") {
    lines.push(``);
    lines.push(`## 音声 mux`);
    lines.push(`mux elapsed = ${muxResult.elapsedSec?.toFixed?.(2) ?? "n/a"} s`);
    lines.push(`audioRendered = ${muxResult.audioRendered} (false なら anullsrc 無音)`);
    lines.push(`ffmpeg rc = ${muxResult.ffmpegRc}`);
    lines.push(`output (mux 後) = ${muxResult.outputPath}`);
  } else if (muxResult && muxResult.type === "error") {
    lines.push(``);
    lines.push(`## 音声 mux (失敗)`);
    lines.push(`code = ${muxResult.code}`);
    lines.push(`detail = ${muxResult.detail}`);
  } else if (formValues.includeAudio === false) {
    lines.push(``);
    lines.push(`## 音声 mux (skip)`);
    lines.push(`「音声を含める」OFF のため video-only ファイルをそのまま採用`);
  }

  for (const line of lines) appendExportLog(line);
}

async function startExport() {
  if (exportSession.running) return;
  const formValues = readExportFormValues();
  if (!formValues) return;

  exportSession.running = true;
  exportSession.aborted = false;
  setExportDialogRunning(true);
  clearExportLog();
  setExportProgress({ label: "準備中...", ratio: 0 });

  try {
    // 書き出し前 save も project-scoped 化 (= active project 依存を避ける)。
    await saveScenario({ silent: true, projectId: state.activeProjectId });
    const result = await runV2Export(formValues);
    if (result.aborted) {
      setExportProgress({ label: "中止しました", ratio: null });
      showToast("書き出しを中止しました", "warn");
    } else {
      setExportProgress({
        label: `完了: ${result.totalFrames} frames in ${result.elapsedSec}s`,
        ratio: 1,
      });
      showToast(`書き出し完了: ${result.outputPath}`, "success");
    }
  } catch (err) {
    console.error(err);
    appendExportLog(`error: ${err?.message || err}`, "err");
    setExportProgress({ label: "失敗しました", ratio: null });
    showToast(`書き出しに失敗しました: ${err?.message || err}`, "error");
  } finally {
    exportSession.running = false;
    exportSession.aborted = false;
    setExportDialogRunning(false);
    // renderer を live preview canvas に戻す。
    await restoreRendererToPreview();
  }
}

function handleConfirmClick(event) {
  event.preventDefault();
  if (exportSession.running) return;
  startExport().catch((err) => console.error(err));
}

function handleCancelClick(event) {
  event.preventDefault();
  if (exportSession.running) {
    exportSession.aborted = true;
    appendExportLog("中止要求受付。次のフレームで終了します。", "warn");
    return;
  }
  if (elements.exportOptionsDialog?.open) elements.exportOptionsDialog.close();
}

function handleDialogClose() {
  // 書き出し中にダイアログが閉じられた場合は abort 扱い (ESC 等)。
  if (exportSession.running) {
    exportSession.aborted = true;
  }
}

export async function exportVideo() {
  await ensureGlobalConfigLoaded();
  fillExportOptionsDialog();
  clearExportLog();
  clearExportProgress();
  setExportDialogRunning(false);
  if (elements.exportDialogLog) elements.exportDialogLog.open = false;
  elements.exportOptionsDialog?.showModal();
  // 全体設定の「動画書き出しにフォーマットを指定」が OFF (= promptBeforeExport=false)
  // の場合は、ダイアログを進捗表示用に開くだけにして書き出しを即開始する。
  // 直前に fillExportOptionsDialog() でフォーム値はプリセット既定で埋まっているので
  // startExport() がそのまま readExportFormValues() で読める。
  const promptBefore = Boolean(
    state.globalConfig?.config?.videoExport?.promptBeforeExport,
  );
  if (!promptBefore) {
    startExport().catch((err) => console.error(err));
  }
}

export function bindExport() {
  if (elements.exportVideoButton) {
    elements.exportVideoButton.addEventListener("click", () => {
      exportVideo().catch((err) => {
        console.error(err);
        showToast("書き出しダイアログを開けませんでした", "error");
      });
    });
  }
  // 旧「エクスポート」ボタンは「バックアップ」(static/js/backup.js) に
  // 役割が変わったので click 紐付けは backup.js 側に移動。`exportText`
  // 関数と `/api/export/text` エンドポイントは残してあるので、必要なら
  // window 経由で叩ける。

  // ダイアログ内のフォーム連動
  elements.exportOptionsPresetSelect?.addEventListener("change", () => {
    applyExportOptionsPresetUI();
  });
  elements.exportOptionsEncoderEngineSelect?.addEventListener("change", () => {
    const preset = findPreset(elements.exportOptionsPresetSelect?.value);
    if (preset) updateEncoderEngineHintFromPreset(preset, elements.exportOptionsEncoderEngineSelect.value);
  });
  elements.exportOptionsConfirmButton?.addEventListener("click", handleConfirmClick);
  elements.exportOptionsCancelButton?.addEventListener("click", handleCancelClick);
  elements.exportOptionsDialog?.addEventListener("close", handleDialogClose);
}
