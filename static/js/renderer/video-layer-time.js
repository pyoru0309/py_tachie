// ===========================================================================
// renderer/video-layer-time.js
//
// 動画レイヤー (videoLayers) の時間マッピング。
//
// scene の videoTrack 用 mapSceneSecToVideoSec とは別物。videoLayer は:
//   - シーン頭から連続再生する背景動画ではなく、startFrame で配置される短いクリップ
//   - loop しない / speed=1 固定 / trim 範囲を越えたら freeze + 非表示
//
// 呼び出し側は /api/video-duration から解決した videoDurationSec を必ず渡す。
// duration 未解決時は呼び出し側で skip (= state="inactive" として扱う) する。
// ===========================================================================

/**
 * @param {object} layer videoLayer のスキーマ
 *   - startFrame: number  シーン頭からの配置フレーム
 *   - trimStartSec: number  動画ファイル内の使用開始秒
 *   - trimEndSec: number|null  使用終了秒 (null=ファイル末尾)
 * @param {number} sceneSec 評価する scene 内通算秒
 * @param {number} fps PROJECT_FPS (24)
 * @param {number} videoDurationSec /api/video-duration で取得した素材の長さ
 * @returns {{ state: "inactive"|"active"|"ended", videoSec: number, localSec: number, spanSec: number }}
 *   - inactive: sceneSec が startFrame より前。video は pause、mesh.visible=false
 *   - active:   sceneSec が trim 範囲内。video.currentTime=videoSec
 *   - ended:    sceneSec が trim 範囲を越えた。video は trimEnd で freeze、mesh.visible=false
 *   - localSec: 配置開始 (startSec) からの経過秒。inactive のとき負、ended のとき >= spanSec
 *   - spanSec: trimEnd - trimStart (= タイムライン上のレイヤー長)
 */
export function mapVideoLayerSec(layer, sceneSec, fps, videoDurationSec) {
  const f = Number(fps) > 0 ? Number(fps) : 24;
  const dur = Number(videoDurationSec);
  const totalDuration = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const startSec = Math.max(0, (Number(layer?.startFrame) || 0) / f);
  const trimStart = Math.max(0, Number(layer?.trimStartSec) || 0);
  // 終端は trimEndSec があればそれ、無ければ素材末尾。両者を duration でクランプ。
  const rawTrimEnd = layer?.trimEndSec != null ? Number(layer.trimEndSec) : totalDuration;
  const trimEnd = totalDuration > 0
    ? Math.min(totalDuration, Math.max(trimStart, rawTrimEnd))
    : Math.max(trimStart, rawTrimEnd);
  const span = Math.max(0, trimEnd - trimStart);
  const localSec = Number(sceneSec) - startSec;
  if (!Number.isFinite(localSec) || localSec < 0 || span <= 0) {
    return { state: "inactive", videoSec: trimStart, localSec: Number.isFinite(localSec) ? localSec : 0, spanSec: span };
  }
  if (localSec >= span) {
    // 末尾 frame で freeze、非表示
    return { state: "ended", videoSec: Math.max(0, trimEnd - 1e-3), localSec, spanSec: span };
  }
  return { state: "active", videoSec: trimStart + localSec, localSec, spanSec: span };
}
