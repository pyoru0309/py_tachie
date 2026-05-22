// =============================================================================
// preview-interactions.js
//
// ライブプレビューキャンバス (livePreviewWebglCanvas) 上でのキャラクター
// ドラッグ&ドロップ操作を提供する。
//
// 機能:
//   - 停止中 (state.isPlaying=false) かつ「キャラ配置」タブ表示中のみ有効
//   - キャラのバウンディングボックスでクリック判定、最前面 (charIndex=0) を優先
//   - クリックで selectedCharacterIndex を切替 (= 登場キャラ select も追従)
//   - ドラッグ中は SceneInstance.charInstance.basePos / group.position と
//     右パネル X/Y inputs を即時更新、scene.update を呼ばない軽量再描画
//   - ドロップ時に updateSelectedCutFromCurrent + scheduleScenarioSave + recordHistory
//
// 座標系:
//   - canvas は 1920×1080 固定。clientX/Y -> scene 座標は単純なスケール変換。
//   - charInstance.basePos はキャラの「中心」(scene 座標)。
//   - state.currentCharacters[i].character.x/y は **左上** 基準。
//     basePos と character.x の差はキャラ幅依存だが、ドラッグでは delta が
//     等しいので両者を同じ delta で動かせばよい。
// =============================================================================
import { state } from "./state.js";
import { elements } from "./elements.js";
import {
  selectedCharacter,
  updateSelectedCharacterFromControls,
  loadCharacterIntoControls,
  renderCharacterSelect,
} from "./character.js";
import { recordHistory } from "./history.js";

let deps = {
  getActiveScene: () => null,
  redrawActiveScene: () => {},
  updateSelectedCutFromCurrent: () => {},
  scheduleScenarioSave: () => {},
  renderPreview: async () => {},
  fillExpressionPresets: () => {},
};

let wired = false;

export function bindPreviewInteractions(injectedDeps = {}) {
  deps = { ...deps, ...injectedDeps };
  if (wired) return;
  const canvas = elements.livePreviewWebglCanvas;
  if (!canvas) return;
  wired = true;

  let dragState = null;
  // クリック判定用: pointerdown 座標からの移動量が閾値を超えるまでは「クリック」扱い。
  const CLICK_THRESHOLD_PX = 4;

  function clientToScene(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const x = (event.clientX - rect.left) * 1920 / rect.width;
    const y = (event.clientY - rect.top) * 1080 / rect.height;
    return { x, y };
  }

  // 「キャラ配置」タブが表示されていないと操作を許可しない (UX 配慮)。
  function isCharacterTabActive() {
    // .control-pane[data-control-pane="character"] が非 hidden なら active。
    const pane = document.querySelector('.control-pane[data-control-pane="character"]');
    if (!pane) return true; // 取得不能なら無条件で許可 (defensive)
    return !pane.classList.contains("hidden");
  }

  // SceneInstance.meshes.characters は配列順序が cut.state.characters と一致する
  // (= 配列上の前 [index 小] が renderOrder 大 = 視覚的に手前)。よって front-to-back
  // にヒットテストするには index 0 から走査する。
  function pickCharacterAt(sceneX, sceneY) {
    const sceneInstance = deps.getActiveScene();
    const charInstances = sceneInstance?.meshes?.characters || [];
    for (let i = 0; i < charInstances.length; i += 1) {
      const inst = charInstances[i];
      if (!inst || !inst.basePos) continue;
      const cx = inst.basePos.x;
      const cy = inst.basePos.y;
      const halfW = (Number(inst.layerWidth) || 0) / 2;
      const halfH = (Number(inst.layerHeight) || 0) / 2;
      if (halfW <= 0 || halfH <= 0) continue;
      if (
        sceneX >= cx - halfW &&
        sceneX <= cx + halfW &&
        sceneY >= cy - halfH &&
        sceneY <= cy + halfH
      ) {
        return { instance: inst, index: i };
      }
    }
    return null;
  }

  function findStateIndexByInstanceId(id) {
    if (!id) return -1;
    return (state.currentCharacters || []).findIndex((c) => c && c.id === id);
  }

  function syncCoordInputs(character) {
    if (!character) return;
    if (elements.characterX) elements.characterX.value = Math.round(character.character.x);
    if (elements.characterY) elements.characterY.value = Math.round(character.character.y);
  }

  function selectCharacterByStateIndex(stateIndex) {
    if (stateIndex < 0 || stateIndex >= state.currentCharacters.length) return;
    if (state.selectedCharacterIndex === stateIndex) return;
    // 現在のフォーム値を作業中キャラに退避してから index を切替。
    updateSelectedCharacterFromControls();
    state.selectedCharacterIndex = stateIndex;
    renderCharacterSelect();
    loadCharacterIntoControls(selectedCharacter());
    deps.fillExpressionPresets("");
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return; // 左クリックのみ
    if (state.isPlaying) return;
    if (!isCharacterTabActive()) return;
    const { x, y } = clientToScene(event);
    const hit = pickCharacterAt(x, y);
    if (!hit) return;
    const stateIndex = findStateIndexByInstanceId(hit.instance.id);
    if (stateIndex < 0) return;

    // 既存の選択を切替 (フォーム値はピック直前に退避済み)。
    selectCharacterByStateIndex(stateIndex);

    const character = state.currentCharacters[stateIndex];
    if (!character) return;
    // 停止中でも shake (zoom 以外) / idle motion (breath / bpmBob) が group.position
    // と basePos の差分として残っていることがある。ドラッグ中も同じオフセットを
    // 保ってキャラの「見た目位置 = カーソル」を維持するために事前に取得しておく。
    const visualOffsetX = hit.instance.group.position.x - hit.instance.basePos.x;
    const visualOffsetY = hit.instance.group.position.y - hit.instance.basePos.y;
    dragState = {
      pointerId: event.pointerId,
      stateIndex,
      instance: hit.instance,
      startScene: { x, y },
      basePosStart: { x: hit.instance.basePos.x, y: hit.instance.basePos.y },
      visualOffset: { x: visualOffsetX, y: visualOffsetY },
      charStart: {
        x: Number(character.character?.x ?? 0),
        y: Number(character.character?.y ?? 0),
      },
      moved: false,
    };
    try { canvas.setPointerCapture(event.pointerId); } catch (_e) {}
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    if (event.pointerId !== dragState.pointerId) return;
    if (state.isPlaying) return;
    const { x, y } = clientToScene(event);
    const dx = x - dragState.startScene.x;
    const dy = y - dragState.startScene.y;
    if (!dragState.moved && Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;

    const character = state.currentCharacters[dragState.stateIndex];
    if (!character) return;
    const newCharX = dragState.charStart.x + dx;
    const newCharY = dragState.charStart.y + dy;
    character.character.x = newCharX;
    character.character.y = newCharY;
    // basePos も同じ delta だけ動かす。group.position は scene.update() を呼ばない
    // と再計算されないので、ここで直接書き換える。shake/idle 由来の visualOffset を
    // 加算して見た目を維持する。
    const inst = dragState.instance;
    inst.basePos.x = dragState.basePosStart.x + dx;
    inst.basePos.y = dragState.basePosStart.y + dy;
    inst.group.position.set(
      inst.basePos.x + dragState.visualOffset.x,
      inst.basePos.y + dragState.visualOffset.y,
      0,
    );
    // 右パネルの X/Y inputs もリアルタイムで追従。
    syncCoordInputs(character);
    // 軽量再描画 (update なし)。
    deps.redrawActiveScene();
  });

  function endDrag(event) {
    if (!dragState) return;
    if (event && event.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    const stateIndex = dragState.stateIndex;
    try { canvas.releasePointerCapture(dragState.pointerId); } catch (_e) {}
    canvas.style.cursor = "";
    dragState = null;
    if (!moved) {
      // クリックのみ (ドラッグなし) → 選択切替だけで保存しない。
      // 既に selectCharacterByStateIndex で UI 同期済。
      return;
    }
    // ドロップ確定: cut.state へ反映 + 保存 + 履歴。
    const character = state.currentCharacters[stateIndex];
    if (character) syncCoordInputs(character);
    deps.updateSelectedCutFromCurrent();
    deps.scheduleScenarioSave();
    recordHistory();
    // scene 再構築 (新 x/y で token が変わる → 同じレイヤー PNG をキャッシュから再利用)。
    deps.renderPreview();
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // canvas の外で pointerup が起きた場合の保険。
  window.addEventListener("pointerup", endDrag);
}
