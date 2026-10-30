/**
 * popover.js — 浮出层：让下拉菜单显示到自己所属窗口之外
 *
 * 要解决的问题：窗口框 `.window{overflow:hidden}`（带圆角）、面板滚动容器
 * `.ss-panes{overflow-y:auto}`、卡片分组 `.ss-group{overflow:hidden}` 会把挂在触发按钮
 * 子树里的菜单一起裁掉 —— 菜单只能在窗口内那一小块地方显示，靠近窗口下缘时
 * 就被切成半截（历史 bug：系统设置 › 通用 › 语言的「简体中文」下拉）。
 *
 * 做法：打开时把菜单节点搬进 document.body 上的固定层（portal），关闭时送回原父级。
 * 两条被排除的路线，原因记在这里以免有人再走一遍：
 *   · 不用浏览器原生 top layer（`popover` 属性 / `<dialog>`）—— top layer 恒定盖过一切，
 *     会把 zindex.js 的层级表整个作废：下拉框会浮到菜单栏（9999）、亮度压暗层（10000）
 *     与锁屏遮罩（10010）之上，锁屏之后菜单还亮着。
 *   · 不用「原地改 position:fixed」—— 记事本窗口根带 `backdrop-filter`，会把自己变成
 *     fixed 后代的包含块，照样被自己的 `overflow:hidden` 裁掉。
 *
 * 搬出去的唯一代价是 CSS 作用域：`.settings .ss-menu` 这类后代选择器和 `--ss-*` 令牌
 * 都依赖祖先。所以每个浮层带一个作用域载体节点（`.os-popover-scope`），类名抄自所属
 * 窗口的根（`settings` / `notepad` / `finder`，或调用方用 `scope` 显式指定），选择器与
 * 令牌照旧命中；载体自身的盒子在 popover.css 里被清空，不带任何视觉。
 *
 * 关闭时机由本模块统一负责（调用方不再各挂各的 document 监听）：
 * 点浮层与触发元素之外、按 Esc、以及下面的 rAF 跟随循环发现触发元素已消失 /
 * 被隐藏（关窗、最小化、切面板）时自动收起。位置在窗口拖动、缩放、面板滚动时跟随。
 */

import { Z } from "../zindex.js";
import { log } from "../log.js";

const LAYER_CLASS = "os-popover-layer";
const SCOPE_CLASS = "os-popover-scope";
const EDGE = 8;            // 浮层与视口边缘的最小间距
const GAP_DEFAULT = 4;     // 浮层与触发元素的默认间距
const MIN_HEIGHT = 96;     // 翻转后仍放不下时给菜单留的最低可滚动高度

/** @type {HTMLElement|null} 唯一的层宿主，懒建 */
let layer = null;
/** @type {Set<object>} 当前打开的浮层 */
const entries = new Set();
let frame = 0;
let seq = 0;
let bound = false;

/** 懒建层宿主。z-index 与 .os-popover-layer 的样式在 popover.css 里（值同 Z.POPOVER）。 */
function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.className = LAYER_CLASS;
    document.body.append(layer);
    return layer;
}

/** 未显式给 scope 时，取所属窗口根上的类名（`window` 本身不算，它会带回窗口外观）。 */
function scopeFrom(anchor) {
    const root = anchor.closest(".window");
    if (!root) return [];
    return Array.from(root.classList).filter((name) => name !== "window");
}

function bindGlobal() {
    if (bound) return;
    bound = true;
    // 用 pointerdown 而不是 click：菜单项的 click 处理器要照常跑完，
    // 而 click 的捕获阶段早于目标上的 click 监听，先关再点会依赖事件路径的旧快照。
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
}

function onPointerDown(event) {
    if (!entries.size) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    Array.from(entries).forEach((entry) => {
        if (entry.host.contains(target) || entry.anchor.contains(target)) return;
        closeEntry(entry);
    });
}

function onKeyDown(event) {
    if (event.key !== "Escape" || !entries.size) return;
    // 只关最晚打开的那个（多层浮层时与 macOS 一致），并吃掉这次按键，
    // 免得 Esc 顺带去关窗口或收别的浮层。
    const top = Array.from(entries).reduce((acc, e) => (acc && acc.seq > e.seq ? acc : e), null);
    if (top) closeEntry(top);
    event.stopPropagation();
}

// ---- 跟随循环：窗口拖动 / 缩放 / 面板滚动 / 触发元素消失 ----

function startLoop() {
    if (frame) return;
    const tick = () => {
        frame = 0;
        Array.from(entries).forEach((entry) => {
            const rect = entry.anchor.isConnected ? entry.anchor.getBoundingClientRect() : null;
            // 触发元素被移除或不可见（关窗、最小化、切面板）：直接收起。
            if (!rect || (!rect.width && !rect.height)) return closeEntry(entry);
            if (!moved(entry.rect, rect)) return;
            place(entry);
        });
        if (entries.size) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
}

function stopLoop() {
    if (!entries.size && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
    }
}

function moved(a, b) {
    if (!a) return true;
    return Math.abs(a.left - b.left) > 0.5 || Math.abs(a.top - b.top) > 0.5
        || Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5;
}

/**
 * 把浮层摆到触发元素下方（放不下就翻到上方），并夹在视口内。
 * 几何一律写内联样式：插件样式表是运行时注入的，写在 popover.css 里会被
 * `.settings .ss-menu{top/right}` 这类同权重规则按加载顺序压过。
 * @param {object} entry 浮层记录
 * @returns {void}
 */
function place(entry) {
    const { anchor, content } = entry;
    const a = anchor.getBoundingClientRect();
    entry.rect = a;
    const style = content.style;
    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;

    // 先读 CSS 自己的 max-height（内联清掉之后才是样式表值），再放开量自然尺寸
    style.maxHeight = "";
    style.position = "fixed";
    // 触发元素在窗口里，浮层却在视口层：CSS 里配的 top/right/bottom 全部作废，
    // 不显式写成 auto，`right:0` 会和内联 left 一起把宽度拉满整屏。
    style.top = "auto";
    style.left = "auto";
    style.right = "auto";
    style.bottom = "auto";
    const cssMax = parseFloat(getComputedStyle(content).maxHeight);
    let width = content.offsetWidth;
    let height = content.offsetHeight;

    // 与触发元素等宽（下拉的常规做法：取两者较大值，别把长选项截断）。
    // 补完 min-width 必须重新量一次：下面对齐与翻转用的是最终尺寸，
    // 拿「加约束前」的窄宽度去算右对齐，整张菜单会朝右偏出 (min-width - 自然宽) 的差值。
    if (entry.matchWidth) {
        style.minWidth = `${Math.round(Math.max(a.width, width))}px`;
        width = content.offsetWidth;
        height = content.offsetHeight;
    }

    const below = a.bottom + entry.gap;
    const above = a.top - entry.gap - height;
    const flipUp = below + height > viewH - EDGE && above >= EDGE;
    const room = flipUp ? a.top - entry.gap - EDGE : viewH - a.bottom - entry.gap - EDGE;
    const cap = Math.max(MIN_HEIGHT, Number.isFinite(cssMax) && cssMax > 0 ? Math.min(cssMax, room) : room);
    style.maxHeight = `${Math.round(cap)}px`;
    // 实际高度取「自然高」与「可用高」的较小值，再据此把顶边夹回视口内：
    // 上下都放不下时（锚点贴着 Dock），宁可让菜单自己滚动，也不能跑出屏幕。
    const top = Math.max(EDGE, Math.min(flipUp ? above : below, viewH - EDGE - Math.min(height, cap)));

    let left = entry.align === "start" ? a.left : entry.align === "center" ? a.left + a.width / 2 - width / 2 : a.right - width;
    left = Math.min(left, viewW - EDGE - width);
    left = Math.max(EDGE, left);
    style.left = `${Math.round(left)}px`;
    style.top = `${Math.round(top)}px`;
}

/** 关闭后把节点送回原父级：调用方的 DOM 看起来和没打开过一样，作用域也随之复原。 */
function reattach(entry) {
    const { content, parent, next } = entry;
    if (parent && parent.isConnected) {
        if (next && next.parentNode === parent) parent.insertBefore(content, next);
        else parent.append(content);
        return;
    }
    content.remove();
}

function closeEntry(entry) {
    if (!entries.has(entry)) return;
    entries.delete(entry);
    const { content } = entry;
    // 隐藏态按调用方打开前的样子还原：站内四个菜单都用 [hidden]，第三方若用类名切换
    // 就别替它改属性，搬回原父级已经足够让它回到原来的显示方式。
    content.hidden = entry.wasHidden;
    content.style.cssText = entry.inlineStyle;
    reattach(entry);
    entry.host.remove();
    if (entry.onDismiss) {
        try { entry.onDismiss(); } catch (err) { log.warn("popover", "关闭回调失败", err); }
    }
    stopLoop();
}

function findBy(target) {
    if (!target) return null;
    return Array.from(entries).find((e) => e === target || e.content === target || e.anchor === target || e.handle === target) || null;
}

/**
 * 打开一个浮层。
 * @param {object} opts 参数
 * @param {HTMLElement} opts.anchor 触发元素（定位基准，必填）
 * @param {HTMLElement} opts.content 要浮出的节点（必填，关闭后送回它原来的父级）
 * @param {"start"|"center"|"end"} [opts.align="end"] 水平对齐锚点的哪条边（macOS 下拉默认右对齐）
 * @param {number} [opts.gap=4] 与锚点的间距（px）
 * @param {boolean} [opts.matchWidth=false] true 时至少与锚点等宽
 * @param {string[]} [opts.scope] 作用域类名；缺省时自动取 `anchor.closest(".window")` 的根类名
 * @param {Function} [opts.onDismiss] 关闭回调（含被本模块自动关闭的情况）
 * @returns {{close:Function, refresh:Function, isOpen:Function, el:HTMLElement}|null} 句柄；参数不合法返回 null
 */
export function openPopover(opts = {}) {
    const { anchor, content } = opts;
    if (!(anchor instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        log.warn("popover", "openPopover 需要 anchor 与 content 两个元素");
        return null;
    }
    const stale = Array.from(entries).find((e) => e.content === content);
    if (stale) closeEntry(stale);

    const entry = {
        anchor,
        content,
        align: opts.align || "end",
        gap: Number.isFinite(opts.gap) ? opts.gap : GAP_DEFAULT,
        matchWidth: opts.matchWidth === true,
        onDismiss: typeof opts.onDismiss === "function" ? opts.onDismiss : null,
        parent: content.parentNode,
        next: content.nextSibling,
        wasHidden: content.hidden,
        inlineStyle: content.getAttribute("style") || "",
        seq: ++seq,
        rect: null,
    };

    const host = document.createElement("div");
    host.className = [SCOPE_CLASS].concat(opts.scope || scopeFrom(anchor)).join(" ");
    entry.host = host;

    content.hidden = false;
    host.append(content);
    ensureLayer().append(host);
    entries.add(entry);
    bindGlobal();
    place(entry);
    startLoop();

    entry.handle = {
        close: () => closeEntry(entry),
        refresh: () => place(entry),
        isOpen: () => entries.has(entry),
        el: content,
    };
    return entry.handle;
}

/** 收起全部浮层（切面板、关窗前用）。 */
export function closeAllPopovers() {
    Array.from(entries).forEach(closeEntry);
}

// ---- 全局浮出层接口 ----
// 与 window.__dialog / __notify 同风格：插件不必 import 本模块即可调用，
// 自己画下拉的第三方插件（记事本、访达、office 工具栏都是各写各的）走这里
// 就能伸出自己的窗口，不必再往 .finder-clip 外面挪 DOM。
// 挂载时机：本模块由 index.html 以 module script 加载（早于任何插件注入）。
window.__popover = {
    /** 打开浮层，参数见 openPopover */
    open: openPopover,
    /** 关闭某个浮层：传 openPopover 的返回值，或传当初的 anchor / content 节点 */
    close(target) { const entry = findBy(target); if (entry) closeEntry(entry); },
    /** 收起全部浮层 */
    closeAll: closeAllPopovers,
    /** 当前打开数；0 表示没有浮层，调用方可据此决定要不要吃掉 Esc */
    get openCount() { return entries.size; },
    /** 层级键值（Z.POPOVER），插件自绘浮层时对齐同一层 */
    z: Z.POPOVER,
};
