// =============================================================================
// renderer/video-provider.js
//
// 背景動画 (videoTrack) の "frame の取り出し方" だけを抽象化する。
// scene-builder の絵作り経路は preview / export で完全に同一 (= 1 本に統一)、
// 違うのは「video frame をどこから持ってくるか」だけ。
//
// 契約:
//   class VideoProvider {
//     async init(videoTrackInfo, opts): Promise<void>
//     getTexture(): THREE.Texture
//     async updateForFrame({ sceneFrameIdx, sceneSec, fps }): Promise<void>
//     dispose(): void
//   }
//
// 実装:
//   - VideoTextureProvider:    HTMLVideoElement + THREE.VideoTexture (= preview)。
//                              video.play() に任せて毎 render で auto-sample。
//                              `updateForFrame` は no-op。
//   - WebCodecsVideoProvider:  MP4Box.js で demux + WebCodecs.VideoDecoder。
//                              frameIdx -> mediaTimestamp 一致の VideoFrame を
//                              テクスチャに upload。export 用 deterministic。
//
// なぜこの分離か (dev_docs/v2_export_multi_cut.md と同じ思想):
//   `HTMLVideoElement.currentTime = X` を毎フレーム設定する経路は frame-accurate
//   seek が保証されず、keyframe seek コストで 90fps の export pipeline を一気に
//   遅くする。WebCodecs の sequential decode は decode 順 = 表示順なので、
//   毎フレーム高速かつ frameIdx 一致が成立する。
// =============================================================================
import * as THREE from "three";

// 共通: video bg plane が要求する texture 設定 (CanvasTexture などと揃える)。
function _configureBackgroundTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // メインシーンが Y-down OrthographicCamera なので flipY=false が前提
  // (texture-cache.js の他テクスチャと同じ向き)。
  tex.flipY = false;
  return tex;
}

// =============================================================================
// VideoTextureProvider — preview 用
//   HTMLVideoElement (DOM <video>) を THREE.VideoTexture でラップ。
//   updateForFrame は呼ばれても何もしない (VideoTexture は renderer.render() の
//   タイミングで毎回 video.currentTime のフレームを GPU に upload する)。
// =============================================================================
export class VideoTextureProvider {
  /**
   * @param {HTMLVideoElement} videoElement  既に src が設定され、play() 済の <video>
   */
  constructor(videoElement) {
    if (!videoElement) throw new Error("VideoTextureProvider: videoElement is required");
    this.videoElement = videoElement;
    this.texture = _configureBackgroundTexture(new THREE.VideoTexture(videoElement));
    this._disposed = false;
  }

  getTexture() { return this.texture; }

  async updateForFrame(_state) {
    // VideoTexture は renderer.render() のタイミングで自動更新 (texSubImage2D
    // 相当を THREE が呼ぶ) されるので、ここは何もしない。
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this.texture?.dispose?.(); } catch (_) {}
    this.texture = null;
    // videoElement 自体は caller が DOM 管理しているので touch しない。
  }
}

// =============================================================================
// WebCodecsVideoProvider — export 用 (deterministic)
//
// MP4 を mp4box.js で demux → WebCodecs.VideoDecoder で sequential decode →
// frameIdx (= sceneSec) に対応する VideoFrame を THREE.Texture に bind。
//
// 使い方:
//   const p = new WebCodecsVideoProvider();
//   await p.init({ src, trimStartSec, speed, loop });  // demux + decoder configure
//   // ここまでで texture が用意される (最初の frame 描画前なら blank)
//   for each frame:
//     await p.updateForFrame({ sceneFrameIdx, sceneSec, fps });
//     renderer.render(...);  // texture が描画される (1 frame 遅延 close で安全)
//   p.dispose();
//
// 注意点:
//   - timestamp は **CTS** (composition timestamp) を使う。`is_sync` で key/delta。
//     B-frame 入り動画では DTS と CTS が違うので CTS 必須。
//   - VideoDecoder.isConfigSupported() で起動前に fail-fast。
//   - r165 には THREE.VideoFrameTexture が無い。OffscreenCanvas + CanvasTexture を
//     fallback として使う (drawImage(VideoFrame) は Chrome/Edge でサポート)。
// =============================================================================
export class WebCodecsVideoProvider {
  /**
   * @param {Object} [options]
   * @param {(sceneSec: number, ctx: { totalSec: number, trimStartSec: number, speed: number, loop: string }) => number} [options.mapFn]
   *   sceneSec → videoSec の変換関数を差し替える。videoLayer 用に
   *   mapVideoLayerSec を渡す経路で使う。省略時は背景動画 (videoTrack) 用の
   *   既定マッピング (trimStart + sceneSec * speed、loop=loop/freeze) を使う。
   * @param {Map<string, object>} [options.demuxCache]
   *   src URL → { samples, timescale, codec, description, width, height, totalSec } の
   *   共有キャッシュ。同一 src を複数 provider が使う (分割で生まれた continuation
   *   レイヤー等) ときに fetch + mp4box demux を 1 回で済ませる。lifecycle は caller
   *   が管理する (= export session 終了で drop して GC)。
   */
  constructor(options = {}) {
    this._disposed = false;
    this.texture = null;
    this._mapFn = typeof options.mapFn === "function" ? options.mapFn : null;
    this._demuxCache = options.demuxCache instanceof Map ? options.demuxCache : null;

    // mp4box demux 結果
    this.timescale = 0;
    this.samples = [];               // [{ cts, dts, duration, is_sync, data }]
    this.totalSec = 0;               // 動画素材の全長 (秒)

    // 再生制御 (videoTrack option)
    this.trimStartSec = 0;
    this.speed = 1;
    this.loop = "loop";              // "loop" | "freeze" | "transparent"

    // VideoDecoder
    this.decoder = null;
    this.decodedQueue = [];          // 表示順 (= CTS 順) で並ぶ VideoFrame
    this.nextSampleIdx = 0;          // 次に decode に push する sample
    this.decoderError = null;
    this._decoderConfig = null;      // reset 時に reconfigure するため保持

    // 表示中 frame の timestamp 範囲 (microseconds)。target がここに入っていれば
    // 同じ frame を出すだけなので decoder を動かさない (= freeze hold / 同一
    // target の連続呼出で詰まらない)。
    this._boundStartUs = -1;
    this._boundEndUs = -1;
    this._lastTargetUs = -1;         // rewind 検出用

    // texture path 切替: r170+ なら VideoFrameTexture、それ未満は OffscreenCanvas
    this.useVFT = false;
    this.canvas = null;
    this.ctx = null;
    this.currentFrame = null;        // VFT 経路で render 後に close するため保持
  }

  /**
   * @param {Object} videoTrackInfo  { src, trimStartSec, trimEndSec, speed, loop, fit, muted }
   *   videoLayer 用に呼び出す場合は constructor で mapFn を渡しておくのが前提。
   *   ここでは trimStartSec / speed / loop だけ参照する (mapFn 経路は totalSec を
   *   見て独自にクランプする)。
   */
  async init(videoTrackInfo) {
    if (!("VideoDecoder" in window)) {
      throw new Error("WebCodecs (VideoDecoder) がブラウザでサポートされていません");
    }
    if (!videoTrackInfo?.src) throw new Error("WebCodecsVideoProvider.init: src 必須");

    this.trimStartSec = Math.max(0, Number(videoTrackInfo.trimStartSec) || 0);
    this.speed = Math.max(0.05, Number(videoTrackInfo.speed) || 1);
    this.loop = String(videoTrackInfo.loop || "loop");

    // 1) ファイル取得 → mp4box demux。同一 src が demuxCache に乗っていれば再利用。
    //    samples/description は read-only 共有可能 (decoder per-provider なので
    //    decode 状態は混ざらない)。fetch + demux + sample sort は重く、分割で
    //    続きレイヤー化したときに同じ素材を何回も読まないようにする狙い。
    //    値は Promise<DemuxResult>。並列 init (Promise.all) で同 src が来ても、
    //    最初の 1 本だけが実際に demux し、他は同じ Promise を await するだけ。
    const src = videoTrackInfo.src.startsWith("/")
      ? videoTrackInfo.src
      : `/assets/${videoTrackInfo.src}`;
    let resultPromise = this._demuxCache ? this._demuxCache.get(src) : null;
    if (!resultPromise) {
      resultPromise = WebCodecsVideoProvider._demuxAndExtract(src);
      if (this._demuxCache) this._demuxCache.set(src, resultPromise);
      // demux 失敗時は cache から削除して、後続 provider が再試行できるようにする。
      resultPromise.catch(() => {
        if (this._demuxCache && this._demuxCache.get(src) === resultPromise) {
          this._demuxCache.delete(src);
        }
      });
    }
    const demux = await resultPromise;
    this.timescale = demux.timescale;
    this.samples = demux.samples;
    this.totalSec = demux.totalSec;
    const codec = demux.codec;
    const description = demux.description;
    const trackWidth = demux.width;
    const trackHeight = demux.height;

    // 2) decoder 起動可能性チェック
    const config = description ? { codec, description } : { codec };
    const supported = await VideoDecoder.isConfigSupported(config);
    if (!supported.supported) {
      throw new Error(`VideoDecoder: codec ${codec} が non-supported`);
    }

    this._decoderConfig = config;
    this.decoder = new VideoDecoder({
      output: (frame) => { this.decodedQueue.push(frame); },
      error: (err) => { this.decoderError = err; },
    });
    this.decoder.configure(config);

    // 5) texture 経路を選ぶ
    const w = trackWidth || 1920;
    const h = trackHeight || 1080;
    if (typeof THREE.VideoFrameTexture === "function") {
      this.useVFT = true;
      this.texture = _configureBackgroundTexture(new THREE.VideoFrameTexture());
    } else {
      // r165 fallback: OffscreenCanvas + CanvasTexture
      this.useVFT = false;
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext("2d", { alpha: false });
      this.texture = _configureBackgroundTexture(new THREE.CanvasTexture(this.canvas));
    }
    // 旧: trimStartSec まで init 内で pre-decode していたが、分割で同一 src を持つ
    // レイヤーが複数あるとき全レイヤー分の先回り decode が並列発火し、書き出しが
    // 「無限ループっぽく」固まる主因になっていた。Phase B で lazy/serial init を入れる
    // までは init 時点の追加 decode は行わず、updateForFrame の inactive skip と
    // 初回 active での catch-up に任せる。
  }

  getTexture() { return this.texture; }

  /**
   * 1 フレーム分のテクスチャ更新。後続の renderer.render() で反映される。
   * lifecycle: 前回の VideoFrame は updateForFrame の冒頭で close (= 1 frame 遅延 close)。
   *
   * @param {Object} state  { sceneFrameIdx, sceneSec, fps }
   */
  async updateForFrame({ sceneSec = 0, fps = 24 } = {}) {
    if (this._disposed) return;
    // 一度 decode が恒久失敗 (deadline 超過 / decoder error) したら、以降のフレームは
    // decode を再試行しない。毎フレーム deadline 待ちで書き出しが極端に遅くなる
    // (1 フレーム数秒 × 全フレーム) のを防ぎ、最後に表示できたフレームのまま継続する。
    if (this._decodeFailed) return;
    if (this.decoderError) {
      // decoder が壊れた (例: Windows の "Codec reclaimed due to inactivity"、HW
      // デコーダの停止)。毎フレーム throw し続けると上流が大量の warn を出し、長尺の
      // project 書き出しで UI が固まり実質ハングする (2026-06-02 Windows で発生)。
      // 恒久失敗として記録し、最初の 1 回だけ throw して上流に 1 行ログさせ、以降は
      // skip (最後に表示できたフレームを保持) して書き出しを degraded で完走させる。
      const err = this.decoderError;
      this._decodeFailed = true;
      this.decoderError = null;
      throw err;
    }

    // 1) target video timestamp (CTS、microseconds)
    //    mapFn が state="inactive"/"ended" を返すレイヤーは decode を一切起動しない。
    //    どちらも scene-builder 側で mesh.visible=false なので、末尾フレームを
    //    決定的に掴む必要は薄い。書き出し fps を奪うので skip。
    let targetSec;
    if (this._mapFn) {
      const ctx = {
        totalSec: this.totalSec,
        trimStartSec: this.trimStartSec,
        speed: this.speed,
        loop: this.loop,
      };
      const r = this._mapFn(Number(sceneSec) || 0, ctx);
      if (r && typeof r === "object" && "videoSec" in r) {
        if (r.state === "inactive" || r.state === "ended") return;
        targetSec = Math.max(0, Number(r.videoSec) || 0);
      } else {
        targetSec = Math.max(0, Number(r) || 0);
      }
    } else {
      targetSec = this._mapSceneSecToVideoSec(Number(sceneSec) || 0);
    }
    const targetUs = Math.round(targetSec * 1_000_000);

    // 2) bound check: 表示中 frame が target を含むなら何もしない。
    //    これで freeze hold / 同一 target 連続呼出 / 微小 jitter が無視できる。
    if (this._boundStartUs >= 0
        && targetUs >= this._boundStartUs
        && targetUs < this._boundEndUs) {
      this._lastTargetUs = targetUs;
      return;
    }

    // 3) rewind 検出: target が前回より十分小さければ loop 境界を踏んだ。
    //    decoder は sequential なので「前にしか進めない」前提で組んでおり、後ろに
    //    巻き戻す唯一の方法は decoder を close → reconfigure + nextSampleIdx=0。
    //    tolerance を 1 ms (1000us) 設けることで float 誤差での誤発火を回避。
    if (this._lastTargetUs >= 0 && targetUs < this._lastTargetUs - 1000) {
      this._resetDecoder();
    }
    this._lastTargetUs = targetUs;

    // 4) keyframe seek: 大きく forward jump する場合 (= 初回 active で trimStart まで
    //    追いつく / rewind 後の再起動 等) は、target を含む GOP の先頭 I-frame まで
    //    nextSampleIdx を飛ばして decoder を reset する。これがないと 0 から target
    //    まで全 sample を線形 decode するため、分割で trimStart が大きい複製ほど
    //    書き出し fps が落ちる (30 秒 → 720 sample → 24fps 級の主因)。
    this._keyframeSeekIfBeneficial(targetUs);

    // 5) target をカバーする frame が出力されるまで decoder に push
    try {
      await this._ensureDecodedTo(targetUs);
    } catch (err) {
      // deadline 超過 / decoder error は恒久失敗として記録し、以降のフレームでは
      // decode を再試行しない (上の _decodeFailed early-return で skip される)。
      this._decodeFailed = true;
      throw err;
    }

    // 5) target を含む frame を queue から取り出す。古い frame は close。
    const chosen = this._popFrameAt(targetUs);
    if (!chosen) return;  // (まだ出てない / queue 空) → 既存 bound のまま

    // 6) texture に bind + bound 範囲を更新
    if (this.useVFT) {
      // 1 frame 遅延 close (前フレームは render 完了済 = closed safe)
      if (this.currentFrame) {
        try { this.currentFrame.close(); } catch (_) {}
      }
      this.currentFrame = chosen;
      this.texture.setFrame(chosen);
    } else {
      // OffscreenCanvas fallback: drawImage で copy するので即 close できる
      this.ctx.drawImage(chosen, 0, 0, this.canvas.width, this.canvas.height);
      this.texture.needsUpdate = true;
      try { chosen.close(); } catch (_) {}
    }
    this._boundStartUs = chosen.timestamp;
    this._boundEndUs = chosen.timestamp + (chosen.duration || 0);
  }

  // 大きく forward jump するとき、target を含む GOP の先頭 sync sample (= I-frame)
  // まで nextSampleIdx を進めて decoder を reset する。
  // samples は DTS 昇順。is_sync=true が I-frame マーカ。B-frame は CTS と DTS が
  // 違うので、I-frame 探しは CTS で評価する: 「[curIdx..end] で is_sync=true かつ
  // CTS ≤ targetUs な最大 i」が target を含む GOP の先頭。CTS が target を超える
  // I-frame を見たら、それ以降は次 GOP なので break。
  // 短い jump (≤ JUMP_THRESHOLD_US) では decoder reset コストの方が高いので skip。
  _keyframeSeekIfBeneficial(targetUs) {
    const JUMP_THRESHOLD_US = 1_000_000;  // 1 秒以上の forward skip で発動
    if (this.samples.length === 0) return;
    if (this.nextSampleIdx >= this.samples.length) return;
    const curSample = this.samples[this.nextSampleIdx];
    const curCts = Math.round((curSample.cts / this.timescale) * 1_000_000);
    if (targetUs - curCts < JUMP_THRESHOLD_US) return;

    let syncIdx = -1;
    for (let i = this.nextSampleIdx; i < this.samples.length; i += 1) {
      const s = this.samples[i];
      const sCts = Math.round((s.cts / this.timescale) * 1_000_000);
      if (s.is_sync) {
        if (sCts <= targetUs) {
          syncIdx = i;
        } else {
          // target を超えた I-frame が出たら、それ以降は target を含まない GOP
          break;
        }
      }
    }
    // 見つからない / 後退方向 / 同位置なら何もしない (= sequential decode に任せる)
    if (syncIdx < 0 || syncIdx <= this.nextSampleIdx) return;

    // decoder を reset し、新 nextSampleIdx に jump。queue は _resetDecoder が破棄。
    // _boundStartUs/_boundEndUs もリセットされるので、後段 _popFrameAt は target を
    // 含む新フレームを正しく拾える。
    this._resetDecoder();
    this.nextSampleIdx = syncIdx;
  }

  // decoder を close → reconfigure し、queue/nextSampleIdx を 0 に戻す。
  // loop 境界で前に巻き戻すときに呼ぶ。keyframe seek 経由でも使われるが、
  // その場合は呼び出し側が _keyframeSeekIfBeneficial 内で nextSampleIdx を
  // すぐ書き換えるため 0 リセットは一時的。
  _resetDecoder() {
    while (this.decodedQueue.length > 0) {
      try { this.decodedQueue.shift().close(); } catch (_) {}
    }
    if (this.decoder && this.decoder.state !== "closed") {
      try { this.decoder.close(); } catch (_) {}
    }
    this.decoder = new VideoDecoder({
      output: (frame) => { this.decodedQueue.push(frame); },
      error: (err) => { this.decoderError = err; },
    });
    this.decoder.configure(this._decoderConfig);
    this.nextSampleIdx = 0;
    // bound はリセット (rewind 後の最初の target は確実に未表示)
    this._boundStartUs = -1;
    this._boundEndUs = -1;
  }

  _mapSceneSecToVideoSec(sceneSec) {
    // mapFn が外から差し替えられているなら委譲 (videoLayer 経路)。
    if (this._mapFn) {
      const ctx = {
        totalSec: this.totalSec,
        trimStartSec: this.trimStartSec,
        speed: this.speed,
        loop: this.loop,
      };
      const r = this._mapFn(Number(sceneSec) || 0, ctx);
      // mapVideoLayerSec は { state, videoSec } を返すので videoSec を取り出す。
      // 数値が返ってきた場合 (旧 mapSceneSecToVideoSec 互換) はそのまま使う。
      if (r && typeof r === "object" && "videoSec" in r) {
        return Math.max(0, Number(r.videoSec) || 0);
      }
      return Math.max(0, Number(r) || 0);
    }
    // 既定: trimStartSec から speed 倍速で再生するモデル (preview / v1 と一致)
    let videoSec = this.trimStartSec + sceneSec * this.speed;
    const total = this.totalSec;
    if (total <= 0) return Math.max(0, videoSec);
    if (videoSec >= total) {
      if (this.loop === "loop") {
        videoSec = videoSec % total;
      } else {
        // freeze / transparent: 末尾 frame に張り付かせる
        videoSec = Math.max(0, total - 1e-3);
      }
    }
    return Math.max(0, videoSec);
  }

  // 同一 src の fetch + mp4box demux + sample sort を 1 回で済ませる。
  // 並列 init で複数 provider が同 src を扱うとき、最初の 1 本だけ実 demux を走らせ、
  // 残りは同じ Promise を await する (= demuxCache.set でこの関数の Promise 自体を
  // 入れている)。samples / description は read-only 共有可能 (decoder は per-provider)。
  static async _demuxAndExtract(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`video fetch ${res.status}: ${src}`);
    const buf = await res.arrayBuffer();

    const mp4boxMod = await import("mp4box");
    const MP4Box = mp4boxMod.default || mp4boxMod;
    if (!MP4Box?.createFile) throw new Error("mp4box: createFile not found in module");
    // mov コンテナ (= 画面録画素材で多い) に含まれる未知 atom や padding を
    // mp4box が `[BoxParser] Box of type '...' has a size N greater than ...`
    // と error level で大量に console.error する問題の抑制。setLogLevel(5) は
    // mp4box 0.5.2 の「全 log silent」レベル (内部閾値 5 > error=4)。
    // 致命的な demux 失敗は file.onError コールバックが reject で別途補足するので、
    // ここで silent にしても問題は検出できる。grobal singleton のため初回 1 度で良い。
    const Log = mp4boxMod.Log || MP4Box?.Log;
    if (Log && typeof Log.setLogLevel === "function") {
      Log.setLogLevel(5);
    }
    const file = MP4Box.createFile();

    const trackInfo = await new Promise((resolve, reject) => {
      file.onError = (err) => reject(new Error(`mp4box: ${err}`));
      file.onReady = (info) => {
        const v = info.tracks.find((t) => t.type === "video");
        if (!v) reject(new Error("MP4 に video track がありません"));
        else resolve(v);
      };
      const ab = buf.slice(0);
      ab.fileStart = 0;
      file.appendBuffer(ab);
      file.flush();
    });

    const timescale = trackInfo.timescale || 1;
    const codec = trackInfo.codec;
    const description = _extractDescription(file, trackInfo, MP4Box);

    const all = [];
    file.onSamples = (_id, _user, samples) => {
      for (const s of samples) all.push(s);
    };
    file.setExtractionOptions(trackInfo.id, null, { nbSamples: 1_000_000 });
    file.start();
    file.flush();
    if (all.length === 0) throw new Error("MP4 sample 抽出が空 (= demux 失敗)");

    const samples = all.slice().sort((a, b) => a.dts - b.dts);
    const lastByCts = all.reduce((m, s) => (s.cts > m.cts ? s : m), all[0]);
    const totalSec = (lastByCts.cts + lastByCts.duration) / timescale;

    return {
      samples,
      timescale,
      totalSec,
      codec,
      description,
      width: trackInfo.video?.width || 1920,
      height: trackInfo.video?.height || 1080,
    };
  }

  async _ensureDecodedTo(targetUs) {
    // 一部の OS/コーデックでは WebCodecs が isConfigSupported=true を返しても、
    // 実 decode で output も error も返さず停止することがある (Windows の HEVC 等
    // .mov で観測, 2026-06-02)。その場合 decodeQueueSize>16 の wait が「エラーも
    // 出ないまま無限ループ」になり、書き出しがフレーム 0 でハング + 中止も効かなく
    // なる。wall-clock の deadline で打ち切り、明示エラーにして上流で失敗させる。
    const DECODE_DEADLINE_MS = 8000;
    const tDeadline = performance.now() + DECODE_DEADLINE_MS;
    // 診断用カウンタ: 投入した chunk 数 / これまでに出力された frame 数 (最大)。
    let pushed = 0;
    let maxOutput = 0;
    const _diag = (why) => new Error(
      `WebCodecs decode ${why}: target=${(targetUs / 1e6).toFixed(2)}s `
      + `total=${(this.totalSec || 0).toFixed(2)}s pushed=${pushed} `
      + `output=${this.decodedQueue.length}(max ${maxOutput}) `
      + `decodeQueueSize=${this.decoder?.decodeQueueSize ?? "?"} `
      + `nextIdx=${this.nextSampleIdx}/${this.samples.length} mapFn=${!!this._mapFn}. `
      + "(この OS/コーデックで HW デコードが進まない可能性。詳細を開発に共有してください)"
    );
    const _checkDeadline = () => {
      if (performance.now() > tDeadline) throw _diag("timeout");
    };
    // queue の末尾 (CTS 最大) が target を超えるまで chunk を流す
    let lastSeenEnd = this._lastQueueEndUs();
    while (lastSeenEnd < targetUs && this.nextSampleIdx < this.samples.length) {
      // backpressure: decodeQueueSize が大きいと wait
      while (this.decoder.decodeQueueSize > 16) {
        await new Promise((r) => setTimeout(r, 0));
        if (this.decoderError) throw this.decoderError;
        _checkDeadline();
      }
      _checkDeadline();
      const s = this.samples[this.nextSampleIdx++];
      // CTS で timestamp。is_sync で key/delta (B-frame 安全)
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: Math.round((s.cts / this.timescale) * 1_000_000),
        duration: Math.round((s.duration / this.timescale) * 1_000_000),
        data: s.data,
      });
      this.decoder.decode(chunk);
      pushed += 1;
      if (this.decodedQueue.length > maxOutput) maxOutput = this.decodedQueue.length;
      lastSeenEnd = this._lastQueueEndUs();

      // ★ プール枯渇対策 (Windows D3D11VA で output=8 程度で停止する症状の真因)。
      //   前方 seek 中はデコード済み VideoFrame が decodedQueue に溜まり続け、HW
      //   デコーダの出力サーフェスプール (≈8) を抱え込んだままにすると、デコーダが
      //   それ以上 output できず停止する (= decodeQueueSize が下がらず deadline)。
      //   target にまだ到達していない区間のフレームは「target より前」なので、
      //   末尾数枚だけ残して古いフレームを close → サーフェスを返却し、流し続ける。
      const KEEP_AHEAD = 3;
      while (this.decodedQueue.length > KEEP_AHEAD) {
        const f0 = this.decodedQueue[0];
        if ((f0.timestamp + f0.duration) <= targetUs) {
          try { this.decodedQueue.shift().close(); } catch (_) {}
        } else {
          break;
        }
      }
    }
    // 末尾 GOP / B-frame reorder の drain: 全 sample を投入し終えてもまだ target に
    // 届かない場合、デコーダ内にバッファされたフレームが flush 待ちで残っている。
    // WebCodecs は end-of-stream で明示 flush しないと末尾フレームを output しない
    // ことがあり、これが「nextIdx=N/N, pushed>0, output=0」の no-output の主因
    // (.mov の末尾を指すカット / ループ bg の末尾境界。Mac/Win 双方で発生, 2026-06)。
    // flush して残りを吐かせる。flush 後も decoder は configured のままで、ループの
    // rewind では _resetDecoder が別途 reconfigure するので副作用はない。
    //
    // ★ deadline 必須: Windows D3D11VA 等で HW デコーダが停止していると flush() が
    //   resolve しないことがある。await をむき出しにすると updateForFrame が返らず、
    //   書き出しがフレーム途中でフリーズ + キャンセル不能になる (= no-output を直そう
    //   とした B-1 修正が招いた回帰, 2026-06-20)。残り deadline で race して打ち切り、
    //   停止時は throw → 呼出側で _decodeFailed=true → 以降は decode を再試行せず
    //   degraded で完走 + 各フレーム冒頭の shouldAbort 判定に戻れるためキャンセル可能。
    if (pushed > 0
        && this.nextSampleIdx >= this.samples.length
        && this._lastQueueEndUs() < targetUs
        && this.decoder
        && this.decoder.state === "configured") {
      // 正常なデコーダなら末尾 GOP 数枚の drain は 1 秒未満で終わる。停止デコーダの
      // ペナルティを抑えるため上限は短め (= 失敗カットあたり最大 FLUSH_DEADLINE_MS)。
      const FLUSH_DEADLINE_MS = 1500;
      let flushTimer = null;
      try {
        const flushPromise = this.decoder.flush();
        // timeout 勝ち時に flush の遅延 reject を unhandled にしないための保険。
        flushPromise.catch(() => {});
        const flushDeadline = new Promise((_, reject) => {
          const remain = Math.min(FLUSH_DEADLINE_MS, Math.max(250, tDeadline - performance.now()));
          flushTimer = setTimeout(() => reject(_diag("flush-timeout")), remain);
        });
        await Promise.race([flushPromise, flushDeadline]);
      } finally {
        if (flushTimer != null) clearTimeout(flushTimer);
      }
      if (this.decoderError) throw this.decoderError;
      if (this.decodedQueue.length > maxOutput) maxOutput = this.decodedQueue.length;
    }
    // 出力が反映されるのを最大 100ms wait (decoder は async output)
    let waited = 0;
    while (this._lastQueueEndUs() < targetUs && waited < 100) {
      await new Promise((r) => setTimeout(r, 1));
      waited += 1;
      if (this.decoderError) throw this.decoderError;
    }
    if (this.decodedQueue.length > maxOutput) maxOutput = this.decodedQueue.length;
    // 診断: chunk を投入したのに 1 frame も出力されなかった = デコーダが入力を
    // 受けても出力しない (環境側の WebCodecs 故障の可能性)。明示エラーで上流に伝える。
    if (pushed > 0 && maxOutput === 0) {
      throw _diag("no-output");
    }
  }

  _lastQueueEndUs() {
    if (this.decodedQueue.length === 0) return -Infinity;
    const last = this.decodedQueue[this.decodedQueue.length - 1];
    return last.timestamp + last.duration;
  }

  _popFrameAt(targetUs) {
    // queue は CTS 昇順 (= 表示順)。target 以前で終わる frame は close して捨てる。
    // target を含む / 直近の frame を返す。
    let chosen = null;
    while (this.decodedQueue.length > 0) {
      const f = this.decodedQueue[0];
      const fEnd = f.timestamp + f.duration;
      if (fEnd <= targetUs && this.decodedQueue.length > 1) {
        const dropped = this.decodedQueue.shift();
        try { dropped.close(); } catch (_) {}
        continue;
      }
      // この frame を採用 (target を含む or 末尾の hold)
      chosen = this.decodedQueue.shift();
      break;
    }
    return chosen;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.currentFrame) {
      try { this.currentFrame.close(); } catch (_) {}
      this.currentFrame = null;
    }
    while (this.decodedQueue.length > 0) {
      try { this.decodedQueue.shift().close(); } catch (_) {}
    }
    if (this.decoder && this.decoder.state !== "closed") {
      try { this.decoder.close(); } catch (_) {}
    }
    if (this.texture) {
      try { this.texture.dispose(); } catch (_) {}
      this.texture = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.samples = [];
  }
}

// avcC / hvcC / vpcC 等の codec description を mp4box から取り出して Uint8Array で返す。
// VideoDecoder.configure({ description }) はこれを期待する形 (avcC payload 等)。
//
// box.write(DataStream) で box 全体 (size 4B + type 4B + payload) を書き出し、
// 先頭 8 bytes を捨てて payload のみ返す。
function _extractDescription(file, trackInfo, MP4Box) {
  const trakBox = file.moov.traks.find((t) => t.tkhd.track_id === trackInfo.id);
  if (!trakBox) return null;
  const stsd = trakBox.mdia?.minf?.stbl?.stsd;
  if (!stsd || !stsd.entries || stsd.entries.length === 0) return null;
  const entry = stsd.entries[0];
  const candidate = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (!candidate || typeof candidate.write !== "function") return null;

  // DataStream は MP4Box module の named/property export として取り出す。
  // jsdelivr +esm 経由では MP4Box.DataStream が直接 property に乗ることが多い。
  const DSCtor =
    (MP4Box && MP4Box.DataStream) ||
    (typeof window !== "undefined" && window.MP4Box && window.MP4Box.DataStream) ||
    null;
  if (!DSCtor) {
    // fallback: window.DataStream (古いビルド)
    if (typeof window !== "undefined" && window.DataStream) {
      const ds = new window.DataStream(undefined, 0, window.DataStream.BIG_ENDIAN);
      candidate.write(ds);
      return new Uint8Array(ds.buffer, 8);
    }
    console.warn("[WebCodecsVideoProvider] DataStream constructor が見つからず、description 抽出に失敗。一部 codec で decoder 起動が失敗するかもしれません。");
    return null;
  }
  const ds = new DSCtor(undefined, 0, DSCtor.BIG_ENDIAN);
  candidate.write(ds);
  return new Uint8Array(ds.buffer, 8);
}

// 便利 factory: kind と videoElement / videoTrackInfo を渡すと適切な provider を返す。
// kind = "preview"  → VideoTextureProvider (videoElement 必須)
// kind = "export"   → WebCodecsVideoProvider (Task #31 で実装)
export function createVideoProvider(kind, opts) {
  if (kind === "preview") {
    return new VideoTextureProvider(opts.videoElement);
  }
  if (kind === "export") {
    return new WebCodecsVideoProvider(opts);
  }
  throw new Error(`unknown VideoProvider kind: ${kind}`);
}
