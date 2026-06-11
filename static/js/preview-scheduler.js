// =============================================================================
// PreviewScheduler — プレビュー用 scene-bundle prefetch の薄い司令塔 (2026-06-11)
//
// 従来 playback.js に分散していた warmup / lookahead / prefetch キャッシュ /
// 破棄を、優先度 + 同時実行数 + 予算待ちの一元管理に集約する。
//
// 設計:
//   - job は cut.id で重複排除。同じカットへの request は既存 Promise を共有し、
//     より高い優先度が来たら昇格だけ行う。
//   - 優先度: CURRENT(0) > NEXT(1) > LOOKAHEAD(2)。
//       CURRENT  : 再生開始 / カット切替に必須。同時実行枠を無視して即時開始。
//       NEXT     : 次カット。枠内で先行着手し、warmup では短い予算だけ待つ。
//       LOOKAHEAD: 完全バックグラウンド。枠が空いたら順に流す。
//   - 同時実行枠 (maxConcurrent): 旧実装は ensureLookahead が範囲内の全カットを
//     同時 fire していたため、重カットが並ぶと現カットの処理とサーバ側で競合した
//     (sync route の threadpool + GIL)。枠で直列度を上げ、優先度順に流す。
//   - clear(): 停止 / 再生開始 / プロジェクト切替時の一括破棄。queued の job は
//     開始せず null 解決、running の結果は捨てられる (= 旧実装と同じ意味論)。
//   - fetch 失敗は job を map から外して null 解決 (= 次回 request で再試行)。
//     旧 prefetchSceneBundleV2 の catch → cache 自己削除と同じ。
//
// スコープ外 (意図的に持たない):
//   - renderPreviewV2 の対話的 fetch (カット選択)。AbortController による
//     「後勝ち」セマンティクスが必要で、共有 Promise の scheduler とは相性が
//     悪いため従来通り直接 fetch する。
//   - SceneInstance prefetch (GPU 直列 queue) と VideoLayer 窓管理。renderer の
//     ライフサイクルに密結合なので playback.js に残す。scheduler は bundle
//     Promise の共有 (peek) だけ提供する。
// =============================================================================

export const PRIORITY = Object.freeze({
  CURRENT: 0,
  NEXT: 1,
  LOOKAHEAD: 2,
});

export function createPreviewScheduler({ fetchBundle, prefetchAudio = null, maxConcurrent = 2 }) {
  const jobs = new Map(); // cutId -> job
  let inFlight = 0;
  let seq = 0;

  function _startJob(job) {
    if (job.status !== "queued") return;
    job.status = "running";
    inFlight += 1;
    Promise.resolve()
      .then(() => fetchBundle(job.cut))
      .then(
        (data) => {
          job.settle(data);
        },
        (err) => {
          console.warn("[preview-scheduler] bundle prefetch failed", err);
          // 失敗 job はキャッシュから外す → 次回 request / consume で再試行。
          if (jobs.get(job.cut.id) === job) jobs.delete(job.cut.id);
          job.settle(null);
        },
      )
      .finally(() => {
        inFlight -= 1;
        job.status = "done";
        _pump();
      });
  }

  // queued の中から最高優先度 (同率は先着) を選んで枠が空いている限り起動する。
  function _pump() {
    while (inFlight < maxConcurrent) {
      let best = null;
      for (const job of jobs.values()) {
        if (job.status !== "queued") continue;
        if (!best || job.priority < best.priority
            || (job.priority === best.priority && job.seq < best.seq)) {
          best = job;
        }
      }
      if (!best) return;
      _startJob(best);
    }
  }

  function request(cut, priority = PRIORITY.LOOKAHEAD) {
    if (!cut?.id) return null;
    const existing = jobs.get(cut.id);
    if (existing) {
      if (priority < existing.priority) {
        existing.priority = priority;
        // CURRENT 昇格は枠を無視して即時開始 (再生に必須のため)。
        if (existing.status === "queued" && priority === PRIORITY.CURRENT) {
          _startJob(existing);
        } else {
          _pump();
        }
      }
      return existing.promise;
    }
    const job = { cut, priority, status: "queued", seq: seq++ };
    job.promise = new Promise((resolve) => {
      job.settle = resolve;
    });
    jobs.set(cut.id, job);
    if (prefetchAudio) {
      try { prefetchAudio(cut); } catch (_) { /* ignore */ }
    }
    if (priority === PRIORITY.CURRENT) {
      _startJob(job);
    } else {
      _pump();
    }
    return job.promise;
  }

  // 所有権を移譲して取り出す (= 旧 consumeSceneBundlePrefetch)。
  // queued のまま consume されたら即時開始する (待たせると永遠に解決しない)。
  function consume(cut) {
    if (!cut?.id) return null;
    const job = jobs.get(cut.id);
    if (!job) return null;
    jobs.delete(cut.id);
    if (job.status === "queued") _startJob(job);
    return job.promise;
  }

  // 取り出さずに Promise を共有する (= SceneInstance prefetch 用)。
  function peek(cut) {
    if (!cut?.id) return null;
    return jobs.get(cut.id)?.promise || null;
  }

  // 再生開始時の warmup。現カット (startIndex) のみ完全 await し、
  // 後続 (warmupCount-1 件) は budgetMs だけ待って見切り発車する。
  async function warmup(cuts, startIndex, warmupCount, { budgetMs = 400, onProgress = null } = {}) {
    const endIndex = Math.min(cuts.length, startIndex + Math.max(1, warmupCount));
    let currentPromise = null;
    const nextPromises = [];
    for (let i = startIndex; i < endIndex; i += 1) {
      const cut = cuts[i];
      if (!cut?.id) continue;
      const promise = request(cut, i === startIndex ? PRIORITY.CURRENT : PRIORITY.NEXT);
      if (!promise) continue;
      if (i === startIndex) currentPromise = promise;
      else nextPromises.push(promise);
    }
    if (currentPromise) {
      if (onProgress) onProgress(0, 1);
      await currentPromise.catch(() => {});
      if (onProgress) onProgress(1, 1);
    }
    if (nextPromises.length > 0 && budgetMs > 0) {
      let timer = null;
      const budget = new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      });
      await Promise.race([Promise.allSettled(nextPromises), budget]);
      if (timer != null) clearTimeout(timer);
    }
  }

  // 再生中のスライディング先読み: [currentIndex+1, currentIndex+1+lookahead)。
  // 直後の 1 件は NEXT、それ以降は LOOKAHEAD として積む。
  function ensureLookahead(cuts, currentIndex, lookahead) {
    const start = currentIndex + 1;
    const end = Math.min(cuts.length, start + Math.max(0, lookahead));
    for (let i = start; i < end; i += 1) {
      const cut = cuts[i];
      if (!cut?.id) continue;
      request(cut, i === start ? PRIORITY.NEXT : PRIORITY.LOOKAHEAD);
    }
  }

  function clear() {
    const pending = [];
    for (const job of jobs.values()) {
      if (job.status === "queued") pending.push(job);
    }
    jobs.clear();
    // queued は開始せずに null 解決して待ち手 (warmup の budget 待ち等) を解放。
    // running は結果が捨てられるだけ (fetch 自体は完走、HTTP キャッシュは温まる)。
    for (const job of pending) {
      job.status = "done";
      job.settle(null);
    }
  }

  return {
    request,
    consume,
    peek,
    warmup,
    ensureLookahead,
    clear,
    get size() {
      return jobs.size;
    },
  };
}
