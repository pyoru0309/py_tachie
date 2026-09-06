import { state } from "./state.js";
import { elements } from "./elements.js";
import { option, fillSelect, clamp } from "./utils.js";
import { showToast } from "./toast.js";
import { recordHistory } from "./history.js";
import { secToFrames } from "./timecode.js";
import { synthesizeBatchItem } from "./scenario-actions.js";
import { promptBulkApply } from "./dialog.js";

let deps = {
  handleEditorChanged: () => {},
  ensureSelectValue: () => {},
  syncPresetName: () => {},
  fillExpressionPresets: () => {},
  // 配置プリセット (X / Y / 拡大率)。表情プリセットとは独立系統。
  fillPlacementPresets: () => {},
  updateSelectedCutFromCurrent: () => {},
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  syncDialogueVoiceFromSpeaker: () => {},
  reloadCurrentCut: async () => {},
  // M-1: モーション入力の collect / apply / 表示制御。
  collectCutMotionSettings: () => ({}),
  applyCutMotionSettingsToControls: () => {},
  syncMotionParamsVisibility: () => {},
};

export function bindCharacter(injectedDeps) {
  deps = { ...deps, ...injectedDeps };
  setupFrontMultiSelect();
}

// === 前面オブジェクト multi-select 内部状態 ===
let frontItems = [];
const frontSelectedSet = new Set();
let frontFilterText = "";
let frontWired = false;

export function characterDefinitions() {
  return state.manifest?.characters?.length ? state.manifest.characters : [];
}

export function characterDefinitionById(characterId) {
  if (!characterId) return null;
  return characterDefinitions().find((item) => item.id === characterId) || null;
}

export function accentColorFallback() {
  // CSS 変数 --accent の現在値を取得（HEX 6桁に正規化）。
  // 取得できないときは tokens.css の既定 (#0f6f69) を返す。
  try {
    const v = (getComputedStyle(document.documentElement)
      .getPropertyValue("--accent") || "")
      .trim()
      .toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    if (/^#[0-9a-f]{3}$/.test(v)) {
      return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    }
  } catch (_e) {}
  return "#0f6f69";
}

// 話者キャラクターの定義色を返す。manifest.color が空なら null。
export function characterColorById(characterId) {
  const def = characterDefinitionById(characterId);
  const raw = String(def?.color || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  return null;
}

export function originLabel(origin) {
  if (origin === "common") return "共通";
  if (origin === "project") return "プロジェクト";
  if (origin === "legacy") return "互換";
  return origin || "不明";
}

// 「モカ（CID: moca_py / 共通 / READ ONLY）」形式の表示ラベル。
// 同じ表示名のキャラを CID で区別できるようにする。
export function characterSelectLabel(item) {
  const name = item?.name || item?.id || "";
  const cid = item?.id || "";
  const parts = [];
  if (cid) parts.push(`CID: ${cid}`);
  parts.push(originLabel(item?.origin));
  if (item?.readOnly) parts.push("READ ONLY");
  return `${name}（${parts.join(" / ")}）`;
}

export function characterDefinitionItems() {
  const usedCharacterIds = new Set(state.currentCharacters.map((character) => character.characterId));
  return characterDefinitions().filter((item) => !usedCharacterIds.has(item.id)).map((item) => ({
    id: item.id,
    name: characterSelectLabel(item),
  }));
}

// 指定キャラクター定義に紐付く expressionPresets を、project + asset 両方から
// 統合した state.manifest.expressionPresets から取り出して返す。
function expressionPresetsForCharacter(characterId) {
  if (!characterId) return [];
  const all = state.manifest?.expressionPresets || [];
  return all.filter((p) => !p?.characterId || p.characterId === characterId);
}

// キャラ定義側の「デフォルト表情プリセット」を返す。優先順:
//   1. expressionPresets で isDefault=true の最初の 1 件
//   2. 1 件もない場合は null
export function defaultExpressionPresetFor(characterId) {
  const presets = expressionPresetsForCharacter(characterId);
  return presets.find((p) => p?.isDefault) || null;
}

export function defaultCharacter(index = 0, preferredCharacterId = null) {
  const defaults = state.manifest?.defaults || {};
  const characterDef =
    characterDefinitionById(preferredCharacterId) || characterDefinitions()[0] || null;
  const characterDefaults = characterDef?.defaults || {};
  // 髪型プリセットの default が指定されている場合、その baseId を初期 baseId として
  // 採用する。プリセットは (base + 前髪 + 後ろ髪) のセットなので、新規キャラの
  // baseId は preset.baseId に同期させておく方がプリセット選択挙動と一貫する。
  // server 側 resolve_character_paths は cut.state.baseId を権威とするため、
  // ここで sync しないと「default preset が指定する base」と「実際にレンダリング
  // される base」が乖離する。
  const defaultPreset = (characterDef?.hairstylePresets || []).find((p) => p?.isDefault);
  const presetBaseId = defaultPreset?.baseId || "";
  // 表情プリセットの default が指定されていれば、その cheek/eye/mouth ID を新キャラの
  // 初期表情に採用する (プレビューが空白で上がってくる UX を回避)。
  const defaultExpr = defaultExpressionPresetFor(characterDef?.id || "");
  return {
    id: `character_${Date.now()}_${index + 1}`,
    name: characterDef?.name || `キャラクター${index + 1}`,
    characterId: characterDef?.id || "default",
    baseId: presetBaseId || characterDefaults.baseId || "",
    cheekId: defaultExpr?.cheekId || "",
    eyeId: defaultExpr?.eyeId || "",
    mouthId: defaultExpr?.mouthId || "",
    // Phase 4+7: 個別 bangs 選択は廃止。髪型プリセットで base+bangs+back_hair を選ぶ。
    // アセット側 default があれば auto-select、無ければ「なし」(空文字)。
    hairstylePresetId: defaultPreset?.id || "",
    frontIds: [],
    eyeAboveBangs: false,
    // PSD 由来は import_manifest.yml の指定に従って false で来ることが多い。
    // characterDefaults / defaults いずれも未指定なら false (= 透過扱いなし) を採用。
    removeWhite: characterDefaults.removeWhite ?? defaults.removeWhite ?? false,
    showCharacter: true,
    // 左右反転 (v2): character.scale は負数化しない方針。flipX を別フィールド
    // にして scene-builder 側でキャラ本体 + silhouette のみ反転する。
    flipX: false,
    character: {
      x: characterDefaults.character?.x ?? defaults.character?.x ?? 448,
      y: characterDefaults.character?.y ?? defaults.character?.y ?? 0,
      scale: characterDefaults.character?.scale ?? defaults.character?.scale ?? 1,
    },
  };
}

export function characterAssetItems(character, key) {
  const characterDef = characterDefinitionById(character?.characterId);
  const items = characterDef?.[key];
  return Array.isArray(items) ? items : [];
}

// 目パチ・口パクのフラグに応じた表示用 suffix。manifest 上の name は変えず、
// セレクタやリストの表示時にだけこの文字列を付加する。
const EYE_FLAG_SUFFIXES = [
  ["blinkOpen", "（開き）"],
  ["blinkHalf", "（中間）"],
  ["blinkClosed", "（閉じ）"],
];
const MOUTH_FLAG_SUFFIXES = [
  ["lipClosed", "（閉じ）"],
  ["lipMid", "（中間）"],
  ["lipOpen", "（開き）"],
];

function decorateAnimationItems(items, flagOrder) {
  return (items || []).map((item) => {
    const flags = item?.flags || {};
    const suffixes = flagOrder
      .filter(([key]) => flags[key])
      .map(([, label]) => label);
    if (!suffixes.length) return item;
    return { ...item, name: `${item.name || item.id}${suffixes.join("")}` };
  });
}

export function fillCharacterAssetControls(character) {
  if (!character) {
    fillSelect(elements.base, [], true, true);
    fillSelect(elements.cheek, [], true, true);
    fillSelect(elements.eye, [], true, true);
    fillSelect(elements.mouth, [], true, true);
    if (elements.hairstylePreset) fillSelect(elements.hairstylePreset, [], true, true);
    renderFrontCheckboxes([], []);
    return;
  }
  fillSelect(elements.base, characterAssetItems(character, "bases"), true, true);
  fillSelect(elements.cheek, characterAssetItems(character, "cheeks"), true, true);
  // eye / mouth は flags を見て name に suffix を付けたコピーを渡す (元 manifest は不変)。
  fillSelect(
    elements.eye,
    decorateAnimationItems(characterAssetItems(character, "eyes"), EYE_FLAG_SUFFIXES),
    true,
    true,
  );
  fillSelect(
    elements.mouth,
    decorateAnimationItems(characterAssetItems(character, "mouths"), MOUTH_FLAG_SUFFIXES),
    true,
    true,
  );
  // 髪型プリセット (asset 側 hairstyle_presets.json から)。isDefault に ★ を付与。
  if (elements.hairstylePreset) {
    const hairstylePresets = characterAssetItems(character, "hairstylePresets");
    const decorated = hairstylePresets.map((p) =>
      p?.isDefault ? { ...p, name: `${p.name || p.id} ★` } : p,
    );
    fillSelect(elements.hairstylePreset, decorated, true, true);
  }
  renderFrontCheckboxes(characterAssetItems(character, "fronts"), character.frontIds || []);
}

export function renderFrontCheckboxes(items, selectedIds) {
  if (!elements.frontMultiSelect) return;
  frontItems = Array.isArray(items) ? items.filter((it) => it && it.id) : [];
  frontSelectedSet.clear();
  const validIds = new Set(frontItems.map((it) => String(it.id)));
  for (const id of selectedIds || []) {
    const key = String(id);
    if (validIds.has(key)) frontSelectedSet.add(key);
  }
  renderFrontChips();
  renderFrontOptions();
}

export function readFrontIdsFromCheckboxes() {
  // items の順を維持して返す
  return frontItems.map((it) => String(it.id)).filter((id) => frontSelectedSet.has(id));
}

function renderFrontChips() {
  if (!elements.frontChips) return;
  elements.frontChips.innerHTML = "";
  const order = readFrontIdsFromCheckboxes();
  for (const id of order) {
    const item = frontItems.find((it) => String(it.id) === id);
    if (!item) continue;
    const chip = document.createElement("span");
    chip.className = "multi-select-chip";
    const label = document.createElement("span");
    label.className = "multi-select-chip-label";
    label.textContent = item.name || item.id;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "multi-select-chip-remove";
    remove.title = "選択解除";
    remove.setAttribute("aria-label", `${item.name || item.id} を解除`);
    remove.innerHTML = '<span class="msym" aria-hidden="true">close</span>';
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFrontSelected(id, false);
    });
    chip.append(label, remove);
    elements.frontChips.append(chip);
  }
}

function renderFrontOptions() {
  if (!elements.frontOptions) return;
  elements.frontOptions.innerHTML = "";
  if (!frontItems.length) {
    const empty = document.createElement("div");
    empty.className = "multi-select-empty";
    empty.textContent = "前面オブジェクトなし";
    elements.frontOptions.append(empty);
    return;
  }
  const filter = (frontFilterText || "").trim().toLowerCase();
  let visibleCount = 0;
  for (const item of frontItems) {
    const id = String(item.id);
    const name = item.name || item.id || "";
    const label = document.createElement("label");
    label.className = "multi-select-option";
    label.dataset.id = id;
    if (filter && !name.toLowerCase().includes(filter)) {
      label.hidden = true;
    } else {
      visibleCount += 1;
    }
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = id;
    checkbox.checked = frontSelectedSet.has(id);
    checkbox.addEventListener("change", () => {
      toggleFrontSelected(id, checkbox.checked);
    });
    const span = document.createElement("span");
    span.textContent = name;
    label.append(checkbox, span);
    elements.frontOptions.append(label);
  }
  if (filter && visibleCount === 0) {
    const empty = document.createElement("div");
    empty.className = "multi-select-empty";
    empty.textContent = "一致する項目はありません";
    elements.frontOptions.append(empty);
  }
}

function toggleFrontSelected(id, on) {
  if (on) frontSelectedSet.add(id);
  else frontSelectedSet.delete(id);
  renderFrontChips();
  // 開いているリストのチェック状態も同期
  const checkbox = elements.frontOptions?.querySelector(`.multi-select-option[data-id="${CSS.escape(id)}"] input[type="checkbox"]`);
  if (checkbox) checkbox.checked = on;
  deps.handleEditorChanged();
}

function setFrontPopoverOpen(open) {
  if (!elements.frontMultiSelect || !elements.frontList) return;
  elements.frontMultiSelect.dataset.state = open ? "open" : "closed";
  elements.frontList.hidden = !open;
  elements.frontMultiSelectTrigger?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    requestAnimationFrame(() => elements.frontFilter?.focus());
  }
}

function setupFrontMultiSelect() {
  if (frontWired || !elements.frontMultiSelect) return;
  frontWired = true;
  setFrontPopoverOpen(false);
  elements.frontMultiSelectTrigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = elements.frontMultiSelect.dataset.state === "open";
    setFrontPopoverOpen(!isOpen);
  });
  elements.frontFilter?.addEventListener("input", (event) => {
    frontFilterText = event.target.value || "";
    renderFrontOptions();
  });
  document.addEventListener("click", (event) => {
    if (!elements.frontMultiSelect) return;
    if (elements.frontMultiSelect.dataset.state !== "open") return;
    if (elements.frontMultiSelect.contains(event.target)) return;
    setFrontPopoverOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.frontMultiSelect?.dataset.state === "open") {
      setFrontPopoverOpen(false);
    }
  });
}

export function fillCharacterDefinitionAddSelect() {
  const selected = elements.characterDefinition.value;
  const items = characterDefinitionItems();
  fillSelect(elements.characterDefinition, items, false);
  if (items.some((item) => item.id === selected)) {
    elements.characterDefinition.value = selected;
  }
  elements.addCharacterButton.disabled = items.length === 0;
  // 置換セクションのセレクタも同じ契機 (キャラ追加・削除・cut 切替・プロジェクト初期化)
  // で更新する。state.scenario.cuts を走査するので、シナリオ書き換え時には呼び出し側
  // で別途呼ぶ必要あり (replaceCharacterAcrossAllCuts 末尾参照)。
  fillReplaceCharacterSelects();
}

export function normalizeCutCharacters(data) {
  // サーバ側 normalize_cut_state が v4 形式に揃えてくれるのでフロントは
  // ID-based のフィールドだけに揃え、UI 表示用のデフォルトを補完する。
  const characters = Array.isArray(data.characters) ? data.characters : [];
  return characters.map((item, index) => {
    const hasDefinition = Boolean(characterDefinitionById(item.characterId));
    const defaults = defaultCharacter(index, hasDefinition ? item.characterId : null);
    return {
      ...defaults,
      ...(hasDefinition ? item : {}),
      id: item.id || `character_${Date.now()}_${index + 1}`,
      name: item.name || defaults.name || `キャラクター${index + 1}`,
      characterId: hasDefinition ? item.characterId : defaults.characterId,
      frontIds: Array.isArray(item.frontIds) ? [...item.frontIds] : [],
      eyeAboveBangs: Boolean(item.eyeAboveBangs),
      flipX: Boolean(item.flipX),
      character: {
        ...defaults.character,
        ...(item.character || {}),
      },
      // B-1: マルチキャラレイアウト用フィールド。orphan キャラでも保持する
      // (= 後で素材を再インポートすれば layout 設定はそのまま生きる)。
      layoutSlot: Number.isInteger(item.layoutSlot) && item.layoutSlot >= 0 ? item.layoutSlot : null,
      crop: _validateCropFromServer(item.crop),
      // M-1: per-character motion ({type, settings})。未設定 (null/undefined) は
      // "動かない" 扱い。旧 scene global motion はサーバ側 normalize で話者キャラへ
      // 移植済みのため、ここでは透過的に保持するだけで OK。
      motion: _validateMotionFromServer(item.motion),
      bob: _validateBobFromServer(item.bob),
    };
  });
}

function _validateMotionFromServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "none");
  if (type === "none") return null;
  if (!["shake_x", "shake_y", "zoom", "move"].includes(type)) return null;
  const settings = (raw.settings && typeof raw.settings === "object") ? { ...raw.settings } : {};
  return { type, settings };
}

function _validateBobFromServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const bpm = Number(raw.bpm);
  const amplitudePx = Number(raw.amplitudePx);
  if (!(bpm > 0) || !(amplitudePx > 0)) return null;
  return { bpm, amplitudePx };
}

// crop オブジェクトを { x, y, width, height } のみに限定して受け入れる。
// width/height が 0 以下 / NaN なら null (= 無効) に倒す。
function _validateCropFromServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

export function selectedCharacter() {
  if (state.currentCharacters.length === 0) {
    return null;
  }
  state.selectedCharacterIndex = clamp(state.selectedCharacterIndex, 0, state.currentCharacters.length - 1);
  return state.currentCharacters[state.selectedCharacterIndex];
}

export function updateSelectedCharacterFromControls() {
  if (state.currentCharacters.length === 0) {
    return;
  }
  const character = selectedCharacter();
  if (!character) {
    return;
  }
  Object.assign(character, {
    baseId: elements.base.value,
    cheekId: elements.cheek.value,
    eyeId: elements.eye.value,
    mouthId: elements.mouth.value,
    hairstylePresetId: elements.hairstylePreset?.value || "",
    frontIds: readFrontIdsFromCheckboxes(),
    eyeAboveBangs: Boolean(elements.eyeAboveBangs?.checked),
    flipX: Boolean(elements.characterFlipX?.checked),
    removeWhite: elements.characterRemoveWhite.checked,
    // 「キャラクターを表示」は cut 全体に効かせる仕様 (お芝居タブ) のため、
    // ここでは selected character には書き込まない。handleEditorChanged 側で
    // 全 character に一括伝搬する。
    character: {
      x: Number(elements.characterX.value),
      y: Number(elements.characterY.value),
      scale: Number(elements.characterScale.value),
    },
    // M-1: per-character motion ({type, settings})。motionType セレクタが "none"
    // のときは null = 何も動かない。それ以外は {type, settings} オブジェクト。
    motion: _collectMotionForCharacterFromControls(),
    // BPM 上下ゆれ (bob)。motion とは独立。bpm/振幅どちらか 0 なら null。
    bob: _collectBobForCharacterFromControls(),
  });
}

function _collectMotionForCharacterFromControls() {
  const type = elements.motionType?.value || "none";
  if (type === "none") return null;
  return { type, settings: deps.collectCutMotionSettings() };
}

function _collectBobForCharacterFromControls() {
  const bpm = Number(elements.characterBobBpm?.value) || 0;
  const amplitudePx = Number(elements.characterBobAmplitude?.value) || 0;
  if (!(bpm > 0) || !(amplitudePx > 0)) return null;
  return { bpm, amplitudePx };
}

export function loadCharacterIntoControls(character) {
  const hasCharacter = Boolean(character);
  for (const element of [
    elements.base,
    elements.expressionPreset,
    elements.cheek,
    elements.eye,
    elements.mouth,
    elements.hairstylePreset,
    elements.eyeAboveBangs,
    elements.characterFlipX,
    elements.characterRemoveWhite,
    elements.showCharacter,
    elements.characterX,
    elements.characterY,
    elements.characterScale,
    elements.centerCharacterButton,
    elements.resetCharacterButton,
    elements.savePresetButton,
    elements.deletePresetButton,
    elements.presetName,
  ]) {
    if (element) element.disabled = !hasCharacter;
  }
  if (!character) {
    fillCharacterAssetControls(null);
    elements.base.value = "";
    elements.cheek.value = "";
    elements.eye.value = "";
    elements.mouth.value = "";
    if (elements.hairstylePreset) elements.hairstylePreset.value = "";
    if (elements.eyeAboveBangs) elements.eyeAboveBangs.checked = false;
    if (elements.characterFlipX) elements.characterFlipX.checked = false;
    elements.characterRemoveWhite.checked = state.manifest.defaults.removeWhite ?? true;
    // showCharacter は cut 全体共通フラグ (loadCut 側で集約値を復元) のため
    // ここでは触らない。
    elements.characterX.value = state.manifest.defaults.character?.x ?? 448;
    elements.characterY.value = state.manifest.defaults.character?.y ?? 0;
    elements.characterScale.value = state.manifest.defaults.character?.scale ?? 1;
    // M-1: キャラなし状態は motionType=none で入力をリセット。
    if (elements.motionType) elements.motionType.value = "none";
    deps.applyCutMotionSettingsToControls(null);
    deps.syncMotionParamsVisibility();
    if (elements.characterBobBpm) elements.characterBobBpm.value = "0";
    if (elements.characterBobAmplitude) elements.characterBobAmplitude.value = "0";
    fillCharacterDefinitionAddSelect();
    deps.fillExpressionPresets("");
    deps.fillPlacementPresets("");
    return;
  }
  fillCharacterAssetControls(character);
  deps.ensureSelectValue(elements.base, character.baseId || "");
  deps.ensureSelectValue(elements.cheek, character.cheekId || "");
  deps.ensureSelectValue(elements.eye, character.eyeId || "");
  deps.ensureSelectValue(elements.mouth, character.mouthId || "");
  if (elements.hairstylePreset) {
    deps.ensureSelectValue(elements.hairstylePreset, character.hairstylePresetId || "");
  }
  elements.base.value = character.baseId || "";
  elements.cheek.value = character.cheekId || "";
  elements.eye.value = character.eyeId || "";
  elements.mouth.value = character.mouthId || "";
  if (elements.hairstylePreset) {
    elements.hairstylePreset.value = character.hairstylePresetId || "";
  }
  if (elements.eyeAboveBangs) {
    elements.eyeAboveBangs.checked = Boolean(character.eyeAboveBangs);
  }
  if (elements.characterFlipX) {
    elements.characterFlipX.checked = Boolean(character.flipX);
  }
  elements.characterRemoveWhite.checked = character.removeWhite ?? state.manifest.defaults.removeWhite ?? true;
  // showCharacter は cut 全体共通フラグ (loadCut 側で集約値を復元) のため
  // キャラ切替時にここで書き換えない。
  elements.characterX.value = character.character?.x ?? state.manifest.defaults.character.x;
  elements.characterY.value = character.character?.y ?? state.manifest.defaults.character.y;
  elements.characterScale.value = character.character?.scale ?? state.manifest.defaults.character.scale;
  // M-1: キャラ切替時に motionType + パラメータを input に反映。motion 未設定キャラは
  // "none" 表示。
  if (elements.motionType) {
    elements.motionType.value = character.motion?.type || "none";
  }
  deps.applyCutMotionSettingsToControls(character.motion?.settings);
  deps.syncMotionParamsVisibility();
  // BPM 上下ゆれ。未設定キャラは 0 (= 無効) 表示。
  if (elements.characterBobBpm) {
    elements.characterBobBpm.value = String(Number(character.bob?.bpm) || 0);
  }
  if (elements.characterBobAmplitude) {
    elements.characterBobAmplitude.value = String(Number(character.bob?.amplitudePx) || 0);
  }
  // 表情プリセットセレクタを (character.characterId に紐付く) 最新候補で再構築する。
  // これをやらないと、loadCut 経路で character は表示されているのに preset セレクタが
  // 「なし」のまま残るバグが出る (project 初期化時の fillAssetControls は state.
  // currentCharacters がまだ空なので、selectedCharacter() が null を返して空 preset
  // 一覧で埋まってしまうため)。現在の cheek/eye/mouth に合致するプリセットがあれば
  // それを選択値に、なければ ""。
  const matchingPreset = (state.manifest?.expressionPresets || []).find(
    (p) =>
      (!p.characterId || p.characterId === character.characterId)
      && p.cheekId === (character.cheekId || "")
      && p.eyeId === (character.eyeId || "")
      && p.mouthId === (character.mouthId || ""),
  );
  deps.fillExpressionPresets(matchingPreset?.id || "");
  deps.syncPresetName();
  // 配置プリセットは「現在の X/Y/拡大率 に一致するものがあれば自動選択」なので
  // 引数なしで呼ぶ (fillPlacementPresets 内で照合する)。
  deps.fillPlacementPresets();
  fillCharacterDefinitionAddSelect();
}

export function renderCharacterSelect() {
  elements.cutCharacter.innerHTML = "";
  if (state.currentCharacters.length === 0) {
    elements.cutCharacter.append(option("なし", ""));
    state.selectedCharacterIndex = 0;
    elements.deleteCharacterButton.disabled = true;
    elements.moveCharacterUpButton.disabled = true;
    elements.moveCharacterDownButton.disabled = true;
    renderSpeakerSelect("");
    fillCharacterDefinitionAddSelect();
    updateCutCharacterInstanceIdLabel();
    updateCharacterLayoutButtonAvailability();
    return;
  }
  state.currentCharacters.forEach((character, index) => {
    const characterDef = characterDefinitionById(character.characterId);
    const source = characterDef ? ` / ${originLabel(characterDef.origin)}` : "";
    elements.cutCharacter.append(
      option(`${index + 1}. ${character.name || `キャラクター${index + 1}`}${source}`, String(index))
    );
  });
  elements.cutCharacter.value = String(state.selectedCharacterIndex);
  elements.deleteCharacterButton.disabled = state.currentCharacters.length === 0;
  elements.moveCharacterUpButton.disabled = state.selectedCharacterIndex <= 0;
  elements.moveCharacterDownButton.disabled = state.selectedCharacterIndex >= state.currentCharacters.length - 1;
  renderSpeakerSelect(elements.speakerCharacter.value);
  updateCutCharacterInstanceIdLabel();
  updateCharacterLayoutButtonAvailability();
}

// 「キャラを配置」ボタンはカット内 2 キャラ以上のときだけ有効。
// renderCharacterSelect 経由で常に最新の characters.length を反映する。
function updateCharacterLayoutButtonAvailability() {
  const button = elements.openCharacterLayoutButton;
  if (!button) return;
  button.disabled = (state.currentCharacters?.length || 0) < 2;
}

// 「登場キャラ」ラベル横に、現在編集中の登場キャラのインスタンス ID
// (cut.state.characters[].id, 例: character_1234567_2) を表示する。
// クリック / フォーカスでテキストが選択されるので、エクスポート YAML の
// speaker 値とコピペで突合できる。
export function updateCutCharacterInstanceIdLabel() {
  const el = elements.cutCharacterInstanceId;
  if (!el) return;
  const ch = state.currentCharacters[state.selectedCharacterIndex];
  if (!ch || !ch.id) {
    el.textContent = "—";
    el.title = "";
    return;
  }
  el.textContent = ch.id;
  el.title = "クリックでコピー: " + ch.id;
}

export function renderSpeakerSelect(selectedId = elements.speakerCharacter.value) {
  const currentValue = selectedId || "";
  fillSelect(
    elements.speakerCharacter,
    state.currentCharacters.map((character, index) => ({
      id: character.id,
      name: `${index + 1}. ${character.name || `キャラクター${index + 1}`}`,
    })),
    true
  );
  if (state.currentCharacters.some((character) => character.id === currentValue)) {
    elements.speakerCharacter.value = currentValue;
  } else if (currentValue && state.currentCharacters.length > 0) {
    // currentValue が削除されたキャラ等を指す無効値の場合、先頭キャラに繰り上げる。
    // (旧実装は dialogue.value.trim() を要求していたが、音声のみ・空文字 dialogue
    //  でも口パクを動かしたいケースがあるため、無効値ならいつでも繰り上げる。)
    // currentValue が空文字 (= ユーザーが「なし」を選択) の場合は変更しない。
    elements.speakerCharacter.value = state.currentCharacters[0].id;
  }
}

export function normalizedSpeakerCharacterId(value = elements.speakerCharacter.value) {
  if (state.currentCharacters.some((character) => character.id === value)) {
    return value;
  }
  // value が空文字 = 明示的に「なし」 → そのまま空。
  // value が無効 ID (削除されたキャラ等) → 先頭キャラに繰り上げる。
  if (!value) {
    return "";
  }
  return state.currentCharacters.length > 0 ? state.currentCharacters[0].id : "";
}

export async function resolveCharacterLayerWidth(character) {
  if (!character) return 1024;
  const cached = state.characterLayerSizes.get(character.id);
  if (cached?.width) return cached.width;
  // base / cheek / eye / mouth / bangs / back_hair / fronts のうち画像から先読みして size を取得する。
  const def = characterDefinitionById(character.characterId);
  if (!def) return 1024;
  const items = [
    ...(def.bases || []),
    ...(def.cheeks || []),
    ...(def.eyes || []),
    ...(def.mouths || []),
    ...(def.bangs || []),
    ...(def.backHairs || []),
    ...(def.fronts || []),
  ];
  const baseId = character.baseId;
  const target =
    items.find((item) => item.id === baseId) ||
    (def.bases || [])[0] ||
    items[0];
  if (!target?.path) return 1024;
  try {
    const size = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = reject;
      img.src = `/assets/${target.path}`;
    });
    if (size.width && size.height) {
      state.characterLayerSizes.set(character.id, size);
      return size.width;
    }
  } catch (error) {
    console.error(error);
  }
  return 1024;
}

export async function centerCharacter() {
  const character = selectedCharacter();
  if (!character) {
    showToast("登場キャラを追加してください", "error");
    return;
  }
  const scale = Number(elements.characterScale.value) || state.manifest.defaults.character.scale || 1;
  const layerWidth = await resolveCharacterLayerWidth(character);
  elements.characterX.value = Math.round((1920 - layerWidth * scale) / 2);
  deps.updateSelectedCutFromCurrent();
  deps.scheduleScenarioSave();
  deps.renderPreview();
  recordHistory();
  showToast("左右中央に配置しました");
}

export function resetCharacter() {
  if (!selectedCharacter()) {
    showToast("登場キャラを追加してください", "error");
    return;
  }
  const defaults = state.manifest.defaults.character;
  elements.characterX.value = defaults.x;
  elements.characterY.value = defaults.y;
  elements.characterScale.value = defaults.scale;
  deps.updateSelectedCutFromCurrent();
  deps.scheduleScenarioSave();
  deps.renderPreview();
  recordHistory();
  showToast("初期位置に戻しました");
}

export function selectCutCharacter(index) {
  if (state.currentCharacters.length === 0) {
    renderCharacterSelect();
    loadCharacterIntoControls(null);
    deps.fillExpressionPresets("");
    deps.renderPreview();
    return;
  }
  updateSelectedCharacterFromControls();
  state.selectedCharacterIndex = clamp(index, 0, state.currentCharacters.length - 1);
  renderCharacterSelect();
  loadCharacterIntoControls(selectedCharacter());
  deps.fillExpressionPresets("");
  // 編集中キャラ id を cut state へ反映 + 保存スケジュール。これがないと
  // disk 上の editingCharacterId が更新されず、再生→停止→同じカットへ
  // 戻ったときに前回の選択が復元されない。
  deps.updateSelectedCutFromCurrent();
  deps.scheduleScenarioSave();
  deps.renderPreview();
}

export function addCharacter() {
  updateSelectedCharacterFromControls();
  const sourceCharacterId = elements.characterDefinition.value || characterDefinitionItems()[0]?.id;
  if (!sourceCharacterId) {
    showToast("追加できる素材キャラがありません", "error");
    return;
  }
  const character = defaultCharacter(state.currentCharacters.length, sourceCharacterId);
  character.id = `character_${Date.now()}_${state.currentCharacters.length + 1}`;
  character.name = character.name || `キャラクター${state.currentCharacters.length + 1}`;
  const offset = state.currentCharacters.length * 80;
  character.character.x = (state.manifest.defaults.character?.x ?? 448) + offset;
  state.currentCharacters.push(character);
  state.selectedCharacterIndex = state.currentCharacters.length - 1;
  renderCharacterSelect();
  // 新規追加したキャラは話者に切り替える (1 人目は元々 speaker 未設定なので必ず採用、
  // 2 人目以降は「いま話す予定のキャラを追加した」直後の UX としても自然)。
  // これにより inactiveCharacterOpacity が明るく/暗くを切替え、お芝居タブの「話者」
  // セレクタが新キャラを指し、syncDialogueVoiceFromSpeaker で声まで更新される。
  if (elements.speakerCharacter) {
    elements.speakerCharacter.value = character.id;
  }
  renderSpeakerSelect(character.id);
  loadCharacterIntoControls(character);
  // 表情プリセットセレクタも default preset があれば自動選択しておく
  // (cheekId/eyeId/mouthId は defaultCharacter で既に埋まっている)。
  const defaultExpr = defaultExpressionPresetFor(sourceCharacterId);
  deps.fillExpressionPresets(defaultExpr?.id || "");
  deps.syncDialogueVoiceFromSpeaker();
  deps.updateSelectedCutFromCurrent();
  deps.scheduleScenarioSave();
  deps.renderPreview();
  recordHistory();
  showToast("キャラクターを追加しました");
}

export function deleteCharacter() {
  if (state.currentCharacters.length === 0) {
    return;
  }
  state.currentCharacters.splice(state.selectedCharacterIndex, 1);
  state.selectedCharacterIndex = clamp(state.selectedCharacterIndex, 0, state.currentCharacters.length - 1);
  // キャラ配置 (= 分割画面) はカット内 2 キャラ以上のときのみ機能する設計。
  // 削除で 1 体以下になった場合は「キャラを配置」ボタンが disabled になり
  // 解除手段がなくなるため、ここで強制的に layout / crop / layoutSlot をリセットする。
  let layoutCleared = false;
  const cut = state.scenario?.cuts?.find((c) => c.id === state.selectedCutId);
  if (cut?.state?.characterLayout && state.currentCharacters.length < 2) {
    cut.state.characterLayout = null;
    for (const ch of state.currentCharacters) {
      if (ch) {
        ch.crop = null;
        ch.layoutSlot = null;
      }
    }
    layoutCleared = true;
  }
  renderCharacterSelect();
  renderSpeakerSelect(elements.speakerCharacter.value);
  loadCharacterIntoControls(selectedCharacter());
  deps.fillExpressionPresets("");
  deps.updateSelectedCutFromCurrent();
  deps.scheduleScenarioSave();
  deps.renderPreview();
  recordHistory();
  showToast(layoutCleared
    ? "キャラクターを削除し、分割配置を解除しました"
    : "キャラクターを削除しました");
}

export function moveCharacter(delta) {
  updateSelectedCharacterFromControls();
  const nextIndex = state.selectedCharacterIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.currentCharacters.length) {
    return;
  }
  const [character] = state.currentCharacters.splice(state.selectedCharacterIndex, 1);
  state.currentCharacters.splice(nextIndex, 0, character);
  state.selectedCharacterIndex = nextIndex;
  renderCharacterSelect();
  renderSpeakerSelect(elements.speakerCharacter.value);
  loadCharacterIntoControls(character);
  deps.fillExpressionPresets("");
  deps.updateSelectedCutFromCurrent();
  deps.scheduleScenarioSave();
  deps.renderPreview();
  recordHistory();
  showToast("重ね順を変更しました");
}

// ===== キャラを置換 =====

// 置換セクションの 2 つの select を充填する。
// 「置換元」は現在のシナリオに 1 度でも配置されている characterId のみ。
// 「置換先」は manifest 内の全 characterId (配置済 / 未配置どちらも可)。
export function fillReplaceCharacterSelects() {
  if (!elements.replaceCharacterSource || !elements.replaceCharacterTarget) return;
  const cuts = state.scenario?.cuts || [];
  const placedIds = new Set();
  for (const cut of cuts) {
    for (const c of (cut.state?.characters || [])) {
      if (c?.characterId) placedIds.add(c.characterId);
    }
  }
  const allDefs = characterDefinitions();
  const sourceItems = allDefs
    .filter((d) => placedIds.has(d.id))
    .map((d) => ({ id: d.id, name: characterSelectLabel(d) }));
  const targetItems = allDefs
    .map((d) => ({ id: d.id, name: characterSelectLabel(d) }));
  const prevSource = elements.replaceCharacterSource.value;
  const prevTarget = elements.replaceCharacterTarget.value;
  fillSelect(elements.replaceCharacterSource, sourceItems, false);
  fillSelect(elements.replaceCharacterTarget, targetItems, false);
  if (sourceItems.some((it) => it.id === prevSource)) elements.replaceCharacterSource.value = prevSource;
  if (targetItems.some((it) => it.id === prevTarget)) elements.replaceCharacterTarget.value = prevTarget;
  if (elements.replaceCharacterButton) {
    elements.replaceCharacterButton.disabled = sourceItems.length === 0 || targetItems.length === 0;
  }
}

function setReplaceProgress(percent, label, logLine) {
  if (elements.replaceCharacterProgressArea) elements.replaceCharacterProgressArea.hidden = false;
  if (elements.replaceCharacterProgress) elements.replaceCharacterProgress.value = percent;
  if (elements.replaceCharacterProgressLabel && label != null) {
    elements.replaceCharacterProgressLabel.textContent = label;
  }
  if (logLine && elements.replaceCharacterProgressLog) {
    elements.replaceCharacterProgressLog.textContent += logLine + "\n";
    elements.replaceCharacterProgressLog.scrollTop = elements.replaceCharacterProgressLog.scrollHeight;
  }
}

function resetReplaceProgress() {
  if (elements.replaceCharacterProgressArea) elements.replaceCharacterProgressArea.hidden = true;
  if (elements.replaceCharacterProgress) elements.replaceCharacterProgress.value = 0;
  if (elements.replaceCharacterProgressLabel) elements.replaceCharacterProgressLabel.textContent = "";
  if (elements.replaceCharacterProgressLog) elements.replaceCharacterProgressLog.textContent = "";
}

// 配置済キャラ A を別キャラ B に全カット一括置換する。
// 保持: instance.id / 配列順 (z-order) / character.{x,y,scale} / flipX / removeWhite / showCharacter
// 置き換え: characterId / name / baseId / cheekId / eyeId / mouthId / hairstylePresetId / frontIds / eyeAboveBangs
//          (新キャラの default preset / 先頭項目 / 空配列に落とす)
// 任意: 「音声を吹き替える」が ON なら、target が話者 instance になっているカットの cut.audio /
//       durationFrame を target.manifest.voice で再合成して上書き、cut.state.voice override を削除。
export async function replaceCharacterAcrossAllCuts() {
  const sourceCharId = elements.replaceCharacterSource?.value || "";
  const targetCharId = elements.replaceCharacterTarget?.value || "";
  const dub = Boolean(elements.replaceCharacterDubVoice?.checked);
  if (!sourceCharId || !targetCharId) {
    showToast("置換元と置換先を選択してください");
    return;
  }
  if (sourceCharId === targetCharId) {
    showToast("同じキャラへの置換はできません");
    return;
  }
  const sourceDef = characterDefinitionById(sourceCharId);
  const targetDef = characterDefinitionById(targetCharId);
  if (!sourceDef || !targetDef) {
    showToast("キャラ定義が見つかりません", "error");
    return;
  }

  // 編集中フォームの値を保存してから走査する (現カットの位置・拡大率が未保存だと
  // 置換後の loadCharacterIntoControls で巻き戻ることを防ぐ)。
  deps.updateSelectedCutFromCurrent();

  const cuts = state.scenario?.cuts || [];
  let cutCount = 0;
  let instanceCount = 0;
  const speakerCutsToDub = [];
  for (const cut of cuts) {
    const list = cut.state?.characters || [];
    const hits = list.filter((c) => c?.characterId === sourceCharId);
    if (hits.length === 0) continue;
    cutCount += 1;
    instanceCount += hits.length;
    const speakerInstId = cut.state?.speakerCharacterId || "";
    const speakerIsSource = hits.some((c) => c.id === speakerInstId);
    const text = String(cut.state?.text || "").trim();
    if (speakerIsSource && text) speakerCutsToDub.push(cut);
  }
  if (cutCount === 0) {
    showToast("置換元のキャラが配置されているカットがありません");
    return;
  }

  // 確認ダイアログ (promptBulkApply を流用)。dub ON でも OFF でも、ダイアログでは
  // 影響範囲をテキストで見せる。dub ON のときだけチェック項目「吹替」を 1 件出して、
  // ユーザーがダイアログ上で吹替だけキャンセルできるようにする。
  const items = [];
  if (dub) {
    items.push({
      key: "dub",
      label: `音声吹替 (話者カット ${speakerCutsToDub.length} 件)`,
      valueText: targetDef?.voice?.id || "voice 未設定",
    });
  } else {
    items.push({ key: "noop", label: "音声吹替は OFF (置換のみ実行)", valueText: "" });
  }
  const description = `「${sourceDef.name || sourceCharId}」を「${targetDef.name || targetCharId}」に置換します。\n対象: ${cutCount} カット / ${instanceCount} インスタンス。\n表情・髪型・ベース・前面オブジェクトは置換先の初期値に戻ります。`;
  const result = await promptBulkApply({
    title: "キャラを置換",
    description,
    items,
    applyLabel: "置換を実行",
    defaultChecked: true,
  });
  if (!result.confirmed) return;
  const doDub = dub && result.selectedKeys.has("dub");

  resetReplaceProgress();

  // === 置換実行 ===
  // defaultCharacter() の baseId / hairstylePresetId / 表情プリセット解決を使い回す。
  // インスタンスを丸ごと置き換えるのではなく、保持すべきフィールド (id, character, flipX,
  // removeWhite, showCharacter) を残してマージ。これにより speakerCharacterId の参照が
  // 自動的に target 側 instance に引き継がれる。
  const dummy = defaultCharacter(0, targetCharId);
  const defaultExpr = defaultExpressionPresetFor(targetCharId);
  for (const cut of cuts) {
    const list = cut.state?.characters || [];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      if (!c || c.characterId !== sourceCharId) continue;
      list[i] = {
        ...c,
        characterId: targetCharId,
        name: targetDef.name || c.name || dummy.name,
        baseId: dummy.baseId,
        cheekId: defaultExpr?.cheekId || "",
        eyeId: defaultExpr?.eyeId || "",
        mouthId: defaultExpr?.mouthId || "",
        hairstylePresetId: dummy.hairstylePresetId,
        frontIds: [],
        eyeAboveBangs: false,
      };
    }
  }

  // === 音声吹替 ===
  let dubbed = 0;
  let dubSkipped = 0;
  if (doDub && speakerCutsToDub.length > 0) {
    const voice = targetDef.voice || {};
    if (!voice.id) {
      setReplaceProgress(100, "voice 未設定のため吹替をスキップしました", `[警告] ${targetDef.name || targetCharId} の manifest.voice が未設定`);
    } else {
      setReplaceProgress(0, `0/${speakerCutsToDub.length} 音声を再合成...`, `[開始] 吹替 voice=${voice.id}${voice.emotion ? "/" + voice.emotion : ""}`);
      for (let i = 0; i < speakerCutsToDub.length; i += 1) {
        const cut = speakerCutsToDub[i];
        const text = String(cut.state?.text || "").trim();
        const cutNumber = cuts.findIndex((c) => c.id === cut.id) + 1;
        if (!text) {
          dubSkipped += 1;
          setReplaceProgress(
            Math.round(((i + 1) / speakerCutsToDub.length) * 100),
            `${i + 1}/${speakerCutsToDub.length} (テキスト空: スキップ)`,
            `[スキップ] cut#${cutNumber} text empty`,
          );
          continue;
        }
        try {
          const data = await synthesizeBatchItem(
            { voiceId: voice.id, emotion: voice.emotion || "", text },
            cutNumber,
          );
          cut.audio = data.audioPath || "";
          // 元のカット長 (durationFrame) が新音声より長い場合はカット長を維持する。
          // 短い場合のみ音声長まで伸ばす (音声が途中で切れることを防ぐ)。
          let lengthNote = "";
          if (Number.isFinite(data.durationSec) && data.durationSec > 0) {
            const newFrames = Math.max(1, secToFrames(data.durationSec));
            const prevFrames = Number(cut.durationFrame) || 0;
            if (prevFrames > newFrames) {
              cut.durationFrame = prevFrames;
              lengthNote = ` keep cut=${prevFrames}f`;
            } else {
              cut.durationFrame = newFrames;
              lengthNote = ` cut=${newFrames}f`;
            }
          }
          if (cut.state) delete cut.state.voice;
          dubbed += 1;
          setReplaceProgress(
            Math.round(((i + 1) / speakerCutsToDub.length) * 100),
            `${i + 1}/${speakerCutsToDub.length} ${text.slice(0, 20)}`,
            `[OK] cut#${cutNumber} ${data.filename || data.audioPath || ""} (${(data.durationSec || 0).toFixed(2)}s)${lengthNote}`,
          );
        } catch (error) {
          dubSkipped += 1;
          setReplaceProgress(
            Math.round(((i + 1) / speakerCutsToDub.length) * 100),
            `${i + 1}/${speakerCutsToDub.length} エラー`,
            `[失敗] cut#${cutNumber} ${error.message}`,
          );
        }
      }
      // manifest 再スキャンで新規 wav 群を audio 一覧に反映 (selectAudio で表示できるように)。
      try {
        const r = await fetch("/api/projects/rescan", { method: "POST" });
        if (r.ok) state.manifest = await r.json();
      } catch (_e) {
        // 失敗しても置換結果は保持
      }
    }
  }

  // === 後処理 ===
  fillCharacterDefinitionAddSelect();
  fillReplaceCharacterSelects();
  deps.scheduleScenarioSave();
  recordHistory();
  // 現在のカットを開き直して characters[] のスキーマ変更を UI に反映する。
  // (applyCharacterToAllCuts は state を直接書き換えるだけだが、こちらは characterId /
  //  baseId / 表情プリセット系まで触るのでフォーム全体を再ロードする必要がある。)
  await deps.reloadCurrentCut?.();
  await deps.renderPreview();
  const dubMsg = doDub ? ` / 吹替 ${dubbed} 件${dubSkipped > 0 ? `・スキップ ${dubSkipped} 件` : ""}` : "";
  showToast(`置換しました (${cutCount} カット / ${instanceCount} インスタンス${dubMsg})`);
}
