// ===========================================================================
// Undo / Redo の履歴スタック管理 (state.history を読み書き)
// applyScenarioSnapshot / undoEdit / redoEdit は他多数の関数に依存するため
// 当面 app.js 側に残してある。
// ===========================================================================

import { state } from "./state.js";
import { toDiskScenario } from "./scenario.js";

// ★ スナップショットは **ディスク形式** (per-scene / シーンローカル frame) で持つ。
//   メモリ形式 (フラット / 絶対 frame) のまま保存すると、復元時の
//   `attachScenarioCutsAlias` が「既にフラットなもの」をもう一度フラット化して
//   しまい、`scenes[i].cuts` が空なので**全アイテムが消える**。
//   ディスク形式で持てば、復元は読み込みと同じ経路になり対称になる。
//   (dev_docs/plans/multi-scene.md §3.2)
export function takeScenarioSnapshot() {
  return {
    scenario: toDiskScenario(state.scenario),
    selectedCutId: state.selectedCutId,
  };
}

export function recordHistory() {
  if (state.isUndoRedoing) return;
  if (state.isLoadingCut) return;
  if (!state.scenario) return;
  const snap = takeScenarioSnapshot();
  const current = state.history.stack[state.history.index];
  if (current && JSON.stringify(current) === JSON.stringify(snap)) return;
  state.history.stack = state.history.stack.slice(0, state.history.index + 1);
  state.history.stack.push(snap);
  const max = Math.max(1, state.history.maxSize || 50);
  while (state.history.stack.length > max) {
    state.history.stack.shift();
  }
  state.history.index = state.history.stack.length - 1;
}

export function clearHistory() {
  state.history.stack = [];
  state.history.index = -1;
}
