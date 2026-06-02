// ===========================================================================
// 動画書き出しダイアログのフォーム制御 + プログレス UI ヘルパ。
// 実際の書き出し orchestration (runExportSession 呼び出し) は export.js が持つ。
// 進捗・ログ・ボタン状態の DOM 操作はこちらに集約する。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";

// ---- v2 GL pipeline 経路で扱える preset の whitelist ----------------------
// v1 BUILTIN_VIDEO_PRESETS の videoCodec を v2 _build_ffmpeg_cmd_from_preset で
// 受けるためには、ffmpeg 側でその codec が利用可能 + GL 出力 (RGBA pipe) と
// 整合する必要がある。下記コーデックは preset 経由でそのまま使える。
// (FFV1 は preset から削除済。)
export const V2_SUPPORTED_PRESET_CODECS = new Set([
  "libx264",
  "libx265",
  "prores_ks",
  "png",
]);

export const ENCODER_PROFILE = {
  libx264: { crf: true, preset: true, maxrate: true, defaultCrf: 20 },
  libx265: { crf: true, preset: true, maxrate: true, defaultCrf: 22 },
};

export function presetEncoderInfo(preset) {
  const codec = String(preset?.videoCodec || "");
  return ENCODER_PROFILE[codec] || { crf: false, preset: false, maxrate: false };
}

export function readPresetVideoArg(preset, key) {
  const list = Array.isArray(preset?.videoArgs) ? preset.videoArgs : [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i] === key) return String(list[i + 1] ?? "");
  }
  return "";
}

// preset.alternateEncoders から「デフォルト推奨 HW」を 1 つ選ぶ。
// 環境別の優先順 (NVIDIA / Apple / Intel / Linux) で available なものを採択。
// 全て unavailable なら "" (= ソフトウェアを既定) を返す。
const _HW_PREFER_ORDER = [
  "h264_nvenc", "h264_videotoolbox", "h264_qsv", "h264_vaapi",
  "hevc_nvenc", "hevc_videotoolbox",
];
function _pickDefaultHwEngine(alternates) {
  if (!Array.isArray(alternates)) return "";
  const availableById = new Map();
  for (const alt of alternates) {
    if (alt && alt.available !== false) {
      availableById.set(String(alt.id || ""), true);
    }
  }
  for (const id of _HW_PREFER_ORDER) {
    if (availableById.has(id)) return id;
  }
  // 優先順表に無い (= 将来追加 HW) も拾う
  for (const alt of alternates) {
    if (alt && alt.available !== false) return String(alt.id || "");
  }
  return "";
}

function allPresets() {
  const builtIn = state.globalConfig?.builtInVideoPresets || [];
  const customs =
    state.globalConfig?.customVideoPresets
    || state.globalConfig?.config?.videoExport?.customPresets
    || [];
  return [...builtIn, ...customs];
}

export function findPreset(id) {
  return allPresets().find((p) => p.id === id) || null;
}

function updateEncoderEngineHint(preset, selectedEngineId) {
  const hint = elements.exportOptionsEncoderEngineHint;
  if (!hint) return;
  if (!selectedEngineId) {
    hint.textContent = "プリセット既定の SW エンコーダを使います";
    hint.hidden = false;
    return;
  }
  const alt = (preset.alternateEncoders || []).find((a) => String(a.id) === String(selectedEngineId));
  if (!alt) {
    hint.hidden = true;
    return;
  }
  const desc = alt.description || "";
  const reason = alt.available === false ? `（${alt.unavailableReason || "未対応"}）` : "";
  hint.textContent = desc + reason;
  hint.hidden = !desc && !reason;
}

export function updateEncoderEngineHintFromPreset(preset, selectedEngineId) {
  return updateEncoderEngineHint(preset, selectedEngineId);
}

export function fillExportOptionsDialog() {
  const cfg = state.globalConfig?.config || {};
  const presets = allPresets();
  const select = elements.exportOptionsPresetSelect;
  if (!select) return;
  select.innerHTML = "";
  for (const preset of presets) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.name + (preset.available === false ? "（未対応）" : "");
    if (preset.available === false) opt.disabled = true;
    select.append(opt);
  }
  const initialId =
    cfg.videoExport?.defaultPresetId && presets.some((p) => p.id === cfg.videoExport.defaultPresetId)
      ? cfg.videoExport.defaultPresetId
      : presets.find((p) => p.available !== false)?.id || "";
  select.value = initialId;
  if (elements.exportOptionsMonoToStereoInput) {
    elements.exportOptionsMonoToStereoInput.checked =
      cfg.videoExport?.monoToStereo !== false;
  }
  // 「音声を含める」は既定 ON。ダイアログを経由しない (= プリセット即時書き出し) 経路
  // でも常に音声付きにするため、フォーム側でも `true` を初期値とする。
  if (elements.exportOptionsIncludeAudioInput) {
    elements.exportOptionsIncludeAudioInput.checked = true;
  }
  // 範囲ラジオは選択中カットがあれば「このカット」、なければ「シナリオ全体」既定。
  const targetRadios = document.querySelectorAll('input[name="exportTarget"]');
  const defaultTarget = state.selectedCutId ? "cut" : "project";
  for (const r of targetRadios) {
    r.checked = r.value === defaultTarget;
    r.disabled = r.value === "cut" && !state.selectedCutId;
  }
  applyExportOptionsPresetUI();
}

export function applyExportOptionsPresetUI() {
  const preset = findPreset(elements.exportOptionsPresetSelect?.value);
  if (!preset) return;
  if (elements.exportOptionsPresetHint) {
    elements.exportOptionsPresetHint.textContent =
      `${preset.extension || ""} · ${preset.videoCodec || ""}${preset.pixFmt ? ` · ${preset.pixFmt}` : ""}`;
  }
  // alternateEncoders がある場合のみ「エンコードエンジン」select を表示。
  const engineSelect = elements.exportOptionsEncoderEngineSelect;
  const engineWrap = elements.exportOptionsEncoderEngineWrap;
  const engineHint = elements.exportOptionsEncoderEngineHint;
  const alternates = Array.isArray(preset.alternateEncoders) ? preset.alternateEncoders : [];
  if (engineSelect && engineWrap) {
    engineSelect.innerHTML = "";
    if (alternates.length === 0) {
      engineWrap.hidden = true;
      if (engineHint) engineHint.hidden = true;
    } else {
      engineWrap.hidden = false;
      // HW がある場合は default を HW にする (Recommended ラベル付き)。
      // alternateEncoders 配列内で available=true の HW を優先順に 1 つ選ぶ。
      const defaultHwId = _pickDefaultHwEngine(alternates);
      const softwareOpt = document.createElement("option");
      softwareOpt.value = "";
      softwareOpt.textContent = `ソフトウェア（${preset.videoCodec} / CPU）`;
      engineSelect.append(softwareOpt);
      for (const alt of alternates) {
        const opt = document.createElement("option");
        opt.value = String(alt.id || "");
        const labelName = alt.name || alt.id;
        const recommendedTag = (alt.available !== false && alt.id === defaultHwId)
          ? "（推奨）" : "";
        const unavailableTag = alt.available === false ? "（未対応）" : "";
        opt.textContent = labelName + recommendedTag + unavailableTag;
        if (alt.available === false) opt.disabled = true;
        engineSelect.append(opt);
      }
      engineSelect.value = defaultHwId || "";
      updateEncoderEngineHint(preset, engineSelect.value);
    }
  }
  const info = presetEncoderInfo(preset);
  if (elements.exportOptionsCrfWrap) elements.exportOptionsCrfWrap.hidden = !info.crf;
  if (elements.exportOptionsMaxrateWrap) elements.exportOptionsMaxrateWrap.hidden = !info.maxrate;
  if (elements.exportOptionsEncoderPresetWrap) {
    elements.exportOptionsEncoderPresetWrap.hidden = !info.preset;
  }
  if (info.crf && elements.exportOptionsCrfInput) {
    const presetCrf = readPresetVideoArg(preset, "-crf");
    elements.exportOptionsCrfInput.value = presetCrf || info.defaultCrf || 20;
  }
  if (info.preset && elements.exportOptionsEncoderPresetSelect) {
    const presetSpeed = readPresetVideoArg(preset, "-preset");
    elements.exportOptionsEncoderPresetSelect.value = presetSpeed || "";
  }
  if (info.maxrate && elements.exportOptionsMaxrateInput) {
    elements.exportOptionsMaxrateInput.value = readPresetVideoArg(preset, "-maxrate") || "";
  }
  if (elements.exportOptionsFpsInput) {
    const presetFps = Number(preset.fps);
    const allowed = [8, 12, 24];
    elements.exportOptionsFpsInput.value = String(allowed.includes(presetFps) ? presetFps : 24);
  }
}

// ---- 書き出しダイアログから取り出すフォーム値 -----------------------------

export function readExportFormValues() {
  const presetId = elements.exportOptionsPresetSelect?.value || "";
  const preset = findPreset(presetId);
  if (!preset) {
    showToast("プリセットを選択してください", "error");
    return null;
  }
  // v2 経路で受け付ける codec 限定。FFV1 は削除済 / 非対応コーデックの拡張は別途。
  const codec = String(preset.videoCodec || "");
  if (!V2_SUPPORTED_PRESET_CODECS.has(codec)) {
    showToast(`このプリセット (${codec}) は v2 書き出しに非対応です`, "error");
    return null;
  }
  const fps = Number(elements.exportOptionsFpsInput?.value) || 24;
  const target = (() => {
    for (const r of document.querySelectorAll('input[name="exportTarget"]')) {
      if (r.checked) return r.value;
    }
    return "cut";
  })();
  if (target === "cut" && !state.selectedCutId) {
    showToast("選択中のカットが見つかりません", "error");
    return null;
  }
  const presetOptions = {};
  const engineId = (elements.exportOptionsEncoderEngineSelect?.value || "").trim();
  if (engineId) presetOptions.videoEncoder = engineId;
  const info = presetEncoderInfo(preset);
  if (info.crf) {
    const crf = Number(elements.exportOptionsCrfInput?.value);
    if (Number.isFinite(crf)) presetOptions.crf = crf;
  }
  if (info.preset) {
    const enc = (elements.exportOptionsEncoderPresetSelect?.value || "").trim();
    if (enc) presetOptions.encoderPreset = enc;
  }
  if (info.maxrate) {
    const mx = (elements.exportOptionsMaxrateInput?.value || "").trim();
    if (mx) presetOptions.maxrate = mx;
  }
  return {
    preset,
    presetId,
    presetOptions,
    fps,
    target,
    transparent: !!preset.alpha,
    monoToStereo: elements.exportOptionsMonoToStereoInput?.checked !== false,
    // 音声トラックを最終 mp4/mov に乗せるかどうか。チェック要素が存在しないとき
    // (= ダイアログ非経由のプリセット即時書き出し経路) は常に true で音声入り。
    includeAudio: elements.exportOptionsIncludeAudioInput
      ? elements.exportOptionsIncludeAudioInput.checked !== false
      : true,
    // 高速書き出し (WebCodecs)。チェック要素が無い経路では既定 true (= 対応形式なら
    // 高速経路、非対応なら export.js 側で自動フォールバック)。
    fastWebcodecs: elements.exportOptionsFastEncodeInput
      ? elements.exportOptionsFastEncodeInput.checked !== false
      : true,
    selectedCutId: state.selectedCutId || null,
  };
}

// ---- ダイアログ進捗 / ログ表示 -----------------------------------------

export function setExportProgress({ label = "", ratio = null } = {}) {
  if (elements.exportPreviewProgress) {
    elements.exportPreviewProgress.textContent = label;
  }
  const bar = elements.exportPreviewProgressBar;
  const fill = elements.exportPreviewProgressBarFill;
  if (bar && fill) {
    if (ratio == null) {
      bar.hidden = true;
      fill.style.width = "0%";
    } else {
      bar.hidden = false;
      const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
      fill.style.width = `${pct}%`;
    }
  }
}

export function clearExportProgress() {
  setExportProgress({ label: "", ratio: null });
}

export function appendExportLog(line, kind = "info") {
  const root = elements.exportDialogLogContent;
  if (!root) return;
  const div = document.createElement("div");
  div.className = "export-dialog-log-line";
  if (kind === "warn") div.classList.add("warn");
  else if (kind === "err") div.classList.add("err");
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${line}`;
  root.append(div);
  root.scrollTop = root.scrollHeight;
}

export function clearExportLog() {
  if (elements.exportDialogLogContent) elements.exportDialogLogContent.textContent = "";
}

// 書き出し中はフォームを操作不可にし、ボタンも書き換える。
export function setExportDialogRunning(running) {
  const settingsRoot = elements.exportOptionsDialog?.querySelector(".export-dialog-settings");
  if (settingsRoot) {
    for (const ctrl of settingsRoot.querySelectorAll("input, select, button")) {
      ctrl.disabled = running;
    }
  }
  const confirm = elements.exportOptionsConfirmButton;
  const cancel = elements.exportOptionsCancelButton;
  if (confirm) {
    confirm.disabled = running;
  }
  if (cancel) {
    const label = cancel.querySelector("span:last-child");
    if (label) label.textContent = running ? "中止" : "キャンセル";
    const icon = cancel.querySelector(".msym");
    if (icon) icon.textContent = running ? "stop_circle" : "close";
  }
}

export function clearExportPreviewCanvas() {
  const canvas = elements.exportPreviewCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}
