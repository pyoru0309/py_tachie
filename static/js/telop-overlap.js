// ===========================================================================
// 同一レーン内のテロップ重なり検出と自動解消
//
// タイムライン上の同じレーンに置いたテロップが数フレームだけ重なる事故
// (スナップが効かなかった / ドラッグが僅かにずれた) を検出し、ワンクリックで
// 直せるようにする。DOM 非依存 (tools/check_telop_overlap.mjs で検証する)。
//
// 解消ルール (レーンごとに開始フレーム昇順で掃引):
//   - 後ろのテロップが前のテロップより「後に始まり、後に終わる」
//     → 前のテロップの終わりを後ろの開始位置まで詰める (開始位置は動かさない。
//       テロップの頭は音声に合わせてあることが多いため)
//   - 同じ開始位置 / 前のテロップに丸ごと含まれる
//     → 詰めると片方が消えてしまうので、後ろのテロップを重ならない別レーンへ
//       移す (空きが無ければレーンを 1 つ増やす)
// ===========================================================================

import { telopStartFrame, telopDurationFrame, itemLane } from "./scenario.js";

function endFrame(telop) {
  return telopStartFrame(telop) + telopDurationFrame(telop);
}

function sortByStart(list) {
  return list.slice().sort((a, b) => telopStartFrame(a) - telopStartFrame(b)
    || endFrame(b) - endFrame(a));
}

function groupByLane(telops) {
  const lanes = new Map();
  for (const t of telops) {
    if (!t) continue;
    const lane = itemLane(t);
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(t);
  }
  return lanes;
}

// 重なりの一覧。{ lane, a, b, startFrame, endFrame } (a が先に始まる側)。
// 1 レーン内の全ペアを返す (3 本重なりなら 3 組)。
export function findTelopLaneOverlaps(telops) {
  const out = [];
  if (!Array.isArray(telops)) return out;
  for (const [lane, list] of groupByLane(telops)) {
    const sorted = sortByStart(list);
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i];
      const aEnd = endFrame(a);
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j];
        const bStart = telopStartFrame(b);
        if (bStart >= aEnd) break;
        out.push({
          lane,
          a,
          b,
          startFrame: bStart,
          endFrame: Math.min(aEnd, endFrame(b)),
        });
      }
    }
  }
  return out;
}

// 重なりに関わっているテロップ id の Set。
export function overlappingTelopIds(overlaps) {
  const ids = new Set();
  for (const o of overlaps || []) {
    if (o.a?.id != null) ids.add(o.a.id);
    if (o.b?.id != null) ids.add(o.b.id);
  }
  return ids;
}

function fitsInLane(telop, others) {
  const s = telopStartFrame(telop);
  const e = endFrame(telop);
  return others.every((o) => o === telop || endFrame(o) <= s || telopStartFrame(o) >= e);
}

// telops を直接書き換えて重なりを解消する。
// 戻り値: { trimmed, moved, laneCount } (laneCount は解消後に必要なレーン数)。
export function resolveTelopLaneOverlaps(telops, laneCount = 1) {
  const result = { trimmed: 0, moved: 0, laneCount: Math.max(1, Math.round(Number(laneCount) || 1)) };
  if (!Array.isArray(telops) || telops.length < 2) return result;
  const maxExisting = telops.reduce((m, t) => Math.max(m, t ? itemLane(t) : 0), 0);
  result.laneCount = Math.max(result.laneCount, maxExisting + 1);
  const itemsInLane = (lane) => telops.filter((t) => t && itemLane(t) === lane);

  for (let lane = 0; lane < result.laneCount; lane += 1) {
    const sorted = sortByStart(itemsInLane(lane));
    let last = null;
    for (const cur of sorted) {
      if (!last || telopStartFrame(cur) >= endFrame(last)) {
        last = cur;
        continue;
      }
      const lastStart = telopStartFrame(last);
      if (telopStartFrame(cur) > lastStart && endFrame(cur) > endFrame(last)) {
        last.durationFrame = telopStartFrame(cur) - lastStart;
        result.trimmed += 1;
        last = cur;
        continue;
      }
      // 詰められない: 重ならないレーンへ逃がす (現在レーン以外で最も上)。
      let target = -1;
      for (let l = 0; l < result.laneCount; l += 1) {
        if (l === lane) continue;
        if (fitsInLane(cur, itemsInLane(l))) { target = l; break; }
      }
      if (target < 0) {
        target = result.laneCount;
        result.laneCount += 1;
      }
      cur.lane = target;
      result.moved += 1;
    }
  }
  return result;
}
