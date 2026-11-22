/**
 * wm/app-windows.js — Dock 图标「应用窗口缩略条」（F-08）
 *
 * macOS Sequoia：⌥点按或用力长按程序坞图标，图标上方弹出该应用全部窗口的
 * 缩略条；点缩略图把窗口带到前台，悬停出现关闭钮，Esc / 点条外关闭，方向键 + 回车可达。
 *
 * - 入口在 dock.js（⌥click + 长按 DOCK_WINDOWS_PRESS_MS，与绿键常量同区定义于 frame.js）；
 * - 快照与台前调度/总览共用 genie-capture.ensureThumbnail（同一份快照管线，不另写一份）；
 * - 关闭单窗走 window.js 的 closeWindow（动态 import，避免 app-windows ↔ window 的静态环）；
 * - G5：条的出现/消失走 CSS 过渡，reduce-motion 时由样式直接关闭动画。
 */

import { stack, records, focusWindow, isMinimized, isWindowElement } from "./stack.js";
import { frameOf } from "./frame.js";
import { ensureThumbnail } from "./genie-capture.js";
import { Z } from "../zindex.js";

/** 当前打开的缩略条根元素；null = 未打开。 */
let strip = null;
/** 键盘导航的当前卡片索引。 */
let cursor = 0;
/** 卡片 -> 窗口元素的映射，点按/回车时用。 */
const cardWins = new Map();

/** 窗口 id 去掉多实例后缀（与 Dock syncRunningApps 同口径）。 */
function baseWindowId(el) {
  return String(el.id || "").replace(/#\d+$/, "");
}

/** 该应用的全部窗口（含最小化；跨空间；关闭中的不算）。 */
function windowsOfApp(appName) {
  return stack.filter((el) => {
    if (!isWindowElement(el) || !el.isConnected) return false;
    if (el.classList.contains("closing")) return false;
    const rec = records.get(el);
    if (!rec) return false;
    return baseWindowId(el) === appName
      || (el.dataset && el.dataset.appId === appName);
  });
}

export function isStripOpen() {
  return !!strip;
}

/** 关闭缩略条（幂等）。 */
export function closeStrip() {
  if (!strip) return;
  const el = strip;
  strip = null;
  el.classList.add("wm-appstrip-closing");
  setTimeout(() => el.remove(), 160);
}

/** 全局一次性监听：点条外 / Esc 关闭（模块求值期挂好）。 */
document.addEventListener("mousedown", (e) => {
  if (!strip) return;
  if (strip.contains(e.target)) return;
  // 点的是 Dock 图标本身时不关：dock.js 会在指针抬起后决定重开或复用
  if (e.target && e.target.closest && e.target.closest("#dock")) return;
  closeStrip();
});

document.addEventListener("keydown", (e) => {
  if (!strip) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeStrip();
    return;
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const cards = strip.querySelectorAll(".wm-appstrip-card");
    if (!cards.length) return;
    cursor = (cursor + (e.key === "ArrowRight" ? 1 : cards.length - 1)) % cards.length;
    cards.forEach((c, i) => c.classList.toggle("wm-appstrip-focus", i === cursor));
    return;
  }
  if (e.key === "Enter") {
    const cards = strip.querySelectorAll(".wm-appstrip-card");
    const card = cards[cursor];
    if (card) {
      e.preventDefault();
      const win = cardWins.get(card);
      if (win) activateWindow(win);
    }
  }
});

/** 点卡片/回车：窗口带回前台（最小化则先还原），然后收条。 */
async function activateWindow(win) {
  closeStrip();
  if (!isWindowElement(win) || !win.isConnected) return;
  if (isMinimized(win)) {
    try {
      const wmMod = await import("../window.js");
      if (wmMod.setMinimized) wmMod.setMinimized(win, false);
    } catch { /* window.js 不可用时仅前置 */ }
  }
  focusWindow(win);
}

/** 关闭单扇窗（缩略卡上的 ×）。 */
async function closeOneWindow(win) {
  try {
    const wmMod = await import("../window.js");
    if (wmMod.closeWindow) wmMod.closeWindow(win);
  } catch { /* 关不掉就只把卡片标灰，不做假动作 */ }
}

/**
 * 打开某应用的窗口缩略条。
 * @param {string} appName Dock 图标的 alt（应用显示名）
 * @param {HTMLElement} anchorEl Dock 图标容器（条锚定其上方）
 * @param {string} [iconSrc] 应用图标地址，无快照窗口的占位用
 * @returns {boolean} 是否真的打开了（该应用没有窗口时返回 false，调用方按住不放不做假动作）
 */
export function openAppWindowsStrip(appName, anchorEl, iconSrc) {
  closeStrip();
  const wins = windowsOfApp(appName);
  if (!wins.length) return false;

  const el = document.createElement("div");
  el.className = "wm-appstrip";
  el.style.zIndex = String(Z.dock + 20);
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", appName);

  cardWins.clear();
  cursor = 0;
  wins.forEach((win, i) => {
    const rec = records.get(win);
    const card = document.createElement("div");
    card.className = "wm-appstrip-card" + (i === cursor ? " wm-appstrip-focus" : "");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "-1");
    card.setAttribute("aria-label", (rec && rec.name) || baseWindowId(win));
    cardWins.set(card, win);

    // 快照区：genie-capture 的 canvas 直接入位；拍不出来（被盖住/最小化且无缓存）
    // 就给图标占位，不画空白假缩略图。
    const shot = document.createElement("div");
    shot.className = "wm-appstrip-shot";
    ensureThumbnail(win, frameOf(win)).then((snap) => {
      if (!snap || !el.isConnected) return;
      shot.replaceChildren(snap);
      card.classList.add("wm-appstrip-has-snap");
    }).catch(() => { /* 保持占位 */ });
    if (iconSrc) {
      const ph = document.createElement("img");
      ph.className = "wm-appstrip-placeholder";
      ph.src = iconSrc;
      ph.alt = "";
      shot.appendChild(ph);
    }

    // 标题行：窗口名（多实例带 #N），最小化的窗口加标记
    const title = document.createElement("div");
    title.className = "wm-appstrip-title";
    title.textContent = (rec && rec.name) || baseWindowId(win);
    if (isMinimized(win)) title.classList.add("wm-appstrip-min");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "wm-appstrip-close";
    close.setAttribute("aria-label", `关闭 ${title.textContent}`);
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeOneWindow(win);
      card.remove();
      cardWins.delete(card);
      if (!strip || !strip.querySelector(".wm-appstrip-card")) closeStrip();
    });

    card.append(shot, title, close);
    card.addEventListener("click", () => activateWindow(win));
    el.appendChild(card);
  });

  // 锚定：Dock 图标上方水平居中；出界时向内收
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    if (anchorEl && anchorEl.isConnected) {
      const a = anchorEl.getBoundingClientRect();
      const s = el.getBoundingClientRect();
      let left = a.left + a.width / 2 - s.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - s.width - 8));
      el.style.left = `${Math.round(left)}px`;
    }
    el.classList.add("wm-appstrip-open");
  });
  strip = el;
  return true;
}
