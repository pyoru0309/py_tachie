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
  // ここまで来たら実際に snapshot を積む = 保留中の連続入力ぶんもこの snapshot に
  // 含まれている。タイマーを畳んで二重計上を避ける。
  // ★ 早期 return より **後ろ** に置くこと。isLoadingCut 中の呼び出しで畳んでしまうと、
  //   打鍵のコミット予約だけが消えて履歴から落ちる。
  _cancelCoalesce();
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
  _cancelCoalesce();
  state.history.stack = [];
  state.history.index = -1;
}

// ===========================================================================
// 連続入力 (テキスト打鍵) 用の履歴コミット
// ===========================================================================
// テキスト入力を 1 打鍵ごとに recordHistory すると履歴 (既定 50 件) が一瞬で
// 溢れる。一方、まったく積まないと「次に履歴を積む操作」まで打鍵がすべて 1 エントリに
// 吸収され、**undo 1 回で複数テロップにまたがる文字修正がまとめて巻き戻る**
// (2026-09-11 に報告された症状の根因: テロップ本文 textarea は recordHistory を
// 呼んでいなかった)。
//
// そこで「編集対象キー (例: `telop:<id>:text`) 単位で、打鍵が止まったら 1 エントリ」
// に丸める。呼び出しは **state を書き換える直前**。キーが変わったらその時点で即
// コミットする — このタイミングなら「前の対象の打鍵は入っていて、新しい対象の打鍵は
// まだ入っていない」状態なので、テロップ A の編集とテロップ B の編集が別エントリに
// 分かれる。
const _coalesce = { key: null, timer: null };

function _cancelCoalesce() {
  if (_coalesce.timer) {
    clearTimeout(_coalesce.timer);
    _coalesce.timer = null;
  }
  _coalesce.key = null;
}

/** 保留中の連続入力を今すぐ 1 エントリとして確定する。undo/redo/blur の直前に呼ぶ。 */
export function flushCoalescedHistory() {
  if (!_coalesce.key) return;
  _cancelCoalesce();
  recordHistory();
}

/**
 * 連続入力の履歴コミットを予約する。**state を書き換える直前**に呼ぶこと。
 * @param {string} key 編集対象を一意に表す文字列 (例: `telop:<id>:text`)
 * @param {{delay?: number}} options delay: 打鍵が止まってから確定するまでの ms
 */
export function beginCoalescedHistory(key, { delay = 800 } = {}) {
  if (!key) return;
  // 対象が変わったら、新しい打鍵が state に入る前に前の対象を確定させる。
  if (_coalesce.key && _coalesce.key !== key) flushCoalescedHistory();
  _coalesce.key = key;
  if (_coalesce.timer) clearTimeout(_coalesce.timer);
  _coalesce.timer = setTimeout(() => {
    _coalesce.timer = null;
    _coalesce.key = null;
    recordHistory();
  }, delay);
}
