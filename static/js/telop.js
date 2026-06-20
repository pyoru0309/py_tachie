import { state } from "./state.js";
import { elements } from "./elements.js";
import {
  normalizeColorValue,
  generateTelopId,
  buttonMarkup,
  fillSelect,
} from "./utils.js";
import {
  formatTimecode,
  secToFrames,
  bindTimecodeInput,
  PROJECT_FPS,
} from "./timecode.js";
import {
  cutStartFrame,
  cutDurationFrame,
  telopStartFrame,
  telopDurationFrame,
} from "./scenario.js";
import { migrateInDialogToasts, showToast } from "./toast.js";
import { recordHistory } from "./history.js";
import {
  FONT_WEIGHT_CSS,
  fontDisplayName,
  globalWeightLabel,
  weightItemsForFamily,
} from "./font.js";
import { renderTelopTrack, findTelopById } from "./timeline.js";
import { drawTextClipsOnCanvas } from "./renderer/text-clip-draw.js";
import { appendTextMotionSections } from "./text-motion.js";

// per-telop オプティカルカーニング: style の enableOpticalKerning(null=継承) +
// opticalKerningHighQuality を 4 値モードに橋渡しする。全体設定 (telopDefaults) の
// 3 値 (off/standard/high) に「継承」を足したもの。
const TELOP_OPTICAL_KERNING_LABELS = {
  inherit: "継承（全体設定）",
  off: "OFF",
  standard: "標準",
  high: "高品質",
};
function telopOpticalKerningMode(style) {
  const en = style?.enableOpticalKerning;
  if (en == null) return "inherit";
  return en ? (style.opticalKerningHighQuality ? "high" : "standard") : "off";
}

let deps = {
  activeScene: () => null,
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  loadCut: async () => {},
  applyEditorTargetView: () => {},
  applyTelopDefaultsToAllTelops: async () => {},
  promptBulkApply: async () => ({ confirmed: false, selectedKeys: new Set() }),
};

export function bindTelop(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
}

export const TELOP_GLOW_DEFAULT = { enabled: false, color: "#ffffff", blurPx: 12, opacity: 0.8, intensity: 1 };
export const TELOP_DROP_SHADOW_DEFAULT = { enabled: false, color: "#000000", blurPx: 6, offsetX: 4, offsetY: 4, opacity: 0.7, intensity: 1 };

// TextClip 拡張キーの client 側の既定値。サーバ _normalize_telop の補完値と一致させる。
// caption は effectPreset=null、animation/in/out/body=null、occlusion.mode="none"。
export function defaultTextClipAnimation() {
  return {
    in: { preset: null, params: {} },
    out: { preset: null, params: {} },
    body: { preset: null, params: {} },
  };
}

export function defaultTextClipOcclusion() {
  return {
    mode: "none",
    target: "characters",
    targetCharacterIds: [],
    partMode: "all",
    targetPartIds: [],
  };
}

export function defaultTelop() {
  // 再生ヘッド位置を基準に追加。タイムラインを編集中の意図に沿わせる。
  const cursorFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const td = state.manifest?.config?.telopDefaults || {};
  const fallbackFamily = state.manifest?.config?.defaultFont || "";
  const familyId = td.fontFamily || fallbackFamily;
  const weights = weightItemsForFamily(familyId);
  const preferredWeight =
    td.fontWeight || state.manifest?.config?.defaultFontWeight || "regular";
  const fontWeight = weights.some((w) => w.id === preferredWeight)
    ? preferredWeight
    : (weights[0]?.id || "regular");
  const glow = { ...TELOP_GLOW_DEFAULT, ...(td.glow || {}) };
  const dropShadow = { ...TELOP_DROP_SHADOW_DEFAULT, ...(td.dropShadow || {}) };
  return {
    id: generateTelopId(),
    kind: "caption",
    startFrame: cursorFrame,
    durationFrame: PROJECT_FPS * 2,
    text: "",
    position: "bottom",
    x: null,
    y: null,
    style: {
      fontSize: Number(td.fontSize ?? 48),
      fontFamily: familyId,
      fontWeight,
      color: td.color || "#ffffff",
      outlineColor: td.outlineColor || "#000000",
      outlineWidth: Number(td.outlineWidth ?? 4),
      align: "center",
      letterSpacing: Number(td.letterSpacing ?? 0),
      lineSpacing: Number(td.lineSpacing ?? 0),
      glow,
      dropShadow,
    },
    renderLayer: "overlay",
    effectPreset: null,
    effectParams: {},
    animation: defaultTextClipAnimation(),
    occlusion: defaultTextClipOcclusion(),
  };
}

// 色入力 UI: ネイティブ <input type="color"> + HEX テキスト並置 (.color-control / .color-value)。
// 「初期実装で <input type="color"> だけ置きがち」だが、それは見た目が分かりにくいので
// 必ず本関数を経由すること (= feedback_color_input_use_swatch)。
// HEX 文字列 (先頭 # 省略可 / 3 桁 or 6 桁) を検証して #rrggbb に正規化する。
// 不正なら null。入力途中の live プレビュー判定にも使う。
function _parseHexInput(raw, fallback) {
  let t = String(raw || "").trim();
  if (t && t[0] !== "#") t = `#${t}`;
  if (/^#[0-9a-f]{3}$/i.test(t) || /^#[0-9a-f]{6}$/i.test(t)) {
    return normalizeColorValue(t, fallback);
  }
  return null;
}

export function buildColorSwatch(initialValue, fallback, onChange) {
  const wrap = document.createElement("span");
  wrap.className = "color-control";
  const input = document.createElement("input");
  input.type = "color";
  // HEX 値は編集可能なテキスト入力にする (= ネイティブのカラーパレットを開かずに
  // #rrggbb を直接打ち替えられる)。スウォッチ (input[type=color]) は従来通り
  // クリックで OS パレットが開く。
  const value = document.createElement("input");
  value.type = "text";
  value.className = "color-value";
  value.spellcheck = false;
  value.maxLength = 7;
  value.setAttribute("aria-label", "色 (HEX)");
  let current = normalizeColorValue(initialValue, fallback);
  const applyChip = (v) => {
    input.value = v;
    value.style.setProperty("--color-value", v);
  };
  input.value = current;
  value.value = current;
  applyChip(current);

  // ネイティブパレット (input[type=color]) からの変更。
  const fromPicker = () => {
    current = normalizeColorValue(input.value, fallback);
    value.value = current;
    applyChip(current);
    onChange(current);
  };
  input.addEventListener("input", fromPicker);
  input.addEventListener("change", fromPicker);

  // HEX テキスト直接編集: 入力中 (input) は live プレビューのみ、
  // 確定 (change = blur / Enter) で commit。不正値は直前の有効値へ戻す。
  value.addEventListener("input", () => {
    const v = _parseHexInput(value.value, fallback);
    if (v) applyChip(v);
  });
  value.addEventListener("change", () => {
    const v = _parseHexInput(value.value, fallback) || current;
    current = v;
    value.value = v;
    applyChip(v);
    onChange(v);
  });
  wrap.append(input, value);
  return wrap;
}

function buildTelopGlowSection(telop, editTelopStyle) {
  const cur = { ...TELOP_GLOW_DEFAULT, ...(telop.style?.glow || {}) };
  const details = document.createElement("div");
  details.className = "telop-style-section character-effect-block";
  const summary = document.createElement("h3");
  summary.className = "telop-style-section-title";
  summary.textContent = "光彩";
  details.append(summary);

  const updateGlow = (patch) => {
    editTelopStyle((style) => {
      style.glow = { ...TELOP_GLOW_DEFAULT, ...(style.glow || {}), ...patch };
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  };

  const rowEnable = document.createElement("label");
  rowEnable.className = "checkbox-row";
  const enableInput = document.createElement("input");
  enableInput.type = "checkbox";
  enableInput.checked = !!cur.enabled;
  rowEnable.append(enableInput, document.createTextNode(" 光彩を有効にする"));
  enableInput.addEventListener("change", () => updateGlow({ enabled: enableInput.checked }));
  details.append(rowEnable);

  const row1 = document.createElement("div");
  row1.className = "inline-fields";
  const colorLabel = document.createElement("label");
  colorLabel.append("光彩色");
  colorLabel.append(buildColorSwatch(cur.color, "#ffffff", (v) => updateGlow({ color: v })));
  row1.append(colorLabel);

  const blurInput = document.createElement("input");
  blurInput.type = "number";
  blurInput.min = "0";
  blurInput.max = "200";
  blurInput.step = "1";
  blurInput.value = Number(cur.blurPx);
  const blurLabel = document.createElement("label");
  blurLabel.append("ぼかし(px)", blurInput);
  blurInput.addEventListener("change", () => {
    updateGlow({ blurPx: Math.max(0, Number(blurInput.value) || 0) });
  });
  row1.append(blurLabel);

  const opInput = document.createElement("input");
  opInput.type = "number";
  opInput.min = "0";
  opInput.max = "1";
  opInput.step = "0.05";
  opInput.value = Number(cur.opacity);
  const opLabel = document.createElement("label");
  opLabel.append("不透明度", opInput);
  opInput.addEventListener("change", () => {
    const v = Math.max(0, Math.min(1, Number(opInput.value) || 0));
    opInput.value = v;
    updateGlow({ opacity: v });
  });
  row1.append(opLabel);

  // 強さ: ぼかしを大きくして薄くなった光彩を濃くする (スタック合成回数)。
  const intensityInput = document.createElement("input");
  intensityInput.type = "number";
  intensityInput.min = "1";
  intensityInput.max = "8";
  intensityInput.step = "0.5";
  intensityInput.value = Number(cur.intensity ?? 1);
  const intensityLabel = document.createElement("label");
  intensityLabel.append("強さ", intensityInput);
  intensityInput.addEventListener("change", () => {
    const v = Math.max(1, Math.min(8, Number(intensityInput.value) || 1));
    intensityInput.value = v;
    updateGlow({ intensity: v });
  });
  row1.append(intensityLabel);
  details.append(row1);

  return details;
}

function buildTelopDropShadowSection(telop, editTelopStyle) {
  const cur = { ...TELOP_DROP_SHADOW_DEFAULT, ...(telop.style?.dropShadow || {}) };
  const details = document.createElement("div");
  details.className = "telop-style-section character-effect-block";
  const summary = document.createElement("h3");
  summary.className = "telop-style-section-title";
  summary.textContent = "ドロップシャドウ";
  details.append(summary);

  const update = (patch) => {
    editTelopStyle((style) => {
      style.dropShadow = { ...TELOP_DROP_SHADOW_DEFAULT, ...(style.dropShadow || {}), ...patch };
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  };

  const rowEnable = document.createElement("label");
  rowEnable.className = "checkbox-row";
  const enableInput = document.createElement("input");
  enableInput.type = "checkbox";
  enableInput.checked = !!cur.enabled;
  rowEnable.append(enableInput, document.createTextNode(" ドロップシャドウを有効にする"));
  enableInput.addEventListener("change", () => update({ enabled: enableInput.checked }));
  details.append(rowEnable);

  const row1 = document.createElement("div");
  row1.className = "inline-fields";
  const colorLabel = document.createElement("label");
  colorLabel.append("影色");
  colorLabel.append(buildColorSwatch(cur.color, "#000000", (v) => update({ color: v })));
  row1.append(colorLabel);

  const blurInput = document.createElement("input");
  blurInput.type = "number";
  blurInput.min = "0";
  blurInput.max = "200";
  blurInput.step = "1";
  blurInput.value = Number(cur.blurPx);
  const blurLabel = document.createElement("label");
  blurLabel.append("ぼかし(px)", blurInput);
  blurInput.addEventListener("change", () => {
    update({ blurPx: Math.max(0, Number(blurInput.value) || 0) });
  });
  row1.append(blurLabel);

  const opInput = document.createElement("input");
  opInput.type = "number";
  opInput.min = "0";
  opInput.max = "1";
  opInput.step = "0.05";
  opInput.value = Number(cur.opacity);
  const opLabel = document.createElement("label");
  opLabel.append("不透明度", opInput);
  opInput.addEventListener("change", () => {
    const v = Math.max(0, Math.min(1, Number(opInput.value) || 0));
    opInput.value = v;
    update({ opacity: v });
  });
  row1.append(opLabel);

  // 強さ: ぼかしを大きくして薄くなった影を濃くする (スタック合成回数)。
  const intensityInput = document.createElement("input");
  intensityInput.type = "number";
  intensityInput.min = "1";
  intensityInput.max = "8";
  intensityInput.step = "0.5";
  intensityInput.value = Number(cur.intensity ?? 1);
  const intensityLabel = document.createElement("label");
  intensityLabel.append("強さ", intensityInput);
  intensityInput.addEventListener("change", () => {
    const v = Math.max(1, Math.min(8, Number(intensityInput.value) || 1));
    intensityInput.value = v;
    update({ intensity: v });
  });
  row1.append(intensityLabel);
  details.append(row1);

  const row2 = document.createElement("div");
  row2.className = "inline-fields";
  const oxInput = document.createElement("input");
  oxInput.type = "number";
  oxInput.step = "1";
  oxInput.value = Number(cur.offsetX);
  const oxLabel = document.createElement("label");
  oxLabel.append("X方向", oxInput);
  oxInput.addEventListener("change", () => {
    update({ offsetX: Number(oxInput.value) || 0 });
  });
  row2.append(oxLabel);

  const oyInput = document.createElement("input");
  oyInput.type = "number";
  oyInput.step = "1";
  oyInput.value = Number(cur.offsetY);
  const oyLabel = document.createElement("label");
  oyLabel.append("Y方向", oyInput);
  oyInput.addEventListener("change", () => {
    update({ offsetY: Number(oyInput.value) || 0 });
  });
  row2.append(oyLabel);
  details.append(row2);

  return details;
}

// 一括反映ダイアログ用のサマリ表示ヘルパ (Phase 3)。長過ぎる JSON はチェックボックス行で
// 読み辛いため、要点だけを 1 行で出す。
function _summarizeAnimation(animation) {
  if (!animation || typeof animation !== "object") return "なし";
  const parts = [];
  for (const slotKey of ["in", "out", "body"]) {
    const slot = animation[slotKey];
    if (slot?.preset) parts.push(`${slotKey}=${slot.preset}`);
  }
  return parts.length > 0 ? parts.join(", ") : "なし";
}

function _summarizeEffectParams(params) {
  if (!params || typeof params !== "object") return "—";
  const keys = Object.keys(params);
  if (keys.length === 0) return "—";
  return `${keys.length} 項目`;
}

export function renderTelopEditor() {
  if (!elements.telopEditorPanel) return;
  const scene = deps.activeScene();
  const telops = Array.isArray(scene?.telops) ? scene.telops : [];
  const telopId = state.selectedTelopId;
  const telop = telops.find((t) => t && t.id === telopId) || null;

  elements.telopEditorPanel.innerHTML = "";
  if (!telop) {
    if (elements.telopEditorEmpty) elements.telopEditorEmpty.hidden = false;
    return;
  }
  if (elements.telopEditorEmpty) elements.telopEditorEmpty.hidden = true;

  // saveScenario が state.scenario を置き換えるため、handler 側では
  // 毎回 telopId で活きたオブジェクトを引き直す。
  const currentTelop = () => {
    const live = deps.activeScene();
    if (!Array.isArray(live?.telops)) return null;
    return live.telops.find((item) => item && item.id === telopId) || null;
  };
  const editTelop = (fn) => {
    const t = currentTelop();
    if (!t) return null;
    fn(t);
    return t;
  };
  const editTelopStyle = (fn) => editTelop((t) => {
    t.style = t.style || {};
    fn(t.style, t);
  });

  const card = document.createElement("div");
  card.className = "telop-card";

  const header = document.createElement("div");
  header.className = "telop-card-header";
  const title = document.createElement("strong");
  const refreshTitle = () => {
    const live = currentTelop();
    if (!live) return;
    const ord = (deps.activeScene()?.telops || []).findIndex((t) => t && t.id === telopId);
    title.textContent = `#${(ord >= 0 ? ord : 0) + 1}  ${formatTimecode(telopStartFrame(live))} (${formatTimecode(telopDurationFrame(live))})`;
  };
  refreshTitle();
  header.append(title);

  const applyAllButton = document.createElement("button");
  applyAllButton.type = "button";
  applyAllButton.className = "compact-action-button";
  applyAllButton.innerHTML = buttonMarkup("done_all", "全テロップに反映");
  applyAllButton.title = "このテロップのスタイル（書体・色・アウトライン・光彩・ドロップシャドウ）を、シーン内のすべてのテロップに反映します";
  applyAllButton.addEventListener("click", async (event) => {
    event.preventDefault();
    const sourceTelop = findTelopById(telopId);
    if (!sourceTelop) return;
    const style = sourceTelop.style || {};
    const sourceKind = String(sourceTelop.kind || "caption");
    const fullDiff = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      color: style.color,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      letterSpacing: style.letterSpacing ?? 0,
      lineSpacing: style.lineSpacing ?? 0,
      // 仮想キー: "inherit" or { enable, highQuality }。dialog.js が両 style キーへ展開。
      opticalKerning: (style.enableOpticalKerning == null)
        ? "inherit"
        : { enable: !!style.enableOpticalKerning, highQuality: !!style.opticalKerningHighQuality },
      glow: { ...TELOP_GLOW_DEFAULT, ...(style.glow || {}) },
      dropShadow: { ...TELOP_DROP_SHADOW_DEFAULT, ...(style.dropShadow || {}) },
      // ★ Phase 3 で追加: TextClip 拡張キーも反映対象に。これらは telop の top-level 値
      //   なので、dialog.js 側で TELOP_TOP_LEVEL_KEYS を見て style ではなく直下に書く。
      renderLayer: sourceTelop.renderLayer || "overlay",
      animation: JSON.parse(JSON.stringify(sourceTelop.animation || {})),
      // 表示位置・座標も反映対象 (= 「他のテロップにも同じ位置」が成立する)。
      position: sourceTelop.position || "bottom",
      x: sourceTelop.x ?? null,
      y: sourceTelop.y ?? null,
    };
    // effect 系は kind=mv_text のときのみ意味があるので、ソースが mv_text のときだけ
    // items に出す (= caption ソースから effect だけ反映するケースは無いはず)。
    if (sourceKind === "mv_text") {
      fullDiff.effectPreset = sourceTelop.effectPreset || null;
      fullDiff.effectParams = JSON.parse(JSON.stringify(sourceTelop.effectParams || {}));
    }
    const scene = deps.activeScene();
    // 反映候補 = 同じ kind かつ自分以外
    const candidateCount = (scene?.telops || []).filter(
      (t) => t && t.id !== telopId && String(t.kind || "caption") === sourceKind,
    ).length;
    if (candidateCount === 0) {
      showToast(`他の${sourceKind === "mv_text" ? "MV 文字" : "通常テロップ"}はありません`);
      return;
    }
    const items = [
      { key: "fontFamily", label: "書体", valueText: fontDisplayName(fullDiff.fontFamily) },
      { key: "fontWeight", label: "太さ", valueText: globalWeightLabel(fullDiff.fontWeight) },
      { key: "fontSize", label: "文字サイズ", valueText: `${fullDiff.fontSize}px` },
      { key: "color", label: "文字色", valueText: fullDiff.color },
      { key: "outlineWidth", label: "アウトライン", valueText: `${fullDiff.outlineWidth}px` },
      { key: "outlineColor", label: "アウトライン色", valueText: fullDiff.outlineColor },
      { key: "letterSpacing", label: "文字間", valueText: `${fullDiff.letterSpacing} (1/1000em)` },
      { key: "lineSpacing", label: "行間", valueText: `${fullDiff.lineSpacing}px` },
      {
        key: "opticalKerning",
        label: "オプティカルカーニング",
        valueText: TELOP_OPTICAL_KERNING_LABELS[
          fullDiff.opticalKerning === "inherit"
            ? "inherit"
            : (fullDiff.opticalKerning.enable ? (fullDiff.opticalKerning.highQuality ? "high" : "standard") : "off")
        ],
      },
      { key: "glow", label: "光彩", valueText: fullDiff.glow.enabled ? "ON" : "OFF" },
      { key: "dropShadow", label: "ドロップシャドウ", valueText: fullDiff.dropShadow.enabled ? "ON" : "OFF" },
      { key: "renderLayer", label: "描画レイヤー", valueText: fullDiff.renderLayer },
      {
        key: "animation",
        label: "アニメーション",
        valueText: _summarizeAnimation(fullDiff.animation),
      },
      {
        key: "position",
        label: "表示位置",
        valueText: fullDiff.position === "custom"
          ? `座標指定 (${fullDiff.x ?? "?"}, ${fullDiff.y ?? "?"})`
          : (fullDiff.position === "top" ? "上"
            : fullDiff.position === "center" ? "中央"
            : fullDiff.position === "bottom" ? "下" : fullDiff.position),
      },
    ];
    // position=custom のときだけ x/y を個別反映項目として出す (それ以外は無効値)。
    if (fullDiff.position === "custom") {
      items.push({ key: "x", label: "X 座標", valueText: String(fullDiff.x ?? "(未指定)") });
      items.push({ key: "y", label: "Y 座標", valueText: String(fullDiff.y ?? "(未指定)") });
    }
    if (sourceKind === "mv_text") {
      items.push({
        key: "effectPreset",
        label: "視覚エフェクト",
        valueText: fullDiff.effectPreset || "なし",
      });
      items.push({
        key: "effectParams",
        label: "エフェクトパラメータ",
        valueText: _summarizeEffectParams(fullDiff.effectParams),
      });
    }
    const targetLabel = sourceKind === "mv_text" ? "MV 文字" : "通常テロップ";
    const result = await deps.promptBulkApply({
      title: "テロップに一括反映",
      description: `このテロップの設定を、シーン内 他の ${candidateCount} 件の ${targetLabel} に反映します。チェックを入れた項目だけが反映されます。`,
      items,
    });
    if (!result.confirmed || result.selectedKeys.size === 0) return;
    const filteredDiff = { __sourceKind: sourceKind };
    for (const k of result.selectedKeys) filteredDiff[k] = fullDiff[k];
    try {
      await deps.applyTelopDefaultsToAllTelops(filteredDiff);
    } catch (error) {
      console.error(error);
      showToast("テロップへの反映に失敗しました", "error");
    }
  });
  header.append(applyAllButton);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "compact-action-button";
  removeButton.innerHTML = buttonMarkup("delete", "削除");
  removeButton.addEventListener("click", (event) => {
    event.preventDefault();
    const live = deps.activeScene();
    if (Array.isArray(live?.telops)) {
      const removeIndex = live.telops.findIndex((item) => item && item.id === telopId);
      if (removeIndex >= 0) live.telops.splice(removeIndex, 1);
    }
    clearTelopSelection();
    deps.scheduleScenarioSave();
    recordHistory();
    deps.renderPreview();
  });
  header.append(removeButton);
  card.append(header);

  const body = document.createElement("div");
  body.className = "telop-card-body";

  const textArea = document.createElement("textarea");
  textArea.rows = 4;
  textArea.value = telop.text || "";
  textArea.placeholder = "テロップ本文";
  textArea.addEventListener("input", () => {
    editTelop((t) => { t.text = textArea.value; });
    deps.scheduleScenarioSave();
    deps.renderPreview();
    renderTelopTrack();
  });
  body.append(textArea);

  const row1 = document.createElement("div");
  row1.className = "inline-fields";
  const startInput = document.createElement("input");
  const startLabel = document.createElement("label");
  startLabel.append("開始", startInput);
  bindTimecodeInput(startInput, {
    minFrames: 0,
    getFrames: () => telopStartFrame(currentTelop()),
    setFrames: (frames) => {
      editTelop((t) => { t.startFrame = frames; });
      refreshTitle();
      deps.scheduleScenarioSave();
      recordHistory();
      deps.renderPreview();
      renderTelopTrack();
    },
  });
  row1.append(startLabel);

  const durInput = document.createElement("input");
  const durLabel = document.createElement("label");
  durLabel.append("表示時間", durInput);
  bindTimecodeInput(durInput, {
    minFrames: 1,
    getFrames: () => telopDurationFrame(currentTelop()),
    setFrames: (frames) => {
      editTelop((t) => { t.durationFrame = Math.max(1, frames); });
      refreshTitle();
      deps.scheduleScenarioSave();
      recordHistory();
      deps.renderPreview();
      renderTelopTrack();
    },
  });
  row1.append(durLabel);

  const positionSelect = document.createElement("select");
  for (const value of ["top", "center", "bottom", "custom"]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value === "top" ? "上"
      : value === "center" ? "中央"
      : value === "bottom" ? "下"
      : "座標指定";
    positionSelect.append(opt);
  }
  positionSelect.value = telop.position || "bottom";
  const posLabel = document.createElement("label");
  posLabel.append("位置", positionSelect);
  positionSelect.addEventListener("change", () => {
    editTelop((t) => { t.position = positionSelect.value; });
    deps.scheduleScenarioSave();
    recordHistory();
    deps.renderPreview();
    renderTelopEditor();
  });
  row1.append(posLabel);
  body.append(row1);

  // 「座標指定」のときの X / Y 入力欄。位置の段のすぐ下に置くことで関連性を視覚的に伝える。
  if (positionSelect.value === "custom") {
    const rowXY = document.createElement("div");
    rowXY.className = "inline-fields";
    const xInput = document.createElement("input");
    xInput.type = "number";
    xInput.value = telop.x ?? "";
    xInput.placeholder = "未指定なら中央";
    const xLabel = document.createElement("label");
    xLabel.append("X座標", xInput);
    xInput.addEventListener("change", () => {
      editTelop((t) => {
        t.x = xInput.value === "" ? null : Number(xInput.value) || 0;
      });
      deps.scheduleScenarioSave();
      deps.renderPreview();
    });
    rowXY.append(xLabel);

    const yInput = document.createElement("input");
    yInput.type = "number";
    yInput.value = telop.y ?? "";
    yInput.placeholder = "未指定なら下端";
    const yLabel = document.createElement("label");
    yLabel.append("Y座標", yInput);
    yInput.addEventListener("change", () => {
      editTelop((t) => {
        t.y = yInput.value === "" ? null : Number(yInput.value) || 0;
      });
      deps.scheduleScenarioSave();
      deps.renderPreview();
    });
    rowXY.append(yLabel);
    body.append(rowXY);
  }

  // 書体・太さ・文字サイズ
  const rowFont = document.createElement("div");
  rowFont.className = "inline-fields";
  const fonts = state.manifest?.config?.fonts || [];
  const defaultFamily = state.manifest?.config?.defaultFont || fonts[0]?.id || "";
  const familyId = telop.style?.fontFamily || defaultFamily;
  const familySelect = document.createElement("select");
  fillSelect(familySelect, fonts, false, true);
  familySelect.value = fonts.some((f) => f.id === familyId) ? familyId : (fonts[0]?.id || "");
  const familyLabel = document.createElement("label");
  familyLabel.append("書体", familySelect);
  rowFont.append(familyLabel);

  const weightSelect = document.createElement("select");
  const fillWeightOptions = (preferred) => {
    const items = weightItemsForFamily(familySelect.value);
    fillSelect(weightSelect, items, false, true);
    const fallback = items[0]?.id || "regular";
    weightSelect.value = items.some((w) => w.id === preferred) ? preferred : fallback;
  };
  fillWeightOptions(telop.style?.fontWeight || state.manifest?.config?.defaultFontWeight || "regular");
  const weightLabel = document.createElement("label");
  weightLabel.append("太さ", weightSelect);
  rowFont.append(weightLabel);

  familySelect.addEventListener("change", () => {
    fillWeightOptions(weightSelect.value);
    editTelopStyle((style) => {
      style.fontFamily = familySelect.value;
      style.fontWeight = weightSelect.value;
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  weightSelect.addEventListener("change", () => {
    editTelopStyle((style) => { style.fontWeight = weightSelect.value; });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });

  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.min = "12";
  sizeInput.max = "200";
  sizeInput.step = "2";
  sizeInput.value = Number(telop.style?.fontSize || 48);
  const sizeLabel = document.createElement("label");
  sizeLabel.append("文字サイズ", sizeInput);
  sizeInput.addEventListener("change", () => {
    editTelopStyle((style) => {
      style.fontSize = Math.max(12, Number(sizeInput.value) || 48);
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  rowFont.append(sizeLabel);
  body.append(rowFont);

  // 文字色 / アウトライン / アウトライン色（設定ダイアログと同じ color-swatch + HEX）
  const rowColor = document.createElement("div");
  rowColor.className = "inline-fields";

  const colorLabel = document.createElement("label");
  colorLabel.append("文字色");
  colorLabel.append(buildColorSwatch(telop.style?.color, "#ffffff", (v) => {
    editTelopStyle((style) => { style.color = v; });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  }));
  rowColor.append(colorLabel);

  const outlineWidthInput = document.createElement("input");
  outlineWidthInput.type = "number";
  outlineWidthInput.min = "0";
  outlineWidthInput.max = "20";
  outlineWidthInput.step = "1";
  outlineWidthInput.value = Number(telop.style?.outlineWidth ?? 4);
  const outlineWidthLabel = document.createElement("label");
  outlineWidthLabel.append("アウトライン", outlineWidthInput);
  outlineWidthInput.addEventListener("change", () => {
    editTelopStyle((style) => {
      style.outlineWidth = Math.max(0, Number(outlineWidthInput.value) || 0);
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  rowColor.append(outlineWidthLabel);

  const outlineColorLabel = document.createElement("label");
  outlineColorLabel.append("アウトライン色");
  outlineColorLabel.append(buildColorSwatch(telop.style?.outlineColor, "#000000", (v) => {
    editTelopStyle((style) => { style.outlineColor = v; });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  }));
  rowColor.append(outlineColorLabel);
  body.append(rowColor);

  // 文字揃え / 文字間 / 行間 (3 列)
  const rowSpacing = document.createElement("div");
  rowSpacing.className = "inline-fields";

  const alignSelect = document.createElement("select");
  for (const [value, label] of [["left", "左揃え"], ["center", "中央"], ["right", "右揃え"]]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    alignSelect.append(opt);
  }
  const initialAlign = String(telop.style?.align || "center").toLowerCase();
  alignSelect.value = ["left", "center", "right"].includes(initialAlign) ? initialAlign : "center";
  const alignLabel = document.createElement("label");
  alignLabel.append("文字揃え", alignSelect);
  alignSelect.addEventListener("change", () => {
    editTelopStyle((style) => {
      const v = alignSelect.value;
      style.align = ["left", "center", "right"].includes(v) ? v : "center";
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  rowSpacing.append(alignLabel);

  const lsInput = document.createElement("input");
  lsInput.type = "number";
  lsInput.min = "-500";
  lsInput.max = "1000";
  lsInput.step = "100";
  lsInput.value = Number(telop.style?.letterSpacing ?? 0);
  const lsLabel = document.createElement("label");
  lsLabel.append("文字間 (1/1000em)", lsInput);
  lsInput.addEventListener("change", () => {
    editTelopStyle((style) => {
      // 1/1000 em 単位。100 単位刻み (= 0.1em ずつ) でスナップ。
      style.letterSpacing = Math.max(-500, Math.min(1000, Math.round((Number(lsInput.value) || 0) / 100) * 100));
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  rowSpacing.append(lsLabel);

  const spInput = document.createElement("input");
  spInput.type = "number";
  spInput.min = "-500";
  spInput.max = "500";
  spInput.step = "1";
  spInput.value = Number(telop.style?.lineSpacing ?? 0);
  const spLabel = document.createElement("label");
  spLabel.append("行間 (px)", spInput);
  spInput.addEventListener("change", () => {
    editTelopStyle((style) => {
      style.lineSpacing = Math.max(-500, Math.min(500, Number(spInput.value) || 0));
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  rowSpacing.append(spLabel);

  // オプティカルカーニング (per-telop override)。「継承」= style にキーを持たず
  // 全体設定 (telopDefaults) に従う。明示すると style.enableOpticalKerning /
  // opticalKerningHighQuality を書き、caption / MV / アニメの全描画経路で確実に反映される。
  const kernSelect = document.createElement("select");
  for (const [value, label] of Object.entries(TELOP_OPTICAL_KERNING_LABELS)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    kernSelect.append(opt);
  }
  kernSelect.value = telopOpticalKerningMode(telop.style);
  const kernLabel = document.createElement("label");
  kernLabel.append("カーニング", kernSelect);
  kernSelect.addEventListener("change", () => {
    editTelopStyle((style) => {
      const v = kernSelect.value;
      if (v === "inherit") {
        delete style.enableOpticalKerning;
        delete style.opticalKerningHighQuality;
      } else {
        style.enableOpticalKerning = (v !== "off");
        style.opticalKerningHighQuality = (v === "high");
      }
    });
    deps.scheduleScenarioSave();
    deps.renderPreview();
  });
  rowSpacing.append(kernLabel);
  body.append(rowSpacing);

  body.append(buildTelopGlowSection(telop, editTelopStyle));
  body.append(buildTelopDropShadowSection(telop, editTelopStyle));

  // ★ TextClip 拡張 (Phase 1+): アニメーション / エフェクト / レイヤーと
  //   kind 切替ボタン。fade_slide や typewriter は kind=caption でも有効。
  appendTextMotionSections(body, telop, {
    currentTelop,
    editTelop,
    scheduleScenarioSave: deps.scheduleScenarioSave,
    recordHistory,
    renderPreview: deps.renderPreview,
    renderTelopEditor,
  });

  card.append(body);
  elements.telopEditorPanel.append(card);
}

export function selectTelop(telopId, options = {}) {
  const scene = deps.activeScene();
  const telop = (scene?.telops || []).find((t) => t && t.id === telopId);
  if (!telop) return;
  state.editorTarget = "telop";
  state.selectedTelopId = telop.id;
  if (options.preserveMultiSelection) {
    if (!state.selectedTelopIds) state.selectedTelopIds = new Set();
    state.selectedTelopIds.add(telop.id);
  } else {
    state.selectedTelopIds = new Set([telop.id]);
  }
  // 選択時に playhead 自動移動はしない (= 編集中の再生位置を保つ)。
  // テロップ開始位置を含むカットへの切替だけは行い、編集パネルのカット文脈が
  // ずれないようにする。
  const startFrame = telopStartFrame(telop);
  const cuts = state.scenario?.cuts || [];
  const targetCut = cuts.find((c) => {
    const cs = cutStartFrame(c);
    const cd = cutDurationFrame(c);
    return cs <= startFrame && startFrame < cs + cd;
  });
  if (targetCut && targetCut.id !== state.selectedCutId) {
    deps.loadCut(targetCut, { keepTelopSelection: true })
      .then(() => {
        deps.applyEditorTargetView();
        renderTelopEditor();
        renderTelopTrack();
      })
      .catch((error) => console.warn("loadCut on telop select failed", error));
    return;
  }
  deps.applyEditorTargetView();
  renderTelopEditor();
  renderTelopTrack();
  deps.renderPreview().catch((error) => console.warn("renderPreview on telop select failed", error));
}

export function clearTelopSelection({ render = true } = {}) {
  const hadMulti = state.selectedTelopIds && state.selectedTelopIds.size > 0;
  if (state.editorTarget === "cut" && state.selectedTelopId == null && !hadMulti) return;
  state.editorTarget = "cut";
  state.selectedTelopId = null;
  state.selectedTelopIds = new Set();
  deps.applyEditorTargetView();
  if (render) renderTelopTrack();
}

export function selectAllTelops() {
  const scene = deps.activeScene();
  const telops = Array.isArray(scene?.telops) ? scene.telops : [];
  if (telops.length === 0) return;
  const sorted = telops.slice().sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  setMultiTelopSelection(sorted.map((t) => t.id), state.selectedTelopId || sorted[0].id);
}

export function setMultiTelopSelection(ids, primaryId) {
  // 複数選択を一括で差し替える。primaryId は編集パネルが追従する「主」のテロップ。
  // ids が空のときは全解除（clearTelopSelection 相当）。
  const normalized = new Set();
  for (const id of ids || []) if (id) normalized.add(id);
  if (normalized.size === 0) {
    clearTelopSelection();
    return;
  }
  state.selectedTelopIds = normalized;
  const primary = primaryId && normalized.has(primaryId)
    ? primaryId
    : Array.from(normalized)[0];
  state.editorTarget = "telop";
  state.selectedTelopId = primary;
  deps.applyEditorTargetView();
  renderTelopTrack();
  renderTelopEditor();
}

export function addTelop() {
  const scene = deps.activeScene();
  if (!Array.isArray(scene.telops)) scene.telops = [];
  const telop = defaultTelop();
  scene.telops.push(telop);
  scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  selectTelop(telop.id);
  deps.renderPreview();
}

// ★ Phase 4 — poster_typography テンプレで複数 TextClip をまとめて生成・挿入する。
//
// dialog (= poster-typography-dialog.js) から「テンプレ.generate() の結果 patch 配列」
// と templateId / params / sourceText を受け取り、scene.telops に挿入する。
// テンプレ登録の副作用 import は dialog 側に閉じる (= telop.js は registry を知らない)。
//
// 各 patch (= text / position / x / y / style / kind / role) を defaultTelop()
// の base にマージし、id / startFrame / durationFrame / metadata.posterTypography
// を埋める。groupId はテンプレ生成ごとに一意。後から個別 clip を編集しても
// metadata.posterTypography は残るので、Phase 4-4 の「テンプレを再適用」で
// 同 groupId の clip 群を再生成できる。
//
// 戻り値: 生成された clip 配列 (= scene.telops に push 済み)。
// metadata.posterTypography.groupId が一致する telop を scene から取り除き、
// その先頭 telop の startFrame / durationFrame を返す (= 再適用時の位置維持に使う)。
// 何も削除できなかった場合は null を返す。
export function removePosterTemplateGroup(groupId) {
  if (!groupId) return null;
  const scene = deps.activeScene();
  const telops = Array.isArray(scene?.telops) ? scene.telops : [];
  if (telops.length === 0) return null;
  const matching = telops.filter((t) => t?.metadata?.posterTypography?.groupId === groupId);
  if (matching.length === 0) return null;
  matching.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  const startFrame = telopStartFrame(matching[0]);
  const durationFrame = telopDurationFrame(matching[0]);
  scene.telops = telops.filter((t) => t?.metadata?.posterTypography?.groupId !== groupId);
  return { startFrame, durationFrame, removedCount: matching.length };
}

export function insertPosterTemplateClips({ patches, templateId, params, sourceText, durationFrame, startFrame }) {
  const scene = deps.activeScene();
  if (!scene) return [];
  if (!Array.isArray(scene.telops)) scene.telops = [];
  if (!Array.isArray(patches) || patches.length === 0) return [];

  const baseStart = Number.isFinite(startFrame)
    ? Math.max(0, Math.floor(startFrame))
    : secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const dur = Math.max(1, Number.isFinite(durationFrame) ? Math.floor(durationFrame) : PROJECT_FPS * 3);

  // groupId は人にも読めるように templateId + 短いランダム接尾辞。
  // 同 templateId のグループが複数あっても識別できる。
  const shortRand = Math.random().toString(36).slice(2, 8);
  const groupId = `${templateId}_${shortRand}`;

  const created = [];
  for (const patch of patches) {
    if (!patch || typeof patch !== "object") continue;
    const base = defaultTelop();
    base.id = generateTelopId();
    base.startFrame = baseStart;
    base.durationFrame = dur;
    base.kind = String(patch.kind || "mv_text");
    base.text = String(patch.text || "");
    base.position = String(patch.position || "custom");
    if (patch.x != null) base.x = Math.round(Number(patch.x));
    if (patch.y != null) base.y = Math.round(Number(patch.y));
    // style は base.style を上書きマージ (= テンプレ patch にあるキーだけ差し替え)。
    if (patch.style && typeof patch.style === "object") {
      base.style = { ...base.style, ...patch.style };
    }
    base.metadata = {
      posterTypography: {
        templateId: String(templateId),
        sourceText: String(sourceText || ""),
        params: { ...(params || {}) },
        groupId,
        role: String(patch.role || ""),
      },
    };
    scene.telops.push(base);
    created.push(base);
  }
  scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  // 最初の clip を選択。複数選択ではなく単一選択で「個別調整できる」状態にする
  // (= addTelop 時の選択挙動と揃える)。
  if (created.length > 0) selectTelop(created[0].id);
  deps.renderPreview();
  return created;
}

// ショートカット用: 選択中のテロップを複製する。
// 単一選択時は同じシーン内の「次のテロップとの隙間」 or 末尾までに収まるよう配置。
// 後続のテロップ位置は変更しない（重なりは許容）。
export function duplicateSelectedTelop() {
  const scene = deps.activeScene();
  const telops = Array.isArray(scene?.telops) ? scene.telops : [];
  if (telops.length === 0) return;
  const ids = Array.from(state.selectedTelopIds && state.selectedTelopIds.size > 0
    ? state.selectedTelopIds
    : (state.selectedTelopId ? [state.selectedTelopId] : []));
  if (ids.length === 0) return;
  const created = [];
  for (const id of ids) {
    const src = telops.find((t) => t && t.id === id);
    if (!src) continue;
    const clone = JSON.parse(JSON.stringify(src));
    clone.id = generateTelopId();
    const srcStart = telopStartFrame(src);
    const srcDur = telopDurationFrame(src);
    // 後ろの空間に追加するが、後続テロップの位置は動かさない（重なるのは許容）。
    clone.startFrame = srcStart + srcDur;
    clone.durationFrame = Math.max(1, srcDur);
    scene.telops.push(clone);
    created.push(clone);
  }
  if (created.length === 0) return;
  scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  // 単一複製時はその新規テロップを active にし、複数複製時は最後のを active に。
  const primary = created[created.length - 1];
  if (created.length === 1) {
    selectTelop(primary.id);
  } else {
    state.editorTarget = "telop";
    state.selectedTelopId = primary.id;
    state.selectedTelopIds = new Set(created.map((t) => t.id));
    deps.applyEditorTargetView();
    renderTelopEditor();
  }
  deps.renderPreview();
  showToast(`テロップを${created.length}件複製しました`);
}

// ショートカット用: 選択中のテロップを削除する。後続テロップの位置は変更しない。
export function deleteSelectedTelops() {
  const scene = deps.activeScene();
  const telops = Array.isArray(scene?.telops) ? scene.telops : [];
  if (telops.length === 0) return;
  const ids = new Set(state.selectedTelopIds && state.selectedTelopIds.size > 0
    ? state.selectedTelopIds
    : (state.selectedTelopId ? [state.selectedTelopId] : []));
  if (ids.size === 0) return;
  scene.telops = telops.filter((t) => !(t && ids.has(t.id)));
  clearTelopSelection({ render: false });
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  deps.renderPreview();
  showToast(`テロップを${ids.size}件削除しました`);
}

// ショートカット用: 単一選択中のテロップから、前 / 次のテロップに切り替える。
// 複数選択時は何もしない (どちらを「現在位置」とすべきか不定なため)。
// direction = -1 (前) / +1 (次)。telops は startFrame 昇順で並べた上で隣接を
// 取る。重なっている / 離れている / 完全に同時刻の telop もこの順序で含まれる。
// 端 (先頭で -1 / 末尾で +1) は何もしない。
export function selectAdjacentTelop(direction) {
  if (state.selectedTelopIds && state.selectedTelopIds.size > 1) return;
  const id = state.selectedTelopId;
  if (!id) return;
  const scene = deps.activeScene();
  const telops = Array.isArray(scene?.telops) ? scene.telops.slice() : [];
  if (telops.length === 0) return;
  telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  const i = telops.findIndex((t) => t && t.id === id);
  if (i < 0) return;
  const j = i + direction;
  if (j < 0 || j >= telops.length) return;
  const next = telops[j];
  if (next && next.id !== id) selectTelop(next.id);
}

function setAddTelopBatchTab(tabId) {
  for (const tab of elements.addTelopBatchTabs || []) {
    const active = tab.dataset.telopBatchTab === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of elements.addTelopBatchTabPanels || []) {
    panel.classList.toggle("hidden", panel.dataset.telopBatchTabPanel !== tabId);
  }
  // 確定ボタンに現在のモードを覚えさせる (commitAddTelopBatch から参照)
  if (elements.addTelopBatchConfirmButton) {
    elements.addTelopBatchConfirmButton.dataset.batchTab = tabId;
  }
}

export function openAddTelopBatchDialog() {
  const dialog = elements.addTelopBatchDialog;
  if (!dialog) return;
  if (elements.addTelopBatchText) elements.addTelopBatchText.value = "";
  if (elements.addTelopBatchYamlInput) elements.addTelopBatchYamlInput.value = "";
  if (elements.addTelopBatchHint) {
    const tFrames = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
    elements.addTelopBatchHint.textContent =
      `開始位置は再生ヘッド ${formatTimecode(tFrames)}。書体や色は「テロップを追加」と同じデフォルトを使います。`;
  }
  setAddTelopBatchTab("text");
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
  migrateInDialogToasts();
  setTimeout(() => elements.addTelopBatchText?.focus(), 0);
}

export function closeAddTelopBatchDialog() {
  const dialog = elements.addTelopBatchDialog;
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function commitAddTelopBatchYaml() {
  const raw = elements.addTelopBatchYamlInput?.value || "";
  if (!raw.trim()) {
    showToast("YAML を入力してください");
    return;
  }
  let parsed;
  try {
    const res = await fetch("/api/telop/parse-yaml", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: raw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "YAML パースに失敗しました");
    parsed = data;
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
    console.warn("[telop yaml]", w);
  }
  const scene = deps.activeScene();
  if (!Array.isArray(scene.telops)) scene.telops = [];
  let firstId = null;
  for (const it of items) {
    const tpl = defaultTelop();
    tpl.startFrame = secToFrames(it.startSec || 0);
    tpl.durationFrame = Math.max(1, secToFrames(it.durationSec || 1.0));
    tpl.text = it.text || "";
    if (it.style && typeof it.style === "object") {
      tpl.style = { ...tpl.style, ...it.style };
    }
    scene.telops.push(tpl);
    if (!firstId) firstId = tpl.id;
  }
  scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  if (firstId) selectTelop(firstId);
  deps.renderPreview();
  closeAddTelopBatchDialog();
  const warnPart = (parsed.warnings || []).length ? `（警告 ${parsed.warnings.length} 件あり / コンソール参照）` : "";
  showToast(`${items.length} 件のテロップを YAML から追加しました${warnPart}`);
}

export function commitAddTelopBatch() {
  const tabId = elements.addTelopBatchConfirmButton?.dataset.batchTab || "text";
  if (tabId === "yaml") {
    commitAddTelopBatchYaml().catch((error) => {
      console.error(error);
      showToast("テロップ一括追加に失敗しました", "error");
    });
    return;
  }
  const raw = elements.addTelopBatchText?.value || "";
  const skipBlank = elements.addTelopBatchSkipBlank?.checked !== false;
  const lines = raw.split(/\r?\n/);
  const items = skipBlank ? lines.map((s) => s.trim()).filter((s) => s.length > 0) : lines;
  if (items.length === 0) {
    showToast("テロップ本文を入力してください");
    return;
  }
  const durationFrame = Math.max(1, secToFrames(Number(elements.addTelopBatchDuration?.value) || 1.0));
  const gapFrame = Math.max(0, secToFrames(Number(elements.addTelopBatchGap?.value) || 0));
  const startBaseFrame = secToFrames(Math.max(0, Number(state.timeline?.currentSec) || 0));
  const scene = deps.activeScene();
  if (!Array.isArray(scene.telops)) scene.telops = [];
  let cursor = startBaseFrame;
  let firstId = null;
  for (const text of items) {
    const tpl = defaultTelop();
    tpl.startFrame = cursor;
    tpl.durationFrame = durationFrame;
    tpl.text = text;
    scene.telops.push(tpl);
    if (!firstId) firstId = tpl.id;
    cursor += durationFrame + gapFrame;
  }
  scene.telops.sort((a, b) => telopStartFrame(a) - telopStartFrame(b));
  deps.scheduleScenarioSave();
  recordHistory();
  renderTelopTrack();
  if (firstId) selectTelop(firstId);
  deps.renderPreview();
  closeAddTelopBatchDialog();
  showToast(`${items.length} 件のテロップを追加しました`);
}

export function bindAddTelopBatchDialog() {
  elements.addTelopBatchConfirmButton?.addEventListener("click", () => commitAddTelopBatch());
  elements.addTelopBatchCancelButton?.addEventListener("click", () => closeAddTelopBatchDialog());
  for (const tab of elements.addTelopBatchTabs || []) {
    tab.addEventListener("click", () => {
      if (tab.disabled) return;
      setAddTelopBatchTab(tab.dataset.telopBatchTab);
    });
  }
  // Cmd/Ctrl+Enter で確定 (テキスト・YAML どちらでも)
  const enterHandler = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      commitAddTelopBatch();
    }
  };
  elements.addTelopBatchText?.addEventListener("keydown", enterHandler);
  elements.addTelopBatchYamlInput?.addEventListener("keydown", enterHandler);
}

// drawTelopsOnCanvas は kind="caption" の TextClip を順次描画するラッパ。
// 描画コアと glow/dropShadow の scratch プールは static/js/renderer/text-core.js
// 側に置き、kind 分岐は static/js/renderer/text-clip-draw.js に集約した。
//
// 既存の呼び出し元 (renderer/telop.js / scene-builder.js のギャップ用 telop plane)
// は引き続き drawTelopsOnCanvas(ctx, telops, sceneSec) の形で呼び続ける。
// timelineSec から quantized frameIdx を出すかは Phase 1 (`refreshTelopCanvas`
// 拡張) で扱う。Phase 0 では context/frameIdx を null で渡してパススルー。
export function drawTelopsOnCanvas(ctx, telops, timelineSec) {
  drawTextClipsOnCanvas(ctx, telops, timelineSec, null, null);
}
