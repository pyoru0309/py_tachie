// シーン設定 > BGM カードの「口パク」欄。
//
// 1) 口パク入力 (useForLipSync): このトラックを出力に流さず口パクの入力に使う。
//    キャラを選ぶとそのキャラ専用 (デュエットのボーカル分け)、選ばなければ従来
//    どおり「話者の口パク」に使う。話者用はシーン内 1 本まで。
// 2) 歌唱判定 MIDI (lipSyncMidi): このトラックの音源と時間軸を共有する MIDI の
//    ノート + 歌詞で口形 (あいうえおん) を決める。トラックごとにキャラを割り当てる。
//
// データの形は app/scenario.py: _normalize_bgm_track / _normalize_lip_sync_midi。
// 口形の決め方は app/midi_lipsync.py、描画側の寄せ先は static/js/lipsync.js。

import { state } from "./state.js";
import { showToast } from "./toast.js";
import { buttonMarkup } from "./utils.js";

let midiFilesPromise = null;
let midiCacheProjectId = "";
const midiSummaryCache = new Map(); // src -> Promise<summary|null>

function activeProjectId() {
  return state.activeProjectId || state.manifest?.projectId || "";
}

// プロジェクトが替わったらキャッシュを捨てる (同名ファイルでも中身が違いうる)。
function ensureCacheProject() {
  const pid = activeProjectId();
  if (pid !== midiCacheProjectId) {
    midiCacheProjectId = pid;
    resetLipSyncMidiCaches();
  }
}

function fetchMidiFiles({ force = false } = {}) {
  ensureCacheProject();
  if (force) midiFilesPromise = null;
  if (!midiFilesPromise) {
    const pid = activeProjectId();
    midiFilesPromise = pid
      ? fetch(`/api/projects/${encodeURIComponent(pid)}/lipsync-midi`)
        .then((r) => (r.ok ? r.json() : { files: [] }))
        .then((data) => (Array.isArray(data?.files) ? data.files : []))
        .catch(() => [])
      : Promise.resolve([]);
  }
  return midiFilesPromise;
}

function fetchMidiSummary(src) {
  ensureCacheProject();
  if (!midiSummaryCache.has(src)) {
    const pid = activeProjectId();
    const url = `/api/projects/${encodeURIComponent(pid)}/lipsync-midi/summary?src=${encodeURIComponent(src)}`;
    midiSummaryCache.set(src, fetch(url).then(async (r) => {
      if (r.ok) return r.json();
      const data = await r.json().catch(() => ({}));
      return { error: data.detail || `読み込みに失敗しました (${r.status})` };
    }).catch(() => ({ error: "読み込みに失敗しました" })));
  }
  return midiSummaryCache.get(src);
}

// 割り当ての一致チェック (MIDI トラック ↔ キャラのボーカル)。入力が同じなら結果も同じ
// なので JSON キーで取り置く (音源解析はサーバ側でもキャッシュされる)。
const midiCheckCache = new Map(); // key -> Promise<result|null>

function fetchMidiCheck(track, tracks) {
  ensureCacheProject();
  const refs = (tracks || []).filter((t) => t?.useForLipSync && (t.lipSyncCharacterIds || []).length)
    .map((t) => ({ src: t.src, trimStartSec: t.trimStartSec, useForLipSync: true, lipSyncCharacterIds: t.lipSyncCharacterIds }));
  if (!refs.length) return Promise.resolve(null);
  const body = {
    track: { src: track.src, trimStartSec: track.trimStartSec, lipSyncMidi: track.lipSyncMidi },
    bgmTracks: refs,
  };
  const key = JSON.stringify(body);
  if (!midiCheckCache.has(key)) {
    const pid = activeProjectId();
    midiCheckCache.set(key, fetch(`/api/projects/${encodeURIComponent(pid)}/lipsync-midi/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: key,
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return midiCheckCache.get(key);
}

// アップロード後に呼ぶ (プロジェクト切替は ensureCacheProject が検出する)。
export function resetLipSyncMidiCaches() {
  midiFilesPromise = null;
  midiSummaryCache.clear();
  midiCheckCache.clear();
}

// 割り当て候補のキャラ。編集中のベッド (シーン / プロジェクト通し) に登場する
// キャラを優先し、1 人もいなければ manifest の全キャラ。既に割り当て済みの ID は
// 登場しなくなっていても外さず出す (黙って消えると割り当てが失われるため)。
function characterChoices(sceneId, assignedIds) {
  const defs = state.manifest?.characters || [];
  const ids = [];
  for (const cut of state.scenario?.cuts || []) {
    if (sceneId && cut?.sceneId !== sceneId) continue;
    for (const ch of cut?.state?.characters || []) {
      const cid = ch?.characterId;
      if (cid && !ids.includes(cid)) ids.push(cid);
    }
  }
  if (!ids.length) defs.forEach((d) => d?.id && ids.push(d.id));
  for (const cid of assignedIds) if (cid && !ids.includes(cid)) ids.push(cid);
  return ids.map((id) => {
    const name = defs.find((d) => d.id === id)?.name || "";
    return { id, label: name && name !== id ? `${name}（${id}）` : id };
  });
}

function buildCharacterPicker(choices, selectedIds, onToggle) {
  const wrap = document.createElement("div");
  wrap.className = "lip-char-picks";
  if (!choices.length) {
    const empty = document.createElement("span");
    empty.className = "asset-hint";
    empty.textContent = "キャラクターがいません";
    wrap.append(empty);
    return wrap;
  }
  for (const choice of choices) {
    const label = document.createElement("label");
    label.className = "checkbox-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selectedIds.includes(choice.id);
    input.addEventListener("change", () => onToggle(choice.id, input.checked));
    const text = document.createElement("span");
    text.textContent = choice.label;
    label.append(input, text);
    wrap.append(label);
  }
  return wrap;
}

function hint(text) {
  const p = document.createElement("p");
  p.className = "asset-hint";
  p.textContent = text;
  return p;
}

function formatSec(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

// track: 編集中の BGM トラック (live state)。tracks: 同じベッドの全 BGM。
// ctx.commit(): 保存 + 履歴 + プレビュー更新 (bundle の lipSyncByChar を取り直す)。
// ctx.rerender(): BGM リストを描き直す。
export function buildBgmLipSyncSection(track, index, tracks, ctx) {
  const section = document.createElement("div");
  section.className = "lip-sync-section";

  // ---- 口パク入力 (音量) --------------------------------------------------
  const lipRow = document.createElement("label");
  lipRow.className = "checkbox-row";
  lipRow.title = "出力ミックスから外し、口パクメーター・口パク振幅判定の入力ソースとして使う";
  const lipInput = document.createElement("input");
  lipInput.type = "checkbox";
  lipInput.checked = !!track.useForLipSync;
  const lipText = document.createElement("span");
  lipText.textContent = "このトラックを口パク入力に使う（出力には流さない）";
  lipRow.append(lipInput, lipText);
  section.append(lipRow);

  // 話者用 (キャラ未割り当て) の口パク入力はベッド内 1 本まで。他の話者用を外す。
  const keepSingleSpeakerInput = () => {
    if (!track.useForLipSync || (track.lipSyncCharacterIds || []).length) return;
    tracks.forEach((other, idx) => {
      if (idx !== index && other.useForLipSync && !(other.lipSyncCharacterIds || []).length) {
        other.useForLipSync = false;
      }
    });
  };

  lipInput.addEventListener("change", () => {
    track.useForLipSync = !!lipInput.checked;
    keepSingleSpeakerInput();
    ctx.rerender();
    ctx.commit();
  });

  if (track.useForLipSync) {
    const assigned = Array.isArray(track.lipSyncCharacterIds) ? track.lipSyncCharacterIds : [];
    const box = document.createElement("div");
    box.className = "lip-sync-sub";
    const title = document.createElement("div");
    title.className = "lip-sync-sub-title";
    title.textContent = "口パクさせるキャラ";
    box.append(title);
    box.append(buildCharacterPicker(characterChoices(ctx.sceneId, assigned), assigned, (cid, on) => {
      const next = (Array.isArray(track.lipSyncCharacterIds) ? track.lipSyncCharacterIds : []).filter((x) => x !== cid);
      if (on) next.push(cid);
      track.lipSyncCharacterIds = next;
      keepSingleSpeakerInput();
      ctx.rerender();
      ctx.commit();
    }));
    box.append(hint(assigned.length
      ? "選んだキャラは話者かどうかに関係なく、このトラックの音量で口パクします（デュエットではキャラごとにボーカル素材を分けて割り当て）。"
      : "未選択 = 話者の口パクに使います（従来の動作。シーン内 1 本まで）。"));
    section.append(box);
  }

  // ---- 歌唱判定 MIDI ------------------------------------------------------
  const midi = track.lipSyncMidi && typeof track.lipSyncMidi === "object" ? track.lipSyncMidi : null;
  const midiBox = document.createElement("div");
  midiBox.className = "lip-sync-sub";
  const midiTitle = document.createElement("div");
  midiTitle.className = "lip-sync-sub-title";
  midiTitle.textContent = "歌唱判定 MIDI で口パク";
  midiBox.append(midiTitle);

  const fileRow = document.createElement("div");
  fileRow.className = "lip-midi-file-row";
  const fileSelect = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "使わない";
  fileSelect.append(noneOpt);
  if (midi?.src) {
    const cur = document.createElement("option");
    cur.value = midi.src;
    cur.textContent = midi.src.split("/").pop();
    fileSelect.append(cur);
  }
  fileSelect.value = midi?.src || "";
  const fileLabel = document.createElement("label");
  fileLabel.append("MIDI ファイル", fileSelect);
  fileRow.append(fileLabel);

  fetchMidiFiles().then((files) => {
    const current = fileSelect.value;
    for (const f of files) {
      if (f.path === midi?.src) continue;
      const opt = document.createElement("option");
      opt.value = f.path;
      opt.textContent = f.name;
      fileSelect.append(opt);
    }
    fileSelect.value = current;
  });

  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.accept = ".mid,.midi";
  uploadInput.hidden = true;
  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "compact-action-button";
  uploadButton.innerHTML = buttonMarkup("upload_file", "MIDI を追加");
  uploadButton.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("scope", "project");
    form.append("category", "midi");
    form.append("files", file);
    uploadButton.disabled = true;
    try {
      const response = await fetch("/api/assets/upload", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "アップロードに失敗しました");
      const savedPath = String((data.saved || [])[0]?.rootPath || "").normalize("NFC");
      resetLipSyncMidiCaches();
      if (savedPath) {
        track.lipSyncMidi = { src: savedPath, offsetMs: Number(midi?.offsetMs) || 0, tracks: [] };
        ctx.rerender();
        ctx.commit();
      }
      showToast("MIDI を追加しました");
    } catch (error) {
      showToast(error.message || "アップロードに失敗しました", "error");
    } finally {
      uploadButton.disabled = false;
      uploadInput.value = "";
    }
  });
  fileRow.append(uploadButton, uploadInput);
  midiBox.append(fileRow);

  fileSelect.addEventListener("change", () => {
    const src = fileSelect.value;
    if (!src) {
      track.lipSyncMidi = null;
    } else {
      // 別ファイルへ切り替えたらトラック割り当ては持ち越さない (番号の意味が変わる)。
      const keepTracks = midi?.src === src ? (midi.tracks || []) : [];
      track.lipSyncMidi = { src, offsetMs: Number(midi?.offsetMs) || 0, tracks: keepTracks };
    }
    ctx.rerender();
    ctx.commit();
  });

  if (midi?.src) {
    const offsetRow = document.createElement("div");
    offsetRow.className = "inline-fields";
    const offsetInput = document.createElement("input");
    offsetInput.type = "number";
    offsetInput.step = "10";
    offsetInput.value = String(Number(midi.offsetMs) || 0);
    const offsetLabel = document.createElement("label");
    offsetLabel.append("オフセット (ms)", offsetInput);
    offsetInput.addEventListener("change", () => {
      const v = Math.round(Number(offsetInput.value) || 0);
      track.lipSyncMidi = { ...track.lipSyncMidi, offsetMs: Math.max(-600000, Math.min(600000, v)) };
      ctx.rerender();
      ctx.commit();
    });
    offsetRow.append(offsetLabel);
    midiBox.append(offsetRow);
    midiBox.append(hint(
      "+ で口パクを遅らせ、− で早めます。音源の頭を X ms 削ってある場合は −X"
      + " (例: 100BPM・4/4 のダミー 1 小節を除いて書き出した音源なら −2400)。"
      + "テンポ変更は MIDI のテンポマップどおりに反映されます。停止中はシーク位置の口形が表示されるので、合わせながら調整できます。",
    ));

    const trackList = document.createElement("div");
    trackList.className = "lip-midi-tracks";
    trackList.textContent = "トラックを読み込み中...";
    midiBox.append(trackList);
    fetchMidiSummary(midi.src).then((summary) => {
      trackList.textContent = "";
      if (!summary || summary.error) {
        trackList.append(hint(summary?.error || "MIDI を読み込めませんでした"));
        return;
      }
      if (!summary.tracks?.length) {
        trackList.append(hint("ノートのあるトラックがありません"));
        return;
      }
      const assignedAll = (track.lipSyncMidi?.tracks || []).flatMap((t) => t.characterIds || []);
      const choices = characterChoices(ctx.sceneId, assignedAll);
      const labelOf = (cid) => (choices.find((c) => c.id === cid)?.label || cid);
      const warnBoxes = new Map(); // MIDI トラック番号 -> 警告の差し込み先
      for (const info of summary.tracks) {
        const row = document.createElement("div");
        row.className = "lip-midi-track";
        const head = document.createElement("div");
        head.className = "lip-midi-track-head";
        const name = document.createElement("strong");
        name.textContent = `トラック ${info.index}${info.name ? `「${info.name}」` : ""}`;
        const meta = document.createElement("span");
        meta.className = "asset-hint";
        const lyric = info.lyricCount > 0
          ? `歌詞: ${info.lyricPreview}${info.lyricCount > 40 ? "…" : ""}`
          : "歌詞なし (全ノート「あ」扱い)";
        meta.textContent = `${info.noteCount} ノート / ${formatSec(info.firstNoteSec)}〜${formatSec(info.lastNoteSec)} / ${lyric}`;
        head.append(name, meta);
        row.append(head);
        const current = (track.lipSyncMidi?.tracks || []).find((t) => t.index === info.index);
        row.append(buildCharacterPicker(choices, current?.characterIds || [], (cid, on) => {
          const list = (track.lipSyncMidi?.tracks || []).map((t) => ({ ...t, characterIds: [...(t.characterIds || [])] }));
          let entry = list.find((t) => t.index === info.index);
          if (!entry) {
            entry = { index: info.index, characterIds: [] };
            list.push(entry);
          }
          entry.characterIds = entry.characterIds.filter((x) => x !== cid);
          if (on) entry.characterIds.push(cid);
          track.lipSyncMidi = {
            ...track.lipSyncMidi,
            tracks: list.filter((t) => t.characterIds.length).sort((a, b) => a.index - b.index),
          };
          ctx.rerender();
          ctx.commit();
        }));
        const warnBox = document.createElement("div");
        warnBox.className = "lip-midi-warn";
        row.append(warnBox);
        warnBoxes.set(info.index, warnBox);
        trackList.append(row);
      }
      if (summary.tempoChangeCount > 1) {
        trackList.append(hint(`テンポ変更 ${summary.tempoChangeCount} 箇所を反映しています。`));
      }
      // 取り違え警告: キャラ専用の口パク入力 (ボーカル音源) があるキャラだけ判定できる。
      fetchMidiCheck(track, tracks).then((result) => {
        for (const entry of result?.tracks || []) {
          const box = warnBoxes.get(entry.index);
          if (!box) continue;
          for (const a of entry.assignments || []) {
            if (!a.warn) continue;
            const line = document.createElement("p");
            line.className = "lip-midi-warn-line";
            let text = `⚠ このトラックのノート中、${labelOf(a.characterId)} の口パク入力の音声が`
              + ` ${Math.round(a.silentRatio * 100)}% 無音です。割り当てかオフセットを確認してください。`;
            if (a.better) {
              text += `（${labelOf(a.better.characterId)} の音声なら ${Math.round(a.better.silentRatio * 100)}%）`;
            }
            line.textContent = text;
            box.append(line);
          }
        }
      });
    });
  } else {
    midiBox.append(hint("ボーカルのノートと歌詞 (かな) が入った MIDI を指定すると、あ・い・う・え・お・ん の口形で口パクします。音量による口パクより優先されます。"));
  }
  section.append(midiBox);
  return section;
}
