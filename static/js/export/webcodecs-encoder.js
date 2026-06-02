// =============================================================================
// export/webcodecs-encoder.js
//
// WebCodecs VideoEncoder で WebGL canvas を H.264 (annexb elementary stream) に
// エンコードし、圧縮チャンクを送信経路へ渡すラッパ。
//
// 背景 (2026-06-02): 従来の書き出しは生 RGBA 8.29MB/frame を WebSocket でサーバへ
// 送り ffmpeg がエンコードしていた。Windows ではこの転送が律速 (124GB を 119MB/s
// で送って ~18fps 頭打み)。ブラウザ内で先に H.264 へ圧縮すれば 1 frame 数百KB に
// なり、サーバは ffmpeg `-c copy` でコンテナ化するだけ (再エンコード無し) になる。
//
// annexb 形式を選ぶ理由: 各キーフレームに SPS/PPS が付くので、サーバは
// `-f h264 -i pipe:0 -c copy` でそのまま受けられる (description 受け渡し不要)。
//
// vflip 不要: VideoFrame(canvas) は OrthographicCamera(top=0) で正立合成済みの
// canvas をそのままキャプチャするため、readPixels(下原点) のような上下反転がない。
// =============================================================================

// avc1.<profileIdc><constraints><levelIdc> (16進)。High profile=0x64。
// level 4.0=0x28 (1080p@30 まで)、5.1=0x33 (4K まで)。
function _codecForSize(width, height) {
  const isLarge = width > 1920 || height > 1088;
  return isLarge ? "avc1.640033" : "avc1.640028";
}

// このブラウザで H.264 (annexb) エンコードが使えるか。VideoEncoder 非対応や
// isConfigSupported=false なら false を返し、呼び出し側は従来の生 RGBA 経路へ
// フォールバックする。
export async function isWebcodecsH264Supported(width, height) {
  if (typeof window === "undefined" || !("VideoEncoder" in window)) return false;
  try {
    const res = await window.VideoEncoder.isConfigSupported({
      codec: _codecForSize(width, height),
      width,
      height,
      bitrate: 16_000_000,
      framerate: 30,
      // 実際の configure と同じ latencyMode で能力確認する (realtime = 速度優先)。
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });
    return !!(res && res.supported);
  } catch {
    return false;
  }
}

// "8M" / "4000k" / "12000000" のようなビットレート文字列を bps (number) へ。
// 解釈できなければ null。
export function parseBitrate(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([kKmMgG]?)(?:bps|bit\/s)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const mul = unit === "g" ? 1e9 : unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1;
  return Math.round(n * mul);
}

// 目標ビットレート。ダイアログの「最大ビットレート」(maxrateOverride) があれば
// それを優先。無ければ 1080p@24 = 16Mbps を基準に解像度×fps でスケール
// (CRF20 相当の見た目を狙う)。下限 2Mbps。
export function computeBitrate(width, height, fps, maxrateOverride) {
  const override = parseBitrate(maxrateOverride);
  if (override && override > 0) return override;
  const base = 16_000_000;
  const scale = (width * height * fps) / (1920 * 1080 * 24);
  return Math.max(2_000_000, Math.round(base * scale));
}

// H.264 フレームエンコーダを生成する。
//   onChunk(Uint8Array): エンコード済みチャンクが出るたびに呼ばれる (送信経路へ)。
//   onError(Error): エンコーダのエラー (caller は中断判断に使う)。
// 返り値: { encodeCanvas, flush, close, chunkCount }
export function createH264FrameEncoder({ width, height, fps, bitrate, onChunk, onError }) {
  let firstError = null;
  let chunkCount = 0;
  // 律速診断: encodeQueueSize backpressure で待った合計時間と最大キュー深さ。
  // encodeWaitTotalMs が elapsed に近い = エンコーダ律速 (Windows ブラウザ実装が
  // ffmpeg/NVENC より遅い等)。≈0 なら encode は律速でなく render/decode が原因。
  let encodeWaitTotalMs = 0;
  let maxQueue = 0;

  const encoder = new window.VideoEncoder({
    output: (chunk) => {
      try {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        chunkCount += 1;
        onChunk(buf);
      } catch (e) {
        firstError = firstError || e;
        onError?.(e);
      }
    },
    error: (e) => {
      firstError = firstError || e;
      onError?.(e);
    },
  });

  encoder.configure({
    codec: _codecForSize(width, height),
    width,
    height,
    bitrate,
    framerate: fps,
    avc: { format: "annexb" },
    // latencyMode:"realtime" = スループット優先。"quality" は品質優先で lookahead /
    // B-frame を使い得るため遅く (Windows ブラウザ実装で encode が律速 = 2026-06-02
    // 実測 wait 44〜66%)、かつ B-frame は `-c copy` で PTS 並べ替えリスクがある。
    // バッチ書き出しは速度優先 + ビットレートで画質担保が正解なので realtime にする。
    latencyMode: "realtime",
    // GPU エンコーダ (NVENC 等、Media Foundation 経由) を優先させる。ソフトウェア
    // フォールバックを避けて Windows での encode を速くする狙い。
    hardwareAcceleration: "prefer-hardware",
    bitrateMode: "variable",
  });

  const keyEvery = Math.max(1, Math.round(fps * 2)); // 2 秒ごとに IDR

  // canvas を 1 frame 分エンコードする。VideoFrame は描画直後に同期取得し
  // (preserveDrawingBuffer:false でも安全)、その後 backpressure を待ってから
  // encode する。frameIdx は session 通算の単調増加インデックス。
  async function encodeCanvas(canvas, frameIdx) {
    if (firstError) throw firstError;
    // ★ yield する前に必ずキャプチャ (canvas クリア前に取り込む)。
    const timestamp = Math.round((frameIdx * 1e6) / fps);
    const frame = new VideoFrame(canvas, { timestamp });
    try {
      if (encoder.encodeQueueSize > maxQueue) maxQueue = encoder.encodeQueueSize;
      // produce が encode を追い越して GPU メモリを溜め込まないよう backpressure。
      // ここで待った時間 = エンコーダが捌けていない時間 (律速診断)。
      const tWait0 = performance.now();
      while (encoder.encodeQueueSize > 8) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1));
        if (firstError) throw firstError;
      }
      encodeWaitTotalMs += performance.now() - tWait0;
      encoder.encode(frame, { keyFrame: frameIdx % keyEvery === 0 });
    } finally {
      frame.close();
    }
  }

  async function flush() {
    await encoder.flush();
    if (firstError) throw firstError;
  }

  function close() {
    try { encoder.close(); } catch { /* already closed */ }
  }

  return {
    encodeCanvas,
    flush,
    close,
    get chunkCount() { return chunkCount; },
    getStats() {
      return { encodeWaitTotalMs, maxQueue, chunkCount, bitrate };
    },
  };
}
