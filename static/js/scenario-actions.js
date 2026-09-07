// シナリオ操作（カット追加・複製・編集ハンドラ・Undo/Redo・保存・カット一括追加ダイアログ等）。
// state.scenario / state.selectedCutId / state.history を読み書きする中核。
// loadCut / renderCutList / payload / scheduleScenarioSave / saveScenario が外部からも参照される。

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast, migrateInDialogToasts } from "./toast.js";
import { recordHistory } from "./history.js";
import {
  option,
  basenameOnly,
  truncateText,
  opacityToUi,
  opacityToRender,
  normalizeColorValue,
  generateSoundEffectId,
  generateVideoLayerId,
} from "./utils.js";
import { formatTimecode, secToFrames, framesToSec, PROJECT_FPS } from "./timecode.js";
import { fillFontWeights } from "./font.js";
import {
  attachScenarioCutsAlias,
  recalcCutStartSec,
  cutStartFrame,
  cutDurationFrame,
  cutStartSec,
  cutDurationSec,
  soundEffectStartFrame,
  soundEffectDurationFrame,
  videoLayerStartFrame,
  videoLayerTrimStartSec,
  videoLayerTrimEndSec,
  toDiskScenario,
  restampCutsSceneByPosition,
  assignSceneMembership,
  syncSelectedSceneToCurrent,
  isCutTransitionOverriddenByScene,
} from "./scenario.js";
import { renderPreview, invalidateRendererCachesForConfigChange } from "./playback.js";
import { schedulePlayheadSave } from "./app-state.js";
import { markThumbnailDirty } from "./thumbnail.js";
import { renderTelopTrack, resetCutListAutoScrollTracking, seekPlayheadToSec } from "./timeline.js";
import {
  selectedCharacter,
  normalizeCutCharacters,
  renderCharacterSelect,
  renderSpeakerSelect,
  loadCharacterIntoControls,
  normalizedSpeakerCharacterId,
  updateSelectedCharacterFromControls,
  characterColorById,
  characterDefinitionById,
} from "./character.js";
import { combineNarratorAndStyle } from "./tts.js";
import { renderSoundEffectEditor } from "./sound-effect.js";
import { renderVideoLayerEditor } from "./video-layer.js";

const deps = {
  applyEditorTargetView: () => {},
  syncPresetName: () => {},
  fillExpressionPresets: () => {},
  normalizeBoxOpacityInput: () => {},
  syncDialogueVoiceFromSpeaker: () => {},
};

export function bindScenarioActions(injected = {}) {
  Object.assign(deps, injected);
  bindCutListWheelScroll();
}

// cut-list の縦ホイール → 横スクロール変換。
// 過去の素直な「scrollLeft += deltaY」直接マッピングは Shift+ホイールの慣性付き
// 横スクロールと比べて感触が悪く一度撤去された経緯があるため、本実装では
//   - deltaMode (LINE / PAGE) を px 換算
//   - 入力ごとに target を加算し、RAF で ease-out 補間
// で滑らかさを担保する。トラックパッドの水平スワイプ (deltaX) や Shift+ホイールは
// 既にブラウザ側が momentum 付きでまかなっているので、そのときは何もしない。
function bindCutListWheelScroll() {
  const cutList = elements.cutList;
  if (!cutList) return;
  let target = null;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (target == null) return;
    const max = Math.max(0, cutList.scrollWidth - cutList.clientWidth);
    const t = Math.max(0, Math.min(max, target));
    const cur = cutList.scrollLeft;
    const diff = t - cur;
    if (Math.abs(diff) < 0.5) {
      cutList.scrollLeft = t;
      target = null;
      return;
    }
    // ease-out: 1 フレームで残差の 25% を詰める。50fps 換算で半減期 ~50ms。
    cutList.scrollLeft = cur + diff * 0.25;
    raf = requestAnimationFrame(tick);
  };
  cutList.addEventListener("wheel", (event) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    const ax = Math.abs(event.deltaX);
    const ay = Math.abs(event.deltaY);
    if (ay <= ax) return;
    // deltaMode 0=PX / 1=LINE / 2=PAGE。LINE/PAGE は実機文脈で近似値を掛ける。
    let pxDelta = event.deltaY;
    if (event.deltaMode === 1) pxDelta *= 40;
    else if (event.deltaMode === 2) pxDelta *= cutList.clientHeight || 400;
    const max = Math.max(0, cutList.scrollWidth - cutList.clientWidth);
    if (max <= 0) return;
    event.preventDefault();
    if (target == null) target = cutList.scrollLeft;
    target = Math.max(0, Math.min(max, target + pxDelta));
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: false });
  // ユーザがスクロールバーやドラッグで明示的に動かしたら、慣性アニメーションの
  // ターゲットを現在位置に追従させて違和感を出さない。
  cutList.addEventListener("pointerdown", () => {
    target = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  });
}

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

export function ensureSelectValue(select, value) {
  const normalized = value || "";
  if (normalized && !Array.from(select.options).some((item) => item.value === normalized)) {
    select.append(option(normalized, normalized));
  }
  select.value = normalized;
}

export function setAudioPath(value) {
  const path = value || "";
  elements.audio.value = path;
  ensureSelectValue(elements.audioSelect, path);
  elements.audioPathDisplay.textContent = path || "音声未選択";
}

// 編集面 (= プロジェクト全体で 1 本のタイムライン)。
//
// Phase 2 以降、cuts / telops / soundEffects / videoLayers / laneCounts は
// `state.scenario` 直下のフラット配列 (frame はプロジェクト絶対) に集約されている。
// この関数はその「1 枚のシーンのように振る舞うオブジェクト」を返す。
// ★ BGM / 背景動画 / ビジュアライザ / 体の揺れ (= ベッド設定) はここには無い。
//   それらは scenario.scenes[i] か scenario.projectSettings から取ること
//   (dialog.js: bedTarget / scenario.js: resolveSceneBed)。
export function activeScene() {
  if (!Array.isArray(state.scenario?.scenes) || state.scenario.scenes.length === 0) {
    attachScenarioCutsAlias(state.scenario);
  }
  return state.scenario;
}

export function missingMaterialMessage() {
  if (!state.manifest) {
    return "";
  }
  const backgroundSelected = (elements.background?.value ?? "").trim();
  if (backgroundSelected && !state.manifest.backgrounds?.length) {
    return "素材フォルダに背景画像やPSD/PNG画像素材などを入れて、素材再スキャンしてください";
  }
  const hasVisibleCharacter = state.currentCharacters.some((character) => character.showCharacter !== false);
  if (hasVisibleCharacter && !state.currentCharacters.some((character) => character.baseId)) {
    return "素材フォルダにPSDやPNG画像素材などを入れて、素材再スキャンしてください";
  }
  return "";
}

// ---------------------------------------------------------------------------
// payload / cutFromCurrent
// ---------------------------------------------------------------------------

function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

// キャラ配置タブのモーション入力から、選択中キャラの character.motion.settings に
// 渡す settings を構築する。未入力の数値項目は manifest 既定 (= global config.motion)
// を fallback。settings オブジェクトには shakeX/shakeY/zoom/move 全部の sub-config
// を入れる (= motionType 切替で input 値だけ変えれば即時反映、特定 type の値だけが
// 飛ぶことを避ける)。
export function collectCutMotionSettings() {
  const defaults = state.manifest?.config?.motion || {};
  const readNum = (input, fallback) => {
    const raw = input?.value;
    if (raw === undefined || raw === "") return Number(fallback) || 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : (Number(fallback) || 0);
  };
  const shakeXDef = defaults.shakeX || {};
  const shakeYDef = defaults.shakeY || {};
  const zoomDef = defaults.zoom || {};
  return {
    shakeX: {
      amplitude: readNum(elements.cutMotionShakeXAmplitude, shakeXDef.amplitude ?? 30),
      count: readNum(elements.cutMotionShakeXCount, shakeXDef.count ?? 3),
      duration: readNum(elements.cutMotionShakeXDuration, shakeXDef.duration ?? 0.6),
    },
    shakeY: {
      amplitude: readNum(elements.cutMotionShakeYAmplitude, shakeYDef.amplitude ?? 30),
      count: readNum(elements.cutMotionShakeYCount, shakeYDef.count ?? 3),
      duration: readNum(elements.cutMotionShakeYDuration, shakeYDef.duration ?? 0.6),
    },
    zoom: {
      scale: readNum(elements.cutMotionZoomScale, zoomDef.scale ?? 1.3),
      origin: elements.cutMotionZoomOrigin?.value || zoomDef.origin || "center",
    },
    move: {
      startFrame: readNum(elements.cutMotionMoveStartFrame, 0),
      // 持続フレーム既定 48 = PROJECT_FPS (24) × 2 秒。短すぎると編集しづらいため。
      durationFrame: readNum(elements.cutMotionMoveDurationFrame, 48),
      startX: readNum(elements.cutMotionMoveStartX, 0),
      startY: readNum(elements.cutMotionMoveStartY, 0),
      endX: readNum(elements.cutMotionMoveEndX, 0),
      endY: readNum(elements.cutMotionMoveEndY, 0),
      startOpacity: readNum(elements.cutMotionMoveStartOpacity, 1),
      endOpacity: readNum(elements.cutMotionMoveEndOpacity, 1),
      startRotation: readNum(elements.cutMotionMoveStartRotation, 0),
      endRotation: readNum(elements.cutMotionMoveEndRotation, 0),
      // 拡大率は乗算係数: 1.0 で等倍 (= キャラ scale そのまま)、0.5 で半分。
      // X/Y と同じく「キャラ自体への直接設定ではなく追加変換」という意味で "相対値"。
      startScale: readNum(elements.cutMotionMoveStartScale, 1),
      endScale: readNum(elements.cutMotionMoveEndScale, 1),
      // 回転 / 拡大の基準点 (1920×1080 絶対座標)。デフォルトは画面中央。
      pivotX: readNum(elements.cutMotionMovePivotX, 960),
      pivotY: readNum(elements.cutMotionMovePivotY, 540),
      easing: elements.cutMotionMoveEasing?.value || "linear",
    },
  };
}

// キャラの motion.settings を input に流し込む。motionSettings が無い場合 (= キャラに
// motion 未設定) は global config.motion の既定で埋める (= 編集前は既定値が見える)。
export function applyCutMotionSettingsToControls(motionSettings) {
  const defaults = state.manifest?.config?.motion || {};
  const ms = motionSettings || {};
  const merge = (key) => ({ ...(defaults[key] || {}), ...(ms[key] || {}) });
  const shakeX = merge("shakeX");
  const shakeY = merge("shakeY");
  const zoom = merge("zoom");
  const move = ms.move || {};
  const setNum = (input, value, fallback) => {
    if (!input) return;
    const n = Number(value ?? fallback);
    input.value = Number.isFinite(n) ? String(n) : "";
  };
  setNum(elements.cutMotionShakeXAmplitude, shakeX.amplitude, 30);
  setNum(elements.cutMotionShakeXCount, shakeX.count, 3);
  setNum(elements.cutMotionShakeXDuration, shakeX.duration, 0.6);
  setNum(elements.cutMotionShakeYAmplitude, shakeY.amplitude, 30);
  setNum(elements.cutMotionShakeYCount, shakeY.count, 3);
  setNum(elements.cutMotionShakeYDuration, shakeY.duration, 0.6);
  setNum(elements.cutMotionZoomScale, zoom.scale, 1.3);
  if (elements.cutMotionZoomOrigin) {
    elements.cutMotionZoomOrigin.value = zoom.origin || "center";
  }
  setNum(elements.cutMotionMoveStartFrame, move.startFrame, 0);
  setNum(elements.cutMotionMoveDurationFrame, move.durationFrame, 48);
  setNum(elements.cutMotionMoveStartX, move.startX, 0);
  setNum(elements.cutMotionMoveStartY, move.startY, 0);
  setNum(elements.cutMotionMoveEndX, move.endX, 0);
  setNum(elements.cutMotionMoveEndY, move.endY, 0);
  setNum(elements.cutMotionMoveStartOpacity, move.startOpacity, 1);
  setNum(elements.cutMotionMoveEndOpacity, move.endOpacity, 1);
  setNum(elements.cutMotionMoveStartRotation, move.startRotation, 0);
  setNum(elements.cutMotionMoveEndRotation, move.endRotation, 0);
  setNum(elements.cutMotionMoveStartScale, move.startScale, 1);
  setNum(elements.cutMotionMoveEndScale, move.endScale, 1);
  setNum(elements.cutMotionMovePivotX, move.pivotX, 960);
  setNum(elements.cutMotionMovePivotY, move.pivotY, 540);
  if (elements.cutMotionMoveEasing) {
    elements.cutMotionMoveEasing.value = move.easing || "linear";
  }
}

// motionType の選択値に応じて .motion-params の表示 / 非表示を切替。
// motionType.change から呼ばれる + loadCut 後にも呼ばれる。
export function syncMotionParamsVisibility() {
  const current = elements.motionType?.value || "none";
  const blocks = document.querySelectorAll("[data-motion-params]");
  for (const block of blocks) {
    block.hidden = (block.dataset.motionParams !== current);
  }
}

function collectCharacterEffectsFromControls() {
  const colorFilter = {
    enabled: !!elements.characterColorFilterEnabled?.checked,
    color: elements.characterColorFilterColor?.value || "#ffe8f9",
    opacity: clamp01(elements.characterColorFilterOpacity?.value, 0.4),
  };
  const glow = {
    enabled: !!elements.characterGlowEnabled?.checked,
    color: elements.characterGlowColor?.value || "#ffffff",
    blurPx: Math.max(0, Number(elements.characterGlowBlur?.value) || 0),
    opacity: clamp01(elements.characterGlowOpacity?.value, 0.7),
  };
  const dropShadow = {
    enabled: !!elements.characterDropShadowEnabled?.checked,
    color: elements.characterDropShadowColor?.value || "#000000",
    blurPx: Math.max(0, Number(elements.characterDropShadowBlur?.value) || 0),
    opacity: clamp01(elements.characterDropShadowOpacity?.value, 0.6),
    offsetX: Number(elements.characterDropShadowOffsetX?.value) || 0,
    offsetY: Number(elements.characterDropShadowOffsetY?.value) || 0,
  };
  return { colorFilter, glow, dropShadow };
}

// 数値入力の値を数値 or null に変換する。空欄 / 非数値は null (= 未指定)。
function _numOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 拡大率入力の値を 0.05〜4 の数値へ丸める。空欄 / 非数値 / 0 以下は 1.0 (= 既定)。
function _scaleOrOne(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return 1;
  return Math.min(4, Math.max(0.05, n));
}

// ケンバーンズ (シーン全体のズーム・パン) の既定値。
const KEN_BURNS_DEFAULTS = {
  enabled: false,
  startScale: 1,
  endScale: 1,
  startX: 0,
  startY: 0,
  endX: 0,
  endY: 0,
  easing: "ease_in_out",
};

const KEN_BURNS_EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out"];

// cut.state.kenBurns を正規化する (サーバ側 _normalize_ken_burns と同じ規則)。
export function normalizeKenBurns(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const num = (key) => {
    const n = Number(src[key]);
    return Number.isFinite(n) ? n : KEN_BURNS_DEFAULTS[key];
  };
  const scale = (key) => {
    const n = Number(src[key]);
    if (!Number.isFinite(n) || !(n > 0)) return 1;
    return Math.min(4, Math.max(0.05, n));
  };
  const easing = String(src.easing || KEN_BURNS_DEFAULTS.easing);
  return {
    enabled: Boolean(src.enabled),
    startScale: scale("startScale"),
    endScale: scale("endScale"),
    startX: num("startX"),
    startY: num("startY"),
    endX: num("endX"),
    endY: num("endY"),
    easing: KEN_BURNS_EASINGS.includes(easing) ? easing : KEN_BURNS_DEFAULTS.easing,
  };
}

// 既定のまま (= 無効かつ start/end とも等倍・移動なし) なら null。
// null を payload に載せると normalize 側でキーごと落ちるので、既存カットの
// scene-bundle token が変わらない。
export function collectKenBurnsFromControls() {
  const cfg = normalizeKenBurns({
    enabled: Boolean(elements.kenBurnsEnabled?.checked),
    startScale: elements.kenBurnsStartScale?.value,
    endScale: elements.kenBurnsEndScale?.value,
    startX: elements.kenBurnsStartX?.value,
    startY: elements.kenBurnsStartY?.value,
    endX: elements.kenBurnsEndX?.value,
    endY: elements.kenBurnsEndY?.value,
    easing: elements.kenBurnsEasing?.value,
  });
  const isDefault = !cfg.enabled
    && cfg.startScale === 1 && cfg.endScale === 1
    && cfg.startX === 0 && cfg.startY === 0
    && cfg.endX === 0 && cfg.endY === 0
    && cfg.easing === KEN_BURNS_DEFAULTS.easing;
  return isDefault ? null : cfg;
}

export function applyKenBurnsToControls(raw) {
  const cfg = normalizeKenBurns(raw);
  if (elements.kenBurnsEnabled) elements.kenBurnsEnabled.checked = cfg.enabled;
  if (elements.kenBurnsStartScale) elements.kenBurnsStartScale.value = String(cfg.startScale);
  if (elements.kenBurnsEndScale) elements.kenBurnsEndScale.value = String(cfg.endScale);
  if (elements.kenBurnsStartX) elements.kenBurnsStartX.value = String(cfg.startX);
  if (elements.kenBurnsStartY) elements.kenBurnsStartY.value = String(cfg.startY);
  if (elements.kenBurnsEndX) elements.kenBurnsEndX.value = String(cfg.endX);
  if (elements.kenBurnsEndY) elements.kenBurnsEndY.value = String(cfg.endY);
  if (elements.kenBurnsEasing) elements.kenBurnsEasing.value = cfg.easing;
}

// HEX 表示要素は app.js init で <span> から編集可能な <input> へ格上げされる。
// span のときは textContent、input のときは value に書き込む (両対応)。
function setSwatchDisplay(swatch, color) {
  if (!swatch) return;
  if (swatch.tagName === "INPUT") swatch.value = color;
  else swatch.textContent = color;
  swatch.style.setProperty("--color-value", color);
}

function setColorInputWithSwatch(input, swatch, value, fallback) {
  if (!input) return;
  const color = normalizeColorValue(value, fallback);
  input.value = color;
  setSwatchDisplay(swatch, color);
}

function applyCharacterEffectsToControls(effects) {
  const eff = (effects && typeof effects === "object") ? effects : {};
  const colorFilter = eff.colorFilter || {};
  if (elements.characterColorFilterEnabled) {
    elements.characterColorFilterEnabled.checked = !!colorFilter.enabled;
  }
  setColorInputWithSwatch(
    elements.characterColorFilterColor,
    elements.characterColorFilterColorValue,
    colorFilter.color,
    "#ffe8f9",
  );
  if (elements.characterColorFilterOpacity) {
    elements.characterColorFilterOpacity.value = String(clamp01(colorFilter.opacity, 0.4));
  }

  const glow = eff.glow || {};
  if (elements.characterGlowEnabled) elements.characterGlowEnabled.checked = !!glow.enabled;
  setColorInputWithSwatch(
    elements.characterGlowColor,
    elements.characterGlowColorValue,
    glow.color,
    "#ffffff",
  );
  if (elements.characterGlowBlur) {
    elements.characterGlowBlur.value = String(Math.max(0, Number(glow.blurPx) || 24));
  }
  if (elements.characterGlowOpacity) {
    elements.characterGlowOpacity.value = String(clamp01(glow.opacity, 0.7));
  }

  const ds = eff.dropShadow || {};
  if (elements.characterDropShadowEnabled) elements.characterDropShadowEnabled.checked = !!ds.enabled;
  setColorInputWithSwatch(
    elements.characterDropShadowColor,
    elements.characterDropShadowColorValue,
    ds.color,
    "#000000",
  );
  if (elements.characterDropShadowBlur) {
    elements.characterDropShadowBlur.value = String(Math.max(0, Number(ds.blurPx) || 12));
  }
  if (elements.characterDropShadowOpacity) {
    elements.characterDropShadowOpacity.value = String(clamp01(ds.opacity, 0.6));
  }
  if (elements.characterDropShadowOffsetX) {
    elements.characterDropShadowOffsetX.value = String(Number.isFinite(Number(ds.offsetX)) ? Number(ds.offsetX) : 8);
  }
  if (elements.characterDropShadowOffsetY) {
    elements.characterDropShadowOffsetY.value = String(Number.isFinite(Number(ds.offsetY)) ? Number(ds.offsetY) : 8);
  }
}

// セリフ編集パネルの「声」「感情」セレクタから cut.state に保存する voice override
// を組み立てる。話者キャラ定義に紐付いた default と一致するときは override を
// 残さない (= scenarios/main.json に voice キー自体を出さない)。これにより
// アセット管理画面で声 default を変えれば、未上書きカットは自動追従する。
function collectVoiceOverrideForPayload(speakerCharacterId) {
  const narratorKey = elements.dialogueVoiceSelect?.value || "";
  const style = elements.dialogueVoiceEmotion?.value || "";
  const persisted = combineNarratorAndStyle(narratorKey, style);
  if (!persisted.id && !persisted.emotion) return null;
  // 話者キャラ定義の default voice と完全一致する場合は override を出さない。
  let defaultId = "";
  let defaultEmotion = "";
  if (speakerCharacterId) {
    const liveChar = state.currentCharacters?.find((c) => c.id === speakerCharacterId);
    const characterId = liveChar?.characterId || "";
    const def = (state.manifest?.characters || []).find((c) => c.id === characterId);
    const v = def?.voice || {};
    defaultId = String(v.id || "");
    defaultEmotion = String(v.emotion || "");
  }
  if (persisted.id === defaultId && persisted.emotion === defaultEmotion) {
    return null;
  }
  return { id: persisted.id, emotion: persisted.emotion };
}

export function payload() {
  const defaults = state.manifest.defaults;
  updateSelectedCharacterFromControls();
  const speakerCharacterId = normalizedSpeakerCharacterId();
  const voiceOverride = collectVoiceOverrideForPayload(speakerCharacterId);
  return {
    ...(voiceOverride ? { voice: voiceOverride } : {}),
    background: elements.background.value ?? defaults.background,
    backgroundBlurPx: Math.max(0, Number(elements.backgroundBlurPx?.value) || 0),
    backgroundColor: normalizeColorValue(elements.backgroundColor?.value || "#000000", "#000000"),
    backgroundColorOpacity: clamp01(elements.backgroundColorOpacity?.value, 0),
    foreground: elements.foreground?.value ?? "",
    // 前景の表示位置 (plane 左上の絶対座標, 0,0 = 画面左上)。空欄/非数値は null =
    // 中央配置 (scene-builder 側でデフォルト中央)。キャラ x/y と同じルール。
    foregroundX: _numOrNull(elements.foregroundX?.value),
    foregroundY: _numOrNull(elements.foregroundY?.value),
    // 前景 / 背景の拡大率と背景の表示位置。空欄 = 既定 (1.0 / 中央)。
    foregroundScale: _scaleOrOne(elements.foregroundScale?.value),
    backgroundX: _numOrNull(elements.backgroundX?.value),
    backgroundY: _numOrNull(elements.backgroundY?.value),
    backgroundScale: _scaleOrOne(elements.backgroundScale?.value),
    // ケンバーンズ (シーン全体のズーム・パン)。
    kenBurns: collectKenBurnsFromControls(),
    // M-1: cut.state.motionType / motionSettings は撤去。各キャラの character.motion
    // (= updateSelectedCharacterFromControls 経由で書き込まれる) を直接使う。
    characterEffects: collectCharacterEffectsFromControls(),
    // 編集中キャラ id を per-cut で永続化。再生→停止→同じカットへ戻ったときに
    // 「最前面 (index=0) に勝手に戻る」現象を防ぐ (= loadCut が disk 値を最優先
    // で復元する)。記録された id が現在の cut にいなければ index=0 にフォールバック。
    editingCharacterId: state.currentCharacters?.[state.selectedCharacterIndex]?.id || "",
    showSpeechBox: elements.showSpeechBox.checked,
    text: elements.dialogue.value,
    speakerCharacterId,
    characters: state.currentCharacters.map((character) => ({ ...character })),
    textStyle: {
      fontSize: Number(elements.fontSize.value),
      fontFamily: elements.fontFamily.value,
      fontWeight: elements.fontWeight.value,
      align: elements.align.value,
      // R8: 個別文字間カーニングはフォーム入力を持たないので、現在のカットの値を
      // そのまま carry する (= payload 再構築で消えないようにする)。空なら省略。
      charKerning: (() => {
        const cur = state.scenario?.cuts?.find((c) => c && c.id === state.selectedCutId);
        const ck = cur?.state?.textStyle?.charKerning;
        return ck && typeof ck === "object" && Object.keys(ck).length > 0 ? { ...ck } : undefined;
      })(),
      speechPlacement: elements.speechPlacement.value,
      lines: Number(elements.lines.value),
      boxOpacity: opacityToRender(elements.boxOpacity.value),
      boxBorderWidth: Number(state.manifest.config.textDefaults?.boxBorderWidth ?? 3),
      boxBorderColor: state.manifest.config.textDefaults?.boxBorderColor ?? "#ffffff",
      boxBackgroundColor: state.manifest.config.textDefaults?.boxBackgroundColor ?? "#14181c",
      textColor: elements.cutTextColor?.value || state.manifest.config.textDefaults?.textColor || "#ffffff",
      textOutlineWidth: Number(
        elements.cutTextOutlineWidth?.value ?? state.manifest.config.textDefaults?.textOutlineWidth ?? 0
      ),
      textOutlineColor:
        elements.cutTextOutlineColor?.value || state.manifest.config.textDefaults?.textOutlineColor || "#666666",
      boxOverlayImage: state.manifest.config.textDefaults?.boxOverlayImage ?? "",
      speechOffsetX: Number(state.manifest.config.textDefaults?.speechOffsetX ?? 120),
      speechOffsetY: Number(state.manifest.config.textDefaults?.speechOffsetY ?? 70),
      speechPaddingX: Number(state.manifest.config.textDefaults?.speechPaddingX ?? 60),
      speechPaddingY: Number(state.manifest.config.textDefaults?.speechPaddingY ?? 70),
      lineGap: (() => {
        // カット個別の行間入力を最優先。空欄/NaN ならデフォルト。
        const raw = elements.cutLineSpacing?.value;
        if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
        return Number(state.manifest.config.textDefaults?.lineGap ?? 16);
      })(),
      letterSpacing: (() => {
        // R7: テロップと同じ 1/1000em 単位。10 刻みに丸めて -500..1000 にクランプ。
        const raw = elements.cutLetterSpacing?.value;
        if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) {
          return Math.max(-500, Math.min(1000, Math.round(Number(raw) / 10) * 10));
        }
        return Number(state.manifest.config.textDefaults?.letterSpacing ?? 0);
      })(),
      speakerNameFontSize: Number(state.manifest.config.textDefaults?.speakerNameFontSize ?? 28),
      showSpeakerName:
        elements.showSpeakerName?.checked ??
        state.manifest.config.textDefaults?.showSpeakerName ??
        true,
      inactiveCharacterOpacity: Number(state.manifest.config.textDefaults?.inactiveCharacterOpacity ?? 0.5),
      // セリフ文字の光彩 / ドロップシャドウ (cut 単位)。
      // テロップ用 glow/dropShadow と同じ shape ({enabled,color,blurPx,opacity[,offsetX/Y]})。
      dialogueGlow: collectDialogueGlowFromControls(),
      dialogueDropShadow: collectDialogueDropShadowFromControls(),
    },
  };
}

function collectDialogueGlowFromControls() {
  const td = state.manifest?.config?.textDefaults || {};
  const fallback = td.dialogueGlow || {};
  return {
    enabled: !!elements.cutDialogueGlowEnabled?.checked,
    color: elements.cutDialogueGlowColor?.value || fallback.color || "#ffffff",
    blurPx: Math.max(0, Math.min(200, Number(elements.cutDialogueGlowBlur?.value) || 0)),
    opacity: Math.max(0, Math.min(1, Number(elements.cutDialogueGlowOpacity?.value) || 0)),
  };
}

function collectDialogueDropShadowFromControls() {
  const td = state.manifest?.config?.textDefaults || {};
  const fallback = td.dialogueDropShadow || {};
  return {
    enabled: !!elements.cutDialogueDropShadowEnabled?.checked,
    color: elements.cutDialogueDropShadowColor?.value || fallback.color || "#000000",
    blurPx: Math.max(0, Math.min(200, Number(elements.cutDialogueDropShadowBlur?.value) || 0)),
    offsetX: Math.max(-200, Math.min(200, Number(elements.cutDialogueDropShadowOffsetX?.value) || 0)),
    offsetY: Math.max(-200, Math.min(200, Number(elements.cutDialogueDropShadowOffsetY?.value) || 0)),
    opacity: Math.max(0, Math.min(1, Number(elements.cutDialogueDropShadowOpacity?.value) || 0)),
  };
}

// セリフ文字エフェクトの cut.state.textStyle → UI コントロール書き戻し。
// 値の優先順位は cut.state.textStyle > textDefaults > 内部 fallback。
function applyDialogueGlowAndShadowToControls(textStyle) {
  const td = state.manifest?.config?.textDefaults || {};
  const glow = {
    enabled: false, color: "#ffffff", blurPx: 12, opacity: 0.8,
    ...(td.dialogueGlow || {}),
    ...(textStyle?.dialogueGlow || {}),
  };
  if (elements.cutDialogueGlowEnabled) elements.cutDialogueGlowEnabled.checked = !!glow.enabled;
  if (elements.cutDialogueGlowColor) {
    const v = normalizeColorValue(glow.color, "#ffffff");
    elements.cutDialogueGlowColor.value = v;
    setSwatchDisplay(elements.cutDialogueGlowColorValue, v);
  }
  if (elements.cutDialogueGlowBlur) elements.cutDialogueGlowBlur.value = Number(glow.blurPx) || 0;
  if (elements.cutDialogueGlowOpacity) elements.cutDialogueGlowOpacity.value = Number(glow.opacity) || 0;

  const ds = {
    enabled: false, color: "#000000", blurPx: 6, offsetX: 4, offsetY: 4, opacity: 0.7,
    ...(td.dialogueDropShadow || {}),
    ...(textStyle?.dialogueDropShadow || {}),
  };
  if (elements.cutDialogueDropShadowEnabled) elements.cutDialogueDropShadowEnabled.checked = !!ds.enabled;
  if (elements.cutDialogueDropShadowColor) {
    const v = normalizeColorValue(ds.color, "#000000");
    elements.cutDialogueDropShadowColor.value = v;
    setSwatchDisplay(elements.cutDialogueDropShadowColorValue, v);
  }
  if (elements.cutDialogueDropShadowBlur) elements.cutDialogueDropShadowBlur.value = Number(ds.blurPx) || 0;
  if (elements.cutDialogueDropShadowOffsetX) elements.cutDialogueDropShadowOffsetX.value = Number(ds.offsetX) || 0;
  if (elements.cutDialogueDropShadowOffsetY) elements.cutDialogueDropShadowOffsetY.value = Number(ds.offsetY) || 0;
  if (elements.cutDialogueDropShadowOpacity) elements.cutDialogueDropShadowOpacity.value = Number(ds.opacity) || 0;
}

export function cutFromCurrent() {
  updateSelectedCharacterFromControls();
  const existing = state.selectedCutId
    ? state.scenario?.cuts?.find((cut) => cut.id === state.selectedCutId)
    : null;
  // payload() に対応するフォーム入力が無いカット状態フィールドは、既存 cut.state
  // から継承する。これらを引き継がないと、キャラクター追加 / 削除など他の操作で
  // updateSelectedCutFromCurrent() が走るたびに毎回 motionSettings (横シェイク等の
  // amplitude / count / duration や zoom scale)、speakerName のキャッシュなどが
  // 消える。cut state schema (`_normalize_cut`) に従って維持すべき項目だけ列挙。
  const carriedFromExisting = {};
  const baseState = (existing && existing.state) || {};
  // motionSettings は M-1 で撤去 (= character.motion へ分散)。speakerName と
  // characterLayout のみ carry。
  for (const key of ["speakerName", "characterLayout"]) {
    if (key in baseState) carriedFromExisting[key] = baseState[key];
  }
  return {
    id: state.selectedCutId || `cut_${Date.now()}`,
    // ★ sceneId はメモリ専用フィールド (所属シーン)。ここで引き継がないと
    //   updateSelectedCutFromCurrent がカットを作り直すたびに所属が消え、
    //   そのカットしか持たないシーンが「空」と見なされて削除される。
    //   (dev_docs/plans/multi-scene.md §3.2 / 二形式データの落とし穴)
    ...(existing && existing.sceneId ? { sceneId: existing.sceneId } : {}),
    startFrame: existing ? cutStartFrame(existing) : 0,
    durationFrame: Math.max(1, Number(elements.duration?.dataset.frames) || PROJECT_FPS * 3),
    audio: elements.audio.value.trim(),
    // 発話ディレイ (秒): 話者音声を冒頭から遅らせる (cut 直下フィールド)。
    audioDelaySec: (() => {
      const raw = Number(elements.cutAudioDelayInput?.value);
      if (Number.isFinite(raw) && raw > 0) return Math.round(raw * 1000) / 1000;
      return 0;
    })(),
    // R10: カット入りトランジション (cut 直下フィールド)。
    transition: collectCutTransitionFromControls(existing),
    state: { ...carriedFromExisting, ...payload() },
  };
}

// R10: 演出タブのトランジション入力から { type, durationFrame } を組む。
function collectCutTransitionFromControls(existing) {
  const typeEl = elements.cutTransitionTypeSelect;
  const durEl = elements.cutTransitionDurationInput;
  if (!typeEl) {
    // フォーム未生成時は既存値を維持。
    const t = existing?.transition;
    return t && typeof t === "object" ? { type: String(t.type || "none"), durationFrame: Math.max(0, Math.round(Number(t.durationFrame) || 0)) } : { type: "none", durationFrame: 0 };
  }
  const type = String(typeEl.value || "none");
  if (type === "none") return { type: "none", durationFrame: 0 };
  const raw = Number(durEl?.value);
  const durationFrame = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : Math.max(1, Math.round(PROJECT_FPS * 0.5));
  const out = { type, durationFrame: Math.max(1, durationFrame) };
  if (type === "wipe") {
    const d = String(elements.cutTransitionWipeDirSelect?.value || "right").toLowerCase();
    out.wipeDirection = ["right", "left", "up", "down"].includes(d) ? d : "right";
  }
  return out;
}

// ---------------------------------------------------------------------------
// カット複数選択 / 並び替え
// ---------------------------------------------------------------------------

export function ensureCutSelectionState() {
  if (!(state.selectedCutIds instanceof Set)) {
    state.selectedCutIds = new Set();
  }
  if (typeof state.cutSelectionAnchorId !== "string") {
    state.cutSelectionAnchorId = "";
  }
  return state.selectedCutIds;
}

export function clearMultiCutSelection() {
  if (state.selectedCutIds instanceof Set && state.selectedCutIds.size > 0) {
    state.selectedCutIds = new Set();
  }
  state.cutSelectionAnchorId = "";
}

export function selectedCutIdSet() {
  ensureCutSelectionState();
  if (state.selectedCutIds.size > 0) return state.selectedCutIds;
  if (state.selectedCutId) return new Set([state.selectedCutId]);
  return new Set();
}

function setRangeSelection(anchorId, primaryId) {
  const cuts = state.scenario.cuts;
  const ai = cuts.findIndex((c) => c.id === anchorId);
  const bi = cuts.findIndex((c) => c.id === primaryId);
  if (ai < 0 || bi < 0) return;
  const lo = Math.min(ai, bi);
  const hi = Math.max(ai, bi);
  const ids = new Set();
  for (let i = lo; i <= hi; i += 1) ids.add(cuts[i].id);
  state.selectedCutIds = ids;
  state.cutSelectionAnchorId = anchorId;
}

// R3: タイムラインのカットレーン(バー)クリックの選択処理。cutList 撤去後はこちらが
// カット選択の入口。通常クリック=単一選択 (多重選択を解除)、Shift=範囲、Cmd/Ctrl=トグル。
// 複製/ペーストで残った selectedCutIds が「通常クリックしても消えない」バグの対策でもある。
export function selectCutFromTimeline(cut, mods = {}) {
  if (!cut) return;
  if (mods.shiftKey) {
    ensureCutSelectionState();
    const anchor = state.cutSelectionAnchorId || state.selectedCutId || cut.id;
    state.selectedCutId = cut.id;
    setRangeSelection(anchor, cut.id);
    loadCut(cut, { keepTelopSelection: true }).catch((error) => console.error(error));
    return;
  }
  if (mods.metaKey || mods.ctrlKey) {
    ensureCutSelectionState();
    const ids = new Set(state.selectedCutIds);
    if (ids.size === 0 && state.selectedCutId) ids.add(state.selectedCutId);
    if (ids.has(cut.id)) ids.delete(cut.id);
    else ids.add(cut.id);
    state.selectedCutIds = ids;
    state.selectedCutId = cut.id;
    state.cutSelectionAnchorId = cut.id;
    loadCut(cut, { keepTelopSelection: true }).catch((error) => console.error(error));
    return;
  }
  // 通常クリック: 単一選択に戻す (多重選択を解除 = 複製/ペースト後の残留ハイライト解消)。
  clearMultiCutSelection();
  state.cutSelectionAnchorId = cut.id;
  loadCut(cut).catch((error) => console.error(error));
}

function handleCutItemClick(cut, event) {
  if (event.shiftKey) {
    ensureCutSelectionState();
    const anchor = state.cutSelectionAnchorId
      || state.selectedCutId
      || cut.id;
    state.selectedCutId = cut.id;
    setRangeSelection(anchor, cut.id);
    // 範囲選択時は loadCut でカット内容を切り替えるが、編集画面のテロップ選択は維持。
    loadCut(cut, { keepTelopSelection: true }).catch((error) => console.error(error));
    return;
  }
  // 通常クリックは単一選択に戻す
  clearMultiCutSelection();
  state.cutSelectionAnchorId = cut.id;
  loadCut(cut).catch((error) => console.error(error));
}

function bindCutItemDrag(item, cut) {
  // HTML5 drag で順序入れ替え。複数選択中はそれを丸ごとドラッグする。
  item.addEventListener("dragstart", (event) => {
    const ids = Array.from(selectedCutIdSet());
    if (!ids.includes(cut.id)) ids.push(cut.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-splite-cut-ids", ids.join(","));
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    elements.cutList.querySelectorAll(".cut-drop-before, .cut-drop-after")
      .forEach((el) => el.classList.remove("cut-drop-before", "cut-drop-after"));
  });
  item.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("application/x-splite-cut-ids")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = item.getBoundingClientRect();
    const after = (event.clientX - rect.left) > rect.width / 2;
    item.classList.toggle("cut-drop-after", after);
    item.classList.toggle("cut-drop-before", !after);
  });
  item.addEventListener("dragleave", () => {
    item.classList.remove("cut-drop-before", "cut-drop-after");
  });
  item.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types?.includes("application/x-splite-cut-ids")) return;
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/x-splite-cut-ids") || "";
    const sourceIds = raw.split(",").filter(Boolean);
    item.classList.remove("cut-drop-before", "cut-drop-after");
    if (sourceIds.length === 0) return;
    const rect = item.getBoundingClientRect();
    const after = (event.clientX - rect.left) > rect.width / 2;
    moveCutsTo(sourceIds, cut.id, after);
  });
}

function moveCutsTo(sourceIds, targetId, after) {
  const cuts = state.scenario.cuts;
  const moving = sourceIds
    .map((id) => cuts.findIndex((c) => c.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (moving.length === 0) return;
  if (sourceIds.includes(targetId)) return; // 自分の上には落とさない
  const movedCuts = moving.map((i) => cuts[i]);
  // 後ろから消す
  for (let i = moving.length - 1; i >= 0; i -= 1) {
    cuts.splice(moving[i], 1);
  }
  let targetIndex = cuts.findIndex((c) => c.id === targetId);
  if (targetIndex < 0) {
    cuts.push(...movedCuts);
  } else {
    if (after) targetIndex += 1;
    cuts.splice(targetIndex, 0, ...movedCuts);
  }
  // ★ 移動したカットは古い sceneId を持ったまま別の場所に現れる。落とした位置の
  //   並びから所属を取り直さないと、間のシーンが吸収されて消える。
  restampCutsSceneByPosition(sourceIds);
  recalcCutStartSec();
  renderCutList();
  scheduleScenarioSave();
  recordHistory();
}

export function duplicateSelectedCuts() {
  // 単一 (selectedCutId) でも複数選択 (selectedCutIds) でも、塊の直後に複製を挿入する。
  // 後続の元データはそのまま、複製群が連続して入る。
  const cuts = state.scenario.cuts;
  const ids = Array.from(selectedCutIdSet());
  if (ids.length === 0) return;
  const indices = ids
    .map((id) => cuts.findIndex((c) => c.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) return;
  const lastIdx = indices[indices.length - 1];
  // クローン前に各 source の old startFrame を控えて、リンクアイテム複製のオフセット
  // 算出に使う (= 元 source.startFrame と clone.startFrame の差分でずらす)。
  const sourceOldStarts = new Map();
  for (const i of indices) {
    const src = cuts[i];
    sourceOldStarts.set(src.id, Math.max(0, Math.round(Number(src.startFrame) || 0)));
  }
  // 元 source.id → clone.id の対応も控える (linkedCutId 張り替え用)。
  const sourceToCloneId = new Map();
  const clones = indices.map((i) => {
    const src = cuts[i];
    const clone = JSON.parse(JSON.stringify(src));
    clone.id = `cut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    sourceToCloneId.set(src.id, clone.id);
    return clone;
  });
  cuts.splice(lastIdx + 1, 0, ...clones);
  // 新しい複製群を選択状態にする
  state.selectedCutId = clones[clones.length - 1].id;
  state.selectedCutIds = new Set(clones.map((c) => c.id));
  state.cutSelectionAnchorId = clones[0].id;
  recalcCutStartSec();

  // リンクアイテムを複製: source の linkedCutId に該当する telop / SE / VL を
  // 同種の clone にコピーし、startFrame を「source からの相対オフセット」を保って
  // clone の新 startFrame 基準にシフト、linkedCutId を clone.id に張り替える。
  // 元アイテム自体は触らない (= 元カットに紐付いたまま残る)。
  const scene = state.scenario;
  if (scene && sourceToCloneId.size > 0) {
    const cloneShiftBySource = new Map();
    for (const [sourceId, cloneId] of sourceToCloneId) {
      const clone = cuts.find((c) => c.id === cloneId);
      const oldStart = sourceOldStarts.get(sourceId) ?? 0;
      if (clone) cloneShiftBySource.set(sourceId, clone.startFrame - oldStart);
    }
    const _cloneItem = (item, idPrefix, newLinkedCutId, shift) => {
      const dup = JSON.parse(JSON.stringify(item));
      dup.id = `${idPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      dup.linkedCutId = newLinkedCutId;
      dup.startFrame = Math.max(0, (Number(item.startFrame) || 0) + shift);
      return dup;
    };
    const newTelops = [], newSEs = [], newVLs = [];
    for (const [sourceId, cloneId] of sourceToCloneId) {
      const shift = cloneShiftBySource.get(sourceId) ?? 0;
      if (Array.isArray(scene.telops)) {
        for (const t of scene.telops) {
          if (t?.linkedCutId === sourceId) newTelops.push(_cloneItem(t, "telop", cloneId, shift));
        }
      }
      if (Array.isArray(scene.soundEffects)) {
        for (const s of scene.soundEffects) {
          if (s?.linkedCutId === sourceId) newSEs.push(_cloneItem(s, "se", cloneId, shift));
        }
      }
      if (Array.isArray(scene.videoLayers)) {
        for (const v of scene.videoLayers) {
          if (v?.linkedCutId === sourceId) newVLs.push(_cloneItem(v, "vl", cloneId, shift));
        }
      }
    }
    if (Array.isArray(scene.telops)) scene.telops.push(...newTelops);
    if (Array.isArray(scene.soundEffects)) scene.soundEffects.push(...newSEs);
    if (Array.isArray(scene.videoLayers)) scene.videoLayers.push(...newVLs);
  }

  loadCut(clones[clones.length - 1]).catch((error) => console.error(error));
  scheduleScenarioSave();
  recordHistory();
  showToast(`カットを${clones.length}件複製しました`);
}

export function deleteSelectedCuts() {
  const cuts = state.scenario.cuts;
  const ids = Array.from(selectedCutIdSet());
  if (ids.length === 0) return;
  const indices = ids
    .map((id) => cuts.findIndex((c) => c.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) return;

  // 削除対象カットにリンクされたテロップ / 効果音 / 動画レイヤーを集計し、
  // 件数を確認ダイアログで提示してからまとめて削除する。Undo で 1 ステップで戻る。
  const deletedIdSet = new Set(ids);
  const scene = state.scenario;
  const linkedTelops = (scene?.telops || []).filter((t) => deletedIdSet.has(t?.linkedCutId));
  const linkedSEs = (scene?.soundEffects || []).filter((s) => deletedIdSet.has(s?.linkedCutId));
  const linkedVLs = (scene?.videoLayers || []).filter((v) => deletedIdSet.has(v?.linkedCutId));
  const linkedTotal = linkedTelops.length + linkedSEs.length + linkedVLs.length;
  if (linkedTotal > 0) {
    const parts = [];
    if (linkedTelops.length > 0) parts.push(`テロップ ${linkedTelops.length} 件`);
    if (linkedSEs.length > 0) parts.push(`効果音 ${linkedSEs.length} 件`);
    if (linkedVLs.length > 0) parts.push(`動画レイヤー ${linkedVLs.length} 件`);
    const msg = `${indices.length} 件のカットに紐付いた ${parts.join(" / ")} も一緒に削除されます。よろしいですか？`;
    if (!window.confirm(msg)) return;
    // リンク済みアイテムを削除
    if (scene) {
      const telopIds = new Set(linkedTelops.map((t) => t.id));
      const seIds = new Set(linkedSEs.map((s) => s.id));
      const vlIds = new Set(linkedVLs.map((v) => v.id));
      if (Array.isArray(scene.telops)) {
        scene.telops = scene.telops.filter((t) => !telopIds.has(t?.id));
      }
      if (Array.isArray(scene.soundEffects)) {
        scene.soundEffects = scene.soundEffects.filter((s) => !seIds.has(s?.id));
      }
      if (Array.isArray(scene.videoLayers)) {
        scene.videoLayers = scene.videoLayers.filter((v) => !vlIds.has(v?.id));
      }
    }
  }

  const firstIdx = indices[0];
  for (let k = indices.length - 1; k >= 0; k -= 1) {
    cuts.splice(indices[k], 1);
  }
  clearMultiCutSelection();
  // 削除した位置の前のカットを次の active に。なければ先頭、それも無ければ null。
  const next = cuts[Math.min(firstIdx, cuts.length - 1)] || cuts[0] || null;
  state.selectedCutId = next?.id || null;
  recalcCutStartSec();
  if (next) {
    loadCut(next).catch((error) => console.error(error));
  } else {
    renderCutList();
  }
  scheduleScenarioSave();
  recordHistory();
  const linkedSuffix = linkedTotal > 0 ? ` (関連アイテム ${linkedTotal} 件含む)` : "";
  showToast(`カットを${indices.length}件削除しました${linkedSuffix}`);
}

export function moveSelectedCutsBy(direction) {
  // direction = -1 (前へ) / +1 (後ろへ)。複数選択なら塊で移動。
  const cuts = state.scenario.cuts;
  const ids = Array.from(selectedCutIdSet());
  if (ids.length === 0) return;
  const indices = ids
    .map((id) => cuts.findIndex((c) => c.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) return;
  if (direction < 0 && indices[0] === 0) return;
  if (direction > 0 && indices[indices.length - 1] === cuts.length - 1) return;
  // 連続塊なら 1 件まとめて、不連続なら端から動かす
  if (direction < 0) {
    for (const idx of indices) {
      const target = idx - 1;
      if (target < 0 || ids.includes(cuts[target].id)) continue;
      const [moved] = cuts.splice(idx, 1);
      cuts.splice(target, 0, moved);
    }
  } else {
    for (let k = indices.length - 1; k >= 0; k -= 1) {
      const idx = indices[k];
      const target = idx + 1;
      if (target >= cuts.length || ids.includes(cuts[target].id)) continue;
      const [moved] = cuts.splice(idx, 1);
      cuts.splice(target, 0, moved);
    }
  }
  // ★ シーン境界をまたいで動かした場合、移動先のシーンに入れ直す (移動元の
  //   sceneId が残ると、間のシーンが吸収されて消える)。
  restampCutsSceneByPosition(ids);
  recalcCutStartSec();
  renderCutList();
  scheduleScenarioSave();
  recordHistory();
}

// ---------------------------------------------------------------------------
// loadCut / renderCutList
// ---------------------------------------------------------------------------

export async function loadCut(cut, options = {}) {
  const data = cut.state || {};
  const textStyle = data.textStyle || {};

  state.selectedCutId = cut.id;
  // 選択中シーンをこのカットの所属へ追従させる (シーンレーンのハイライトと
  // シーン設定ダイアログの編集対象が「今見ているカット」に揃う)。
  syncSelectedSceneToCurrent();
  // カットを開いたら右パネルはカット編集に戻す。テロップ / 効果音選択は解除。
  // ただし keepTelopSelection / keepSoundEffectSelection / keepVideoLayerSelection
  // で呼ばれた場合は維持する。
  const hasMultiTelop = state.selectedTelopIds && state.selectedTelopIds.size > 0;
  const needsTelopReset = !options.keepTelopSelection
    && (state.selectedTelopId != null || hasMultiTelop);
  const needsSoundEffectReset = !options.keepSoundEffectSelection
    && state.selectedSoundEffectId != null;
  const needsVideoLayerReset = !options.keepVideoLayerSelection
    && state.selectedVideoLayerId != null;
  if (needsTelopReset || needsSoundEffectReset || needsVideoLayerReset
      || (state.editorTarget !== "cut"
        && !(options.keepTelopSelection && state.editorTarget === "telop")
        && !(options.keepSoundEffectSelection && state.editorTarget === "soundEffect")
        && !(options.keepVideoLayerSelection && state.editorTarget === "videoLayer"))) {
    if (needsTelopReset) {
      state.selectedTelopId = null;
      state.selectedTelopIds = new Set();
    }
    if (needsSoundEffectReset) {
      state.selectedSoundEffectId = null;
    }
    if (needsVideoLayerReset) {
      state.selectedVideoLayerId = null;
    }
    if (!(options.keepTelopSelection && state.editorTarget === "telop")
        && !(options.keepSoundEffectSelection && state.editorTarget === "soundEffect")
        && !(options.keepVideoLayerSelection && state.editorTarget === "videoLayer")) {
      state.editorTarget = "cut";
    }
    deps.applyEditorTargetView();
  }
  // ensureSelectValue で「manifest に無いパス」も option を補って残す。
  // 直接 select.value = "..." すると、option 一覧に値が無いとき DOM が
  // 静かに空文字に倒れ、その後の payload() が空を読み出してカット保存時に
  // 値が消えるバグの原因になる (例: 別プロジェクトから duplicate した
  // カットで前景パスが現プロジェクト manifest に無いケース)。
  ensureSelectValue(
    elements.background,
    Object.hasOwn(data, "background") ? (data.background ?? "") : (state.manifest.defaults.background || ""),
  );
  if (elements.backgroundBlurPx) {
    const raw = Number(data.backgroundBlurPx);
    elements.backgroundBlurPx.value = String(Number.isFinite(raw) ? Math.max(0, raw) : 0);
  }
  if (elements.backgroundColor) {
    const v = normalizeColorValue(data.backgroundColor || "#000000", "#000000");
    elements.backgroundColor.value = v;
    setSwatchDisplay(elements.backgroundColorValue, v);
  }
  // R10: カット入りトランジション (cut 直下) を演出タブへ反映。
  if (elements.cutTransitionTypeSelect) {
    const tr = (cut && typeof cut.transition === "object") ? cut.transition : null;
    const type = tr ? String(tr.type || "none") : "none";
    elements.cutTransitionTypeSelect.value = type;
    if (elements.cutTransitionDurationInput) {
      const df = tr ? Math.max(0, Math.round(Number(tr.durationFrame) || 0)) : 0;
      elements.cutTransitionDurationInput.value = String(df > 0 ? df : Math.round(PROJECT_FPS * 0.5));
    }
    if (elements.cutTransitionWipeDirSelect) {
      const dir = tr && tr.wipeDirection ? String(tr.wipeDirection) : "right";
      elements.cutTransitionWipeDirSelect.value = ["right", "left", "up", "down"].includes(dir) ? dir : "right";
    }
    // ワイプ方向セレクトは type=wipe のときだけ表示。
    if (elements.cutTransitionWipeDirLabel) {
      elements.cutTransitionWipeDirLabel.hidden = type !== "wipe";
    }
  }
  // シーン先頭カットでは scene.transition が優先される。その旨を出す (Phase 3)。
  if (elements.cutTransitionOverriddenNote) {
    elements.cutTransitionOverriddenNote.hidden = !isCutTransitionOverriddenByScene(cut);
  }
  // 発話ディレイ (cut 直下フィールド) を演出タブへ反映。
  if (elements.cutAudioDelayInput) {
    const ad = cut ? Math.max(0, Number(cut.audioDelaySec) || 0) : 0;
    elements.cutAudioDelayInput.value = ad > 0 ? String(ad) : "0";
  }
  if (elements.backgroundColorOpacity) {
    const raw = Number(data.backgroundColorOpacity);
    elements.backgroundColorOpacity.value = String(
      Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0,
    );
  }
  if (elements.foreground) {
    ensureSelectValue(
      elements.foreground,
      Object.hasOwn(data, "foreground") ? (data.foreground ?? "") : "",
    );
  }
  // 前景 X / Y。null / 未指定は空欄 (= 中央配置)。
  if (elements.foregroundX) {
    elements.foregroundX.value = _numOrNull(data.foregroundX) == null ? "" : String(_numOrNull(data.foregroundX));
  }
  if (elements.foregroundY) {
    elements.foregroundY.value = _numOrNull(data.foregroundY) == null ? "" : String(_numOrNull(data.foregroundY));
  }
  // 前景 / 背景 拡大率、背景 X / Y。1.0 / null は空欄表示 (placeholder が既定値を示す)。
  if (elements.foregroundScale) {
    const fs = _scaleOrOne(data.foregroundScale);
    elements.foregroundScale.value = fs === 1 ? "" : String(fs);
  }
  if (elements.backgroundScale) {
    const bs = _scaleOrOne(data.backgroundScale);
    elements.backgroundScale.value = bs === 1 ? "" : String(bs);
  }
  if (elements.backgroundX) {
    elements.backgroundX.value = _numOrNull(data.backgroundX) == null ? "" : String(_numOrNull(data.backgroundX));
  }
  if (elements.backgroundY) {
    elements.backgroundY.value = _numOrNull(data.backgroundY) == null ? "" : String(_numOrNull(data.backgroundY));
  }
  applyKenBurnsToControls(data.kenBurns);
  // M-1: motionType / motionSettings は character.motion へ統合。
  // loadCut の段階では仮 reset しておき、loadCharacterIntoControls (= 選択中キャラ
  // が決まった後) で各キャラの motion を input に流し込む。
  if (elements.motionType) elements.motionType.value = "none";
  applyCutMotionSettingsToControls(null);
  syncMotionParamsVisibility();
  applyCharacterEffectsToControls(data.characterEffects);
  // 編集中キャラの復元優先順:
  //   1. cut.state.editingCharacterId (= disk 保存) を最優先で復元 — カットへ
  //      戻ってきたとき常に同じキャラから再開できる。
  //   2. loadCut 直前まで選択していたキャラ id をフォールバック — 別カットから
  //      切り替えた直後で、たまたま同じ id がいる場合に拾う。
  //   3. どちらも一致しなければ 0 (= 最前面)。
  const previousSelectedCharId = state.currentCharacters?.[state.selectedCharacterIndex]?.id || null;
  state.currentCharacters = normalizeCutCharacters(data);
  const savedEditingCharId = (typeof data.editingCharacterId === "string" && data.editingCharacterId)
    ? data.editingCharacterId : null;
  let restoredIndex = -1;
  if (savedEditingCharId) {
    restoredIndex = state.currentCharacters.findIndex((c) => c?.id === savedEditingCharId);
  }
  if (restoredIndex < 0 && previousSelectedCharId) {
    restoredIndex = state.currentCharacters.findIndex((c) => c?.id === previousSelectedCharId);
  }
  state.selectedCharacterIndex = restoredIndex >= 0 ? restoredIndex : 0;
  elements.dialogue.value = data.text || "";
  renderCharacterSelect();
  renderSpeakerSelect(data.speakerCharacterId || "");
  // 旧実装は speakerCharacterId 不在時に cut.state を mutate して silent
  // scheduleScenarioSave() を走らせていた。これは:
  //  - ユーザーが編集していないのに自動保存してしまう
  //  - cut.state が毎回書き換わるため scene-bundle の payload SHA1 が変わり、
  //    安定 token + 永久キャッシュの効果を打ち消してしまう
  //  - normalizeCutCharacters が新しい id を発行する経路では、loadCut のたびに
  //    speakerCharacterId が更新されてしまう
  // 表示・描画上は payload() / normalizedSpeakerCharacterId() が同じフォール
  // バックを行うため、ここで cut.state を書き換える必要は無い (UI 側の select
  // は renderSpeakerSelect が既に第一キャラへ寄せている)。
  loadCharacterIntoControls(selectedCharacter());
  elements.fontSize.value = textStyle.fontSize ?? state.manifest.defaults.textStyle.fontSize;
  ensureSelectValue(
    elements.fontFamily,
    textStyle.fontFamily || state.manifest.config.defaultFont,
  );
  fillFontWeights(textStyle.fontWeight || state.manifest.config.defaultFontWeight || "regular");
  elements.align.value = textStyle.align || "left";
  elements.speechPlacement.value = textStyle.speechPlacement || "bottom";
  elements.lines.value = textStyle.lines || 2;
  elements.boxOpacity.value = opacityToUi(textStyle.boxOpacity ?? 215);
  if (elements.cutTextColor) {
    const cutTextColor = textStyle.textColor
      ?? state.manifest.config.textDefaults?.textColor
      ?? "#ffffff";
    elements.cutTextColor.value = normalizeColorValue(cutTextColor, "#ffffff");
    setSwatchDisplay(elements.cutTextColorValue, elements.cutTextColor.value);
  }
  if (elements.cutTextOutlineWidth) {
    elements.cutTextOutlineWidth.value =
      textStyle.textOutlineWidth ?? state.manifest.config.textDefaults?.textOutlineWidth ?? 0;
  }
  if (elements.cutTextOutlineColor) {
    const cutTextOutlineColor = textStyle.textOutlineColor
      ?? state.manifest.config.textDefaults?.textOutlineColor
      ?? "#666666";
    elements.cutTextOutlineColor.value = normalizeColorValue(cutTextOutlineColor, "#666666");
    setSwatchDisplay(elements.cutTextOutlineColorValue, elements.cutTextOutlineColor.value);
  }
  if (elements.cutLetterSpacing) {
    elements.cutLetterSpacing.value =
      Number(textStyle.letterSpacing ?? state.manifest.config.textDefaults?.letterSpacing ?? 0);
  }
  if (elements.cutLineSpacing) {
    elements.cutLineSpacing.value =
      Number(textStyle.lineGap ?? state.manifest.config.textDefaults?.lineGap ?? 16);
  }
  applyDialogueGlowAndShadowToControls(textStyle);
  elements.showSpeechBox.checked = data.showSpeechBox ?? true;
  if (elements.showSpeakerName) {
    const fallback = state.manifest?.config?.textDefaults?.showSpeakerName ?? true;
    const styleValue = data.textStyle?.showSpeakerName;
    elements.showSpeakerName.checked = (typeof styleValue === "boolean" ? styleValue : fallback);
  }
  if (elements.showCharacter) {
    // 「キャラクターを表示」は cut 全体共通。全キャラに伝搬する設計のため、
    // 復元時も全員 true なら ON、誰か 1 人でも false なら OFF として表示する。
    const characters = state.currentCharacters || [];
    elements.showCharacter.checked =
      characters.length === 0
        ? true
        : characters.every((ch) => (ch?.showCharacter ?? true) !== false);
  }
  elements.duration.value = formatTimecode(cutDurationFrame(cut));
  elements.duration.dataset.frames = String(cutDurationFrame(cut));
  setAudioPath(cut.audio || "");
  deps.syncPresetName();
  deps.syncDialogueVoiceFromSpeaker();
  renderCutList();
  if (options.render === false) {
    return;
  }
  await renderPreview();
  // ロード完了後の playhead を永続化。これで次回プロジェクトを開いた時に
  // 同じカット同じ位置から再開でき、一覧サムネ (cache/thumbnail.png) もそこから生成される。
  schedulePlayheadSave();
}

export function renderCutList() {
  // DOM 再生成でカードの offsetLeft が変わるので、autoScrollCutListToActive の
  // 「同 id ならスキップ」判定をリセットしておく。次の seek / 再生 tick で
  // 視界外ならちゃんと引き込まれる。
  resetCutListAutoScrollTracking();
  elements.cutList.innerHTML = "";
  const multiSelected = state.selectedCutIds instanceof Set ? state.selectedCutIds : null;
  state.scenario.cuts.forEach((cut, index) => {
    const item = document.createElement("div");
    const isActive = cut.id === state.selectedCutId;
    const isInRangeSelection = !!multiSelected && multiSelected.has(cut.id) && !isActive;
    let className = "cut-item";
    if (isActive) className += " active";
    if (isInRangeSelection) className += " range-selected";
    item.className = className;
    item.role = "button";
    item.tabIndex = 0;
    item.dataset.cutId = cut.id;
    item.draggable = true;

    const title = document.createElement("div");
    title.className = "cut-title";
    const text = cut.state?.text || "";
    title.textContent = `${index + 1}. ${truncateText(text, 24) || "無題"}`;
    if (text) title.title = text;

    const meta = document.createElement("div");
    meta.className = "cut-meta";
    // メタ行は話者名のみ。音声ファイル名はカードを間延びさせるので tooltip に回す。
    // 話者未指定のカットだけは情報を絶やさないようタイムコードを表示する。
    const speakerId = cut.state?.speakerCharacterId || "";
    const speakerInst = (cut.state?.characters || []).find((c) => c && c.id === speakerId);
    const speakerName = speakerInst?.name
      || (speakerId ? "未割当" : "");
    const startLabel = formatTimecode(cutStartFrame(cut));
    const durLabel = formatTimecode(cutDurationFrame(cut));
    meta.textContent = speakerName || `${startLabel} · ${durLabel}`;
    meta.title = `${startLabel} · ${durLabel}${cut.audio ? `\n${cut.audio}` : ""}`;

    // active / range-selected カットには話者キャラクターの定義色を流し込む。
    // 話者なし or 色未指定なら tokens.css の var(--accent) (= 既定値) を継承。
    // 範囲選択 (range-selected) でも単独 active と同じ speaker color を使うことで、
    // 「単独選択 → 緑、範囲選択 → 青」のようなギャップを無くし、選択ステータスの
    // 認知一貫性を保つ。
    if (isActive || isInRangeSelection) {
      const speakerColor = characterColorById(speakerInst?.characterId || "");
      if (speakerColor) {
        item.style.setProperty("--accent", speakerColor);
        item.style.setProperty(
          "--accent-soft",
          `color-mix(in srgb, ${speakerColor} 28%, var(--surface-2))`,
        );
        item.style.setProperty(
          "--accent-ring",
          `color-mix(in srgb, ${speakerColor} 40%, transparent)`,
        );
      }
    }

    item.append(title, meta);
    item.addEventListener("click", (event) => handleCutItemClick(cut, event));
    // ダブルクリックは「カット先頭まで playhead をシーク」専用 (range 選択や
    // loadCut の挙動は単発クリック側に任せる)。dblclick 発火時にはブラウザが
    // 内部的に click も2回流すが、handleCutItemClick はそのカットへの loadCut が
    // 中心で副作用が薄いため、二重呼び出しは許容する。
    item.addEventListener("dblclick", (event) => {
      event.preventDefault();
      seekPlayheadToSec(cutStartSec(cut));
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadCut(cut);
      }
    });
    bindCutItemDrag(item, cut);
    elements.cutList.append(item);
  });

  const addItem = document.createElement("button");
  addItem.type = "button";
  addItem.className = "cut-item add-cut-card";
  addItem.innerHTML = `<span class="add-cut-plus" aria-hidden="true">＋</span><span>カット追加</span>`;
  addItem.addEventListener("click", addCutFromCurrent);
  elements.cutList.append(addItem);

  renderTelopTrack();
}

// ---------------------------------------------------------------------------
// カット追加・複製・編集ハンドラ
// ---------------------------------------------------------------------------

export function addCutFromCurrent() {
  const cut = cutFromCurrent();
  cut.id = `cut_${Date.now()}`;
  state.selectedCutId = cut.id;
  // cutFromCurrent は「選択中カットの sceneId」を引き継ぐが、追加先は末尾なので
  // 末尾カットのシーンに入れる (前方のシーンを宣言したまま末尾に置かない)。
  const lastCut = state.scenario.cuts[state.scenario.cuts.length - 1];
  if (lastCut?.sceneId) cut.sceneId = lastCut.sceneId;
  else delete cut.sceneId;
  state.scenario.cuts.push(cut);
  recalcCutStartSec();
  renderCutList();
  scheduleScenarioSave();
  recordHistory();
  showToast("カットを追加しました");
}

// ---------------------------------------------------------------------------
// カット↔︎アイテムのリンク (linkedCutId) 操作
// ---------------------------------------------------------------------------

// 現在選択中のテロップ / 効果音 / 動画レイヤーを再生位置のカットへリンク。
// 種別をまたぐ複数選択 (Cmd/Ctrl+クリック) に対応し、1 アクションで全部紐付ける。
// トグル UI の現在状態を計算する。3 値:
//   "empty"   - 選択 0 件 (= ボタン disable)
//   "link"    - 選択中にリンクされていないアイテムがある (= 次のクリックで全部リンク)
//   "unlink"  - 選択中の全アイテムがリンク済み (= 次のクリックで全部解除)
// 仕様: 混在 (一部リンク済み + 一部未リンク) のときは "link" を返す。
// → ユーザは「いったん全部リンク」して、もう一度押せば「全部解除」できる。
function _computeLinkToggleState() {
  const scene = state.scenario;
  if (!scene) return "empty";
  const telopIds = state.selectedTelopIds instanceof Set ? state.selectedTelopIds : new Set();
  const seIds = state.selectedSoundEffectIds instanceof Set ? state.selectedSoundEffectIds : new Set();
  const vlIds = state.selectedVideoLayerIds instanceof Set ? state.selectedVideoLayerIds : new Set();
  if (telopIds.size + seIds.size + vlIds.size === 0) return "empty";
  let hasUnlinked = false;
  let total = 0;
  let linked = 0;
  const _check = (list, set) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || !set.has(item.id)) continue;
      total += 1;
      if (item.linkedCutId) linked += 1;
      else hasUnlinked = true;
    }
  };
  _check(scene.telops, telopIds);
  _check(scene.soundEffects, seIds);
  _check(scene.videoLayers, vlIds);
  if (total === 0) return "empty";
  return hasUnlinked ? "link" : "unlink";
}

export function updateLinkToggleButton() {
  const btn = elements.linkToggleButton;
  const icon = elements.linkToggleIcon;
  const label = elements.linkToggleLabel;
  if (!btn || !icon || !label) return;
  const state_ = _computeLinkToggleState();
  if (state_ === "empty") {
    btn.disabled = true;
    icon.textContent = "link";
    label.textContent = "カットへリンク";
    btn.title = "リンク対象のテロップ/効果音/動画レイヤーを選択してください";
    return;
  }
  btn.disabled = false;
  if (state_ === "unlink") {
    icon.textContent = "link_off";
    label.textContent = "リンク解除";
    btn.title = "選択中のリンクをすべて解除";
  } else {
    icon.textContent = "link";
    label.textContent = "カットへリンク";
    btn.title = "再生位置のカットへリンク (混在選択時はまとめてリンク → もう一度押すと解除)";
  }
}

// 単一トグルエントリポイント。ボタン押下から呼ぶ。
// state="link" → linkSelectedItemsToCurrentCut(), state="unlink" → unlinkSelectedItems()
export function toggleLinkForSelection() {
  const s = _computeLinkToggleState();
  if (s === "empty") return;
  if (s === "unlink") {
    unlinkSelectedItems();
  } else {
    linkSelectedItemsToCurrentCut();
  }
  updateLinkToggleButton();
}

export function linkSelectedItemsToCurrentCut() {
  const scene = state.scenario;
  if (!scene) return;
  const cuts = state.scenario?.cuts || [];
  // リンク先カットの決定 (優先順):
  //   1. state.selectedCutId — cut-list で active 表示中のカット (= ユーザが視覚的に「これ」と認識しているカット)
  //   2. playhead を含むカット
  //   3. 先頭カット (フォールバック)
  // 1 を優先することで「playhead が別カットに居る最中にリンク」しても、選択中のカットに紐付くので
  // 「リンクしたつもりが違うカットに紐付いていた」事故を防ぐ。
  let targetCut = null;
  if (state.selectedCutId) {
    targetCut = cuts.find((c) => c?.id === state.selectedCutId) || null;
  }
  if (!targetCut) {
    const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
    targetCut = cuts.find((c) => {
      const s = Math.max(0, Math.round(Number(c?.startFrame) || 0));
      const e = s + Math.max(1, Math.round(Number(c?.durationFrame) || 0));
      return s <= playheadFrame && playheadFrame < e;
    }) || cuts[0];
  }
  if (!targetCut?.id) {
    showToast("リンク先のカットが見つかりません", "error");
    return;
  }
  const telopIds = state.selectedTelopIds instanceof Set ? state.selectedTelopIds : new Set();
  const seIds = state.selectedSoundEffectIds instanceof Set ? state.selectedSoundEffectIds : new Set();
  const vlIds = state.selectedVideoLayerIds instanceof Set ? state.selectedVideoLayerIds : new Set();
  let count = 0;
  if (Array.isArray(scene.telops)) {
    for (const t of scene.telops) {
      if (t && telopIds.has(t.id)) { t.linkedCutId = targetCut.id; count += 1; }
    }
  }
  if (Array.isArray(scene.soundEffects)) {
    for (const s of scene.soundEffects) {
      if (s && seIds.has(s.id)) { s.linkedCutId = targetCut.id; count += 1; }
    }
  }
  if (Array.isArray(scene.videoLayers)) {
    for (const v of scene.videoLayers) {
      if (v && vlIds.has(v.id)) { v.linkedCutId = targetCut.id; count += 1; }
    }
  }
  if (count === 0) {
    showToast("選択中のアイテムがありません", "info");
    return;
  }
  scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  showToast(`${count} 件をカット「${truncateText(targetCut.state?.text || "無題", 16)}」へリンクしました`);
}

export function unlinkSelectedItems() {
  const scene = state.scenario;
  if (!scene) return;
  const telopIds = state.selectedTelopIds instanceof Set ? state.selectedTelopIds : new Set();
  const seIds = state.selectedSoundEffectIds instanceof Set ? state.selectedSoundEffectIds : new Set();
  const vlIds = state.selectedVideoLayerIds instanceof Set ? state.selectedVideoLayerIds : new Set();
  let count = 0;
  for (const t of (scene.telops || [])) {
    if (t && telopIds.has(t.id) && t.linkedCutId) { t.linkedCutId = null; count += 1; }
  }
  for (const s of (scene.soundEffects || [])) {
    if (s && seIds.has(s.id) && s.linkedCutId) { s.linkedCutId = null; count += 1; }
  }
  for (const v of (scene.videoLayers || [])) {
    if (v && vlIds.has(v.id) && v.linkedCutId) { v.linkedCutId = null; count += 1; }
  }
  if (count === 0) {
    showToast("リンク済みアイテムが選択されていません", "info");
    return;
  }
  scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  showToast(`${count} 件のカットリンクを解除しました`);
}

export function duplicateCutAt(index) {
  const source = state.scenario.cuts[index];
  if (!source) return;
  // 複製前の source.startFrame を記録 (linkedCutId 経由のアイテム複製でオフセット計算に使う)
  const sourceOldStart = Math.max(0, Math.round(Number(source.startFrame) || 0));
  const clone = JSON.parse(JSON.stringify(source));
  clone.id = `cut_${Date.now()}`;
  state.scenario.cuts.splice(index + 1, 0, clone);
  state.selectedCutId = clone.id;
  // recalcCutStartSec 内で「source 以降のカット」の startFrame が動き、
  // それに紐付くリンクアイテムもまとめて平行移動される。
  recalcCutStartSec();

  // linkedCutId === source.id のアイテムを複製し、clone の新位置にぶら下げる。
  // 注: 既存のリンクアイテム自体は source に紐付いたまま残る (= 元位置のまま)。
  // ここでは「複製先にも同じテロップ・SE・VL 群を持たせる」のが目的。
  const scene = state.scenario;
  if (scene) {
    const cloneShift = clone.startFrame - sourceOldStart;
    const _cloneItem = (item, idPrefix) => {
      const dup = JSON.parse(JSON.stringify(item));
      dup.id = `${idPrefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      dup.linkedCutId = clone.id;
      dup.startFrame = Math.max(0, (Number(item.startFrame) || 0) + cloneShift);
      return dup;
    };
    if (Array.isArray(scene.telops)) {
      const linked = scene.telops.filter((t) => t?.linkedCutId === source.id);
      for (const t of linked) scene.telops.push(_cloneItem(t, "telop"));
    }
    if (Array.isArray(scene.soundEffects)) {
      const linked = scene.soundEffects.filter((s) => s?.linkedCutId === source.id);
      for (const s of linked) scene.soundEffects.push(_cloneItem(s, "se"));
    }
    if (Array.isArray(scene.videoLayers)) {
      const linked = scene.videoLayers.filter((v) => v?.linkedCutId === source.id);
      for (const v of linked) scene.videoLayers.push(_cloneItem(v, "vl"));
    }
  }

  loadCut(clone).catch((error) => console.error(error));
  scheduleScenarioSave();
  recordHistory();
  showToast("カットを複製しました");
}

export function updateSelectedCutFromCurrent() {
  if (!state.selectedCutId) {
    return;
  }
  const index = state.scenario.cuts.findIndex((item) => item.id === state.selectedCutId);
  if (index < 0) {
    return;
  }
  state.scenario.cuts[index] = cutFromCurrent();
  recalcCutStartSec();
  renderCutList();
}

export function trimCutEndToPlayhead() {
  // 再生バー直下のカットの終端を再生位置まで縮める / 延ばす。
  // テロップ位置とカット境界を素早く揃えるためのアクション。
  const cuts = state.scenario?.cuts || [];
  if (cuts.length === 0) return;
  const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  // playhead が乗っているカットを探す。境界に居るときは「区間内」優先 → 直前カット終端の順。
  let target = null;
  for (const cut of cuts) {
    const s = cutStartFrame(cut);
    const e = s + cutDurationFrame(cut);
    if (playheadFrame >= s && playheadFrame < e) { target = cut; break; }
  }
  if (!target) {
    let best = null;
    for (const cut of cuts) {
      const s = cutStartFrame(cut);
      if (s <= playheadFrame && (best == null || cutStartFrame(best) < s)) best = cut;
    }
    target = best || cuts[0];
  }
  const start = cutStartFrame(target);
  const newDurationFrame = playheadFrame - start;
  // 先端で押した場合は無視する (duration 0 を作らない)。
  if (newDurationFrame <= 0) return;
  target.durationFrame = Math.max(1, newDurationFrame);
  recalcCutStartSec();
  renderCutList();
  scheduleScenarioSave();
  recordHistory();
  renderPreview();
  showToast(`カット終端を ${formatTimecode(target.durationFrame)} に調整しました`);
}

export function splitCutAtPlayhead() {
  // 再生位置でカットを 2 つに分割する。
  // 前半は元カットの先頭側を維持し audio/dialogue を残す。
  // 後半は視覚状態 (キャラ・背景・効果) を引き継ぎつつ audio/dialogue を空にする。
  const cuts = state.scenario?.cuts || [];
  if (cuts.length === 0) return;
  const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  let targetIndex = -1;
  for (let i = 0; i < cuts.length; i += 1) {
    const s = cutStartFrame(cuts[i]);
    const e = s + cutDurationFrame(cuts[i]);
    if (playheadFrame >= s && playheadFrame < e) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0) {
    showToast("再生位置がカット範囲外です");
    return;
  }
  const target = cuts[targetIndex];
  const start = cutStartFrame(target);
  const dur = cutDurationFrame(target);
  const splitOffset = playheadFrame - start;
  if (splitOffset <= 0 || splitOffset >= dur) {
    showToast("カット境界では分割できません");
    return;
  }
  const clone = JSON.parse(JSON.stringify(target));
  clone.id = `cut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  clone.audio = "";
  if (clone.state && typeof clone.state === "object") {
    clone.state.text = "";
  }
  target.durationFrame = splitOffset;
  clone.durationFrame = dur - splitOffset;
  cuts.splice(targetIndex + 1, 0, clone);
  recalcCutStartSec();
  renderCutList();
  scheduleScenarioSave();
  recordHistory();
  renderPreview();
  showToast(`カットを ${formatTimecode(splitOffset)} で分割しました`);
}

// 再生位置で選択中の効果音を 2 つに「擬似分割」する。
// 新しい音声ファイルは作らず、durationFrame / audioOffsetSec を調整して
// 「元と続き」の 2 つの SE にする。
export function splitSelectedSoundEffect() {
  const scene = state.scenario;
  const list = Array.isArray(scene?.soundEffects) ? scene.soundEffects : [];
  const id = state.selectedSoundEffectId;
  const se = id ? list.find((s) => s && s.id === id) : null;
  if (!se) {
    showToast("分割する効果音が選択されていません");
    return;
  }
  const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const startFrame = soundEffectStartFrame(se);
  const assetDurSec = Number(state.soundEffectDurations?.get(se.src)) || 0;
  const curDurFrames = soundEffectDurationFrame(se, assetDurSec);
  const endFrame = startFrame + curDurFrames;
  // 再生位置が SE 区間外なら分割できない
  if (playheadFrame <= startFrame || playheadFrame >= endFrame) {
    showToast("再生位置が効果音の範囲外です");
    return;
  }
  const splitOffsetFrames = playheadFrame - startFrame;
  const splitOffsetSec = splitOffsetFrames / PROJECT_FPS;
  // 新 SE の audioOffsetSec: 元 offset + 分割位置までの経過。loop ならアセット長で modulo。
  const baseOffsetSec = Math.max(0, Number(se.audioOffsetSec) || 0);
  let newOffsetSec = baseOffsetSec + splitOffsetSec;
  if (se.loop && assetDurSec > 0) {
    newOffsetSec = newOffsetSec % assetDurSec;
  }
  const clone = { ...se, id: generateSoundEffectId() };
  clone.startFrame = playheadFrame;
  clone.durationFrame = endFrame - playheadFrame;
  clone.audioOffsetSec = Math.max(0, newOffsetSec);
  // 「先頭側」のフェードアウトと「続き側」のフェードインは継ぎ目で二重に掛かると
  // クリックノイズになりがち。継ぎ目側の fade は 0 に倒す (区間先頭と末尾だけに掛ける
  // 既存仕様を分割境界には掛けない)。
  clone.fadeInSec = 0;
  // 元 SE 側
  se.durationFrame = splitOffsetFrames;
  se.fadeOutSec = 0;
  // リストに挿入してソート
  list.push(clone);
  list.sort((a, b) => soundEffectStartFrame(a) - soundEffectStartFrame(b));
  state.selectedSoundEffectId = clone.id;
  scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  renderSoundEffectEditor();
  renderPreview();
  showToast(`効果音を ${formatTimecode(splitOffsetFrames)} で分割しました`);
}

// 再生位置で選択中の動画レイヤーを 2 つに「擬似分割」する。
// trimStartSec / trimEndSec を調整して、元と続きの 2 つの動画レイヤーにする。
export function splitSelectedVideoLayer() {
  const scene = state.scenario;
  const list = Array.isArray(scene?.videoLayers) ? scene.videoLayers : [];
  const id = state.selectedVideoLayerId;
  const vl = id ? list.find((v) => v && v.id === id) : null;
  if (!vl) {
    showToast("分割する動画が選択されていません");
    return;
  }
  const playheadFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const startFrame = videoLayerStartFrame(vl);
  // trim 末端は ffprobe 由来の素材長で補完される (`videoLayerTrimEndSec` 第二引数)。
  const meta = state.videoLayerDurations?.get(vl.src);
  const assetDurSec = Number(meta?.duration) || 0;
  const trimStart = videoLayerTrimStartSec(vl);
  const trimEnd = videoLayerTrimEndSec(vl, assetDurSec);
  const spanSec = Math.max(0, trimEnd - trimStart);
  const endFrame = startFrame + Math.round(spanSec * PROJECT_FPS);
  if (playheadFrame <= startFrame || playheadFrame >= endFrame) {
    showToast("再生位置が動画の範囲外です");
    return;
  }
  const splitOffsetFrames = playheadFrame - startFrame;
  const splitOffsetSec = splitOffsetFrames / PROJECT_FPS;
  // 元 / 続きの素材内位置 (= trim 範囲を [trimStart, splitPoint], [splitPoint, trimEnd] に割る)
  const splitTrimSec = trimStart + splitOffsetSec;
  const clone = { ...vl, id: generateVideoLayerId() };
  clone.startFrame = playheadFrame;
  clone.trimStartSec = Number(splitTrimSec.toFixed(3));
  clone.trimEndSec = Number(trimEnd.toFixed(3));
  // フェード境界は SE と同じく継ぎ目を 0 にする (二重 fade 回避)
  clone.fadeInEnabled = false;
  // 元側
  vl.trimEndSec = Number(splitTrimSec.toFixed(3));
  vl.fadeOutEnabled = false;
  list.push(clone);
  list.sort((a, b) => videoLayerStartFrame(a) - videoLayerStartFrame(b));
  state.selectedVideoLayerId = clone.id;
  scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  renderVideoLayerEditor();
  // scene-bundle の token は cut payload しか覆っていないため、videoLayers の
  // 増減 / split で token が変わらず active scene が再利用 → 新 clone の plane
  // が GL に出ない (= 視覚が消える、splitした瞬間の音声 sync も壊れる) 現象が起きる。
  // 明示的に active scene を破棄して次の renderPreview で再 build させる。
  invalidateRendererCachesForConfigChange();
  renderPreview();
  showToast(`動画を ${formatTimecode(splitOffsetFrames)} で分割しました`);
}

export function scheduleScenarioSave() {
  window.clearTimeout(state.autoSaveTimer);
  // ★ projectId をスケジュール時点で snapshot して、saveScenario に渡す。
  //   こうしないと、debounce 中にプロジェクトを切り替えた場合「古いプロジェクトの
  //   payload が新しい active project に書き込まれる」race が起きる
  //   (= dj2 の中身が動画テスト２のコピーに置き換わる現象の本命経路)。
  const scheduledProjectId = state.activeProjectId || null;
  state.autoSaveTimer = window.setTimeout(() => {
    // ★ 二重防御: 発火時に「snapshot した projectId と現在の activeProjectId が
    //   一致するか」を verify。不一致なら「scheduleScenarioSave 後にプロジェクトが
    //   切り替わった」ことを意味するため、ここの save を abort する。state.scenario は
    //   既に新プロジェクトの内容に置き換わっている可能性が高い (= 旧 payload が
    //   旧プロジェクトに書ければ良いが、ペイロード自体も整合しないことが多い)。
    //   切替時の cancelPendingScenarioSave({flush:true}) で本来は不要だが、await を
    //   跨いだイベント発火など想定外の経路もあり得るのでここで最終ゲート。
    if (scheduledProjectId && state.activeProjectId && scheduledProjectId !== state.activeProjectId) {
      console.warn(
        `[scenario] auto save aborted: project changed during debounce (${scheduledProjectId} → ${state.activeProjectId})`,
      );
      return;
    }
    saveScenario({ silent: true, projectId: scheduledProjectId })
      .catch((error) => {
        console.error(error);
        showToast("自動保存に失敗しました", "error");
      });
  }, 700);
}

// プロジェクト切替時に呼ぶ: 未発火の自動保存タイマーをクリアし、必要なら
// 同期的に flush する。clearTimeout だけだと「直前の編集が永続化されない」
// 可能性が残るので、明示 flush も同時に行う。
export async function cancelPendingScenarioSave({ flush = true } = {}) {
  const hadPending = state.autoSaveTimer != null;
  window.clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = null;
  if (!flush || !hadPending) return;
  // flush: 残弾は捨て、現在の state.scenario を「今の activeProjectId」に書く。
  // race 防止のため、その時点の activeProjectId を snapshot して渡す。
  const pid = state.activeProjectId || null;
  try {
    await saveScenario({ silent: true, projectId: pid });
  } catch (error) {
    console.warn("[scenario] pending flush failed", error);
  }
}

export function handleEditorChanged() {
  if (state.isLoadingCut) {
    return;
  }
  deps.normalizeBoxOpacityInput();
  // 「キャラクターを表示」は cut 全体に効くため、selected キャラ更新前に全員へ伝搬。
  // (旧実装は selected character のみ反映され、話者しか制御できなかった)
  if (elements.showCharacter && Array.isArray(state.currentCharacters)) {
    const show = elements.showCharacter.checked;
    for (const ch of state.currentCharacters) {
      if (ch && typeof ch === "object") ch.showCharacter = show;
    }
  }
  updateSelectedCutFromCurrent();
  scheduleScenarioSave();
  renderPreview();
  recordHistory();
}

// ---------------------------------------------------------------------------
// シナリオ保存
// ---------------------------------------------------------------------------

export async function saveScenario(options = {}) {
  recalcCutStartSec();
  const targetProjectId = options.projectId || state.activeProjectId || state.manifest?.projectId || "";
  const loadedProjectId = state.loadedProjectId || state.manifest?.projectId || "";
  if (targetProjectId && loadedProjectId && targetProjectId !== loadedProjectId) {
    const message = `scenario save aborted: loaded project ${loadedProjectId} != target project ${targetProjectId}`;
    console.warn(`[scenario] ${message}`);
    throw new Error(message);
  }
  // メモリはフラット + プロジェクト絶対フレーム。ディスクは per-scene +
  // シーンローカル。ここが唯一の書き出し側の変換点 (dev_docs/plans/multi-scene.md §3.2)。
  const payload = {
    ...toDiskScenario(state.scenario),
    projectId: loadedProjectId || targetProjectId || null,
  };
  // ★ options.projectId が指定されたら project-scoped エンドポイントへ。
  //   scheduleScenarioSave からは「スケジュール時点の activeProjectId」を渡してもらう。
  //   未指定なら互換のため active project 依存の旧エンドポイント (race リスクあり)。
  const explicitPid = targetProjectId;
  const url = explicitPid
    ? `/api/projects/${encodeURIComponent(explicitPid)}/scenario`
    : "/api/scenario";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  // 自動保存（silent）でレスポンスを取り込むと、保存リクエスト送信〜レスポンス受信の
  // 間にユーザーが入力した変更（テロップのテキスト/色など）が
  // サーバの「保存時点」のシナリオで上書きされて消えてしまう。
  // 明示保存のときだけサーバ側の正規化結果を取り込む。
  const body = await response.json().catch(() => null);
  // サムネは「scenario が変わった可能性がある」タイミングで dirty 化する。
  // 実際に投げるのは renderPreview({ captureThumbnail: true }) 経由の v2 still
  // render 成功後だけ (= 古い canvas を保存しないように)。
  markThumbnailDirty();
  if (!options.silent && body) {
    state.scenario = attachScenarioCutsAlias(body);
    if (explicitPid) state.loadedProjectId = explicitPid;
    renderCutList();
    showToast("シナリオを保存しました");
    // 明示保存のタイミングで現在のカットを再 render してサムネを焼き直す。
    // renderPreview が v2 still render を成功させた直後にサムネ送信が走る。
    // v2 でない / scene が無い / race で skip された場合はサムネは送られない。
    renderPreview({ captureThumbnail: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// カット一括追加ダイアログ
// ---------------------------------------------------------------------------

// 連番付きの音声ファイル名から「番号」「セリフ部分」を取り出す。
// 想定: 「<num>-<セリフ>{-<任意>}.<拡張子>」
// 例: "0-こんにちは.wav", "12-じゃあね-take2.wav"
export function parseSequencedAudioName(filePath) {
  const base = basenameOnly(filePath);
  const stripped = base.replace(/\.[^./\\]+$/, "");
  const m = stripped.match(/^(\d+)-(.+)$/);
  if (!m) return null;
  const seq = parseInt(m[1], 10);
  if (!Number.isFinite(seq)) return null;
  // 「セリフ部分」: 後ろに「-suffix」が連結されていれば取り除く（最初の「-」までをセリフとする運用）
  // ただし、セリフに - を含めたい場合もあるので、末尾のみ「-take2」のような接尾辞を識別するのは曖昧。
  // 仕様に従い、まずは全体をセリフとみなす（最初の N-までを除いた残り）。
  // ユーザーが望む「-任意の文字列」サフィックス排除はいったん最後の "-XXX" だけ落とすシンプル方式とする。
  let dialogue = m[2];
  // 末尾に1つだけの "-suffix" があり、suffix が短い (8文字以内) で記号 (-_数字英字) のみなら剥がす。
  const suffixMatch = dialogue.match(/^(.+?)-([\w_]{1,16})$/);
  if (suffixMatch) {
    dialogue = suffixMatch[1];
  }
  return { seq, dialogue, audio: filePath };
}

export function getSequencedAudioCandidates() {
  const list = state.manifest?.audio || [];
  const items = [];
  for (const a of list) {
    const path = a?.path || a?.id || "";
    const parsed = parseSequencedAudioName(path);
    if (parsed) items.push(parsed);
  }
  items.sort((x, y) => x.seq - y.seq);
  return items;
}

function setAddCutBatchTab(tabId) {
  for (const tab of elements.addCutBatchTabs || []) {
    const active = tab.dataset.batchTab === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of elements.addCutBatchTabPanels || []) {
    panel.classList.toggle("hidden", panel.dataset.batchTabPanel !== tabId);
  }
  if (elements.addCutBatchModeText) elements.addCutBatchModeText.checked = tabId === "text";
  if (elements.addCutBatchModeAudio) elements.addCutBatchModeAudio.checked = tabId === "audio";
  if (elements.addCutBatchModeYaml) elements.addCutBatchModeYaml.checked = tabId === "yaml";
  // 音声ファイルモードは pre-recorded wav の取り込みなので、自動生成 UI は隠す。
  const showAutoSynth = tabId !== "audio";
  if (elements.addCutBatchAutoSynthLabel) {
    elements.addCutBatchAutoSynthLabel.hidden = !showAutoSynth;
  }
  if (elements.addCutBatchAutoSynthHint) {
    elements.addCutBatchAutoSynthHint.hidden = !showAutoSynth;
  }
}

export function openAddCutBatchDialog() {
  const dialog = elements.addCutBatchDialog;
  if (!dialog) return;
  if (elements.addCutBatchTextInput) elements.addCutBatchTextInput.value = "";
  // 音声候補数で音声タブの enable/disable を決める
  const audioItems = getSequencedAudioCandidates();
  const audioEnabled = audioItems.length > 0;
  const audioTabBtn = (elements.addCutBatchTabs || []).find?.(
    (t) => t.dataset.batchTab === "audio",
  ) || Array.from(elements.addCutBatchTabs || []).find((t) => t.dataset.batchTab === "audio");
  if (audioTabBtn) {
    audioTabBtn.disabled = !audioEnabled;
    audioTabBtn.classList.toggle("disabled", !audioEnabled);
  }
  // 既定タブはテキスト。ただし音声候補があるときも自動で切り替えはしない
  // (ユーザーの明示的な選択を尊重)。前回開いた時の選択は持ち越さず常に text 起点。
  setAddCutBatchTab("text");
  if (elements.addCutBatchAudioHint) {
    elements.addCutBatchAudioHint.textContent = audioEnabled
      ? `プロジェクトに連番つき音声ファイルが ${audioItems.length} 件登録されています。話者は現在のカット位置と同じです。`
      : "プロジェクトに登録済みの音声ファイル名が「連番-セリフ{-任意の文字列}.wav」形式であれば、一括登録可能です。（現在は該当ファイルなし）";
  }
  if (elements.addCutBatchAudioPreview) {
    if (audioEnabled) {
      elements.addCutBatchAudioPreview.hidden = false;
      const sample = audioItems.slice(0, 8).map((it) => `${it.seq}: ${it.dialogue}    [${basenameOnly(it.audio)}]`).join("\n");
      elements.addCutBatchAudioPreview.textContent = audioItems.length > 8
        ? `${sample}\n... 他 ${audioItems.length - 8} 件`
        : sample;
    } else {
      elements.addCutBatchAudioPreview.hidden = true;
      elements.addCutBatchAudioPreview.textContent = "";
    }
  }
  // TTS の利用可否で「音声を自動で作成する」を enable/disable
  const ttsAvail = Boolean(state.tts?.available);
  if (elements.addCutBatchAutoSynth) {
    elements.addCutBatchAutoSynth.disabled = !ttsAvail;
    if (!ttsAvail) elements.addCutBatchAutoSynth.checked = false;
  }
  // テキストモード専用の「指定秒数の余白を入れる」初期化。
  // 開くたびに OFF + 0.5s 戻す (前回の値が予期せず適用されるのを避ける)。
  if (elements.addCutBatchPauseEnable) {
    elements.addCutBatchPauseEnable.checked = false;
  }
  if (elements.addCutBatchPauseSec) {
    elements.addCutBatchPauseSec.value = "0.5";
  }
  updateAddCutBatchPauseFieldEnabled();
  if (elements.addCutBatchAutoSynthHint) {
    elements.addCutBatchAutoSynthHint.textContent = ttsAvail
      ? "ON にすると、話者キャラクターに紐付けた声と感情で wav を生成して各カットに割り当てます（YAML 入力では voice 行で上書き可能）。"
      : "VOICEVOX / Voicepeak が未検出のため自動生成は無効です（全体設定 → 音声読み上げ）。";
  }
  if (elements.addCutBatchProgressArea) {
    elements.addCutBatchProgressArea.hidden = true;
  }
  if (elements.addCutBatchProgress) elements.addCutBatchProgress.value = 0;
  if (elements.addCutBatchProgressLabel) elements.addCutBatchProgressLabel.textContent = "";
  if (elements.addCutBatchProgressLog) elements.addCutBatchProgressLog.textContent = "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  migrateInDialogToasts();
}

export function closeAddCutBatchDialog() {
  const dialog = elements.addCutBatchDialog;
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

// テンプレートカットの characters 配列から「話者ID -> 話者ID」と「表示名 -> 話者ID」の
// 2 種類の resolver を作る。表示名は同名複数が居うるので、配列の index が小さい
// (= 前面側レイヤー) を優先する。
// 戻り値: { speakerIds: Set<string>, nameToSpeakerId: Map<string,string> }
export function buildSpeakerResolver(templateCharacters) {
  const speakerIds = new Set();
  const nameToSpeakerId = new Map();
  const list = Array.isArray(templateCharacters) ? templateCharacters : [];
  for (const c of list) {
    const speakerId = c?.id ? String(c.id) : "";
    if (!speakerId) continue;
    speakerIds.add(speakerId);
    const def = characterDefinitionById(c?.characterId);
    const name = String(def?.name || "").trim();
    if (name && !nameToSpeakerId.has(name)) {
      nameToSpeakerId.set(name, speakerId);
    }
  }
  return { speakerIds, nameToSpeakerId };
}

// 「話者ID:セリフ」「話者名:セリフ」形式のパース。
// resolver は buildSpeakerResolver() の戻り値 (互換のため Set 単体も受け付ける)。
// 話者が見つからなければ speakerId: null + 元の文字列を返す (": を含む通常セリフ" 扱い)。
//
// 区切り文字は半角「:」と全角「：」のどちらも受理する (テキストモードでの一括追加で
// 日本語 IME から「マキ：こんにちは」と入力したケースに合わせる)。
export function parseLinePerhapsWithSpeaker(line, resolver) {
  const raw = String(line);
  // 半角 (:) / 全角 (：) のどちらか「最初に出現」した位置で 1 回だけ分割する。
  // String#match の `[^:：]+[:：]` でも同じことができるが、明示的に index を取って
  // 分割した方が読みやすく、後段で挙動を追いやすい。
  const idx = raw.search(/[:：]/);
  if (idx < 0) return { speakerId: null, text: raw };
  const speakerCandidate = raw.slice(0, idx).trim();
  const text = raw.slice(idx + 1);
  if (!speakerCandidate) return { speakerId: null, text: raw };
  let speakerIds;
  let nameToSpeakerId;
  if (resolver instanceof Set) {
    speakerIds = resolver;
    nameToSpeakerId = null;
  } else {
    speakerIds = resolver?.speakerIds;
    nameToSpeakerId = resolver?.nameToSpeakerId;
  }
  if (speakerIds && speakerIds.has(speakerCandidate)) {
    return { speakerId: speakerCandidate, text };
  }
  if (nameToSpeakerId && nameToSpeakerId.has(speakerCandidate)) {
    return { speakerId: nameToSpeakerId.get(speakerCandidate), text };
  }
  return { speakerId: null, text: line };
}

// 話者ID (= cut.state.characters[].id) から characterDefinition の voice 既定値を引く。
// voice-dialogue.js の speakerVoiceFromCharacter と同等だが、テンプレート由来の cut を
// 渡して引けるようにしている (テキスト一括追加で auto-synth するときに必要)。
function speakerVoiceFromTemplate(template, speakerId) {
  if (!speakerId) return { id: "", emotion: "" };
  const list = template?.state?.characters || [];
  const char = list.find((c) => c?.id === speakerId);
  const def = characterDefinitionById(char?.characterId);
  const voice = def?.voice || {};
  return {
    id: String(voice.id || ""),
    emotion: String(voice.emotion || ""),
  };
}

function setBatchProgress(percent, label, logLine) {
  if (elements.addCutBatchProgressArea) elements.addCutBatchProgressArea.hidden = false;
  if (elements.addCutBatchProgress) elements.addCutBatchProgress.value = percent;
  if (elements.addCutBatchProgressLabel && label != null) {
    elements.addCutBatchProgressLabel.textContent = label;
  }
  if (logLine && elements.addCutBatchProgressLog) {
    elements.addCutBatchProgressLog.textContent += logLine + "\n";
    elements.addCutBatchProgressLog.scrollTop = elements.addCutBatchProgressLog.scrollHeight;
  }
}

async function fetchYamlBatchItems(yamlText) {
  const res = await fetch("/api/tts/parse-yaml", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml: yamlText }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "YAML パースに失敗しました");
  return data;
}

export async function synthesizeBatchItem(item, cutIndexFor1Based) {
  const res = await fetch("/api/tts/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      voiceId: item.voiceId,
      emotion: item.emotion,
      text: item.text,
      cutIndex: cutIndexFor1Based,
      skipManifest: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "音声合成に失敗しました");
  return data;
}

export async function commitAddCutBatch() {
  const cuts = state.scenario?.cuts || [];
  // テンプレートとなる現在のカットを取り出す
  updateSelectedCutFromCurrent();
  const template = cuts.find((c) => c.id === state.selectedCutId) || cuts[cuts.length - 1] || null;
  if (!template) {
    showToast("テンプレートとなるカットが見つかりません", "error");
    return;
  }
  const cloneTemplate = () => JSON.parse(JSON.stringify(template));

  let newEntries = [];
  let yamlMode = false;
  if (elements.addCutBatchModeAudio?.checked) {
    const audioItems = getSequencedAudioCandidates();
    if (audioItems.length === 0) {
      showToast("連番つき音声ファイルが見つかりません");
      return;
    }
    newEntries = audioItems.map((item) => ({
      audio: item.audio,
      text: item.dialogue,
      speakerId: null,
      voiceId: "",
      emotion: "",
      pauseSec: 0,
    }));
  } else if (elements.addCutBatchModeYaml?.checked) {
    yamlMode = true;
    const raw = elements.addCutBatchYamlInput?.value || "";
    if (!raw.trim()) {
      showToast("YAML を入力してください");
      return;
    }
    let parsed;
    try {
      parsed = await fetchYamlBatchItems(raw);
    } catch (error) {
      showToast(error.message, "error");
      return;
    }
    const items = parsed.items || [];
    if (items.length === 0) {
      showToast("有効な item が YAML に見つかりません");
      return;
    }
    for (const w of parsed.warnings || []) {
      setBatchProgress(0, "警告あり", `[警告] ${w}`);
    }
    newEntries = items.map((it) => ({
      audio: "",
      text: it.text,
      speakerId: it.speakerCharacterId || null,
      voiceId: it.voiceId || "",
      emotion: it.emotion || "",
      pauseSec: Number(it.pauseSec) || 0,
    }));
  } else {
    const raw = elements.addCutBatchTextInput?.value || "";
    const lines = raw.split(/\r?\n/).map((s) => s).filter((s) => s.length > 0);
    if (lines.length === 0) {
      showToast("テキストを入力してください");
      return;
    }
    const resolver = buildSpeakerResolver(template.state?.characters);
    // auto-synth が ON のときは「行頭で話者指定なし」のセリフをテンプレートの話者で
    // 喋らせるため、template.state.speakerCharacterId を fallback として埋め込む。
    const fallbackSpeakerId = String(template.state?.speakerCharacterId || "") || null;
    // 「指定秒数の余白を入れる」が ON のときは、各カットの表示時間に sec を加える。
    const pauseEnabled = Boolean(elements.addCutBatchPauseEnable?.checked);
    let pauseSec = 0;
    if (pauseEnabled) {
      const v = parseFloat(elements.addCutBatchPauseSec?.value);
      if (Number.isFinite(v) && v > 0) pauseSec = Math.min(60, Math.max(0, v));
    }
    newEntries = lines.map((line) => {
      const parsed = parseLinePerhapsWithSpeaker(line, resolver);
      const effectiveSpeakerId = parsed.speakerId || fallbackSpeakerId;
      const voice = speakerVoiceFromTemplate(template, effectiveSpeakerId);
      return {
        audio: "",
        text: parsed.text,
        speakerId: parsed.speakerId,
        voiceId: voice.id,
        emotion: voice.emotion,
        pauseSec,
      };
    });
  }

  // 挿入位置: 現在のカットの直後
  const insertIndex = cuts.findIndex((c) => c.id === template.id);
  const inserted = [];
  for (const entry of newEntries) {
    const clone = cloneTemplate();
    clone.id = `cut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    clone.audio = entry.audio || "";
    clone.state = clone.state || {};
    clone.state.text = entry.text || "";
    if (entry.speakerId) {
      clone.state.speakerCharacterId = entry.speakerId;
    }
    inserted.push({ cut: clone, entry });
  }
  cuts.splice(insertIndex + 1, 0, ...inserted.map((p) => p.cut));

  // テキスト / YAML どちらのモードでも、ユーザーが ON にした場合は wav を作る。
  // 音声ファイルモード (audio タブ) は既に wav 指定なのでスキップ。
  const audioFileMode = Boolean(elements.addCutBatchModeAudio?.checked);
  const autoSynth = Boolean(elements.addCutBatchAutoSynth?.checked) && !audioFileMode;
  let manifestUpdated = false;

  if (autoSynth) {
    const total = inserted.length;
    setBatchProgress(0, `0/${total} 音声を作成中...`, "[開始] 音声生成バッチ");
    for (let i = 0; i < inserted.length; i += 1) {
      const { cut, entry } = inserted[i];
      const cutNumber = insertIndex + 1 + i + 1; // 全体での 1-based カット番号
      if (!entry.voiceId) {
        setBatchProgress(
          Math.round(((i + 1) / total) * 100),
          `${i + 1}/${total} ${entry.text.slice(0, 20)} (voice 未指定: スキップ)`,
          `[スキップ] #${i + 1} voice 未指定`,
        );
        continue;
      }
      try {
        const data = await synthesizeBatchItem(
          { voiceId: entry.voiceId, emotion: entry.emotion, text: entry.text },
          cutNumber,
        );
        cut.audio = data.audioPath || "";
        if (Number.isFinite(data.durationSec) && data.durationSec > 0) {
          const baseFrames = Math.max(1, secToFrames(data.durationSec));
          const pauseFrames = Math.max(0, secToFrames(entry.pauseSec || 0));
          cut.durationFrame = baseFrames + pauseFrames;
        }
        manifestUpdated = true;
        setBatchProgress(
          Math.round(((i + 1) / total) * 100),
          `${i + 1}/${total} ${entry.text.slice(0, 20)}`,
          `[OK] #${i + 1} ${data.filename || data.audioPath || ""} (${(data.durationSec || 0).toFixed(2)}s)`,
        );
      } catch (error) {
        setBatchProgress(
          Math.round(((i + 1) / total) * 100),
          `${i + 1}/${total} エラー`,
          `[失敗] #${i + 1} ${error.message}`,
        );
      }
    }
  }

  // 連番音声モード等で audio が指定されているカットの duration を音声長から推定
  await Promise.all(inserted.map(async ({ cut }) => {
    if (!cut.audio) return;
    if (Number.isFinite(cut.durationFrame) && cut.durationFrame > 0 && autoSynth) return;
    try {
      const dur = await fetchAudioDuration(cut.audio);
      if (Number.isFinite(dur) && dur > 0) cut.durationFrame = Math.max(1, secToFrames(dur));
    } catch (_e) {
      // 失敗しても元の duration をそのまま使う
    }
  }));

  if (manifestUpdated) {
    // 音声生成があったら manifest を更新 (新 wav を audio 一覧に反映)
    try {
      const r = await fetch("/api/projects/rescan", { method: "POST" });
      if (r.ok) state.manifest = await r.json();
    } catch (e) {
      console.warn("rescan after bulk synth failed", e);
    }
  }

  recalcCutStartSec();
  renderCutList();
  scheduleScenarioSave();
  recordHistory();
  closeAddCutBatchDialog();
  showToast(`${inserted.length} 件のカットを追加しました${autoSynth ? "（音声生成完了）" : ""}`);
}

export async function fetchAudioDuration(audioPath) {
  if (!audioPath) return NaN;
  try {
    const response = await fetch(`/api/audio-duration?path=${encodeURIComponent(audioPath)}`);
    if (!response.ok) return NaN;
    const result = await response.json();
    return Number(result.roundedDuration ?? result.duration ?? NaN);
  } catch (_e) {
    return NaN;
  }
}

// 「指定秒数の余白を入れる」チェックボックスの状態に合わせて、秒数入力 + 単位
// ラベルを enable/disable する (OFF のときグレーアウト)。
function updateAddCutBatchPauseFieldEnabled() {
  const enabled = Boolean(elements.addCutBatchPauseEnable?.checked);
  if (elements.addCutBatchPauseSec) {
    elements.addCutBatchPauseSec.disabled = !enabled;
  }
}

export function bindAddCutBatchDialog() {
  elements.openAddCutBatchDialogButton?.addEventListener("click", openAddCutBatchDialog);
  for (const tab of elements.addCutBatchTabs || []) {
    tab.addEventListener("click", () => {
      if (tab.disabled) return;
      setAddCutBatchTab(tab.dataset.batchTab);
    });
  }
  elements.addCutBatchPauseEnable?.addEventListener("change", updateAddCutBatchPauseFieldEnabled);
  elements.addCutBatchConfirmButton?.addEventListener("click", () => {
    commitAddCutBatch().catch((error) => {
      console.error(error);
      showToast("カット一括追加に失敗しました", "error");
    });
  });
  elements.addCutBatchCancelButton?.addEventListener("click", closeAddCutBatchDialog);
}

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

export async function applyScenarioSnapshot(snap) {
  state.isLoadingCut = true;
  try {
    state.scenario = attachScenarioCutsAlias(JSON.parse(JSON.stringify(snap.scenario)));
    state.selectedCutId = snap.selectedCutId;
    renderCutList();
    let cut = state.scenario.cuts.find((c) => c.id === state.selectedCutId);
    if (!cut && state.scenario.cuts.length > 0) {
      cut = state.scenario.cuts[0];
      state.selectedCutId = cut.id;
    }
    if (cut) {
      await loadCut(cut);
    } else {
      state.selectedCutId = null;
      state.currentCharacters = [];
      state.selectedCharacterIndex = 0;
      renderCharacterSelect();
      loadCharacterIntoControls(null);
      deps.fillExpressionPresets("");
      await renderPreview();
    }
  } finally {
    state.isLoadingCut = false;
  }
  scheduleScenarioSave();
}

export async function undoEdit() {
  if (state.history.index <= 0) {
    showToast("これ以上戻せません");
    return;
  }
  state.isUndoRedoing = true;
  state.history.index -= 1;
  try {
    await applyScenarioSnapshot(state.history.stack[state.history.index]);
    showToast("元に戻しました");
  } finally {
    state.isUndoRedoing = false;
  }
}

export async function redoEdit() {
  if (state.history.index >= state.history.stack.length - 1) {
    showToast("これ以上やり直せません");
    return;
  }
  state.isUndoRedoing = true;
  state.history.index += 1;
  try {
    await applyScenarioSnapshot(state.history.stack[state.history.index]);
    showToast("やり直しました");
  } finally {
    state.isUndoRedoing = false;
  }
}
