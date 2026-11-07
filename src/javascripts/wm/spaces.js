/**
 * wm/spaces.js — 全屏伪空间与分屏浏览（FS-02 / FS-03 / FS-04）
 *
 * macOS 里全屏 App 独占一个空间：该空间里只有这一个 App，不存在「普通窗口浮在
 * 全屏窗口上面」的状态。浏览器新标签页是单视口单文档，真多桌面没有对应物，
 * 这里用「同一视口内的伪空间切换」模拟：
 *
 * - 焦点落在全屏窗口上：它是当前空间 —— 其余全屏窗口与分屏对全部挂
 *   .wm-space-hidden（visibility，getVisibleWindows 随之排除），菜单栏与 Dock 收起；
 * - 焦点移到普通窗口（Dock 再开应用、点桌面图标）：全屏/分屏窗口压栈隐藏，
 *   html.deskly-fullscreen 摘除，菜单栏回来 —— 等价于「离开全屏空间回到桌面」；
 * - 再聚焦全屏窗口（Dock 点它的图标）：复原。
 *
 * 分屏浏览（Split View，降级形态，视觉全量实现）：
 * - 入口 = 绿键菜单「全屏幕 › 屏幕左侧 / 屏幕右侧」，选侧后对侧弹出可拼窗口清单；
 * - 两侧就位后菜单栏与 Dock 按全屏同一套收起；中间 6px 分隔条可拖改占比
 *   （偏好持久化 localStorage），连按恢复 50/50；
 * - 退出：任一侧绿键/「将窗口移到桌面」= 该窗回桌面用户框，另一侧升为独占全屏；
 *   一侧被关闭时另一侧自动升为独占全屏。
 * - 不实现（报告已定调）：触控板手势（浏览器不可达）、真多桌面、拖标题栏互换左右。
 *
 * 同步入口只有一个 syncSpaces(focusedEl)，由 stack.js 在焦点/状态变化时回调
 * （bindSpacesSync 注入，保持 stack → 无依赖的单向方向）。
 */

import {
    records, stack, isMinimized, focusWindow, bindSpacesSync, getLastFocused, syncState,
} from "./stack.js";
import { frameOf, applyFrame, displayFrame, limitsOf } from "./frame.js";
import { i18n } from "../i18n.js";
import { createContextMenu } from "../ui/contextMenu.js";

/** 分隔条宽度（px）。 */
const SPLIT_DIVIDER_W = 6;
/** 占比允许区间（两侧都不能窄到点不到）。 */
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;
/** 占比持久化键（用户偏好，跨会话记住）。 */
const RATIO_STORE_KEY = "deskly.split.ratio";

/** 当前分屏对：{ left, right, ratio }；null = 无分屏。 */
let split = null;
/** 已选一侧、等待另一侧点选的待定态：{ el, side }。 */
let pendingSplit = null;

/** 分屏对中的成员（存活的）。 */
function splitMembers() {
    if (!split) return [];
    return [split.left, split.right].filter((w) => w && w.isConnected);
}

/** 该窗是否在当前分屏对里。 */
export function inSplit(el) {
    return !!(split && el && (split.left === el || split.right === el));
}

/** 探针与菜单用：当前分屏状态快照。 */
export function splitState() {
    if (!split) return null;
    return { left: split.left, right: split.right, ratio: split.ratio };
}

/**
 * 伪空间同步（唯一权威）：按当前焦点窗决定「现在该显示哪个空间」。
 * 由 stack 在 focus/blur/状态写入/最小化/还原/关闭后回调。
 * @param {HTMLElement|null} focused 当前焦点窗（缺省读 stack 的 lastFocused）
 */
export function syncSpaces(focused) {
    const focusEl = focused || getLastFocused();
    const fsWins = stack.filter((w) => {
        const r = records.get(w);
        return r && r.fullscreen && w.isConnected;
    });
    const pair = splitMembers();
    const focusedFs = !!(focusEl && fsWins.includes(focusEl) && !isMinimized(focusEl));
    const focusedSplit = !!(focusEl && pair.includes(focusEl) && !isMinimized(focusEl));
    const spaceOn = focusedFs || focusedSplit;

    fsWins.forEach((w) => w.classList.toggle("wm-space-hidden", w !== focusEl));
    pair.forEach((w) => w.classList.toggle("wm-space-hidden", !focusedSplit));
    document.documentElement.classList.toggle("deskly-fullscreen", spaceOn);
    applySpaceDim(spaceOn);
    syncDivider();
}

/** 全屏/分屏空间压暗墙纸的遮罩（FS-08）。独立 DOM、只动 opacity，
 *  不给 .wallpaper 加 filter —— 墙纸层是全屏底图，滤镜会把整屏重绘一次。 */
let spaceDim = null;
function applySpaceDim(on) {
    if (!on && !spaceDim) return;
    if (!spaceDim) {
        spaceDim = document.createElement("div");
        spaceDim.id = "deskly-space-dim";
        spaceDim.setAttribute("aria-hidden", "true");
        document.body.appendChild(spaceDim);
    }
    spaceDim.classList.toggle("on", !!on);
}

// ── 分屏浏览 ──

/** 读持久化占比（非法值回 0.5）。 */
function loadRatio() {
    const n = parseFloat(globalThis.localStorage ? localStorage.getItem(RATIO_STORE_KEY) : "");
    return Number.isFinite(n) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, n)) : 0.5;
}

function saveRatio(r) {
    try { localStorage.setItem(RATIO_STORE_KEY, String(r)); } catch { /* 配额满不致命 */ }
}

/** 分屏态下可拼窗口的判据：普通顶层窗、未全屏、未最小化、非待定方。 */
function pickable(w, except) {
    if (w === except) return false;
    const rec = records.get(w);
    if (!rec || rec.role !== "normal" || rec.parent) return false;
    if (rec.fullscreen || rec.split) return false;
    if (isMinimized(w) || !w.isConnected) return false;
    if (w.classList.contains("closing") || w.classList.contains("wm-space-hidden")) return false;
    return true;
}

/** 分屏准入闸（台前调度开启时禁止进入分屏，由 stage-manager 在求值期注入）。 */
let splitGuard = null;
export function bindSplitGuard(fn) { splitGuard = fn; }

/**
 * 进入分屏：先把本窗记为待定侧，再弹出「另一侧选哪扇窗」清单。
 * 同时只允许一组分屏（macOS 单显示器语义）；已有分屏时返回 false（菜单侧会禁用）。
 * @param {HTMLElement} el
 * @param {"left"|"right"} side
 * @returns {boolean}
 */
export function enterSplit(el, side) {
    if (split || pendingSplit) return false;
    if (splitGuard && splitGuard()) return false;
    const rec = records.get(el);
    if (!rec || rec.role !== "normal" || rec.parent) return false;
    if (rec.fullscreen) return false;
    if (!rec.normal) rec.normal = frameOf(el);
    pendingSplit = { el, side };
    openPartnerPicker(el, side);
    return true;
}

/** 对侧选窗清单：居中弹出，列出其余可拼窗口。 */
function openPartnerPicker(el, side) {
    const candidates = stack.filter((w) => pickable(w, el)).reverse();
    const items = [
        { type: "header", label: i18n.t("window.splitPick", "选择另一侧窗口") },
        ...candidates.map((w) => ({
            label: (records.get(w) && records.get(w).name) || w.id,
            action: () => chooseSplitPartner(w),
        })),
    ];
    if (!candidates.length) {
        items.push({ label: i18n.t("window.splitNone", "没有其他可拼贴的窗口"), disabled: true });
    }
    createContextMenu(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 3), items);
}

/**
 * 待定态的另一侧点选完成（菜单 / 探针共用入口）。
 * @param {HTMLElement} other
 * @returns {boolean}
 */
export function chooseSplitPartner(other) {
    if (!pendingSplit || !other || pendingSplit.el === other) return false;
    if (!pickable(other, pendingSplit.el)) return false;
    const { el, side } = pendingSplit;
    pendingSplit = null;
    // 程序化点选（快捷键/探针）也要把选窗菜单收掉，别留一张没人认领的浮层
    const strayMenu = document.querySelector("div.menu.contextmenu");
    if (strayMenu) strayMenu.remove();
    const orec = records.get(other);
    if (!orec.normal) orec.normal = frameOf(other);
    // 退出全屏伪空间才进得来分屏：若对方此刻缩放/平铺，先脱开回用户框
    if (orec.zoomed || orec.tiled) { orec.zoomed = false; orec.tiled = null; }
    split = side === "left"
        ? { left: el, right: other, ratio: loadRatio() }
        : { left: other, right: el, ratio: loadRatio() };
    records.get(split.left).split = "left";
    records.get(split.right).split = "right";
    layoutSplit(true);
    focusWindow(el);
    syncSpaces(el);
    return true;
}

/** 按占比铺开两侧几何；两侧各自的 min/max 声明是硬边界（如访达 min-width:800），
 *  夹完后另一侧吃剩余量 —— 与 macOS 分屏的最小宽度行为一致。 */
function layoutSplit(animate = false) {
    if (!split) return;
    const d = displayFrame();
    const avail = d.w - SPLIT_DIVIDER_W;
    const clampSide = (el, w) => {
        const lim = limitsOf(el);
        return Math.min(Math.max(w, lim.minW), lim.maxW);
    };
    const leftW = clampSide(split.left, Math.round(avail * split.ratio));
    const rightW = clampSide(split.right, avail - leftW);
    applyFrame(split.left, { x: d.x, y: d.y, w: leftW, h: d.h }, { animate });
    applyFrame(split.right, { x: d.x + leftW + SPLIT_DIVIDER_W, y: d.y, w: rightW, h: d.h }, { animate });
    syncState(split.left, records.get(split.left));
    syncState(split.right, records.get(split.right));
    syncDivider();
}

/**
 * 拖分隔条改占比（连按恢复 50/50 由分隔条自己的 dblclick 负责）。
 * @param {number} ratio 0~1，越界夹进允许区间
 */
export function setSplitRatio(ratio) {
    if (!split) return;
    split.ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
    layoutSplit(false);
    saveRatio(split.ratio);
}

/** 分屏期间视口变化：按同一占比重铺（facade 的 relayoutOnResize 转调）。 */
export function relayoutSplit() {
    if (split) layoutSplit(false);
}

/**
 * 退出分屏：移出方回桌面用户框，另一侧升为独占全屏（macOS 语义）。
 * @param {HTMLElement} el 要移回桌面的一侧
 * @param {{animate?: boolean}} [opts]
 */
export function exitSplit(el, opts = {}) {
    if (!split) return;
    const other = split.left === el ? split.right : split.left;
    const rec = records.get(el);
    const orec = other ? records.get(other) : null;
    split = null;
    hideDivider();
    if (rec) {
        rec.split = null;
        applyFrame(el, rec.normal || frameOf(el), { animate: opts.animate !== false });
        syncState(el, rec);
    }
    if (other && other.isConnected && orec) {
        orec.split = null;
        orec.fullscreen = true;
        applyFrame(other, displayFrame(), { animate: opts.animate !== false });
        syncState(other, orec);
        focusWindow(other);
        syncSpaces(other);
    } else {
        syncSpaces(el);
    }
}

/** 一侧被关闭：另一侧升为独占全屏（由 window:close 事件驱动）。 */
document.addEventListener("window:close", (e) => {
    const el = e.detail && e.detail.state && e.detail.state.el;
    if (!el || !split) return;
    if (el !== split.left && el !== split.right) return;
    const other = split.left === el ? split.right : split.left;
    split = null;
    hideDivider();
    if (other && other.isConnected) {
        const orec = records.get(other);
        if (orec) {
            orec.split = null;
            orec.fullscreen = true;
            applyFrame(other, displayFrame(), { animate: false });
            syncState(other, orec);
        }
    }
    syncSpaces(getLastFocused());
});

// ── 分隔条 ──

let divider = null;
function ensureDivider() {
    if (divider) return divider;
    divider = document.createElement("div");
    divider.id = "deskly-split-divider";
    divider.setAttribute("aria-hidden", "true");
    let dragging = false;
    divider.addEventListener("pointerdown", (e) => {
        if (!split) return;
        dragging = true;
        e.preventDefault();
        const move = (ev) => setSplitRatio(ev.clientX / Math.max(1, window.innerWidth));
        const up = () => {
            dragging = false;
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            document.removeEventListener("pointercancel", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
    });
    divider.addEventListener("dblclick", () => { if (!dragging) setSplitRatio(0.5); });
    return divider;
}

function syncDivider() {
    const pair = splitMembers();
    const active = !!split && pair.length === 2
        && document.documentElement.classList.contains("deskly-fullscreen")
        && pair.some((w) => w === getLastFocused());
    if (!active) { hideDivider(); return; }
    const d = ensureDivider();
    if (!d.isConnected) document.body.appendChild(d);
    const leftW = Math.round((window.innerWidth - SPLIT_DIVIDER_W) * split.ratio);
    d.style.left = `${leftW}px`;
}

function hideDivider() {
    if (divider && divider.isConnected) divider.remove();
}

// ── 空间序列切换（FS-03 降级形态：⌃← / ⌃→ 在全屏窗口与分屏对之间轮换） ──

/** 当前全部「空间」：每个全屏窗口一个，分屏对合算一个（焦点目标取左窗）。 */
function spaceSequence() {
    const seq = stack.filter((w) => {
        const r = records.get(w);
        return r && r.fullscreen && w.isConnected && !isMinimized(w);
    });
    if (split && splitMembers().length === 2) seq.push(split.left);
    return seq;
}

/**
 * 在全屏伪空间序列中轮换（macOS 全屏 App 间三指轻扫的键盘替代）。
 * 当前不在任何空间里时， ⌃←/⌃→ 不动作。
 * @param {1|-1} dir
 */
export function cycleSpaces(dir) {
    const seq = spaceSequence();
    if (seq.length < 2) return;
    const cur = getLastFocused();
    let idx = seq.indexOf(cur);
    if (idx < 0 && split && cur && inSplit(cur)) idx = seq.indexOf(split.left);
    if (idx < 0) return;
    const next = seq[(idx + dir + seq.length) % seq.length];
    focusWindow(next);
}

/** 求值期接线：stack 的焦点/状态变化回调到这里。 */
bindSpacesSync(syncSpaces);
