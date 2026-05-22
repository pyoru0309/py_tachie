// キャラクター管理ダイアログと表情プリセットの保存/削除を担当する。
// プロジェクト編集画面（メイン）からは個別キャラの ID/座標/拡大率/白抜きフラグを編集し、
// 共通キャラ（assets/characters/<id>/）はプリセットを READ ONLY 扱いにする。

import { state } from "./state.js";
import { elements } from "./elements.js";
import { showToast } from "./toast.js";
import { fillSelect, clamp, normalizeColorValue } from "./utils.js";
import { attachScenarioCutsAlias } from "./scenario.js";
import { renderPreview } from "./playback.js";
import { renderCutList } from "./scenario-actions.js";
import {
  selectedCharacter,
  characterDefinitionById,
  characterDefinitions,
  originLabel,
  accentColorFallback,
} from "./character.js";
import { loadProjects } from "./project.js";
import {
  ttsAvailable,
  ttsNarratorList,
  ttsStyleListForNarrator,
  splitVoiceId,
  combineNarratorAndStyle,
} from "./tts.js";

const deps = {
  fillAssetControls: () => {},
  fillConfigForm: () => {},
  centerDialog: () => {},
  syncDialogueVoiceFromSpeaker: () => {},
};

export function bindCharacterManager(injected = {}) {
  Object.assign(deps, injected);
  // 「声 (= 話者 narrator)」切替で「感情 (= スタイル/emotion)」候補を更新する。
  // 声を変えたら感情候補は最新一覧で再構築 (前の声の感情を引き継がない)。
  if (elements.characterManagerVoiceSelect) {
    elements.characterManagerVoiceSelect.addEventListener("change", () => {
      populateStyleSelectorForManager(
        elements.characterManagerVoiceSelect.value,
        "",
      );
    });
  }
  if (elements.characterManagerColor) {
    const sync = () => {
      const v = normalizeColorValue(
        elements.characterManagerColor.value,
        accentColorFallback(),
      );
      elements.characterManagerColor.value = v;
      elements.characterManagerColor.dataset.assigned = "1";
      if (elements.characterManagerColorValue) {
        elements.characterManagerColorValue.textContent = v;
        elements.characterManagerColorValue.style.setProperty("--color-value", v);
      }
    };
    elements.characterManagerColor.addEventListener("input", sync);
    elements.characterManagerColor.addEventListener("change", sync);
  }
  if (elements.characterManagerColorClearButton) {
    elements.characterManagerColorClearButton.addEventListener("click", () => {
      // 「未指定 = アクセントカラーを使う」状態に戻す
      if (elements.characterManagerColor) {
        elements.characterManagerColor.value = accentColorFallback();
        delete elements.characterManagerColor.dataset.assigned;
      }
      if (elements.characterManagerColorValue) {
        elements.characterManagerColorValue.textContent = "未指定";
        elements.characterManagerColorValue.style.setProperty(
          "--color-value",
          accentColorFallback(),
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 表情プリセット
// ---------------------------------------------------------------------------

export function fillExpressionPresets(selectedId = elements.expressionPreset.value) {
  const character = selectedCharacter();
  if (!character) {
    fillSelect(elements.expressionPreset, [], true);
    elements.presetName.value = "";
    updatePresetButtons();
    return;
  }
  const characterId = character.characterId;
  const presets = (state.manifest.expressionPresets || []).filter(
    (item) => !item.characterId || item.characterId === characterId
  );
  // 表示時にデフォルト印 (★) と origin (アセット定義は灰色っぽく) を付ける。
  // fillSelect は {id, name} を読むので、name を装飾した形にする。
  const decorated = presets.map((item) => {
    const marks = [];
    if (item.isDefault) marks.push("★");
    if (item.origin === "asset") marks.push("(アセット)");
    return { ...item, name: marks.length ? `${item.name} ${marks.join(" ")}` : item.name };
  });
  fillSelect(elements.expressionPreset, decorated, true);
  if (presets.some((item) => item.id === selectedId)) {
    elements.expressionPreset.value = selectedId;
  }
  syncPresetName();
  updatePresetButtons();
}

export function syncPresetName() {
  const character = selectedCharacter();
  if (!character) {
    elements.presetName.value = "";
    updatePresetButtons();
    return;
  }
  const characterId = character.characterId;
  const preset = (state.manifest.expressionPresets || []).find(
    (item) => item.id === elements.expressionPreset.value && (!item.characterId || item.characterId === characterId)
  );
  elements.presetName.value = preset?.name || "";
  updatePresetButtons();
}

export function selectedCharacterDefinitionIsReadOnly() {
  // アセット定義 (assets/characters/<id>/) の layers / character_manifest.json を
  // 編集画面から書き換えてはいけないという意味のフラグ。
  // 「project 側 expression_presets.json への保存」とは無関係なので
  // updatePresetButtons / saveCurrentPreset / deleteCurrentPreset では使わない。
  // (Phase 3 で導入するアセット側プリセットの書き戻し UI でだけ使う)
  const character = selectedCharacter();
  return !character || Boolean(characterDefinitionById(character.characterId)?.readOnly);
}

export function updatePresetButtons() {
  // project 側プリセット保存はキャラが選ばれていれば常に可能。共通アセット由来の
  // キャラでも、プロジェクト固有の override として保存される。
  const hasCharacter = Boolean(selectedCharacter());
  const character = selectedCharacter();
  const characterId = character?.characterId || "";
  const presetId = elements.expressionPreset.value;
  const merged = state.manifest.expressionPresets || [];
  const current = merged.find(
    (item) => item.id === presetId && (item.characterId || "") === characterId,
  );
  // アセット定義由来の preset は cut editor から削除不可 (project 側に override
  // を作るだけが可能)。アセット側の編集はアセット管理ダイアログで実施する。
  const isAssetOnly = current?.origin === "asset";
  elements.savePresetButton.disabled = !hasCharacter;
  elements.deletePresetButton.disabled =
    !hasCharacter || !presetId || isAssetOnly;
  elements.presetName.disabled = !hasCharacter;
}

export function currentPreset() {
  const character = selectedCharacter();
  const id = elements.expressionPreset.value || `preset_${Date.now()}`;
  const characterId = character?.characterId || "";
  // 既存 preset があれば isDefault を引継ぐ。アセット由来でも編集すれば project
  // 上書きとして保存されるが、デフォルト指定はアセット側の定義をそのまま尊重する。
  const existing = (state.manifest.expressionPresets || []).find(
    (item) => item.id === id && (item.characterId || "") === characterId,
  );
  return {
    id,
    name: elements.presetName.value.trim() || "新規表情",
    characterId,
    cheekId: elements.cheek.value,
    eyeId: elements.eye.value,
    mouthId: elements.mouth.value,
    isDefault: existing ? !!existing.isDefault : false,
  };
}

export async function saveExpressionPresets(presets) {
  const response = await fetch("/api/expression-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presets }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  state.manifest.expressionPresets = result.presets;
  return result.presets;
}

export async function saveCurrentPreset() {
  if (!selectedCharacter()) {
    showToast("登場キャラを追加してから表情プリセットを保存してください", "error");
    return;
  }
  const preset = currentPreset();
  const presets = [...(state.manifest.expressionPresets || [])];
  const index = presets.findIndex((item) => item.id === preset.id && item.characterId === preset.characterId);
  if (index >= 0) {
    presets[index] = preset;
  } else {
    presets.push(preset);
  }
  await saveExpressionPresets(presets);
  fillExpressionPresets(preset.id);
  elements.expressionPreset.value = preset.id;
  showToast("表情プリセットを保存しました");
}

export async function deleteCurrentPreset() {
  const character = selectedCharacter();
  if (!character) {
    return;
  }
  const presetId = elements.expressionPreset.value;
  const characterId = character.characterId;
  if (!presetId) {
    return;
  }
  const presets = (state.manifest.expressionPresets || []).filter(
    (item) => item.id !== presetId || item.characterId !== characterId
  );
  await saveExpressionPresets(presets);
  fillExpressionPresets("");
  showToast("表情プリセットを削除しました");
}

// ---------------------------------------------------------------------------
// キャラクター管理ダイアログ
// ---------------------------------------------------------------------------

export async function refreshCharacterManagerManifest() {
  const response = await fetch("/api/characters/manifest");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  state.manifest = await response.json();
  if (state.activeProjectId) {
    deps.fillAssetControls();
    deps.fillConfigForm();
  }
  return state.manifest;
}

export function loadCharacterManagerForm(character) {
  const defaults = character.defaults || {};
  const position = defaults.character || {};
  const hasAssetRoot = Boolean(character.assetRoot);
  elements.characterManagerAssetRoot.value = character.assetRoot || "";
  const idValue = character.manifestId || character.id || "";
  elements.characterManagerId.value = idValue;
  if (elements.characterManagerIdDisplay) {
    elements.characterManagerIdDisplay.textContent = idValue || "—";
  }
  elements.characterManagerName.value = character.name || character.id || "";
  elements.characterManagerX.value = position.x ?? 448;
  elements.characterManagerY.value = position.y ?? 0;
  elements.characterManagerScale.value = position.scale ?? 1;
  elements.characterManagerRemoveWhite.checked = defaults.removeWhite ?? true;
  if (elements.characterManagerHeading) {
    // 旧: 「{name} の詳細」→ 横にカラー選択を並べるためコンパクト化。
    elements.characterManagerHeading.textContent = character.name || character.id || "キャラ";
  }
  elements.characterManagerMeta.textContent = `${originLabel(character.origin)} / ${character.assetRoot || "素材パス未取得"} / ${character.readOnly ? "編集画面プリセット READ ONLY" : "プロジェクト編集可"}`;
  elements.saveCharacterManagerButton.disabled = !hasAssetRoot;
  elements.deleteCharacterManagerButton.disabled = !hasAssetRoot || character.origin !== "project";
  populateVoiceSelectorsForManager(character.voice || { id: "", emotion: "" });
  applyColorToManagerForm(character.color || "");
}

function applyColorToManagerForm(colorValue) {
  const fallback = accentColorFallback();
  const raw = normalizeColorValue(colorValue, fallback);
  const hasExplicit = /^#[0-9a-f]{6}$/i.test(String(colorValue || "").trim());
  if (elements.characterManagerColor) {
    elements.characterManagerColor.value = hasExplicit ? raw : fallback;
    if (hasExplicit) {
      elements.characterManagerColor.dataset.assigned = "1";
    } else {
      delete elements.characterManagerColor.dataset.assigned;
    }
  }
  if (elements.characterManagerColorValue) {
    elements.characterManagerColorValue.textContent = hasExplicit ? raw : "未指定";
    elements.characterManagerColorValue.style.setProperty(
      "--color-value",
      hasExplicit ? raw : fallback,
    );
  }
}

function populateVoiceSelectorsForManager(voice) {
  const narratorSelect = elements.characterManagerVoiceSelect;
  const hint = elements.characterManagerVoiceHint;
  const available = ttsAvailable();
  // voice.id は VOICEVOX なら "voicevox:{narrator}/{style}" の合体形式。
  // 話者・声 2 セレクタへ分配するため (narratorKey, style) に分解する。
  const { narratorKey, style } = splitVoiceId(voice?.id || "", voice?.emotion || "");
  if (narratorSelect) {
    narratorSelect.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "未設定";
    narratorSelect.append(noneOpt);
    for (const n of ttsNarratorList()) {
      const opt = document.createElement("option");
      opt.value = n.id;
      opt.textContent = n.label || n.id;
      narratorSelect.append(opt);
    }
    // カタログ未登録の話者でも option を生やして選択値を維持する
    if (narratorKey && !Array.from(narratorSelect.options).some((o) => o.value === narratorKey)) {
      const opt = document.createElement("option");
      opt.value = narratorKey;
      opt.textContent = `${narratorKey}（カタログ未登録）`;
      narratorSelect.append(opt);
    }
    narratorSelect.value = narratorKey;
    narratorSelect.disabled = !available;
  }
  populateStyleSelectorForManager(narratorKey, style);
  if (hint) {
    if (!available) {
      hint.textContent =
        "VOICEVOX / Voicepeak が検出されていないか、ボイスが未登録です（全体設定 → 音声読み上げ で「ボイスを登録」を押してください）";
    } else {
      hint.textContent =
        "セリフごとに上書き可能です。ここで指定したものは「話者」キャラクターを切り替えたときに使われます。";
    }
  }
}

function populateStyleSelectorForManager(narratorKey, style) {
  const select = elements.characterManagerVoiceEmotion;
  if (!select) return;
  select.innerHTML = "";
  const isVoicevox = String(narratorKey || "").startsWith("voicevox:");
  // VOICEVOX は style 必須なのでプレースホルダ「ノーマル (= 空 value)」は出さない。
  // 出すと実 style "ノーマル" と二重表示 + voice.id が壊れて保存される事故になる。
  // Voicepeak は emotion 未指定 = ノーマル相当なので空 value のプレースホルダを置く。
  if (!isVoicevox) {
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "ノーマル";
    select.append(noneOpt);
  }
  const styles = ttsStyleListForNarrator(narratorKey);
  for (const e of styles) {
    const opt = document.createElement("option");
    opt.value = e;
    opt.textContent = e;
    select.append(opt);
  }
  // 旧データ / カタログ未登録のスタイルでも option を補って維持する
  if (style && !styles.includes(style)) {
    const opt = document.createElement("option");
    opt.value = style;
    opt.textContent = `${style}（未対応）`;
    select.append(opt);
  }
  // VOICEVOX で style 未指定の場合は先頭 style に倒す (壊れた voice.id 防止)。
  let valueToSet = style || "";
  if (isVoicevox && !valueToSet && styles.length > 0) {
    valueToSet = styles[0];
  }
  select.value = valueToSet;
  // 候補スタイルが無く、かつ既存値も無いなら disable (= ノーマル固定)
  select.disabled = !ttsAvailable() || (styles.length === 0 && !valueToSet);
}

export async function openCharacterManager(targetAssetRoot = null) {
  await loadProjects();
  await refreshCharacterManagerManifest();
  const defs = characterDefinitions();
  const target = targetAssetRoot
    ? defs.find((item) => item.assetRoot === targetAssetRoot) || null
    : null;
  if (target) {
    loadCharacterManagerForm(target);
  } else {
    elements.characterManagerAssetRoot.value = "";
    elements.characterManagerId.value = "";
    if (elements.characterManagerIdDisplay) {
      elements.characterManagerIdDisplay.textContent = "—";
    }
    elements.characterManagerName.value = "";
    elements.characterManagerMeta.textContent = "キャラクターが見つかりません";
    if (elements.characterManagerHeading) {
      elements.characterManagerHeading.textContent = "キャラ詳細";
    }
    elements.saveCharacterManagerButton.disabled = true;
    elements.deleteCharacterManagerButton.disabled = true;
    applyColorToManagerForm("");
  }
  elements.characterManagerDialog.showModal();
  deps.centerDialog(elements.characterManagerDialog);
}

export async function saveCharacterManager() {
  const assetRoot = elements.characterManagerAssetRoot.value;
  if (!assetRoot) {
    showToast("キャラクターを選択してください", "error");
    return;
  }
  const narratorKey = elements.characterManagerVoiceSelect?.value || "";
  const styleValue = elements.characterManagerVoiceEmotion?.value || "";
  const voicePersist = combineNarratorAndStyle(narratorKey, styleValue);
  const colorAssigned = elements.characterManagerColor?.dataset?.assigned === "1";
  const colorValue = colorAssigned
    ? normalizeColorValue(elements.characterManagerColor?.value || "", accentColorFallback())
    : "";
  const response = await fetch("/api/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assetRoot,
      characterId: elements.characterManagerId.value,
      name: elements.characterManagerName.value,
      character: {
        x: Number(elements.characterManagerX.value),
        y: Number(elements.characterManagerY.value),
        scale: Number(elements.characterManagerScale.value),
      },
      removeWhite: elements.characterManagerRemoveWhite.checked,
      voice: voicePersist,
      color: colorValue,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  state.manifest = result.manifest;
  if (state.activeProjectId) {
    deps.fillAssetControls();
    deps.fillConfigForm();
    renderCutList();
    renderPreview();
    // 編集中カットの「声」「感情」セレクタを最新の紐付けで同期し直す
    deps.syncDialogueVoiceFromSpeaker();
  }
  const updated = characterDefinitions().find((item) => item.assetRoot === assetRoot);
  if (updated) {
    loadCharacterManagerForm(updated);
  }
  showToast("キャラクター定義を保存しました");
}

export async function deleteCharacterManagerCharacter() {
  const assetRoot = elements.characterManagerAssetRoot.value;
  const character = characterDefinitions().find((item) => item.assetRoot === assetRoot);
  if (!assetRoot || !character) {
    showToast("キャラクターを選択してください", "error");
    return;
  }
  if (character.origin !== "project") {
    showToast("削除できるのはプロジェクトキャラクターだけです", "error");
    return;
  }
  if (!window.confirm(`${character.name || character.id} を素材ファイルごと削除します。よろしいですか？`)) {
    return;
  }
  const response = await fetch("/api/characters", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assetRoot,
      characterId: character.id,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  state.manifest = result.manifest;
  if (result.scenario) {
    state.scenario = attachScenarioCutsAlias(result.scenario);
    state.selectedCutIndex = clamp(state.selectedCutIndex, 0, state.scenario.cuts.length - 1);
    loadCutIntoEditor(currentCut());
  }
  deps.fillAssetControls();
  deps.fillConfigForm();
  renderCutList();
  renderPreview();
  elements.characterManagerDialog.close();
  showToast("プロジェクトキャラクターを削除しました");
}
