// ツールバー overflow (>>) コントローラ。
// ツールバーの幅が足りなくなったら、右端の要素から順に「>>」メニュー側へ
// 移動して常に 1 段に収める。余裕が出たら元の位置に自動復帰する。

import { elements } from "./elements.js";

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.toolbar          - 監視対象 (直接の子が候補)
 * @param {HTMLElement} opts.overflowContainer - 「>>」ボタン + menu のラッパ
 * @param {HTMLButtonElement} opts.overflowButton - 開閉ボタン
 * @param {HTMLElement} opts.overflowMenu     - メニュー本体 (= 子に押し出された要素を入れる)
 * @param {(el: Element) => boolean} [opts.isProtected]
 *        true を返す要素は overflow しない (左端の常時表示要素など)
 */
export function bindToolbarOverflow({
  toolbar,
  overflowContainer,
  overflowButton,
  overflowMenu,
  isProtected = () => false,
}) {
  if (!toolbar || !overflowContainer || !overflowButton || !overflowMenu) return null;

  // 押し出された要素の「元の位置 (parent + nextSibling)」を覚えておき、
  // 復帰時はそこに insertBefore する。
  const homeMap = new WeakMap();

  const captureHome = (el) => {
    if (homeMap.has(el)) return;
    homeMap.set(el, { parent: el.parentNode, nextSibling: el.nextSibling });
  };

  const restoreOne = (el) => {
    const home = homeMap.get(el);
    if (!home || !home.parent) return;
    home.parent.insertBefore(el, home.nextSibling);
  };

  const restoreAll = () => {
    const inMenu = Array.from(overflowMenu.children);
    for (let i = inMenu.length - 1; i >= 0; i--) restoreOne(inMenu[i]);
  };

  const isOverflowing = () => toolbar.scrollWidth > toolbar.clientWidth + 1;

  const pickRightmostOverflowable = () => {
    const children = Array.from(toolbar.children);
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      if (el === overflowContainer) continue;
      if (isProtected(el)) continue;
      if (el.hidden) continue;
      return el;
    }
    return null;
  };

  const closeMenu = () => {
    if (overflowMenu.hidden) return;
    overflowMenu.hidden = true;
    overflowButton.setAttribute("aria-expanded", "false");
    // 内部の dropdown 子も閉じる
    overflowMenu.querySelectorAll(".dropdown-button.open").forEach((el) => {
      el.classList.remove("open");
      const sub = el.querySelector(".dropdown-menu");
      if (sub) sub.hidden = true;
      const trig = el.querySelector("[aria-expanded]");
      if (trig) trig.setAttribute("aria-expanded", "false");
    });
  };

  const openMenu = () => {
    overflowMenu.hidden = false;
    overflowButton.setAttribute("aria-expanded", "true");
    // サブメニュー (.dropdown-button) の右出し fly が画面右端にぶつかる場合は
    // .flip-left クラスで左反転する (CSS が対応)。
    overflowMenu.querySelectorAll(".dropdown-button").forEach((db) => {
      const sub = db.querySelector(".dropdown-menu");
      if (!sub) return;
      db.classList.remove("flip-left");
      const wasHidden = sub.hidden;
      // 測定のため visibility:hidden 相当で一時表示
      sub.style.visibility = "hidden";
      sub.hidden = false;
      const rect = sub.getBoundingClientRect();
      sub.hidden = wasHidden;
      sub.style.visibility = "";
      if (rect.right > window.innerWidth - 8) {
        db.classList.add("flip-left");
      }
    });
  };

  let scheduled = false;
  const scheduleUpdate = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  };

  const update = () => {
    // 一旦すべて戻して、現状の幅で再評価 (= 余裕が出たら自動復帰)。
    restoreAll();
    // ★ 2 段階判定:
    //   1. 「>> を出さない状態」で「ボタン本体だけで収まるか」を判定。
    //      余裕があるならそのまま終了 (= >> も出さない)。
    //   2. 収まらない場合のみ >> を表示し、>> 込みの clientWidth で push を進める。
    //   こうしないと、フル HD のように本体だけで余裕がある状況で >> を出した瞬間
    //   ボタン 1 個分のオーバーが発生し、最後の 1 個 (= 設定 / テーマ) だけが
    //   余計に menu 行きになる現象が起きる。
    overflowContainer.hidden = true;
    if (window.__spliteDebugToolbarOverflow) {
      const sw = toolbar.scrollWidth;
      const cw = toolbar.clientWidth;
      console.log("[toolbar-overflow] phase1 (>>非表示)", {
        scrollWidth: sw, clientWidth: cw, diff: sw - cw,
      });
    }
    if (!isOverflowing()) {
      // 本体だけで余裕あり: 何も送らずそのまま終了。
      closeMenu();
      return;
    }
    // 本体で収まらない → >> を表示して 1 個ずつ送る。
    overflowContainer.hidden = false;
    if (window.__spliteDebugToolbarOverflow) {
      console.log("[toolbar-overflow] phase2 (>>表示)", {
        scrollWidth: toolbar.scrollWidth,
        clientWidth: toolbar.clientWidth,
        overflowBtnWidth: overflowContainer.offsetWidth,
      });
    }
    let safety = 200;
    let sentCount = 0;
    while (isOverflowing() && safety-- > 0) {
      const candidate = pickRightmostOverflowable();
      if (!candidate) break;
      if (window.__spliteDebugToolbarOverflow) {
        console.log("[toolbar-overflow] sending to menu",
          candidate.id || candidate.className,
          "candidate.width=", candidate.offsetWidth);
      }
      captureHome(candidate);
      overflowMenu.insertBefore(candidate, overflowMenu.firstChild);
      sentCount++;
    }
    const hasOverflow = sentCount > 0;
    overflowContainer.hidden = !hasOverflow;
    if (!hasOverflow) closeMenu();
  };

  overflowButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (overflowMenu.hidden) openMenu();
    else closeMenu();
  });

  overflowMenu.addEventListener("click", (e) => {
    const targetButton = e.target.closest("button");
    if (!targetButton) return;
    // .dropdown-button の trigger 自体は toggle のため閉じない
    const dropdownParent = targetButton.closest(".dropdown-button");
    if (dropdownParent && targetButton === dropdownParent.querySelector(":scope > button")) {
      return;
    }
    closeMenu();
  });

  document.addEventListener("click", (e) => {
    if (!overflowContainer.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overflowMenu.hidden) closeMenu();
  });

  const ro = new ResizeObserver(() => scheduleUpdate());
  ro.observe(toolbar);
  if (toolbar.parentElement) ro.observe(toolbar.parentElement);
  window.addEventListener("resize", scheduleUpdate);

  // 初回測定は同期実行 (= 親 overflow:hidden を外した分、初回フレームで
  // はみ出しを見せないために rAF を待たず即時振り分ける)。
  update();

  return {
    refresh: scheduleUpdate,
    destroy: () => {
      ro.disconnect();
      restoreAll();
    },
  };
}

/** 既定の上段・下段ツールバー両方に overflow ハンドラを取り付ける。 */
export function bindAllToolbarOverflow() {
  const topActions = document.querySelector(".top-actions");
  if (topActions && elements.topActionsOverflowButton && elements.topActionsOverflowMenu) {
    const protectedTop = new Set(
      [
        document.getElementById("openDashboardButton"),
        document.getElementById("projectSelect"),
        document.getElementById("createProjectButton"),
      ].filter(Boolean)
    );
    bindToolbarOverflow({
      toolbar: topActions,
      overflowContainer: elements.topActionsOverflowButton.parentElement,
      overflowButton: elements.topActionsOverflowButton,
      overflowMenu: elements.topActionsOverflowMenu,
      isProtected: (el) => protectedTop.has(el),
    });
  }
  const timelineHeader = document.querySelector(".timeline-header");
  if (
    timelineHeader &&
    elements.timelineToolbarOverflowButton &&
    elements.timelineToolbarOverflowMenu
  ) {
    bindToolbarOverflow({
      toolbar: timelineHeader,
      overflowContainer: elements.timelineToolbarOverflowButton.parentElement,
      overflowButton: elements.timelineToolbarOverflowButton,
      overflowMenu: elements.timelineToolbarOverflowMenu,
      // 左端のズーム・時刻表示ブロックは丸ごと保護
      isProtected: (el) => el.classList.contains("timeline-toolbar"),
    });
  }
}
