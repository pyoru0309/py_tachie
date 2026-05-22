// ===========================================================================
// 純粋ヘルパー関数群 (state / elements / 他モジュールに依存しないもの)
// ===========================================================================

export function option(label, value) {
  const element = document.createElement("option");
  element.textContent = label;
  element.value = value;
  return element;
}

export function fillSelect(select, items, allowNone, useIdValue = false) {
  select.innerHTML = "";
  if (allowNone) {
    select.append(option("なし", ""));
  }
  for (const item of items) {
    const value = useIdValue ? (item.id ?? "") : (item.path ?? item.id);
    select.append(option(item.name, value));
  }
}

export function iconMarkup(name) {
  return `<span class="msym button-icon" aria-hidden="true">${name}</span>`;
}

export function buttonMarkup(icon, text) {
  return `${iconMarkup(icon)}<span>${text}</span>`;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function opacityToUi(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.8;
  }
  return Number((numeric > 1 ? numeric / 255 : numeric).toFixed(1));
}

export function opacityToRender(value) {
  return Math.round(clamp(Number(value) || 0, 0, 1) * 255);
}

export function basenameOnly(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

export function truncateText(value, maxChars) {
  const chars = Array.from(String(value || ""));
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

export function formatSeconds(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function formatProjectDate(value) {
  if (!value) {
    return "日時なし";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

export function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const decimals = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

export function formatTimestamp(iso) {
  if (!iso) return "";
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_error) {
    return "";
  }
}

export function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function hexToRgba(hex, alpha) {
  const h = String(hex || "").replace(/^#/, "");
  if (h.length !== 6) return `rgba(20, 24, 28, ${alpha})`;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return `rgba(20, 24, 28, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function normalizeColorValue(value, fallback = "#000000") {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return text.toLowerCase();
  }
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return fallback;
}

export function generateTelopId() {
  // ms タイムスタンプだけでは一括追加のループ内で衝突する。ランダムサフィックスで一意化する。
  return `telop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateSoundEffectId() {
  return `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateVideoLayerId() {
  return `vl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const PSD_IMPORTER_KEY_SEPARATOR = "\x01";

export function pathToKey(path) {
  return (path || [])
    .map((part) => String(part).replace(/[\x00-\x08]/g, ""))
    .join(PSD_IMPORTER_KEY_SEPARATOR);
}

export function keyToPath(key) {
  return key === "" ? [] : key.split(PSD_IMPORTER_KEY_SEPARATOR);
}

export function pathArrayToString(path) {
  return (path || []).join("/");
}

export function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}
