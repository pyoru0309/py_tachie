// ===========================================================================
// テーマ (light / dark) 管理
// ===========================================================================

export const THEME_STORAGE_KEY = "splite_anime_theme";

export function preferredTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

export function setStoredTheme(value) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch (error) {
    /* ストレージが使えない環境では無視 */
  }
}

export function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  document.querySelectorAll("[data-theme-icon]").forEach((node) => {
    node.textContent = next === "dark" ? "light_mode" : "dark_mode";
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((node) => {
    node.title = next === "dark" ? "ライトモードへ切替" : "ダークモードへ切替";
    node.setAttribute("aria-label", node.title);
  });
  // canvas で imperative に描画している箇所 (timeline 等) は CSS 変数の値を
  // getPropertyValue で都度読むため、テーマ切替時に明示的に再描画させる。
  // モジュール間結合を避けるため CustomEvent 経由で通知する。
  document.dispatchEvent(new CustomEvent("splite:theme-change", { detail: { theme: next } }));
}

export function initTheme() {
  const stored = getStoredTheme();
  applyTheme(stored || preferredTheme());
  if (!stored && window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener?.("change", (event) => {
      if (!getStoredTheme()) {
        applyTheme(event.matches ? "dark" : "light");
      }
    });
  }
  document.querySelectorAll("[data-theme-toggle]").forEach((node) => {
    node.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";
      setStoredTheme(next);
      applyTheme(next);
    });
  });
}
