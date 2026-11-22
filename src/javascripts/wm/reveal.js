/**
 * wm/reveal.js — 点按墙纸显示/恢复桌面（F-11）
 *
 * macOS Sequoia：在墙纸空白处点一下，所有窗口移开露出桌面；再点一下全部回到原位。
 * 本模块是「移开 ↔ 恢复」的唯一状态机：
 * - 苹果菜单「显示全部」（session.showAll）委托 restoreAllWindows，不另写第二套恢复逻辑；
 * - 台前调度（F-09）开启时点墙纸归它的 clickWallpaper 行为管，本模块跳过，不抢；
 * - 移开方式：窗口按 left/top 滑出视口下缘堆叠（绝不 display:none、绝不 transform ——
 *   .window 带 backdrop-filter，transform 会让亚克力换 backdrop-root，项目铁律）；
 * - 恢复：逐窗回写保存时的框架（left/top/width/height 与 z 序都不动，天然精确），
 *   并把移开前最顶层窗口重新聚焦。
 *
 * 不移开的窗口：子窗/模态（随母窗一起走）、最小化、全屏与分屏成员（属于各自空间）、
 * 台前调度已收起组（.wm-shelved）、其他空间的 .wm-space-hidden、fixed 定位窗、关闭中的窗。
 */

import { records, stack, focusWindow, getTopWindow, stateOf, isMinimized, isWindowElement } from "./stack.js";
import { followMove } from "./relations.js";
import { applyFrame } from "./frame.js";
import { inSplit } from "./spaces.js";
import * as stageManager from "./stage-manager.js";
import { isOverviewOpen } from "./overview.js";

/** 是否处于「已移开」状态。 */
let hidden = false;
/** el -> { frame, dy }：移开时的框架快照与纵向位移量（恢复时子窗按 -dy 跟回）。 */
const saved = new Map();
/** 移开前最顶层（焦点）窗口，恢复时还回去。 */
let lastFocused = null;

/** 该窗口此刻是否该参与移开。 */
function movable(el) {
  if (!isWindowElement(el) || !el.isConnected) return false;
  const rec = records.get(el);
  if (!rec) return false;
  const st = stateOf(el);
  if (st.role && st.role !== "normal") return false; // 子窗/模态随母窗
  if (el._wmFixed) return false;                     // fixed 定位窗（通知/固定面板）
  if (el.classList.contains("closing")) return false;
  if (el.classList.contains("wm-preparing")) return false;
  if (el.classList.contains("wm-shelved")) return false;      // 台前调度已收起
  if (el.classList.contains("wm-space-hidden")) return false; // 其他空间的窗口
  if (isMinimized(el)) return false;
  if (rec.fullscreen) return false;
  if (inSplit(el)) return false;
  return true;
}

/**
 * 移开所有参与的窗口。幂等：已移开时不再叠加。
 * @returns {boolean} 是否发生了移开
 */
export function hideAllWindows() {
  if (hidden) return false;
  const targets = stack.filter((el) => movable(el));
  if (!targets.length) return false;
  lastFocused = movable(getTopWindow()) ? getTopWindow() : null;
  let i = 0;
  for (const el of targets) {
    const f = stateOf(el).frame;
    // 排队滑到视口下缘外：只在纵向错开，横向保持原位，恢复时原样回去。
    const y = window.innerHeight + 8 + i * 6;
    const dy = y - f.y;
    saved.set(el, { frame: { ...f }, dy });
    applyFrame(el, { x: f.x, y, w: f.w, h: f.h });
    // 子窗/模态随母窗同位移；整屏移开不走视口钳制，否则子窗会被留在屏内
    followMove(el, 0, dy, { clamp: false });
    el._wmRevealHidden = true; // 视口重排（relayoutOnResize）看到这个标记不往回拉
    i += 1;
  }
  hidden = true;
  return true;
}

/**
 * 恢复全部移开的窗口到各自保存时的框架，并聚焦移开前的顶层窗口。
 * @returns {boolean} 是否有窗口被恢复
 */
export function restoreAllWindows() {
  if (!hidden) return false;
  hidden = false;
  let restored = false;
  for (const [el, snap] of saved) {
    if (!isWindowElement(el) || !el.isConnected) continue;
    applyFrame(el, { ...snap.frame });
    // 子窗按同一位移量跟回（与移开对称，同样不走视口钳制）
    followMove(el, 0, -snap.dy, { clamp: false });
    el._wmRevealHidden = false;
    restored = true;
  }
  saved.clear();
  if (restored && lastFocused && isWindowElement(lastFocused) && lastFocused.isConnected && !isMinimized(lastFocused)) {
    focusWindow(lastFocused);
  }
  lastFocused = null;
  return restored;
}

/** 墙纸点按的开关入口：移开中则恢复，否则移开。 */
export function toggle() {
  if (hidden) restoreAllWindows();
  else hideAllWindows();
}

/** @returns {boolean} 当前是否处于移开态。 */
export function isHidden() {
  return hidden;
}

/* ── 墙纸点按识别 ── */

/** 按下位置记录：位移小于该值才算「点一下」，拖框选/拖窗松手不算。 */
const CLICK_TOLERANCE = 6;
let press = null;

/** 点的是不是墙纸空白（不含桌面图标、Dock、菜单栏 —— 那些都在 #desktop 之外或 .item 内）。 */
function isWallpaperTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  const desktop = t.closest ? t.closest("#desktop") : null;
  if (!desktop) return false;
  if (t.closest(".item")) return false;
  return true;
}

/** 快照里应跳过的全局前置条件：让位给各自的专有处理器。 */
function blockedByOtherSurface() {
  if (stageManager.isEnabled()) return true; // F-09 的 clickWallpaper 行为接管
  if (isOverviewOpen()) return true;         // 总览打开时由总览自己关
  if (window.__quickLookOpen) return true;   // QuickLook 自己会吃掉这次点按
  if (document.querySelector("div.menu.contextmenu")) return true; // 右键菜单开着
  return false;
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (blockedByOtherSurface()) return;
  if (!isWallpaperTarget(e.target)) return;
  press = { x: e.clientX, y: e.clientY };
});

document.addEventListener("mouseup", (e) => {
  if (!press) return;
  const p = press;
  press = null;
  if (e.button !== 0) return;
  if (blockedByOtherSurface()) return;
  if (!isWallpaperTarget(e.target)) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_TOLERANCE) return; // 拉框/拖拽松手
  toggle();
});

window.addEventListener("blur", () => { press = null; });
