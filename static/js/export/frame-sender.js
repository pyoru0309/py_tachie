// =============================================================================
// export/frame-sender.js
//
// 1 export セッション分の WebSocket 接続を持ち、handshake → 1 frame ずつ
// binary RGBA を流す → finish → サーバの done を待つ、を担当する。
//
// PoC bench で確認した重要事項:
//
//   1) WS 圧縮 (permessage-deflate) があると raw RGBA が CPU 圧縮で潰れる。
//      uvicorn は --ws-per-message-deflate=false で起動が必須級。
//      handshake 完了後に ws.extensions に文字列 permessage-deflate が
//      入っていたら警告を上げる (open() の戻り値で渡す)。
//   2) ws.send は呼んだ瞬間にだけ「キューに積んだ」を意味する。
//      実 throughput は ws.bufferedAmount を閾値まで落とす await を入れて
//      初めて見える。閾値 0 = backpressure 無効 (= enqueue fps しか見えない)。
//      export 本線では必ず非 0 (16-32MB 推奨) を入れる。
//   3) サーバから来る text JSON は 4 種:
//        ready    : ffmpeg 起動が成功した (出力先などを返す)
//        progress : 30 frame ごと
//        done     : encode 完了 (fps / ffmpegRc / outputPath などを返す)
//        error    : ffmpeg 起動失敗等
//      ready が来るまでは binary を流してはいけない。
// =============================================================================

export class FrameSender {
  /**
   * @param {Object} opts
   * @param {string} opts.url            WS URL (ws:// or wss://)
   * @param {Object} opts.handshake      最初に送る JSON。サーバ側で必須キーを定義。
   * @param {number} opts.bpThresholdMB  bufferedAmount がこの値 (MB) を超えている
   *                                     間は send を await する。0 で無効化。
   * @param {(line: string, kind?: "info"|"warn"|"err") => void} [opts.onLog]
   * @param {(progress: Object) => void} [opts.onProgress]
   */
  constructor({ url, handshake, bpThresholdMB = 16, onLog, onProgress, onEncoderProgress }) {
    this.url = url;
    this.handshake = handshake;
    this.bpThresholdBytes = Math.max(0, bpThresholdMB) * 1e6;
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onEncoderProgress = onEncoderProgress || (() => {});

    /** @type {WebSocket | null} */
    this.ws = null;
    this.serverReady = null;
    this.serverDone = null;
    /** @type {Error | null} */
    this.lastError = null;
    this.negotiatedExtensions = "";

    // 計測用
    this.sentBytes = 0;
    this.framesSent = 0;
    this.bpWaitTimes = [];
    this.sendTimes = [];
    this.bufferedAfter = [];
  }

  // open + handshake + ready 待ち。ready が来るまで返さない。
  // 接続失敗 / ready エラーは throw。
  async open() {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket connect error")), { once: true });
    });

    this.negotiatedExtensions = ws.extensions || "";
    if (/permessage-deflate/i.test(this.negotiatedExtensions)) {
      this.onLog(
        `WARN: permessage-deflate が交渉成立 (${this.negotiatedExtensions})。`
        + ` raw RGBA が WS 圧縮で潰れます。uvicorn を --ws-per-message-deflate=false で起動してください。`,
        "warn",
      );
    }

    ws.addEventListener("message", (ev) => this._onMessage(ev));
    ws.addEventListener("close", () => {
      // 正常終了は serverDone でわかる。それ以前に閉じたら error として上げる。
      if (!this.serverDone && !this.lastError) {
        this.lastError = new Error("WebSocket closed before done");
      }
    });

    ws.send(JSON.stringify(this.handshake));

    // ready / error を待つ
    while (!this.serverReady && !this.lastError) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.lastError) throw this.lastError;
    return this.serverReady;
  }

  _onMessage(ev) {
    if (typeof ev.data !== "string") return;
    let obj;
    try { obj = JSON.parse(ev.data); } catch { return; }
    if (obj.type === "ready") {
      this.serverReady = obj;
      this.onLog(`server ready: output=${obj.outputPath || "(no file)"}`);
    } else if (obj.type === "progress") {
      this.onProgress(obj);
    } else if (obj.type === "encoderProgress") {
      // ffmpeg `-progress pipe:1` を 1 秒ごとにパースしたメッセージ。
      // {frame, fps, outTime, speed, status} を caller に転送する。
      this.onEncoderProgress(obj);
    } else if (obj.type === "done") {
      this.serverDone = obj;
    } else if (obj.type === "error") {
      // 新形式: {code, detail}。旧形式 {message} も受ける (フォールバック)。
      const code = obj.code || "ERROR";
      const detail = obj.detail || obj.message || "server error";
      const err = new Error(`[${code}] ${detail}`);
      err.code = code;
      err.detail = detail;
      this.lastError = err;
      this.onLog(`server error [${code}]: ${detail}`, "err");
    }
  }

  // bufferedAmount が閾値を超えていれば await。0 = backpressure 無効。
  async _waitForDrain() {
    if (this.bpThresholdBytes <= 0) return 0;
    const ws = this.ws;
    if (!ws) return 0;
    const t0 = performance.now();
    while (ws.bufferedAmount > this.bpThresholdBytes) {
      await new Promise((r) => setTimeout(r, 1));
      if (this.lastError) break;
    }
    return performance.now() - t0;
  }

  // 1 frame 送信。bytes は Uint8Array (cpuBuf 共有)。
  // 注意: PboRingReadback の cpuBuf は同じバッファを使い回すため、
  // 呼び出し直後にコピーが必要なら ws.send 後の同期点までに caller がコピーする。
  // (実装上は ws.send が直ちにコピー or キューイングするので透過的に動く)
  async sendFrame(bytes) {
    const ws = this.ws;
    if (!ws) throw new Error("FrameSender not opened");
    if (this.lastError) throw this.lastError;

    const waited = await this._waitForDrain();
    this.bpWaitTimes.push(waited);

    const tS0 = performance.now();
    ws.send(bytes);
    const tS1 = performance.now();
    this.sendTimes.push(tS1 - tS0);
    this.bufferedAfter.push(ws.bufferedAmount);
    this.sentBytes += bytes.byteLength;
    this.framesSent += 1;
  }

  // finish を送って done を待つ。最大 timeoutMs 待つ (既定 60秒)。
  async finishAndWait(timeoutMs = 60_000) {
    const ws = this.ws;
    if (!ws) return null;
    try { ws.send(JSON.stringify({ type: "finish" })); } catch {}
    const start = performance.now();
    while (!this.serverDone && !this.lastError && performance.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.lastError) throw this.lastError;
    return this.serverDone;
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}
