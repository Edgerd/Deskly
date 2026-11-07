/**
 * wm/stack.js — 焦点栈与层级分带
 *
 * 职责（从 window-manager.js 抽出，单一口径）：
 * - 窗口记录表 records 与焦点栈 stack 的唯一持有者；
 * - commitStack：按「层级分带 + 栈序 + 子窗紧随母窗」分配 z-index；
 * - 层级分带（NW-4）：窗口总段 [WINDOW_MIN, WINDOW_MAX] 不变，内部四带——
 *   normal 2050–4499（默认）/ floating 4500–5999（浮动工具窗）
 *   panel 6000–7499（面板）/ modal 7500–9000（仅模态子窗自动获得，不开放声明）。
 *   子窗不占独立层级，恒为母窗同带 +1（靠「紧随母窗」的排序保证）；
 * - 焦点判定：is-active / 红绿灯灰化 / focus & blur 事件；
 * - stateOf 快照（含 NW-4 新增的 level / role / parent 字段，纯新增键，向后兼容）。
 *
 * 与 macOS 的对齐点不变：层级由栈序推导，不再无上限自增；
 * 带内仍是焦点栈序，全部仍低于 Z.GENIE(9450) 与 Dock(9500)。
 */

import { Z } from "../zindex.js";
import { updateMenu } from "../finderbar.js";
import { setTrafficLightsActive, getTrafficLights } from "../ui/trafficLights.js";
import { frameOf } from "./frame.js";
import { emitWindowEvent } from "./events.js";

/** 层级区间：窗口段 [WINDOW_MIN, WINDOW_MAX]，Dock 固定 9500，所以窗口永不越界。 */
export const WINDOW_Z_MIN = Z.WINDOW_MIN;
export const WINDOW_Z_MAX = Z.WINDOW_MAX;

/**
 * 窗口层级分带（NW-4）。每带内按焦点栈序递增；带上限只是名义边界，
 * 极端溢出时继续递增（相对序不变），不做整体回拉 —— 同屏窗口数远到不了这个量级。
 */
export const LEVEL_BANDS = Object.freeze({
    normal: Object.freeze([WINDOW_Z_MIN, 4499]),
    floating: Object.freeze([4500, 5999]),
    panel: Object.freeze([6000, 7499]),
    modal: Object.freeze([7500, WINDOW_Z_MAX]),
});

/** 可声明的层级（modal 只能由模态子窗自动获得，见 relations.js）。 */
export const DECLARABLE_LEVELS = Object.freeze(["normal", "floating", "panel"]);

/** 窗口记录表：元素 -> 控制器状态。WeakMap 让被移除的窗口自动回收。 */
export const records = new WeakMap();
/** 焦点栈：下标 0 最底、末尾最前。层级由栈序推导。 */
export const stack = [];
/** 上一次分配给窗口的 z-index（仅用于对外读数与上限告警）。 */
export let zCounter = WINDOW_Z_MIN - 1;

/** 取窗口记录（可能不存在）。 */
export function recOf(el) {
    return el ? records.get(el) : undefined;
}

/** 当前被托管的窗口（栈序，底 → 顶）。 */
export function getWindows() {
    return stack.filter((el) => el.isConnected);
}

/**
 * 是不是一个真窗口：带 .window 类，且不在菜单栏 / 菜单 / 程序坞 / 桌面图标层里。
 * 顶栏菜单里历史上出现过 <p class="window">，按类名全量遍历会给它挂红绿灯、
 * 绑拖动，污染成「伪窗口」并让 getElementById 命中错对象。
 */
export function isWindowElement(el) {
    if (!el || !el.classList || !el.classList.contains("window")) return false;
    if (el.closest(".finderbar, .menu, .dockcontainer, .desktop, .launchpad")) return false;
    return true;
}

/**
 * 当前可见窗口（排除关闭中、最小化、被藏掉的、被压进非活动全屏/分屏空间的），
 * 按层级从高到低。
 * @returns {HTMLElement[]}
 */
export function getVisibleWindows() {
    return stack
        .filter((el) => el.isConnected && !el.classList.contains("closing") && !isMinimized(el)
            && el.style.display !== "none" && !el.classList.contains("wm-space-hidden")
            && !el.classList.contains("wm-shelved"))
        .reverse();
}

/** 最靠上的可见窗口（顶栏菜单与快捷键的作用对象）。 */
export function getTopWindow() {
    return getVisibleWindows()[0];
}

/** 最小化判定：类名 / 标记位 / dock 动画留下的 display:none 三处都可能表达它。 */
export function isMinimized(el) {
    // 判空是必需的：本函数被 dock / 菜单 / winctl 当公开读数用，
    // 传入一个已释放或查不到的元素时，读 el.classList 就是一记 TypeError。
    if (!el || !el.classList) return false;
    return !!(el._minimized || el.classList.contains("minimized") || el.style.display === "none");
}

/** 按元素 / id / 显示名解析窗口（显示名可能被 CSS 选择器转义，先走 getElementById）。 */
export function resolveWindow(target) {
    if (!target) return null;
    if (typeof target === "string") {
        const byId = document.getElementById(target);
        if (isWindowElement(byId)) return byId;
        return Array.from(document.querySelectorAll("body > .window"))
            .find((w) => w.dataset.appName === target || w.id === target) || null;
    }
    return isWindowElement(target) ? target : null;
}

/** 窗口的生效层级：模态子窗走自己的 modal 带；普通子窗恒随母窗同带。 */
function effectiveLevel(el) {
    const rec = records.get(el);
    if (!rec) return "normal";
    if (rec.modal) return "modal";
    if (rec.parent) {
        const parentRec = records.get(rec.parent);
        if (parentRec && parentRec.level) return parentRec.level;
    }
    return rec.level || "normal";
}

/**
 * 展开焦点栈为「分配序」：每个母窗之后紧随其全部子孙（递归），
 * 其余窗口保持栈序 —— 子窗恒在母窗上一层、栈内相邻（NW-1）。
 * @returns {HTMLElement[]}
 */
function allocationOrder() {
    const ordered = [];
    const emitted = new Set();
    const emit = (el) => {
        if (emitted.has(el)) return;
        emitted.add(el);
        ordered.push(el);
        stack.forEach((w) => {
            const r = records.get(w);
            if (r && r.parent === el) emit(w);
        });
    };
    stack.forEach((el) => {
        const r = records.get(el);
        if (r && r.parent && stack.includes(r.parent)) return; // 由母窗分支带出
        emit(el);
    });
    return ordered;
}

/**
 * 按焦点栈 + 层级分带重排 z-index（NW-4）。
 * 旧实现是「每次置顶 +1，逼近上限再全量重排」，窗口数远达不到上限时数字无意义；
 * 后来是纯栈序单段分配；现在先按带分组（带内保持分配序），各带从自己的下界起排。
 */
export function commitStack() {
    const ordered = allocationOrder();
    let last = WINDOW_Z_MIN - 1;
    for (const key of Object.keys(LEVEL_BANDS)) {
        let z = LEVEL_BANDS[key][0] - 1;
        ordered.forEach((el) => {
            if (effectiveLevel(el) !== key) return;
            z += 1;
            el.style.zIndex = String(z);
            last = z;
        });
    }
    zCounter = last;
}

export function pushStack(el) {
    const i = stack.indexOf(el);
    if (i >= 0) stack.splice(i, 1);
    stack.push(el);
}

/**
 * 标记活跃窗口：红绿灯灰化 + .is-active（样式表据此区分阴影强度）。
 * 同时派发 window:focus / window:blur（NW-8）。
 * @param {HTMLElement|null} win
 */
export function setFocusedWindow(win) {
    const prev = [];
    document.querySelectorAll("body > .window").forEach((w) => {
        if (!isWindowElement(w)) return;
        const active = w === win;
        if (w.classList.contains("is-active") && !active) prev.push(w);
        w.classList.toggle("is-active", active);
        setTrafficLightsActive(w, active);
    });
    prev.forEach((w) => emitWindowEvent("blur", w));
    if (win && isWindowElement(win)) {
        lastFocused = win;
        emitWindowEvent("focus", win);
    }
    notifySpaces();
}

/**
 * 置顶并取焦点。聚焦母窗时其子窗由 commitStack 的分配序紧随其上；
 * 聚焦子窗时把母窗链一并抬升（macOS：点子窗，母窗跟着上来）。
 * @param {HTMLElement} el 窗口
 * @param {string} [menuName] 顶栏菜单要切到的应用名（默认用窗口自己的名字）
 */
export function focusWindow(el, menuName) {
    if (!el || !el.isConnected) return;
    // 延迟取 manage：本模块不 import lifecycle（模块求值环），由 lifecycle 在求值期注入。
    const rec = manageHook ? manageHook(el) : records.get(el);
    if (!rec) return;
    if (isMinimized(el) && restoreHook) restoreHook(el);
    // 母窗链先入栈（底 → 顶），再压本窗；子窗排序由 commitStack 保证
    const chain = [];
    let p = rec.parent;
    while (p) {
        chain.unshift(p);
        const pr = records.get(p);
        p = pr ? pr.parent : null;
    }
    chain.forEach((w) => { if (w.isConnected) pushStack(w); });
    pushStack(el);
    commitStack();
    const name = menuName || rec.name || el.id;
    if (name) updateMenu(name);
    setFocusedWindow(el);
}

/** 兼容旧调用姿势：bringToFront(win, name)。 */
export function bringToFront(el, name) {
    focusWindow(el, name);
}

/** 顶栏「前置全部窗口」：按栈序自底向上置顶一遍，等价于 macOS 的窗口轮转。 */
export function bringAllWindowsToFront() {
    const visible = getVisibleWindows().slice().reverse();
    visible.forEach((el) => focusWindow(el));
}

/**
 * 按当前可见窗口自动切换顶栏菜单；没有可见窗口时回到「访达」。
 */
export function updateActiveAppMenu() {
    const top = getTopWindow();
    if (!top) {
        updateMenu("访达");
        setFocusedWindow(null);
        return;
    }
    const rec = records.get(top);
    const name = (rec && rec.name) || top.id;
    if (name) updateMenu(name);
    setFocusedWindow(top);
}

// ── 状态写入：把内部状态同步到 DOM 属性（样式与外部读取都看 DOM，不看私有字段） ──

export function syncState(el, rec) {
    el.classList.toggle("wm-zoomed", !!rec.zoomed);
    el.classList.toggle("wm-fullscreen", !!rec.fullscreen);
    el.classList.toggle("wm-tiled", !!rec.tiled);
    el.dataset.wmState = rec.fullscreen ? "fullscreen" : rec.zoomed ? "zoom" : rec.tiled ? `tile-${rec.tiled}` : "normal";
    // FS-11：全屏态绿灯悬停符号换为「退出全屏」，由组件按属性换形
    const lights = getTrafficLights(el);
    if (lights) lights.toggleAttribute("host-fullscreen", !!rec.fullscreen);
    // 全屏外壳类（菜单栏/程序坞收起）的唯一权威在 wm/spaces.js：
    // 全屏是独立空间 —— 只有「当前焦点在全屏/分屏窗口上」时才收，不是「栈里有全屏」就收。
    notifySpaces();
}

/** 用户手动改了几何（拖动 / 缩放 / center / frame setter）即宣告托管状态结束。 */
export function detachStates(rec, keepNormal) {
    const el = rec.el;
    if (rec.fullscreen) {
        // 全屏必须一并脱开：漏掉这一位会留下三重错乱 —— 几何已是普通尺寸、
        // rec.fullscreen 仍为 true、外壳类不摘，下一次 resize 又把窗口弹回全屏。
        rec.fullscreen = false;
    }
    if (rec.zoomed || rec.tiled) {
        if (!keepNormal) rec.normal = frameOf(el);
        rec.zoomed = false;
        rec.tiled = null;
    }
    syncState(el, rec);
}

/**
 * 当前状态快照（插件与顶栏菜单据此决定菜单项文案与禁用态）。
 * NW-4 起新增 level / role / parent / modal 字段（纯新增键，向后兼容）。
 */
export function stateOf(target) {
    const el = resolveWindow(target);
    if (!el) return null;
    const rec = records.get(el);
    return {
        el,
        frame: frameOf(el),
        normal: rec && rec.normal ? { ...rec.normal } : frameOf(el),
        minimized: isMinimized(el),
        zoomed: !!(rec && rec.zoomed),
        fullscreen: !!(rec && rec.fullscreen),
        tiled: (rec && rec.tiled) || null,
        resizable: !el.classList.contains("no-resize"),
        active: el.classList.contains("is-active"),
        role: (rec && rec.role) || "normal",
        level: (rec && rec.level) || "normal",
        parent: (rec && rec.parent) || null,
        modal: !!(rec && rec.modal),
    };
}

/**
 * 设置窗口层级（NW-4）。modal 档仅模态子窗自动获得，这里拒绝外部直接指定。
 * @param {HTMLElement} el
 * @param {"normal"|"floating"|"panel"} level
 * @returns {boolean}
 */
export function setLevel(el, level) {
    if (!DECLARABLE_LEVELS.includes(level)) return false;
    const rec = records.get(el);
    if (!rec) return false;
    if (rec.level === level) return true;
    rec.level = level;
    commitStack();
    emitWindowEvent("level-change", el);
    return true;
}

/** 内核专用：直接写层级位（模态子窗用，不走 setLevel 的白名单）。 */
export function assignLevel(el, level) {
    const rec = records.get(el);
    if (!rec || !LEVEL_BANDS[level]) return;
    if (rec.level === level) return;
    rec.level = level;
    commitStack();
    emitWindowEvent("level-change", el);
}

// ── 求值环解耦：manage / restore 由 lifecycle.js 在求值期注入 ──
// stack 是层级与焦点的底层层，lifecycle 依赖它；反过来 focusWindow 又需要
// 「未托管先接管」「最小化先还原」。静态互 import 在本项目是合法的（函数声明提升），
// 但 finderbar → window.js → window-manager → lifecycle → stack → finderbar 这条环
// 会把求值顺序变成拆弹，改成注入后依赖只剩一个方向。
let manageHook = null;
let restoreHook = null;
export function bindLifecycleHooks({ manage, restore }) {
    manageHook = manage;
    restoreHook = restore;
}

// ── 全屏/分屏伪空间（FS-02/04）：wm/spaces.js 在求值期注入同步钩子 ──
// stack 不 import spaces（spaces 需要 stack 的全部读数，反向注入保持单向依赖）。
// 焦点变化、状态写入、最小化/还原/关闭后都要重算「现在该显示哪个空间」。
let spacesHook = null;
let lastFocused = null;
export function bindSpacesSync(fn) { spacesHook = fn; }
export function notifySpaces() { if (spacesHook) spacesHook(lastFocused); }
export function getLastFocused() { return lastFocused; }
