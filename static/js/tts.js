// ===========================================================================
// 音声合成 (VOICEVOX / Voicepeak) クライアントヘルパ
// state.tts は /api/tts/state の最新レスポンス。
// - voices : [{id, app, narrator, label, emotions}]
// - available : 1 つでも voices があれば true
// ===========================================================================

import { state } from "./state.js";

export async function fetchTtsState() {
  const res = await fetch("/api/tts/state");
  if (!res.ok) throw new Error("tts state 取得失敗");
  state.tts = await res.json();
  return state.tts;
}

export async function refreshTtsCatalog() {
  const res = await fetch("/api/tts/refresh", { method: "POST" });
  if (!res.ok) throw new Error("tts refresh 失敗");
  state.tts = await res.json();
  return state.tts;
}

export async function synthesizeOne(payload) {
  const res = await fetch("/api/tts/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.detail || data?.message || "音声合成に失敗しました";
    throw new Error(detail);
  }
  return data;
}

// voice カタログを app ごとに分類して返す。UI セレクタ生成に使う。
export function ttsVoiceList() {
  return state.tts?.voices || [];
}

// voiceId から voice エントリ。見つからなければ null。
export function findVoice(voiceId) {
  if (!voiceId) return null;
  return ttsVoiceList().find((v) => v.id === voiceId) || null;
}

// VOICEVOX は ``voicevox:{narrator}/{styleName}`` で 1 voiceId に話者+スタイルが
// 詰まっている。Voicepeak は ``voicepeak:{narrator}`` (+ 別フィールド emotion)。
// この差を吸収して、UI 側で「話者」と「声 (=スタイル/感情)」を独立に選べるよう
// 共通の (narratorKey, style) ペアに分解する。
//
// narratorKey の形式:
//   - VOICEVOX:  "voicevox:{narrator}"
//   - Voicepeak: "voicepeak:{narrator}"
// style の形式:
//   - VOICEVOX:  styleName (例: "ノーマル"、空文字の場合あり)
//   - Voicepeak: emotion 引数の値 (例: "happy"、未指定なら空文字)
export function splitVoiceId(voiceId, emotion) {
  const id = String(voiceId || "");
  const emo = String(emotion || "");
  if (id.startsWith("voicevox:")) {
    const sub = id.slice("voicevox:".length);
    const slash = sub.indexOf("/");
    if (slash >= 0) {
      return {
        narratorKey: `voicevox:${sub.slice(0, slash)}`,
        style: sub.slice(slash + 1),
      };
    }
    return { narratorKey: id, style: "" };
  }
  if (id.startsWith("voicepeak:")) {
    return { narratorKey: id, style: emo };
  }
  return { narratorKey: id, style: emo };
}

// (narratorKey, style) → 永続化用の {id, emotion} ペア。
// VOICEVOX は style を id 末尾に詰め、emotion は常に空。
// Voicepeak は emotion 側に style を入れる。
export function combineNarratorAndStyle(narratorKey, style) {
  const key = String(narratorKey || "");
  const sty = String(style || "");
  if (!key) return { id: "", emotion: "" };
  if (key.startsWith("voicevox:")) {
    const narrator = key.slice("voicevox:".length);
    if (sty) return { id: `voicevox:${narrator}/${sty}`, emotion: "" };
    return { id: key, emotion: "" };
  }
  if (key.startsWith("voicepeak:")) {
    return { id: key, emotion: sty };
  }
  return { id: key, emotion: sty };
}

// 話者一覧 (重複排除済)。`{id: narratorKey, label}`。
export function ttsNarratorList() {
  const seen = new Set();
  const list = [];
  for (const v of ttsVoiceList()) {
    const app = String(v.app || "");
    const narrator = String(v.narrator || "");
    if (!narrator) continue;
    const narratorKey = `${app}:${narrator}`;
    if (seen.has(narratorKey)) continue;
    seen.add(narratorKey);
    const suffix = app === "voicevox" ? "VOICEVOX" : app === "voicepeak" ? "Voicepeak" : app || "";
    list.push({
      id: narratorKey,
      app,
      narrator,
      label: suffix ? `${narrator} (${suffix})` : narrator,
    });
  }
  return list;
}

// 指定 narratorKey に対する style/emotion 候補を返す。
// VOICEVOX の場合は styleName 一覧、Voicepeak の場合は emotions 一覧。
export function ttsStyleListForNarrator(narratorKey) {
  const key = String(narratorKey || "");
  if (!key) return [];
  if (key.startsWith("voicevox:")) {
    const narrator = key.slice("voicevox:".length);
    const styles = [];
    const seen = new Set();
    for (const v of ttsVoiceList()) {
      if (v.app !== "voicevox" || v.narrator !== narrator) continue;
      const styleName = String(v.styleName || "");
      if (!styleName || seen.has(styleName)) continue;
      seen.add(styleName);
      styles.push(styleName);
    }
    return styles;
  }
  if (key.startsWith("voicepeak:")) {
    const narrator = key.slice("voicepeak:".length);
    const v = ttsVoiceList().find((x) => x.app === "voicepeak" && x.narrator === narrator);
    return Array.isArray(v?.emotions) ? [...v.emotions] : [];
  }
  return [];
}

export function ttsAvailable() {
  return Boolean(state.tts?.available);
}

export function ttsVoicevoxAvailable() {
  return Boolean(state.tts?.voicevox?.available);
}

export function ttsVoicepeakAvailable() {
  return Boolean(state.tts?.voicepeak?.available);
}
