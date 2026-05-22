// source-time → stream-time 変換 (clean PCM 用)。
//
// 編集 UI 上の `trimStartSec/trimEndSec` は元素材の source-time。clean PCM は
// `aresample=48000,asetpts=N/SR/TB` で AAC packet を順次 decode した連続 sample
// に振り直したもので、source-time の PTS gap が stream-time では消えている。
// preview の VL audio を `<audio src=clean_pcm.wav>` で再生する際、`currentTime`
// に source-time をそのまま渡すと「数秒先走り / 後送り」のズレが出る。本関数で
// 変換してから渡せば preview 通し再生 / 途中 seek 再生 / export の 3 経路が
// stream-time で揃う。
//
// Python 側の `app/export_video.py:source_to_stream_time` と同じ semantics で
// 実装する (= 半開区間 `[start, end)`、 gap 中の丸めは side で分岐)。
//
// `mapInfo`: `/api/clean-pcm-info` が返す `{"sample_rate": int, "frames":
//   [[pts_time, stream_time, nb_samples], ...]}` 形式。

/**
 * @param {{sample_rate: number, frames: [number, number, number][]}} mapInfo
 * @param {number} sourceSec
 * @param {"start" | "end"} [side="start"]
 * @returns {number} clean PCM 内の stream-time (秒)
 */
export function sourceToStreamTime(mapInfo, sourceSec, side = "start") {
  if (!mapInfo) return Math.max(0, +sourceSec || 0);
  const sr = mapInfo.sample_rate | 0;
  const frames = mapInfo.frames;
  if (sr <= 0 || !Array.isArray(frames) || frames.length === 0) {
    return Math.max(0, +sourceSec || 0);
  }
  const target = +sourceSec;
  if (!Number.isFinite(target)) return 0;

  // 範囲外: 最初の frame の pts_time より小さい / 最後の frame の終端より大きい
  if (target <= +frames[0][0]) return +frames[0][1];
  const last = frames[frames.length - 1];
  const lastPts = +last[0];
  const lastStream = +last[1];
  const lastN = +last[2];
  const lastSrcEnd = lastPts + lastN / sr;
  const lastStreamEnd = lastStream + lastN / sr;
  if (target >= lastSrcEnd) return lastStreamEnd;

  // 二分探索: frames[lo][0] <= target となる最大の lo
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (+frames[mid][0] <= target) lo = mid;
    else hi = mid;
  }

  const srcLo = +frames[lo][0];
  const strLo = +frames[lo][1];
  const nLo = +frames[lo][2];
  const srcLoEnd = srcLo + nLo / sr;

  if (target < srcLoEnd) {
    // lo frame 内 (= 通常区間): 線形補間
    if (nLo <= 0) return strLo;
    const ratio = (target - srcLo) / (nLo / sr);
    return strLo + ratio * (nLo / sr);
  }

  // gap 中 (= source_sec が lo frame の終端より後、 hi frame の頭より前)
  if (side === "end") {
    return strLo + nLo / sr;
  }
  // "start": 次 frame の頭
  if (lo + 1 < frames.length) return +frames[lo + 1][1];
  return lastStreamEnd;
}
