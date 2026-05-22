// =============================================================================
// thumbnail.js
//
// プロジェクト一覧トップで表示するサムネイルを、編集画面の v2 GL canvas から
// 1 frame だけ静止画化してサーバへ送る。
//
// 方針:
// - サムネ生成は v2 GL canvas を toBlob('image/png') する経路で統一する。
//   これは「PNG出力」(/api/projects/{id}/render-png) と全く同じ
//   captureSceneSnapshot パイプラインで、ビジュアライザ / videoTrack /
//   dialogue / telop / 色フィルタ / blur / 再生ヘッド上の motion・lipSync・blink
//   まで含めた「再生ヘッドの絵そのまま」が反映される。
// - 形式は PNG 固定 (旧実装の webp 優先は撤去)。トップページ自体では three.js を
//   起動せず、サーバが保存済み thumbnail.png を /project-cache/<id>/thumbnail.png
//   として配信する。
// - 編集中の任意タイミングで GL canvas を toBlob して POST するだけの薄い層。
// - dirty フラグで「最後の更新以降に scenario が変わった可能性があるか」を
//   管理し、変更が無いタイミングでは投げない。
//
// 呼び出される場所:
// - scenario-actions.saveScenario (silent / non-silent 両方で markDirty)
// - playback.stopPreviewPlayback (再生→停止のタイミングで upload)
// - 明示保存 (non-silent) 後の upload
// - playback.renderPreview の v2 経路 (saveOutput=true による PNG 出力 / 静止
//   render の captureThumbnail オプション)
// - beforeunload で sendBeacon
// =============================================================================

import { state } from "./state.js";

let dirty = false;
let inFlight = false;

export function markThumbnailDirty() {
  dirty = true;
}

// v2 module は loadCut V2 で初期化された後だけ意味を持つので、初回 active 化前は
// 静かに no-op で返す。
async function loadV2Module() {
  try {
    return await import("./renderer/index.js");
  } catch {
    return null;
  }
}

// サムネを取って POST する。dirty=true で v2 active scene が存在するときだけ実発火。
// force=true なら dirty を無視して送る (明示保存等)。
//
// 重要: projectId は関数冒頭で state.activeProjectId を bind して固定する。
// 非同期処理中に state.activeProjectId が変わると、旧プロジェクトの GL canvas を
// 取って新プロジェクトに POST してしまう race が起きるため。
// 失敗 / skip 時のログは「なぜ撮らなかった/送れなかったか」を残せるよう、
// reason 文字列付きの console.debug にする。本番でうるさくならない程度の粒度で
// 細かく原因が分かるようにしておくと、サムネが上がってこない時に追跡しやすい。
function logSkip(reason, extra) {
  if (extra !== undefined) {
    console.debug(`[thumbnail] skip: ${reason}`, extra);
  } else {
    console.debug(`[thumbnail] skip: ${reason}`);
  }
}

/**
 * v2 GL canvas からサムネ PNG を作って /api/projects/{id}/thumbnail に POST する。
 *
 * @param {Object}  opts
 * @param {boolean} [opts.force=false]  dirty 判定を無視して撮る (= プロジェクト
 *   離脱直前のように、再生ヘッド上の絵を確実にサムネ化したいケース)。
 * @param {Blob}    [opts.blob=null]    既にあるサムネ用 PNG Blob を再利用 (= PNG出力
 *   ボタンで render-png に POST した直後に同じ blob でサムネも更新するケース)。
 *   Blob が指定されると captureSceneSnapshot を呼ばないので無駄な toBlob を省ける。
 * @returns {Promise<{ ok: boolean, thumbnail?: string|null }>}
 *   ok=true のとき thumbnail に新しい URL (`/project-cache/{id}/thumbnail.png?v=...`)
 *   を入れて返す。state.projects 上の該当プロジェクトの `thumbnail` も同じ URL に
 *   置き換えるので、呼び出し側は loadProjects せずに renderProjectDashboard を回すだけで
 *   一覧カードが新しい絵になる。
 */
export async function captureAndUploadThumbnail({ force = false, blob = null } = {}) {
  if (inFlight) { logSkip("inFlight"); return { ok: false }; }
  if (!force && !dirty) { logSkip("not dirty (force=false)"); return { ok: false }; }
  const projectId = state.activeProjectId;
  if (!projectId) { logSkip("no activeProjectId"); return { ok: false }; }

  // 既存 blob があればそれを使う。無ければここで GL canvas から toBlob する。
  let pngBlob = blob;
  if (!pngBlob) {
    const v2 = await loadV2Module();
    if (!v2) { logSkip("renderer module load failed"); return { ok: false }; }
    if (!v2.isRendererReady?.()) { logSkip("renderer not ready"); return { ok: false }; }
    if (!v2.getActiveScene?.()) { logSkip("no active scene"); return { ok: false }; }
    if (state.activeProjectId !== projectId) { logSkip("projectId changed before capture"); return { ok: false }; }
    pngBlob = await v2.captureSceneSnapshot({ format: "image/png" });
  }
  if (!pngBlob) { logSkip("toBlob returned null (canvas empty?)"); return { ok: false }; }
  if (pngBlob.size === 0) { logSkip("toBlob returned empty blob"); return { ok: false }; }
  if (state.activeProjectId !== projectId) { logSkip("projectId changed after toBlob"); return { ok: false }; }

  inFlight = true;
  try {
    const url = `/api/projects/${encodeURIComponent(projectId)}/thumbnail`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: pngBlob,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[thumbnail] upload failed: HTTP ${res.status}`, body);
      return { ok: false };
    }
    const result = await res.json().catch(() => ({}));
    dirty = false;
    // state.projects 上の URL を新しいものに差し替える (loadProjects せずに
    // renderProjectDashboard だけで一覧カードが更新できるように)。
    if (result.thumbnail && Array.isArray(state.projects)) {
      const proj = state.projects.find((p) => p && p.id === projectId);
      if (proj) proj.thumbnail = result.thumbnail;
    }
    return { ok: true, thumbnail: result.thumbnail || null };
  } catch (err) {
    console.warn("[thumbnail] upload threw:", err);
    return { ok: false };
  } finally {
    inFlight = false;
  }
}

// ページ離脱時に dirty なサムネを投げる。fetch は cancel される可能性があるので
// sendBeacon を優先 (Blob を直接送れる)。形式は PNG 固定。
export function flushThumbnailOnUnload() {
  if (!dirty) return;
  const projectId = state.activeProjectId;
  if (!projectId) return;
  // unload 直前は dynamic import が間に合わない可能性がある。すでに module が
  // 読み込まれていれば cache から同期取得できる (import() の Promise が解決済)
  // が、安全側で「render module が既に load 済かつ active scene があるとき」
  // のみ実行する。
  // ※ ここでは import.meta から確認する手段が無いので、window.__spliteRendererV2
  //   のような hook も置かず、未ロード時は静かに諦める。
  // 簡易実装: 同期 fetch は使えないので、import.meta + sendBeacon の組合せで
  // 「ロード済」を間接的に確認 → 失敗時は無視。
  import("./renderer/index.js").then((v2) => {
    if (!v2.isRendererReady?.() || !v2.getActiveScene?.()) return;
    v2.captureSceneSnapshot({ format: "image/png" }).then((blob) => {
      if (!blob) return;
      // projectId は冒頭で bind 済み。途中の async でも変えない。
      // sendBeacon は Blob を渡すと自動で Content-Type を blob.type に設定する。
      // toBlob('image/png') の戻り値は type='image/png' なのでサーバ側の
      // image/png 検証も通る。
      const url = `/api/projects/${encodeURIComponent(projectId)}/thumbnail`;
      try {
        navigator.sendBeacon?.(url, blob);
      } catch {
        // beacon 失敗時は何も出来ない (unload 中)。
      }
    });
  });
}
