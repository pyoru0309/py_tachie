// =============================================================================
// scene-ops.js
//
// シーンの区切り操作。dev_docs/plans/multi-scene.md §3.4 / §3.5。
//
// シーンは「連続したカットの並び」であり、境界は必ずカット境界と一致する。
// よって操作は「伸ばす / 縮める」ではなく **「区切りを打つ / 消す / 動かす」**
// として提示する。人間の言葉に近く、迷いが出ない。
//
//   splitSceneAtCut(cutId)        … このカットから新しいシーンを始める
//   mergeSceneWithPrevious(id)    … 前のシーンに結合する (= 区切りを消す)
//   moveSceneBoundary(i, delta)   … i 番目の区切りをカット単位で動かす
//
// タイムラインアイテム (テロップ / 効果音 / 動画レイヤー) はシーン境界をまたいで
// 置ける (2026-09-28 に §3.5 の「またげない」を撤回)。所属は開始位置のシーンで、
// 境界を動かしてもアイテムの長さは変えない。描画は toDiskScenario の
// carryStraddling が張り出し先のシーンへ持ち越す。
// =============================================================================
import { state } from "./state.js";
import { showToast } from "./toast.js";
import { recordHistory } from "./history.js";
import {
  TIMELINE_ITEM_KINDS,
  sceneSpans,
  recalcCutStartSec,
  assignSceneMembership,
} from "./scenario.js";
import { PROJECT_FPS } from "./timecode.js";

let deps = {
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  drawTimeline: () => {},
  renderCutList: () => {},
};

export function bindSceneOps(injectedDeps = {}) {
  deps = { ...deps, ...injectedDeps };
}

function scenes() {
  return Array.isArray(state.scenario?.scenes) ? state.scenario.scenes : [];
}

function cuts() {
  return Array.isArray(state.scenario?.cuts) ? state.scenario.cuts : [];
}

// 各シーンの「先頭カット index」。空シーンは -1。
function sceneFirstCutIndices() {
  return sceneSpans(state.scenario).map((span) => span.firstCutIndex);
}

// 先頭カット index の並びから、全カットの sceneId を振り直す。
function stampSceneIds(firstIndices) {
  const list = cuts();
  const sceneList = scenes();
  for (let s = 0; s < firstIndices.length; s += 1) {
    const from = firstIndices[s];
    if (from < 0) continue;
    const to = s + 1 < firstIndices.length ? firstIndices[s + 1] : list.length;
    for (let k = from; k < to && k < list.length; k += 1) {
      if (list[k]) list[k].sceneId = sceneList[s].id;
    }
  }
}

// 構造変更の後始末 (所属正規化 → 保存 → 再描画) をまとめる。
function commitSceneChange(message) {
  recalcCutStartSec();
  assignSceneMembership(state.scenario);
  deps.scheduleScenarioSave();
  recordHistory();
  deps.renderCutList();
  deps.drawTimeline();
  deps.renderPreview().catch(() => {});
  if (message) showToast(message);
}

function nextSceneId() {
  const used = new Set(scenes().map((s) => s.id));
  for (let i = 1; i < 1000; i += 1) {
    const id = `scene_${String(i).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
  return `scene_${Date.now().toString(36)}`;
}

// 新しいシーンの既定タイトル。挿入先の位置に対応する「シーンN」を第一候補にし、
// 既に使われていれば空いている番号に送る。前から順に区切っていく通常の流れなら
// シーン1 / シーン2 / シーン3 … と素直に並ぶ。
// (旧実装の `${元タイトル} の続き` は分割を繰り返すと同名が並んで見分けが
//  つかなくなり、結合の確認文も意味を成さなくなる)
function nextSceneTitle(insertIndex) {
  const used = new Set(scenes().map((s) => String(s.title || "")));
  const preferred = `シーン${insertIndex + 1}`;
  if (!used.has(preferred)) return preferred;
  for (let i = 1; i < 1000; i += 1) {
    const title = `シーン${i}`;
    if (!used.has(title)) return title;
  }
  return `シーン${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// (B) カットに対する操作 — 主操作
// ---------------------------------------------------------------------------

// このカットから新しいシーンを始める (= カットの手前に区切りを打つ)。
// 新シーンは元シーンのベッド設定を引き継ぐので、見た目は変わらない。
export function splitSceneAtCut(cutId) {
  const list = cuts();
  const index = list.findIndex((c) => c && c.id === cutId);
  if (index < 0) {
    showToast("対象のカットが見つかりません", "error");
    return false;
  }
  const sceneList = scenes();
  const ownerIdx = sceneList.findIndex((s) => s.id === list[index].sceneId);
  if (ownerIdx < 0) return false;
  const spans = sceneSpans(state.scenario);
  if (spans[ownerIdx].firstCutIndex === index) {
    showToast("このカットは既にシーンの先頭です");
    return false;
  }
  const source = sceneList[ownerIdx];
  // ベッド設定を引き継いだ新シーンを直後に挿入する。
  const created = {
    ...JSON.parse(JSON.stringify(source)),
    id: nextSceneId(),
    title: nextSceneTitle(ownerIdx + 1),
    cuts: [], telops: [], soundEffects: [], videoLayers: [],
  };
  sceneList.splice(ownerIdx + 1, 0, created);
  // index 以降で「元シーンに属していたカット」を新シーンへ移す。
  for (let k = index; k < list.length; k += 1) {
    if (list[k]?.sceneId === source.id) list[k].sceneId = created.id;
  }
  state.selectedSceneId = created.id;
  commitSceneChange(`「${created.title}」を作りました`);
  return true;
}

// 2 つの隣り合うシーンを 1 つにする (= 間の区切りを消す)。
//
// keeperIndex 側の設定 (BGM / 背景動画 / ビジュアライザ / 体の揺れ / トランジション)
// が残り、absorbedIndex 側は捨てられる。カットとタイムラインアイテムは全部残る。
function mergeAdjacentScenes(keeperIndex, absorbedIndex) {
  const sceneList = scenes();
  const keeper = sceneList[keeperIndex];
  const absorbed = sceneList[absorbedIndex];
  if (!keeper || !absorbed) return false;
  const lost = [];
  if ((absorbed.bgmTracks || []).length > 0) lost.push("BGM");
  if (absorbed.videoTrack) lost.push("背景動画");
  if (absorbed.visualizer?.enabled) lost.push("ビジュアライザ");
  if (absorbed.breath?.amplitudePx > 0 || absorbed.bpmBob?.amplitudePx > 0) lost.push("体の揺れ");
  if (absorbed.transition?.type && absorbed.transition.type !== "none") lost.push("シーン入りトランジション");
  if (absorbed.background) lost.push("背景");
  const lostLine = lost.length > 0
    ? `\n\n「${absorbed.title}」側の ${lost.join(" / ")} の設定は失われます。`
    : "";
  const ok = window.confirm(
    `「${keeper.title}」と「${absorbed.title}」を 1 つのシーンにまとめます。\n`
    + `カット・テロップ・効果音・動画レイヤーはすべて残り、`
    + `「${keeper.title}」の設定が引き継がれます。${lostLine}`,
  );
  if (!ok) return false;
  for (const cut of cuts()) {
    if (cut?.sceneId === absorbed.id) cut.sceneId = keeper.id;
  }
  for (const kind of TIMELINE_ITEM_KINDS) {
    for (const item of state.scenario?.[kind] || []) {
      if (item?.sceneId === absorbed.id) item.sceneId = keeper.id;
    }
  }
  sceneList.splice(absorbedIndex, 1);
  state.selectedSceneId = keeper.id;
  commitSceneChange(`「${absorbed.title}」を「${keeper.title}」に結合しました`);
  return true;
}

// このシーンを前のシーンへ結合する (= 手前の区切りを消す)。前のシーンの設定が残る。
export function mergeSceneWithPrevious(sceneId) {
  const sceneList = scenes();
  const index = sceneList.findIndex((s) => s.id === sceneId);
  if (index <= 0) {
    showToast("先頭のシーンには前のシーンがありません");
    return false;
  }
  return mergeAdjacentScenes(index - 1, index);
}

// このシーンに次のシーンを結合する (= 後ろの区切りを消す)。このシーンの設定が残る。
export function mergeSceneWithNext(sceneId) {
  const sceneList = scenes();
  const index = sceneList.findIndex((s) => s.id === sceneId);
  if (index < 0 || index >= sceneList.length - 1) {
    showToast("最後のシーンには次のシーンがありません");
    return false;
  }
  return mergeAdjacentScenes(index, index + 1);
}

// ---------------------------------------------------------------------------
// (A)(C) 境界をカット単位で動かす
// ---------------------------------------------------------------------------

// boundaryIndex 番目の区切り (シーン boundaryIndex と boundaryIndex+1 の間) を
// deltaCuts カット分だけ動かす。正 = 右 (次シーンのカットを前シーンへ取り込む)。
// どちらのシーンも 0 カットにならない範囲でクランプする。
export function moveSceneBoundary(boundaryIndex, deltaCuts) {
  const firstIndices = sceneFirstCutIndices();
  const total = cuts().length;
  const b = boundaryIndex + 1; // 動かすのは「次シーンの先頭カット index」
  if (b <= 0 || b >= firstIndices.length) return false;
  const lower = (firstIndices[b - 1] < 0 ? 0 : firstIndices[b - 1]) + 1;   // 前シーンに最低 1 カット
  const upper = (b + 1 < firstIndices.length ? firstIndices[b + 1] : total) - 1; // 次シーンに最低 1 カット
  const target = Math.max(lower, Math.min(upper, firstIndices[b] + Math.round(deltaCuts)));
  return setSceneBoundary(boundaryIndex, target);
}

// boundaryIndex 番目の区切りを「次シーンの先頭カット index = firstCutIndex」に据える。
export function setSceneBoundary(boundaryIndex, firstCutIndex) {
  const firstIndices = sceneFirstCutIndices();
  const b = boundaryIndex + 1;
  if (b <= 0 || b >= firstIndices.length) return false;
  const total = cuts().length;
  const lower = (firstIndices[b - 1] < 0 ? 0 : firstIndices[b - 1]) + 1;
  const upper = (b + 1 < firstIndices.length ? firstIndices[b + 1] : total) - 1;
  const target = Math.max(lower, Math.min(upper, Math.round(firstCutIndex)));
  if (target === firstIndices[b]) return false;
  firstIndices[b] = target;
  stampSceneIds(firstIndices);
  commitSceneChange(null);
  return true;
}

// タイムライン上の絶対フレームに最も近いカット境界の「カット index」を返す。
export function nearestCutBoundaryIndex(frame) {
  const list = cuts();
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i += 1) {
    const start = Math.max(0, Math.round(Number(list[i]?.startFrame) || 0));
    const dist = Math.abs(start - frame);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

// 選択中のカットに対して「ここから新しいシーンを始める」が可能か。
export function canSplitSceneAtCut(cutId) {
  const list = cuts();
  const index = list.findIndex((c) => c && c.id === cutId);
  if (index <= 0) return false;
  const spans = sceneSpans(state.scenario);
  const ownerIdx = scenes().findIndex((s) => s.id === list[index].sceneId);
  return ownerIdx >= 0 && spans[ownerIdx].firstCutIndex !== index;
}

// 選択中のカットが属するシーンを「前のシーンに結合」できるか。
export function canMergeSceneOfCut(cutId) {
  const cut = cuts().find((c) => c && c.id === cutId);
  if (!cut) return false;
  return scenes().findIndex((s) => s.id === cut.sceneId) > 0;
}

export { PROJECT_FPS };
