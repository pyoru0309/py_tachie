// ===========================================================================
// グローバル設定（動画書き出しプリセット / 黒線描画モード / ffmpeg / projectsPath 等）
// reloadProjectData は projects 関連が未モジュール化のため、bindGlobalSettings から
// 依存性注入で受け取る。
// ===========================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { applyExportOptionsPresetUI, updateEncoderEngineHintFromPreset } from "./export-ui.js";
import { fetchTtsState, refreshTtsCatalog } from "./tts.js";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORIES,
  defaultShortcuts,
  shortcutLabel,
  eventToCanonicalKey,
} from "./shortcuts.js";

let deps = {
  reloadProjectData: async () => {},
  restartAutoBackupTimer: () => {},
};

export async function fetchGlobalConfig() {
  const res = await fetch("/api/global-config");
  if (!res.ok) throw new Error("global-config 取得失敗");
  return res.json();
}

function activateGlobalTab(tabId) {
  for (const tab of elements.globalSettingsTabs) {
    tab.classList.toggle("active", tab.dataset.globalTab === tabId);
  }
  for (const panel of elements.globalSettingsPanels) {
    panel.classList.toggle("hidden", panel.dataset.globalTabPanel !== tabId);
  }
}

function buildPresetItem(preset, selectedId, name, onChange) {
  const label = document.createElement("label");
  const unavailable = preset.available === false;
  label.className = `preset-item${preset.id === selectedId ? " selected" : ""}${unavailable ? " disabled" : ""}`;
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = name;
  radio.value = preset.id;
  radio.disabled = unavailable;
  if (preset.id === selectedId) radio.checked = true;
  radio.addEventListener("change", () => onChange(preset.id));

  const body = document.createElement("div");
  body.className = "preset-item-body";
  const nameEl = document.createElement("div");
  nameEl.className = "preset-item-name";
  nameEl.textContent = preset.name;
  if (preset.builtIn) {
    const badge = document.createElement("span");
    badge.className = "badge readonly";
    badge.textContent = "標準";
    nameEl.append(badge);
  }
  if (unavailable) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "未対応";
    nameEl.append(badge);
  }
  const descEl = document.createElement("div");
  descEl.className = "preset-item-description";
  descEl.textContent = preset.description || "";
  const metaEl = document.createElement("div");
  metaEl.className = "preset-item-meta";
  const audioPart = preset.audioBitrate ? `${preset.audioCodec}/${preset.audioBitrate}` : preset.audioCodec || "";
  metaEl.textContent = `${preset.extension || ""} · ${preset.videoCodec || ""}${preset.pixFmt ? ` · ${preset.pixFmt}` : ""} · ${preset.fps || 30}fps · ${audioPart}`;
  body.append(nameEl, descEl, metaEl);
  if (unavailable && preset.unavailableReason) {
    const reasonEl = document.createElement("div");
    reasonEl.className = "preset-item-warning";
    reasonEl.textContent = preset.unavailableReason;
    body.append(reasonEl);
  }
  label.append(radio, body);
  return label;
}

function renderGlobalSettings() {
  const data = state.globalConfig;
  if (!data || !elements.globalVideoPresetList) return;
  const selectedId = data.config.videoExport.defaultPresetId;
  elements.globalVideoPresetList.innerHTML = "";
  if (elements.ffmpegStatusBanner) {
    const ffmpeg = data.ffmpeg || {};
    if (ffmpeg.available === false) {
      elements.ffmpegStatusBanner.hidden = false;
      elements.ffmpegStatusBanner.textContent =
        ffmpeg.error
          ? `ffmpeg 検出エラー: ${ffmpeg.error}`
          : "ffmpeg が利用できません。インストールと PATH 設定を確認してください。";
    } else {
      elements.ffmpegStatusBanner.hidden = true;
      elements.ffmpegStatusBanner.textContent = "";
    }
  }
  for (const preset of data.builtInVideoPresets || []) {
    elements.globalVideoPresetList.append(
      buildPresetItem(preset, selectedId, "videoPreset", (id) => {
        state.globalConfig.config.videoExport.defaultPresetId = id;
        renderGlobalSettings();
      }),
    );
  }
  const customs = data.customVideoPresets || data.config.videoExport.customPresets || [];
  for (const preset of customs) {
    elements.globalVideoPresetList.append(
      buildPresetItem(preset, selectedId, "videoPreset", (id) => {
        state.globalConfig.config.videoExport.defaultPresetId = id;
        renderGlobalSettings();
      }),
    );
  }
  if (elements.globalHistorySizeInput) {
    elements.globalHistorySizeInput.value =
      data.config.editorHistorySize ?? 50;
  }
  if (elements.globalPreviewLookaheadInput) {
    const la = Number(data.config.preview?.prefetchLookahead);
    elements.globalPreviewLookaheadInput.value =
      Number.isFinite(la) && la >= 0 ? String(la) : "3";
  }
  if (elements.globalPreviewSmoothingSelect) {
    const s = String(data.config.preview?.smoothing || "sharp").toLowerCase();
    elements.globalPreviewSmoothingSelect.value = s === "smooth" ? "smooth" : "sharp";
  }
  const backupCfg = data.config?.backup || {};
  if (elements.globalBackupIntervalInput) {
    elements.globalBackupIntervalInput.value = backupCfg.autoIntervalMinutes ?? 5;
  }
  if (elements.globalBackupRetentionInput) {
    elements.globalBackupRetentionInput.value = backupCfg.autoRetentionCount ?? 50;
  }
  const cacheCfg = data.config?.cache || {};
  if (elements.globalCacheAutoPruneInput) {
    elements.globalCacheAutoPruneInput.checked = cacheCfg.autoPruneOnStartup !== false;
  }
  if (elements.globalCacheAutoPruneHoursInput) {
    // 旧 autoPruneOlderThanDays が残っていれば 24 倍して読む (= migration はサーバ側で
    // やっているので普通は autoPruneOlderThanHours が入っている)。
    const fallbackHours = cacheCfg.autoPruneOlderThanDays != null
      ? Number(cacheCfg.autoPruneOlderThanDays) * 24
      : 6;
    elements.globalCacheAutoPruneHoursInput.value = cacheCfg.autoPruneOlderThanHours ?? fallbackHours;
  }
  if (elements.globalFfmpegPathInput) {
    elements.globalFfmpegPathInput.value = data.config.ffmpegPath || "";
  }
  if (elements.globalFfmpegResolved) {
    const ffmpeg = data.ffmpeg || {};
    if (ffmpeg.available) {
      elements.globalFfmpegResolved.textContent =
        `現在: ${data.config.ffmpegPath || "（PATH の ffmpeg）"} · ${ffmpeg.encoderCount} エンコーダ検出済み`;
    } else {
      elements.globalFfmpegResolved.textContent =
        ffmpeg.error
          ? `現在: 利用不可（${ffmpeg.error}）`
          : "現在: 利用不可";
    }
  }
  if (elements.globalProjectsPathInput) {
    elements.globalProjectsPathInput.value = data.config.projectsPath || "";
  }
  if (elements.globalProjectsResolved) {
    elements.globalProjectsResolved.textContent = data.config.projectsPath
      ? `現在: ${data.config.projectsPath}`
      : "現在: アプリ同梱の projects/ を使用中";
  }
  if (elements.globalMonoToStereoInput) {
    elements.globalMonoToStereoInput.checked =
      data.config.videoExport?.monoToStereo !== false;
  }
  if (elements.globalPromptBeforeExportInput) {
    elements.globalPromptBeforeExportInput.checked =
      Boolean(data.config.videoExport?.promptBeforeExport);
  }
  if (elements.globalBpThresholdMbInput) {
    const bp = Number(data.config.videoExport?.bpThresholdMB);
    elements.globalBpThresholdMbInput.value = Number.isFinite(bp) && bp >= 1 ? String(bp) : "16";
  }
  if (elements.globalQuietModeInput) {
    elements.globalQuietModeInput.checked =
      Boolean(data.config.logging?.quietMode);
  }
  if (elements.globalVendorUseCdnInput) {
    elements.globalVendorUseCdnInput.checked =
      Boolean(data.config.vendor?.useCdn);
  }
  // 描画エンジン (renderer.version) は v2 (WebGL) 固定。旧 v1 (Pillow + Canvas2D)
  // 経路はサーバ・クライアントとも撤去済み。
  renderTtsSettings();
  renderShortcutList();
}

async function refreshTtsButtonHandler() {
  // パスを変更した直後に押した可能性があるので、まず現在の入力値を保存してから refresh する。
  const button = elements.ttsRefreshButton;
  if (!state.globalConfig) return;
  const cfg = state.globalConfig.config;
  const ttsPayload = {
    voicevoxAppPath: (elements.ttsVoicevoxAppPathInput?.value || "").trim(),
    voicevoxBaseUrl: (elements.ttsVoicevoxBaseUrlInput?.value || "").trim(),
    voicepeakBinPath: (elements.ttsVoicepeakBinPathInput?.value || "").trim(),
  };
  if (button) button.disabled = true;
  if (elements.ttsCatalogStatus) {
    // refresh は backend で「VOICEVOX 検出 → 起動 → /version 待機 → /speakers 取得」
    // を順に行うので、押した直後の体感は最大 ~20 秒沈黙する。ステータスを書いておく。
    elements.ttsCatalogStatus.textContent =
      "VOICEVOX が未起動の場合は起動を試みます（最大20秒）…";
  }
  try {
    if (
      ttsPayload.voicevoxAppPath !== (cfg.tts?.voicevoxAppPath || "") ||
      ttsPayload.voicevoxBaseUrl !== (cfg.tts?.voicevoxBaseUrl || "") ||
      ttsPayload.voicepeakBinPath !== (cfg.tts?.voicepeakBinPath || "")
    ) {
      const res = await fetch("/api/global-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tts: ttsPayload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "設定の保存に失敗しました");
      state.globalConfig = data;
    }
    await refreshTtsCatalog();
    renderGlobalSettings();
    const errs = state.tts?.errors || [];
    const total = (state.tts?.voices || []).length;
    if (errs.length) {
      showToast(`登録完了 (${total} 件) ／ 警告: ${errs[0]}`, "info");
    } else {
      showToast(`音声カタログを更新しました（${total} 件）`);
    }
  } finally {
    if (button) button.disabled = false;
  }
}

function renderTtsSettings() {
  const cfg = state.globalConfig?.config?.tts || {};
  const tts = state.tts || {};
  if (elements.ttsVoicevoxAppPathInput) {
    elements.ttsVoicevoxAppPathInput.value = cfg.voicevoxAppPath || "";
    elements.ttsVoicevoxAppPathInput.placeholder = tts.voicevox?.appPath
      ? `自動検出: ${tts.voicevox.appPath}`
      : "/Applications/VOICEVOX.app";
  }
  if (elements.ttsVoicevoxBaseUrlInput) {
    elements.ttsVoicevoxBaseUrlInput.value = cfg.voicevoxBaseUrl || "";
    elements.ttsVoicevoxBaseUrlInput.placeholder =
      tts.voicevox?.baseUrl || "http://127.0.0.1:50021";
  }
  if (elements.ttsVoicevoxStatus) {
    const vv = tts.voicevox || {};
    if (!vv.appPath) {
      elements.ttsVoicevoxStatus.textContent =
        "VOICEVOX アプリは検出されていません（パスを入力するか、デフォルトの場所にインストールしてください）";
    } else if (!vv.engineAlive) {
      elements.ttsVoicevoxStatus.textContent =
        `アプリ検出: ${vv.appPath} / Engine 未起動 (${vv.baseUrl})`;
    } else {
      const count = (vv.voices || []).length;
      elements.ttsVoicevoxStatus.textContent = count
        ? `アプリ検出: ${vv.appPath} / Engine 応答: ${vv.baseUrl} / 話者: ${count} 件登録済み`
        : `アプリ検出: ${vv.appPath} / Engine 応答: ${vv.baseUrl} / 「ボイスを登録」を押すと話者を取得します`;
    }
  }
  if (elements.ttsVoicepeakBinPathInput) {
    elements.ttsVoicepeakBinPathInput.value = cfg.voicepeakBinPath || "";
    elements.ttsVoicepeakBinPathInput.placeholder = tts.voicepeak?.binPath
      ? `自動検出: ${tts.voicepeak.binPath}`
      : "/Applications/voicepeak.app/Contents/MacOS/voicepeak";
  }
  if (elements.ttsVoicepeakStatus) {
    const vp = tts.voicepeak || {};
    if (!vp.binPath) {
      elements.ttsVoicepeakStatus.textContent =
        "Voicepeak は検出されていません（パスを入力するか、デフォルトの場所にインストールしてください）";
    } else {
      const count = (vp.voices || []).length;
      elements.ttsVoicepeakStatus.textContent = count
        ? `バイナリ検出: ${vp.binPath} / 話者: ${count} 件登録済み`
        : `バイナリ検出: ${vp.binPath} / 「ボイスを登録」を押すと話者・感情を取得します`;
    }
  }
  if (elements.ttsCatalogStatus) {
    const updated = tts.catalogUpdatedAt;
    const errs = tts.errors || [];
    if (errs.length) {
      elements.ttsCatalogStatus.textContent = `エラー: ${errs.join(" / ")}`;
    } else if (updated) {
      elements.ttsCatalogStatus.textContent = `最終更新: ${updated}`;
    } else {
      elements.ttsCatalogStatus.textContent = "";
    }
  }
}

function describeVendorState(state) {
  const libs = state?.libs || {};
  const parts = [];
  for (const [name, info] of Object.entries(libs)) {
    const active = info.active || "";
    if (active) {
      parts.push(`${name}@${active}（ローカル）`);
    } else {
      parts.push(`${name}: 未インストール（CDN フォールバック）`);
    }
  }
  if (state?.useCdn) {
    return `CDN 利用（local 解決を無効化中）— ${parts.join(" / ") || "—"}`;
  }
  return parts.join(" / ") || "—";
}

async function refreshVendorStatus() {
  if (!elements.globalVendorStatus) return;
  try {
    const res = await fetch("/api/vendor/state");
    if (!res.ok) throw new Error("vendor 取得失敗");
    const data = await res.json();
    elements.globalVendorStatus.textContent = describeVendorState(data);
  } catch (error) {
    console.error(error);
    elements.globalVendorStatus.textContent = "状態取得に失敗しました";
  }
}

function ensureShortcutsObject() {
  if (!state.globalConfig) return null;
  const cfg = state.globalConfig.config;
  if (!cfg.shortcuts || typeof cfg.shortcuts !== "object") {
    cfg.shortcuts = {};
  }
  return cfg.shortcuts;
}

function effectiveShortcut(actionId) {
  const overrides = ensureShortcutsObject();
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    return overrides[actionId] || "";
  }
  return SHORTCUT_ACTIONS.find((a) => a.id === actionId)?.default || "";
}

function setShortcutOverride(actionId, key) {
  const overrides = ensureShortcutsObject();
  if (!overrides) return;
  // 「初期値」(undo) → entry を消す。「なし」(clear) → 空文字を残す。
  // 入力されたキーが既定と同じならエントリ削除（綺麗な状態で保存）。
  const def = SHORTCUT_ACTIONS.find((a) => a.id === actionId)?.default || "";
  if (key === undefined || key === null) {
    delete overrides[actionId];
    return;
  }
  if (key === def) {
    delete overrides[actionId];
    return;
  }
  overrides[actionId] = key;
}

function captureShortcutKey(button, actionId) {
  // 「キーを押してください」モードに入る。次の keydown を吸収して割当てる。
  button.classList.add("capturing");
  button.textContent = "キーを押してください…";
  const onKey = (event) => {
    if (event.key === "Escape") {
      cancel();
      return;
    }
    if (event.key === "Tab") {
      // Tab はフォーカス操作を奪わない（フォーカス迷子防止）。
      return;
    }
    // 修飾キーだけ押された場合はまだ確定しない
    if (["Shift", "Control", "Alt", "Meta", "OS"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const canonical = eventToCanonicalKey(event);
    if (!canonical) {
      cancel();
      return;
    }
    setShortcutOverride(actionId, canonical);
    cleanup();
    renderShortcutList();
  };
  const onBlur = () => cancel();
  const cancel = () => {
    cleanup();
    renderShortcutList();
  };
  const cleanup = () => {
    button.classList.remove("capturing");
    document.removeEventListener("keydown", onKey, true);
    button.removeEventListener("blur", onBlur);
  };
  document.addEventListener("keydown", onKey, true);
  button.addEventListener("blur", onBlur);
}

function buildShortcutRow(action) {
  const row = document.createElement("div");
  row.className = "shortcut-row";

  const label = document.createElement("div");
  label.className = "shortcut-label";
  label.textContent = action.label;
  row.append(label);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "shortcut-key";
  const current = effectiveShortcut(action.id);
  button.textContent = shortcutLabel(current);
  if (!current) button.classList.add("is-empty");
  button.title = current ? `${current}（クリックで再設定）` : "クリックでキーを設定";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    captureShortcutKey(button, action.id);
  });
  row.append(button);

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "compact-action-button";
  clearButton.textContent = "クリア";
  clearButton.title = "なし（無効化）にする";
  clearButton.addEventListener("click", (event) => {
    event.preventDefault();
    setShortcutOverride(action.id, "");
    renderShortcutList();
  });
  row.append(clearButton);

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "compact-action-button";
  resetButton.textContent = "初期値";
  resetButton.title = `初期値: ${shortcutLabel(action.default)}`;
  resetButton.addEventListener("click", (event) => {
    event.preventDefault();
    setShortcutOverride(action.id, undefined);
    renderShortcutList();
  });
  row.append(resetButton);

  return row;
}

function renderShortcutList() {
  const container = elements.globalShortcutsList;
  if (!container) return;
  container.innerHTML = "";
  for (const cat of SHORTCUT_CATEGORIES) {
    const actions = SHORTCUT_ACTIONS.filter((a) => a.category === cat.id);
    if (actions.length === 0) continue;
    const group = document.createElement("section");
    group.className = "shortcut-group";
    const heading = document.createElement("h4");
    heading.className = "shortcut-group-heading";
    heading.textContent = cat.label;
    group.append(heading);
    for (const action of actions) {
      group.append(buildShortcutRow(action));
    }
    container.append(group);
  }
}

async function refreshFontStatus() {
  if (!elements.globalFontStatus) return;
  try {
    const res = await fetch("/api/fonts/installed");
    if (!res.ok) throw new Error("fonts 取得失敗");
    const data = await res.json();
    const names = (data?.installed || []).map((f) => f.family).filter(Boolean);
    if (names.length === 0) {
      elements.globalFontStatus.textContent =
        "assets/fonts/ にインストール済みフォントなし（OS フォントへフォールバック）";
    } else {
      elements.globalFontStatus.textContent = `インストール済み: ${names.join(" / ")}`;
    }
  } catch (error) {
    console.error(error);
    elements.globalFontStatus.textContent = "状態取得に失敗しました";
  }
}

// 検出結果と override の編集中バッファ。state.globalConfig 経由で
// 全体設定保存時に payload に流す (saveGlobalSettings 参照)。
const fontScanState = {
  files: [],
  weightChoices: [],
};

function weightLabelById(id) {
  const item = fontScanState.weightChoices.find((w) => w.id === id);
  return item?.name || id;
}

function ensureOverridesObject() {
  if (!state.globalConfig) return null;
  const cfg = state.globalConfig.config;
  if (!cfg.fontWeightOverrides || typeof cfg.fontWeightOverrides !== "object") {
    cfg.fontWeightOverrides = {};
  }
  return cfg.fontWeightOverrides;
}

function renderFontScanList() {
  const list = elements.globalFontScanList;
  if (!list) return;
  list.innerHTML = "";
  if (fontScanState.files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "asset-hint";
    empty.textContent = "assets/fonts/ にスキャン対象のフォントがありません";
    list.append(empty);
    return;
  }
  const overrides = ensureOverridesObject() || {};
  for (const f of fontScanState.files) {
    const row = document.createElement("div");
    row.className = "font-scan-row" + (overrides[f.path] ? " has-override" : "");

    const name = document.createElement("div");
    name.className = "font-scan-filename";
    name.title = f.path;
    name.textContent = f.filename;

    const meta = document.createElement("div");
    meta.className = "font-scan-meta";
    const family = f.metaFamily || f.displayFamily;
    const sub = f.metaSubfamily ? ` · ${f.metaSubfamily}` : "";
    const variable = f.isVariable ? " · variable" : "";
    meta.textContent = `${family}${sub}${variable}`;

    const cls = document.createElement("div");
    cls.className = "font-scan-class";
    cls.title = `OS/2.usWeightClass = ${f.weightClass}（${f.source}）`;
    cls.textContent = f.weightClass || "—";

    const select = document.createElement("select");
    const auto = document.createElement("option");
    auto.value = "";
    const detected = f.detectedWeight;
    auto.textContent = `自動 (${weightLabelById(detected)})`;
    select.append(auto);
    for (const w of fontScanState.weightChoices) {
      const opt = document.createElement("option");
      opt.value = w.id;
      opt.textContent = w.name;
      select.append(opt);
    }
    select.value = overrides[f.path] || "";
    select.addEventListener("change", () => {
      const ov = ensureOverridesObject();
      if (!ov) return;
      const v = select.value.trim();
      if (v) ov[f.path] = v;
      else delete ov[f.path];
      // override の有無で枠色を更新
      row.classList.toggle("has-override", Boolean(v));
    });

    row.append(name, meta, cls, select);
    list.append(row);
  }
}

async function refreshFontScan() {
  if (!elements.globalFontScanList) return;
  if (elements.globalFontScanStatus) {
    elements.globalFontScanStatus.textContent = "スキャン中…";
  }
  try {
    const res = await fetch("/api/fonts/scan-detail");
    if (!res.ok) throw new Error("scan-detail 取得失敗");
    const data = await res.json();
    fontScanState.files = data.files || [];
    fontScanState.weightChoices = data.weightChoices || [];
    // サーバ側の override と state.globalConfig の override が乖離している
    // ケース (画面開きっぱなしで他箇所が触った等) は、サーバ側を信用して
    // editing buffer を上書き。
    if (state.globalConfig) {
      state.globalConfig.config.fontWeightOverrides = { ...(data.overrides || {}) };
    }
    if (elements.globalFontScanStatus) {
      const overrideCount = Object.keys(data.overrides || {}).length;
      elements.globalFontScanStatus.textContent =
        `${fontScanState.files.length} 個のフォントを認識` +
        (overrideCount ? ` / ${overrideCount} 件の上書きあり` : "");
    }
    renderFontScanList();
  } catch (error) {
    console.error(error);
    if (elements.globalFontScanStatus) {
      elements.globalFontScanStatus.textContent = "スキャンに失敗しました";
    }
  }
}

async function installVendorLibsAll() {
  if (!confirm("three.js と mp4box.js を npm から取得して static/vendor/ に保存します。よろしいですか?")) {
    return;
  }
  const button = elements.installVendorLibsButton;
  if (button) button.disabled = true;
  try {
    elements.globalVendorStatus &&
      (elements.globalVendorStatus.textContent = "インストール中…");
    for (const lib of ["three", "mp4box"]) {
      const res = await fetch("/api/vendor/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lib }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || `${lib} インストール失敗`);
    }
    showToast("JS ライブラリをインストールしました（リロードで反映）");
    await refreshVendorStatus();
  } catch (error) {
    console.error(error);
    showToast(error.message || "JS ライブラリのインストールに失敗しました", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function installNotoSansJp() {
  const button = elements.installNotoSansJpButton;
  if (button) button.disabled = true;
  try {
    elements.globalFontStatus &&
      (elements.globalFontStatus.textContent = "インストール中…");
    const res = await fetch("/api/fonts/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "NotoSansJP" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "Noto Sans JP インストール失敗");
    showToast("Noto Sans JP をインストールしました");
    await refreshFontStatus();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Noto Sans JP のインストールに失敗しました", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderUpdateStatus(data) {
  const status = elements.globalUpdateStatus;
  const applyBtn = elements.applyUpdateButton;
  const details = elements.globalUpdateDetails;
  if (!status || !applyBtn || !details) return;
  const current = data.currentTag || data.currentSha || "?";
  const latest = data.latestTag || data.latestSha || "?";
  if (data.behind === 0) {
    status.textContent = `最新版です (${current})`;
    applyBtn.classList.add("hidden");
    details.classList.add("hidden");
    details.innerHTML = "";
    return;
  }
  status.textContent = `${current} → ${latest} （${data.behind} 個の更新があります）`;
  applyBtn.classList.remove("hidden");
  details.classList.remove("hidden");

  const lines = ['<div class="update-options">'];
  lines.push(
    '<label class="checkbox-row"><input type="checkbox" id="updateIncludeAssets" /> ' +
      "共通アセット (背景・音声等) も更新する" +
      "</label>"
  );
  lines.push(
    '<label class="checkbox-row"><input type="checkbox" id="updateMakeBackup" checked /> ' +
      "アップデート前にバックアップを取る (app_state/backups/)" +
      "</label>"
  );
  if (Array.isArray(data.dirtyModified) && data.dirtyModified.length > 0) {
    lines.push(
      '<label class="checkbox-row"><input type="checkbox" id="updateDiscardLocal" /> ' +
        "ローカルで変更されているファイルを破棄して進める" +
        "</label>"
    );
    lines.push('<details class="update-dirty-files">');
    lines.push(`<summary>変更があるファイル (${data.dirtyModified.length})</summary><ul>`);
    for (const f of data.dirtyModified.slice(0, 30)) {
      lines.push(`<li><code>${escapeHtml(f)}</code></li>`);
    }
    if (data.dirtyModified.length > 30) {
      lines.push(`<li>… 他 ${data.dirtyModified.length - 30} 件</li>`);
    }
    lines.push("</ul></details>");
  }
  lines.push("</div>");
  details.innerHTML = lines.join("");
}

async function checkForUpdates() {
  const button = elements.checkForUpdatesButton;
  if (button) button.disabled = true;
  if (elements.globalUpdateStatus) {
    elements.globalUpdateStatus.textContent = "確認中…";
  }
  try {
    const res = await fetch("/api/update/check");
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const msg = data.message || "確認に失敗しました";
      if (elements.globalUpdateStatus) elements.globalUpdateStatus.textContent = msg;
      elements.applyUpdateButton?.classList.add("hidden");
      elements.globalUpdateDetails?.classList.add("hidden");
      return;
    }
    state.updateInfo = data;
    renderUpdateStatus(data);
  } catch (error) {
    console.error(error);
    if (elements.globalUpdateStatus) {
      elements.globalUpdateStatus.textContent = "確認に失敗しました";
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function applyUpdate() {
  if (!confirm("アップデートを実行します。完了後はアプリの再起動が必要です。続行しますか?")) {
    return;
  }
  const button = elements.applyUpdateButton;
  if (button) button.disabled = true;
  if (elements.globalUpdateStatus) {
    elements.globalUpdateStatus.textContent = "更新中…";
  }
  try {
    const includeAssets = document.getElementById("updateIncludeAssets")?.checked || false;
    const backup = document.getElementById("updateMakeBackup")?.checked !== false;
    const discardLocal = document.getElementById("updateDiscardLocal")?.checked || false;
    const res = await fetch("/api/update/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeAssets, backup, discardLocalChanges: discardLocal }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const msg = data.message || data.detail || "アップデートに失敗しました";
      showToast(msg, "error");
      if (elements.globalUpdateStatus) elements.globalUpdateStatus.textContent = msg;
      return;
    }
    showToast(data.message || "アップデートが完了しました。再起動してください。", "success");
    if (elements.globalUpdateStatus) {
      elements.globalUpdateStatus.textContent = data.message;
    }
    elements.applyUpdateButton?.classList.add("hidden");
    elements.globalUpdateDetails?.classList.add("hidden");
  } catch (error) {
    console.error(error);
    showToast("アップデートに失敗しました", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

export async function openGlobalSettings() {
  try {
    state.globalConfig = await fetchGlobalConfig();
  } catch (error) {
    console.error(error);
    showToast("全体設定の取得に失敗しました", "error");
    return;
  }
  activateGlobalTab("video");
  try {
    await fetchTtsState();
  } catch (error) {
    console.warn("tts state 取得失敗", error);
  }
  renderGlobalSettings();
  refreshVendorStatus();
  refreshFontStatus();
  refreshFontScan();
  if (typeof elements.globalSettingsDialog?.showModal === "function") {
    elements.globalSettingsDialog.showModal();
  } else {
    elements.globalSettingsDialog?.setAttribute("open", "");
  }
}

async function saveGlobalSettings() {
  if (!state.globalConfig) return;
  const cfg = state.globalConfig.config;
  const historySize = Math.max(
    1,
    Math.min(500, Number(elements.globalHistorySizeInput?.value) || cfg.editorHistorySize || 50),
  );
  cfg.editorHistorySize = historySize;
  const payload = {
    videoExport: {
      defaultPresetId: cfg.videoExport.defaultPresetId,
      customPresets: cfg.videoExport.customPresets || [],
      monoToStereo: elements.globalMonoToStereoInput
        ? elements.globalMonoToStereoInput.checked
        : cfg.videoExport.monoToStereo !== false,
      promptBeforeExport: elements.globalPromptBeforeExportInput
        ? elements.globalPromptBeforeExportInput.checked
        : Boolean(cfg.videoExport.promptBeforeExport),
      bpThresholdMB: (() => {
        const raw = Number(elements.globalBpThresholdMbInput?.value);
        const cur = Number(cfg.videoExport?.bpThresholdMB);
        const fallback = Number.isFinite(cur) && cur >= 1 ? cur : 16;
        if (!Number.isFinite(raw)) return fallback;
        return Math.max(1, Math.min(1024, raw));
      })(),
    },
    editorHistorySize: historySize,
    ffmpegPath: (elements.globalFfmpegPathInput?.value || "").trim(),
    projectsPath: (elements.globalProjectsPathInput?.value || "").trim(),
    logging: {
      quietMode: elements.globalQuietModeInput
        ? elements.globalQuietModeInput.checked
        : Boolean(cfg.logging?.quietMode),
    },
    vendor: {
      useCdn: elements.globalVendorUseCdnInput
        ? elements.globalVendorUseCdnInput.checked
        : Boolean(cfg.vendor?.useCdn),
    },
    fontWeightOverrides: cfg.fontWeightOverrides || {},
    tts: {
      voicevoxAppPath: (elements.ttsVoicevoxAppPathInput?.value || "").trim(),
      voicevoxBaseUrl: (elements.ttsVoicevoxBaseUrlInput?.value || "").trim(),
      voicepeakBinPath: (elements.ttsVoicepeakBinPathInput?.value || "").trim(),
    },
    shortcuts: cfg.shortcuts && typeof cfg.shortcuts === "object" ? cfg.shortcuts : {},
    preview: {
      prefetchLookahead: (() => {
        const raw = Number(elements.globalPreviewLookaheadInput?.value);
        const cur = Number(cfg.preview?.prefetchLookahead);
        const fallback = Number.isFinite(cur) && cur >= 0 ? Math.floor(cur) : 3;
        if (!Number.isFinite(raw)) return fallback;
        return Math.max(0, Math.min(20, Math.floor(raw)));
      })(),
      smoothing: (() => {
        const v = String(elements.globalPreviewSmoothingSelect?.value || cfg.preview?.smoothing || "sharp").toLowerCase();
        return v === "smooth" ? "smooth" : "sharp";
      })(),
    },
    backup: {
      autoIntervalMinutes: Math.max(
        1,
        Math.min(120, Number(elements.globalBackupIntervalInput?.value) || cfg.backup?.autoIntervalMinutes || 5)
      ),
      autoRetentionCount: Math.max(
        1,
        Math.min(1000, Number(elements.globalBackupRetentionInput?.value) || cfg.backup?.autoRetentionCount || 50)
      ),
    },
    cache: {
      autoPruneOnStartup: !!(elements.globalCacheAutoPruneInput?.checked),
      autoPruneOlderThanHours: Math.max(
        1,
        Math.min(8760, Number(elements.globalCacheAutoPruneHoursInput?.value) || cfg.cache?.autoPruneOlderThanHours || 6)
      ),
    },
    // renderer.version は v2 固定 (UI / バックエンドとも撤去済み)。payload には乗せない。
  };
  const previousProjectsPath = state.globalConfig?.config?.projectsPath || "";
  const previousOverrides = JSON.stringify(
    state.globalConfig?.config?.fontWeightOverrides || {},
  );
  try {
    const res = await fetch("/api/global-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "保存に失敗しました");
    state.globalConfig = data;
    state.history.maxSize = data.config?.editorHistorySize ?? 50;
    // backup.autoIntervalMinutes 変更を反映するためタイマーを張り直す。
    // ハンドラは循環参照を避けるため deps 経由 (bindGlobalSettings 経由で注入)。
    try {
      if (typeof deps.restartAutoBackupTimer === "function") {
        deps.restartAutoBackupTimer();
      }
    } catch (e) {
      console.warn("auto backup timer restart failed", e);
    }
    // プレビュー smoothing の設定変更を即座に反映 (= overlay 開始/停止)
    try {
      const { applyPreviewSmoothingFromConfig } = await import("./playback.js");
      applyPreviewSmoothingFromConfig?.();
    } catch (_e) { /* ignore */ }
    showToast("全体設定を保存しました");
    elements.globalSettingsDialog?.close();
    if ((data.config?.projectsPath || "") !== previousProjectsPath) {
      try {
        await deps.reloadProjectData();
        showToast("プロジェクトフォルダを再読み込みしました");
      } catch (error) {
        console.error(error);
        showToast("新しいフォルダのプロジェクト読み込みに失敗しました", "error");
      }
    }
    const newOverrides = JSON.stringify(data.config?.fontWeightOverrides || {});
    if (newOverrides !== previousOverrides) {
      // フォント自動認識の override が変わった → 素材再スキャンで manifest を更新
      try {
        await deps.reloadProjectData();
        showToast("フォント認識を再スキャンしました");
      } catch (error) {
        console.error(error);
      }
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || "全体設定の保存に失敗しました", "error");
  }
}

export function bindGlobalSettings(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  elements.dashboardGlobalSettingsButton?.addEventListener("click", () => {
    openGlobalSettings();
  });
  elements.closeGlobalSettingsButton?.addEventListener("click", () => {
    elements.globalSettingsDialog?.close();
  });
  elements.saveGlobalSettingsButton?.addEventListener("click", () => {
    saveGlobalSettings();
  });
  elements.refreshFfmpegButton?.addEventListener("click", async () => {
    elements.refreshFfmpegButton.disabled = true;
    try {
      const response = await fetch("/api/ffmpeg/refresh", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      if (state.globalConfig) {
        state.globalConfig.ffmpeg = data.ffmpeg;
        state.globalConfig.builtInVideoPresets = data.builtInVideoPresets;
      }
      renderGlobalSettings();
      showToast(
        data.ffmpeg?.available
          ? `ffmpeg を検出しました（${data.ffmpeg.encoderCount} エンコーダ）`
          : "ffmpeg が見つかりませんでした",
        data.ffmpeg?.available ? "success" : "error",
      );
    } catch (error) {
      console.error(error);
      showToast("ffmpeg の再検出に失敗しました", "error");
    } finally {
      elements.refreshFfmpegButton.disabled = false;
    }
  });
  for (const tab of elements.globalSettingsTabs) {
    tab.addEventListener("click", () => activateGlobalTab(tab.dataset.globalTab));
  }
  elements.installVendorLibsButton?.addEventListener("click", () => {
    installVendorLibsAll();
  });
  elements.installNotoSansJpButton?.addEventListener("click", () => {
    installNotoSansJp();
  });
  elements.refreshFontScanButton?.addEventListener("click", () => {
    refreshFontScan();
  });
  elements.checkForUpdatesButton?.addEventListener("click", () => {
    checkForUpdates();
  });
  elements.applyUpdateButton?.addEventListener("click", () => {
    applyUpdate();
  });
  elements.resetShortcutsButton?.addEventListener("click", () => {
    if (state.globalConfig?.config) {
      state.globalConfig.config.shortcuts = { ...defaultShortcuts() };
      // defaults に揃える = 全 entry で値が default と等しい状態。
      // 保存時に「default と同じならエントリ削除」する仕様により実体は空 dict になる。
      // ただ次回開いたときの表示用に entries を残しておく必要は無い (defaults が
      // それ自体表示の真実なので) → 空 dict で OK。
      state.globalConfig.config.shortcuts = {};
    }
    renderShortcutList();
  });
  elements.ttsRefreshButton?.addEventListener("click", () => {
    refreshTtsButtonHandler().catch((error) => {
      console.error(error);
      showToast(error.message || "音声カタログの取得に失敗しました", "error");
    });
  });
  elements.exportOptionsPresetSelect?.addEventListener("change", applyExportOptionsPresetUI);
  elements.exportOptionsEncoderEngineSelect?.addEventListener("change", () => {
    // 現在の preset を取り直して hint を更新
    const presets = (state.globalConfig?.builtInVideoPresets || []).concat(
      state.globalConfig?.customVideoPresets || state.globalConfig?.config?.videoExport?.customPresets || [],
    );
    const preset = presets.find((p) => p.id === elements.exportOptionsPresetSelect?.value);
    if (preset && elements.exportOptionsEncoderEngineSelect) {
      updateEncoderEngineHintFromPreset(preset, elements.exportOptionsEncoderEngineSelect.value);
    }
  });
}
