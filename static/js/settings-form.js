// 設定ダイアログのフォーム類（テキスト/モーション/テロップ既定値/プレビュー/保存）。
import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import {
  fillSelect,
  clamp,
  opacityToUi,
  opacityToRender,
  hexToRgba,
  normalizeColorValue,
} from "./utils.js";
import {
  FONT_WEIGHT_CSS,
  fontFamilyCssStack,
  resolveFontWeightCss,
  fillDefaultFontWeights,
  fillTelopDefaultFontWeights,
} from "./font.js";
import {
  TEXT_DEFAULT_LABELS,
  TELOP_DEFAULT_LABELS,
  formatBulkValue,
  textDefaultsDiff,
  telopDefaultsDiff,
} from "./bulk-apply.js";
import { TELOP_GLOW_DEFAULT, TELOP_DROP_SHADOW_DEFAULT } from "./telop.js";
import {
  promptBulkApply,
  applyTextDefaultsToAllCuts,
  applyTelopDefaultsToAllTelops,
} from "./dialog.js";
import { activeScene } from "./scenario-actions.js";
import {
  renderPreview,
  updateAudioMeterThresholds,
  invalidateRendererCachesForConfigChange,
} from "./playback.js";

export function fillConfigForm() {
  const lipSync = state.manifest.config.lipSync || {};
  const textDefaults = state.manifest.config.textDefaults || {};
  const animationDefaults = state.manifest.config.animationDefaults || {};
  fillSelect(elements.defaultFontFamily, state.manifest.config.fonts, false);
  elements.defaultFontFamily.value = textDefaults.fontFamily || state.manifest.config.defaultFont;
  fillDefaultFontWeights(textDefaults.fontWeight || state.manifest.config.defaultFontWeight || "regular");
  elements.defaultFontSize.value = textDefaults.fontSize ?? state.manifest.defaults.textStyle.fontSize;
  elements.defaultBoxOpacity.value = opacityToUi(textDefaults.boxOpacity ?? state.manifest.defaults.textStyle.boxOpacity);
  elements.boxBorderWidth.value = textDefaults.boxBorderWidth ?? state.manifest.defaults.textStyle.boxBorderWidth ?? 3;
  elements.boxBorderColor.value = textDefaults.boxBorderColor ?? state.manifest.defaults.textStyle.boxBorderColor ?? "#ffffff";
  elements.boxBackgroundColor.value =
    textDefaults.boxBackgroundColor ?? state.manifest.defaults.textStyle.boxBackgroundColor ?? "#14181c";
  elements.textColor.value = textDefaults.textColor ?? state.manifest.defaults.textStyle.textColor ?? "#ffffff";
  elements.textOutlineWidth.value =
    textDefaults.textOutlineWidth ?? state.manifest.defaults.textStyle.textOutlineWidth ?? 0;
  elements.textOutlineColor.value =
    textDefaults.textOutlineColor ?? state.manifest.defaults.textStyle.textOutlineColor ?? "#666666";
  fillSelect(elements.boxOverlayImage, state.manifest.overlays || [], true);
  elements.boxOverlayImage.value = textDefaults.boxOverlayImage ?? state.manifest.defaults.textStyle.boxOverlayImage ?? "";
  elements.speechOffsetX.value = textDefaults.speechOffsetX ?? state.manifest.defaults.textStyle.speechOffsetX ?? 120;
  elements.speechOffsetY.value = textDefaults.speechOffsetY ?? state.manifest.defaults.textStyle.speechOffsetY ?? 70;
  elements.speechPaddingX.value = textDefaults.speechPaddingX ?? state.manifest.defaults.textStyle.speechPaddingX ?? 60;
  elements.speechPaddingY.value = textDefaults.speechPaddingY ?? state.manifest.defaults.textStyle.speechPaddingY ?? 70;
  elements.lineGap.value = textDefaults.lineGap ?? state.manifest.defaults.textStyle.lineGap ?? 16;
  if (elements.defaultLetterSpacing) {
    elements.defaultLetterSpacing.value = Number(textDefaults.letterSpacing ?? 0);
  }
  setOpticalKerningRadios(
    elements.defaultOpticalKerningModeRadios,
    !!textDefaults.enableOpticalKerning,
    !!textDefaults.opticalKerningHighQuality,
  );
  // セリフ本文の光彩 / ドロップシャドウ。textDefaults.dialogueGlow / dialogueDropShadow。
  const dlgGlow = {
    enabled: false, color: "#ffffff", blurPx: 12, opacity: 0.8,
    ...(textDefaults.dialogueGlow || {}),
  };
  if (elements.defaultDialogueGlowEnabled) elements.defaultDialogueGlowEnabled.checked = !!dlgGlow.enabled;
  if (elements.defaultDialogueGlowColor) elements.defaultDialogueGlowColor.value = dlgGlow.color;
  if (elements.defaultDialogueGlowBlur) elements.defaultDialogueGlowBlur.value = Number(dlgGlow.blurPx) || 0;
  if (elements.defaultDialogueGlowOpacity) elements.defaultDialogueGlowOpacity.value = Number(dlgGlow.opacity) || 0;
  const dlgDs = {
    enabled: false, color: "#000000", blurPx: 6, offsetX: 4, offsetY: 4, opacity: 0.7,
    ...(textDefaults.dialogueDropShadow || {}),
  };
  if (elements.defaultDialogueDropShadowEnabled) elements.defaultDialogueDropShadowEnabled.checked = !!dlgDs.enabled;
  if (elements.defaultDialogueDropShadowColor) elements.defaultDialogueDropShadowColor.value = dlgDs.color;
  if (elements.defaultDialogueDropShadowBlur) elements.defaultDialogueDropShadowBlur.value = Number(dlgDs.blurPx) || 0;
  if (elements.defaultDialogueDropShadowOffsetX) elements.defaultDialogueDropShadowOffsetX.value = Number(dlgDs.offsetX) || 0;
  if (elements.defaultDialogueDropShadowOffsetY) elements.defaultDialogueDropShadowOffsetY.value = Number(dlgDs.offsetY) || 0;
  if (elements.defaultDialogueDropShadowOpacity) elements.defaultDialogueDropShadowOpacity.value = Number(dlgDs.opacity) || 0;
  elements.speakerNameFontSize.value =
    textDefaults.speakerNameFontSize ?? state.manifest.defaults.textStyle.speakerNameFontSize ?? 28;
  // UI は「暗さ」(0 = 全く暗くしない) で表示するが、内部は inactiveCharacterOpacity
  // (opacity, 1 = 明るい / 0 = 暗い) で保持する。`darkness = 1 - opacity` で双方向変換する。
  {
    const opacity = Number(
      textDefaults.inactiveCharacterOpacity
        ?? state.manifest.defaults.textStyle.inactiveCharacterOpacity
        ?? 0.5,
    );
    const darkness = Math.max(0, Math.min(0.9, 1 - opacity));
    elements.inactiveCharacterOpacity.value = Number(darkness.toFixed(2));
  }
  if (elements.boxBorderRadiusTL) elements.boxBorderRadiusTL.value = Number(textDefaults.boxBorderRadiusTL ?? 0);
  if (elements.boxBorderRadiusTR) elements.boxBorderRadiusTR.value = Number(textDefaults.boxBorderRadiusTR ?? 0);
  if (elements.boxBorderRadiusBL) elements.boxBorderRadiusBL.value = Number(textDefaults.boxBorderRadiusBL ?? 0);
  if (elements.boxBorderRadiusBR) elements.boxBorderRadiusBR.value = Number(textDefaults.boxBorderRadiusBR ?? 0);
  if (elements.defaultShowSpeakerName) {
    elements.defaultShowSpeakerName.checked =
      textDefaults.showSpeakerName ?? state.manifest.defaults.textStyle.showSpeakerName ?? true;
  }
  elements.blink.checked = animationDefaults.blink ?? true;
  elements.lipSync.checked = animationDefaults.lipSync ?? true;
  if (elements.blinkAlgorithm) {
    const algorithm = String(animationDefaults.blinkAlgorithm || "anime");
    elements.blinkAlgorithm.value = ["anime", "uniform"].includes(algorithm) ? algorithm : "anime";
  }
  if (elements.characterAnimationFps) {
    const charFps = Number(state.manifest.config.characterAnimationFps);
    const allowed = [8, 12, 24];
    elements.characterAnimationFps.value = String(allowed.includes(charFps) ? charFps : 12);
  }
  elements.lipSilence.value = lipSync.silenceThreshold ?? 0.08;
  elements.lipOpen.value = lipSync.openThreshold ?? 0.42;
  elements.lipDbFloor.value = lipSync.dbFloor ?? -55;
  elements.lipDbCeil.value = lipSync.dbCeil ?? -18;
  elements.lipSmoothing.value = lipSync.smoothing ?? 0.2;
  fillMotionConfigForm();
  fillTelopDefaultsForm();
  syncColorDisplays();
  updateAudioMeterThresholds(lipSync);
}

function defaultMotionConfig() {
  return {
    shakeX: { amplitude: 30, count: 3, duration: 0.6 },
    shakeY: { amplitude: 30, count: 3, duration: 0.6 },
    zoom: { scale: 1.3, origin: "center" },
  };
}

function fillMotionConfigForm() {
  if (!elements.motionShakeXAmplitude) return;
  const motion = state.manifest?.config?.motion || defaultMotionConfig();
  const shakeX = motion.shakeX || {};
  const shakeY = motion.shakeY || {};
  const zoom = motion.zoom || {};
  elements.motionShakeXAmplitude.value = shakeX.amplitude ?? 30;
  elements.motionShakeXCount.value = shakeX.count ?? 3;
  elements.motionShakeXDuration.value = shakeX.duration ?? 0.6;
  elements.motionShakeYAmplitude.value = shakeY.amplitude ?? 30;
  elements.motionShakeYCount.value = shakeY.count ?? 3;
  elements.motionShakeYDuration.value = shakeY.duration ?? 0.6;
  elements.motionZoomScale.value = zoom.scale ?? 1.3;
  elements.motionZoomOrigin.value = ["center", "top", "bottom"].includes(zoom.origin) ? zoom.origin : "center";
}

function collectMotionConfig() {
  return {
    shakeX: {
      amplitude: Number(elements.motionShakeXAmplitude?.value || 30),
      count: Number(elements.motionShakeXCount?.value || 3),
      duration: Number(elements.motionShakeXDuration?.value || 0.6),
    },
    shakeY: {
      amplitude: Number(elements.motionShakeYAmplitude?.value || 30),
      count: Number(elements.motionShakeYCount?.value || 3),
      duration: Number(elements.motionShakeYDuration?.value || 0.6),
    },
    zoom: {
      scale: Number(elements.motionZoomScale?.value || 1.3),
      origin: elements.motionZoomOrigin?.value || "center",
    },
  };
}

function syncColorDisplay(input, output) {
  if (!input || !output) return;
  const color = normalizeColorValue(input.value);
  input.value = color;
  // output は app.js init で <span> から編集可能な <input> へ格上げされる場合がある。
  if (output.tagName === "INPUT") output.value = color;
  else output.textContent = color;
  output.style.setProperty("--color-value", color);
}

export function syncColorDisplays() {
  syncColorDisplay(elements.boxBorderColor, elements.boxBorderColorValue);
  syncColorDisplay(elements.boxBackgroundColor, elements.boxBackgroundColorValue);
  syncColorDisplay(elements.textColor, elements.textColorValue);
  syncColorDisplay(elements.textOutlineColor, elements.textOutlineColorValue);
  syncColorDisplay(elements.telopDefaultColor, elements.telopDefaultColorValue);
  syncColorDisplay(elements.telopDefaultOutlineColor, elements.telopDefaultOutlineColorValue);
  syncColorDisplay(elements.telopDefaultGlowColor, elements.telopDefaultGlowColorValue);
  syncColorDisplay(elements.telopDefaultDropShadowColor, elements.telopDefaultDropShadowColorValue);
  if (elements.defaultDialogueGlowColor && elements.defaultDialogueGlowColorValue) {
    syncColorDisplay(elements.defaultDialogueGlowColor, elements.defaultDialogueGlowColorValue);
  }
  if (elements.defaultDialogueDropShadowColor && elements.defaultDialogueDropShadowColorValue) {
    syncColorDisplay(elements.defaultDialogueDropShadowColor, elements.defaultDialogueDropShadowColorValue);
  }
  updateSpeechPreview();
}

function fillTelopDefaultsForm() {
  if (!elements.telopDefaultFontFamily) return;
  const td = state.manifest?.config?.telopDefaults || {};
  fillSelect(elements.telopDefaultFontFamily, state.manifest.config.fonts, false);
  elements.telopDefaultFontFamily.value =
    td.fontFamily || state.manifest.config.defaultFont || (state.manifest.config.fonts?.[0]?.id ?? "");
  fillTelopDefaultFontWeights(td.fontWeight || state.manifest.config.defaultFontWeight || "regular");
  if (elements.telopDefaultFontSize) elements.telopDefaultFontSize.value = Number(td.fontSize ?? 48);
  if (elements.telopDefaultColor) elements.telopDefaultColor.value = td.color || "#ffffff";
  if (elements.telopDefaultOutlineWidth)
    elements.telopDefaultOutlineWidth.value = Number(td.outlineWidth ?? 4);
  if (elements.telopDefaultOutlineColor)
    elements.telopDefaultOutlineColor.value = td.outlineColor || "#000000";
  const glow = { ...TELOP_GLOW_DEFAULT, ...(td.glow || {}) };
  if (elements.telopDefaultGlowEnabled) elements.telopDefaultGlowEnabled.checked = !!glow.enabled;
  if (elements.telopDefaultGlowColor) elements.telopDefaultGlowColor.value = glow.color;
  if (elements.telopDefaultGlowBlur) elements.telopDefaultGlowBlur.value = Number(glow.blurPx);
  if (elements.telopDefaultGlowOpacity) elements.telopDefaultGlowOpacity.value = Number(glow.opacity);
  const ds = { ...TELOP_DROP_SHADOW_DEFAULT, ...(td.dropShadow || {}) };
  if (elements.telopDefaultDropShadowEnabled) elements.telopDefaultDropShadowEnabled.checked = !!ds.enabled;
  if (elements.telopDefaultDropShadowColor) elements.telopDefaultDropShadowColor.value = ds.color;
  if (elements.telopDefaultDropShadowBlur) elements.telopDefaultDropShadowBlur.value = Number(ds.blurPx);
  if (elements.telopDefaultDropShadowOffsetX)
    elements.telopDefaultDropShadowOffsetX.value = Number(ds.offsetX);
  if (elements.telopDefaultDropShadowOffsetY)
    elements.telopDefaultDropShadowOffsetY.value = Number(ds.offsetY);
  if (elements.telopDefaultDropShadowOpacity)
    elements.telopDefaultDropShadowOpacity.value = Number(ds.opacity);
  if (elements.telopDefaultLetterSpacing)
    elements.telopDefaultLetterSpacing.value = Number(td.letterSpacing ?? 0);
  if (elements.telopDefaultLineSpacing)
    elements.telopDefaultLineSpacing.value = Number(td.lineSpacing ?? 0);
  setOpticalKerningRadios(
    elements.telopDefaultOpticalKerningModeRadios,
    !!td.enableOpticalKerning,
    !!td.opticalKerningHighQuality,
  );
}

// 排他 3 値ラジオ ↔ boolean 2 個の橋渡し。
//   off:      enable=false, hq=false
//   standard: enable=true,  hq=false
//   high:     enable=true,  hq=true
function setOpticalKerningRadios(radios, enable, highQuality) {
  if (!radios || !radios.length) return;
  const mode = enable ? (highQuality ? "high" : "standard") : "off";
  for (const radio of radios) {
    radio.checked = (radio.value === mode);
  }
}

function readOpticalKerningRadios(radios) {
  if (!radios || !radios.length) return { enable: false, highQuality: false };
  let mode = "off";
  for (const radio of radios) {
    if (radio.checked) { mode = radio.value; break; }
  }
  return {
    enable: mode !== "off",
    highQuality: mode === "high",
  };
}

function collectTelopDefaultsConfig() {
  if (!elements.telopDefaultFontFamily) {
    return state.manifest?.config?.telopDefaults || {};
  }
  return {
    fontFamily: elements.telopDefaultFontFamily.value || state.manifest.config.defaultFont || "",
    fontWeight: elements.telopDefaultFontWeight?.value || "regular",
    fontSize: Math.max(20, Math.min(160, Number(elements.telopDefaultFontSize?.value) || 48)),
    color: elements.telopDefaultColor?.value || "#ffffff",
    outlineWidth: Math.max(0, Math.min(20, Number(elements.telopDefaultOutlineWidth?.value) || 0)),
    outlineColor: elements.telopDefaultOutlineColor?.value || "#000000",
    glow: {
      enabled: !!elements.telopDefaultGlowEnabled?.checked,
      color: elements.telopDefaultGlowColor?.value || "#ffffff",
      blurPx: Math.max(0, Math.min(60, Number(elements.telopDefaultGlowBlur?.value) || 0)),
      opacity: Math.max(0, Math.min(1, Number(elements.telopDefaultGlowOpacity?.value) || 0)),
    },
    dropShadow: {
      enabled: !!elements.telopDefaultDropShadowEnabled?.checked,
      color: elements.telopDefaultDropShadowColor?.value || "#000000",
      blurPx: Math.max(0, Math.min(40, Number(elements.telopDefaultDropShadowBlur?.value) || 0)),
      offsetX: Math.max(-40, Math.min(40, Number(elements.telopDefaultDropShadowOffsetX?.value) || 0)),
      offsetY: Math.max(-40, Math.min(40, Number(elements.telopDefaultDropShadowOffsetY?.value) || 0)),
      opacity: Math.max(0, Math.min(1, Number(elements.telopDefaultDropShadowOpacity?.value) || 0)),
    },
    // 1/1000 em 単位。step=10 (= 0.01em 刻み) で操作する想定。
    letterSpacing: Math.max(-500, Math.min(1000, Math.round((Number(elements.telopDefaultLetterSpacing?.value) || 0) / 10) * 10)),
    lineSpacing: Math.max(-500, Math.min(500, Number(elements.telopDefaultLineSpacing?.value) || 0)),
    ...(() => {
      const r = readOpticalKerningRadios(elements.telopDefaultOpticalKerningModeRadios);
      return { enableOpticalKerning: r.enable, opticalKerningHighQuality: r.highQuality };
    })(),
  };
}

// 各 number input から数値を取り出すヘルパ。空文字 → fallback、"0" → 0 (NaN ガード)。
// `Number(elements.X?.value || fallback)` は value="0" が string "0" で truthy になるため
// たまたま 0 を保てるが、value="" (空) / undefined のときに fallback に倒れない事故を防ぐ
// ため明示的な数値変換 + Number.isFinite チェックで揃える。
function _numOr(input, fallback) {
  if (!input) return fallback;
  const raw = input.value;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function updateSpeechPreview() {
  const stage = document.querySelector("#speechPreview");
  const band = stage ? stage.querySelector(".speech-preview-band") : null;
  if (!stage || !band) return;
  // ステージは 16:9 固定 (= 1920×1080 を縮小したビューポート)。表示幅から実寸スケールが決まる。
  // 設定ダイアログを別タブ (お芝居（文字）等) で開いた直後は #speechPreview が
  // display:none で stageWidth=0。タブ切替時にこの関数を再実行することで反映する。
  const stageWidth = stage.clientWidth;
  if (stageWidth <= 0) {
    // 後で表示されたときに再計算されるので、ここでは何もしない (現状の表示を維持)。
    return;
  }
  const scale = stageWidth / 1920;

  const opacity = clamp(_numOr(elements.defaultBoxOpacity, 0.8), 0, 1);
  const bg = (elements.boxBackgroundColor?.value || "#14181c").trim();
  const border = (elements.boxBorderColor?.value || "#ffffff").trim();
  const borderWidth = Math.max(0, _numOr(elements.boxBorderWidth, 3));
  const text = (elements.textColor?.value || "#ffffff").trim();
  const outlineWidth = Math.max(0, _numOr(elements.textOutlineWidth, 0));
  const outlineColor = (elements.textOutlineColor?.value || "#666666").trim();
  const offX = Math.max(0, _numOr(elements.speechOffsetX, 120));
  const offY = Math.max(0, _numOr(elements.speechOffsetY, 70));
  const padX = Math.max(0, _numOr(elements.speechPaddingX, 60));
  const padY = Math.max(0, _numOr(elements.speechPaddingY, 70));
  const radiusTL = Math.max(0, _numOr(elements.boxBorderRadiusTL, 0));
  const radiusTR = Math.max(0, _numOr(elements.boxBorderRadiusTR, 0));
  const radiusBR = Math.max(0, _numOr(elements.boxBorderRadiusBR, 0));
  const radiusBL = Math.max(0, _numOr(elements.boxBorderRadiusBL, 0));
  const fontSizePx = Math.max(20, _numOr(elements.defaultFontSize, 54));
  const speakerSizePx = Math.max(12, _numOr(elements.speakerNameFontSize, 28));

  // 装飾画像 (overlay) はステージ全幅 (= 1920×1080 全域) に背景として敷く。
  // band の border-radius でクリップされないので、フレーム装飾が box 外まで張り出す
  // デザインでも欠けなく見える。boxOpacity は band 側にだけ効くので、opacity=0 でも
  // ステージ側の装飾画像は維持される (= 「枠を消して装飾画像で置き換える」運用が機能する)。
  const overlayPath = String(elements.boxOverlayImage?.value || "").trim();
  if (overlayPath) {
    const url = `/assets/${overlayPath.replace(/^\/+/, "")}`;
    stage.style.backgroundImage = `url("${url}")`;
  } else {
    stage.style.backgroundImage = "";
  }

  // band は実出力と同じ (offX, offY) 位置に absolute 配置。bottom-anchor で「下からのオフセット」
  // を表現 (= 既定の speechPlacement="bottom" を仮定)。
  band.style.left = `${offX * scale}px`;
  band.style.width = `${(1920 - 2 * offX) * scale}px`;
  band.style.bottom = `${offY * scale}px`;
  band.style.top = "auto";
  band.style.right = "auto";

  band.style.backgroundColor = hexToRgba(bg, opacity);
  band.style.color = text;
  // 半透明 fill とボーダー色が混ざらないよう、CSS border を抑止して box-shadow
  // (= 完全に外側) で外周ボーダーを描く。実出力の Pillow / canvas2d 経路と同じ
  // 「fill の完全外側だけにボーダー色を載せる」挙動に揃える。
  // ボーダー不透明度は boxOpacity に連動する (compositor.py で borderOpacity = box_opacity)。
  band.style.borderWidth = "0";
  band.style.borderStyle = "none";
  const borderPx = borderWidth > 0 ? borderWidth * scale : 0;
  band.style.boxShadow = borderPx > 0 && opacity > 0
    ? `0 0 0 ${borderPx}px ${hexToRgba(border, opacity)}`
    : "none";
  band.style.borderRadius =
    `${radiusTL * scale}px ${radiusTR * scale}px ${radiusBR * scale}px ${radiusBL * scale}px`;
  band.style.paddingLeft = `${padX * scale}px`;
  band.style.paddingRight = `${padX * scale}px`;
  band.style.paddingTop = `${padY * scale}px`;
  band.style.paddingBottom = `${padY * scale}px`;

  const familyId = elements.defaultFontFamily?.value || state.manifest?.config?.defaultFont;
  const weightId = elements.defaultFontWeight?.value || state.manifest?.config?.defaultFontWeight || "regular";
  band.style.fontFamily = fontFamilyCssStack(familyId);
  band.style.fontWeight = resolveFontWeightCss(familyId, weightId);
  const speaker = band.querySelector(".speech-preview-speaker");
  const line = band.querySelector(".speech-preview-line");
  if (speaker) {
    speaker.style.fontSize = `${Math.round(speakerSizePx * scale)}px`;
    const showSpeaker = elements.defaultShowSpeakerName?.checked ?? true;
    speaker.style.display = showSpeaker ? "" : "none";
  }
  if (line) {
    line.style.fontSize = `${Math.round(fontSizePx * scale)}px`;
    if (outlineWidth > 0) {
      const w = Math.max(1, Math.round(outlineWidth * scale));
      line.style.textShadow = [
        `${w}px 0 0 ${outlineColor}`,
        `-${w}px 0 0 ${outlineColor}`,
        `0 ${w}px 0 ${outlineColor}`,
        `0 -${w}px 0 ${outlineColor}`,
        `${w}px ${w}px 0 ${outlineColor}`,
        `-${w}px ${w}px 0 ${outlineColor}`,
        `${w}px -${w}px 0 ${outlineColor}`,
        `-${w}px -${w}px 0 ${outlineColor}`,
      ].join(", ");
    } else {
      line.style.textShadow = "";
    }
  }
}

export function normalizeBoxOpacityInput() {
  elements.boxOpacity.value = opacityToUi(elements.boxOpacity.value);
}

export async function saveConfig() {
  const previousTextDefaults = {
    fontFamily: String(state.manifest?.config?.textDefaults?.fontFamily ?? ""),
    fontWeight: String(state.manifest?.config?.textDefaults?.fontWeight ?? ""),
    fontSize: Number(state.manifest?.config?.textDefaults?.fontSize ?? -1),
    boxOpacity: Number(state.manifest?.config?.textDefaults?.boxOpacity ?? -1),
    textColor: String(state.manifest?.config?.textDefaults?.textColor ?? ""),
    textOutlineWidth: Number(state.manifest?.config?.textDefaults?.textOutlineWidth ?? -1),
    textOutlineColor: String(state.manifest?.config?.textDefaults?.textOutlineColor ?? ""),
    showSpeakerName: Boolean(state.manifest?.config?.textDefaults?.showSpeakerName ?? true),
    letterSpacing: Number(state.manifest?.config?.textDefaults?.letterSpacing ?? 0),
    lineGap: Number(state.manifest?.config?.textDefaults?.lineGap ?? -1),
    dialogueGlow: state.manifest?.config?.textDefaults?.dialogueGlow || null,
    dialogueDropShadow: state.manifest?.config?.textDefaults?.dialogueDropShadow || null,
  };
  const previousTelopDefaults = {
    ...(state.manifest?.config?.telopDefaults || {}),
  };
  const { renderDefaults, ...baseConfig } = state.manifest.config;
  const config = {
    ...baseConfig,
    defaultFont: elements.defaultFontFamily.value,
    defaultFontWeight: elements.defaultFontWeight.value,
    textDefaults: {
      fontFamily: elements.defaultFontFamily.value,
      fontWeight: elements.defaultFontWeight.value,
      fontSize: Number(elements.defaultFontSize.value),
      boxOpacity: Number(elements.defaultBoxOpacity.value),
      speechPlacement: state.manifest.config.textDefaults?.speechPlacement || "bottom",
      boxBorderWidth: Number(elements.boxBorderWidth.value),
      boxBorderColor: elements.boxBorderColor.value,
      boxBackgroundColor: elements.boxBackgroundColor.value,
      textColor: elements.textColor.value,
      textOutlineWidth: Number(elements.textOutlineWidth.value),
      textOutlineColor: elements.textOutlineColor.value,
      boxOverlayImage: elements.boxOverlayImage.value,
      speechOffsetX: Number(elements.speechOffsetX.value),
      speechOffsetY: Number(elements.speechOffsetY.value),
      speechPaddingX: Number(elements.speechPaddingX.value),
      speechPaddingY: Number(elements.speechPaddingY.value),
      lineGap: Number(elements.lineGap.value),
      // 1/1000 em 単位。step=10 (= 0.01em 刻み) で操作する想定。
      letterSpacing: Math.max(-500, Math.min(1000, Math.round((Number(elements.defaultLetterSpacing?.value) || 0) / 10) * 10)),
      speakerNameFontSize: Number(elements.speakerNameFontSize.value),
      showSpeakerName: elements.defaultShowSpeakerName?.checked ?? true,
      // UI 表示は「暗さ」(0 = 全く暗くしない)。内部 opacity は `1 - darkness` で逆変換する。
      inactiveCharacterOpacity: Math.max(0.1, Math.min(1, 1 - Number(elements.inactiveCharacterOpacity.value))),
      boxBorderRadiusTL: Math.max(0, Math.min(500, Number(elements.boxBorderRadiusTL?.value) || 0)),
      boxBorderRadiusTR: Math.max(0, Math.min(500, Number(elements.boxBorderRadiusTR?.value) || 0)),
      boxBorderRadiusBL: Math.max(0, Math.min(500, Number(elements.boxBorderRadiusBL?.value) || 0)),
      boxBorderRadiusBR: Math.max(0, Math.min(500, Number(elements.boxBorderRadiusBR?.value) || 0)),
      ...(() => {
        const r = readOpticalKerningRadios(elements.defaultOpticalKerningModeRadios);
        return { enableOpticalKerning: r.enable, opticalKerningHighQuality: r.highQuality };
      })(),
      dialogueGlow: {
        enabled: !!elements.defaultDialogueGlowEnabled?.checked,
        color: elements.defaultDialogueGlowColor?.value || "#ffffff",
        blurPx: Math.max(0, Math.min(200, Number(elements.defaultDialogueGlowBlur?.value) || 0)),
        opacity: Math.max(0, Math.min(1, Number(elements.defaultDialogueGlowOpacity?.value) || 0)),
      },
      dialogueDropShadow: {
        enabled: !!elements.defaultDialogueDropShadowEnabled?.checked,
        color: elements.defaultDialogueDropShadowColor?.value || "#000000",
        blurPx: Math.max(0, Math.min(200, Number(elements.defaultDialogueDropShadowBlur?.value) || 0)),
        offsetX: Math.max(-200, Math.min(200, Number(elements.defaultDialogueDropShadowOffsetX?.value) || 0)),
        offsetY: Math.max(-200, Math.min(200, Number(elements.defaultDialogueDropShadowOffsetY?.value) || 0)),
        opacity: Math.max(0, Math.min(1, Number(elements.defaultDialogueDropShadowOpacity?.value) || 0)),
      },
    },
    animationDefaults: {
      blink: elements.blink.checked,
      lipSync: elements.lipSync.checked,
      blinkAlgorithm: ["anime", "uniform"].includes(elements.blinkAlgorithm?.value)
        ? elements.blinkAlgorithm.value
        : "anime",
    },
    characterAnimationFps: Number(elements.characterAnimationFps?.value) || 12,
    lipSync: {
      silenceThreshold: Number(elements.lipSilence.value),
      openThreshold: Number(elements.lipOpen.value),
      dbFloor: Number(elements.lipDbFloor.value),
      dbCeil: Number(elements.lipDbCeil.value),
      smoothing: Number(elements.lipSmoothing.value),
    },
    motion: collectMotionConfig(),
    telopDefaults: collectTelopDefaultsConfig(),
  };
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  state.manifest.config = await response.json();
  state.manifest.defaults.textStyle = {
    ...state.manifest.defaults.textStyle,
    ...state.manifest.config.textDefaults,
    boxOpacity: opacityToRender(state.manifest.config.textDefaults.boxOpacity),
  };
  fillConfigForm();
  // textDefaults / telopDefaults (オプティカルカーニング、行送り、フォント等) は
  // scene-bundle の token に乗らないため、設定変更だけだと active scene が再利用され
  // dialogue / telop canvas が古いまま残る。次の renderPreview で確実に焼き直す。
  await invalidateRendererCachesForConfigChange();
  renderPreview();
  updateAudioMeterThresholds(state.manifest.config.lipSync || {});
  showToast("設定を保存しました");
  const newTextDefaults = {
    fontFamily: String(state.manifest.config.textDefaults?.fontFamily ?? ""),
    fontWeight: String(state.manifest.config.textDefaults?.fontWeight ?? ""),
    fontSize: Number(state.manifest.config.textDefaults?.fontSize ?? -1),
    boxOpacity: Number(state.manifest.config.textDefaults?.boxOpacity ?? -1),
    textColor: String(state.manifest.config.textDefaults?.textColor ?? ""),
    textOutlineWidth: Number(state.manifest.config.textDefaults?.textOutlineWidth ?? -1),
    textOutlineColor: String(state.manifest.config.textDefaults?.textOutlineColor ?? ""),
    showSpeakerName: Boolean(state.manifest.config.textDefaults?.showSpeakerName ?? true),
    letterSpacing: Number(state.manifest.config.textDefaults?.letterSpacing ?? 0),
    lineGap: Number(state.manifest.config.textDefaults?.lineGap ?? -1),
    dialogueGlow: state.manifest.config.textDefaults?.dialogueGlow || null,
    dialogueDropShadow: state.manifest.config.textDefaults?.dialogueDropShadow || null,
  };
  const diff = textDefaultsDiff(previousTextDefaults, newTextDefaults);
  if (Object.keys(diff).length > 0) {
    const cuts = state.scenario?.cuts || [];
    if (cuts.length > 0) {
      const items = Object.keys(diff).map((key) => ({
        key,
        label: TEXT_DEFAULT_LABELS[key] || key,
        valueText: formatBulkValue(key, diff[key]),
      }));
      const result = await promptBulkApply({
        title: "デフォルト設定をカットに反映",
        description: `変更したデフォルト値を、プロジェクト内 ${cuts.length} 件のカットに反映します。チェックを入れた項目だけが反映されます。`,
        items,
      });
      if (result.confirmed && result.selectedKeys.size > 0) {
        const filtered = {};
        for (const k of result.selectedKeys) filtered[k] = diff[k];
        try {
          await applyTextDefaultsToAllCuts(filtered);
        } catch (error) {
          console.error(error);
          showToast("カットへの反映に失敗しました", "error");
        }
      }
    }
  }
  const newTelopDefaults = state.manifest?.config?.telopDefaults || {};
  const telopDiff = telopDefaultsDiff(previousTelopDefaults, newTelopDefaults);
  if (Object.keys(telopDiff).length > 0) {
    const scene = activeScene();
    const telopCount = (scene?.telops || []).length;
    if (telopCount > 0) {
      const items = Object.keys(telopDiff).map((key) => ({
        key,
        label: TELOP_DEFAULT_LABELS[key] || key,
        valueText: formatBulkValue(key, telopDiff[key]),
      }));
      const result = await promptBulkApply({
        title: "テロップに一括反映",
        description: `変更したテロップ既定値を、シーン内 ${telopCount} 件のテロップに反映します。チェックを入れた項目だけが反映されます。`,
        items,
      });
      if (result.confirmed && result.selectedKeys.size > 0) {
        const filtered = {};
        for (const k of result.selectedKeys) filtered[k] = telopDiff[k];
        try {
          await applyTelopDefaultsToAllTelops(filtered);
        } catch (error) {
          console.error(error);
          showToast("テロップへの反映に失敗しました", "error");
        }
      }
    }
  }
}
