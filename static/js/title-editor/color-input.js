// =============================================================================
// title-editor / color-input.js
//
// 色入力 UI (= swatch + HEX 並置)。telop.js の buildColorSwatch を複製している。
// 本体側を import すると elements.js / timeline.js / poster-typography-dialog.js
// など重い依存チェーンを引き込んで、未存在 DOM 要素や named export 不整合で
// モジュール全体が読み込めなくなる。タイトルエディタ用に独立した最小実装を持つ。
// =============================================================================

const HEX_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

function normalizeHex(value, fallback = "#ffffff") {
  const s = String(value || "").trim();
  if (HEX_RE.test(s)) {
    if (s.length === 4) {
      return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    }
    return s.toLowerCase();
  }
  return fallback;
}

export function buildColorSwatch(initial, fallback, onChange) {
  const wrap = document.createElement("span");
  wrap.className = "color-control";
  const input = document.createElement("input");
  input.type = "color";
  const value = document.createElement("span");
  value.className = "color-value";
  const v0 = normalizeHex(initial, fallback);
  input.value = v0;
  value.textContent = v0;
  value.style.setProperty("--color-value", v0);
  wrap.append(input, value);
  const handler = () => {
    const v = normalizeHex(input.value, fallback);
    value.textContent = v;
    value.style.setProperty("--color-value", v);
    onChange(v);
  };
  input.addEventListener("input", handler);
  input.addEventListener("change", handler);
  return wrap;
}
