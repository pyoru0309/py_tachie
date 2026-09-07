// =============================================================================
// popup-menu.js
//
// ツールバーのプルダウン / オーバーフローメニュー共通の 2 つの規律。
//
// 1. **開いているのは常に 1 つ** (`registerPopup` / `closeOtherPopups`)
//    trigger の click は `stopPropagation()` するので「外側クリックで閉じる」
//    document ハンドラに届かない。そのため別のメニューを開いても前のメニューが
//    開きっぱなしになり、2 枚が重なって見えていた (2026-09-08 のユーザー報告)。
//    開く側から明示的に他を閉じる。
//
// 2. **クリップする祖先から逃がす** (`placeFloatingMenu` / `clearFloatingMenu`)
//    メニューは `overflow: hidden` の祖先 (`.workspace` / `.timeline-dock`) の
//    内側にある。`position: absolute` のままだと画面幅が狭いときに親の右端で
//    切られ、「右のパネルの下に隠れている」ように見える (同報告)。z-index を
//    いくら上げてもクリップは外せないので、開くときに `position: fixed` へ
//    逃がして viewport にクランプする。
// =============================================================================

// 画面端から最低限あける余白 (px)。
const VIEWPORT_MARGIN = 8;

// ---------------------------------------------------------------------------
// 1. 同時に開くのは 1 つだけ
// ---------------------------------------------------------------------------

/** @type {Map<Element, () => void>} 要素 → それを閉じる関数 */
const popups = new Map();

export function registerPopup(element, close) {
  if (element && typeof close === "function") popups.set(element, close);
}

// `except` 以外を閉じる。except を**内側に持つ**メニュー (オーバーフローメニュー
// など) は閉じない — 閉じると、いま開こうとしている子メニューごと消えてしまう。
export function closeOtherPopups(except) {
  for (const [element, close] of popups) {
    if (element === except) continue;
    if (except && element.contains?.(except)) continue;
    close();
  }
}

export function closeAllPopups() {
  for (const close of popups.values()) close();
}

// リサイズすると fixed 座標が古くなる。追従までは要らないので閉じる。
// (スクロールは対象のツールバーが固定なので拾わない — 再生中の
//  タイムライン自動スクロールでメニューが消える方が邪魔になる)
window.addEventListener("resize", () => closeAllPopups());

// ---------------------------------------------------------------------------
// 2. クリップする祖先から逃がす
// ---------------------------------------------------------------------------

/**
 * メニューを `position: fixed` に切り替え、anchor を基準に viewport 内へ収める。
 * **メニューを表示状態にしてから**呼ぶこと (実寸を測るため)。
 *
 * @param {HTMLElement} menu   メニュー本体
 * @param {HTMLElement} anchor 基準にする要素 (trigger ボタン)
 * @param {Object} [opts]
 * @param {"bottom"|"right"} [opts.side]  anchor の下に出すか、右に出すか (fly-out)
 * @param {"start"|"end"} [opts.align]    side="bottom" のとき左揃え / 右揃え
 * @param {number} [opts.gap]             anchor との隙間 (px)
 */
export function placeFloatingMenu(menu, anchor, { side = "bottom", align = "start", gap = 4 } = {}) {
  if (!menu || !anchor) return;
  // 実寸を測る前に fixed 化する (absolute のままだと祖先基準の座標が返る)。
  menu.style.position = "fixed";
  menu.style.margin = "0";
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // viewport より高いメニューは詰めて中でスクロールさせる。
  let height = m.height;
  const maxHeight = vh - VIEWPORT_MARGIN * 2;
  if (height > maxHeight) {
    height = maxHeight;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.overflowY = "auto";
  }

  let top;
  let left;
  if (side === "right") {
    top = a.top;
    left = a.right + gap;
    // 右に出ないなら左へ反転 (旧 .flip-left 相当)。
    if (left + m.width > vw - VIEWPORT_MARGIN) left = a.left - gap - m.width;
  } else {
    top = a.bottom + gap;
    // 下に入らないなら上へ。上にも入らないなら下端に貼り付ける。
    if (top + height > vh - VIEWPORT_MARGIN) {
      const above = a.top - gap - height;
      top = above >= VIEWPORT_MARGIN ? above : vh - VIEWPORT_MARGIN - height;
    }
    left = align === "end" ? a.right - m.width : a.left;
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - VIEWPORT_MARGIN - m.width));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - VIEWPORT_MARGIN - height));

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.right = "auto";
  menu.style.bottom = "auto";
}

/** `placeFloatingMenu` が付けたインラインスタイルを剥がす (閉じるとき)。 */
export function clearFloatingMenu(menu) {
  if (!menu) return;
  for (const prop of ["position", "left", "top", "right", "bottom", "margin", "maxHeight", "overflowY"]) {
    menu.style[prop] = "";
  }
}
