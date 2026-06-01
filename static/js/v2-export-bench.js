// =============================================================================
// v2-export-bench.js
//
// WebGL → readPixels → WebSocket → ffmpeg stdin の搬送限界を測定するため
// だけの独立ページ。本体 UI とは状態を共有せず、自分で必要な API だけ叩く。
//
// 計測:
//   - per-frame: render / readPixels発行 / clientWaitSync(0)で stall した回数 /
//     getBufferSubData / ws.send / そのときの bufferedAmount
//   - 集計: mean fps, p50/p95 frame time, stall 発生率
//   - サーバ側: ffmpeg stdin write 時間 / drain 時間 (back-pressure)
//
// readback モード:
//   - sync : gl.readPixels で即時 (CPU 完了待ち)
//   - pbo2 : PBO×2 リング + fenceSync。1-frame-late で回収
//   - pbo3 : PBO×3 リング。2-frame-late で回収 (より大きな GPU 余裕)
//
// Y 反転:
//   - ffmpeg : 送信は左下原点のまま、ffmpeg -vf vflip で反転
//   - gpu    : FBO に反転 UV で焼いてから readPixels (PoC では未実装。今回は
//              ffmpeg / cpu / none の 3 つで先に帯域を見る)
//   - cpu    : 受信前に CPU で row reverse (1080p/4K で勝てない筋。比較用)
//   - none   : 反転無し (上下逆になるが、計測上は等価)
// =============================================================================
import {
  initRenderer,
  buildSceneFromLayerData,
  setActiveScene,
  disposeActiveScene,
  renderActiveScene,
  getActiveScene,
} from "/static/js/renderer/index.js";
import { getRenderer } from "/static/js/renderer/core.js";
import { preloadVisualizerImages } from "/static/js/renderer/scene-builder.js";

// ----- DOM 要素 ----------------------------------------------------------
const el = (id) => document.getElementById(id);
const ui = {
  status: el("status"),
  projectSelect: el("projectSelect"),
  cutSelect: el("cutSelect"),
  totalFrames: el("totalFramesInput"),
  resolution: el("resolutionSelect"),
  readback: el("readbackSelect"),
  vflip: el("vflipSelect"),
  encoder: el("encoderSelect"),
  vizMode: el("vizModeSelect"),
  bpThreshold: el("bpThresholdInput"),
  startBtn: el("startBtn"),
  stopBtn: el("stopBtn"),
  progress: el("progress"),
  canvas: el("renderCanvas"),
  statsOut: el("statsOut"),
  logOut: el("logOut"),
};

// ----- ログ --------------------------------------------------------------
function logLine(text, kind = "info") {
  const div = document.createElement("div");
  div.className = "line" + (kind === "err" ? " err" : "");
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${text}`;
  ui.logOut.appendChild(div);
  ui.logOut.scrollTop = ui.logOut.scrollHeight;
}

function setStatus(label, klass = "") {
  ui.status.textContent = label;
  ui.status.className = "pill" + (klass ? " " + klass : "");
}

// ----- プロジェクト/カット選択 ------------------------------------------
let projects = [];
let scenarioCache = null;

async function loadProjects() {
  const res = await fetch("/api/projects");
  const data = await res.json();
  projects = data.projects || [];
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
  // 既定 totalFrames はカット長
  const cut0 = cuts[0];
  if (cut0?.durationFrame) ui.totalFrames.value = String(cut0.durationFrame);
}

ui.projectSelect.addEventListener("change", onProjectChange);
ui.cutSelect.addEventListener("change", () => {
  const cuts = (scenarioCache?.scenes?.[0]?.cuts) || [];
  const sel = cuts.find((c) => c.id === ui.cutSelect.value);
  if (sel?.durationFrame) ui.totalFrames.value = String(sel.durationFrame);
});

// ----- scene-bundle 取得 -------------------------------------------------
async function fetchSceneBundle(cut, projectId = "") {
  const cutState = cut.state || {};
  const body = {
    ...cutState,
    cutId: cut.id,
    duration: (cut.durationFrame || 0) / 24,
    audio: cut.audio,
  };
  const url = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/v2/scene-bundle`
    : "/api/v2/scene-bundle";
  const res = await fetch(url, {
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

// ----- 計測ユーティリティ ------------------------------------------------
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[k];
}

function summarize(label, values) {
  if (!values.length) return `${label}: (no samples)`;
  const sum = values.reduce((a, b) => a + b, 0);
  return `${label}: mean=${(sum / values.length).toFixed(2)} p50=${percentile(values, 50).toFixed(2)} p95=${percentile(values, 95).toFixed(2)} max=${Math.max(...values).toFixed(2)} (n=${values.length})`;
}

// ----- readback 実装 ----------------------------------------------------
class SyncReadback {
  constructor(gl, w, h) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 4);
  }
  // sync: render 直後に呼んで即返す。
  // 戻り値: { bytes: Uint8Array, stalled: false, readMs, fetchMs }
  async readback() {
    const gl = this.gl;
    const t0 = performance.now();
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    const t1 = performance.now();
    return { bytes: this.buf, stalled: false, readMs: t1 - t0, fetchMs: 0 };
  }
  dispose() {}
}

class PboRingReadback {
  // PBO リング: render → readPixels(target=PIXEL_PACK_BUFFER, offset=0) で
  // GPU→PBO の転送発行 + fenceSync。N frame 後に clientWaitSync で完了確認、
  // getBufferSubData で CPU 配列へコピー。
  //
  // WebGL2 注意: clientWaitSync の timeout 引数は MAX_CLIENT_WAIT_TIMEOUT_WEBGL
  // 以下でなければ INVALID_OPERATION + WAIT_FAILED を返す。Chrome 等は実質 0、
  // ブラウザによって ~0..数ms と幅がある (MDN: clientWaitSync)。なので blocking
  // timeout は使わず、timeout=0 polling + setTimeout(0) yield で代用する。
  constructor(gl, w, h, ring = 2) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.ring = ring;
    this.frameBytes = w * h * 4;
    this.pbos = [];
    this.syncs = new Array(ring).fill(null);
    this.head = 0; // 次に書き込む slot
    this.warmup = 0; // 初回 ring 個分はまだ完了していない
    this.cpuBuf = new Uint8Array(this.frameBytes);
    // clientWaitSync の戻り値カウント (診断用)。WAIT_FAILED が出たら即 throw する。
    this.rcAlready = 0;       // ALREADY_SIGNALED (= 既に GPU が完了済み: 理想)
    this.rcSatisfied = 0;     // CONDITION_SATISFIED (= 待っている間に完了)
    this.rcTimeoutPolls = 0;  // TIMEOUT_EXPIRED (= polling 中。yield + 再 poll 回数)
    // MAX_CLIENT_WAIT_TIMEOUT_WEBGL は WebGL2 でも getParameter で取れる。
    try {
      const max = gl.getParameter(gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL);
      this.maxClientWaitTimeout = (typeof max === "number") ? max : null;
    } catch {
      this.maxClientWaitTimeout = null;
    }
    for (let i = 0; i < ring; i++) {
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.frameBytes, gl.STREAM_READ);
      this.pbos.push(pbo);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  // sync 完了まで timeout=0 polling で待つ (非ドロップ)。
  // 完了戻り値別カウンタを更新、WAIT_FAILED は throw、1 秒で諦めて throw。
  // 戻り値: { stalled: boolean, waitMs: number }
  async _waitForSync(sync) {
    const gl = this.gl;
    let r = gl.clientWaitSync(sync, 0, 0);
    if (r === gl.ALREADY_SIGNALED) {
      this.rcAlready += 1;
      return { stalled: false, waitMs: 0 };
    }
    if (r === gl.CONDITION_SATISFIED) {
      // timeout=0 で CONDITION_SATISFIED は通常出ないが、解釈上は完了。
      this.rcSatisfied += 1;
      return { stalled: false, waitMs: 0 };
    }
    if (r === gl.WAIT_FAILED) {
      throw new Error(`clientWaitSync WAIT_FAILED on first poll (gl.getError=${gl.getError()})`);
    }
    // r === TIMEOUT_EXPIRED → yield + 再 poll
    const tW0 = performance.now();
    while (true) {
      this.rcTimeoutPolls += 1;
      // setTimeout(0) は最低 4ms にクランプされ得るが、GPU drain は別スレッドで
      // 進むのでここで yield して JS thread を解放するだけで十分。MessageChannel
      // などでの sub-ms yield は将来余地。
      await new Promise((resolve) => setTimeout(resolve, 0));
      r = gl.clientWaitSync(sync, 0, 0);
      if (r === gl.ALREADY_SIGNALED) {
        this.rcAlready += 1;
        break;
      }
      if (r === gl.CONDITION_SATISFIED) {
        this.rcSatisfied += 1;
        break;
      }
      if (r === gl.WAIT_FAILED) {
        throw new Error(`clientWaitSync WAIT_FAILED during poll (gl.getError=${gl.getError()})`);
      }
      if (performance.now() - tW0 > 1000) {
        throw new Error(`PBO sync wait > 1000ms, last=TIMEOUT_EXPIRED (rcTimeoutPolls=${this.rcTimeoutPolls})`);
      }
    }
    return { stalled: true, waitMs: performance.now() - tW0 };
  }

  // readback: render 直後に呼ぶ。head 位置の PBO に readPixels 発行 → fenceSync。
  // 同時に、(head - ring) の slot から getBufferSubData で「必ず」回収する
  // (= 非ドロップ。実 export 等価)。GPU 未完了なら yield+retry で待つ。
  // stalled=true は「待ちが発生した (= GPU 完了より先に CPU が回収を試みた)」
  // の意味。waitMs に待ち時間を返す。
  async readback() {
    const gl = this.gl;
    const ringSlot = this.head % this.ring;
    const t0 = performance.now();

    // 1) head 位置の PBO に readPixels 発行
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[ringSlot]);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    // 既存の sync があれば delete (古い世代を上書きするケース)
    if (this.syncs[ringSlot]) {
      gl.deleteSync(this.syncs[ringSlot]);
    }
    this.syncs[ringSlot] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const t1 = performance.now();

    // 2) ring-1 frame 前の slot から「必ず」回収。warmup 中は何も返さない。
    //
    // 例 ring=2 (1-frame-late): head=0 で write のみ。head=1 で write+fetch slot 0
    //   (= frame 0 data)。head=2 で write+fetch slot 1 (= frame 1 data)。…
    //   warmup>=ring-1 で fetch を始めれば全 frame を取りこぼさない。
    let stalled = false;
    let bytes = null;
    let fetchMs = 0;
    let waitMs = 0;
    if (this.warmup >= this.ring - 1) {
      const fetchSlot = (this.head + 1) % this.ring; // ring 個前の slot = 次に上書きされる slot の逆
      const sync = this.syncs[fetchSlot];
      if (sync) {
        // 非ドロップ: timeout=0 polling で必ず完了まで待つ。WAIT_FAILED は throw。
        const w = await this._waitForSync(sync);
        stalled = w.stalled;
        waitMs = w.waitMs;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[fetchSlot]);
        const tF0 = performance.now();
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.cpuBuf);
        const tF1 = performance.now();
        fetchMs = tF1 - tF0;
        bytes = this.cpuBuf;
      }
    } else {
      // warmup: ring 分溜めるまで送らない
      this.warmup += 1;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    return { bytes, stalled, readMs: t1 - t0, fetchMs, waitMs };
  }

  // flush: 終端で残った PBO 中身を全部回収する (back-fill)。
  // 旧コードは clientWaitSync(0, 1ms) で待っていたが、Chrome では
  // MAX_CLIENT_WAIT_TIMEOUT_WEBGL=0 のため WAIT_FAILED が永続して frames ロス
  // していた。readback と同じ timeout=0 polling + yield に統一する。
  async flushRemaining(callback) {
    const gl = this.gl;
    for (let i = 0; i < this.ring - 1; i++) {
      const fetchSlot = (this.head + 1 + i) % this.ring;
      const sync = this.syncs[fetchSlot];
      if (!sync) continue;
      await this._waitForSync(sync);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[fetchSlot]);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.cpuBuf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      await callback(this.cpuBuf);
    }
  }

  advance() { this.head += 1; }

  dispose() {
    const gl = this.gl;
    for (const sync of this.syncs) {
      if (sync) gl.deleteSync(sync);
    }
    for (const pbo of this.pbos) {
      gl.deleteBuffer(pbo);
    }
    this.pbos = [];
    this.syncs = [];
  }
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

// ----- ベンチ本体 --------------------------------------------------------
let running = false;
let abortRequested = false;

ui.startBtn.addEventListener("click", () => runBench().catch((e) => {
  logLine(`error: ${e.message || e}`, "err");
  setStatus("error", "err");
  running = false;
  ui.startBtn.disabled = false;
  ui.stopBtn.disabled = true;
}));
ui.stopBtn.addEventListener("click", () => { abortRequested = true; });

async function runBench() {
  if (running) return;
  running = true;
  abortRequested = false;
  ui.startBtn.disabled = true;
  ui.stopBtn.disabled = false;
  ui.statsOut.textContent = "（測定中...）";
  setStatus("running", "run");

  const projectId = ui.projectSelect.value;
  const cutId = ui.cutSelect.value;
  const totalFrames = Math.max(1, parseInt(ui.totalFrames.value, 10) || 240);
  const [W, H] = ui.resolution.value.split("x").map((s) => parseInt(s, 10));
  const readbackMode = ui.readback.value;
  const vflipMode = ui.vflip.value;
  const encoder = ui.encoder.value;
  const vizMode = ui.vizMode?.value || "normal";
  // backpressure 閾値 (MB)。0 = 無制限。それ以外は ws.bufferedAmount が
  // この値を超えている間 ws.send を遅延させて、enqueue fps ではなく実 throughput を測る。
  const bpThresholdMB = Math.max(0, parseFloat(ui.bpThreshold.value) || 0);
  const bpThresholdBytes = bpThresholdMB * 1e6;

  logLine(`start: project=${projectId} cut=${cutId} ${W}x${H} frames=${totalFrames} readback=${readbackMode} vflip=${vflipMode} encoder=${encoder} viz=${vizMode} bpThresholdMB=${bpThresholdMB}`);

  const cuts = (scenarioCache?.scenes?.[0]?.cuts) || [];
  const cut = cuts.find((c) => c.id === cutId);
  if (!cut) throw new Error("cut not found");

  // 1) renderer 初期化 + canvas 解像度
  ui.canvas.width = W;
  ui.canvas.height = H;
  initRenderer(ui.canvas);
  const renderer = getRenderer();
  renderer.setSize(W, H, false);
  const gl = renderer.getContext();
  if (!gl || !(gl instanceof WebGL2RenderingContext)) {
    if (readbackMode !== "sync") {
      throw new Error("PBO readback requires WebGL2 (このブラウザは非対応)");
    }
  }

  // 2) scene-bundle 取得 → scene build
  // ★ per-cut コスト計測: 本番の project 書き出しはカット毎に scene-bundle 取得
  //    (サーバ Pillow でキャラレイヤー PNG を焼く) + buildScene (GPU 構築) を
  //    やり直す。ここで 1 カット分の ms を出し、×(カット数) で「カット再構築が
  //    総時間にどれだけ効くか (H1)」を見積もる。
  logLine("fetching scene bundle ...");
  const tBundle0 = performance.now();
  const layerData = await fetchSceneBundle(cut, projectId);
  const bundleMs = performance.now() - tBundle0;
  logLine(`scene-bundle fetch (server bake 含む) = ${bundleMs.toFixed(0)}ms`);
  // PoC では videoTrack は無視 (前景 RGBA だけを測る方針)
  layerData.hasVideoTrack = false;

  // visualizer mode を build 前後で適用。
  //   off       : layerData.visualizer を消す → scene に viz mesh が乗らない
  //   frozen    : frameDurationSec を巨大化 → idx は常に 0 に固定 (texture 差替え 0)
  //   preloaded : build 後に preloadVisualizerImages で全 frame を並列 fetch+decode
  //   normal    : 現行 (初期 1 枚 eager + 残り lazy)
  // idx 変化追跡用に元の frameDurationSec も保持しておく。
  const origVizFrameDurSec =
    Number(layerData.visualizer?.frameDurationSec) || (1 / 12);
  const origVizFrameCount = layerData.visualizer?.frames?.length || 0;
  if (vizMode === "off") {
    layerData.visualizer = null;
  } else if (vizMode === "frozen" && layerData.visualizer) {
    // 1e9 sec = idx は常に floor(elapsed / 1e9) = 0 になる
    layerData.visualizer = { ...layerData.visualizer, frameDurationSec: 1e9 };
  }
  const tBuild0 = performance.now();
  const sceneInstance = await buildSceneFromLayerData(layerData, null);
  const buildMs = performance.now() - tBuild0;
  setActiveScene(sceneInstance);
  // 本番 project 書き出しでは下記 2 つがカット数ぶん発生する。総カット数を
  // 掛けると「カット切替の作り直し」が elapsed のどれだけを占めるか分かる。
  const perCutMs = bundleMs + buildMs;
  logLine(
    `buildScene = ${buildMs.toFixed(0)}ms / per-cut 合計 (bundle+build) = `
    + `${perCutMs.toFixed(0)}ms → 80 カットなら約 ${(perCutMs * 80 / 1000).toFixed(1)}s`,
  );

  if (vizMode === "preloaded" && sceneInstance.meshes?.visualizer) {
    const tP0 = performance.now();
    const n = await preloadVisualizerImages(sceneInstance);
    logLine(`visualizer preload: ${n} frames in ${(performance.now() - tP0).toFixed(0)}ms`);
  }

  // 3) WS 接続
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${wsProto}//${location.host}/api/v2-export-bench/ws`);
  ws.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });

  // 4) ハンドシェイク
  ws.send(JSON.stringify({
    width: W,
    height: H,
    fps: 24,
    encoder,
    vflip: vflipMode === "ffmpeg",
    totalFrames,
  }));

  let serverDone = null;
  let serverReady = null;
  let serverProgress = (_o) => {};
  let lastError = null;
  // ws.extensions は handshake 完了後 (open 後) に negotiated 値が入る。
  // 一方サーバ側の sec-websocket-extensions ヘッダは「クライアントが提示した値」
  // なので、実際に交渉が成立しているかは ws.extensions で見る方が確実。
  const negotiatedExtensions = ws.extensions || "";
  if (/permessage-deflate/i.test(negotiatedExtensions)) {
    logLine(`WARN: permessage-deflate が交渉成立 (${negotiatedExtensions})。raw RGBA を毎フレーム圧縮しようとして CPU が負けます。uvicorn を --ws-per-message-deflate=false で起動推奨。`, "err");
  } else {
    logLine(`ws.extensions (negotiated) = ${negotiatedExtensions || "(none)"}`);
  }

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const obj = JSON.parse(ev.data);
      if (obj.type === "ready") {
        serverReady = obj;
        logLine(`server ready: output=${obj.outputPath || "(no file)"}`);
      }
      else if (obj.type === "progress") serverProgress(obj);
      else if (obj.type === "done") serverDone = obj;
      else if (obj.type === "error") {
        lastError = new Error(obj.message);
        logLine(`server error: ${obj.message}`, "err");
      }
    } catch {}
  });

  // 5) readback 準備
  let readbackEngine;
  if (readbackMode === "sync") {
    readbackEngine = new SyncReadback(gl, W, H);
  } else if (readbackMode === "pbo2") {
    readbackEngine = new PboRingReadback(gl, W, H, 2);
  } else if (readbackMode === "pbo3") {
    readbackEngine = new PboRingReadback(gl, W, H, 3);
  } else {
    throw new Error(`unknown readback mode: ${readbackMode}`);
  }
  if (readbackEngine.maxClientWaitTimeout !== undefined) {
    // Chrome は通常 0 (= blocking timeout 不可、polling 必須)、Firefox は 0 以外も
    // 報告し得る。0 でも非ドロップ polling は機能する (timeout=0 即返り)。
    logLine(`MAX_CLIENT_WAIT_TIMEOUT_WEBGL = ${readbackEngine.maxClientWaitTimeout}`);
  }

  // 6) フレームループ
  const renderTimes = [];
  const readTimes = [];
  const fetchTimes = [];
  const pboWaitTimes = []; // PBO 非ドロップ wait の所要時間 (sync モードでは empty)
  const vflipTimes = [];   // CPU vflip だけの所要時間 (vflipMode==='cpu' のときのみ)
  const sendTimes = [];    // ws.send() コール自体 (= キュー積み込み時間)
  const bpWaitTimes = [];  // backpressure で await した時間 (= 実 throughput を測る)
  const bufferedAfter = [];
  // 視覚化 idx 変化フレーム / 維持フレームでの render+readPixels 内訳。
  // off/frozen/non-viz でも常に collect (空 bucket は出力時に skip)。
  const renderTimesVizChange = [];
  const renderTimesVizSame = [];
  const readTimesVizChange = [];
  const readTimesVizSame = [];
  let prevVizIdx = -1;
  let stallCount = 0;
  let sentBytes = 0;
  let framesSent = 0;
  const animationFps = 12;
  // 先頭 N フレームを除いた steady-state fps を計測するための anchor。
  const STEADY_WARMUP = 10;
  let steadyAnchorTime = null;
  let steadyAnchorSent = 0;
  const tStart = performance.now();

  // backpressure: bufferedAmount が閾値を超えていれば await。bpThresholdBytes==0 で無効。
  const waitForDrain = async () => {
    if (bpThresholdBytes <= 0) return 0;
    const t0 = performance.now();
    while (ws.bufferedAmount > bpThresholdBytes) {
      // setTimeout(0) は spec 上 4ms 以上に丸まる。1ms 解像度を出すため
      // MessageChannel ベースのマイクロタスクは使わず、setTimeout で十分。
      await new Promise((r) => setTimeout(r, 1));
      if (abortRequested || lastError) break;
    }
    return performance.now() - t0;
  };

  for (let f = 0; f < totalFrames; f++) {
    if (abortRequested) { logLine("aborted by user", "err"); break; }
    if (lastError) break;

    // a) update + render
    const elapsedSec = f / 24;
    // この frame で visualizer の idx が前 frame から変化したか (split 計測用)。
    // off / no-viz では常に -1 → 「変化なし」扱い。
    let curVizIdx = -1;
    if (vizMode === "frozen" && origVizFrameCount > 0) {
      curVizIdx = 0;
    } else if (vizMode !== "off" && origVizFrameCount > 0) {
      curVizIdx = Math.floor(elapsedSec / origVizFrameDurSec);
      if (curVizIdx >= origVizFrameCount) curVizIdx = origVizFrameCount - 1;
    }
    const vizChanged = curVizIdx !== prevVizIdx;
    prevVizIdx = curVizIdx;

    const tR0 = performance.now();
    renderActiveScene({
      eyeKey: "open",
      mouthKey: "closed",
      speakerId: null,
      shakeDx: 0, shakeDy: 0,
      idleDx: 0, idleDy: 0,
      elapsedSec,
      animationFps,
      frameIdx: f,
    });
    const tR1 = performance.now();
    const renderMs = tR1 - tR0;
    renderTimes.push(renderMs);
    if (vizChanged) renderTimesVizChange.push(renderMs);
    else renderTimesVizSame.push(renderMs);

    // b) readback
    const rb = await readbackEngine.readback();
    readTimes.push(rb.readMs);
    if (vizChanged) readTimesVizChange.push(rb.readMs);
    else readTimesVizSame.push(rb.readMs);
    if (rb.fetchMs) fetchTimes.push(rb.fetchMs);
    if (rb.waitMs) pboWaitTimes.push(rb.waitMs);
    if (rb.stalled) stallCount += 1;
    if (readbackEngine.advance) readbackEngine.advance();

    let bytesToSend = rb.bytes;
    if (bytesToSend && vflipMode === "cpu") {
      const tV0 = performance.now();
      cpuVerticalFlip(bytesToSend, W, H);
      vflipTimes.push(performance.now() - tV0);
    }

    // c) WS 送信 (bytes が無い frame は warmup なので skip)
    if (bytesToSend) {
      // backpressure: ここで await することで「ws の queue が捌けたら送る」になる。
      // 結果として framesSent / elapsed が enqueue fps ではなく実 throughput になる。
      const waited = await waitForDrain();
      bpWaitTimes.push(waited);

      const tS0 = performance.now();
      ws.send(bytesToSend);
      const tS1 = performance.now();
      sendTimes.push(tS1 - tS0);
      bufferedAfter.push(ws.bufferedAmount);
      sentBytes += bytesToSend.byteLength;
      framesSent += 1;
      // 先頭 STEADY_WARMUP frame 送信完了時点を anchor に取る (texture 初回 upload や
      // GL シェーダ初期化が混じる序盤を steady-state から除外するため)。
      if (framesSent === STEADY_WARMUP && steadyAnchorTime === null) {
        steadyAnchorTime = performance.now();
        steadyAnchorSent = framesSent;
      }
    }

    if ((f + 1) % 30 === 0) {
      const dt = (performance.now() - tStart) / 1000;
      const fpsLabel = bpThresholdBytes > 0 ? "fps" : "enqueue fps";
      ui.progress.textContent = `${f + 1}/${totalFrames} frames, ${(framesSent / dt).toFixed(1)} ${fpsLabel}, bufferedAmount=${(ws.bufferedAmount / 1e6).toFixed(1)}MB, stall=${stallCount}`;
    }
  }

  // 7) PBO の back-fill (ring 分残っている)
  if (readbackEngine.flushRemaining) {
    await readbackEngine.flushRemaining(async (bytes) => {
      let bytesToSend = bytes;
      if (vflipMode === "cpu") cpuVerticalFlip(bytesToSend, W, H);
      ws.send(bytesToSend);
      sentBytes += bytesToSend.byteLength;
      framesSent += 1;
    });
  }
  readbackEngine.dispose();

  // 8) 終端通知 + サーバ集計待ち
  ws.send(JSON.stringify({ type: "finish" }));
  // 最大 60 秒待つ
  const startWait = performance.now();
  while (!serverDone && performance.now() - startWait < 60_000) {
    if (lastError) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  try { ws.close(); } catch {}

  const tEnd = performance.now();
  const elapsed = (tEnd - tStart) / 1000;
  const browserFps = framesSent / elapsed;

  // 9) 集計
  // steady-state fps: 序盤 STEADY_WARMUP frame を除外。anchor が立たないほど短い
  // 実行 (totalFrames < STEADY_WARMUP) では undefined にして「N/A」を出す。
  let steadyFps = null;
  if (steadyAnchorTime !== null && framesSent > steadyAnchorSent) {
    const dt = (tEnd - steadyAnchorTime) / 1000;
    if (dt > 0) steadyFps = (framesSent - steadyAnchorSent) / dt;
  }

  const lines = [];
  lines.push(`## 設定`);
  lines.push(`project=${projectId} cut=${cutId} ${W}x${H} frames=${framesSent}/${totalFrames}`);
  lines.push(`readback=${readbackMode} vflip=${vflipMode} encoder=${encoder} viz=${vizMode} bpThresholdMB=${bpThresholdMB}`);
  lines.push(`ws.extensions (negotiated) = ${negotiatedExtensions || "(none)"}`);
  lines.push(``);
  lines.push(`## ブラウザ側`);
  lines.push(`elapsed = ${elapsed.toFixed(2)} s`);
  const fpsLabel = bpThresholdBytes > 0 ? "fps (実 throughput, backpressure 入り)" : "enqueue fps (backpressure 無し / queue 積込み速度)";
  lines.push(`${fpsLabel} = ${browserFps.toFixed(2)}`);
  if (steadyFps !== null) {
    lines.push(`steady-state fps (先頭 ${STEADY_WARMUP} frame 除外) = ${steadyFps.toFixed(2)}`);
  } else {
    lines.push(`steady-state fps = N/A (frames < ${STEADY_WARMUP})`);
  }
  lines.push(`sent bytes = ${(sentBytes / 1e6).toFixed(1)} MB (= ${(sentBytes / 1e6 / elapsed).toFixed(1)} MB/s)`);
  lines.push(`stalls (PBO had to wait) = ${stallCount}`);
  // PBO 戻り値カウント (clientWaitSync の挙動が想定通りかの検証)
  if (readbackEngine instanceof PboRingReadback) {
    lines.push(
      `clientWaitSync rc: ALREADY_SIGNALED=${readbackEngine.rcAlready} `
      + `CONDITION_SATISFIED=${readbackEngine.rcSatisfied} `
      + `TIMEOUT_EXPIRED polls=${readbackEngine.rcTimeoutPolls} `
      + `(MAX_CLIENT_WAIT_TIMEOUT_WEBGL=${readbackEngine.maxClientWaitTimeout})`
    );
  }
  lines.push(summarize("render ms", renderTimes));
  lines.push(summarize("readPixels発行 ms", readTimes));
  lines.push(summarize("getBufferSubData ms", fetchTimes));
  lines.push(summarize("PBO wait ms (非ドロップ wait)", pboWaitTimes));
  lines.push(summarize("CPU vflip ms", vflipTimes));
  lines.push(summarize("backpressure wait ms", bpWaitTimes));
  lines.push(summarize("ws.send ms (キュー積込み)", sendTimes));
  lines.push(summarize("bufferedAmount(MB)", bufferedAfter.map((b) => b / 1e6)));
  // visualizer idx 変化フレーム / 維持フレームでの内訳。両 bucket に sample が
  // 揃っていなければ意味が無いので、両方に値があるときだけ出す。
  if (renderTimesVizChange.length > 0 && renderTimesVizSame.length > 0) {
    lines.push(``);
    lines.push(`## visualizer idx 変化フレーム vs 維持フレーム (viz=${vizMode}, origFrames=${origVizFrameCount})`);
    lines.push(summarize("render ms (idx changed)", renderTimesVizChange));
    lines.push(summarize("render ms (idx same)", renderTimesVizSame));
    lines.push(summarize("readPixels ms (idx changed)", readTimesVizChange));
    lines.push(summarize("readPixels ms (idx same)", readTimesVizSame));
  }
  lines.push(``);
  lines.push(`## サーバ側`);
  if (serverDone) {
    lines.push(`server fps = ${serverDone.fps?.toFixed(2)}`);
    if (serverDone.throughputMBps) lines.push(`server throughput = ${serverDone.throughputMBps.toFixed(1)} MB/s`);
    lines.push(`ffmpeg rc = ${serverDone.ffmpegRc}`);
    if (serverDone.outputPath) lines.push(`output = ${serverDone.outputPath}`);
    if (serverDone.receiveIdleMs) {
      const r = serverDone.receiveIdleMs;
      lines.push(`ws.receive idle ms (前 frame 完了→次 frame 到着): mean=${r.mean.toFixed(2)} p50=${r.p50.toFixed(2)} p95=${r.p95.toFixed(2)} max=${r.max.toFixed(2)}`);
    }
    if (serverDone.stdinWriteMs) {
      const w = serverDone.stdinWriteMs;
      lines.push(`stdin write ms: mean=${w.mean.toFixed(2)} p50=${w.p50.toFixed(2)} p95=${w.p95.toFixed(2)} max=${w.max.toFixed(2)}`);
    }
    if (serverDone.drainMs) {
      const d = serverDone.drainMs;
      lines.push(`stdin drain ms (ffmpeg back-pressure): mean=${d.mean.toFixed(2)} p50=${d.p50.toFixed(2)} p95=${d.p95.toFixed(2)} max=${d.max.toFixed(2)}`);
    }
    if (serverDone.ffmpegStderrTail) {
      lines.push(`-- ffmpeg stderr tail --`);
      lines.push(serverDone.ffmpegStderrTail.slice(-500));
    }
  } else {
    lines.push(`(server done message not received)`);
  }

  ui.statsOut.textContent = lines.join("\n");
  setStatus("done", "done");
  logLine(`finished: browser fps=${browserFps.toFixed(1)}`);

  disposeActiveScene();
  ui.startBtn.disabled = false;
  ui.stopBtn.disabled = true;
  running = false;
}

// ----- 起動 -------------------------------------------------------------
loadProjects().catch((e) => {
  logLine(`failed to load projects: ${e.message || e}`, "err");
});
