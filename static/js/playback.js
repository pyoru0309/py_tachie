import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { drawTimeline, autoScrollTimelineToCursor, autoScrollCutListToActive } from "./timeline.js";
import { PROJECT_FPS, clampCharacterAnimationFps } from "./timecode.js";
import {
  cutStartFrame, cutDurationFrame, cutStartSec, cutDurationSec, cutTransition,
  activeSceneResolved, projectSettings, bedScope, sceneToDisk, sceneSpans,
  syncSelectedSceneToCurrent, resolveSceneBed, effectiveCutTransition,
} from "./scenario.js";
import { captureAndUploadThumbnail } from "./thumbnail.js";
import { createPreviewScheduler, PRIORITY } from "./preview-scheduler.js";
import { setCutPrerenderStatus } from "./prerender.js";

// =============================================================================
// v2 (WebGL + three.js) renderer
// 旧 v1 (Pillow + Canvas2D) 経路は撤去済み。three.js は初回呼び出し時に dynamic
// import でロードする。
// =============================================================================
let _v2ModulePromise = null;
async function loadRendererV2() {
  if (!_v2ModulePromise) {
    _v2ModulePromise = import("./renderer/index.js");
  }
  return _v2ModulePromise;
}

let deps = {
  loadCut: async () => {},
  payload: () => ({}),
  missingMaterialMessage: () => null,
  renderCutList: () => {},
};

export function bindPlayback(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
}

export function setTogglePlayUi(isPlaying) {
  const btn = elements.togglePreviewButton;
  if (!btn) return;
  btn.dataset.playState = isPlaying ? "playing" : "stopped";
  const icon = btn.querySelector(".msym");
  const label = btn.querySelector("span:not(.msym)");
  if (icon) icon.textContent = isPlaying ? "stop" : "play_arrow";
  if (label) label.textContent = isPlaying ? "停止" : "再生";
  btn.title = isPlaying ? "停止 (Space)" : "再生 (Space)";
}

export async function renderPreview(options = {}) {
  if (!state.manifest) return;
  const saveOutput = options.saveOutput === true;
  // ★ previewRequestId は **どの分岐でも必ずインクリメント** する。
  //   素材不足ガード等の早期 return を踏むと、直前に走っていた renderPreviewV2 が
  //   後追いで `state.previewRequestId === requestId` 判定をすり抜けて
  //   `showLivePreviewCanvas(true)` を呼んでしまう。今回の inc で旧 requestId は
  //   即座に古くなり、in-flight な still render は途中で skip される。
  const requestId = (state.previewRequestId += 1);
  const materialMessage = deps.missingMaterialMessage();
  if (materialMessage) {
    elements.previewImage.removeAttribute("src");
    elements.emptyPreview.textContent = materialMessage;
    elements.emptyPreview.style.display = "grid";
    // emptyPreview は半透明オーバーレイなので、直前カットの GL フレームが
    // 下に透けるのを防ぐため GL canvas / video / scene を畳む。
    showLivePreviewCanvas(false);
    if (saveOutput) {
      showToast("素材を追加してから出力してください", "error");
    }
    return;
  }
  // v2 GL still render + (saveOutput=true なら GL canvas を toBlob('image/png') して
  // /api/projects/{id}/render-png に POST) で再生ヘッド上のプレビューを描画する。
  const currentCut = state.selectedCutId
    ? state.scenario?.cuts?.find((cut) => cut.id === state.selectedCutId)
    : null;
  if (!currentCut) return;
  // renderButton は「エクスポート ▼」内のメニュー項目 (icon + label span 構成) な
  // ので、textContent 直書きは避けて label span だけを差し替える。
  const renderButtonLabel = elements.renderButton?.querySelector("span:not(.button-icon)");
  if (saveOutput) {
    elements.renderButton.disabled = true;
    if (renderButtonLabel) renderButtonLabel.textContent = "出力中…";
  }
  try {
    const ok = await renderPreviewV2(currentCut, requestId);
    if (!ok) {
      if (saveOutput) showToast("プレビュー描画に失敗しました", "error");
      return;
    }
    if (saveOutput) {
      const v2 = await loadRendererV2();
      let blob = null;
      try {
        blob = await v2.captureSceneSnapshot({ format: "image/png" });
      } catch (err) {
        console.warn("[v2] captureSceneSnapshot failed:", err);
      }
      if (!blob || !state.activeProjectId) {
        showToast("PNG出力に失敗しました (snapshot unavailable)", "error");
        return;
      }
      const url = `/api/projects/${encodeURIComponent(state.activeProjectId)}/render-png`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      if (!response.ok) {
        const txt = await response.text().catch(() => "");
        throw new Error(`render-png upload failed: HTTP ${response.status} ${txt}`);
      }
      const result = await response.json();
      state.lastPath = result.path;
      elements.previewImage.src = `${result.path}?t=${Date.now()}`;
      elements.previewImage.style.opacity = "1";
      elements.emptyPreview.style.display = "none";
      showToast(`PNGを書き出しました: ${result.filename}`);
      // 同じ blob を一覧サムネとしても保存する (force=true で dirty 判定を無視)。
      captureAndUploadThumbnail({ force: true, blob }).catch(() => {});
    } else if (options.captureThumbnail) {
      // 描画が完了した (=race / fail で skip されていない) ときだけサムネを送る。
      captureAndUploadThumbnail({ force: false }).catch(() => {});
    }
  } catch (error) {
    console.error(error);
    if (saveOutput) {
      showToast("PNG出力に失敗しました", "error");
    } else {
      showToast("プレビュー描画に失敗しました", "error");
    }
  } finally {
    if (saveOutput) {
      elements.renderButton.disabled = false;
      if (renderButtonLabel) renderButtonLabel.textContent = "PNG静止画";
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    state.playbackTimer = window.setTimeout(resolve, ms);
  });
}

// 発話ディレイ (cut.audioDelaySec) で audio.play() を後ろへずらす予約タイマー。
// stopAudio / カット切替で必ず clear する (= 停止後の resurrect 防止)。
let _pendingSpeechDelayTimer = null;

function stopAudio() {
  // 発話ディレイで予約した play() があれば取り消す (停止/カット切替で resurrect 防止)。
  if (_pendingSpeechDelayTimer) {
    try { clearTimeout(_pendingSpeechDelayTimer); } catch (_) { /* ignore */ }
    _pendingSpeechDelayTimer = null;
  }
  if (state.playbackAudio) {
    try {
      state.playbackAudio.pause();
      state.playbackAudio.currentTime = 0;
    } catch (_) { /* ignore */ }
    state.playbackAudio = null;
  }
  // 話者音声 (cut.audio) を analyser に通している場合は、HTMLAudioElement と
  // 1:1 で紐づく AudioContext / source をカット境界で破棄する。
  // BGM 由来の analyser はシーン全体で共有するのでここでは触らない。
  closeSpeakerLipSyncAnalyser();
}

function stopLivePreviewBgm() {
  const list = state.playbackBgmAudios || [];
  for (const a of list) {
    try { a.pause(); a.currentTime = 0; } catch (_) { /* ignore */ }
  }
  state.playbackBgmAudios = [];
  // BGM 由来 / 話者由来どちらの analyser でもこの経路は強制的にクリーンアップ。
  // outer ループ境界やプロジェクト切替の hard stop で呼ばれる想定。
  if (state.playbackAudioContext) {
    try { state.playbackAudioContext.close(); } catch (_) { /* ignore */ }
    state.playbackAudioContext = null;
  }
  state.playbackAnalyser = null;
  state.playbackAnalyserBuffer = null;
  state.playbackAnalyserOwner = null;
}

// 効果音 (scene.soundEffects[]) 用の予約再生プレイヤー。
// se.durationFrame で「区間」を持ち、se.loop で終了時間まで素材を繰り返し、
// se.fadeInSec / se.fadeOutSec で区間先頭と末尾だけにフェードを掛ける
// (= ループ反復の境目には掛けない)。
function stopLivePreviewSoundEffects() {
  const timers = state.playbackSoundEffectTimers || [];
  for (const t of timers) {
    try { clearTimeout(t); } catch (_) { /* ignore */ }
  }
  state.playbackSoundEffectTimers = [];
  const intervals = state.playbackSoundEffectIntervals || [];
  for (const i of intervals) {
    try { clearInterval(i); } catch (_) { /* ignore */ }
  }
  state.playbackSoundEffectIntervals = [];
  const audios = state.playbackSoundEffectAudios || [];
  for (const a of audios) {
    try { a.pause(); a.currentTime = 0; a.loop = false; } catch (_) { /* ignore */ }
  }
  state.playbackSoundEffectAudios = [];
}

// audio.volume を targetVolume の比率で from→to に補間する setInterval を返す。
// 終了したら自分自身を clearInterval し、interval 配列からも除去する。
function rampSoundEffectVolume(audio, fromRatio, toRatio, durSec, targetVolume, intervals) {
  if (durSec <= 0) {
    audio.volume = Math.max(0, Math.min(1, targetVolume * toRatio));
    return null;
  }
  const stepMs = 40;          // 25Hz でランプ更新 (fade として十分滑らか)
  const steps = Math.max(1, Math.round((durSec * 1000) / stepMs));
  let step = 0;
  audio.volume = Math.max(0, Math.min(1, targetVolume * fromRatio));
  const id = window.setInterval(() => {
    step += 1;
    const t = Math.min(1, step / steps);
    const ratio = fromRatio + (toRatio - fromRatio) * t;
    try {
      audio.volume = Math.max(0, Math.min(1, targetVolume * ratio));
    } catch (_) { /* ignore */ }
    if (step >= steps) {
      clearInterval(id);
      const idx = intervals.indexOf(id);
      if (idx >= 0) intervals.splice(idx, 1);
    }
  }, stepMs);
  intervals.push(id);
  return id;
}

function startLivePreviewSoundEffects(scene, timelineOffsetSec) {
  stopLivePreviewSoundEffects();
  if (!scene || !Array.isArray(scene.soundEffects)) return;
  const offsetSec = Math.max(0, Number(timelineOffsetSec) || 0);
  const timers = [];
  const intervals = [];
  const audios = [];
  for (const se of scene.soundEffects) {
    if (!se || !se.src) continue;
    const startFrame = Math.max(0, Math.round(Number(se.startFrame) || 0));
    const startSec = startFrame / PROJECT_FPS;
    const delaySec = startSec - offsetSec;

    // 区間長 (durationFrame=0 = 素材長そのまま)
    const rawDurFrames = Math.max(0, Math.round(Number(se.durationFrame) || 0));
    const assetDurSec = Number(state.soundEffectDurations?.get(se.src)) || 0;
    let durSec = rawDurFrames > 0 ? rawDurFrames / PROJECT_FPS
      : (assetDurSec > 0 ? assetDurSec : null);

    const loop = !!se.loop;
    // 素材内の頭出し位置 (= 分割で生まれた SE が素材途中から鳴り始める用途、
    // 左端ドラッグでの「左カット」用途)。preview では audio.currentTime に加算する。
    const audioOffsetSec = Math.max(0, Number(se.audioOffsetSec) || 0);
    // 区間の終了時刻 (シーンタイムライン上の秒) で「もう鳴り終わっている SE」だけ skip。
    // 旧実装は「過去 1 秒以上」で一律 skip していたため、長尺 SE をカット途中から
    // 再生したとき (例: 30s ジングルを 15s 時点から再生) に音が出なかった。
    // loop=False で durationFrame > assetDur のときは音的に asset 末尾で終わるので
    // endSec はその短い方を使う (素材無音区間を「鳴っている」扱いしない)。
    const effectiveEndDurSec = durSec != null
      ? (loop || assetDurSec <= 0 ? durSec : Math.min(durSec, assetDurSec))
      : null;
    const endSec = effectiveEndDurSec != null ? startSec + effectiveEndDurSec : Infinity;
    if (endSec <= offsetSec) continue;
    const targetVolume = Math.max(0, Math.min(1, Number(se.volume ?? 1)));
    // フェード時間は区間の半分まで (区間より長い fade はクランプ)。
    const fadeMaxSec = durSec ? durSec / 2 : Infinity;
    const fadeIn = Math.min(fadeMaxSec, Math.max(0, Number(se.fadeInSec) || 0));
    const fadeOut = Math.min(fadeMaxSec, Math.max(0, Number(se.fadeOutSec) || 0));

    const src = se.src.startsWith("/") ? se.src : `/assets/${se.src}`;
    const audio = new Audio(src);
    audio.preload = "auto";
    audio.loop = loop;
    // 初期音量: fadeIn ありなら 0、なければ targetVolume
    audio.volume = fadeIn > 0 ? 0 : targetVolume;
    audios.push(audio);

    // 「再生開始 → fadeIn ランプ → durSec 経過直前で fadeOut ランプ → durSec で stop」
    // を delaySec オフセットで予約する。過去にスタートしてた SE は currentTime で
    // シーク済みの所から再開しつつ、残り時間で fade を換算し直す。
    const setupPlayback = (alreadyElapsedSec) => {
      const remainingDurSec = durSec != null ? Math.max(0, durSec - alreadyElapsedSec) : null;

      // fadeIn: 既に過ぎていれば即 targetVolume、過渡中なら残り分だけランプ。
      if (fadeIn > 0) {
        const fadeInRemaining = fadeIn - alreadyElapsedSec;
        if (fadeInRemaining <= 0) {
          audio.volume = targetVolume;
        } else {
          const fromRatio = Math.max(0, alreadyElapsedSec / fadeIn);
          rampSoundEffectVolume(audio, fromRatio, 1, fadeInRemaining, targetVolume, intervals);
        }
      } else {
        audio.volume = targetVolume;
      }

      audio.play().catch((error) => console.warn("SE play failed", error));

      if (remainingDurSec != null) {
        // fadeOut 開始予約
        if (fadeOut > 0) {
          const fadeOutStartFromNow = remainingDurSec - fadeOut;
          if (fadeOutStartFromNow <= 0) {
            // 既に fadeOut 区間に入っている → 残り時間で 1→0 ランプ
            const elapsedInFadeOut = -fadeOutStartFromNow;
            const fromRatio = Math.max(0, 1 - elapsedInFadeOut / fadeOut);
            rampSoundEffectVolume(audio, fromRatio, 0, remainingDurSec, targetVolume, intervals);
          } else {
            const t = window.setTimeout(() => {
              rampSoundEffectVolume(audio, 1, 0, fadeOut, targetVolume, intervals);
            }, fadeOutStartFromNow * 1000);
            timers.push(t);
          }
        }
        // stop 予約 (= 区間終端)
        const t = window.setTimeout(() => {
          try { audio.pause(); audio.loop = false; } catch (_) { /* ignore */ }
        }, remainingDurSec * 1000);
        timers.push(t);
      }
    };

    if (delaySec <= 0) {
      // 過去スタート: 経過分だけ素材内をスキップして再開。loop=true なら素材長で割る。
      // audioOffsetSec があれば素材内位置の起点をそこにずらす。
      const elapsed = -delaySec;
      try {
        if (loop && assetDurSec > 0) {
          audio.currentTime = (audioOffsetSec + elapsed) % assetDurSec;
        } else if (assetDurSec > 0) {
          audio.currentTime = Math.min(
            audioOffsetSec + elapsed,
            Math.max(0, assetDurSec - 0.05),
          );
        } else {
          audio.currentTime = audioOffsetSec + elapsed;
        }
      } catch (_) { /* ignore */ }
      setupPlayback(elapsed);
    } else {
      const t = window.setTimeout(() => {
        // future スタート: 再生開始の瞬間に offset へ seek する。
        if (audioOffsetSec > 0) {
          try {
            if (loop && assetDurSec > 0) {
              audio.currentTime = audioOffsetSec % assetDurSec;
            } else if (assetDurSec > 0) {
              audio.currentTime = Math.min(audioOffsetSec, Math.max(0, assetDurSec - 0.05));
            } else {
              audio.currentTime = audioOffsetSec;
            }
          } catch (_) { /* ignore */ }
        }
        setupPlayback(0);
      }, delaySec * 1000);
      timers.push(t);
    }
  }
  state.playbackSoundEffectTimers = timers;
  state.playbackSoundEffectIntervals = intervals;
  state.playbackSoundEffectAudios = audios;
}

// Promise.race で audio が「鳴り始めた」シグナルを取る。
// - play() Promise: 再生キュー受理。decode が走る OS では遅延あり。
// - "playing" event: 実際に再生フレームが出始めたタイミング。
// 両方を競争させ、先に来た方を「BGM 開始」とみなす。
// タイムアウト (1500ms) で stuck 防止 (canplay 失敗時等)。
function audioReadyPromise(audio) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("playing", done);
      resolve();
    };
    audio.addEventListener("playing", done, { once: true });
    audio.play()
      .then(done)
      .catch((error) => {
        console.warn("BGM preview failed", error);
        done();
      });
    setTimeout(done, 1500);
  });
}

// 再生中のシーン切替に合わせて BGM を張り替える。
// `state.playbackBgmSceneId` に「今鳴らしているシーン」を持ち、変化したときだけ
// stop → start する。プロジェクト通しの BGM では何もしない。
async function _switchBgmIfSceneChanged(cut) {
  if (bedScope().bgm === "project") return;
  const sceneId = cut?.sceneId || null;
  if (!sceneId || sceneId === state.playbackBgmSceneId) return;
  state.playbackBgmSceneId = sceneId;
  const scene = (state.scenario?.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return;
  stopLivePreviewBgm();
  // 新しいシーンの先頭から鳴らす (シーン内経過 = 0)。
  await startLivePreviewBgm(resolveSceneBed(scene), 0);
}

async function startLivePreviewBgm(scene, timelineOffsetSec) {
  stopLivePreviewBgm();
  if (!scene || !Array.isArray(scene.bgmTracks)) return;
  const audios = [];
  let lipAudio = null;
  for (const bgm of scene.bgmTracks) {
    if (!bgm || !bgm.src) continue;
    const src = bgm.src.startsWith("/") ? bgm.src : `/assets/${bgm.src}`;
    const audio = new Audio(src);
    const trimStart = Math.max(0, Number(bgm.trimStartSec) || 0);
    const offset = Math.max(0, Number(timelineOffsetSec) || 0);
    audio.currentTime = trimStart + offset;
    audio.volume = Math.max(0, Math.min(1, Number(bgm.volume) || 1));
    // ループ再生 ON のときは HTMLAudio の loop 属性に倒す (排他ではないので
    // 同一シーンの複数 BGM がそれぞれ独立にループする)。
    audio.loop = !!bgm.loop;
    if (bgm.useForLipSync) {
      // 口パク用トラックは analyser 経由で波形を取り、destination には繋がない。
      // → 出力ミックスから外れ、波形だけ取得できる。
      lipAudio = audio;
    }
    audios.push({ audio, isLipSync: !!bgm.useForLipSync });
  }
  state.playbackBgmAudios = audios.map(({ audio }) => audio);
  if (lipAudio) {
    setupLipSyncAnalyser(lipAudio);
  }
  // BGM が実際に鳴り始めるまで待ってから resolve する。
  // → 呼び出し側 (playPreviewPlayback) はこの直後に wallclock anchor を取れるので、
  //   Windows の初回 audio decode 遅延でテロップが先走る現象を防げる。
  // 注意: lipAudio は audios にもエントリが含まれているので、ここで二重に
  // audioReadyPromise を呼ぶと audio.play() が同一要素に対し 2 回発火し、
  // 一部ブラウザで BGM の partial fetch が二重に走る。各 audio に対して
  // 1 回ずつだけ ready promise を作る。
  const ready = audios.map(({ audio }) => audioReadyPromise(audio));
  await Promise.all(ready);
}

function setupLipSyncAnalyser(audio) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    // destination には繋がない。これにより analyser を経由した分の音は再生されず、
    // useForLipSync トラックは出力ミックスから外れたまま波形だけ取れる。
    state.playbackAudioContext = ctx;
    state.playbackAnalyser = analyser;
    state.playbackAnalyserBuffer = new Float32Array(analyser.fftSize);
    state.playbackAnalyserOwner = "bgm";
    return analyser;
  } catch (error) {
    console.warn("Lip-sync analyser unavailable", error);
    return null;
  }
}

// useForLipSync な BGM が無いときのフォールバック。話者音声 (cut.audio) を
// analyser に通し、その波形から口パク・音量メーターを駆動する。
// BGM 用と違い destination にも繋ぐので、音声は通常通り聞こえる。
// HTMLAudioElement と createMediaElementSource は 1:1 のため、AudioContext は
// カット単位で作り直す (stopAudio の closeSpeakerLipSyncAnalyser でクリーンアップ)。
function setupSpeakerLipSyncAnalyser(audio) {
  // BGM 側が既に analyser を握っているなら触らない。シーン単位で先に立っている。
  if (state.playbackAnalyserOwner === "bgm") return null;
  // 直前カットの speaker analyser が残っていれば閉じる (通常は stopAudio 経由で
  // 既に閉じているが、防御的に）。
  closeSpeakerLipSyncAnalyser();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    // 話者音声経路は出力 mix にも残す (BGM 用とは違い、音は普通に流したい)。
    analyser.connect(ctx.destination);
    state.playbackAudioContext = ctx;
    state.playbackAnalyser = analyser;
    state.playbackAnalyserBuffer = new Float32Array(analyser.fftSize);
    state.playbackAnalyserOwner = "speaker";
    return analyser;
  } catch (error) {
    console.warn("Speaker lip-sync analyser unavailable", error);
    return null;
  }
}

function closeSpeakerLipSyncAnalyser() {
  // owner が "bgm" のときは BGM の AudioContext を閉じてしまわないよう早期 return。
  if (state.playbackAnalyserOwner !== "speaker") return;
  if (state.playbackAudioContext) {
    try { state.playbackAudioContext.close(); } catch (_) { /* ignore */ }
    state.playbackAudioContext = null;
  }
  state.playbackAnalyser = null;
  state.playbackAnalyserBuffer = null;
  state.playbackAnalyserOwner = null;
}

// fetch → Blob → createImageBitmap。<img> 経由よりも:
// カット境界の遅延計測。`window.__spliteCutPerf = true` で有効化。
// 再生ループの 1 イテごとに「前カットの最終 frame → 次カットの最初の frame」
// 区間を分解計測する。phase は順番に loadCut → fetchBundle → fontsReady →
// buildScene → firstFrame。total は beginCutTransition 起点〜firstFrame までの ms。
//
// 出力例:
//   [cut-transition] cut="..." loadCut=8.2 fetchBundle=187.4 fontsReady=0.1 buildScene=412.3 firstFrame=1.1 total=609.1ms
const cutTransitionPerf = {
  enabled: false,
  active: null,
};

function isCutPerfEnabled() {
  return !!window.__spliteCutPerf;
}

function beginCutTransition(cut, indexLabel) {
  if (!isCutPerfEnabled()) {
    cutTransitionPerf.active = null;
    return;
  }
  const text = (cut?.state?.text || "").replace(/\s+/g, " ").slice(0, 16);
  cutTransitionPerf.active = {
    label: text || cut?.id || "(unknown)",
    indexLabel: indexLabel || "",
    t0: performance.now(),
    last: performance.now(),
    phases: [],
  };
}

function markCutPhase(name) {
  const p = cutTransitionPerf.active;
  if (!p) return;
  const now = performance.now();
  p.phases.push([name, now - p.last]);
  p.last = now;
}

function endCutTransition() {
  const p = cutTransitionPerf.active;
  if (!p) return;
  cutTransitionPerf.active = null;
  const total = performance.now() - p.t0;
  const parts = p.phases.map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ");
  const prefix = p.indexLabel ? `[cut-transition] ${p.indexLabel} ` : "[cut-transition] ";
  console.log(`${prefix}cut="${p.label}" ${parts} total=${total.toFixed(1)}ms`);
}

// 動画レイヤー (VL) 系リソース消費の観測。`window.__spliteVLPerf = true` で有効化。
// 再生開始で setInterval、停止で clearInterval。1 秒間隔で 1 行 console.log する。
// Map.size と Set(Map.values()).size を両方出すのは、group 共有で同一 element/provider
// を複数 ID から参照する設計のため、Map.size だけでは実リソース数を過大表示するため。
// 出力例:
//   [vl-perf] vlEls=12(uniq=4) vlProv=12(uniq=4) vlAud=4(uniq=4) audioPrefetch=8
//             sceneBundlePrefetch=3 scenePrefetch=1 vlGroups=4 sceneVlLen=12
const vlPerf = {
  intervalId: null,
};

function isVlPerfEnabled() {
  return !!window.__spliteVLPerf;
}

function _logVlPerfSample() {
  if (!isVlPerfEnabled()) return;
  const els = state.playbackVideoLayerEls;
  const provs = state.playbackVideoLayerProviders;
  const auds = state.playbackVideoLayerAudios;
  const elsUniq = new Set(els.values()).size;
  const provsUniq = new Set(provs.values()).size;
  const audsUniq = new Set(auds.values()).size;
  const sceneVl = state.scenario?.videoLayers;
  const sceneVlLen = Array.isArray(sceneVl) ? sceneVl.length : 0;
  let groupCount = 0;
  try {
    groupCount = _groupSameSrcContiguousVideoLayers(sceneVl || []).length;
  } catch (_) { /* ignore */ }
  console.log(
    `[vl-perf] vlEls=${els.size}(uniq=${elsUniq})`
    + ` vlProv=${provs.size}(uniq=${provsUniq})`
    + ` vlAud=${auds.size}(uniq=${audsUniq})`
    + ` audioPrefetch=${audioPrefetchCache.size}`
    + ` sceneBundlePrefetch=${bundleScheduler.size}`
    + ` scenePrefetch=${sceneInstancePrefetchCache.size}`
    + ` vlGroups=${groupCount}`
    + ` sceneVlLen=${sceneVlLen}`,
  );
}

function startVlPerfTimer() {
  if (vlPerf.intervalId != null) return;
  // フラグ後付け有効化を許すため、毎 tick で isVlPerfEnabled を再チェック。
  vlPerf.intervalId = window.setInterval(_logVlPerfSample, 1000);
}

function stopVlPerfTimer() {
  if (vlPerf.intervalId == null) return;
  window.clearInterval(vlPerf.intervalId);
  vlPerf.intervalId = null;
}

// プロジェクト切替時 / 再生開始時に呼ぶ汎用 cleanup。scene-bundle prefetch と
// 音声 prefetch を一括で破棄する。app-state.js もここを叩く。
export function clearPreviewLayerCache() {
  clearSceneBundlePrefetchCache();
  clearAudioPrefetchCache();
  clearPrefetchedSceneInstances();
}

function generateBlinkStarts(duration) {
  const starts = [];
  let cursor = 1.5 + Math.random() * 2.0;
  while (cursor < duration) {
    starts.push(cursor);
    cursor += 2.5 + Math.random() * 2.5;
  }
  return starts;
}

// キャラ ID 配列ぶんの blink schedule を独立に生成する。
// 2 人以上を同時に出したときに同じ瞬間にまばたきする不自然さを避けるため、
// 各キャラごとに初期 phase + 間隔を独立な Math.random() で振る。
// 再現性は不要なので seed なし。再生のたびに違っても OK。
function generateBlinkStartsByChar(duration, charIds) {
  const byChar = {};
  if (!Array.isArray(charIds)) return byChar;
  for (const id of charIds) {
    if (!id) continue;
    byChar[id] = generateBlinkStarts(duration);
  }
  return byChar;
}

// 目パチパターンを返す。
//   algorithm="anime"   : アニメ業界の鉄則「開き→閉じ→中→開き」(スナップ閉じ + 段階開き)。
//                          中目なしキャラは呼び出し側の fallback で half→closed に倒れ、
//                          「2段目パチ」になる。
//   algorithm="uniform" : 各 fps で均等な短い目パチ。中目なしキャラはさらに短くなり、
//                          中目ありキャラとはパターン長そのものが異なる。
//                          (12fps 中目あり=closed,half / 12fps 中目なし=closed,closed)
export function blinkPattern(animationFps, algorithm = "anime", hasHalf = true) {
  const fps = Number(animationFps) || 12;
  if (algorithm === "uniform") {
    if (hasHalf) {
      // 8fps と 24fps はアニメ方式と同じ。12fps だけ closed×1, half×1 に短縮。
      if (fps <= 8) return ["closed", "half"];
      if (fps <= 12) return ["closed", "half"];
      return ["closed", "closed", "closed", "half", "half", "half"];
    }
    if (fps <= 8) return ["closed"];
    if (fps <= 12) return ["closed", "closed"];
    return ["closed", "closed", "closed"];
  }
  if (fps <= 8) return ["closed", "half"];
  if (fps <= 12) return ["closed", "closed", "half"];
  return ["closed", "closed", "closed", "half", "half", "half"];
}

export function eyeKeyForTime(t, blinkStarts, animationFps, algorithm = "anime", hasHalf = true) {
  // anim fps 単位の frame index に量子化。1e-6 epsilon は浮動小数点の誤差で
  // 「frame の境界に乗ったが Math.floor で 1 frame 早く判定」を防ぐため。
  const fps = Number(animationFps) || 12;
  const frameIdx = Math.floor(t * fps + 1e-6);
  const pattern = blinkPattern(fps, algorithm, hasHalf);
  for (const startSec of blinkStarts) {
    const startFrame = Math.round(startSec * fps);
    const offset = frameIdx - startFrame;
    if (offset >= 0 && offset < pattern.length) return pattern[offset];
  }
  return "open";
}

function rmsToNormalizedDb(rms, lipSync) {
  if (!rms || rms <= 0) return 0;
  const dbFloor = Number(lipSync?.dbFloor ?? -55);
  const dbCeil = Number(lipSync?.dbCeil ?? -18);
  const ceil = dbCeil <= dbFloor ? dbFloor + 1 : dbCeil;
  const db = 20 * Math.log10(rms);
  if (!Number.isFinite(db) || db <= dbFloor) return 0;
  if (db >= ceil) return 1;
  return (db - dbFloor) / (ceil - dbFloor);
}

function sampleAudioVolume(lipSync) {
  const analyser = state.playbackAnalyser;
  const buffer = state.playbackAnalyserBuffer;
  if (!analyser || !buffer) {
    state.playbackVolumeSmoothed = 0;
    state.playbackVolumeCurrent = null;
    state.playbackVolumeDb = null;
    return null;
  }
  if (typeof analyser.getFloatTimeDomainData !== "function") return null;
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sum / buffer.length);
  // 生 RMS の dB 値も保持（メーターの数値表示で使う）。
  const dbRaw = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  state.playbackVolumeDb = dbRaw;
  const normalized = rmsToNormalizedDb(rms, lipSync);
  const smoothing = Math.max(0, Math.min(0.45, Number(lipSync?.smoothing ?? 0.2)));
  const previous = state.playbackVolumeSmoothed ?? 0;
  const center = 1.0 - smoothing * 2;
  const smoothed = previous * smoothing + normalized * center + normalized * smoothing;
  state.playbackVolumeSmoothed = smoothed;
  state.playbackVolumeCurrent = normalized;
  return smoothed;
}

function currentAudioVolume() {
  return state.playbackVolumeSmoothed ?? null;
}

function mouthKeyFromVolume(volume, lipSync) {
  // analyser 未セットアップ / 無音区間 / 全体口パク OFF → "default" (= カット選択の口)。
  // scene-builder 側が non-speaker / 全体 OFF も "default" に倒すので、ここでは
  // 「speaker かつ口パク有効、analyser から volume が取れている」前提の値変換のみ。
  if (volume == null) return "default";
  const silence = Number(lipSync?.silenceThreshold ?? 0.08);
  const open = Number(lipSync?.openThreshold ?? 0.42);
  if (volume < silence) return "default";
  if (volume < open) return "mid";
  return "open";
}

// =============================================================================
// preview smoothing overlay (2026-05-24): WebGL canvas を CSS で縮小表示すると
// 環境によってはアンチエイリアスが効かずポリゴンエッジがジャギーに見える
// (特に Windows + ANGLE)。全体設定 preview.smoothing="smooth" のとき、
// 同じ preview-frame に 2D canvas overlay を重ね、毎フレーム drawImage で
// 高品質バイリニア縮小をかける。
// =============================================================================
let _smoothingRaf = 0;
let _smoothingObserver = null;
let _smoothingActive = false;

function _smoothingResize() {
  const dst = elements.livePreviewSmoothCanvas;
  const src = elements.livePreviewWebglCanvas;
  if (!dst || !src) return;
  const rect = dst.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.min(src.width || 1920, Math.round(rect.width * dpr)));
  const h = Math.max(1, Math.min(src.height || 1080, Math.round(rect.height * dpr)));
  if (dst.width !== w) dst.width = w;
  if (dst.height !== h) dst.height = h;
}

function _smoothingDraw() {
  const dst = elements.livePreviewSmoothCanvas;
  const src = elements.livePreviewWebglCanvas;
  if (!_smoothingActive || !dst || !src) {
    _smoothingRaf = 0;
    return;
  }
  _smoothingResize();
  const ctx = dst.getContext("2d");
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, dst.width, dst.height);
  } catch (_e) { /* GL canvas が tainted 等のとき */ }
  _smoothingRaf = requestAnimationFrame(_smoothingDraw);
}

function startPreviewSmoothing() {
  if (_smoothingActive) return;
  const dst = elements.livePreviewSmoothCanvas;
  const src = elements.livePreviewWebglCanvas;
  if (!dst || !src) return;
  _smoothingActive = true;
  // GL canvas は opacity:0 で透明化する (見た目は dst の smooth canvas が担う)。
  // ★ visibility:hidden / hidden 属性は使わない:
  //   - visibility:hidden の要素はポインタイベントを受け取らないため、上に重なる
  //     dst (pointer-events:none) を素通りしたイベントも GL canvas に届かず、
  //     preview-interactions.js のキャラドラッグが smooth モードで一切効かなくなる。
  //   - hidden 属性は renderer の初期化フローと干渉する。
  //   opacity:0 なら hit-test 対象として残るので、ドラッグ判定はそのまま機能する。
  //   drawImage は canvas のバックバッファを読むので CSS opacity の影響を受けない。
  src.style.opacity = "0";
  dst.hidden = false;
  dst.style.visibility = "visible";
  if (typeof ResizeObserver === "function" && !_smoothingObserver) {
    _smoothingObserver = new ResizeObserver(() => _smoothingResize());
    _smoothingObserver.observe(dst);
  }
  _smoothingResize();
  if (!_smoothingRaf) _smoothingRaf = requestAnimationFrame(_smoothingDraw);
}

function stopPreviewSmoothing() {
  if (!_smoothingActive) return;
  _smoothingActive = false;
  if (_smoothingRaf) {
    cancelAnimationFrame(_smoothingRaf);
    _smoothingRaf = 0;
  }
  if (_smoothingObserver) {
    try { _smoothingObserver.disconnect(); } catch (_e) {}
    _smoothingObserver = null;
  }
  const dst = elements.livePreviewSmoothCanvas;
  const src = elements.livePreviewWebglCanvas;
  if (dst) dst.hidden = true;
  if (src) src.style.opacity = "";
}

// 全体設定 preview.smoothing を読んで開始/停止を切替。設定保存後 / 起動時 /
// showLivePreviewCanvas(true) の各タイミングで呼ばれる。
export function applyPreviewSmoothingFromConfig() {
  const mode = String(state.globalConfig?.config?.preview?.smoothing || "sharp").toLowerCase();
  if (mode === "smooth") startPreviewSmoothing();
  else stopPreviewSmoothing();
}

function showLivePreviewCanvas(show) {
  // v2 (WebGL) 描画。
  //   show=true: GL canvas を出して previewImage を隠す。
  //   show=false: GL canvas / video / previewImage を全部畳んで still GL frame の
  //     残像を消す。素材不足ガード / プロジェクトクリア / hard stop から呼ぶ。
  //
  // 注: 「通常停止後も still render を維持する」要件 (memory
  // feedback_v2_thumbnail_video_sync) があるので、通常 stopPreviewPlayback では
  // ここを呼ばないこと。hard モードからのみ呼ぶ。
  if (show) {
    if (elements.livePreviewWebglCanvas) elements.livePreviewWebglCanvas.hidden = false;
    if (elements.previewImage) elements.previewImage.style.visibility = "hidden";
    // smoothing が有効ならここで overlay を開始 (= 描画開始タイミング)
    applyPreviewSmoothingFromConfig();
    return;
  }
  stopPreviewSmoothing();
  // ★ hide 経路では in-flight な renderPreviewV2 を確実に無効化する。
  //   previewRequestId をインクリメントしておけば、後追い完了した renderPreviewV2
  //   が `state.previewRequestId !== requestId` で skip されて
  //   `showLivePreviewCanvas(true)` を呼ばなくなる。
  state.previewRequestId = (state.previewRequestId || 0) + 1;
  if (elements.livePreviewWebglCanvas) elements.livePreviewWebglCanvas.hidden = true;
  if (elements.livePreviewVideo) {
    try { elements.livePreviewVideo.pause(); } catch (_) { /* ignore */ }
    elements.livePreviewVideo.removeAttribute("src");
    delete elements.livePreviewVideo.dataset.currentSrc;
    try { elements.livePreviewVideo.load(); } catch (_) { /* ignore */ }
    elements.livePreviewVideo.hidden = true;
  }
  if (elements.previewImage) elements.previewImage.style.visibility = "";
  if (_v2ModulePromise) {
    // v2 module 未ロードなら no-op。ロード済なら active scene を dispose して
    // texture / RT を解放する (= 次回描画で再 build される)。
    _v2ModulePromise.then((mod) => mod.disposeActiveScene()).catch(() => {});
  }
}

// video element の DOM 属性 (src / muted / objectFit / loop / playbackRate) を
// 共通設定する。再生用 / 静止画用の両方から呼ぶ helper。
function _applyVideoTrackAttrs(videoEl, videoTrack) {
  const src = videoTrack.src.startsWith("/") ? videoTrack.src : `/assets/${videoTrack.src}`;
  if (videoEl.dataset.currentSrc !== src) {
    videoEl.src = src;
    videoEl.dataset.currentSrc = src;
  }
  videoEl.hidden = false;
  videoEl.muted = videoTrack.muted !== false;
  videoEl.playbackRate = Number(videoTrack.speed) || 1;
  videoEl.style.objectFit = videoTrack.fit === "fill" ? "fill" : (videoTrack.fit === "contain" ? "contain" : "cover");
  videoEl.loop = videoTrack.loop === "loop";
}

// scene-global 時刻 (秒) を video element の currentTime に写す。
// renderer/video-provider.js の WebCodecsVideoProvider._mapSceneSecToVideoSec と
// 数式を揃え、preview 経路と export 経路で同じループ位相にする。
// videoDuration が未知 (loadedmetadata 前) は modulo できないので raw 値を返す。
export function mapSceneSecToVideoSec(videoTrack, sceneSec, videoDuration) {
  const trimStart = Math.max(0, Number(videoTrack.trimStartSec) || 0);
  const speed = Number(videoTrack.speed) || 1;
  let videoSec = trimStart + Math.max(0, Number(sceneSec) || 0) * speed;
  const total = Number(videoDuration) || 0;
  if (total > 0 && videoSec >= total) {
    videoSec = videoTrack.loop === "loop"
      ? videoSec % total
      : Math.max(0, total - 1e-3);
  }
  return Math.max(0, videoSec);
}

// 再生 (playLiveCut / playLiveCutV2) 専用。play() を呼ぶので連続的に decode され、
// VideoTexture も毎フレーム sample で追従する。await 不要。
//
// sceneSec はカットの「scene-global 時刻」 (= タイムライン秒)。**カット先頭での
// 値だけでなく、再生再開時の playhead 位置も渡せる**ように設計する。
//
// 重要: 連続再生中の **カット境界では原則 seek しない** こと。理由は、背景動画が
// scene 全体時間より短くてループする場合、cutStartSec(cut) を毎回 currentTime に
// 書くと「ループ末尾 → 0 へ巻き戻り → 即 cutStartSec へ seek 戻し → またループ
// 末尾」という発振パターンになり、ユーザから見るとカット境界で動画が頭出しに
// 戻り続けるバグが発生する (2026-05-12 報告)。
//
// seek するのは以下の三条件のいずれかが満たされた時のみ:
//   1. 別 videoTrack に切替 (= dataset.currentSrc が変わった)
//   2. video が一時停止状態 (= 再生再開直後 / 初回 play()。playhead 任意位置あり)
//   3. drift がしきい値 (0.25s ≒ 24fps で 6 frame) を超えた (= seek 等で playhead が
//      大きく動いた、または decode 遅延で video が現実から遅れた)
function setupLivePreviewVideo(videoTrack, sceneSec) {
  const videoEl = elements.livePreviewVideo;
  if (!videoEl) return null;
  if (!videoTrack || !videoTrack.src) {
    videoEl.hidden = true;
    return null;
  }
  const prevSrc = videoEl.dataset.currentSrc || "";
  _applyVideoTrackAttrs(videoEl, videoTrack);
  const srcChanged = videoEl.dataset.currentSrc !== prevSrc;

  const dur = Number(videoEl.duration);
  const hasDuration = Number.isFinite(dur) && dur > 0;
  // duration 未取得時は modulo できないので生値で fallback (loadedmetadata で再 seek)。
  const target = hasDuration
    ? mapSceneSecToVideoSec(videoTrack, sceneSec, dur)
    : Math.max(0, Number(videoTrack.trimStartSec) || 0)
      + Math.max(0, Number(sceneSec) || 0) * (Number(videoTrack.speed) || 1);
  const drift = Math.abs((Number(videoEl.currentTime) || 0) - target);

  const SEEK_DRIFT_THRESHOLD_SEC = 0.25;
  const needsSeek = srcChanged || videoEl.paused || drift > SEEK_DRIFT_THRESHOLD_SEC;

  if (needsSeek) {
    if (!hasDuration && srcChanged) {
      // metadata 未満 → modulo できない。loadedmetadata 後に改めて seek する。
      const onMeta = () => {
        videoEl.removeEventListener("loadedmetadata", onMeta);
        const newDur = Number(videoEl.duration);
        videoEl.currentTime = (Number.isFinite(newDur) && newDur > 0)
          ? mapSceneSecToVideoSec(videoTrack, sceneSec, newDur)
          : target;
      };
      videoEl.addEventListener("loadedmetadata", onMeta, { once: true });
    } else {
      videoEl.currentTime = target;
    }
  }

  videoEl.play().catch((error) => console.warn("Video preview failed", error));
  return videoEl;
}

// 停止中の still render 専用。play() を呼ばず、target time にひと呼吸で seek し、
// VideoTexture が掴める状態 (HAVE_CURRENT_DATA + 1 frame 進んだ) で resolve する。
// 全体に対して timeoutMs (既定 1500ms) でクランプ。各工程で個別 timeout を持た
// ないので、worst case でも 1.5s で抜ける。
async function prepareVideoFrameForStill(videoTrack, targetTime, timeoutMs = 1500) {
  const videoEl = elements.livePreviewVideo;
  if (!videoEl) return null;
  if (!videoTrack || !videoTrack.src) {
    videoEl.hidden = true;
    return null;
  }
  _applyVideoTrackAttrs(videoEl, videoTrack);
  try { videoEl.pause(); } catch (_) { /* ignore */ }
  const target = Math.max(0, Number(targetTime) || 0);

  // 全体を Promise.race(work, timeout) でクランプ。timeout 側は値を返さず、
  // work が中途で resolve しても videoEl 側は seek/decode を継続するので
  // VideoTexture 側で次の sample 時に最新フレームへ追いつく。
  const work = (async () => {
    // 1) metadata 未満なら readiness を待つ (currentTime 代入が反映されないため)
    if (videoEl.readyState < 1 /* HAVE_METADATA */) {
      await new Promise((resolve) => {
        const done = () => { videoEl.removeEventListener("loadedmetadata", done); resolve(); };
        videoEl.addEventListener("loadedmetadata", done, { once: true });
      });
    }
    // 2) seek (target とずれていれば現在位置を更新)
    if (Math.abs(videoEl.currentTime - target) > 0.001) {
      await new Promise((resolve) => {
        const done = () => { videoEl.removeEventListener("seeked", done); resolve(); };
        videoEl.addEventListener("seeked", done, { once: true });
        try { videoEl.currentTime = target; } catch (_) { resolve(); }
      });
    }
    // 3) HAVE_CURRENT_DATA (= 2) を待つ。seeked 完了後はほぼ即時に到達する。
    if (videoEl.readyState < 2) {
      await new Promise((resolve) => {
        const done = () => {
          videoEl.removeEventListener("loadeddata", done);
          videoEl.removeEventListener("canplay", done);
          resolve();
        };
        videoEl.addEventListener("loadeddata", done, { once: true });
        videoEl.addEventListener("canplay", done, { once: true });
      });
    }
    // 4) RAF 1 回で paint pipeline を 1 段進める。これで VideoTexture が次の
    //    sample 時に「seek 後フレーム」を取り込めるようになる。RAF×2 や
    //    requestVideoFrameCallback まで待つと paused video で永久 stuck する
    //    環境があるので、RAF×1 で打ち切るのが実用的。
    await new Promise((resolve) => requestAnimationFrame(resolve));
  })();
  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return videoEl;
}

// /api/video-duration を引いて state.videoLayerDurations に memoize する。
// 同じ src に対する concurrent fetch は videoLayerDurationFetching でガード。
// 解決済み / fetch 中なら何もしない (fire-and-forget)。
// fetch 成功で停止中なら renderPreview を再発火 (停止中 still render は次 tick が
// 来ないので、duration が後から入っても videoLayer plane が出てこない問題への対処)。
async function _fetchVideoLayerDuration(src) {
  if (!src) return;
  if (state.videoLayerDurations.has(src)) return;
  if (state.videoLayerDurationFetching.has(src)) return;
  state.videoLayerDurationFetching.add(src);
  let resolved = false;
  try {
    const res = await fetch(`/api/video-duration?path=${encodeURIComponent(src)}`);
    if (res.ok) {
      const data = await res.json();
      state.videoLayerDurations.set(src, {
        duration: Number(data.duration) || 0,
        width: Number(data.width) || 0,
        height: Number(data.height) || 0,
        hasAudio: !!data.hasAudio,
      });
      resolved = true;
    }
  } catch (_) {
    /* ignore: 失敗時は次回 build で再試行 */
  } finally {
    state.videoLayerDurationFetching.delete(src);
  }
  // 停止中は再生 tick で自然 visible に戻らないので、解決後にもう一度 still render。
  // 再生中は次フレームで scene.update が durationSec を見直して自動で visible になる。
  if (resolved && !state.isPlaying) {
    Promise.resolve().then(() => {
      try { renderPreview(); } catch (_) { /* ignore */ }
    });
  }
}


// VL preview audio (= clean PCM + source→stream map) の info fetch。
// `<video>` の内蔵 audio を捨てて、別 `<audio src=/cache/clean_pcm/...wav>` で
// 再生するため、サーバから url + mapInfo を取って memoize する。同 src の concurrent
// fetch は in-flight Promise で dedup する。
async function _fetchCleanPcmInfo(src) {
  if (!src) return null;
  if (state.playbackVideoLayerAudioInfo.has(src)) {
    return state.playbackVideoLayerAudioInfo.get(src);
  }
  const pending = state.playbackVideoLayerAudioFetching.get(src);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(`/api/clean-pcm-info?path=${encodeURIComponent(src)}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.url || !data.mapInfo) return null;
      const info = { url: String(data.url), mapInfo: data.mapInfo };
      state.playbackVideoLayerAudioInfo.set(src, info);
      // 停止中なら preview を 1 回再発火して audio を attach し直す。
      if (!state.isPlaying) {
        Promise.resolve().then(() => {
          try { renderPreview(); } catch (_) { /* ignore */ }
        });
      }
      return info;
    } catch (_) {
      return null;
    } finally {
      state.playbackVideoLayerAudioFetching.delete(src);
    }
  })();
  state.playbackVideoLayerAudioFetching.set(src, p);
  return p;
}

// scene の videoLayers をプレビュー用に準備する。
// 1) 各 layer の duration を /api/video-duration で fetch (memoize)
// 2) HTMLVideoElement を ensure (per-layer)
// 3) sync (初回 seek + 再生中なら play)
// 4) per-layer VideoTextureProvider を作って Map で返す
//
// 既存の HTMLVideoElement は state.playbackVideoLayerEls に残り続けるので、
// VideoTextureProvider を毎回新規に作っても元素は揺らがない。
// 戻り値: { providersById: Map<id, VideoTextureProvider> }
// 停止中の still preview 用に、video element を「metadata → seeked → HAVE_CURRENT_DATA
// → RAF×1」のチェーンで確実に target time に合わせる。背景動画の
// prepareVideoFrameForStill と同じ思想の per-layer 版。currentTime 代入だけだと
// 「seek 完了前の初期 frame」「decode 未完了の黒 frame」が GL に上がる事故が起きる。
// 全体タイムアウト timeoutMs (= 1500ms) でクランプ。
async function _prepareVideoLayerElForStill(videoEl, targetTime, timeoutMs = 1500) {
  if (!videoEl) return;
  try { videoEl.pause(); } catch (_) { /* ignore */ }
  const target = Math.max(0, Number(targetTime) || 0);

  const work = (async () => {
    // 1) metadata
    if (videoEl.readyState < 1) {
      await new Promise((resolve) => {
        const done = () => { videoEl.removeEventListener("loadedmetadata", done); resolve(); };
        videoEl.addEventListener("loadedmetadata", done, { once: true });
      });
    }
    // 2) seek (target とずれていれば現在位置を更新)
    if (Math.abs(videoEl.currentTime - target) > 0.001) {
      await new Promise((resolve) => {
        const done = () => { videoEl.removeEventListener("seeked", done); resolve(); };
        videoEl.addEventListener("seeked", done, { once: true });
        try { videoEl.currentTime = target; } catch (_) { resolve(); }
      });
    }
    // 3) HAVE_CURRENT_DATA (= 2) を待つ
    if (videoEl.readyState < 2) {
      await new Promise((resolve) => {
        const done = () => {
          videoEl.removeEventListener("loadeddata", done);
          videoEl.removeEventListener("canplay", done);
          resolve();
        };
        videoEl.addEventListener("loadeddata", done, { once: true });
        videoEl.addEventListener("canplay", done, { once: true });
      });
    }
    // 4) RAF×1 で paint pipeline を 1 段進める (VideoTexture が seek 後 frame を取り込む)
    await new Promise((resolve) => requestAnimationFrame(resolve));
  })();
  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// scene: 元の scene 全体 (videoLayers 全件を持つ可能性あり)。
// sceneSec: focus 時刻 (= still preview の表示時刻 / 再生開始時刻)。
// options.windowedLayers: 呼び出し側が事前に時間窓フィルタを掛けた subset (A1)。
//   渡されたときは scene.videoLayers を使わず、これを正解として扱う。
//   未指定なら旧挙動 (= scene.videoLayers 全件) にフォールバック。
async function prepareVideoLayersForPreview(scene, sceneSec, options = {}) {
  const allLayers = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  const layers = Array.isArray(options.windowedLayers)
    ? options.windowedLayers
    : allLayers;
  if (!layers.length) {
    // 過去 scene の el / provider を全解放 (= 窓に入る VL が 0 件なら確実に空にする)
    releaseAllVideoLayerEls();
    return { providersById: new Map() };
  }
  // duration fetch (非同期、await しない)。未解決のものは build 後の同期で
  // mesh.visible が false のままになり、解決後の次フレームで自然に visible に。
  // clean PCM info (= VL audio 用) も同じく非同期 fetch。取得後 renderPreview()
  // 再発火 (停止中) or 次フレーム sync (再生中) で audio が attach される。
  for (const layer of layers) {
    if (layer?.src) {
      if (!state.videoLayerDurations.has(layer.src)) {
        _fetchVideoLayerDuration(layer.src);
      }
      if (!state.playbackVideoLayerAudioInfo.has(layer.src)) {
        _fetchCleanPcmInfo(layer.src);
      }
    }
  }
  // A1: ensureVideoLayerEls には窓フィルタ後の videoLayers を持つ scene を渡す。
  // これにより wantedIds から窓外 VL が抜け、`<video>` / clean PCM `<audio>` も窓外は
  // _disposeVideoLayerEl で破棄される。
  const scopedScene = (options.windowedLayers && scene)
    ? { ...scene, videoLayers: layers }
    : scene;
  ensureVideoLayerEls(scopedScene);
  syncVideoLayerEls(layers, sceneSec, 24, state.isPlaying);

  // ★ 停止中は active layer の seek を「metadata → seeked → HAVE_CURRENT_DATA → RAF」
  //    で必ず待つ。currentTime 代入だけだと VideoTexture が初期フレーム / 黒 / 未表示
  //    のまま GL に上がる (背景動画は prepareVideoFrameForStill で同等処理済み)。
  //    duration が未解決 / inactive / ended の layer は visible=false で plane が出ない
  //    ので skip。
  if (!state.isPlaying) {
    const { mapVideoLayerSec } = await import("/static/js/renderer/video-layer-time.js");
    const stillWaits = [];
    for (const layer of layers) {
      if (!layer?.id || !layer?.src) continue;
      const el = state.playbackVideoLayerEls.get(layer.id);
      if (!el) continue;
      const meta = state.videoLayerDurations.get(layer.src);
      const dur = meta?.duration || 0;
      if (dur <= 0) continue;
      const result = mapVideoLayerSec(layer, sceneSec, 24, dur);
      if (result.state !== "active") continue;
      stillWaits.push(_prepareVideoLayerElForStill(el, result.videoSec));
    }
    if (stillWaits.length > 0) {
      await Promise.all(stillWaits);
    }
  }

  const { VideoTextureProvider } = await import("/static/js/renderer/video-provider.js");

  // ★ provider を「id 単位で再利用」する。
  //   renderPreviewV2 が同じ token の scene を reuse することがあるが、その scene 内の
  //   plane は既存 provider の texture を参照したまま生きている。ここで前回 provider を
  //   一括 dispose してから new すると、scene reuse 経路で「次の build まで」texture が
  //   壊れた状態になる (duration fetch 完了 → renderPreview 再発火が同じ token になる
  //   ケースで顕在化)。同じ HTMLVideoElement に対しては provider をそのまま使い回す。
  const wantedIds = new Set();
  for (const layer of layers) {
    if (layer?.id) wantedIds.add(layer.id);
  }
  // 不要になった id の provider のみ dispose
  for (const [id, p] of Array.from(state.playbackVideoLayerProviders.entries())) {
    if (wantedIds.has(id)) continue;
    try { p.dispose(); } catch (_) { /* ignore */ }
    state.playbackVideoLayerProviders.delete(id);
  }
  // group 共有 element に合わせて provider も group 共有する (= GPU texture を
  // 重複作成しない / 境界で texture 切替が起きない)。
  const groups = _groupSameSrcContiguousVideoLayers(layers);
  const providersById = new Map();
  for (const g of groups) {
    const primaryId = g.layerIds[0];
    const el = state.playbackVideoLayerEls.get(primaryId);
    if (!el) continue;
    let provider = state.playbackVideoLayerProviders.get(primaryId);
    // HTMLVideoElement が差し替わっていた (ensureVideoLayerEls で src 変更で再生成
    // された) 場合は古い provider の texture が別 element 参照のまま残るので作り直す。
    if (provider && provider.videoElement !== el) {
      try { provider.dispose(); } catch (_) { /* ignore */ }
      provider = null;
    }
    if (!provider) {
      provider = new VideoTextureProvider(el);
    }
    // group 全 ID で同 provider を共有
    for (const id of g.layerIds) {
      state.playbackVideoLayerProviders.set(id, provider);
      providersById.set(id, provider);
    }
  }
  return { providersById };
}

// =============================================================================
// 動画レイヤー (videoLayers) の preview lifecycle 管理
//
// scene 単位で per-layer の HTMLVideoElement を `state.playbackVideoLayerEls` Map
// に保持する。scene 切替 / プレビュー停止 / プロジェクト切替で releaseVideoLayerEls
// を呼んで解放する。
//
// 重なり禁止は同一 `layer` 内のみなので、複数本同時に active になり得るが、
// 実装は per-layer instance を独立に持つ単純な方針。
// =============================================================================
import { mapVideoLayerSec } from "/static/js/renderer/video-layer-time.js";
import { sourceToStreamTime } from "/static/js/renderer/source-stream-time.js";

const VIDEO_LAYER_EL_CONTAINER_ID = "videoLayerElContainer";

function _ensureVideoLayerElContainer() {
  // DOM には append しない方針もあるが、Safari は detached <video> の readyState
  // が安定しない事例があるので display:none の隠しコンテナに入れる。
  let container = document.getElementById(VIDEO_LAYER_EL_CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = VIDEO_LAYER_EL_CONTAINER_ID;
    container.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;visibility:hidden;";
    document.body.appendChild(container);
  }
  return container;
}

// 隣接する同一 src の videoLayer を 1 つの `<video>` element + 1 つの provider で
// 共有するためのグルーピング。
// 共有することで、境界 (= split で生まれた continuation layer の継ぎ目) で pause →
// seek → play を踏む必要がなくなり、音声 buffer 残響と次レイヤー先頭の重なりによる
// 「同じ音が一瞬繰り返される」現象が解消する。
//
// マージ条件 (全部満たすときだけ同 group):
//   - src 一致 / layer (= 表示スロット) 一致
//   - timeline 連続 (= 直前の end frame ≈ 次の startFrame、tolerance 1 frame)
//   - 素材内連続 (= 直前 trimEndSec ≈ 次 trimStartSec、tolerance 0.05s)
//   - volume / muted が一致 (= element の audio 設定を切り替える必要が無い)
//   - 境界に fade なし (= 分割で fadeIn/Out を 0 化した綺麗な継ぎ目だけ統合)
//
// 戻り値: [{ src, layerKey, startFrame, trimStartSec, trimEndSec, volume, muted,
//          members: [vl], layerIds: [string] }]
function _groupSameSrcContiguousVideoLayers(layers, fps = 24) {
  if (!Array.isArray(layers)) return [];
  const eligible = layers.filter((l) => l && l.id && l.src);
  if (eligible.length === 0) return [];
  // 表示スロット別に分けて startFrame 昇順
  const byLayer = new Map();
  for (const l of eligible) {
    const key = String(l.layer || "above_bg");
    if (!byLayer.has(key)) byLayer.set(key, []);
    byLayer.get(key).push(l);
  }
  const groups = [];
  for (const [layerKey, list] of byLayer) {
    list.sort((a, b) => (Number(a.startFrame) || 0) - (Number(b.startFrame) || 0));
    let current = null;
    for (const l of list) {
      const startFrame = Math.max(0, Number(l.startFrame) || 0);
      const trimStart = Math.max(0, Number(l.trimStartSec) || 0);
      const rawTrimEnd = l.trimEndSec;
      const trimEnd = (rawTrimEnd != null && rawTrimEnd !== "")
        ? Number(rawTrimEnd) : null;
      const volume = Number.isFinite(Number(l.volume)) ? Number(l.volume) : 1.0;
      const muted = !!l.muted;
      const fadeIn = !!l.fadeInEnabled;
      const fadeOut = !!l.fadeOutEnabled;
      const canMerge = current
        && current.src === l.src
        && current.layerKey === layerKey
        && Math.abs(current._endFrame - startFrame) <= 1
        && trimEnd != null
        && Math.abs(current.trimEndSec - trimStart) < 0.05
        && Math.abs(current.volume - volume) < 1e-3
        && current.muted === muted
        && !current._lastFadeOut
        && !fadeIn;
      if (canMerge) {
        current.members.push(l);
        current.layerIds.push(l.id);
        current.trimEndSec = trimEnd;
        current._endFrame = current.startFrame
          + Math.round((current.trimEndSec - current.trimStartSec) * fps);
        current._lastFadeOut = fadeOut;
        continue;
      }
      current = {
        src: l.src,
        layerKey,
        startFrame,
        trimStartSec: trimStart,
        trimEndSec: trimEnd != null ? trimEnd : trimStart,
        volume,
        muted,
        members: [l],
        layerIds: [l.id],
        _endFrame: trimEnd != null
          ? (startFrame + Math.round((trimEnd - trimStart) * fps))
          : startFrame,
        _lastFadeOut: fadeOut,
      };
      groups.push(current);
    }
  }
  return groups;
}

function _disposeVideoLayerEl(el) {
  try { el.pause(); } catch (_) {}
  try { el.removeAttribute("src"); el.load(); } catch (_) {}
  try { el.remove(); } catch (_) {}
}

// VL preview audio (= clean PCM `<audio>` element) 用ヘルパ。VL の `<video>` を
// muted=true にして、音だけ別 `<audio>` で再生する。これにより:
//   - preview 通し再生: `<audio>` の通常 decode (= AAC decoder の連続出力)
//   - preview 途中 seek 再生: `audio.currentTime = sourceToStreamTime(source-time)`
//     で stream-time にセット → PTS gap の影響なし
//   - export: 同じ clean PCM + map を使うので 3 経路が stream-time で揃う
function _disposeVideoLayerAudio(audio) {
  try { audio.pause(); } catch (_) {}
  try { audio.removeAttribute("src"); audio.load(); } catch (_) {}
  try { audio.remove(); } catch (_) {}
}

function _getOrCreateVideoLayerAudio(primaryId, url) {
  if (!url) return null;
  let audio = state.playbackVideoLayerAudios.get(primaryId);
  if (!audio) {
    audio = document.createElement("audio");
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audio.dataset.primaryId = primaryId;
    // 画面非表示で OK (= 音だけ使う)
    audio.style.display = "none";
    document.body.appendChild(audio);
    state.playbackVideoLayerAudios.set(primaryId, audio);
  }
  if (audio.dataset.currentSrc !== url) {
    audio.src = url;
    audio.dataset.currentSrc = url;
  }
  return audio;
}

// HTMLAudioElement への seek を `<video>` と同じ「同 target なら投げ直さない」
// パターンで発行する。expando `_splitePendingAudioSeekTarget` を使う (video の
// expando とは別キー)。tolerance は 0.05s — 毎フレームの sceneSec 増分 (~16ms
// @ 60fps) で違う target 扱いになり連発するのを防ぐ。
function _seekVideoLayerAudio(audio, targetSec, tolerance = 0.05) {
  if (!audio) return;
  const target = Math.max(0, Number(targetSec) || 0);
  const cur = Number(audio.currentTime) || 0;
  if (Math.abs(cur - target) <= tolerance) {
    audio._splitePendingAudioSeekTarget = null;
    return;
  }
  const pending = audio._splitePendingAudioSeekTarget;
  if (pending != null && Math.abs(pending - target) <= tolerance) return;
  audio._splitePendingAudioSeekTarget = target;
  const onSettle = () => {
    if (audio._splitePendingAudioSeekTarget != null
        && Math.abs(audio._splitePendingAudioSeekTarget - target) <= tolerance) {
      audio._splitePendingAudioSeekTarget = null;
    }
  };
  audio.addEventListener("seeked", onSettle, { once: true });
  audio.addEventListener("error", onSettle, { once: true });
  try {
    audio.currentTime = target;
  } catch (_) {
    audio._splitePendingAudioSeekTarget = null;
  }
}

function _getOrCreateVideoLayerEl(layerId, src) {
  // 空 src で <video> を作って "/assets/" を src に設定するとブラウザがフォルダ
  // index を取りに行ってフリーズすることがある。必ず非空 src のときだけ要素を作る。
  if (!src) return null;
  const container = _ensureVideoLayerElContainer();
  let el = state.playbackVideoLayerEls.get(layerId);
  const fullSrc = src.startsWith("/") ? src : `/assets/${src}`;
  if (!el) {
    el = document.createElement("video");
    // VL の音は別 `<audio>` element (= clean PCM 経由) で出すため、video element
    // は常に muted=true 固定。`syncVideoLayerEls` で `el.muted` を上書きしないこと。
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.dataset.layerId = layerId;
    container.appendChild(el);
    state.playbackVideoLayerEls.set(layerId, el);
  }
  // 再生中に muted が外れていた場合に備えて毎回固定
  el.muted = true;
  if (el.dataset.currentSrc !== fullSrc) {
    el.src = fullSrc;
    el.dataset.currentSrc = fullSrc;
  }
  return el;
}

/**
 * 現在の scene の videoLayers に対応する HTMLVideoElement を準備する。
 * - 各 layer に対応する <video> を作成/更新
 * - 不要になった layer の <video> を解放
 * - 戻り値は Map<layerId, HTMLVideoElement> (= state.playbackVideoLayerEls の subset view)
 *
 * 再生中・停止中は呼び出し側で制御する (再生中: video.play() を後段で呼ぶ、
 * 停止中: pause + seek)。ここでは src 設定のみ。
 */
export function ensureVideoLayerEls(scene) {
  const layers = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  const groups = _groupSameSrcContiguousVideoLayers(layers);

  // wanted layer ID 集合 (全 group のメンバー)
  const wantedIds = new Set();
  for (const g of groups) {
    for (const id of g.layerIds) wantedIds.add(id);
  }

  // 不要な layer ID を Map から外し、参照が外れた element だけ解放する。
  // (= 同 element が group 内の複数 ID から参照されているとき、片方の id を
  //  削除しただけで element 自体は残す)
  const removalCandidates = [];
  for (const [id, el] of Array.from(state.playbackVideoLayerEls.entries())) {
    if (!wantedIds.has(id)) {
      removalCandidates.push(el);
      state.playbackVideoLayerEls.delete(id);
    }
  }
  const stillReferenced = new Set(state.playbackVideoLayerEls.values());
  const releasedEls = new Set();
  for (const el of removalCandidates) {
    if (stillReferenced.has(el) || releasedEls.has(el)) continue;
    releasedEls.add(el);
    _disposeVideoLayerEl(el);
  }

  // group ごとに element を 1 つ ensure し、group 内の全 layer ID から同 element を
  // 参照させる。primary id (= group の先頭) の element を再利用するのが基本。
  for (const g of groups) {
    if (!g.src) continue;
    const primaryId = g.layerIds[0];
    const expectedSrc = g.src.startsWith("/") ? g.src : `/assets/${g.src}`;
    let el = state.playbackVideoLayerEls.get(primaryId);
    if (el && el.dataset.currentSrc !== expectedSrc) {
      // src 変更: 既存 element を破棄して作り直す。
      _disposeVideoLayerEl(el);
      el = null;
      // 同 group の他 id も古い el を指したまま残らないようクリア
      for (const id of g.layerIds) {
        if (state.playbackVideoLayerEls.get(id) !== el) {
          state.playbackVideoLayerEls.delete(id);
        }
      }
    }
    if (!el) {
      el = _getOrCreateVideoLayerEl(primaryId, g.src);
    }
    if (!el) continue;
    // group 全 ID で同 element を共有 (= boundary で別 element に切替しない)
    for (const id of g.layerIds) {
      state.playbackVideoLayerEls.set(id, el);
    }

    // VL 音声用 `<audio>` element を ensure。clean PCM info が memoize 済みなら
    // 即座に attach、未取得なら fetch をキックして取得後 renderPreview() で再来訪。
    const info = state.playbackVideoLayerAudioInfo.get(g.src);
    if (info) {
      _getOrCreateVideoLayerAudio(primaryId, info.url);
    } else {
      _fetchCleanPcmInfo(g.src);
    }
  }

  // 不要になった audio (group が外れた primary id) を片付ける
  const wantedPrimaryIds = new Set(groups.map((g) => g.layerIds[0]));
  for (const [id, audio] of Array.from(state.playbackVideoLayerAudios.entries())) {
    if (wantedPrimaryIds.has(id)) continue;
    _disposeVideoLayerAudio(audio);
    state.playbackVideoLayerAudios.delete(id);
  }
  return state.playbackVideoLayerEls;
}

/**
 * 全 layer の HTMLVideoElement を解放 (scene 切替 / プロジェクト切替で呼ぶ)。
 * 関連する VideoTextureProvider も同時に解放する。
 */
export function releaseAllVideoLayerEls() {
  // 同 element / 同 provider が group 共有で複数 ID から参照されている可能性が
  // あるので、Set で dedup してから dispose する。
  const disposedProviders = new Set();
  for (const [, p] of state.playbackVideoLayerProviders) {
    if (!p || disposedProviders.has(p)) continue;
    disposedProviders.add(p);
    try { p.dispose(); } catch (_) { /* ignore */ }
  }
  state.playbackVideoLayerProviders.clear();
  const disposedEls = new Set();
  for (const [, el] of state.playbackVideoLayerEls) {
    if (!el || disposedEls.has(el)) continue;
    disposedEls.add(el);
    _disposeVideoLayerEl(el);
  }
  state.playbackVideoLayerEls.clear();
  // VL audio (= clean PCM <audio>) も同時に解放
  const disposedAudios = new Set();
  for (const [, audio] of state.playbackVideoLayerAudios) {
    if (!audio || disposedAudios.has(audio)) continue;
    disposedAudios.add(audio);
    _disposeVideoLayerAudio(audio);
  }
  state.playbackVideoLayerAudios.clear();
}

/**
 * 1 frame 分の同期:
 *   - active なら play() (まだなら) + currentTime を mapVideoLayerSec の値に寄せる
 *   - inactive/ended なら pause + 末尾 frame を seek (freeze) してから停止
 * drift > 0.25s / paused / src 変更時のみ seek。背景動画の経路と同じ思想。
 *
 * @param {object[]} layers scene.videoLayers
 * @param {number} sceneSec 現在の scene-global 秒
 * @param {number} fps PROJECT_FPS
 * @param {boolean} isPlaying state.isPlaying に相当する flag
 */
// HTMLVideoElement への seek を「同じ target なら投げ直さない」形で発行する。
// `el.currentTime = X` は非同期 seek を起こすため、seek 完了前に毎 RAF で同じ値を
// 再代入すると、ブラウザが内部で connect/cancel を繰り返し、再生開始がカクつく
// (分割で trimStart が大きい inactive レイヤーへの pre-seek で踏みやすい)。
//
// expando `_splitePendingSeekTarget` に「現在投げ中の target 秒」を持たせ、`seeked`
// / `error` で解除する。同じ target が来たら早期 return。tolerance は 0.05s。
function _seekVideoLayerElement(el, targetSec, tolerance = 0.05) {
  if (!el) return;
  const target = Math.max(0, Number(targetSec) || 0);
  const cur = Number(el.currentTime) || 0;
  // 既に十分近ければ何もしない (pending もクリアして次の異なる target に備える)
  if (Math.abs(cur - target) <= tolerance) {
    el._splitePendingSeekTarget = null;
    return;
  }
  const pending = el._splitePendingSeekTarget;
  // 同じ target で seek 中なら再投げしない (= 完了を待つ)
  if (pending != null && Math.abs(pending - target) <= tolerance) return;
  el._splitePendingSeekTarget = target;
  const onSettle = () => {
    // 別の target に上書きされた場合は、その target 用の listener に任せる
    // (= ここで何もしないことで二重クリアを避ける)
    if (el._splitePendingSeekTarget != null
        && Math.abs(el._splitePendingSeekTarget - target) <= tolerance) {
      el._splitePendingSeekTarget = null;
    }
  };
  el.addEventListener("seeked", onSettle, { once: true });
  el.addEventListener("error", onSettle, { once: true });
  try {
    el.currentTime = target;
  } catch (_) {
    el._splitePendingSeekTarget = null;
  }
}

export function syncVideoLayerEls(layers, sceneSec, fps, isPlaying) {
  if (!Array.isArray(layers)) return;
  const SEEK_DRIFT_SEC = 0.25;
  // audio 側の seek/anchor 戦略 (2026-05-21 改訂):
  //   - 初回 attach (= audio.paused) または src 切替時にだけ source→stream 変換で
  //     位置決めし、同時に `_spliteAnchor = { sceneSec, streamSec, src }` を保存
  //   - 通常進行中は `expectedStream = anchor.streamSec + (sceneSec - anchor.sceneSec)`
  //     で audio.currentTime と比較。AUDIO_RESET_DRIFT_SEC 越えだけ再 anchor する
  //   - 毎フレーム `sourceToStreamTime(currentSourceSec)` を比較対象にしてはならない
  //     PTS gap 区間で streamSec が頭打ちになる一方 clean PCM は実時間で進むため
  //     drift が累積し、閾値超えで「過去への seek = 微妙な巻き戻り」が連発する
  //     (= ユーザー観察「930f/970f 付近の DJ 巻き戻り」)。
  const AUDIO_RESET_DRIFT_SEC = 2.0;
  // group 単位で seek/play 判定する。同 group の複数 layer が連続しているとき、
  // 個別 layer で pause/seek/play を踏むと境界で audio buffer の残響と次レイヤー
  // 先頭が重なり「同じ音が一瞬繰り返される」現象が出る。
  // group のうち 1 つでも active なメンバーがあれば element を play 継続させる
  // (= 境界で pause しない / element の currentTime はそのまま進ませる)。
  const groups = _groupSameSrcContiguousVideoLayers(layers, fps);
  for (const g of groups) {
    const primaryId = g.layerIds[0];
    const el = state.playbackVideoLayerEls.get(primaryId);
    if (!el) continue;
    const meta = state.videoLayerDurations.get(g.src);
    const dur = meta?.duration || 0;
    if (dur <= 0) continue;
    // VL 音声用 audio element + map info (clean PCM 経路)
    const audio = state.playbackVideoLayerAudios.get(primaryId);
    const info = state.playbackVideoLayerAudioInfo.get(g.src);
    // group 内の各 member を評価し、active なメンバーを見つける。
    // 連続 group では sceneSec が進むほど後続 member に切り替わるだけで、
    // element 自体は同 src を再生し続けている前提なので、active member の
    // videoSec を target にすればよい。
    let activeMember = null;
    let activeResult = null;
    for (const m of g.members) {
      const r = mapVideoLayerSec(m, sceneSec, fps, dur);
      if (r.state === "active") {
        activeMember = m;
        activeResult = r;
        break;
      }
    }
    if (activeMember && activeResult) {
      // 映像側: 既存ロジック (source-time で seek)
      const drift = Math.abs((Number(el.currentTime) || 0) - activeResult.videoSec);
      const needsSeek = el.paused || drift > SEEK_DRIFT_SEC;
      if (needsSeek) {
        _seekVideoLayerElement(el, activeResult.videoSec);
      }
      if (isPlaying && el.paused) {
        el.play().catch(() => { /* autoplay 制限などは無視 */ });
      }
      // muted は常に true 固定 (= 音は audio element で出す)
      el.muted = true;

      // 音声側: clean PCM <audio> を anchor 方式で同期する。
      //
      // 重要 (2026-05-21): `sourceToStreamTime(currentSourceSec)` は PTS gap 区間で
      // 頭打ちになるため、毎フレームこれと `audio.currentTime` を比較するのは誤り。
      // gap に入ると expected 側だけ止まり、実際の clean PCM は 1 sec/sec で進むため
      // drift が累積し、AUDIO_RESET_DRIFT_SEC 越えで「過去への seek = 巻き戻り」が
      // 発火する。代わりに anchor 起点の線形補外と比較する。
      //
      // anchor は「初回 attach / src 切替 / 大幅 jump 検出」の 3 イベントだけで更新
      // し、通常再生中は触らない。これで gap を跨いでも巻き戻らない。
      //
      // **seek + play() レース対策 (2026-05-21)**
      // ブラウザの `<audio>.currentTime = X` 発行中は audio.paused=true になる。
      // この間に `audio.play()` を呼ぶと seek が cancel される → 中途半端な位置で
      // 再生 → drift → 再 seek →… のループ。`_splitePendingAudioSeekTarget` は
      // `_seekVideoLayerAudio` 内で立つので、seek を投げた**後**に再評価して play()
      // 可否を決める (= tick の冒頭で読んだ古い isSeekPending は使わない)。
      if (audio && info && info.mapInfo) {
        const isSeekPendingBefore = audio._splitePendingAudioSeekTarget != null;
        if (!isSeekPendingBefore) {
          const anchor = audio._spliteAnchor;
          const anchorSrc = info.url;
          const anchorValid = anchor && anchor.src === anchorSrc;
          let reseekTarget = null;
          if (audio.paused || !anchorValid) {
            // 初回 attach (停止中) または src 切替: source→stream で位置決め
            reseekTarget = sourceToStreamTime(
              info.mapInfo, activeResult.videoSec, "start",
            );
          } else {
            // 通常再生中は anchor 起点の線形補外と比較する。
            // expectedStream は scene 時刻の進みをそのまま stream 時刻に写すだけで、
            // PTS gap の影響を受けない。
            const expectedStream =
              anchor.streamSec + (sceneSec - anchor.sceneSec);
            const drift = Math.abs(
              (Number(audio.currentTime) || 0) - expectedStream,
            );
            if (drift > AUDIO_RESET_DRIFT_SEC) {
              reseekTarget = sourceToStreamTime(
                info.mapInfo, activeResult.videoSec, "start",
              );
            }
          }
          if (reseekTarget != null) {
            _seekVideoLayerAudio(audio, reseekTarget);
            audio._spliteAnchor = {
              src: anchorSrc,
              sceneSec,
              streamSec: reseekTarget,
            };
          }
          // play/pause は seek を投げた後の pending を再評価してから判定する
          const seekPendingAfter = audio._splitePendingAudioSeekTarget != null;
          if (isPlaying) {
            if (audio.paused && !seekPendingAfter) {
              audio.play().catch(() => { /* autoplay 制限などは無視 */ });
            }
          } else {
            if (!audio.paused) {
              try { audio.pause(); } catch (_) {}
            }
          }
          audio.muted = !!activeMember.muted;
          // 映像側 (_computeVideoLayerAlpha) と同じ式で fadeIn / fadeOut 係数を
          // 算出して base volume に乗じる (= 視覚フェードと音量フェードを同期させる)。
          // 合計が span を越えるケースは特に対策しない (= 互いの係数が低い側で抑制
          // される) ため、export 側のような duration/2 クランプは不要。
          let baseVol = Number(activeMember.volume);
          if (!Number.isFinite(baseVol)) baseVol = 1.0;
          let fadeFactor = 1.0;
          const localSec = Number(activeResult.localSec) || 0;
          const spanSec = Number(activeResult.spanSec) || 0;
          if (activeMember.fadeInEnabled) {
            const fIn = Math.max(0, Number(activeMember.fadeInSec) || 0);
            if (fIn > 0) {
              fadeFactor *= Math.max(0, Math.min(1, localSec / fIn));
            }
          }
          if (activeMember.fadeOutEnabled && spanSec > 0) {
            const fOut = Math.max(0, Number(activeMember.fadeOutSec) || 0);
            if (fOut > 0) {
              const remaining = spanSec - localSec;
              fadeFactor *= Math.max(0, Math.min(1, remaining / fOut));
            }
          }
          audio.volume = Math.max(0, Math.min(1, baseVol * fadeFactor));
        }
        // isSeekPendingBefore=true のときは進行中の seek を待つ (= 何もしない)。
        // 同 tick で別 seek を投げたり play() を呼ぶと seek が cancel されるため。
      }
    } else {
      // group 内に active が無い → 全 member が inactive または ended
      // group の起点 trimStart まで前 seek した上で pause (active 遷移時の
      // keyframe seek を回避)。最後の member が ended なら trimEnd に寄せる。
      let allEnded = true;
      for (const m of g.members) {
        const r = mapVideoLayerSec(m, sceneSec, fps, dur);
        if (r.state !== "ended") { allEnded = false; break; }
      }
      if (!el.paused) {
        try { el.pause(); } catch (_) {}
      }
      const targetSec = allEnded ? g.trimEndSec : g.trimStartSec;
      _seekVideoLayerElement(el, Math.max(0, Number(targetSec) || 0));

      // 音声側も同様に pause + 起点 / 終端 stream-time に寄せる
      if (audio) {
        if (!audio.paused) {
          try { audio.pause(); } catch (_) {}
        }
        if (info && info.mapInfo) {
          const targetStreamSec = sourceToStreamTime(
            info.mapInfo, Math.max(0, Number(targetSec) || 0),
            allEnded ? "end" : "start",
          );
          _seekVideoLayerAudio(audio, targetStreamSec);
        }
      }
    }
  }
}

export function updateAudioMeterThresholds(lipSync) {
  if (!elements.audioMeterSilence || !elements.audioMeterOpen) return;
  const silence = Math.max(0, Math.min(1, Number(lipSync?.silenceThreshold ?? 0.08)));
  const open = Math.max(silence, Math.min(1, Number(lipSync?.openThreshold ?? 0.42)));
  elements.audioMeterSilence.style.left = `${silence * 100}%`;
  elements.audioMeterOpen.style.left = `${open * 100}%`;
  // メーター track の左右端に dbFloor / dbCeil の値を出して両端のスケールを読めるようにする。
  const dbFloor = Number(lipSync?.dbFloor ?? -55);
  const dbCeil = Number(lipSync?.dbCeil ?? -18);
  if (elements.audioMeterScaleMin) {
    elements.audioMeterScaleMin.textContent = `${formatDbForMeter(dbFloor)}`;
  }
  if (elements.audioMeterScaleMax) {
    elements.audioMeterScaleMax.textContent = `${formatDbForMeter(dbCeil)}`;
  }
}

function formatDbForMeter(db) {
  if (!Number.isFinite(db)) return "−∞";
  // 整数寄りに丸めて、必ず符号を表示する（−55 / −18 等）。
  const rounded = Math.round(db);
  const abs = Math.abs(rounded);
  return rounded < 0 ? `−${abs}` : (rounded > 0 ? `+${abs}` : "0");
}

function updateAudioMeterValue(volume) {
  if (!elements.audioMeterFill) return;
  const v = Math.max(0, Math.min(1, Number(volume) || 0));
  elements.audioMeterFill.style.width = `${v * 100}%`;
  // 数値読み取り（dB と norm）の更新。analyser が無効なら無音表記に戻す。
  if (elements.audioMeterDb) {
    const db = state.playbackVolumeDb;
    if (db == null) {
      elements.audioMeterDb.textContent = "−∞";
    } else if (!Number.isFinite(db)) {
      elements.audioMeterDb.textContent = "−∞";
    } else {
      elements.audioMeterDb.textContent = formatDbForMeter(db);
    }
  }
  if (elements.audioMeterNorm) {
    elements.audioMeterNorm.textContent = v.toFixed(2);
  }
}

function resetAudioMeter() {
  state.playbackVolumeDb = null;
  state.playbackVolumeSmoothed = 0;
  state.playbackVolumeCurrent = 0;
  updateAudioMeterValue(0);
}

function sceneIdleMotionConfig() {
  // 体の揺れ (breath / bpmBob) と BPM は bedScope でプロジェクト通しにできるので、
  // 解決済みシーンから読む (dev_docs/plans/multi-scene.md §2)。
  const scene = activeSceneResolved();
  if (!scene) return null;
  return {
    bpm: scene.bpm == null ? null : Number(scene.bpm) || 0,
    breath: scene.breath || null,
    bpmBob: scene.bpmBob || null,
  };
}

// motion "move" の補間状態。startFrame〜startFrame+durationFrame の間で
// startX/Y/Opacity/Rotation/Scale → endX/Y/Opacity/Rotation/Scale を補間し、
//   { dx, dy, opacity, rotationDeg, scaleMul }
// を返す。dx/dy は相対オフセット (= キャラ基準位置に加算)、scaleMul は乗算係数
// (= 1.0 で等倍、0.5 で半分)、rotationDeg は度単位の絶対回転、opacity は 0-1。
function computeMoveOffset(move, elapsedSec) {
  if (!move) return _moveIdentity();
  const startFrame = Math.max(0, Number(move.startFrame) || 0);
  const durationFrame = Math.max(1, Number(move.durationFrame) || 1);
  const startX = Number(move.startX) || 0;
  const startY = Number(move.startY) || 0;
  const endX = Number(move.endX) || 0;
  const endY = Number(move.endY) || 0;
  const startOpacity = _moveClampOpacity(move.startOpacity, 1);
  const endOpacity = _moveClampOpacity(move.endOpacity, 1);
  const startRotation = Number(move.startRotation) || 0;
  const endRotation = Number(move.endRotation) || 0;
  const startScale = _moveClampScale(move.startScale, 1);
  const endScale = _moveClampScale(move.endScale, 1);
  const easing = move.easing || "linear";
  const currentFrame = (Number(elapsedSec) || 0) * PROJECT_FPS;
  if (currentFrame < startFrame) {
    return {
      dx: startX, dy: startY,
      opacity: startOpacity, rotationDeg: startRotation, scaleMul: startScale,
    };
  }
  if (currentFrame >= startFrame + durationFrame) {
    return {
      dx: endX, dy: endY,
      opacity: endOpacity, rotationDeg: endRotation, scaleMul: endScale,
    };
  }
  const tRaw = (currentFrame - startFrame) / durationFrame;
  const t = _applyMoveEasing(Math.max(0, Math.min(1, tRaw)), easing);
  return {
    dx: startX + (endX - startX) * t,
    dy: startY + (endY - startY) * t,
    opacity: startOpacity + (endOpacity - startOpacity) * t,
    rotationDeg: startRotation + (endRotation - startRotation) * t,
    scaleMul: startScale + (endScale - startScale) * t,
  };
}

function _moveIdentity() {
  return { dx: 0, dy: 0, opacity: 1, rotationDeg: 0, scaleMul: 1 };
}

function _moveClampOpacity(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function _moveClampScale(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function _applyMoveEasing(t, easing) {
  switch (easing) {
    case "easeIn":  return t * t;
    case "easeOut": return 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
    case "linear":
    default:        return t;
  }
}

// M-2: 各キャラの character.motion から { dx, dy, scale? } を計算。
// shake_x/y / move / zoom を 1 経路で扱う。scene-builder の motionOffsetByChar に渡す。
function computePerCharacterMotionOffsets(characters, quantizedSec) {
  const result = {};
  for (const char of characters || []) {
    if (!char.id || !char.motion) continue;
    const offset = _computeOneMotion(char.motion, quantizedSec);
    if (offset) result[char.id] = offset;
  }
  return result;
}

function _computeOneMotion(motion, quantizedSec) {
  if (!motion?.type || motion.type === "none") return null;
  const settings = motion.settings || {};
  if (motion.type === "shake_x" || motion.type === "shake_y") {
    const cfg = motion.type === "shake_x" ? (settings.shakeX || {}) : (settings.shakeY || {});
    const amp = Number(cfg.amplitude || 0);
    const count = Number(cfg.count || 0);
    const dur = Number(cfg.duration || 0);
    if (amp > 0 && count > 0 && dur > 0 && quantizedSec < dur) {
      const offset = amp * Math.sin((2 * Math.PI * count * quantizedSec) / dur);
      return motion.type === "shake_x" ? { dx: offset, dy: 0 } : { dx: 0, dy: offset };
    }
    return null;
  }
  if (motion.type === "move") {
    const mo = computeMoveOffset(settings.move, quantizedSec);
    // 全項目が「変化なし」なら null (= scene-builder 側で何も touched しない)。
    if (mo.dx === 0 && mo.dy === 0 && mo.opacity === 1
        && mo.rotationDeg === 0 && mo.scaleMul === 1) {
      return null;
    }
    // 回転 / 拡大の基準点 (= pivot)。settings.move.pivotX/Y が数値なら採用、
    // 無効なら null = scene-builder 側でキャラ basePos を pivot 扱い。
    const rawPivotX = Number(settings.move?.pivotX);
    const rawPivotY = Number(settings.move?.pivotY);
    const pivotX = Number.isFinite(rawPivotX) ? rawPivotX : null;
    const pivotY = Number.isFinite(rawPivotY) ? rawPivotY : null;
    return {
      dx: mo.dx,
      dy: mo.dy,
      scale: mo.scaleMul,            // scene-builder の group.scale 用
      rotationDeg: mo.rotationDeg,    // 度→ラジアン変換は scene-builder で
      opacity: mo.opacity,            // material.uniforms.uOpacity 用
      pivotX, pivotY,                  // null なら basePos 中心 (= 旧挙動)
    };
  }
  if (motion.type === "zoom") {
    const sc = Number(settings.zoom?.scale || 1);
    if (sc > 0 && sc !== 1) return { dx: 0, dy: 0, scale: sc };
    return null;
  }
  return null;
}

function computeIdleMotionOffset(idleMotion, timelineSec) {
  let dy = 0;
  const t = Number(timelineSec) || 0;
  const breath = idleMotion?.breath;
  if (breath) {
    const amp = Math.max(0, Number(breath.amplitudePx) || 0);
    const period = Math.max(0.05, Number(breath.periodSec) || 4);
    if (amp > 0 && period > 0) {
      dy += amp * Math.sin((2 * Math.PI * t) / period);
    }
  }
  const bpm = Number(idleMotion?.bpm) || 0;
  const bob = idleMotion?.bpmBob;
  if (bpm > 0 && bob) {
    const amp = Math.max(0, Number(bob.amplitudePx) || 0);
    if (amp > 0) {
      const period = 60.0 / bpm;
      dy += amp * Math.sin((2 * Math.PI * t) / period);
    }
  }
  return { dx: 0, dy };
}

export async function playLiveCut(cut, options = {}) {
  // 旧 v1 (Pillow + Canvas2D) 経路は撤去済。v2 (WebGL + three.js) のみ。
  return playLiveCutV2(cut, options);
}

// =============================================================================
// renderPreviewV2: 停止中 / カット選択時の still render を v2 GL で行う。
//
// 戻り値: 描画が完了したら true、race / 失敗で skip した場合は false。
// 呼び出し元はこの bool で「実描画後にしか走らせたくない処理」(= サムネ
// 取得など) を直列化する。
// =============================================================================
async function renderPreviewV2(cut, requestId) {
  // 前回 renderPreview の scene-bundle fetch を明示 abort。AbortError は
  // 後続の except で握りつぶす (= 単に古いリクエストが捨てられただけ)。
  _abortPendingSceneBundle();
  const controller = new AbortController();
  _pendingSceneBundleAbort = controller;
  let layerData;
  try {
    layerData = await fetchSceneBundleV2(cut, { signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") return false;
    throw err;
  } finally {
    if (_pendingSceneBundleAbort === controller) {
      _pendingSceneBundleAbort = null;
    }
  }
  if (state.previewRequestId !== requestId) return false;

  // FontFace 待ち (未ロード時に system font に fallback されると意図と違う絵になる)。
  if (state.projectFontsReady) {
    try { await state.projectFontsReady; } catch {}
  }
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch {}
  }
  if (state.previewRequestId !== requestId) return false;

  const canvas = elements.livePreviewWebglCanvas;
  if (!canvas) throw new Error("livePreviewWebglCanvas not found");
  const v2 = await loadRendererV2();
  v2.initRenderer(canvas);

  const sceneVideo = activeSceneResolved()?.videoTrack || null;
  const hasVideoTrack = !!(sceneVideo && sceneVideo.src);
  layerData.hasVideoTrack = hasVideoTrack;
  // 動画レイヤー: A1 の時間窓フィルタを停止プレビューにも適用。
  // 停止中は lookahead=0 (= 現カット + 1 つ前のみ)。再生再開時に
  // playLiveCutV2 が改めて lookahead 付き window で rebuild するので、
  // 停止中の VL provider は最小限で十分。
  const liveSceneForLayersStill = state.scenario || null;
  const { windowedLayers: windowedVideoLayersStill, windowKey: vlWindowKeyStill } =
    _computeVideoLayerWindow(liveSceneForLayersStill, cut, 0);
  layerData.videoLayers = windowedVideoLayersStill;
  const cutStart = cutStartSec(cut);
  const cutDur = cutDurationSec(cut);
  const playhead = Number(state.timeline?.currentSec);
  // 半開区間 (`< cutStart + cutDur`) だと、自動停止で playhead がカット終端ぴったりに
  // 着地したケースで条件が false → previewSec=0 (= カット最初のフレーム) に倒れ、
  // 「停止後に VL が cut 先頭の絵に戻る」現象が起きる (2026-05-21 確認)。
  // 閉区間 (`<=`) に拡張しつつ、frameIdx 計算が範囲を 1 frame だけ超えないよう
  // `cutDur - 1e-3` で clamp する (= 末尾フレームに張り付かせる)。
  const cutDurClamp = Math.max(0, cutDur - 1e-3);
  const previewSec =
    Number.isFinite(playhead) && playhead >= cutStart && playhead <= cutStart + cutDur
      ? Math.min(cutDurClamp, Math.max(0, playhead - cutStart))
      : 0;

  // videoTrack: 再生中と停止中で経路を分ける。
  //   - 再生中 (= renderPreview を再生中に明示呼出 — 通常は無いが ad-hoc seek 用):
  //     setupLivePreviewVideo で play() させ、自然デコードに任せる。
  //   - 停止中: prepareVideoFrameForStill で全体 1.5s タイムアウト下に
  //     loadedmetadata → seeked → loadeddata → RAF×1 を畳む。play() しない。
  let videoEl = null;
  if (hasVideoTrack) {
    if (state.isPlaying) {
      videoEl = setupLivePreviewVideo(sceneVideo, cutStart + previewSec);
    } else {
      videoEl = await prepareVideoFrameForStill(sceneVideo, cutStart + previewSec);
      if (state.previewRequestId !== requestId) return false;
    }
  }
  // VideoTextureProvider に包んで scene-builder に渡す。preview の videoTrack
  // 経路は VideoTexture 自動 sample に任せるので updateForFrame は no-op。
  const videoProvider = videoEl
    ? new (await import("/static/js/renderer/video-provider.js")).VideoTextureProvider(videoEl)
    : null;

  // 動画レイヤー (videoLayers) も preview 用に per-layer 準備。window フィルタ後を渡す。
  const { providersById: videoLayerProvidersById } = await prepareVideoLayersForPreview(
    liveSceneForLayersStill, cutStart + previewSec,
    { windowedLayers: windowedVideoLayersStill },
  );

  // 同じ token の scene が既にあれば reuse、なければ build。
  // ★ build 前に disposeActiveScene を呼ばないこと (cf. project_v2_cut_transition_perf
  //   の memo): preserveDrawingBuffer=true の canvas に残っている旧フレームを
  //   transparent クリアしてしまうと、build 完了までの ~10〜100ms の間に
  //   「一瞬透ける」フラッシュが発生する。先に新 scene を build → setActiveScene
  //   が旧 scene を自動 dispose してくれる順序にすると、旧フレームが画面に残った
  //   まま新フレームへ滑らかに切り替わる。
  let sceneInstance = null;
  const activeToken = v2.getActiveSceneToken?.();
  const activeVlWindowKey = v2.getActiveVlWindowKey?.() || "";
  if (activeToken && layerData.token && activeToken === layerData.token
      && activeVlWindowKey === vlWindowKeyStill) {
    sceneInstance = v2.getActiveScene?.();
  }
  if (!sceneInstance) {
    sceneInstance = await v2.buildSceneFromLayerData(
      layerData, videoProvider,
      videoLayerProvidersById, state.videoLayerDurations, vlWindowKeyStill,
    );
    if (state.previewRequestId !== requestId) {
      // race: 後続の loadCut が走り、こちらは捨てる対象になった。
      // 自動 dispose には乗らないので明示破棄しておく。
      try { sceneInstance.dispose?.(); } catch (_e) { /* ignore */ }
      return false;
    }
    v2.setActiveScene(sceneInstance);
  }
  if (state.previewRequestId !== requestId) return false;

  const animationFps = clampCharacterAnimationFps(state.manifest?.config?.characterAnimationFps);
  const frameIdx = Math.max(0, Math.floor(previewSec * animationFps));
  const quantized = frameIdx / animationFps;

  // 停止中は目パチも口パクも止める。
  // - eyeKey="open" → eyeTextures.open = カット選択の目 (blinkEligible に関係なし)
  // - mouthKey="default" → mouthTextures.default = カット選択の口
  const eyeKey = "open";
  const mouthKey = "default";
  const speakerId = layerData.speakerId || null;

  // モーション (再生中と同じ式)。停止中も「現在 frame における shake/idle 量」を
  // そのまま反映するので、シーク中の見た目が再生中と一致する。
  const motionType = layerData.motion?.type || "none";
  const motionSettings = layerData.motion?.settings || {};
  const idleMotion = sceneIdleMotionConfig();
  let shakeDx = 0;
  let shakeDy = 0;
  if (motionType === "shake_x" || motionType === "shake_y") {
    const cfg = motionType === "shake_x" ? (motionSettings.shakeX || {}) : (motionSettings.shakeY || {});
    const amp = Number(cfg.amplitude || 0);
    const count = Number(cfg.count || 0);
    const motionDuration = Number(cfg.duration || 0);
    if (amp > 0 && count > 0 && motionDuration > 0 && quantized < motionDuration) {
      const offset = amp * Math.sin((2 * Math.PI * count * quantized) / motionDuration);
      if (motionType === "shake_x") shakeDx = offset;
      else shakeDy = offset;
    }
  } else if (motionType === "move") {
    const moveOffset = computeMoveOffset(motionSettings.move, quantized);
    shakeDx = moveOffset.dx;
    shakeDy = moveOffset.dy;
  }
  const idleOffset = idleMotion
    ? computeIdleMotionOffset(idleMotion, cutStart + quantized)
    : { dx: 0, dy: 0 };

  const motionOffsetByChar = computePerCharacterMotionOffsets(layerData.characters, quantized);
  const sceneState = {
    eyeKey,
    mouthKey,
    speakerId,
    shakeDx,
    shakeDy,
    idleDx: idleOffset.dx,
    idleDy: idleOffset.dy,
    motionOffsetByChar,
    elapsedSec: quantized,
    // テロップ可視判定用: 量子化前の cut-local 秒。selectTelop で playhead を
    // telop.startFrame に合わせた直後でも「animation 量子化で startFrame の
    // 直前へ丸まり、telop が表示されない」を防ぐ。
    rawElapsedSec: previewSec,
  };
  // R10: カット入りトランジションを active scene に反映 (毎 render 安価)。
  v2.setActiveSceneTransition?.(effectiveCutTransition(cut));
  v2.renderActiveScene(sceneState);

  // videoTrack / videoLayer 経路の保険: 初回 render 時点で VideoTexture が前フレームを
  // 掴んでいる環境向けに、次の paint cycle で同じ scene state を再 render する。
  // RAF×1 だけなので追加コストは ~16ms。frame 待ちの await は **しない** (paused
  // video に対する rVFC が永久 stuck する環境があるため)。
  const hasActiveVideoLayerEl = (videoLayerProvidersById?.size ?? 0) > 0;
  if ((videoEl && hasVideoTrack) || hasActiveVideoLayerEl) {
    if (!state.isPlaying) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (state.previewRequestId !== requestId) return false;
      v2.renderActiveScene(sceneState);
    }
  }

  // テロップは scene-builder の ORDER_TELOP plane に取り込まれている。
  showLivePreviewCanvas(true);
  elements.emptyPreview.style.display = "none";
  return true;
}


// =============================================================================
// playLiveCutV2: WebGL (three.js) 経路。Phase A は静的合成 + 目パチ + 口パクのみ。
// モーション / 色フィルタ / 光彩 / 影 / ビジュアライザ / テロップ GPU 化は Phase B+。
// =============================================================================
// 通常の preview/PNG 出力用 scene-bundle fetch を一元管理するための
// AbortController。renderPreview が呼ばれるたびに前回 in-flight な fetch を
// abort し、サーバ側で並列処理に起因する「Response content longer than
// Content-Length」+ truncated PNG → WebGL texSubImage2D エラーで描画が
// 真っ黒になる事象の確率を下げる。
// prefetch (= 別キャッシュ経路) はここでは abort しない (= まったく別の
// caller 起因のため、彼ら自身が完了するまで待つ)。
let _pendingSceneBundleAbort = null;

function _abortPendingSceneBundle() {
  if (_pendingSceneBundleAbort) {
    try { _pendingSceneBundleAbort.abort(); } catch (_e) {}
    _pendingSceneBundleAbort = null;
  }
}

async function fetchSceneBundleV2(cut, options = {}) {
  const cutState = cut.state || {};
  // ★ scene 単位の設定 (telops / videoTrack / bgmTracks / visualizer / bpm / breath /
  //   bpmBob) は cut.state には乗っていない。サーバの `_build_scene_payload` は
  //   `ensure_scenario` 経由でディスク (= 最後に保存された scenarios/main.json) を
  //   読みに行くため、`scheduleScenarioSave` の 700ms debounce 中に renderPreview
  //   が走ると 1 操作前の状態が返ってくる (= テロップ編集が「次の操作の時にやって
  //   くる」体感バグの主因)。
  //   live scene を `sceneOverride` として一緒に送り、サーバ側で disk より優先する
  //   ことで、save 完了を待たずに即時反映できる。
  // メモリはフラット + プロジェクト絶対フレームなので、カットが属するシーンを
  // **ディスク形式 (シーンローカル frame)** に組み直してから送る。サーバの
  // cutStartSec / visualizer の time grid がシーンローカル前提のため
  // (dev_docs/plans/multi-scene.md §3.2)。
  const liveScene = (() => {
    const owner = (state.scenario?.cuts || []).find((c) => c && c.id === cut.id);
    if (!owner) return null;
    return sceneToDisk(owner.sceneId);
  })();
  // 音源単位 viz 解析キャッシュの「同期生成」を許すかどうか。先読み (NEXT/LOOKAHEAD)
  // のときだけ true にして裏で音源全長キャッシュを温め、現カット (CURRENT) や対話
  // fetch (priority 未指定) では false にして「3 分 BGM の最初の 1 カットで音源全長
  // 解析を待たされる」初動レイテンシ回帰を避ける。未生成なら per-cut 即返しになる。
  // 明示指定 (事前解析の warm) があれば優先、無ければ priority から決める。
  const vizSourceBuild = (options.vizSourceBuild != null)
    ? !!options.vizSourceBuild
    : (options.priority === PRIORITY.NEXT || options.priority === PRIORITY.LOOKAHEAD);
  const body = {
    ...cutState,
    cutId: cut.id,
    duration: cutDurationSec(cut),
    audio: cut.audio,
    vizSourceBuild,
    // preview 経路はサーバの compute_cut_lipsync_levels (ffmpeg astats) を skip
    // させる。preview の口パクは AnalyserNode で real-time 駆動するため不要。
    // サーバ側で token には乗らない (preview/export で焼き込み PNG を共有)。
    purpose: "preview",
    ...(liveScene
      ? {
          sceneOverride: {
            // ベッド設定の二層化: サーバは bedScope に従ってシーン設定を
            // projectSettings で差し替える。編集直後の即時反映のため live state
            // をそのまま送る (dev_docs/plans/multi-scene.md §2)。
            projectSettings: projectSettings(),
            bedScope: bedScope(),
            telops: Array.isArray(liveScene.telops) ? liveScene.telops : [],
            videoTrack: liveScene.videoTrack || null,
            bgmTracks: Array.isArray(liveScene.bgmTracks) ? liveScene.bgmTracks : [],
            videoLayers: Array.isArray(liveScene.videoLayers) ? liveScene.videoLayers : [],
            visualizer: liveScene.visualizer || null,
            bpm: liveScene.bpm ?? null,
            breath: liveScene.breath || null,
            bpmBob: liveScene.bpmBob || null,
            // cuts も override に乗せて、startFrame / durationFrame の編集が
            // disk 読み込み遅延を介さず即座に visualizer / cut_start_sec に
            // 反映されるようにする。
            cuts: Array.isArray(liveScene.cuts) ? liveScene.cuts : [],
          },
        }
      : {}),
  };
  const projectId = state.activeProjectId || state.manifest?.projectId || "";
  const sceneBundleUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/v2/scene-bundle`
    : "/api/v2/scene-bundle";
  const signal = options.signal || null;
  const response = await fetch(sceneBundleUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`scene-bundle ${response.status}`);
  }
  const data = await response.json();
  if (projectId && data?.projectId && data.projectId !== projectId) {
    throw new Error(`scene-bundle project mismatch: expected ${projectId}, got ${data.projectId}`);
  }
  // v1 と同じくキャラのレイヤーサイズを保存 (centerCharacter で使用)。
  for (const ch of data.characters || []) {
    if (ch.id && ch.layerWidth && ch.layerHeight) {
      state.characterLayerSizes.set(ch.id, { width: ch.layerWidth, height: ch.layerHeight });
    }
  }
  // 光彩 / ドロップシャドウは v1 と同じく cut.state.characterEffects を JS 側で持つ
  // (サーバ scene-bundle は焼き込まないため raw を使う)。
  data.characterEffects = cutState.characterEffects || {};
  // B-2: マルチキャラレイアウトの分割枠 + ボーダー設定。同じく raw を JS 側で
  // 保持する (= サーバは焼き込まない、scene-builder が border plane 群を描画する)。
  data.characterLayout = cutState.characterLayout || null;
  // crop / layoutSlot は scene-bundle のキャラ payload 内で transport される
  // (= サーバ側 _build_scene_payload が CharacterRequest.crop / layout_slot を含める)。
  // ただし scene-bundle 側で character が欠落するケース (orphan 等) のフォールバック
  // として、cutState の値で上書きする。id 一致で照合。
  if (Array.isArray(cutState.characters) && Array.isArray(data.characters)) {
    const byId = new Map(cutState.characters.map((c) => [c?.id, c]));
    for (const ch of data.characters) {
      const src = byId.get(ch?.id);
      if (src) {
        if (ch.crop == null && src.crop) ch.crop = src.crop;
        if (ch.layoutSlot == null && Number.isInteger(src.layoutSlot)) ch.layoutSlot = src.layoutSlot;
      }
    }
  }
  // vizSourceBuild=true の warm 成功 = このカットのサーバ側キャッシュ (viz 音源解析 +
  // bundle 焼き) が温まった。事前解析ストリップを ready (緑) にする。先読み
  // (NEXT/LOOKAHEAD) と明示プリレンダーの両方がここを通る (= 受動 + 能動の可視化)。
  if (vizSourceBuild && cut?.id) {
    try { setCutPrerenderStatus(cut.id, "ready"); } catch (_) { /* ignore */ }
  }
  return data;
}

// 事前解析 (プリレンダー) 用に 1 カットを warm する。scene-bundle を vizSourceBuild=true
// で fetch し、サーバに viz 音源解析 + bundle 焼きを生成させる。prerender.js から
// bindPrerender 経由で注入されて使われる (循環 import 回避)。
export function warmSceneBundleForPrerender(cut) {
  return fetchSceneBundleV2(cut, { vizSourceBuild: true });
}

// =============================================================================
// scene-bundle prefetch (v2) — PreviewScheduler (preview-scheduler.js) に集約。
// 次カットの POST /api/v2/scene-bundle を裏で発火し、結果を Promise でキャッシュ。
// 次カットの playLiveCutV2 が consume すれば、HTTP RTT + サーバの visualizer/
// dialogue/telop 焼き込みが await の外に追い出される。
//
// scheduler は優先度 (current > next > lookahead) + 同時実行枠 2 で fetch を
// 直列度高く流す。旧実装は lookahead 範囲を全部同時 fire していたため、重カット
// が並ぶと現カットの処理とサーバ側 (threadpool + GIL) で競合していた。
//
// scene-bundle は stable_token=True なので、同じ cut.state なら同じ token / 同じ
// ファイル名 = サーバ側ディスクキャッシュも有効。prefetch 投機実行は安全。
//
// invalidation: stop / play 開始時にクリアする (用意したカットの cut.state が
// 編集された場合に備えて)。再生中の cut.state 編集は UI 上できない設計なので、
// それ以外の経路は気にしなくてよい。
// =============================================================================
const bundleScheduler = createPreviewScheduler({
  // priority を fetch に伝搬する: 現カット (CURRENT) と対話 fetch は初動レイテンシ
  // 優先で音源単位 viz キャッシュの同期生成を抑止 (vizSourceBuild=false)、先読み
  // (NEXT/LOOKAHEAD) のときだけ裏で音源キャッシュを温める。
  fetchBundle: (cut, priority) => fetchSceneBundleV2(cut, { priority }),
  prefetchAudio: (cut) => prefetchAudioForCut(cut),
});

// 旧 API 互換の薄いラッパ (呼び出し箇所のセマンティクスを変えないため)。
function prefetchSceneBundleV2(cut, priority = PRIORITY.LOOKAHEAD) {
  return bundleScheduler.request(cut, priority);
}

function consumeSceneBundlePrefetch(cut) {
  return bundleScheduler.consume(cut);
}

function clearSceneBundlePrefetchCache() {
  bundleScheduler.clear();
}

// =============================================================================
// scene instance prefetch (Phase 3, 2026-05-24): 次カットの SceneInstance を裏で
// pre-build しておき、切替時に setActiveScene するだけで使えるようにする。
//
// 動機: Windows ANGLE で buildScene が偶発的に 200-450ms 跳ねる (= shader compile /
// texture upload の初回コスト)。事前 build により cut N 再生中に GPU が遊ぶ時間で
// この処理を片付け、cut N+1 切替時の buildScene 時間を ≒0 に近づける。
//
// 制約:
//   - 動画レイヤー (= scene.videoLayers[]) を含むカットは対象外。
//     videoLayerProvidersById は playLiveCutV2 内で毎カット作り直されるため、
//     事前 build 時点で provider が確定しない (lifecycle 干渉のリスク)。
//   - renderer はシングルトンなので、build を直列化する (= serial queue)。
//     同時に 2 つの buildScene が走ると cover RT 等の state が混ざる可能性。
//
// lifecycle:
//   - prefetch: cache に Promise<SceneInstance> を入れる
//   - take: 取り出し (= cache から削除、所有権移譲)。setActiveScene で active 化
//   - clear: stop / project 切替 / config change で全 dispose
//     (active scene にすでに昇格していたものは disposeActiveScene 側で扱う)
// =============================================================================
const sceneInstancePrefetchCache = new Map();
let _sceneInstanceBuildQueue = Promise.resolve();

// scene-level の videoLayers から、cut の時間範囲に重なる layer が 1 つでもあるか判定。
// 重なる = preview で「この cut の間に動画が流れる」状態 → provider 経路が必要。
// 重ならない = この cut の間は動画なし → prefetch 対象にできる。
//
// layer の終了 frame は trimEnd - trimStart を fps 倍した値。speed は無視 (= 1.0
// 既定、速度変更ありなら厳密には short になるが安全側に倒すため 1.0 で計算)。
function _videoLayerOverlapsCut(layer, cutStartFrame, cutDurationFrame) {
  const layerStart = Math.max(0, Number(layer?.startFrame) || 0);
  const trimStart = Math.max(0, Number(layer?.trimStartSec) || 0);
  const trimEndRaw = layer?.trimEndSec;
  const trimEnd = trimEndRaw == null ? null : Math.max(trimStart, Number(trimEndRaw) || trimStart);
  if (trimEnd == null) {
    // 終端未指定 = 「素材末尾まで」。長さ不明なので「重なる可能性あり」を安全側で返す。
    return true;
  }
  const layerLenFrames = Math.max(1, Math.round((trimEnd - trimStart) * PROJECT_FPS));
  const layerEnd = layerStart + layerLenFrames;
  const cutEnd = cutStartFrame + cutDurationFrame;
  // 半開区間 [start, end) の重なり判定
  return layerStart < cutEnd && layerEnd > cutStartFrame;
}

function _anyActiveVideoLayer(layerData, cutStartFrame, cutDurationFrame) {
  const v = layerData?.videoLayers;
  if (!Array.isArray(v) || v.length === 0) return false;
  for (const layer of v) {
    if (_videoLayerOverlapsCut(layer, cutStartFrame, cutDurationFrame)) return true;
  }
  return false;
}

// VL 時間窓フィルタ (A1, 2026-05-25):
// scene 全体の videoLayers から、focusCut ± lookahead カット範囲に重なるものだけ
// 抜き出す。これで「scene 全 VL に対して常時 <video preload=auto> + clean PCM <audio>
// preload=auto を保持する」現状を、現在見えている / 直近で active になる範囲だけに
// 絞り、ブラウザのバッファ消費を有界化する。
//
// 窓の決め方:
//   - focusCut の index を基準に、後ろ 1 cut、前 lookaheadCuts cut を含める
//   - 後ろ 1 cut は seek 後の巻き戻りで「直前 cut に戻ったとき」即 attach できるよう
//   - lookaheadCuts は再生中の prefetch lookahead (= 全体設定 preview.prefetchLookahead)
//
// 戻り値:
//   { windowedLayers: VL[], windowKey: string }
//   windowKey は VL ID のソート済み join。SceneInstance reuse 判定で「window が
//   変わったら同 token でも rebuild」を可能にするためのキー。
function _computeVideoLayerWindow(scene, focusCut, lookaheadCuts = 0) {
  const layers = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  if (!layers.length) {
    return { windowedLayers: [], windowKey: "" };
  }
  if (!focusCut) {
    // focus 不明なら旧挙動 (フィルタなし) にフォールバック。
    const all = layers.slice();
    const key = all.map((l) => l?.id).filter(Boolean).sort().join("|");
    return { windowedLayers: all, windowKey: key };
  }
  const cuts = state.scenario?.cuts || [];
  const idx = cuts.findIndex((c) => c?.id === focusCut.id);
  if (idx < 0) {
    const all = layers.slice();
    const key = all.map((l) => l?.id).filter(Boolean).sort().join("|");
    return { windowedLayers: all, windowKey: key };
  }
  const fromIdx = Math.max(0, idx - 1);
  const toIdx = Math.min(cuts.length - 1, idx + Math.max(0, lookaheadCuts));
  const windowStartFrame = cutStartFrame(cuts[fromIdx]);
  const windowEndFrame = cutStartFrame(cuts[toIdx]) + cutDurationFrame(cuts[toIdx]);
  const windowDurationFrame = Math.max(1, windowEndFrame - windowStartFrame);
  const windowed = layers.filter((layer) =>
    _videoLayerOverlapsCut(layer, windowStartFrame, windowDurationFrame),
  );
  // ★ 座標系の変換。メモリ上の VL は **プロジェクト絶対フレーム** だが、
  //   renderer は `sceneSec = cutStartSec + elapsed` の **シーンローカル**時間で
  //   VL の in/out を判定する (cutStartSec は scene-bundle 由来 = シーンローカル)。
  //   そのままだと 2 つめ以降のシーンで VL の出入りがシーン先頭分ずれる。
  //   アイテムはシーンをまたげない (§3.5) ので、フォーカス中のカットと同じ
  //   シーンの VL だけに絞り、そのシーンの開始フレームだけ引いて渡す。
  const focusSceneId = focusCut.sceneId || null;
  const spans = sceneSpans(state.scenario);
  const sceneStartFrame = spans.find((sp) => sp.id === focusSceneId)?.startFrame || 0;
  const rebased = windowed
    .filter((layer) => !focusSceneId || !layer?.sceneId || layer.sceneId === focusSceneId)
    .map((layer) => (sceneStartFrame > 0
      ? { ...layer, startFrame: Math.max(0, (Number(layer.startFrame) || 0) - sceneStartFrame) }
      : layer));
  const windowKey = rebased.map((l) => l?.id).filter(Boolean).sort().join("|");
  return { windowedLayers: rebased, windowKey };
}

// 直列化された buildSceneFromLayerData。前の build が終わるまで次は待つ。
// renderer (= シングルトン) が cover RT / blur RT を共有しているため、同期 build と
// prefetch build が並列に走ると state が混ざって結果が壊れる。playLiveCutV2 の
// 同期 build 経路もこの queue を通すことで、prefetch との競合を排除する。
function _serialBuildScene(layerData, videoProvider, videoLayerProvidersById, videoLayerDurations, vlWindowKey = "") {
  const next = _sceneInstanceBuildQueue.then(async () => {
    const { buildSceneFromLayerData } = await import("/static/js/renderer/index.js");
    return buildSceneFromLayerData(
      layerData, videoProvider,
      videoLayerProvidersById, videoLayerDurations, vlWindowKey,
    );
  });
  _sceneInstanceBuildQueue = next.catch(() => {});
  return next;
}

function prefetchSceneInstance(cut) {
  if (!cut?.id) return;
  if (sceneInstancePrefetchCache.has(cut.id)) return;
  // cut の時間範囲を計算 (= active な videoLayer 判定のため)
  const cutStartFrameVal = cutStartFrame(cut);
  const cutDurationFrameVal = cutDurationFrame(cut);

  // scene-bundle の prefetch が無ければ並行で発火させる (= bundle Promise を共有)
  const bundlePromise = prefetchSceneBundleV2(cut);
  if (!bundlePromise) return;
  const promise = bundlePromise.then(async (layerData) => {
    if (!layerData) return null;
    // videoTrack (= scene 全体の背景動画) は provider 経由なので除外。
    // ★ playLiveCutV2 内で書き加えられる layerData.hasVideoTrack はここでは未定義。
    //   scene-bundle response の videoTrack.src を直接見る必要がある。
    if (layerData.videoTrack?.src) return null;
    // 動画レイヤーは scene-level の配列で、それぞれ時間範囲を持つ。cut の時間範囲に
    // 重なる layer が 1 つもなければ、この cut の間は動画レイヤーが描画されないので
    // provider 不要 → prefetch 対象にできる。
    if (_anyActiveVideoLayer(layerData, cutStartFrameVal, cutDurationFrameVal)) return null;
    try {
      return await _serialBuildScene(layerData, null, null, state.videoLayerDurations);
    } catch (err) {
      console.warn("[scene-prefetch] build failed", err);
      return null;
    }
  });
  sceneInstancePrefetchCache.set(cut.id, promise);
  promise.then((inst) => {
    if (!inst) sceneInstancePrefetchCache.delete(cut.id);
  });
}

function takePrefetchedSceneInstance(cut) {
  if (!cut?.id) return null;
  const promise = sceneInstancePrefetchCache.get(cut.id);
  if (!promise) return null;
  sceneInstancePrefetchCache.delete(cut.id);
  return promise; // Promise<SceneInstance | null>
}

function clearPrefetchedSceneInstances() {
  const promises = Array.from(sceneInstancePrefetchCache.values());
  sceneInstancePrefetchCache.clear();
  // dispose は非同期 (= 各 Promise が resolve したら inst.dispose)
  for (const p of promises) {
    p.then((inst) => {
      if (inst) {
        try { inst.dispose?.(); } catch (_) { /* ignore */ }
      }
    }).catch(() => {});
  }
}

// 全体設定の textDefaults / telopDefaults などプロジェクト config レベルの値が
// 変わったときに呼ぶ。scene-bundle 自体の token はカット payload しか覆っていない
// ので、設定変更だけだと token が同じまま active scene が再利用されてしまい、
// dialogue / telop canvas が古いレイアウトのままになる (= オプティカルカーニング
// 切替が「書体を変えるまで反映されない」現象の原因)。次の renderPreview で確実に
// canvas を焼き直すため、prefetch / active scene の双方を捨てる。
export async function invalidateRendererCachesForConfigChange() {
  clearSceneBundlePrefetchCache();
  clearPrefetchedSceneInstances();
  try {
    const { disposeActiveScene } = await import("/static/js/renderer/index.js");
    disposeActiveScene?.();
  } catch (_err) {
    /* renderer 未ロード時は何もしない */
  }
}

// =============================================================================
// 音声プリフェッチ
// カット切替で `new Audio(src).play()` した瞬間にネットワーク fetch + decode が
// 走り、音が一瞬途切れる現象を防ぐ。次カット (もしくは再生開始時に全カット) の
// audio をあらかじめ HTMLAudioElement に load させ、play() タイミングでは
// decoded data がメモリに乗っている状態にする。
// キャッシュキーは src URL。同じ URL なら 1 回しか prefetch しない。
// =============================================================================
const audioPrefetchCache = new Map(); // src -> HTMLAudioElement
const AUDIO_PREFETCH_LIMIT = 24;

function audioSourceForCut(cut) {
  if (!cut?.audio) return null;
  return cut.audio.startsWith("/") ? cut.audio : `/assets/${cut.audio}`;
}

function prefetchAudioForCut(cut) {
  const src = audioSourceForCut(cut);
  if (!src) return;
  if (audioPrefetchCache.has(src)) return;
  const a = new Audio();
  a.preload = "auto";
  a.src = src;
  // preload="auto" だけでは load を発火しないブラウザがあるので明示。
  try { a.load(); } catch (_) { /* ignore */ }
  audioPrefetchCache.set(src, a);
  while (audioPrefetchCache.size > AUDIO_PREFETCH_LIMIT) {
    const firstKey = audioPrefetchCache.keys().next().value;
    const evict = audioPrefetchCache.get(firstKey);
    audioPrefetchCache.delete(firstKey);
    try { evict.src = ""; } catch (_) { /* ignore */ }
  }
}

// 次カットの audio を取り出す。ヒットすれば現キャッシュから外して所有権を移譲。
// 取り出した Audio はそのまま play() するのが望ましい (decoded buffer を再利用)。
function takePrefetchedAudio(src) {
  if (!src) return null;
  const a = audioPrefetchCache.get(src);
  if (!a) return null;
  audioPrefetchCache.delete(src);
  try { a.pause(); a.currentTime = 0; } catch (_) { /* ignore */ }
  return a;
}

function clearAudioPrefetchCache() {
  for (const a of audioPrefetchCache.values()) {
    try { a.pause(); a.src = ""; } catch (_) { /* ignore */ }
  }
  audioPrefetchCache.clear();
}

// スライディング・ウィンドウ prefetch (2026-05-20, 2026-06-11 改訂):
// - 再生開始時は warmupInitialBundles が「現カットのみ完全 await、2 件目以降は
//   短い予算 (WARMUP_NEXT_BUDGET_MS) だけ待って見切り発車」する。長尺 BGM の
//   ビジュアライザー解析が次カットに乗っていても再生開始をブロックしない。
//   (サーバ側は viz 専用トークンの解析キャッシュを持つので、2 回目以降は予算内に
//   即解決して従来同様「温まった状態」で開始できる。)
// - 再生中は playLiveCutV2 が ensureLookahead で「現カット + LOOKAHEAD」までを
//   常時温める (= シーン途中の重カットも、その手前で焼き終わっている状態にする)
//
// 旧実装 (1): 再生開始時に全カットを await → ダイアログ数で開始遅延が線形増加。
// 旧実装 (2): 先頭 2 カットを完全 await → 長尺ビジュアライザーで開始が数十秒
// 塞がる。いずれも現在の方式に置き換えた。
//
// 制限値の根拠:
// - INITIAL_WARMUP_CUTS=2: 現カット + 1 件先の prefetch を発火する範囲。
// - WARMUP_NEXT_BUDGET_MS: 次カットがキャッシュ済みなら即解決し、重い解析が
//   走っている場合はこの予算で打ち切る (prefetch 自体は裏で継続する)。
// - prefetchLookahead (config 経由): 連続する重カットが並んだときの buffer。
//   先回りで queue に積む発想。全体設定 → 編集タブから 0〜20 で調整可能。
const INITIAL_WARMUP_CUTS = 2;
const WARMUP_NEXT_BUDGET_MS = 400;
const DEFAULT_PREFETCH_LOOKAHEAD = 3;

function getPrefetchLookahead() {
  const raw = state.globalConfig?.config?.preview?.prefetchLookahead;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PREFETCH_LOOKAHEAD;
  return Math.max(0, Math.min(20, Math.floor(n)));
}

// 再生開始時に先頭 N 件 (= warmupCount) の prefetch を発火する。
// await するのは現カット (startIndex) のみ。2 件目以降は WARMUP_NEXT_BUDGET_MS
// だけ待ち、間に合わなければ裏の prefetch に任せて再生を開始する。
// 実体は PreviewScheduler.warmup (音声 prefetch も scheduler が同時に発火する)。
// onProgress: (done, total) => void  プログレス表示用 (任意)。
async function warmupInitialBundles(cuts, startIndex, warmupCount, onProgress) {
  await bundleScheduler.warmup(cuts, startIndex, warmupCount, {
    budgetMs: WARMUP_NEXT_BUDGET_MS,
    onProgress,
  });
}

// 現カット index から見て [currentIndex+1, currentIndex+1+lookahead) の範囲を
// バックグラウンドで温める。直後 1 件は NEXT、それ以降は LOOKAHEAD 優先度で
// scheduler に積む (同時実行枠内で順に流れる)。await しないので呼び出し側の
// 再生フローはブロックしない。
function ensureLookahead(cuts, currentIndex, lookahead) {
  bundleScheduler.ensureLookahead(cuts, currentIndex, lookahead);
}

// Phase 3: 次カットの SceneInstance を裏で build する。serial queue 経由で
// 走るため、現カットの buildScene が終わってから順次実行される。これを
// playLiveCutV2 の build 「後」に呼ぶことで、現カットの同期 build を
// prefetch が遅らせない順序を保つ (= ensureLookahead と分離した理由)。
function ensureScenePrefetch(cuts, currentIndex) {
  const nextCut = cuts[currentIndex + 1];
  if (nextCut?.id && !sceneInstancePrefetchCache.has(nextCut.id)) {
    prefetchSceneInstance(nextCut);
  }
}

// =============================================================================
// フルライブ境界またぎトランジション (preview)
//
// トランジションをカット境界 [境界-D/2, 境界+D/2] にまたがせ、前後カットを半分ずつ
// シェアして切り替える。窓の間は前カット A と現カット B の両シーンを毎フレーム
// 描画して合成する (= 口パク/目パチ/モーション/BPM が両方動いたまま切り替わる)。
//
//   A-side (前カット A の尾 [dur-D/2, dur]):  A=live, B=先頭フレーム静止, progress 0→0.5
//   B-side (現カット B の頭 [0, D/2]):        B=live, A=尾を live 延長, progress 0.5→1
//
// A-side の B は境界前でまだ始まっていないので「先頭フレーム」を静的テクスチャで
// 出すのが正 (start で _prepareASideToTex が裏で焼く)。B-side の A はカット尺を
// 越えても口パク以外 (目パチ/モーション/BPM) を時間関数で延長して live 描画する。
// =============================================================================

// B-side 用に detach (no-dispose) して保持する前カット A。
let _straddleFromInst = null;   // SceneInstance (生かしておく A)
let _straddleFromCtx = null;    // A の render context
let _straddleForCutId = null;   // この A を from に使う現カット B の id
// B-side straddle を使うカットの id (overlay フォールバック判定用、窓を抜けても保持)。
let _bSideCutId = null;
// A-side 用に裏で焼いた「次カット B の先頭フレーム」テクスチャ。
let _aSideToTex = null;
let _aSideForCutId = null;      // 焼き済みの次カット id
let _aSideExpectedCutId = null; // 現在準備中 (race 検出用)

// カット 1 つを任意 cut-local 秒で描画するための render context を組む。
// playLiveCutV2 内で既に計算している値の集約 (partner の state 計算に使う)。
function _buildCutRenderContext(cut, layerData) {
  const duration = cutDurationSec(cut);
  const blinkCharIds = (layerData.characters || []).map((c) => c.id).filter((id) => id);
  const blinkEnabled = layerData.blinkEnabled !== false;
  return {
    cutId: cut.id,
    layerData,
    duration,
    timelineOffsetSec: cutStartSec(cut),
    animationFps: clampCharacterAnimationFps(state.manifest?.config?.characterAnimationFps),
    blinkEnabled,
    blinkStartsByChar: blinkEnabled ? generateBlinkStartsByChar(duration, blinkCharIds) : {},
    blinkAlgorithm: layerData.blinkAlgorithm || "anime",
    lipSyncEnabled: layerData.lipSyncEnabled !== false,
    lipSync: layerData.lipSync || {},
    motionType: layerData.motion?.type || "none",
    motionSettings: layerData.motion?.settings || {},
    idleMotion: sceneIdleMotionConfig(),
    speakerId: layerData.speakerId || null,
  };
}

// render context から cut-local 秒の scene state を計算する (tick のインライン計算と同式)。
// mouthVolume=null なら口パクなし ("default")。partner (前カット延長) は常に null。
function _computeCutSceneState(ctx, cutLocalSec, { mouthVolume = null } = {}) {
  const fps = ctx.animationFps;
  const frameIdx = Math.max(0, Math.floor(cutLocalSec * fps));
  const quantized = frameIdx / fps;
  let eyeKeyByChar = null;
  if (ctx.blinkEnabled) {
    eyeKeyByChar = {};
    for (const char of ctx.layerData.characters || []) {
      if (!char.id || char.blinkEligible === false) continue;
      const hasHalf = !!char.eyeUrls?.half;
      const startsForChar = ctx.blinkStartsByChar[char.id] || [];
      eyeKeyByChar[char.id] = eyeKeyForTime(quantized, startsForChar, fps, ctx.blinkAlgorithm, hasHalf);
    }
  }
  const mouthKey = (ctx.lipSyncEnabled && mouthVolume != null)
    ? mouthKeyFromVolume(mouthVolume, ctx.lipSync)
    : "default";
  let shakeDx = 0;
  let shakeDy = 0;
  if (ctx.motionType === "shake_x" || ctx.motionType === "shake_y") {
    const cfg = ctx.motionType === "shake_x" ? (ctx.motionSettings.shakeX || {}) : (ctx.motionSettings.shakeY || {});
    const amp = Number(cfg.amplitude || 0);
    const count = Number(cfg.count || 0);
    const md = Number(cfg.duration || 0);
    if (amp > 0 && count > 0 && md > 0 && quantized < md) {
      const off = amp * Math.sin((2 * Math.PI * count * quantized) / md);
      if (ctx.motionType === "shake_x") shakeDx = off;
      else shakeDy = off;
    }
  } else if (ctx.motionType === "move") {
    const mo = computeMoveOffset(ctx.motionSettings.move, quantized);
    shakeDx = mo.dx;
    shakeDy = mo.dy;
  }
  const idleOffset = ctx.idleMotion
    ? computeIdleMotionOffset(ctx.idleMotion, ctx.timelineOffsetSec + quantized)
    : { dx: 0, dy: 0 };
  const motionOffsetByChar = computePerCharacterMotionOffsets(ctx.layerData.characters, quantized);
  return {
    eyeKey: "open",
    eyeKeyByChar,
    mouthKey,
    speakerId: ctx.speakerId,
    shakeDx,
    shakeDy,
    idleDx: idleOffset.dx,
    idleDy: idleOffset.dy,
    motionOffsetByChar,
    elapsedSec: quantized,
    rawElapsedSec: cutLocalSec,
  };
}

// A-side 用: 次カット B の先頭フレームを裏で焼いてテクスチャに保持する。
// B はサーバ disk キャッシュ済みの bundle から transient build → frame0 を RT 焼き →
// dispose (RT には焼き済みなので texture は生きる)。video provider は省略 (frame0 の
// 視覚近似で十分・窓は ~0.25s)。失敗時は A-side を諦めて通常描画にフォールバック。
async function _prepareASideToTex(nextCut, v2) {
  _aSideExpectedCutId = nextCut.id;
  _aSideToTex = null;
  _aSideForCutId = null;
  let inst = null;
  try {
    const layerData = await fetchSceneBundleV2(nextCut);
    if (_aSideExpectedCutId !== nextCut.id || !state.isPlaying) return;
    inst = await v2.buildSceneFromLayerData(layerData, null, null, state.videoLayerDurations, "");
    if (!inst) return;
    if (_aSideExpectedCutId !== nextCut.id || !state.isPlaying) { try { inst.dispose?.(); } catch (_) {} return; }
    const frame0 = _computeCutSceneState(_buildCutRenderContext(nextCut, layerData), 0, { mouthVolume: null });
    const tex = v2.captureInstanceFrameToTexture(inst, frame0);
    _aSideToTex = tex || null;
    _aSideForCutId = nextCut.id;
  } catch (_e) {
    _aSideToTex = null;
    _aSideForCutId = null;
  } finally {
    if (inst) { try { inst.dispose?.(); } catch (_) {} }
  }
}

// B-side で生かしておいた前カット A を破棄する。
function _disposeStraddleFrom() {
  if (_straddleFromInst) {
    try { _straddleFromInst.dispose?.(); } catch (_) {}
  }
  _straddleFromInst = null;
  _straddleFromCtx = null;
  _straddleForCutId = null;
}

// 直前に再生したカットの render context / scene (B-side の from に使う)。
let _lastPlayedCtx = null;

// 境界またぎ用の全リソースを解放する (停止 / abort / プロジェクト切替時)。
export function clearStraddleResources() {
  _disposeStraddleFrom();
  _bSideCutId = null;
  _lastPlayedCtx = null;
  _aSideToTex = null;
  _aSideForCutId = null;
  _aSideExpectedCutId = null;
}

export async function playLiveCutV2(cut, _options = {}) {
  let layerData;
  try {
    // 直前のカット tick で prefetch 済なら、await はキャッシュ済 Promise を待つだけ。
    // (キャッシュが先に解決していれば microtask 内で即時 resolve。)
    // prefetch が失敗していた / 無かったら fresh fetch にフォールバック。
    const cached = consumeSceneBundlePrefetch(cut);
    layerData = cached ? await cached : null;
    if (!layerData) {
      layerData = await fetchSceneBundleV2(cut);
    }
  } catch (error) {
    abortV2Playback("シーン情報の取得に失敗", error);
    return;
  }
  markCutPhase("fetchBundle");

  // 「現カット + prefetchLookahead」までを裏で温める (await しない)。サーバ単一
  // スレッド想定でも、現カットの buildScene + tick (audio 再生 ~数秒) と並行して
  // 焼けるので、次イテの consumeSceneBundlePrefetch でほぼゼロコストになる。
  // 失敗しても prefetch 経路の catch でキャッシュから自己除去 → 次イテで fresh fetch。
  // 重カット (visualizer / 背景動画) が連続する場合の境界ラグを Lookahead 個分の
  // バッファで吸収する (= 全体設定で調整可能)。
  {
    const cuts = state.scenario?.cuts || [];
    const curIdx = cuts.findIndex((c) => c.id === cut.id);
    if (curIdx >= 0) ensureLookahead(cuts, curIdx, getPrefetchLookahead());
  }

  // dialogue は焼き済み PNG なのでフォントロード待ちは v1 ほど厳密ではないが、
  // 念のため v1 と同じ待機を踏襲する (project font が telop 用に必要なときの保険)。
  if (state.projectFontsReady) {
    try { await state.projectFontsReady; } catch {}
  }
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch {}
  }
  markCutPhase("fontsReady");

  const canvas = elements.livePreviewWebglCanvas;
  if (!canvas) {
    abortV2Playback("WebGL canvas が見つかりません");
    return;
  }

  let v2;
  try {
    v2 = await loadRendererV2();
    v2.initRenderer(canvas);
  } catch (error) {
    abortV2Playback("three.js / WebGL の初期化に失敗", error);
    return;
  }

  // videoTrack 経路は VideoTexture を bg plane として WebGL 内に取り込む。
  // 透過 bg + DOM <video> を canvas 背面に重ねる古い方式は:
  //   - WebGL canvas が透明になり ブラウザ合成段で半透明エフェクトが暗くなる
  //   - readPixels に動画が含まれずデバッグが破綻する
  //   - DOM 透明 canvas + DOM video の合成は環境依存が強い
  // という構造的問題があった。ここで video element を先に立ち上げ、それを
  // VideoTexture のソースとして scene-builder へ渡す。video element 自体は
  // DOM に残し続ける (currentTime 操作などの API のため)。canvas の bg plane
  // が opaque になり画面では完全に隠れるので、見た目上の重複は無し。
  const sceneVideo = activeSceneResolved()?.videoTrack || null;
  const hasVideoTrack = !!(sceneVideo && sceneVideo.src);
  layerData.hasVideoTrack = hasVideoTrack;
  // 動画レイヤー: live state を最新として注入 + A1 の時間窓フィルタ。
  // window は「現カット ± lookahead カット」内に時間範囲が重なる VL のみ。
  // これで scene 全 VL に対する `<video preload=auto>` + clean PCM `<audio>` の
  // 常時保持を停止し、ブラウザバッファ消費を有界化する。
  const liveSceneForLayersTop = state.scenario || null;
  const { windowedLayers: windowedVideoLayers, windowKey: vlWindowKey } =
    _computeVideoLayerWindow(liveSceneForLayersTop, cut, getPrefetchLookahead());
  // layerData.videoLayers も窓フィルタ後で固定する。これに合わせて
  // scene-builder は window 内 VL の plane だけ作る。
  layerData.videoLayers = windowedVideoLayers;

  const timelineOffsetSec = cutStartSec(cut);
  const cutStartWallclockMs = (state.playbackStartWallclockMs ?? performance.now())
    + (timelineOffsetSec - (state.playbackStartTimelineSec ?? timelineOffsetSec)) * 1000;

  // VideoTexture が即サンプリングできるよう、build 前に video element を
  // setupLivePreviewVideo で起動しておく (src 設定 + play() 呼び出し)。
  // 背景動画は scene-global 連続レイヤ。カット境界では原則 seek せず、playhead
  // (= 再生再開時にカット中盤のことがある) を渡して drift しきい値で抑制する。
  const livePreviewSceneSec = Number.isFinite(Number(state.timeline?.currentSec))
    ? Math.max(timelineOffsetSec, Number(state.timeline.currentSec))
    : timelineOffsetSec;
  const videoEl = setupLivePreviewVideo(sceneVideo, livePreviewSceneSec);
  // VideoTextureProvider に包む (export では WebCodecsVideoProvider に差し替え)。
  const videoProvider = videoEl
    ? new (await import("/static/js/renderer/video-provider.js")).VideoTextureProvider(videoEl)
    : null;

  // 動画レイヤー: per-layer の HTMLVideoElement + VideoTextureProvider を準備。
  // window フィルタ後の VL のみ ensure する (A1)。
  const { providersById: videoLayerProvidersById } = await prepareVideoLayersForPreview(
    liveSceneForLayersTop, livePreviewSceneSec, { windowedLayers: windowedVideoLayers },
  );

  // scene-bundle が返す token は state の SHA1。直前のカットと完全に同じ state
  // (同 token) なら、dispose → texture release → build → texture re-fetch という
  // ループを丸ごと省略して、現 active scene をそのまま再利用する。
  // これでカット切替時でも、内容が変わらない限り「重い build やり直し / 同じ
  // viz_*.png の再フェッチ」が発生しなくなる。
  //
  // ★ A1: token に加えて VL window key も一致するときだけ reuse。
  //   同 token でも window が変わった (= 新たに窓入りした VL がある / 窓から抜けた VL
  //   がある) なら、active scene の videoLayers plane 集合は古いので rebuild が必要。
  // 異なる token のときは新 scene を先に build し、setActiveScene で旧 scene を
  // 自動 dispose する (= dispose-after-build の順序)。理由:
  //   - texture-cache.js は refCount 付きキャッシュ。同じ URL の THREE.Texture
  //     は再利用される設計。
  //   - 旧 dispose を build より先に呼ぶと、旧 scene の releaseTexture が refCount
  //     を全部 1→0 に落とし、shared な URL でも THREE.Texture が破棄されてしまう。
  //     新 scene の loadTexture は cache miss → 新 Texture → GPU へ再アップロード
  //     という順で動き、毎カット firstFrame に重い GPU 転送が乗る。
  //   - 「先に build して新 scene が refCount を 1→2 に上げる → setActiveScene が
  //     旧 dispose を呼んで 2→1 に戻す」順なら、shared Texture は GPU 上で生き残り、
  //     首カットの GPU 再アップロードを防げる。
  // 旧コードの「先 dispose で canvas をクリア」効果は失うが、build 後の
  // renderActiveScene で全画面塗り直されるので体感差はない (むしろ build 中も
  // 旧 scene が見え続けるので、透明フラッシュが消える方向)。
  let sceneInstance = null;
  const activeToken = v2.getActiveSceneToken ? v2.getActiveSceneToken() : null;
  const activeVlWindowKey = v2.getActiveVlWindowKey ? v2.getActiveVlWindowKey() : "";
  if (activeToken && layerData.token && activeToken === layerData.token
      && activeVlWindowKey === vlWindowKey) {
    sceneInstance = v2.getActiveScene ? v2.getActiveScene() : null;
  }

  // 境界またぎ (B-side): このカット B にトランジションがあり、直前カットがあり、
  // かつ scene を新規 build する (= reuse でない) なら、現在 active な前カット A を
  // dispose せず detach して保持する。B の頭 D/2 の間、A を live 延長で描いて合成する。
  const _cutsArrTop = state.scenario?.cuts || [];
  const _bIdxTop = _cutsArrTop.findIndex((c) => c.id === cut.id);
  const _trBTop = effectiveCutTransition(cut);
  _disposeStraddleFrom(); // 取りこぼし掃除
  _bSideCutId = null;
  if (_trBTop.type !== "none" && _trBTop.durationFrame > 0
      && _bIdxTop > 0 && !sceneInstance
      && _lastPlayedCtx && _lastPlayedCtx.cutId === _cutsArrTop[_bIdxTop - 1]?.id) {
    const activeA = v2.getActiveScene ? v2.getActiveScene() : null;
    if (activeA && v2.detachActiveSceneNoDispose) {
      _straddleFromInst = v2.detachActiveSceneNoDispose();
      _straddleFromCtx = _lastPlayedCtx;
      _straddleForCutId = cut.id;
      _bSideCutId = cut.id; // overlay フォールバック抑止 (窓を抜けても保持)
    }
  }

  // ★ 音声を buildScene より前に発火させる (= カット切替時の「音が一瞬飛ぶ」対策)。
  //   旧実装は buildScene を await した後に audio.play() していたため、buildScene が
  //   重いカット (Windows ANGLE で 300ms+ になることがある) では「カット切替直後に
  //   構造的な無音区間」が生まれていた。
  //   - 取り出し / analyser attach / play() は全部 buildScene の前で済ませる
  //   - setupSpeakerLipSyncAnalyser は play() より前に createMediaElementSource する
  //     必要があるので、ここでの順序 (analyser → play) は維持する
  //   - 副作用: 画面切替が build 完了まで遅れて見える (= 音声先行) が、人間の知覚は
  //     音声基準で同期するため違和感は最小限。
  let audio = null;
  if (cut.audio) {
    const source = audioSourceForCut(cut);
    // 既に prefetch されていれば decoded buffer を持つ HTMLAudioElement を再利用。
    // ヒットしなければ通常通り new Audio (ブラウザの HTTP キャッシュには載っている
    // ことが多いので、ここでも体感差はそれなりに小さい)。
    audio = takePrefetchedAudio(source) || new Audio(source);
    state.playbackAudio = audio;
    // useForLipSync な BGM が無ければ、話者音声から口パクを駆動する
    // フォールバック。createMediaElementSource は audio.play() より前で呼ぶ。
    setupSpeakerLipSyncAnalyser(audio);
    // 発話ディレイ: カット冒頭から audioDelay 秒だけ声を遅らせる。音声の
    // カット内位置は (cutLocal - audioDelay)。再生位置が delay 前なら play() を
    // 残り秒数だけ後ろへ予約し、delay を過ぎた所からの開始ならその分進めて即再生。
    const audioDelay = Math.max(0, Number(cut.audioDelaySec) || 0);
    const initialOffset = Math.max(0, (performance.now() - cutStartWallclockMs) / 1000);
    const audioPos = initialOffset - audioDelay;
    if (_pendingSpeechDelayTimer) {
      try { clearTimeout(_pendingSpeechDelayTimer); } catch (_) { /* ignore */ }
      _pendingSpeechDelayTimer = null;
    }
    if (audioPos >= 0) {
      if (audioPos > 0) {
        try { audio.currentTime = audioPos; } catch (_) { /* ignore */ }
      }
      audio.play().catch((error) => console.warn("Audio preview failed", error));
    } else {
      // まだ delay 区間。currentTime=0 のまま、残り (= -audioPos) 秒後に play 予約。
      const waitMs = Math.round(-audioPos * 1000);
      const pendingAudio = audio;
      _pendingSpeechDelayTimer = window.setTimeout(() => {
        _pendingSpeechDelayTimer = null;
        // 予約中にカット切替/停止で別音声に差し替わっていたら発火しない。
        if (!state.isPlaying || state.playbackAudio !== pendingAudio) return;
        pendingAudio.play().catch((error) => console.warn("Audio preview failed", error));
      }, waitMs);
    }
  }

  // Phase 3: 事前 build された SceneInstance があれば取り出して使う。
  // video layer / videoTrack ありカットは prefetchSceneInstance 内で skip されるので、
  // hit するのは「動画なしカット」のみ (= 大多数)。
  // ★ A1: prefetched scene は VL なし状態で build されている (prefetchSceneInstance で
  //   _anyActiveVideoLayer skip 済み)。現カットの vlWindowKey が空でないなら、窓に
  //   入る VL の plane が欠けるので dispose して fresh build にフォールバック。
  if (!sceneInstance) {
    const prefetched = takePrefetchedSceneInstance(cut);
    if (prefetched) {
      try {
        const inst = await prefetched;
        if (inst) {
          if ((inst.vlWindowKey || "") === vlWindowKey) {
            sceneInstance = inst;
            v2.setActiveScene(sceneInstance);
          } else {
            try { inst.dispose?.(); } catch (_) { /* ignore */ }
          }
        }
      } catch (_err) { /* ignore: 失敗時は下の build にフォールバック */ }
    }
  }

  if (!sceneInstance) {
    try {
      // serial queue 経由で build (prefetch との race を回避)。
      // 直前の prefetch build がまだ走っていれば、それを await してから自分の build に入る。
      sceneInstance = await _serialBuildScene(
        layerData, videoProvider,
        videoLayerProvidersById, state.videoLayerDurations, vlWindowKey,
      );
    } catch (error) {
      abortV2Playback("シーン構築に失敗", error);
      return;
    }
    v2.setActiveScene(sceneInstance);
  }
  markCutPhase("buildScene");

  // Phase 3: 現カットの buildScene が完了したので、次カットの SceneInstance を
  // 裏で build するキューに積む (= serial queue は今 idle、即実行される)。
  // ensureLookahead (= scene-bundle / audio の HTTP prefetch) よりも遅らせる
  // ことで、現カット同期 build が先に終わる順序を保つ。
  {
    const cuts2 = state.scenario?.cuts || [];
    const curIdx2 = cuts2.findIndex((c) => c.id === cut.id);
    if (curIdx2 >= 0) ensureScenePrefetch(cuts2, curIdx2);
  }

  showLivePreviewCanvas(true);
  resetAudioMeter();
  updateAudioMeterThresholds(layerData.lipSync || {});

  const duration = cutDurationSec(cut);
  // 目パチ: キャラ毎に独立な schedule を作る (= 2 人以上で同時にまばたく不自然さの対策)。
  // 描画 ループでは blinkStartsByChar[char.id] を引いて per-char eyeKey を解決する。
  const blinkCharIds = (layerData.characters || [])
    .map((c) => c.id)
    .filter((id) => id);
  const blinkStartsByChar = layerData.blinkEnabled !== false
    ? generateBlinkStartsByChar(duration, blinkCharIds)
    : {};

  const animationFps = clampCharacterAnimationFps(state.manifest?.config?.characterAnimationFps);
  const speakerId = layerData.speakerId || null;
  const lipSync = layerData.lipSync || {};
  const blinkEnabled = layerData.blinkEnabled !== false;
  const lipSyncEnabled = layerData.lipSyncEnabled !== false;
  const blinkAlgorithm = layerData.blinkAlgorithm || "anime";
  const motionType = layerData.motion?.type || "none";
  const motionSettings = layerData.motion?.settings || {};
  const idleMotion = sceneIdleMotionConfig();

  // 境界またぎ: このカットの render context を記録 (= 次カット B-side の from に使う)。
  _lastPlayedCtx = {
    cutId: cut.id,
    layerData,
    duration,
    timelineOffsetSec,
    animationFps,
    blinkEnabled,
    blinkStartsByChar,
    blinkAlgorithm,
    lipSyncEnabled,
    lipSync,
    motionType,
    motionSettings,
    idleMotion,
    speakerId,
  };
  // A-side: 次カットにトランジションがあれば、その先頭フレームを裏で焼いておく
  // (= このカット A の尾で B が徐々に現れる合成に使う)。
  const _cutsArrSelf = state.scenario?.cuts || [];
  const _selfIdx = _cutsArrSelf.findIndex((c) => c.id === cut.id);
  const _nextCutSelf = _selfIdx >= 0 ? _cutsArrSelf[_selfIdx + 1] : null;
  const _trNextSelf = _nextCutSelf ? effectiveCutTransition(_nextCutSelf) : { type: "none", durationFrame: 0 };
  if (_trNextSelf.type !== "none" && _trNextSelf.durationFrame > 0 && _nextCutSelf) {
    _prepareASideToTex(_nextCutSelf, v2);
  } else {
    _aSideToTex = null; _aSideForCutId = null; _aSideExpectedCutId = null;
  }
  // テロップは scene-builder の ORDER_TELOP plane に取り込まれており、
  // sceneSec から active 判定 + canvas2d → CanvasTexture を update() 内で行う。
  // 2D ctx へ毎フレーム塗り直す経路は撤去。

  let firstFrameLogged = false;
  return new Promise((resolve) => {
    let lastDrawnFrame = -1;
    const tick = () => {
      if (!state.isPlaying) {
        resolve();
        return;
      }
      const elapsed = (performance.now() - cutStartWallclockMs) / 1000;
      const clamped = Math.max(0, elapsed);
      const frameIdx = Math.floor(clamped * animationFps);
      if (frameIdx !== lastDrawnFrame) {
        lastDrawnFrame = frameIdx;
        const quantized = frameIdx / animationFps;
        sampleAudioVolume(lipSync);
        updateAudioMeterValue(currentAudioVolume() || 0);
        // 均等方式は per-char で「中目あり / なし」によりパターン長が変わるため、
        // キャラ単位で eyeKey を計算して eyeKeyByChar として scene-builder に渡す。
        // アニメ方式でも 中目なしキャラは pattern 上 "half" → 描画時に closed
        // フォールバックされるので、ここで per-char に解決して問題なし。
        let eyeKeyByChar = null;
        if (blinkEnabled) {
          eyeKeyByChar = {};
          for (const char of layerData.characters || []) {
            if (!char.id || char.blinkEligible === false) continue;
            const hasHalf = !!char.eyeUrls?.half;
            // per-char の blink schedule を引く (== 同期しないランダム化)。
            const startsForChar = blinkStartsByChar[char.id] || [];
            eyeKeyByChar[char.id] = eyeKeyForTime(
              quantized, startsForChar, animationFps, blinkAlgorithm, hasHalf,
            );
          }
        }
        // 全体口パク OFF のときは default (= カット選択の口) 固定。
        // ON のときは mouthKeyFromVolume が "open"/"mid"/"default" を返す
        // (analyser 未セットアップ / silence は "default")。
        const mouthKey = lipSyncEnabled
          ? mouthKeyFromVolume(currentAudioVolume(), lipSync)
          : "default";

        // モーション (v1 と同じ式)。shake はカット内 elapsed、idle はタイムライン t。
        let shakeDx = 0;
        let shakeDy = 0;
        if (motionType === "shake_x" || motionType === "shake_y") {
          const cfg = motionType === "shake_x" ? (motionSettings.shakeX || {}) : (motionSettings.shakeY || {});
          const amp = Number(cfg.amplitude || 0);
          const count = Number(cfg.count || 0);
          const motionDuration = Number(cfg.duration || 0);
          if (amp > 0 && count > 0 && motionDuration > 0 && quantized < motionDuration) {
            const offset = amp * Math.sin((2 * Math.PI * count * quantized) / motionDuration);
            if (motionType === "shake_x") shakeDx = offset;
            else shakeDy = offset;
          }
        } else if (motionType === "move") {
          const moveOffset = computeMoveOffset(motionSettings.move, quantized);
          shakeDx = moveOffset.dx;
          shakeDy = moveOffset.dy;
        }
        const idleOffset = idleMotion
          ? computeIdleMotionOffset(idleMotion, timelineOffsetSec + quantized)
          : { dx: 0, dy: 0 };

        // 動画レイヤー: per-layer HTMLVideoElement の play/pause/seek を毎フレーム同期。
        // mesh.visible は scene-builder の update() 側で mapVideoLayerSec を再計算
        // して切り替えるが、video element 側の再生制御はこちらで行う。
        if (Array.isArray(layerData.videoLayers) && layerData.videoLayers.length > 0) {
          syncVideoLayerEls(layerData.videoLayers, timelineOffsetSec + clamped, 24, true);
        }

        const motionOffsetByChar = computePerCharacterMotionOffsets(layerData.characters, quantized);
        const sceneState = {
          eyeKey: "open",
          eyeKeyByChar,
          mouthKey,
          speakerId,
          shakeDx,
          shakeDy,
          idleDx: idleOffset.dx,
          idleDy: idleOffset.dy,
          motionOffsetByChar,
          elapsedSec: quantized,
          // 再生中も telop の出入りは量子化していない実時間で判定する。
          // animationFps=12 で project=24 のとき、奇数フレームに乗った telop が
          // 1 frame 遅れて出現する/消えるのを防ぐ。
          rawElapsedSec: clamped,
        };

        // ---- 境界またぎトランジション (フルライブ dual-RT 合成) ----
        // B-side: このカット B の頭 [0, D_B/2]。前カット A を尾から live 延長して from に。
        // A-side: このカット A の尾 [dur-D_next/2, dur]。次カット B の先頭フレームを to に。
        // どちらでもなければ通常描画 (+ 先頭カットのみ overlay でホワイトイン等)。
        let _composited = false;
        const activeInst = v2.getActiveScene ? v2.getActiveScene() : null;
        if (_straddleFromInst && _straddleFromCtx && _straddleForCutId === cut.id) {
          const dB = (_trBTop.durationFrame || 0) / PROJECT_FPS;
          const halfB = dB / 2;
          if (dB > 0 && clamped < halfB && activeInst && v2.renderSceneTransitionComposite) {
            const progress = Math.min(1, 0.5 + clamped / dB); // 0.5→1
            const aLocal = _straddleFromCtx.duration + clamped; // A を尾から延長 (口パク除く)
            const fromState = _computeCutSceneState(_straddleFromCtx, aLocal, { mouthVolume: null });
            _composited = v2.renderSceneTransitionComposite({
              fromInst: _straddleFromInst, fromState,
              toInst: activeInst, toState: sceneState,
              cfg: _trBTop, progress,
            });
          }
          if (clamped >= halfB) _disposeStraddleFrom(); // B-side 窓を抜けたら A を破棄
        }
        if (!_composited && _aSideToTex && _aSideForCutId === _nextCutSelf?.id
            && _trNextSelf.type !== "none" && _trNextSelf.durationFrame > 0) {
          const dN = _trNextSelf.durationFrame / PROJECT_FPS;
          const halfN = dN / 2;
          const aSideStart = duration - halfN;
          if (clamped > aSideStart && activeInst && v2.renderSceneTransitionComposite) {
            const progress = Math.max(0, Math.min(0.5, (clamped - aSideStart) / dN)); // 0→0.5
            _composited = v2.renderSceneTransitionComposite({
              fromInst: activeInst, fromState: sceneState,
              toTex: _aSideToTex,
              cfg: _trNextSelf, progress,
            });
          }
        }
        if (!_composited) {
          // 通常描画。このカットにトランジションがあり、かつ B-side straddle を
          // 使っていない (= 先頭カット、または prev 未再生で seek 開始した場合) は
          // 従来の overlay でフェードイン表示する。straddle 適用カットは overlay 抑止。
          const showOverlay = _trBTop.type !== "none" && _bSideCutId !== cut.id;
          v2.setActiveSceneTransition?.(showOverlay ? _trBTop : null);
          v2.renderActiveScene(sceneState);
        }
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          markCutPhase("firstFrame");
          endCutTransition();
        }
        state.timeline.currentSec = timelineOffsetSec + quantized;
        // 再生中もシーンレーンのハイライトを追従させる。
        syncSelectedSceneToCurrent();
        autoScrollTimelineToCursor();
        autoScrollCutListToActive();
        drawTimeline();
      }
      if (elapsed >= duration) {
        resolve();
        return;
      }
      state.livePreviewRaf = requestAnimationFrame(tick);
    };
    state.livePreviewRaf = requestAnimationFrame(tick);
  });
}


// v2 (WebGL) 再生経路が失敗したときの停止 + エラー表示。
// 旧 v1 fallback (`playStaticCut`: 音声だけ進める) は撤去済。サイレント失敗で
// ユーザに「再生が動いてないのに音声だけ進んでいる」状態を見せないようにする。
function abortV2Playback(reason, error) {
  if (error) console.warn(`[v2] ${reason}:`, error);
  else console.warn(`[v2] ${reason}`);
  showToast(`再生に失敗しました: ${reason}`, "error");
  // stopPreviewPlayback 内で state.isPlaying=false になるので、呼び出し元は
  // 直後に return する。skipPreviewRefresh=true で post-stop の still render を
  // 抑止 (失敗の原因がそのまま renderPreview にも乗るので二重で toast が出るのを防ぐ)。
  stopPreviewPlayback({ skipPreviewRefresh: true });
}

// 停止モード:
//   既定 (user stop):
//     - audio / BGM / RAF を停止
//     - GL scene と video element の src は維持 (still render の reuse 用)
//     - `wasPlaying` なら直後に renderPreview({ captureThumbnail: true }) を発火
//       (停止フレームの絵を canvas に焼いてサムネを保存)
//   { skipPreviewRefresh: true }:
//     - 停止後の still render とサムネ取得を抑止
//     - reloadProjectData などで「停止と並行に新プロジェクト遷移」が走る経路用
//   { hard: true }:
//     - 上記すべてに加えて video element の src を完全クリア + GL scene を dispose
//     - showProjectDashboard / プロジェクト切替 など「画面を畳む」経路用
//     - hard 指定時は skipPreviewRefresh も自動的に true 扱い (画面遷移先では
//       still render を走らせる意味が無いため)
export function stopPreviewPlayback(options = {}) {
  const hard = options.hard === true;
  const skipPreviewRefresh = hard || options.skipPreviewRefresh === true;
  const wasPlaying = state.isPlaying;
  state.isPlaying = false;
  stopVlPerfTimer();
  clearSceneBundlePrefetchCache();
  clearAudioPrefetchCache();
  // A3: 停止時にも pre-built SceneInstance を捨てる。停止 → 編集 → 再生で
  // 古い prefetch が残ったまま消えない構造を防ぐ。
  clearPrefetchedSceneInstances();
  // 境界またぎトランジション用の retained 前カット / A-side テクスチャを解放。
  clearStraddleResources();
  if (state.playbackTimer) {
    window.clearTimeout(state.playbackTimer);
    state.playbackTimer = null;
  }
  if (state.livePreviewRaf) {
    cancelAnimationFrame(state.livePreviewRaf);
    state.livePreviewRaf = null;
  }
  stopAudio();
  stopLivePreviewBgm();
  stopLivePreviewSoundEffects();
  // 動画レイヤー: 通常停止では HTMLVideoElement / `<audio>` を残し (still render
  // 再利用)、pause だけ呼ぶ。hard 停止では完全解放。
  // ★ audio 側も video と同時に pause しないと、renderPreview 経由の sync が
  //    走るまで音だけ play し続ける (= 停止が効いてないように聞こえる)
  if (hard) {
    releaseAllVideoLayerEls();
  } else {
    for (const [, el] of state.playbackVideoLayerEls) {
      try { el.pause(); } catch (_) {}
    }
    for (const [, audio] of state.playbackVideoLayerAudios) {
      try { audio.pause(); } catch (_) {}
    }
  }
  resetAudioMeter();
  setTogglePlayUi(false);
  elements.playbackStatus.textContent = "停止中";
  deps.renderCutList();
  // 再生ヘッダ（state.timeline.currentSec）は意図的に保持する。
  // 次回再生は playPreviewPlayback がここから再開する。
  drawTimeline();

  if (hard) {
    // hard 停止: GL canvas / video / previewImage を全部畳み、active scene を
    // dispose する (texture / RT / canvas を解放)。dashboard 表示中に video が
    // 裏で再生され続けたり、古い GL フレームが下に透けて見えるのを防ぐ。
    showLivePreviewCanvas(false);
  }
  // 通常停止 (hard=false) では canvas / video / scene を維持する。停止直後の
  // renderPreview({ captureThumbnail }) が同じ scene を再利用して still 描画 +
  // サムネ取得を行うため (memory feedback_v2_thumbnail_video_sync 参照)。

  if (wasPlaying && !skipPreviewRefresh) {
    // サムネ取得は v2 still render が成功した直後に renderPreview 内で同期発火する。
    renderPreview({ captureThumbnail: true })
      .catch((error) => console.warn("post-stop renderPreview failed", error));
  }
}

export async function playPreviewPlayback() {
  if (state.isPlaying || state.scenario.cuts.length === 0) {
    return;
  }
  // ダッシュボード表示中 / プロジェクト未選択 では再生を始めない。Space ハンドラ
  // 側の guard と二重化 (双方の経路でも click() が成功しないように)。
  if (state.projectDashboardVisible) return;
  if (!state.activeProjectId) return;
  state.isPlaying = true;
  setTogglePlayUi(true);
  startVlPerfTimer();

  // 再生開始時に prefetch を一掃。停止 → 編集 → 再生の流れで古いキャッシュ
  // (cut.state を変えても URL/token が同じになるケース) を返さないよう、再生の
  // たびに毎回新鮮なデータから始める。scene-bundle prefetch + audio prefetch
  // の両方を破棄する。
  clearPreviewLayerCache();
  // 音声プリフェッチも 1 回流す (TTS 再生成等で URL が更新されている可能性)。
  clearAudioPrefetchCache();

  // ループ再生対応:
  // outer while で「シナリオ通し再生 → ループモードに応じて再開」を繰り返す。
  // ループ境界では BGM / audio を一旦停止してから再起動する (BGM の wallclock を
  // 取り直す必要があるため)。ループモードは state.loopMode で常時参照。
  const cuts = state.scenario.cuts;
  // 1 周分の最後に再生したカット index を覚えておき、loopMode==="cut" で再周期に
  // 同じカットへ戻すのに使う。
  let lastPlayedIndex = -1;

  outer: while (state.isPlaying) {
    // ---- 再生位置決定 (毎周回ごとに再評価) ----
    // 1) 再生ヘッダ (state.timeline.currentSec) がカット内ならそのカットから
    // 2) そうでなければ選択中カットの先頭
    // 3) それも無ければ最初のカット
    const cursorSec = Number(state.timeline?.currentSec || 0);
    let startIndex = -1;
    for (let i = 0; i < cuts.length; i += 1) {
      const s = cutStartSec(cuts[i]);
      const e = s + cutDurationSec(cuts[i]);
      if (cursorSec >= s && cursorSec < e) {
        startIndex = i;
        break;
      }
    }
    let startTimelineSec = cursorSec;
    if (startIndex < 0) {
      if (state.selectedCutId) {
        const idx = cuts.findIndex((c) => c.id === state.selectedCutId);
        if (idx >= 0) {
          startIndex = idx;
          startTimelineSec = cutStartSec(cuts[idx]);
        }
      }
    }
    if (startIndex < 0) {
      startIndex = 0;
      startTimelineSec = cuts[0] ? cutStartSec(cuts[0]) : 0;
    }

    // v2 シーンバンドル prefetch: 完全に await するのは現カットのみ。次カットは
    // 短い予算内だけ待ち、残りは再生中に playLiveCutV2 → ensureLookahead が
    // スライドさせながら裏で温める。(二回目以降はサーバ側ディスクキャッシュで即 return)
    if (cuts.length > startIndex) {
      elements.playbackStatus.textContent = "プリロード中...";
      await warmupInitialBundles(cuts, startIndex, INITIAL_WARMUP_CUTS, (done, total) => {
        if (state.isPlaying) {
          elements.playbackStatus.textContent = `プリロード中... (${done}/${total})`;
        }
      });
      if (!state.isPlaying) return;
    }

    state.playbackStartTimelineSec = startTimelineSec;
    // BGM が「シーンごと」のときは、素材の再生位置はシーン先頭からの経過で決まる。
    // プロジェクト通しならタイムライン先頭からの経過そのもの。
    // ★ 現状、再生中にシーンをまたいでも BGM は切り替わらない (再生開始時点の
    //   シーンのものが鳴り続ける)。dev_docs/plans/multi-scene.md Phase 2e の残作業。
    const startFrame = Math.round(startTimelineSec * PROJECT_FPS);
    const bgmScene = activeSceneResolved(state.scenario, startFrame);
    const bgmOffsetSec = (() => {
      if (bedScope().bgm === "project") return startTimelineSec;
      const span = sceneSpans(state.scenario).find((sp) => sp.id === bgmScene?.id);
      return Math.max(0, startTimelineSec - (span ? span.startFrame / PROJECT_FPS : 0));
    })();
    state.playbackBgmSceneId = bgmScene?.id || null;
    await startLivePreviewBgm(bgmScene, bgmOffsetSec);
    if (!state.isPlaying) return;
    startLivePreviewSoundEffects(state.scenario, startTimelineSec);
    state.playbackStartWallclockMs = performance.now();

    let interruptedByCutLoop = false;
    for (let index = startIndex; index < cuts.length; index += 1) {
      if (!state.isPlaying) break outer;
      const cut = cuts[index];
      lastPlayedIndex = index;
      // シーンごと BGM のときは、シーンが変わった時点で BGM を張り替える。
      // (プロジェクト通しのときは 1 本を鳴らし続けるので触らない)
      await _switchBgmIfSceneChanged(cut);
      if (!state.isPlaying) break outer;
      beginCutTransition(cut, `${index + 1}/${cuts.length}`);
      elements.playbackStatus.textContent = `再生中 ${index + 1} / ${cuts.length}`;

      state.isLoadingCut = true;
      try {
        await deps.loadCut(cut, { render: false });
      } catch (error) {
        console.warn("loadCut during playback failed", error);
      } finally {
        state.isLoadingCut = false;
      }
      markCutPhase("loadCut");
      if (!state.isPlaying) break outer;

      stopAudio();
      if (state.livePreviewRaf) {
        cancelAnimationFrame(state.livePreviewRaf);
        state.livePreviewRaf = null;
      }
      await playLiveCut(cut);
      if (!state.isPlaying) break outer;

      // カットループ: 1 カット再生し終わったら、現在のカット先頭へ戻して outer を再周回。
      // BGM/audio はここで一旦止め、outer 冒頭で startLivePreviewBgm を呼び直す。
      if (state.loopMode === "cut") {
        interruptedByCutLoop = true;
        break;
      }
    }

    if (!state.isPlaying) break;

    if (interruptedByCutLoop && lastPlayedIndex >= 0) {
      const cut = cuts[lastPlayedIndex];
      state.timeline.currentSec = cutStartSec(cut);
      stopAudio();
      stopLivePreviewBgm();
      stopLivePreviewSoundEffects();
      continue;
    }

    // 末尾まで再生し切ったあとの分岐
    if (state.loopMode === "scene") {
      // シーン全体ループ: 先頭カットへ戻して再周回
      state.timeline.currentSec = cuts[0] ? cutStartSec(cuts[0]) : 0;
      stopAudio();
      stopLivePreviewBgm();
      stopLivePreviewSoundEffects();
      continue;
    }

    break; // ループなし → 終了
  }

  stopPreviewPlayback();
}
