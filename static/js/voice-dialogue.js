// ===========================================================================
// 編集パネル「セリフ」の声・感情セレクタと「音声を再生成」ボタン
// (UI 用語: 「話者」= 喋るキャラクター、「声」= TTS narrator、
//          「感情」= TTS スタイル/emotion パラメータ)
// 話者キャラ切替時に、そのキャラ定義に紐付いた声/感情をデフォルトとして反映する。
// ユーザーが手動で声/感情を変更した場合は cut.state.voice に永続化し、別カットへ
// 移動して戻ってきても override が維持される (override 方式)。
// ボタン押下で /api/tts/synthesize を呼び出し、生成された wav を current cut の
// audio に差し替える (manifest 自動更新 + duration 同期)。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { characterDefinitionById } from "./character.js";
import {
  ttsAvailable,
  ttsNarratorList,
  ttsStyleListForNarrator,
  splitVoiceId,
  combineNarratorAndStyle,
  synthesizeOne,
  fetchTtsState,
} from "./tts.js";
import {
  setAudioPath,
  renderCutList,
  scheduleScenarioSave,
  updateSelectedCutFromCurrent,
} from "./scenario-actions.js";
import { recalcCutStartSec } from "./scenario.js";
import { recordHistory } from "./history.js";
import { secToFrames, formatTimecode } from "./timecode.js";
import { renderPreview } from "./playback.js";

function buildNarratorOptions(select, currentNarratorKey) {
  if (!select) return;
  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "未設定";
  select.append(noneOpt);
  for (const n of ttsNarratorList()) {
    const opt = document.createElement("option");
    opt.value = n.id;
    opt.textContent = n.label || n.id;
    select.append(opt);
  }
  // カタログ未登録の旧データでも option を残す
  if (currentNarratorKey && !Array.from(select.options).some((o) => o.value === currentNarratorKey)) {
    const opt = document.createElement("option");
    opt.value = currentNarratorKey;
    opt.textContent = `${currentNarratorKey}（カタログ未登録）`;
    select.append(opt);
  }
  select.value = currentNarratorKey || "";
}

function buildStyleOptions(select, narratorKey, currentStyle) {
  if (!select) return;
  select.innerHTML = "";
  const isVoicevox = String(narratorKey || "").startsWith("voicevox:");
  // VOICEVOX は style 必須 (= "ノーマル" を含む実 style 一覧から必ず 1 つ選ぶ)。
  // 空 value 用の「ノーマル」プレースホルダを出すと、実 style "ノーマル" と
  // 二重表示になるうえ、空を選ばれると voice.id が "voicevox:narrator" の
  // 壊れた形で永続化されてしまう。Voicepeak は emotion 未指定 = ノーマル相当
  // (本アプリ仕様) なので空 value のプレースホルダを出す。
  if (!isVoicevox) {
    const normal = document.createElement("option");
    normal.value = "";
    normal.textContent = "ノーマル";
    select.append(normal);
  }
  const styles = ttsStyleListForNarrator(narratorKey);
  for (const e of styles) {
    const opt = document.createElement("option");
    opt.value = e;
    opt.textContent = e;
    select.append(opt);
  }
  if (currentStyle && !styles.includes(currentStyle)) {
    const opt = document.createElement("option");
    opt.value = currentStyle;
    opt.textContent = `${currentStyle}（未対応）`;
    select.append(opt);
  }
  // VOICEVOX で currentStyle が空のときは先頭 style に倒す (壊れた voice.id 防止)。
  let valueToSet = currentStyle || "";
  if (isVoicevox && !valueToSet && styles.length > 0) {
    valueToSet = styles[0];
  }
  select.value = valueToSet;
  // 完全に候補ゼロかつ選択ゼロなら disable。
  select.disabled = !ttsAvailable() || (styles.length === 0 && !valueToSet);
}

// 話者キャラに紐付いた voice/emotion を取り出す (manifest 上の characters[].voice)。
// speakerId は cut 内の登場キャラ ID (character_xxxxx)。state.currentCharacters
// から該当する登場キャラを引いて、その characterId (定義 ID) で manifest の
// キャラ定義を検索し、定義の voice を返す。
function speakerVoiceFromCharacter(speakerId) {
  if (!speakerId) return { id: "", emotion: "" };
  const liveChar = state.currentCharacters?.find((c) => c.id === speakerId);
  const characterId = liveChar?.characterId || "";
  if (!characterId) return { id: "", emotion: "" };
  const def = characterDefinitionById(characterId);
  const voice = def?.voice || {};
  return {
    id: String(voice.id || ""),
    emotion: String(voice.emotion || ""),
  };
}

// 現在のカットを取得。state.scenario.cuts と selectedCutId の組合せから引く。
function currentCutForVoice() {
  const cuts = state.scenario?.cuts || [];
  return cuts.find((c) => c && c.id === state.selectedCutId) || null;
}

// cut.state.voice の override を取り出す。未保存の cut でも安全に空 dict を返す。
function cutVoiceOverride() {
  const cut = currentCutForVoice();
  const v = cut?.state?.voice;
  if (!v || typeof v !== "object") return { id: "", emotion: "" };
  return {
    id: String(v.id || ""),
    emotion: String(v.emotion || ""),
  };
}

function updateVoiceUiAvailability() {
  const enabled = ttsAvailable();
  if (elements.dialogueVoiceSelect) elements.dialogueVoiceSelect.disabled = !enabled;
  if (elements.dialogueVoiceEmotion) {
    if (!enabled) elements.dialogueVoiceEmotion.disabled = true;
    // style select の disabled はオプション数 + 選択値で決まる (buildStyleOptions 側)
  }
  if (elements.regenerateDialogueAudioButton) {
    const hasText = (elements.dialogue?.value || "").trim().length > 0;
    const hasNarrator = Boolean(elements.dialogueVoiceSelect?.value);
    elements.regenerateDialogueAudioButton.disabled = !enabled || !hasText || !hasNarrator;
  }
  if (elements.dialogueVoiceHint) {
    if (!enabled) {
      elements.dialogueVoiceHint.hidden = false;
      elements.dialogueVoiceHint.textContent =
        "VOICEVOX / Voicepeak が検出されていないか、ボイスが未登録です（全体設定 → 音声読み上げ）。";
    } else {
      elements.dialogueVoiceHint.hidden = true;
      elements.dialogueVoiceHint.textContent = "";
    }
  }
}

// 話者切替時 / カット読み込み時に呼ぶ。
//
// 優先順:
//   1. cut.state.voice (= ユーザーが手動で選んだ override) があればそれを表示
//   2. なければ「話者キャラ定義に紐付いた voice」をデフォルトとして表示
//
// これにより「声を手動で選んでカットを保存 → 別カットへ移動 → 戻ってきても override
// が維持される」。話者キャラそのものを別キャラへ切り替えると override は失われる
// (新しい話者の default が出る) — UI 上では話者キャラ change のときも override を
// クリアして default に戻す。
export function syncDialogueVoiceFromSpeaker() {
  const speakerId = elements.speakerCharacter?.value || "";
  const override = cutVoiceOverride();
  const fallback = speakerVoiceFromCharacter(speakerId);
  const voiceId = override.id || fallback.id;
  const voiceEmotion = override.id ? override.emotion : fallback.emotion;
  const { narratorKey, style } = splitVoiceId(voiceId, voiceEmotion);
  buildNarratorOptions(elements.dialogueVoiceSelect, narratorKey);
  buildStyleOptions(elements.dialogueVoiceEmotion, narratorKey, style);
  updateVoiceUiAvailability();
}

// セレクタを ttsState の最新カタログで再構築 (現在値は維持)。
export function refreshDialogueVoiceCatalog() {
  const narratorKey = elements.dialogueVoiceSelect?.value || "";
  const style = elements.dialogueVoiceEmotion?.value || "";
  buildNarratorOptions(elements.dialogueVoiceSelect, narratorKey);
  buildStyleOptions(elements.dialogueVoiceEmotion, narratorKey, style);
  updateVoiceUiAvailability();
}

async function regenerateDialogueAudio() {
  const cuts = state.scenario?.cuts || [];
  const startIdx = cuts.findIndex((c) => c.id === state.selectedCutId);
  if (startIdx < 0) {
    showToast("カットを選択してから「音声を再生成」を押してください", "error");
    return;
  }
  // await 中に updateSelectedCutFromCurrent が走ると state.scenario.cuts[idx] は
  // 新しいオブジェクトに差し替わる (cutFromCurrent が cut 全体を作り直す設計のため)。
  // ここで cuts[idx] の参照を捕まえると、await 後の cut.audio = ... が孤児オブジェクトを
  // 書き換えるだけになり、別カット移動 → 戻ったときに古い audio に "戻る" ように見える。
  // → cutId だけ捕まえて、await 後に id で必ず引き直す。
  const cutId = state.selectedCutId;
  const text = (elements.dialogue?.value || "").trim();
  if (!text) {
    showToast("セリフが空です", "error");
    return;
  }
  const narratorKey = elements.dialogueVoiceSelect?.value || "";
  if (!narratorKey) {
    showToast("声が選択されていません", "error");
    return;
  }
  const style = elements.dialogueVoiceEmotion?.value || "";
  // narrator + style を永続化フォーマットの voice.id / voice.emotion に再合成する
  const persist = combineNarratorAndStyle(narratorKey, style);
  const voiceId = persist.id;
  const emotion = persist.emotion;
  const button = elements.regenerateDialogueAudioButton;
  if (button) button.disabled = true;
  try {
    const data = await synthesizeOne({
      voiceId,
      text,
      emotion,
      cutIndex: startIdx + 1,
    });
    // ★ await 後は id で必ず引き直す (上記の差し替え race を回避)。
    const freshCuts = state.scenario?.cuts || [];
    const freshIdx = freshCuts.findIndex((c) => c.id === cutId);
    if (freshIdx < 0) {
      showToast("カットが見つかりません (削除された可能性)", "error");
      return;
    }
    const cut = freshCuts[freshIdx];
    cut.audio = data.audioPath || "";
    if (data.manifest) state.manifest = data.manifest;
    // 再生成に使った話者+声を override として cut.state に保存。
    // persistCutVoice は state.selectedCutId 経由で「現在のカット」を引くため、
    // 別カットへ移動済みのケースでは書き先がズレる。fresh cut へ直接書く。
    cut.state = cut.state || {};
    if (!voiceId && !emotion) {
      delete cut.state.voice;
    } else {
      cut.state.voice = { id: String(voiceId || ""), emotion: String(emotion || "") };
    }
    // 音声尺をカット duration に反映。
    // 既存の表示時間が再生成後の音声尺より長い場合は、ユーザーが意図的に間を伸ばしている
    // ケース (無音尾を残す等) を尊重して維持する。短いときだけ音声尺へ伸ばす。
    let newDurationFrame = null;
    if (Number.isFinite(data.durationSec) && data.durationSec > 0) {
      const audioFrames = Math.max(1, secToFrames(data.durationSec));
      const currentFrames = Number(cut.durationFrame) || 0;
      if (audioFrames > currentFrames) {
        cut.durationFrame = audioFrames;
        newDurationFrame = audioFrames;
      }
    }
    // UI 更新は「再生成を開始したカットが今もアクティブ」のときだけ。
    // 別カットへ移動済みのときに setAudioPath / elements.duration を触ると、
    // 表示中カットの UI 入力を別カットの値で汚染してしまい、次の handleEditorChanged で
    // 表示中カットの audio/durationFrame が再生成済み wav に置き換わる二次バグを起こす。
    const stillActive = state.selectedCutId === cutId;
    if (stillActive) {
      setAudioPath(data.audioPath || "");
      if (newDurationFrame !== null && elements.duration) {
        elements.duration.value = formatTimecode(newDurationFrame);
        elements.duration.dataset.frames = String(newDurationFrame);
      }
    }
    recalcCutStartSec();
    renderCutList();
    scheduleScenarioSave();
    recordHistory();
    if (stillActive) {
      await renderPreview();
    }
    showToast(`音声を生成しました: ${data.filename || data.audioPath || "wav"}`);
  } catch (error) {
    console.error(error);
    showToast(error.message || "音声合成に失敗しました", "error");
  } finally {
    updateVoiceUiAvailability();
  }
}

// 「声」「感情」セレクタの変更を cut.state へ反映する。
// payload() が UI からまとめて voice override を組み立てて cut.state.voice に乗せる
// 設計に揃えたので、ここでは updateSelectedCutFromCurrent を呼んで通常編集と同じ
// rebuild → save 経路に乗せる (これで scenarios/main.json の cut.state.voice が
// 必ず最新値で保存される)。
function persistDialogueVoiceOverride() {
  updateSelectedCutFromCurrent();
  scheduleScenarioSave();
}

export function bindDialogueVoice() {
  if (elements.dialogueVoiceSelect) {
    elements.dialogueVoiceSelect.addEventListener("change", () => {
      const narratorKey = elements.dialogueVoiceSelect.value;
      // 話者を変えたら声候補は再構築 (前話者の style を引きずらない)
      buildStyleOptions(elements.dialogueVoiceEmotion, narratorKey, "");
      updateVoiceUiAvailability();
      persistDialogueVoiceOverride();
    });
  }
  if (elements.dialogueVoiceEmotion) {
    elements.dialogueVoiceEmotion.addEventListener("change", () => {
      updateVoiceUiAvailability();
      persistDialogueVoiceOverride();
    });
  }
  if (elements.speakerCharacter) {
    elements.speakerCharacter.addEventListener("change", () => {
      // 話者キャラを切り替えたら override を一旦クリアし、新しい話者の default を読む
      const cut = currentCutForVoice();
      if (cut?.state) delete cut.state.voice;
      syncDialogueVoiceFromSpeaker();
      // UI のセレクタ値を payload() 経由で cut.state に反映 (default と一致なら
      // voice キーは出ない)。
      updateSelectedCutFromCurrent();
      scheduleScenarioSave();
    });
  }
  if (elements.dialogue) {
    // セリフ未入力時はボタン disabled にする
    elements.dialogue.addEventListener("input", () => {
      updateVoiceUiAvailability();
    });
  }
  if (elements.regenerateDialogueAudioButton) {
    elements.regenerateDialogueAudioButton.addEventListener("click", () => {
      regenerateDialogueAudio();
    });
  }
  // tts state がまだ取れていない初期段階でも呼べるよう、guard を付ける
  if (state.tts === null || state.tts === undefined) {
    fetchTtsState().catch(() => null).finally(() => {
      syncDialogueVoiceFromSpeaker();
    });
  } else {
    syncDialogueVoiceFromSpeaker();
  }
}
