// ===========================================================================
// シナリオ構造ユーティリティ (state.scenario の正規化と派生計算)
// saveScenario など外部依存の多い API 呼び出しは当面 app.js 側に残す。
// ===========================================================================

import { state } from "./state.js";
import { PROJECT_FPS } from "./timecode.js";

// ユーザー通知。toast.js は elements.js (= DOM) を引くのでここでは直接 import
// せず、app.js から注入する (このモジュールを DOM 無しでテストできるように)。
let _notify = () => {};
export function bindScenarioNotifier(fn) {
  if (typeof fn === "function") _notify = fn;
}

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

// ===========================================================================
// ベッド設定 (SceneBed) の二層化 — プロジェクト通し / シーンごと
//
// background / videoTrack / bgmTracks / visualizer / breath+bpmBob / bpm を、
// scenario.projectSettings (プロジェクト通し) と scene (シーンごと) の
// どちらから取るかを scenario.bedScope が決める。既定は全部 "scene" なので、
// 既存プロジェクトの挙動は変わらない。
//
// 詳細は dev_docs/plans/multi-scene.md §1-2。サーバ側の同名ロジックは
// app/scenario.py: resolve_effective_scene / _normalize_bed_scope と対。
// ===========================================================================

// bedScope のキー → それが支配する SceneBed のフィールド。
export const BED_SCOPE_FIELDS = {
  bgm: ["bgmTracks"],
  videoTrack: ["videoTrack"],
  visualizer: ["visualizer"],
  bodySway: ["breath", "bpmBob"],
};
export const BED_SCOPE_KEYS = Object.keys(BED_SCOPE_FIELDS);

// 排他スコープを持たない「上書き型」フィールド。単一スカラーで二重適用が
// 起きないので、scene 側に値があればそれ、無ければ projectSettings を使う。
export const BED_OVERRIDE_FIELDS = ["bpm", "background"];

// 各スコープ項目の日本語ラベル (ダイアログの切替 UI で使う)。
export const BED_SCOPE_LABELS = {
  bgm: "BGM",
  videoTrack: "背景動画",
  visualizer: "ビジュアライザ",
  bodySway: "体の揺れ",
};

export function emptySceneBed() {
  return {
    background: "",
    videoTrack: null,
    bgmTracks: [],
    visualizer: { enabled: false, pluginKey: "", audioTrackId: "", layer: "above_bg", params: {} },
    breath: { amplitudePx: 0, periodSec: 4 },
    bpmBob: { amplitudePx: 0 },
    bpm: null,
  };
}

export function defaultBedScope() {
  const out = {};
  for (const key of BED_SCOPE_KEYS) out[key] = "scene";
  return out;
}

// scenario.bedScope を読む (欠損キーは "scene")。
// 制約: ビジュアライザは audioTrackId で BGM を指すので、viz がプロジェクト通しの
// ときは BGM もプロジェクト通しに倒す (サーバ側 _normalize_bed_scope と同じ規則)。
export function bedScope(scenario = state.scenario) {
  const raw = (scenario && typeof scenario.bedScope === "object") ? scenario.bedScope : {};
  const out = {};
  for (const key of BED_SCOPE_KEYS) {
    out[key] = raw[key] === "project" ? "project" : "scene";
  }
  if (out.visualizer === "project") out.bgm = "project";
  return out;
}

// 指定項目が「プロジェクト通し」かどうか。
export function isProjectScoped(key, scenario = state.scenario) {
  return bedScope(scenario)[key] === "project";
}

export function projectSettings(scenario = state.scenario) {
  if (!scenario) return emptySceneBed();
  if (!scenario.projectSettings || typeof scenario.projectSettings !== "object") {
    scenario.projectSettings = emptySceneBed();
  }
  const ps = scenario.projectSettings;
  // 欠損フィールドの遅延補完 (旧データ / 部分保存対策)。
  const base = emptySceneBed();
  for (const [key, value] of Object.entries(base)) {
    if (ps[key] === undefined) ps[key] = value;
  }
  if (!Array.isArray(ps.bgmTracks)) ps.bgmTracks = [];
  return ps;
}

// bedScope に従い、scene のベッド設定を projectSettings で差し替えた**新しい**
// オブジェクトを返す。元 scene は変更しない (= 編集対象と再生対象を分離する)。
export function resolveSceneBed(scene, scenario = state.scenario) {
  if (!scene) return scene;
  const scope = bedScope(scenario);
  const ps = projectSettings(scenario);
  const out = { ...scene };
  for (const key of BED_SCOPE_KEYS) {
    if (scope[key] !== "project") continue;
    for (const field of BED_SCOPE_FIELDS[key]) out[field] = ps[field];
  }
  // 上書き型: scene 側が未指定のときだけプロジェクト側を使う。
  for (const field of BED_OVERRIDE_FIELDS) {
    if (!out[field] && ps[field]) out[field] = ps[field];
  }
  return out;
}

// 再生・描画が見るべき「解決済みシーン」= ベッド設定 (BGM / 背景動画 /
// ビジュアライザ / 体の揺れ / BPM) を bedScope に従って解決したもの。
//
// ★ ここが返すのは**ベッドだけ**。タイムラインアイテム (cuts / telops /
//   soundEffects / videoLayers) は編集面 (state.scenario) 側が正で、
//   シーン側の配列はメモリ上では空になっている。
//
// frame を渡すとその位置のシーン、省略すると再生ヘッド位置のシーンを見る。
export function activeSceneResolved(scenario = state.scenario, frame = null) {
  const scenes = scenario?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return null;
  let scene = scenes[0];
  if (scenes.length > 1) {
    const f = frame != null
      ? frame
      : Math.round((Number(state.timeline?.currentSec) || 0) * PROJECT_FPS);
    scene = sceneAtFrame(f, scenario) || scenes[0];
  }
  return resolveSceneBed(scene, scenario);
}

// ===========================================================================
// 編集面のフラット化 (Phase 2)
//
// **ディスク**: `scenes[i]` ごとに cuts / telops / soundEffects / videoLayers を
//   持ち、frame はシーンローカル (各シーン先頭 = 0)。サーバの正規化・書き出し・
//   ビジュアライザ解析がすべてこの前提で完成しているので、この形は変えない。
// **メモリ**: プロジェクト全体で 1 本のタイムライン。`scenario.cuts` /
//   `.telops` / `.soundEffects` / `.videoLayers` のフラット配列に集約し、
//   frame は**プロジェクト絶対**。各アイテムは所属シーンを `sceneId` で持つ。
//
// 変換は読み込み (`attachScenarioCutsAlias`) と保存 (`toDiskScenario`) の
// 2 箇所だけ。編集コードはシーンの存在を意識せず、1 本のタイムラインを触れば
// よくなる (= 既存の 90 箇所超の `scenario.cuts` 参照がそのまま活きる)。
//
// 詳細は dev_docs/plans/multi-scene.md §3.2。
// ===========================================================================

export const TIMELINE_ITEM_KINDS = ["telops", "soundEffects", "videoLayers"];

// ディスク上のシーン尺 (フレーム)。= 自シーンのカット尺の合計。
// ただし **最後のシーンだけ** は末尾テロップのはみ出し分だけ延びる
// (サーバ `_scene_total_duration` の互換維持。§3.3)。
function diskSceneTotalFrames(scene, isLast) {
  let total = 0;
  for (const cut of scene.cuts || []) {
    total += Math.max(1, Math.round(Number(cut?.durationFrame) || 0));
  }
  if (isLast) {
    for (const telop of scene.telops || []) {
      const end = Math.max(0, Math.round(Number(telop?.startFrame) || 0))
        + Math.max(0, Math.round(Number(telop?.durationFrame) || 0));
      if (end > total) total = end;
    }
  }
  return total;
}

// ディスク形式 (per-scene / シーンローカル) → メモリ形式 (フラット / 絶対)。
function flattenScenarioForEditing(scenario) {
  const cuts = [];
  const telops = [];
  const soundEffects = [];
  const videoLayers = [];
  const laneCounts = { telop: 1, soundEffect: 1, videoLayer: 1 };
  let offset = 0;
  const scenes = scenario.scenes;
  scenes.forEach((scene, index) => {
    if (!Array.isArray(scene.cuts)) scene.cuts = [];
    if (!Array.isArray(scene.telops)) scene.telops = [];
    if (!Array.isArray(scene.soundEffects)) scene.soundEffects = [];
    if (!Array.isArray(scene.videoLayers)) scene.videoLayers = [];
    if (!scene.id) scene.id = `scene_${String(index + 1).padStart(3, "0")}`;
    if (!scene.title) scene.title = `シーン${index + 1}`;
    const sceneId = scene.id;
    const shift = (item, into) => {
      item.sceneId = sceneId;
      item.startFrame = Math.max(0, Math.round(Number(item.startFrame) || 0)) + offset;
      into.push(item);
    };
    for (const cut of scene.cuts) shift(cut, cuts);
    for (const t of scene.telops) shift(t, telops);
    for (const se of scene.soundEffects) shift(se, soundEffects);
    for (const vl of scene.videoLayers) shift(vl, videoLayers);
    // レーン段数はタイムライン 1 枚で描く以上プロジェクト全体で揃える (§3.6)。
    for (const key of ["telop", "soundEffect", "videoLayer"]) {
      laneCounts[key] = Math.max(laneCounts[key], sceneLaneCount(scene, key));
    }
    offset += diskSceneTotalFrames(scene, index === scenes.length - 1);
    // メモリ上はフラット側が正。シーン側の配列は空にしておく
    // (誤って古い参照を読んでも「無い」ことがすぐ分かるように)。
    scene.cuts = [];
    scene.telops = [];
    scene.soundEffects = [];
    scene.videoLayers = [];
  });
  scenario.cuts = cuts;
  scenario.telops = telops;
  scenario.soundEffects = soundEffects;
  scenario.videoLayers = videoLayers;
  scenario.laneCounts = laneCounts;
  // 二重フラット化の防止印。メモリ形式に一度変換したものをもう一度
  // flatten すると、シーン側の配列が空なので全アイテムが消える。
  // toDiskScenario は新しいオブジェクトを組むのでこの印は外へ漏れない。
  scenario.__flattened = true;
  assignSceneMembership(scenario);
}

// カット並びの「所属シーン ID」を **非破壊で** 解決する。
//
// `cut.sceneId` はメモリ専用フィールドなので、オブジェクトを作り直す経路
// (フォーム再構築 / 貼り付け / 一括追加) で欠けることがある。欠けたカットを
// どのシーンにも数えないと **シーン尺がズレて保存時の rebase が壊れる**ので、
// ここで必ず「直前のカットと同じシーン」に寄せる。
function resolveCutSceneIds(cuts, scenes) {
  const known = new Set(scenes.map((scene) => scene.id));
  const fallback = scenes[0]?.id;
  const out = new Array(cuts.length);
  let current = fallback;
  for (let i = 0; i < cuts.length; i += 1) {
    const declared = cuts[i]?.sceneId;
    if (declared && known.has(declared)) current = declared;
    out[i] = current;
  }
  return out;
}

// 各シーンの [開始フレーム, 終了フレーム) とカット範囲を返す。
// カットは順序どおりに並び、シーンをまたいで交互になることはない (不変条件)。
export function sceneSpans(scenario = state.scenario) {
  const scenes = Array.isArray(scenario?.scenes) ? scenario.scenes : [];
  const cuts = Array.isArray(scenario?.cuts) ? scenario.cuts : [];
  const out = scenes.map((scene) => ({
    scene,
    id: scene.id,
    startFrame: 0,
    endFrame: 0,
    cutCount: 0,
    firstCutIndex: -1,
  }));
  const byId = new Map(out.map((entry) => [entry.id, entry]));
  const cutSceneIds = resolveCutSceneIds(cuts, scenes);
  const totals = new Map();
  cuts.forEach((cut, index) => {
    const entry = byId.get(cutSceneIds[index]) || out[0];
    if (!entry) return;
    if (entry.firstCutIndex < 0) entry.firstCutIndex = index;
    entry.cutCount += 1;
    totals.set(entry.id, (totals.get(entry.id) || 0) + cutDurationFrame(cut));
  });
  let offset = 0;
  for (const entry of out) {
    entry.startFrame = offset;
    entry.endFrame = offset + (totals.get(entry.id) || 0);
    offset = entry.endFrame;
  }
  return out;
}

// ---------------------------------------------------------------------------
// カット所属の復元 (シーン消失バグの根治)
//
// シーンは「連続したカットの並び」なので、カット index → シーン index は
// **非減少**でなければならない (§3.4 の不変条件)。ところが移動 / 貼り付けで
// 位置が変わったカットは**古い `sceneId` を持ったまま**別の場所に現れる。
// 宣言をそのまま信じて前進すると、間のシーンのカットが丸ごと後ろのシーンへ
// 吸い込まれ、**そのシーンが空になって消える** (例: 最後のシーンのカットを
// 先頭へドラッグすると 3 シーンが 1 シーンに潰れる)。
//
// そこで「非減少な割り当てのうち、宣言と一致する数が最大のもの」を DP で選ぶ。
// 宣言が整合している通常時は一致数 = 全カットとなり結果は宣言そのもの
// (= 従来の挙動)。迷子が 1 枚混ざったときだけ、その 1 枚が周囲に合わせられ、
// シーン構成は保たれる。
//
// 同点の破り方 (優先度順):
//   ② いずれかのカットが宣言しているシーンをより多く使う割り当て
//      (= 宣言があるのに空になるシーンを作らない)
//   ③ 区切りをできるだけ後ろに置く割り当て
//      (= 宣言の無いカットは直前のカットに貼り付く)
// ---------------------------------------------------------------------------
// スコア = 一致数 * _AGREE_WEIGHT + 使用した「宣言済みシーン」数。
// シーン数 < _AGREE_WEIGHT なので桁は混ざらない。③ は backtrack の選び方で表す。
const _AGREE_WEIGHT = 1e6;

function resolveCutSceneIndices(cuts, scenes) {
  const n = cuts.length;
  const m = scenes.length;
  if (n === 0 || m === 0) return [];
  if (m === 1) return new Array(n).fill(0);
  const indexById = new Map(scenes.map((scene, i) => [scene.id, i]));
  const declared = cuts.map((cut) => {
    const found = cut ? indexById.get(cut.sceneId) : undefined;
    return found == null ? -1 : found;
  });
  // 「宣言されているシーン」だけを維持対象にする。誰も宣言していないシーンを
  // 埋めにいくと、末尾に足したばかりの (sceneId の無い) カットが勝手に次の
  // シーンへ移ってしまう。
  const declaredScenes = new Set(declared.filter((d) => d >= 0));
  const usedBonus = (s) => (declaredScenes.has(s) ? 1 : 0);

  // dp[i][s] = カット i を シーン s に置いたときの、そこまでの最大スコア。
  const dp = [];
  for (let i = 0; i < n; i += 1) {
    const cur = new Float64Array(m);
    const prev = i > 0 ? dp[i - 1] : null;
    let bestPrev = -Infinity;   // s' < s の範囲での prev 最大値
    for (let s = 0; s < m; s += 1) {
      const agree = declared[i] === s ? _AGREE_WEIGHT : 0;
      if (!prev) {
        // 先頭カット: どのシーンから始めてもよい (手前のシーンは空になる)。
        cur[s] = agree + usedBonus(s);
      } else {
        const stay = prev[s];
        const move = bestPrev > -Infinity ? bestPrev + usedBonus(s) : -Infinity;
        cur[s] = agree + Math.max(stay, move);
      }
      if (prev && prev[s] > bestPrev) bestPrev = prev[s];
    }
    dp.push(cur);
  }

  // 最終スコアが最大のシーン。同点なら**手前**のシーンを選ぶ (= 区切りを後ろへ)。
  const last = dp[n - 1];
  let bestScene = 0;
  for (let s = 1; s < m; s += 1) if (last[s] > last[bestScene]) bestScene = s;

  const out = new Array(n);
  out[n - 1] = bestScene;
  for (let i = n - 1; i >= 1; i -= 1) {
    const s = out[i];
    const agree = declared[i] === s ? _AGREE_WEIGHT : 0;
    const target = dp[i][s] - agree;
    // 同じ最適値を出す前カットのシーンのうち**最も手前**を選ぶ。こうすると
    // 所属が決まらないカットは直前のカットに貼り付き、区切りが勝手に前へ
    // ずれない。
    let chosen = s;
    for (let sp = 0; sp <= s; sp += 1) {
      const value = dp[i - 1][sp] + (sp === s ? 0 : usedBonus(s));
      if (value === target) { chosen = sp; break; }
    }
    out[i - 1] = chosen;
  }
  return out;
}

// 移動 / 貼り付けで位置が変わったカットの所属を、**移動先の並び**から取り直す。
// 直前のカット (自分たち以外) と同じシーンに入る。先頭に落とした場合は直後の
// カットに合わせる。これをしないと古い `sceneId` が残り、間のシーンが消える。
export function restampCutsSceneByPosition(cutIds, scenario = state.scenario) {
  const scenes = Array.isArray(scenario?.scenes) ? scenario.scenes : [];
  const cuts = Array.isArray(scenario?.cuts) ? scenario.cuts : [];
  if (scenes.length === 0 || cuts.length === 0) return;
  const moving = cutIds instanceof Set ? cutIds : new Set(cutIds || []);
  if (moving.size === 0) return;
  const known = new Set(scenes.map((scene) => scene.id));
  // 動いていないカットが 1 枚も無いなら「移動先」を決める基準がない。触らずに
  // 帰る (全カットを選んで動かした = 並び順が変わっていないケース)。
  const hasAnchor = cuts.some((cut) => cut && !moving.has(cut.id) && known.has(cut.sceneId));
  if (!hasAnchor) return;
  const anchorAt = (index) => {
    for (let i = index - 1; i >= 0; i -= 1) {
      const cut = cuts[i];
      if (cut && !moving.has(cut.id) && known.has(cut.sceneId)) return cut.sceneId;
    }
    for (let i = index + 1; i < cuts.length; i += 1) {
      const cut = cuts[i];
      if (cut && !moving.has(cut.id) && known.has(cut.sceneId)) return cut.sceneId;
    }
    return scenes[0].id;
  };
  cuts.forEach((cut, index) => {
    if (cut && moving.has(cut.id)) cut.sceneId = anchorAt(index);
  });
}

// カットとアイテムの所属シーンを正規化する。
// - カットは並び順に走査し、シーン index が後戻りしないように割り当てる
//   (= シーンは常に「連続したカットの並び」になる。§3.4 の不変条件)。
// - テロップ / 効果音 / 動画レイヤーは開始フレームが入るシーンに所属させる。
//
// 戻り値: 空になって取り除かれたシーンのタイトル配列 (呼び出し側の通知用)。
export function assignSceneMembership(scenario = state.scenario) {
  let scenes = Array.isArray(scenario?.scenes) ? scenario.scenes : [];
  if (scenes.length === 0) return [];
  const cuts = Array.isArray(scenario.cuts) ? scenario.cuts : [];

  // ① 先に全カットの所属を確定させる。
  //    ★ 掃除より先に走らせること。`sceneId` を落としたカット (フォームからの
  //      再構築など) が居るとき、先に掃除するとそのカットだけを持つシーンが
  //      「空」と誤判定されて消える。所属確定が先なら、所属が欠けたカットは
  //      直前のカットと同じシーン (先頭なら scenes[0]) に復帰する。
  const resolved = resolveCutSceneIndices(cuts, scenes);
  cuts.forEach((cut, index) => {
    if (!cut) return;
    cut.sceneId = scenes[resolved[index]].id;
  });

  // ② 確定後の所属をもとに、カットが 1 つも無いシーンを取り除く
  //    (§3.4 の不変条件)。全カットが消えている場合は 1 つ残す。
  const removed = [];
  if (scenes.length > 1 && cuts.length > 0) {
    const used = new Set(cuts.map((c) => c?.sceneId).filter(Boolean));
    const kept = scenes.filter((scene) => used.has(scene.id));
    if (kept.length > 0 && kept.length < scenes.length) {
      for (const scene of scenes) {
        if (!used.has(scene.id)) removed.push(scene.title || scene.id);
      }
      scenario.scenes = kept;
      scenes = kept;
      if (state.selectedSceneId && !kept.some((s) => s.id === state.selectedSceneId)) {
        state.selectedSceneId = kept[0].id;
      }
    }
  }
  // アイテムは「開始フレームが属するシーン」。span はカット割り当て後に取る。
  const spans = sceneSpans(scenario);
  const sceneIdAtFrame = (frame) => {
    for (const span of spans) {
      if (frame < span.endFrame) return span.id;
    }
    return spans[spans.length - 1]?.id || scenes[0].id;
  };
  for (const kind of TIMELINE_ITEM_KINDS) {
    for (const item of scenario[kind] || []) {
      if (!item) continue;
      item.sceneId = sceneIdAtFrame(Math.max(0, Math.round(Number(item.startFrame) || 0)));
    }
  }
  return removed;
}

// メモリ形式 → ディスク形式 (per-scene / シーンローカル)。保存と sceneOverride で使う。
// **メモリ側は一切変更しない** (新しいオブジェクトを組んで返す)。
//
// options.resolveTransitions = true のとき、シーン先頭カットの `transition` を
// **実効値** (シーン側が上書きしていればそれ) に差し替える。書き出し経路専用の
// オプションで、保存では使わない (使うと上書き結果がディスクに焼き付いてしまう)。
export function toDiskScenario(scenario = state.scenario, options = {}) {
  const spans = sceneSpans(scenario);
  const laneCounts = scenario?.laneCounts || { telop: 1, soundEffect: 1, videoLayer: 1 };
  const resolveTransitions = !!options.resolveTransitions;
  const rebase = (item, offset) => ({
    ...item,
    startFrame: Math.max(0, Math.round(Number(item.startFrame) || 0) - offset),
  });
  // ★ 所属不明 (sceneId が欠落 / どのシーンも指していない) のアイテムを
  //   **絶対に取りこぼさない**。単純な `item.sceneId === span.id` の filter だと、
  //   タイムラインに追加した直後 (assignSceneMembership がまだ走っていない)
  //   テロップ / 効果音 / 動画レイヤーが履歴スナップショットや保存 payload から
  //   静かに消える。カットは並び順が正なので直前のカットへ、その他のアイテムは
  //   開始フレームが入るシーンへ寄せる。
  const knownSceneIds = new Set(spans.map((span) => span.id));
  const cutSceneIds = resolveCutSceneIds(
    Array.isArray(scenario?.cuts) ? scenario.cuts : [],
    spans.map((span) => span.scene),
  );
  const itemSceneId = (item) => {
    if (item && knownSceneIds.has(item.sceneId)) return item.sceneId;
    const frame = Math.max(0, Math.round(Number(item?.startFrame) || 0));
    for (const span of spans) {
      if (frame < span.endFrame) return span.id;
    }
    return spans[spans.length - 1]?.id;
  };
  const scenes = spans.map((span) => {
    const pick = (list) => (list || [])
      .filter((item) => item && itemSceneId(item) === span.id)
      .map((item) => rebase(item, span.startFrame));
    const cutsOut = (scenario.cuts || [])
      .filter((cut, index) => cut && cutSceneIds[index] === span.id)
      .map((cut) => rebase(cut, span.startFrame));
    if (resolveTransitions && cutsOut.length > 0) {
      const sceneTransition = span.scene?.transition;
      if (sceneTransition && sceneTransition.type && sceneTransition.type !== "none") {
        cutsOut[0] = { ...cutsOut[0], transition: { ...sceneTransition } };
      }
    }
    return {
      ...span.scene,
      cuts: cutsOut,
      telops: pick(scenario.telops),
      soundEffects: pick(scenario.soundEffects),
      videoLayers: pick(scenario.videoLayers),
      laneCounts: { ...laneCounts },
    };
  });
  return {
    version: scenario?.version || 4,
    title: scenario?.title || "scenario",
    projectSettings: scenario?.projectSettings || null,
    bedScope: scenario?.bedScope || null,
    scenes,
  };
}

// 指定シーン 1 つ分だけをディスク形式で取り出す (scene-bundle の sceneOverride 用)。
export function sceneToDisk(sceneId, scenario = state.scenario) {
  const disk = toDiskScenario(scenario);
  return disk.scenes.find((scene) => scene.id === sceneId) || disk.scenes[0] || null;
}

// 指定の絶対フレームを含むシーン (範囲外は末尾シーン)。
export function sceneAtFrame(frame, scenario = state.scenario) {
  const spans = sceneSpans(scenario);
  if (spans.length === 0) return null;
  const f = Math.max(0, Math.round(Number(frame) || 0));
  for (const span of spans) {
    if (f < span.endFrame) return span.scene;
  }
  return spans[spans.length - 1].scene;
}

// カットに実際に適用されるトランジション設定を返す (Phase 3)。
//
// **シーンの先頭カットでは `scene.transition` が `cut.transition` を上書きする。**
// 理由: シーン境界は「シーンの切り替わり」であり、そこに 2 種類のトランジションが
// 二重に掛かると意味が壊れる。シーン境界を持つのはシーン側、と一本化する。
//
// 先頭シーンの先頭カットでは「前」が無いので、cut と同じく白/黒からのフェードイン
// として解釈される (描画側の既存挙動をそのまま使う)。
export function effectiveCutTransition(cut, scenario = state.scenario) {
  if (!cut) return { type: "none", durationFrame: 0 };
  const scenes = scenario?.scenes;
  if (Array.isArray(scenes) && scenes.length > 0) {
    const spans = sceneSpans(scenario);
    const cuts = scenario.cuts || [];
    const index = cuts.indexOf(cut);
    const span = spans.find((sp) => sp.id === cut.sceneId);
    if (span && span.firstCutIndex >= 0 && span.firstCutIndex === index) {
      const st = span.scene?.transition;
      if (st && st.type && st.type !== "none") {
        return {
          type: String(st.type),
          durationFrame: Math.max(0, Math.round(Number(st.durationFrame) || 0)),
          ...(st.wipeDirection ? { wipeDirection: String(st.wipeDirection) } : {}),
        };
      }
    }
  }
  return cutTransition(cut);
}

// シーン先頭カットで、カット側のトランジションがシーン側に上書きされているか。
// UI で「この設定は使われません」と出すために使う。
export function isCutTransitionOverriddenByScene(cut, scenario = state.scenario) {
  if (!cut) return false;
  const own = cutTransition(cut);
  if (own.type === "none") return false;
  const eff = effectiveCutTransition(cut, scenario);
  return eff.type !== own.type || eff.durationFrame !== own.durationFrame;
}

// 選択中シーンを「今どこを見ているか」に追従させる。
//
// カットを選ぶ / 再生ヘッドを動かすと、そのカットが属するシーンも選択状態に
// なるのが自然なので、両方の入口からこれを呼ぶ。シーンレーンを直接クリック
// した場合も同じ変数を書くだけなので、次にカットを触れば自然に上書きされる。
export function syncSelectedSceneToCurrent(scenario = state.scenario) {
  const scenes = scenario?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return null;
  let sceneId = null;
  const cut = (scenario.cuts || []).find((c) => c && c.id === state.selectedCutId);
  if (cut?.sceneId) {
    sceneId = cut.sceneId;
  } else {
    const frame = Math.round((Number(state.timeline?.currentSec) || 0) * PROJECT_FPS);
    sceneId = sceneAtFrame(frame, scenario)?.id || scenes[0].id;
  }
  if (state.selectedSceneId !== sceneId) state.selectedSceneId = sceneId;
  return sceneId;
}

// カット ID から所属シーンを引く。
export function sceneOfCut(cutId, scenario = state.scenario) {
  const cut = (scenario?.cuts || []).find((c) => c && c.id === cutId);
  if (!cut) return scenario?.scenes?.[0] || null;
  return (scenario.scenes || []).find((s) => s.id === cut.sceneId) || scenario.scenes?.[0] || null;
}

export function attachScenarioCutsAlias(scenario) {
  // ディスク形式 (per-scene / シーンローカル) を受け取り、メモリ形式
  // (フラット / プロジェクト絶対) に変換して返す。
  // 旧フォーマット (cuts 直下) も scenes に巻き直す。
  if (!scenario || typeof scenario !== "object") {
    scenario = { version: 4, title: "scenario", scenes: [] };
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
  if (scenario.__flattened) {
    // 既にメモリ形式。所属だけ取り直して二重変換を避ける (防御的措置。
    // 通常はディスク形式しか渡ってこない)。
    assignSceneMembership(scenario);
  } else {
    flattenScenarioForEditing(scenario);
  }
  // ベッド設定の二層化 (dev_docs/plans/multi-scene.md)。サーバは既定値のとき
  // キーを出さないので、クライアント側で器を用意しておく。
  if (!scenario.projectSettings || typeof scenario.projectSettings !== "object") {
    scenario.projectSettings = emptySceneBed();
  }
  if (!scenario.bedScope || typeof scenario.bedScope !== "object") {
    scenario.bedScope = defaultBedScope();
  } else {
    scenario.bedScope = bedScope(scenario);
  }
  if (!scenario.version) scenario.version = 4;
  return scenario;
}

// カット並びから startFrame を再計算し、所属シーンを正規化する。
// **構造変更 (追加 / 削除 / 並べ替え / 分割) の後は必ずこれが呼ばれる**ので、
// シーン membership の維持もここに相乗りさせている。
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
  if (deltaByCutId.size > 0) {
    for (const kind of TIMELINE_ITEM_KINDS) {
      for (const item of state.scenario?.[kind] || []) {
        const linked = item?.linkedCutId;
        if (!linked) continue;
        const delta = deltaByCutId.get(linked);
        if (!delta) continue;
        item.startFrame = Math.max(0, (Number(item.startFrame) || 0) + delta);
      }
    }
  }
  // カットの並び / 尺が変わるとシーンの範囲も変わる。所属を取り直す。
  const removed = assignSceneMembership(state.scenario);
  // シーンが消えるのは「カットが 1 つも無くなった」ときだけ。黙って消えると
  // 何が起きたか分からないので必ず知らせる (2026-09-08 のユーザー報告)。
  if (removed.length > 0) {
    _notify(
      `カットが無くなったシーン ${removed.map((t) => `「${t}」`).join("")} を削除しました`,
      "warn",
    );
  }
}
