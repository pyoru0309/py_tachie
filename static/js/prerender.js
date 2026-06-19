// =============================================================================
// prerender.js — 事前解析 (プリレンダー) の司令塔 (2026-06-20)
//
// 書き出し前にサーバ側キャッシュ (ビジュアライザー解析の音源単位ストリーム +
// scene-bundle の焼き込み PNG) をカット単位で温めておくための機能。cold 書き出しが
// 遅い (#2) のと「今 何がキャッシュ済みか見えない」課題への対応。
//
// 「1 カット warm する」= そのカットの scene-bundle を vizSourceBuild=true で fetch
// すること。これでサーバは音源全長解析を同期実行してキャッシュし、bundle PNG も焼く。
// purpose / vizSourceBuild は stable token から除外されるので、ここで温めた成果物は
// そのまま書き出し (export-session の独自 fetch=既定 vizSourceBuild) でも再利用される。
//
// 可視化: state.cutPrerenderStatus (Map<cutId, "analyzing"|"ready">) を更新し、
// timeline.js がタイムライン最上部に per-cut の赤(解析中)/緑(解析済)ストリップを描く。
// プレビュー先読み (NEXT/LOOKAHEAD) の warm 成功でも ready になるので、再生するだけで
// 先のカットが緑に変わっていく (= 受動的な可視化)。
//
// warm の実体 (= warmCut) は playback.js の fetchSceneBundleV2 経由だが、循環 import を
// 避けるため bindPrerender で注入する (このモジュールは playback.js を import しない)。
// =============================================================================

import { state } from "./state.js";
import { drawTimeline } from "./timeline.js";

let _warmCut = null;       // (cut) => Promise<any>  : 1 カットを warm する関数 (注入)
let _running = false;
let _cancelRequested = false;

export function bindPrerender({ warmCut } = {}) {
  if (typeof warmCut === "function") _warmCut = warmCut;
}

export function isPrerendering() {
  return _running;
}

export function cancelPrerender() {
  if (_running) _cancelRequested = true;
}

// rAF で coalesce してストリップだけ再描画する (per-cut 更新で drawTimeline を
// 連発しないため)。drawTimeline 全体だが、タイムラインは canvas 1 枚なので十分軽い。
let _redrawScheduled = false;
function _scheduleStripRedraw() {
  if (_redrawScheduled) return;
  _redrawScheduled = true;
  const raf = (typeof requestAnimationFrame === "function")
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);
  raf(() => {
    _redrawScheduled = false;
    try { drawTimeline(); } catch (_) { /* ignore */ }
  });
}

// カットの事前解析ステータスを更新する。status は "analyzing" | "ready" | "idle"。
// "idle" は Map から削除 (= 未解析表示)。warm 成功 (fetchSceneBundleV2) と
// runPrerenderAll の両方から呼ばれる (= 冪等)。
export function setCutPrerenderStatus(cutId, status) {
  if (!cutId) return;
  const map = state.cutPrerenderStatus;
  if (!(map instanceof Map)) return;
  const prev = map.get(cutId);
  if (status === "idle") {
    if (!map.has(cutId)) return;
    map.delete(cutId);
  } else {
    if (prev === status) return;
    map.set(cutId, status);
  }
  _scheduleStripRedraw();
}

export function clearAllPrerenderStatus() {
  const map = state.cutPrerenderStatus;
  if (map instanceof Map && map.size > 0) {
    map.clear();
    _scheduleStripRedraw();
  }
}

// 全カットを順に warm する。順次 (await 直列) にして「解析中(赤)」が 1 カットずつ
// 進むようにし、サーバ側の排他リソース (GIL + threadpool) も詰まらせない。最初の
// カットで音源全長解析が走り、同一音源の後続カットは行スライスで即返る。
//
// onProgress({ done, total, running, cancelled }) を各段で呼ぶ (ボタンの進捗表示用)。
export async function runPrerenderAll({ onProgress } = {}) {
  if (_running) return;
  if (typeof _warmCut !== "function") return;
  const cuts = (state.scenario?.cuts || []).filter((c) => c && c.id);
  const total = cuts.length;
  if (total === 0) {
    if (onProgress) onProgress({ done: 0, total: 0, running: false, cancelled: false });
    return;
  }
  _running = true;
  _cancelRequested = false;
  let done = 0;
  if (onProgress) onProgress({ done, total, running: true, cancelled: false });
  try {
    for (const cut of cuts) {
      if (_cancelRequested) break;
      setCutPrerenderStatus(cut.id, "analyzing");
      try {
        await _warmCut(cut);
        setCutPrerenderStatus(cut.id, "ready");
      } catch (_) {
        // warm 失敗 (fetch エラー等) は idle に戻す。次回再実行で再試行。
        setCutPrerenderStatus(cut.id, "idle");
      }
      done += 1;
      if (onProgress) onProgress({ done, total, running: true, cancelled: false });
    }
  } finally {
    const cancelled = _cancelRequested;
    _running = false;
    _cancelRequested = false;
    if (onProgress) onProgress({ done, total, running: false, cancelled });
  }
}
