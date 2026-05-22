// =============================================================================
// poster-typography-dialog.js
//
// Phase 4 — poster_typography テンプレ生成ダイアログ。
// 「テンプレから追加」ボタン (= elements.addPosterTemplateButton) から開く。
//
// 構成:
//   - 左列: テンプレ一覧 (kanji_kana_pair / central_emphasis / repeated_ghost / diagonal_phrase)
//   - 右列: 選択中テンプレの controls をフォーム展開 + 説明
//   - フッタ: 表示長 (秒) / 「生成」 / 「キャンセル」
//
// 生成時の流れ:
//   1. テンプレ.generate(params, {canvasW:1920, canvasH:1080}) → patches[]
//   2. telop.js:insertPosterTemplateClips({ patches, templateId, params, sourceText, durationFrame })
//   3. scenario save / history / preview 更新まで insertPosterTemplateClips 内で実行
//
// テンプレ毎の sourceText は「主要入力テキスト」を 1 つ拾う (= 再生成時に表示する代表値)。
// =============================================================================

import { state } from "./state.js";
import { elements } from "./elements.js";
import {
  insertPosterTemplateClips,
  removePosterTemplateGroup,
  buildColorSwatch,
} from "./telop.js";
import { migrateInDialogToasts, showToast } from "./toast.js";
import { secToFrames, PROJECT_FPS } from "./timecode.js";
import {
  listPosterTemplates,
  getPosterTemplate,
} from "./renderer/poster-templates/registry.js";
import "./renderer/poster-templates/index.js";  // 副作用: 各テンプレを registry に登録

// テンプレごとに「再生成用の代表テキスト」を抜き出す key を定義する。
// metadata.posterTypography.sourceText に保存し、UI で「このテンプレから生成」表示にも使う。
const SOURCE_TEXT_KEY_BY_TEMPLATE = {
  kanji_kana_pair: "mainText",
  central_emphasis: "centerText",
  repeated_ghost: "text",
  diagonal_phrase: "lines",
};

let _dialogEl = null;
let _currentTemplateId = null;
let _currentParams = {};       // 選択中テンプレの params (defaults+ユーザー編集)
let _durationSec = 3.0;
// 再生成モード: { groupId } を持つと「同 groupId の clip 群を削除 → 新規生成」
// で動く。新規追加モードでは null。
let _mode = { kind: "create" };

function _ensureDialog() {
  if (_dialogEl) return _dialogEl;

  const dialog = document.createElement("dialog");
  dialog.className = "settings-dialog poster-template-dialog";
  dialog.id = "posterTemplateDialog";
  dialog.innerHTML = `
    <form method="dialog" class="settings-panel" id="posterTemplateForm">
      <header class="settings-header">
        <div>
          <h2 data-poster-title>テンプレから追加</h2>
          <p class="settings-subtitle" data-poster-subtitle>複数の TextClip をまとめて生成します。生成後は各 clip を個別調整できます。</p>
        </div>
      </header>
      <div class="poster-template-body">
        <aside class="poster-template-list" data-poster-list></aside>
        <section class="poster-template-form">
          <div class="poster-template-description" data-poster-description></div>
          <div class="poster-template-controls" data-poster-controls></div>
        </section>
      </div>
      <footer class="settings-footer poster-template-footer">
        <label class="poster-template-duration">
          <span>表示長 (秒)</span>
          <input type="number" min="0.1" step="0.1" value="3.0" data-poster-duration />
        </label>
        <div class="settings-footer-actions">
          <button type="button" class="ghost-button" data-poster-cancel>キャンセル</button>
          <button type="button" class="primary-button" data-poster-confirm>
            <span class="msym button-icon" aria-hidden="true">style</span>
            <span>生成</span>
          </button>
        </div>
      </footer>
    </form>
  `;
  document.body.append(dialog);
  _dialogEl = dialog;

  dialog.querySelector("[data-poster-cancel]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-poster-confirm]").addEventListener("click", _confirmGenerate);
  const durInput = dialog.querySelector("[data-poster-duration]");
  durInput.addEventListener("change", () => {
    const v = Number(durInput.value);
    _durationSec = Number.isFinite(v) && v > 0 ? v : 3.0;
  });
  return dialog;
}

function _renderTemplateList() {
  const list = _dialogEl.querySelector("[data-poster-list]");
  list.innerHTML = "";
  const templates = listPosterTemplates();
  for (const tpl of templates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poster-template-item";
    btn.dataset.templateId = tpl.id;
    btn.innerHTML = `
      <strong class="poster-template-item-label">${tpl.label}</strong>
      <span class="poster-template-item-desc">${tpl.description || ""}</span>
    `;
    btn.addEventListener("click", () => _selectTemplate(tpl.id));
    if (tpl.id === _currentTemplateId) btn.classList.add("active");
    list.append(btn);
  }
}

function _selectTemplate(templateId) {
  _currentTemplateId = templateId;
  const tpl = getPosterTemplate(templateId);
  if (!tpl) return;
  _currentParams = { ...tpl.defaultParams };
  _renderTemplateList();
  _renderControls();
}

function _renderControls() {
  const descEl = _dialogEl.querySelector("[data-poster-description]");
  const controlsEl = _dialogEl.querySelector("[data-poster-controls]");
  descEl.innerHTML = "";
  controlsEl.innerHTML = "";
  if (!_currentTemplateId) return;
  const tpl = getPosterTemplate(_currentTemplateId);
  if (!tpl) return;
  if (tpl.description) {
    const p = document.createElement("p");
    p.textContent = tpl.description;
    descEl.append(p);
  }
  for (const control of tpl.controls) {
    const node = _buildControl(control);
    if (node) controlsEl.append(node);
  }
}

// text-motion.js の _buildPresetControl とほぼ同じ。dialog 内で完結させるため複製している。
function _buildControl(control) {
  const wrap = document.createElement("label");
  wrap.className = "preset-control";
  const labelText = document.createElement("span");
  labelText.className = "preset-control-label";
  labelText.textContent = control.label || control.key;
  wrap.append(labelText);
  const cur = _currentParams[control.key];
  let input;
  if (control.type === "fontFamily") {
    // 書体セレクタ: state.manifest.config.fonts から ID 一覧を引いて <select> を組む。
    // 先頭に「(デフォルト)」 = 空文字。指定なしのときは patch.style.fontFamily を
    // 入れず defaultTelop の fontFamily (= telopDefaults.fontFamily / defaultFont)
    // をそのまま継承する。
    input = document.createElement("select");
    const fonts = state.manifest?.config?.fonts || [];
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "(デフォルト)";
    input.append(noneOpt);
    for (const font of fonts) {
      const o = document.createElement("option");
      o.value = String(font.id);
      o.textContent = String(font.name || font.id);
      input.append(o);
    }
    input.value = cur != null ? String(cur) : "";
    input.addEventListener("change", () => { _currentParams[control.key] = input.value; });
  } else if (control.type === "select" && Array.isArray(control.options)) {
    input = document.createElement("select");
    for (const opt of control.options) {
      const o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = opt.label;
      input.append(o);
    }
    input.value = cur != null ? String(cur) : String(control.options[0]?.value ?? "");
    input.addEventListener("change", () => {
      const raw = input.value;
      const orig = control.options.find((o) => String(o.value) === raw);
      _currentParams[control.key] = orig ? orig.value : raw;
    });
  } else if (control.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!cur;
    input.addEventListener("change", () => { _currentParams[control.key] = input.checked; });
  } else if (control.type === "color") {
    const fallback = (typeof control.defaultValue === "string") ? control.defaultValue : "#ffffff";
    const initial = cur != null ? String(cur) : fallback;
    const swatch = buildColorSwatch(initial, fallback, (v) => { _currentParams[control.key] = v; });
    wrap.append(swatch);
    return wrap;
  } else if (control.type === "text") {
    // 改行を含むかもしれない (= lines / peripheralTexts) ので textarea にする。
    // 単一行のテキストでも textarea で問題ないが、見た目を判定するために
    // 改行が「ありそう」なキー (lines / peripheralTexts) は高めの行数にする。
    if (control.key === "lines" || control.key === "peripheralTexts") {
      input = document.createElement("textarea");
      input.rows = 4;
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.value = cur != null ? String(cur) : "";
    input.addEventListener("input", () => { _currentParams[control.key] = input.value; });
  } else {
    input = document.createElement("input");
    input.type = "number";
    if (control.min != null) input.min = String(control.min);
    if (control.max != null) input.max = String(control.max);
    if (control.step != null) input.step = String(control.step);
    input.value = cur != null ? String(cur) : "";
    input.addEventListener("change", () => {
      const n = Number(input.value);
      _currentParams[control.key] = Number.isFinite(n) ? n : 0;
    });
  }
  wrap.append(input);
  return wrap;
}

function _confirmGenerate() {
  if (!_currentTemplateId) {
    showToast("テンプレを選択してください", "error");
    return;
  }
  const tpl = getPosterTemplate(_currentTemplateId);
  if (!tpl) {
    showToast(`テンプレ "${_currentTemplateId}" が見つかりません`, "error");
    return;
  }
  let patches;
  try {
    patches = tpl.generate({ ...tpl.defaultParams, ..._currentParams }, { canvasW: 1920, canvasH: 1080 });
  } catch (err) {
    console.error(err);
    showToast(`生成に失敗: ${err?.message || err}`, "error");
    return;
  }
  if (!Array.isArray(patches) || patches.length === 0) {
    showToast("生成された TextClip が 0 件でした (テキストが空かもしれません)", "error");
    return;
  }
  const sourceText = String(_currentParams[SOURCE_TEXT_KEY_BY_TEMPLATE[_currentTemplateId]] || "");

  // 再生成モードなら、まず旧 groupId の clip 群を消す。先頭 clip の位置と表示長を
  // 再利用することで「タイムライン上で再適用しても位置が動かない」挙動にする。
  // 個別調整した clip は警告付きで丸ごと差し替えになる旨は事前トーストで明示する。
  let startFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  let durationFrame = Math.max(1, secToFrames(_durationSec));
  if (_mode?.kind === "regenerate" && _mode.groupId) {
    const removed = removePosterTemplateGroup(_mode.groupId);
    if (removed) {
      startFrame = removed.startFrame;
      durationFrame = removed.durationFrame;
    }
  }
  const created = insertPosterTemplateClips({
    patches,
    templateId: _currentTemplateId,
    params: { ...tpl.defaultParams, ..._currentParams },
    sourceText,
    durationFrame,
    startFrame,
  });
  if (created.length > 0) {
    if (_mode?.kind === "regenerate") {
      showToast(`${created.length} 件の TextClip を再生成しました`);
    } else {
      showToast(`${created.length} 件の TextClip を生成しました`);
    }
    _dialogEl.close();
  }
}

// options.mode = "regenerate" のときは options.groupId / templateId / params /
// sourceText / durationFrame をダイアログにプリロードして開く。確定時は同 groupId の
// clip 群を削除した上で新規生成する。
export function openPosterTypographyDialog(options = {}) {
  const dialog = _ensureDialog();
  const templates = listPosterTemplates();
  if (templates.length === 0) {
    showToast("登録済み poster_typography テンプレがありません", "error");
    return;
  }
  const titleEl = dialog.querySelector("[data-poster-title]");
  const subtitleEl = dialog.querySelector("[data-poster-subtitle]");
  if (options?.mode === "regenerate" && options.groupId && options.templateId) {
    _mode = { kind: "regenerate", groupId: String(options.groupId) };
    titleEl.textContent = "テンプレを再適用";
    subtitleEl.textContent =
      "同じテンプレから生成された TextClip 群を、現在のパラメータでまとめて再生成します。個別に編集した clip は上書きされます。";
    const tpl = getPosterTemplate(String(options.templateId));
    if (tpl) {
      _currentTemplateId = tpl.id;
      _currentParams = { ...tpl.defaultParams, ...(options.params || {}) };
    } else {
      _selectTemplate(templates[0].id);
    }
    if (Number.isFinite(options.durationFrame) && options.durationFrame > 0) {
      _durationSec = options.durationFrame / PROJECT_FPS;
    }
  } else {
    _mode = { kind: "create" };
    titleEl.textContent = "テンプレから追加";
    subtitleEl.textContent =
      "複数の TextClip をまとめて生成します。生成後は各 clip を個別調整できます。";
    if (!_currentTemplateId || !getPosterTemplate(_currentTemplateId)) {
      _selectTemplate(templates[0].id);
    }
  }
  _renderTemplateList();
  _renderControls();
  // 表示長入力を最新の _durationSec に同期する (= 直前の生成からの維持)
  const durInput = dialog.querySelector("[data-poster-duration]");
  durInput.value = String(_durationSec);
  // 確定ボタンのラベルもモードに応じて変更
  const confirmBtn = dialog.querySelector("[data-poster-confirm]");
  const confirmLabel = confirmBtn.querySelector("span:last-child");
  if (confirmLabel) {
    confirmLabel.textContent = _mode.kind === "regenerate" ? "再生成" : "生成";
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  migrateInDialogToasts(dialog);
}
