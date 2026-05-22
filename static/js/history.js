// ===========================================================================
// Undo / Redo の履歴スタック管理 (state.history を読み書き)
// applyScenarioSnapshot / undoEdit / redoEdit は他多数の関数に依存するため
// 当面 app.js 側に残してある。
// ===========================================================================

import { state } from "./state.js";

export function takeScenarioSnapshot() {
  return {
    scenario: JSON.parse(JSON.stringify(state.scenario)),
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
