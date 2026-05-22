// ===========================================================================
// タイムコード変換 (秒 ↔ 整数フレーム / MM:SS.FF 整形 / カスタム入力 binding)
// プロジェクト fps = 24 を基準とし、cut.startFrame / telop.startFrame など
// 整数フレームで保持されたデータの表示と入力を共通化する。
// ===========================================================================

export const PROJECT_FPS = 24;
export const CHARACTER_ANIMATION_FPS_CHOICES = [8, 12, 24];
export const CHARACTER_ANIMATION_FPS_DEFAULT = 12;

const TIMECODE_PATTERN = /^\s*(\d{1,3}):(\d{1,2})\.(\d{1,2})\s*$/;

export function secToFrames(value, fps = PROJECT_FPS) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num * fps);
}

export function framesToSec(frames, fps = PROJECT_FPS) {
  const num = Number(frames);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num) / fps;
}

export function formatTimecode(frames, fps = PROJECT_FPS) {
  const f = Math.max(0, Math.round(Number(frames) || 0));
  const totalSeconds = Math.floor(f / fps);
  const frameOnly = f % fps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(frameOnly).padStart(2, "0")}`;
}

export function formatTimecodeSec(seconds, fps = PROJECT_FPS) {
  return formatTimecode(secToFrames(seconds, fps), fps);
}

export function parseTimecode(text, fps = PROJECT_FPS) {
  if (text == null) return null;
  const match = TIMECODE_PATTERN.exec(String(text));
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const frames = Number(match[3]);
  if (seconds >= 60 || frames >= fps) return null;
  return (minutes * 60 + seconds) * fps + frames;
}

export function clampCharacterAnimationFps(value) {
  const num = Number(value);
  if (CHARACTER_ANIMATION_FPS_CHOICES.includes(num)) return num;
  return CHARACTER_ANIMATION_FPS_DEFAULT;
}

/**
 * MM:SS.FF 形式の input を frame 値で扱うためのバインダ。
 *   bindTimecodeInput(inputEl, {
 *     getFrames: () => 12,        // 表示時に呼ばれる
 *     setFrames: (frames) => {},  // 入力確定時に呼ばれる
 *     fps: 24,
 *     minFrames: 1,               // 0 以上が標準。duration 用は 1 以上推奨
 *   });
 */
export function bindTimecodeInput(input, options = {}) {
  if (!input) return () => {};
  const fps = options.fps || PROJECT_FPS;
  const minFrames = Number.isFinite(options.minFrames) ? options.minFrames : 0;
  const getFrames = typeof options.getFrames === "function" ? options.getFrames : () => 0;
  const setFrames = typeof options.setFrames === "function" ? options.setFrames : () => {};

  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (!input.placeholder) input.placeholder = "00:00.00";
  if (!input.pattern) input.pattern = "\\d{1,3}:\\d{1,2}\\.\\d{1,2}";

  const refresh = () => {
    input.value = formatTimecode(getFrames(), fps);
    input.classList.remove("input-error");
  };

  const commit = () => {
    const parsed = parseTimecode(input.value, fps);
    if (parsed == null) {
      input.classList.add("input-error");
      refresh();
      return;
    }
    input.classList.remove("input-error");
    const clamped = Math.max(minFrames, parsed);
    setFrames(clamped);
    input.value = formatTimecode(clamped, fps);
    input.dataset.frames = String(clamped);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const onKeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      input.blur();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const delta = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? fps : 1);
      const parsed = parseTimecode(input.value, fps);
      const base = parsed != null ? parsed : getFrames();
      const next = Math.max(minFrames, base + delta);
      input.value = formatTimecode(next, fps);
      input.dataset.frames = String(next);
      setFrames(next);
      input.classList.remove("input-error");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", onKeydown);

  refresh();
  return refresh;
}
