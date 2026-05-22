// =============================================================================
// export/pbo-readback.js
//
// WebGL canvas → CPU 配列の readback を 2 経路提供する:
//   - SyncReadback     : gl.readPixels で即時 (CPU が GPU 完了を待つ)
//   - PboRingReadback  : PBO×N + fenceSync。N-1 frame 遅れで回収する非ドロップ実装
//
// PoC bench (static/js/v2-export-bench.js) で書いた実装を export 本線でも
// 使えるよう独立モジュール化したもの。bench 由来の挙動メモ:
//
//   - Chrome は gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL == 0。なので blocking
//     timeout 付き clientWaitSync は使えず、timeout=0 polling + setTimeout(0)
//     yield を回す。これを破ると WAIT_FAILED が永続して frame ロスする。
//   - export では「何があっても全 frame 回収」が要件なので drop-on-stall は
//     入れない。stall した時間は waitMs として呼び出し側に返すだけ。
//   - flushRemaining で ring に残った frame を必ず吐き出す (warmup ぶん)。
// =============================================================================

export class SyncReadback {
  constructor(gl, w, h) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 4);
    this.maxClientWaitTimeout = null;
  }
  // render 直後に呼ぶ。WebGL2 でなくても動く (旧コンテキスト fallback として有用)。
  async readback() {
    const gl = this.gl;
    const t0 = performance.now();
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    const t1 = performance.now();
    return { bytes: this.buf, stalled: false, readMs: t1 - t0, fetchMs: 0, waitMs: 0 };
  }
  advance() {}
  async flushRemaining(_callback) {}
  dispose() {}
}

export class PboRingReadback {
  // ring=2 で 1-frame-late、ring=3 で 2-frame-late。
  // 帯域に余裕が無い (Windows 旧 GPU 等) 環境だと ring=3 の方が stall を吸収しやすい。
  constructor(gl, w, h, ring = 2) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.ring = ring;
    this.frameBytes = w * h * 4;
    this.pbos = [];
    this.syncs = new Array(ring).fill(null);
    this.head = 0;
    this.warmup = 0;
    this.cpuBuf = new Uint8Array(this.frameBytes);

    // 診断カウンタ。ALREADY_SIGNALED = GPU 既完 / CONDITION_SATISFIED = polling
    // 中に完 / TIMEOUT_EXPIRED polls = yield + 再 poll の回数。
    this.rcAlready = 0;
    this.rcSatisfied = 0;
    this.rcTimeoutPolls = 0;

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

  // 1 frame の sync を完了まで待つ (timeout=0 polling)。1 秒を超えたら
  // 異常として throw する (export を勝手に止めない代わりに caller でリトライ可能)。
  async _waitForSync(sync) {
    const gl = this.gl;
    let r = gl.clientWaitSync(sync, 0, 0);
    if (r === gl.ALREADY_SIGNALED) {
      this.rcAlready += 1;
      return { stalled: false, waitMs: 0 };
    }
    if (r === gl.CONDITION_SATISFIED) {
      this.rcSatisfied += 1;
      return { stalled: false, waitMs: 0 };
    }
    if (r === gl.WAIT_FAILED) {
      throw new Error(`clientWaitSync WAIT_FAILED (gl.getError=${gl.getError()})`);
    }
    // TIMEOUT_EXPIRED: yield + 再 poll
    const tW0 = performance.now();
    while (true) {
      this.rcTimeoutPolls += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      r = gl.clientWaitSync(sync, 0, 0);
      if (r === gl.ALREADY_SIGNALED) { this.rcAlready += 1; break; }
      if (r === gl.CONDITION_SATISFIED) { this.rcSatisfied += 1; break; }
      if (r === gl.WAIT_FAILED) {
        throw new Error(`clientWaitSync WAIT_FAILED during poll (gl.getError=${gl.getError()})`);
      }
      if (performance.now() - tW0 > 1000) {
        throw new Error(`PBO sync wait > 1000ms (rcTimeoutPolls=${this.rcTimeoutPolls})`);
      }
    }
    return { stalled: true, waitMs: performance.now() - tW0 };
  }

  // render 直後に呼ぶ。head 位置の PBO に readPixels 発行 + fenceSync を立て、
  // 同時に ring-1 frame 前の slot から「必ず」回収する (= 非ドロップ)。
  // warmup 中 (最初の ring-1 frame) は bytes=null を返し、呼び出し側で skip させる。
  async readback() {
    const gl = this.gl;
    const ringSlot = this.head % this.ring;
    const t0 = performance.now();

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[ringSlot]);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    if (this.syncs[ringSlot]) gl.deleteSync(this.syncs[ringSlot]);
    this.syncs[ringSlot] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const t1 = performance.now();

    let stalled = false;
    let bytes = null;
    let fetchMs = 0;
    let waitMs = 0;
    if (this.warmup >= this.ring - 1) {
      const fetchSlot = (this.head + 1) % this.ring;
      const sync = this.syncs[fetchSlot];
      if (sync) {
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
      this.warmup += 1;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    return { bytes, stalled, readMs: t1 - t0, fetchMs, waitMs };
  }

  advance() { this.head += 1; }

  // 終端で ring に残ったフレームを取り出す。callback は async で受ける。
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

  dispose() {
    const gl = this.gl;
    for (const sync of this.syncs) if (sync) gl.deleteSync(sync);
    for (const pbo of this.pbos) gl.deleteBuffer(pbo);
    this.pbos = [];
    this.syncs = [];
  }
}

// readback モード文字列から実装を生成。"sync" は WebGL2 でなくても動く fallback。
export function createReadback(mode, gl, w, h) {
  if (mode === "sync") return new SyncReadback(gl, w, h);
  if (mode === "pbo2") return new PboRingReadback(gl, w, h, 2);
  if (mode === "pbo3") return new PboRingReadback(gl, w, h, 3);
  throw new Error(`unknown readback mode: ${mode}`);
}
