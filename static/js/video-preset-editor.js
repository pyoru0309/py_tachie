// 全体設定「動画」タブの書き出しプリセット一覧と編集欄。
//
// 一覧は state.globalConfig.videoPresets (サーバが全体設定 videoExport.presets を
// ffmpeg の対応状況付きで返したもの) をその場で書き換え、全体設定の「保存」で
// videoExport.presets として送る (collectVideoPresetsForSave)。サーバ側で正規化される
// (app/global_config.py normalize_video_presets)。全体設定にまだプリセットが無いときは
// サーバが内蔵の既定値を入れて返すので、ここでは区別しない。
//
// 「既定に戻す」は state.globalConfig.defaultVideoPresets (内蔵の既定値) から取る。

import { state } from "./state.js";
import { elements } from "./elements.js";

// 既定値との比較・保存に使う項目 (available などサーバが付ける飾りは除く)。
const PRESET_FIELDS = [
  "id", "name", "description", "extension", "fps", "videoCodec", "videoArgs", "pixFmt",
  "colorSpace", "audioCodec", "audioBitrate", "containerArgs", "alpha", "alternateEncoders",
];
const PCM_CODECS = new Set(["pcm_s16le", "pcm_s24le"]);
const ALPHA_CODECS = new Set(["prores_ks", "png"]);
const MOV_ONLY_CODECS = new Set(["prores_ks", "png"]); // mp4 には入れられない

const ui = {
  editingId: null,
  // 一覧の各項目の表示要素 (id → { label, nameEl, descEl, metaEl, warnEl })。入力欄の変更では
  // 一覧を作り直さずにここだけ書き換える (作り直すと、入力欄から抜けた瞬間の change で
  // 押しかけたボタンが消えてクリックが空振りする)。
  items: new Map(),
  bound: false,
  onDefaultChange: () => {},
};

function presets() {
  const data = state.globalConfig;
  if (!data) return [];
  if (!Array.isArray(data.videoPresets)) data.videoPresets = [];
  return data.videoPresets;
}

function defaults() {
  return Array.isArray(state.globalConfig?.defaultVideoPresets) ? state.globalConfig.defaultVideoPresets : [];
}

function clonePreset(preset) {
  const out = {};
  for (const key of PRESET_FIELDS) {
    if (preset[key] !== undefined) out[key] = JSON.parse(JSON.stringify(preset[key]));
  }
  return out;
}

function comparable(preset) {
  const c = clonePreset(preset || {});
  delete c.alternateEncoders; // HW エンコーダは対応状況の飾りが付くので比較しない
  c.alpha = !!c.alpha;
  return JSON.stringify(c);
}

function defaultFor(id) {
  return defaults().find((p) => p.id === id) || null;
}

function argsText(list) {
  return (Array.isArray(list) ? list : []).join(" ");
}

function parseArgs(text) {
  return String(text || "").split(/\s+/).filter(Boolean);
}

function newPresetId() {
  const ids = new Set(presets().map((p) => p.id));
  let id = `custom_${Date.now().toString(36)}`;
  let n = 2;
  while (ids.has(id)) id = `custom_${Date.now().toString(36)}_${n++}`;
  return id;
}

function selectedId() {
  return state.globalConfig?.config?.videoExport?.defaultPresetId || "";
}

function setSelectedId(id) {
  const ve = state.globalConfig?.config?.videoExport;
  if (ve) ve.defaultPresetId = id;
}

// ---- 一覧 -------------------------------------------------------------------

function iconButton(icon, title, onClick, { disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button icon-only";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  const span = document.createElement("span");
  span.className = "msym button-icon";
  span.setAttribute("aria-hidden", "true");
  span.textContent = icon;
  button.append(span);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function badge(text, className = "") {
  const el = document.createElement("span");
  el.className = `badge ${className}`.trim();
  el.textContent = text;
  return el;
}

function buildItem(preset, total) {
  const current = selectedId();
  const unavailable = preset.available === false;
  const label = document.createElement("label");
  label.className = [
    "preset-item", "has-actions",
    preset.id === current ? "selected" : "",
    unavailable ? "disabled" : "",
    preset.id === ui.editingId ? "editing" : "",
  ].filter(Boolean).join(" ");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "videoPreset";
  radio.value = preset.id;
  radio.disabled = unavailable;
  radio.checked = preset.id === current;
  radio.addEventListener("change", () => {
    setSelectedId(preset.id);
    renderVideoPresetList();
    ui.onDefaultChange(preset.id);
  });

  const body = document.createElement("div");
  body.className = "preset-item-body";
  const nameEl = document.createElement("div");
  nameEl.className = "preset-item-name";
  const descEl = document.createElement("div");
  descEl.className = "preset-item-description";
  const metaEl = document.createElement("div");
  metaEl.className = "preset-item-meta";
  const warnEl = document.createElement("div");
  warnEl.className = "preset-item-warning";
  body.append(nameEl, descEl, metaEl, warnEl);
  ui.items.set(preset.id, { label, radio, nameEl, descEl, metaEl, warnEl });
  updateItemDisplay(preset);

  const actions = document.createElement("div");
  actions.className = "preset-item-actions";
  actions.append(
    iconButton(preset.id === ui.editingId ? "edit_off" : "edit", preset.id === ui.editingId ? "編集欄を閉じる" : "編集", () => {
      ui.editingId = ui.editingId === preset.id ? null : preset.id;
      renderVideoPresetList();
    }),
    iconButton("content_copy", "複製", () => duplicatePreset(preset)),
    iconButton("delete", total <= 1 ? "最後の 1 つは消せません" : "削除", () => deletePreset(preset), { disabled: total <= 1 }),
  );
  label.append(radio, body, actions);
  return label;
}

// 項目の表示 (名前・印・説明・形式・対応状況) だけを書き換える。
function updateItemDisplay(preset) {
  const item = ui.items.get(preset.id);
  if (!item) return;
  const unavailable = preset.available === false;
  item.label.classList.toggle("disabled", unavailable);
  item.radio.disabled = unavailable;
  item.nameEl.textContent = preset.name || preset.id;
  const base = defaultFor(preset.id);
  if (!base) item.nameEl.append(badge("追加"));
  else if (comparable(base) !== comparable(preset)) item.nameEl.append(badge("既定から変更", "modified"));
  else item.nameEl.append(badge("既定", "readonly"));
  if (unavailable) item.nameEl.append(badge("未対応"));
  item.descEl.textContent = preset.description || "";
  const audioPart = preset.audioBitrate ? `${preset.audioCodec}/${preset.audioBitrate}` : preset.audioCodec || "";
  item.metaEl.textContent = `${preset.extension || ""} · ${preset.videoCodec || ""}${preset.pixFmt ? ` · ${preset.pixFmt}` : ""} · ${preset.fps || 24}fps · ${audioPart}${preset.alpha ? " · 透過" : ""}`;
  item.warnEl.textContent = unavailable ? (preset.unavailableReason || "") : "";
  item.warnEl.hidden = !item.warnEl.textContent;
}

export function renderVideoPresetList() {
  const list = elements.globalVideoPresetList;
  if (!list || !state.globalConfig) return;
  bindEditor();
  list.innerHTML = "";
  ui.items.clear();
  const all = presets();
  for (const preset of all) list.append(buildItem(preset, all.length));
  renderEditor();
}

// ---- 追加・複製・削除・既定に戻す -------------------------------------------

function insertAfter(target, preset) {
  const all = presets();
  const index = target ? all.indexOf(target) : all.length - 1;
  all.splice(index + 1, 0, preset);
}

function duplicatePreset(preset) {
  const copy = clonePreset(preset);
  copy.id = newPresetId();
  copy.name = `${preset.name || preset.id}（コピー）`;
  insertAfter(preset, copy);
  ui.editingId = copy.id;
  renderVideoPresetList();
}

function addPreset() {
  // H.264 標準をひな形にする (無ければ一覧の先頭)。
  const template = defaults().find((p) => p.videoCodec === "libx264") || presets()[0] || {};
  const preset = clonePreset(template);
  preset.id = newPresetId();
  preset.name = "新しいプリセット";
  preset.description = "";
  insertAfter(null, preset);
  ui.editingId = preset.id;
  renderVideoPresetList();
}

function deletePreset(preset) {
  const all = presets();
  if (all.length <= 1) return;
  if (!window.confirm(`プリセット「${preset.name || preset.id}」を削除します。よろしいですか？（全体設定の「保存」を押すまでは確定しません）`)) return;
  all.splice(all.indexOf(preset), 1);
  if (selectedId() === preset.id) setSelectedId(all[0].id);
  if (ui.editingId === preset.id) ui.editingId = null;
  renderVideoPresetList();
}

function resetPreset(preset) {
  const base = defaultFor(preset.id);
  if (!base) return;
  Object.keys(preset).forEach((key) => { delete preset[key]; });
  Object.assign(preset, clonePreset(base));
  renderVideoPresetList();
}

function resetAll() {
  if (!window.confirm("プリセットの一覧を内蔵の既定値に戻します。追加したプリセットと変更は消えます。よろしいですか？（全体設定の「保存」を押すまでは確定しません）")) return;
  const data = state.globalConfig;
  data.videoPresets = defaults().map(clonePreset);
  if (!data.videoPresets.some((p) => p.id === selectedId())) setSelectedId(data.videoPresets[0]?.id || "");
  ui.editingId = null;
  renderVideoPresetList();
}

// ---- 編集欄 -----------------------------------------------------------------

function editingPreset() {
  return presets().find((p) => p.id === ui.editingId) || null;
}

function renderEditor() {
  const panel = elements.globalVideoPresetEditor;
  if (!panel) return;
  const preset = editingPreset();
  panel.hidden = !preset;
  if (!preset) return;
  const set = (el, value) => { if (el && document.activeElement !== el) el.value = value; };
  if (elements.videoPresetEditorTitle) {
    elements.videoPresetEditorTitle.textContent = `「${preset.name || preset.id}」を編集`;
  }
  set(elements.videoPresetNameInput, preset.name || "");
  set(elements.videoPresetDescriptionInput, preset.description || "");
  set(elements.videoPresetCodecSelect, preset.videoCodec || "libx264");
  set(elements.videoPresetExtensionSelect, preset.extension || ".mp4");
  set(elements.videoPresetVideoArgsInput, argsText(preset.videoArgs));
  set(elements.videoPresetPixFmtInput, preset.pixFmt || "");
  set(elements.videoPresetColorSpaceSelect, preset.colorSpace || "");
  set(elements.videoPresetFpsSelect, String(preset.fps || 24));
  set(elements.videoPresetAudioCodecSelect, preset.audioCodec || "aac");
  set(elements.videoPresetAudioBitrateSelect, preset.audioBitrate || "192k");
  set(elements.videoPresetContainerArgsInput, argsText(preset.containerArgs));
  // ProRes / PNG は .mov のみ。
  for (const opt of elements.videoPresetExtensionSelect?.options || []) {
    opt.disabled = opt.value === ".mp4" && MOV_ONLY_CODECS.has(preset.videoCodec);
  }
  // リニア PCM は .mov のみ。PCM のときはビットレートを隠す。
  const isMov = preset.extension === ".mov";
  for (const opt of elements.videoPresetAudioCodecSelect?.options || []) {
    opt.disabled = PCM_CODECS.has(opt.value) && !isMov;
  }
  if (elements.videoPresetAudioBitrateWrap) {
    elements.videoPresetAudioBitrateWrap.hidden = PCM_CODECS.has(preset.audioCodec);
  }
  if (elements.videoPresetAlphaInput) {
    const alphaOk = ALPHA_CODECS.has(preset.videoCodec);
    elements.videoPresetAlphaInput.disabled = !alphaOk;
    elements.videoPresetAlphaInput.checked = alphaOk && !!preset.alpha;
  }
  if (elements.videoPresetAlternatesText) {
    const alts = Array.isArray(preset.alternateEncoders) ? preset.alternateEncoders : [];
    elements.videoPresetAlternatesText.textContent = alts.length
      ? `ハードウェアエンコーダ（書き出しダイアログで選べます）: ${alts.map((a) => a.name || a.id).join(" / ")}`
      : "ハードウェアエンコーダ: なし（このコーデックはソフトウェアで書き出します）";
  }
  if (elements.resetVideoPresetButton) {
    const base = defaultFor(preset.id);
    elements.resetVideoPresetButton.hidden = !base;
    elements.resetVideoPresetButton.disabled = !base || comparable(base) === comparable(preset);
  }
}

// 映像コーデックを変えたら、そのコーデックの標準的な設定 (既定プリセットの最初の 1 つ) を入れる。
function applyCodecTemplate(preset, codec) {
  const template = defaults().find((p) => p.videoCodec === codec);
  preset.videoCodec = codec;
  if (!template) return;
  for (const key of ["extension", "videoArgs", "pixFmt", "colorSpace", "containerArgs", "audioCodec", "audioBitrate"]) {
    preset[key] = JSON.parse(JSON.stringify(template[key] ?? ""));
  }
  if (template.alternateEncoders) preset.alternateEncoders = JSON.parse(JSON.stringify(template.alternateEncoders));
  else delete preset.alternateEncoders;
  if (template.alpha) preset.alpha = true;
  else delete preset.alpha;
}

function updateEditing(mutator) {
  const preset = editingPreset();
  if (!preset) return;
  mutator(preset);
  // 対応状況はコーデック等で変わるので、保存して取り直すまで飾りを外す。
  delete preset.available;
  delete preset.unavailableReason;
  updateItemDisplay(preset);
  renderEditor();
}

function bindEditor() {
  if (ui.bound) return;
  ui.bound = true;
  const on = (el, event, fn) => el?.addEventListener(event, fn);
  on(elements.videoPresetNameInput, "input", () => updateEditing((p) => { p.name = elements.videoPresetNameInput.value; }));
  on(elements.videoPresetDescriptionInput, "input", () => updateEditing((p) => { p.description = elements.videoPresetDescriptionInput.value; }));
  on(elements.videoPresetCodecSelect, "change", () => updateEditing((p) => applyCodecTemplate(p, elements.videoPresetCodecSelect.value)));
  on(elements.videoPresetExtensionSelect, "change", () => updateEditing((p) => {
    p.extension = MOV_ONLY_CODECS.has(p.videoCodec) ? ".mov" : elements.videoPresetExtensionSelect.value;
    if (p.extension !== ".mov" && PCM_CODECS.has(p.audioCodec)) {
      p.audioCodec = "aac";
      p.audioBitrate = p.audioBitrate || "192k";
    }
  }));
  on(elements.videoPresetVideoArgsInput, "change", () => updateEditing((p) => { p.videoArgs = parseArgs(elements.videoPresetVideoArgsInput.value); }));
  on(elements.videoPresetPixFmtInput, "change", () => updateEditing((p) => { p.pixFmt = elements.videoPresetPixFmtInput.value.trim().toLowerCase(); }));
  on(elements.videoPresetColorSpaceSelect, "change", () => updateEditing((p) => { p.colorSpace = elements.videoPresetColorSpaceSelect.value; }));
  on(elements.videoPresetFpsSelect, "change", () => updateEditing((p) => { p.fps = Number(elements.videoPresetFpsSelect.value) || 24; }));
  on(elements.videoPresetAudioCodecSelect, "change", () => updateEditing((p) => {
    p.audioCodec = elements.videoPresetAudioCodecSelect.value;
    p.audioBitrate = PCM_CODECS.has(p.audioCodec) ? "" : (p.audioBitrate || "192k");
  }));
  on(elements.videoPresetAudioBitrateSelect, "change", () => updateEditing((p) => { p.audioBitrate = elements.videoPresetAudioBitrateSelect.value; }));
  on(elements.videoPresetContainerArgsInput, "change", () => updateEditing((p) => { p.containerArgs = parseArgs(elements.videoPresetContainerArgsInput.value); }));
  on(elements.videoPresetAlphaInput, "change", () => updateEditing((p) => {
    if (elements.videoPresetAlphaInput.checked) p.alpha = true;
    else delete p.alpha;
  }));
  on(elements.resetVideoPresetButton, "click", () => {
    const preset = editingPreset();
    if (preset) resetPreset(preset);
  });
  on(elements.closeVideoPresetEditorButton, "click", () => {
    ui.editingId = null;
    renderVideoPresetList();
  });
  on(elements.addVideoPresetButton, "click", addPreset);
  on(elements.resetAllVideoPresetsButton, "click", resetAll);
}

// ---- 公開 API --------------------------------------------------------------

// 全体設定ダイアログを開き直したとき (サーバから取り直したとき) に編集欄を閉じる。
export function resetVideoPresetEditor() {
  ui.editingId = null;
}

// 既定プリセットの選択が変わったときに呼ぶ (書き出しダイアログ側の同期など)。
export function onVideoPresetDefaultChange(fn) {
  ui.onDefaultChange = typeof fn === "function" ? fn : () => {};
}

// 全体設定の保存用。テキスト欄の入力途中 (change 前) の値も拾う。
export function collectVideoPresetsForSave() {
  const preset = editingPreset();
  if (preset) {
    if (elements.videoPresetVideoArgsInput) preset.videoArgs = parseArgs(elements.videoPresetVideoArgsInput.value);
    if (elements.videoPresetContainerArgsInput) preset.containerArgs = parseArgs(elements.videoPresetContainerArgsInput.value);
    if (elements.videoPresetPixFmtInput) preset.pixFmt = elements.videoPresetPixFmtInput.value.trim().toLowerCase();
  }
  return presets().map(clonePreset);
}
