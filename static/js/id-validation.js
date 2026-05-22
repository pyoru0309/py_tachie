// ===========================================================================
// キャラクター ID 重複チェック・インライン警告 (新規作成 / PSDインポータ用)
// ensureCommonInventoryLoaded は fetchAssetInventory に依存するため当面 app.js 残置。
// ===========================================================================

import { state } from "./state.js";

export function slugifyCharacterIdClient(value) {
  return String(value || "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

export function characterIdExists(scope, candidateId) {
  if (!candidateId) return false;
  const slug = slugifyCharacterIdClient(candidateId);
  const items = state.assetInventory?.[scope]?.categories?.characters || [];
  return items.some((item) => {
    const existing = item.characterId || item.name || "";
    return existing && (existing === candidateId || slugifyCharacterIdClient(existing) === slug);
  });
}

export function applyIdValidationFeedback(input, warningEl, scope) {
  if (!input) return false;
  const value = input.value.trim();
  let message = "";
  if (value && characterIdExists(scope, value)) {
    message = `この ID は既に使用されています`;
  }
  input.classList.toggle("has-error", Boolean(message));
  if (warningEl) {
    if (message) {
      warningEl.textContent = message;
      warningEl.hidden = false;
    } else {
      warningEl.hidden = true;
      warningEl.textContent = "";
    }
  }
  return Boolean(message);
}

export function bindLiveIdValidation(input, warningEl, scopeGetter) {
  if (!input) return;
  const handler = () => applyIdValidationFeedback(input, warningEl, scopeGetter());
  input.addEventListener("input", handler);
  input.addEventListener("focus", handler);
  input.addEventListener("blur", handler);
}
