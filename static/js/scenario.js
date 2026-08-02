// ===========================================================================
// シナリオ構造ユーティリティ (state.scenario の正規化と派生計算)
// saveScenario など外部依存の多い API 呼び出しは当面 app.js 側に残す。
// ===========================================================================

import { state } from "./state.js";
import { PROJECT_FPS } from "./timecode.js";

// 共通アクセサ: cut/telop の開始位置/長さを「秒」「フレーム」で取得する。
// 永続スキーマは startFrame / durationFrame の整数 (project fps = 24 基準)。

export function cutStartFrame(cut) {
  return Math.max(0, Math.round(Number(cut?.startFrame) || 0));
}

export function cutDurationFrame(cut) {
  return Math.max(1, Math.round(Number(cut?.durationFrame) || 0));
}

export function cutStartSec(cut) {
  return cutStartFrame(cut) / PROJECT_FPS;
}

export function cutDurationSec(cut) {
  return cutDurationFrame(cut) / PROJECT_FPS;
}

export function telopStartFrame(telop) {
  return Math.max(0, Math.round(Number(telop?.startFrame) || 0));
}

export function telopDurationFrame(telop) {
  return Math.max(1, Math.round(Number(telop?.durationFrame) || 0));
}

export function telopStartSec(telop) {
  return telopStartFrame(telop) / PROJECT_FPS;
}

export function telopDurationSec(telop) {
  return telopDurationFrame(telop) / PROJECT_FPS;
}

export function soundEffectStartFrame(se) {
  return Math.max(0, Math.round(Number(se?.startFrame) || 0));
}

export function soundEffectStartSec(se) {
  return soundEffectStartFrame(se) / PROJECT_FPS;
}

// se.durationFrame は「終了時間 = startFrame + durationFrame」の期間 (フレーム)。
// 0 / 未指定 = 「素材長そのまま」を意味する。assetDurationSec を渡せばそれで補完する。
export function soundEffectDurationFrame(se, assetDurationSec = 0) {
  const raw = Math.max(0, Math.round(Number(se?.durationFrame) || 0));
  if (raw > 0) return raw;
  const asset = Math.max(0, Number(assetDurationSec) || 0);
  if (asset > 0) return Math.max(1, Math.round(asset * PROJECT_FPS));
  return 0;
}

export function soundEffectDurationSec(se, assetDurationSec = 0) {
  return soundEffectDurationFrame(se, assetDurationSec) / PROJECT_FPS;
}

// 動画レイヤー: startFrame + 派生 durationFrame (= (trimEndSec - trimStartSec) * fps)。
// trimEndSec が null の場合は呼び出し側で videoDurationSec を渡して解決する。
export function videoLayerStartFrame(vl) {
  return Math.max(0, Math.round(Number(vl?.startFrame) || 0));
}

export function videoLayerStartSec(vl) {
  return videoLayerStartFrame(vl) / PROJECT_FPS;
}

export function videoLayerTrimStartSec(vl) {
  return Math.max(0, Number(vl?.trimStartSec) || 0);
}

// videoDurationSec は /api/video-duration から解決した値を渡す。
// trimEndSec が null/未指定なら videoDurationSec をそのまま終端とみなす。
export function videoLayerTrimEndSec(vl, videoDurationSec) {
  const dur = Number(videoDurationSec);
  const fallback = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const rawTrimEnd = vl?.trimEndSec != null ? Number(vl.trimEndSec) : fallback;
  const trimStart = videoLayerTrimStartSec(vl);
  if (!Number.isFinite(rawTrimEnd)) return Math.max(trimStart, fallback);
  return Math.min(fallback || rawTrimEnd, Math.max(trimStart, rawTrimEnd));
}

export function videoLayerDurationSec(vl, videoDurationSec) {
  return Math.max(0, videoLayerTrimEndSec(vl, videoDurationSec) - videoLayerTrimStartSec(vl));
}

export function videoLayerDurationFrame(vl, videoDurationSec) {
  return Math.max(0, Math.round(videoLayerDurationSec(vl, videoDurationSec) * PROJECT_FPS));
}

// R2: アイテム (telop/se/vl) のレーン番号 (0 起点)。
export function itemLane(item) {
  return Math.max(0, Math.round(Number(item?.lane) || 0));
}

// R2: 種別 ("telop" | "soundEffect" | "videoLayer") のレーン数 (最低 1)。
export function sceneLaneCount(scene, kind) {
  const lc = scene && typeof scene === "object" ? scene.laneCounts : null;
  const n = lc && typeof lc === "object" ? Number(lc[kind]) : 1;
  return Math.max(1, Math.round(Number.isFinite(n) ? n : 1));
}

// R10: カット入りトランジション設定の取得 (既定 none)。
export function cutTransition(cut) {
  const t = cut && typeof cut === "object" ? cut.transition : null;
  if (!t || typeof t !== "object") return { type: "none", durationFrame: 0 };
  const type = String(t.type || "none");
  const durationFrame = Math.max(0, Math.round(Number(t.durationFrame) || 0));
  const out = { type, durationFrame };
  if (type === "wipe") {
    const d = String(t.wipeDirection || "right").toLowerCase();
    out.wipeDirection = ["right", "left", "up", "down"].includes(d) ? d : "right";
  }
  return out;
}

export function attachScenarioCutsAlias(scenario) {
  // v4 シナリオは scenes[0].cuts が正、state.scenario.cuts はその同一参照として扱う。
  // 旧フォーマット（cuts 直下）を受け取った場合も scenes に巻き直す。
  if (!scenario || typeof scenario !== "object") {
    return { version: 4, title: "scenario", scenes: [{ id: "scene_001", title: "シーン1", cuts: [] }], cuts: [] };
  }
  if (!Array.isArray(scenario.scenes) || scenario.scenes.length === 0) {
    const legacyCuts = Array.isArray(scenario.cuts) ? scenario.cuts : [];
    scenario.scenes = [{
      id: "scene_001",
      title: "シーン1",
      background: "",
      videoTrack: null,
      bgmTracks: [],
      soundEffects: [],
      videoLayers: [],
      bpm: null,
      cuts: legacyCuts,
      telops: [],
    }];
  }
  const scene = scenario.scenes[0];
  if (!Array.isArray(scene.cuts)) scene.cuts = [];
  if (!Array.isArray(scene.soundEffects)) scene.soundEffects = [];
  if (!Array.isArray(scene.videoLayers)) scene.videoLayers = [];
  if (!Array.isArray(scene.telops)) scene.telops = [];
  // R2: 種別ごとのレーン数。サーバ正規化で必ず入るが、クライアント生成/旧データ向けに既定。
  if (!scene.laneCounts || typeof scene.laneCounts !== "object") {
    scene.laneCounts = { telop: 1, soundEffect: 1, videoLayer: 1 };
  }
  scenario.cuts = scene.cuts;
  if (!scenario.version) scenario.version = 4;
  return scenario;
}

export function recalcCutStartSec() {
  // カット並びから startFrame を整数で連番計算する。
  // 各カットの「旧 startFrame → 新 startFrame」差分を計算し、linkedCutId で
  // 紐付いているテロップ / 効果音 / 動画レイヤーを delta だけ平行移動する。
  // (= 場面転換テロップなどがカット移動・複製・並び替えに自動追従する仕組み)
  const cuts = state.scenario?.cuts || [];
  const oldStartByCutId = new Map();
  for (const cut of cuts) {
    if (!cut || !cut.id) continue;
    oldStartByCutId.set(cut.id, Math.max(0, Math.round(Number(cut.startFrame) || 0)));
  }
  let cursor = 0;
  for (const cut of cuts) {
    const dur = cutDurationFrame(cut);
    cut.startFrame = cursor;
    cursor = cut.startFrame + dur;
  }
  // delta=0 の場合はスキップ。1 frame でもズレたカットだけリンクアイテムを動かす。
  const deltaByCutId = new Map();
  for (const cut of cuts) {
    if (!cut || !cut.id) continue;
    const oldStart = oldStartByCutId.get(cut.id);
    if (oldStart == null) continue; // 新規追加カット (linked items 無し前提)
    const delta = cut.startFrame - oldStart;
    if (delta !== 0) deltaByCutId.set(cut.id, delta);
  }
  if (deltaByCutId.size === 0) return;
  const scene = state.scenario?.scenes?.[0];
  if (!scene) return;
  for (const list of [scene.telops, scene.soundEffects, scene.videoLayers]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const linked = item?.linkedCutId;
      if (!linked) continue;
      const delta = deltaByCutId.get(linked);
      if (!delta) continue;
      item.startFrame = Math.max(0, (Number(item.startFrame) || 0) + delta);
    }
  }
}
