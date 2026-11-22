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

/**
 * F-14：收集当前的空间清单（伪空间口径，与 spaces.js 的空间模型一一对应）。
 * @param {HTMLElement[]} wins 当前可见窗口
 * @returns {{label: string, title?: string, target?: HTMLElement, current: boolean}[]}
 */
function buildSpaceEntries(wins) {
    const active = wins.find((w) => w.classList.contains("is-active"));
    const entries = [];
    const seenSplit = new Set();
    // 桌面空间：target 为空 = 只退出总览，回到桌面所在的空间
    entries.push({ label: i18n.t("overview.spaceDesktop", "桌面"), target: null, current: true });
    // 全屏窗口各占一个空间；分屏对合成一个空间条目（同一对只列一次）
    wins.forEach((w) => {
        const rec = records.get(w);
        if (!rec) return;
        if (rec.fullscreen) {
            entries.push({
                label: rec.name || w.id,
                title: i18n.t("overview.spaceFullscreen", "全屏幕 — {n}").replace("{n}", rec.name || w.id),
                target: w,
                current: active === w,
            });
            return;
        }
        if (inSplit(w) && !seenSplit.has(w)) {
            const partner = wins.find((o) => {
                if (o === w || seenSplit.has(o)) return false;
                const oRec = records.get(o);
                return !!(oRec && oRec.split && oRec.split !== rec.split);
            });
            if (partner) {
                seenSplit.add(w);
                seenSplit.add(partner);
                const pRec = records.get(partner);
                const pairLabel = `${rec.name || w.id} ＋ ${pRec ? pRec.name || partner.id : partner.id}`;
                entries.push({
                    label: pairLabel,
                    title: i18n.t("overview.spaceSplit", "分屏浏览 — {n}").replace("{n}", pairLabel),
                    target: w,
                    current: active === w || active === partner,
                });
            }
        }
    });
    // 有窗口在非桌面空间（全屏/分屏聚焦中）时，桌面条目不再是当前空间
    if (entries.some((e) => e.current && e.target)) entries[0].current = false;
    return entries;
}

/** 选区移动：网格按行宽估算列数（CSS grid auto-fill，列宽约 220px + 16 间距）。 */
function columns() {
    const w = window.innerWidth - 96;
    return Math.max(1, Math.floor(w / 236));
}

function applySelection() {
    if (sel >= cards.length) sel = Math.max(0, cards.length - 1);
    cards.forEach((c, i) => c.classList.toggle("selected", i === sel));
    const cur = cards[sel];
    if (cur && typeof cur.scrollIntoView === "function") cur.scrollIntoView({ block: "nearest" });
}

/** F-10：总览里的关闭钮 —— 直接关闭该窗口，卡片就地移除（macOS Mission Control 同款）。 */
async function closeWindowFromCard(card, win) {
    try {
        const m = await import("../window.js");
        if (m.closeWindow) m.closeWindow(win);
    } catch { /* 关不掉就不做假动作：卡片保留 */ }
    card.remove();
    cards = cards.filter((c) => c.isConnected);
    applySelection();
    if (!cards.length) close();
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

    // ── F-14：顶部空间条 ──
    // 本项目的空间模型是「伪空间」（单视口单文档，见 wm/spaces.js 头注）：桌面空间 +
    // 每个全屏窗口 + 每组分屏各算一个空间。条上如实列出这些空间、点条切换焦点，
    // 当前所在空间高亮。macOS 的「添加桌面」按钮不做——那需要真多桌面，伪空间
    // 模型下做出来就是假功能（G9），按 02 报告 FS-06 的替代口径降级。
    const spaces = buildSpaceEntries(wins);
    if (spaces.length > 1) {
        const bar = document.createElement("div");
        bar.className = "ov-spaces";
        spaces.forEach((sp) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "ov-space" + (sp.current ? " current" : "");
            chip.textContent = sp.label;
            chip.title = sp.title || sp.label;
            chip.addEventListener("click", () => {
                close();
                if (sp.target && sp.target.isConnected) focusWindow(sp.target);
            });
            bar.appendChild(chip);
        });
        overlay.appendChild(bar);
    }

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
        const title = (rec && rec.name) || w.id;
        label.textContent = title;
        // F-10：悬停给出「窗口名 — 应用名」（多实例后缀去掉，与 Dock 同口径）
        const appName = String(w.id || "").replace(/#\d+$/, "");
        if (appName && appName !== title) card.title = `${title} — ${appName}`;
        else card.title = title;
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
        // F-10：悬停出现的关闭钮 —— 直接关闭该窗口（事件不冒泡成卡片激活）
        const closeBtn = document.createElement("span");
        closeBtn.className = "ov-close";
        closeBtn.setAttribute("role", "button");
        closeBtn.setAttribute("aria-label", i18n.t("overview.closeWindow", "关闭窗口"));
        closeBtn.textContent = "×";
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeWindowFromCard(card, w);
        });
        card.appendChild(closeBtn);
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
