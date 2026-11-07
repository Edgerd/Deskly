/**
 * wm/overview.js — ⌃↑ 窗口总览（FS-06 多空间的降级形态）
 *
 * 多空间（Spaces）/ 调度中心在浏览器新标签页里没有对应物（单视口单文档），
 * 按 02 报告 FS-06 的替代规格落地为「窗口总览」单层浮层：
 * - ⌃↑ 打开：平铺显示所有可见窗口的静态缩略图（复用 wm/genie-capture.js 快照管线），
 *   点按聚焦；全屏 / 分屏窗口排在第一行并加角标；
 * - 方向键移动选区、Enter 聚焦、Esc / 再按 ⌃↑ 关闭；
 * - 顶部不做空间栏（不实现任意多桌面）；触控板三/四指手势浏览器不可达，不实现。
 *
 * 用户可感知的后果（02 报告口径）：无法把窗口组织到多个桌面；窗口多的时候靠
 * 最小化与台前调度收敛；全屏应用之间只能顺序轮换（⌃←/⌃→），没有空间栏全局视图。
 */

import { Z } from "../zindex.js";
import { records, getVisibleWindows, focusWindow } from "./stack.js";
import { frameOf } from "./frame.js";
import { inSplit } from "./spaces.js";
import { i18n } from "../i18n.js";

let overlay = null;
let cards = [];
let sel = 0;

export function isOverviewOpen() {
    return !!(overlay && overlay.isConnected);
}

/** 选区移动：网格按行宽估算列数（CSS grid auto-fill，列宽约 220px + 16 间距）。 */
function columns() {
    const w = window.innerWidth - 96;
    return Math.max(1, Math.floor(w / 236));
}

function applySelection() {
    cards.forEach((c, i) => c.classList.toggle("selected", i === sel));
    const cur = cards[sel];
    if (cur && typeof cur.scrollIntoView === "function") cur.scrollIntoView({ block: "nearest" });
}

function activate() {
    const card = cards[sel];
    if (!card) return;
    const el = card._window;
    close();
    if (el && el.isConnected) focusWindow(el);
}

/** 关闭总览（不动窗口状态）。 */
export function close() {
    if (!isOverviewOpen()) return;
    overlay.classList.remove("visible");
    const node = overlay;
    overlay = null;
    cards = [];
    setTimeout(() => node.remove(), 200);
    document.removeEventListener("keydown", onKey, true);
}

/** 打开总览：平铺全部可见窗口（含当前全屏/分屏空间里的，标角标）。 */
export function open() {
    if (isOverviewOpen()) { close(); return; }
    const wins = getVisibleWindows();
    if (!wins.length) return;

    overlay = document.createElement("div");
    overlay.id = "deskly-overview";
    overlay.style.zIndex = String(Z.OVERVIEW);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", i18n.t("overview.title", "窗口总览"));

    const grid = document.createElement("div");
    grid.className = "ov-grid";
    overlay.appendChild(grid);

    // 全屏 / 分屏窗口排第一行（先排它们，角标说明），其余按层级序
    const special = wins.filter((w) => (records.get(w) && records.get(w).fullscreen) || inSplit(w));
    const normal = wins.filter((w) => !special.includes(w));
    const ordered = [...special, ...normal];
    cards = ordered.map((w, i) => {
        const rec = records.get(w);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "ov-card";
        card._window = w;
        const thumb = document.createElement("div");
        thumb.className = "ov-thumb";
        const label = document.createElement("span");
        label.className = "ov-label";
        label.textContent = (rec && rec.name) || w.id;
        card.appendChild(thumb);
        card.appendChild(label);
        if ((rec && rec.fullscreen) || inSplit(w)) {
            const badge = document.createElement("span");
            badge.className = "ov-badge";
            badge.textContent = rec && rec.fullscreen
                ? i18n.t("overview.badgeFullscreen", "全屏")
                : i18n.t("overview.badgeSplit", "分屏");
            card.appendChild(badge);
        }
        card.addEventListener("click", () => { sel = i; activate(); });
        card.addEventListener("pointerenter", () => { sel = i; applySelection(); });
        grid.appendChild(card);
        // 快照异步填充：原生截图不可用时留空底（总览结构不依赖截图成功）
        import("./genie-capture.js").then((m) => m.snapshotFor(w, frameOf(w))).then((snap) => {
            if (snap && card.isConnected) thumb.appendChild(snap);
        }).catch(() => {});
        return card;
    });

    // 默认选中当前焦点窗
    const focused = ordered.findIndex((w) => w.classList.contains("is-active"));
    sel = focused >= 0 ? focused : 0;

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => { if (overlay) overlay.classList.add("visible"); });
    applySelection();
}

function onKey(e) {
    if (!isOverviewOpen()) return;
    const cols = columns();
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); activate(); return; }
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
    if (!(e.key in moves)) return;
    e.preventDefault();
    e.stopPropagation();
    const next = sel + moves[e.key];
    if (next >= 0 && next < cards.length) { sel = next; applySelection(); }
}

/** ⌃↑ 开关总览（facade 的全局 keydown 转调）。 */
export function toggle() {
    if (isOverviewOpen()) close(); else open();
}
