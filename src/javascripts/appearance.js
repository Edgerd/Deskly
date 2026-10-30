/**
 * appearance.js — 全局外观（系统设置）状态管理
 *
 * 负责：读取/写入 localStorage、把外观设置实时应用到 <html> 上
 * （data-theme / --accent / --highlight / data-sidebar-size /
 *  data-wallpaper-tint / --window-tint / data-scrollbars / data-scroll-click），
 * 并广播 CustomEvent 供其它模块响应。
 *
 * 由 bootstrap.js 在启动时调用 initAppearance() 做全局初始化，
 * 系统设置面板 script.js 在打开时读取这些值来还原控件选中态。
 *
 * 墙纸着色：data-wallpaper-tint="on" 只是开关，真正的颜色由 wallpaper.applyTint()
 * 计算并写成 <html> 上的 --wallpaper-tint-color / --wallpaper-tint-rgb 与
 * --window-tint / --window-tint-rgb；样式表（window.css、controlcenter.css、
 * main.css 的系统设置侧栏）在着色开启时把硬编码的半透明灰换成这几个令牌。
 * 取色与令牌写入只有一处归属（wallpaper 侧），本模块不再自己换算，
 * 否则同一个主色会有「元组」和「十六进制」两种理解，迟早对不上。
 */

import { applyTint as applyWallpaperTint } from "./wallpaper.js";

// 强调色 / 高亮色 取值映射（key -> CSS 颜色）
const COLOR_MAP = {
    multicolor: "#0a82ff", // 多彩：跟随系统默认蓝
    blue: "#0a82ff",
    purple: "#8a358b",
    pink: "#F64694",
    red: "#DB3136",
    orange: "#f67719",
    yellow: "#FFC022",
    green: "#57B13D",
    gray: "#8D8D8D",
};

const LS = {
    theme: "appearance-theme",
    accent: "appearance-accent",
    highlight: "appearance-highlight",
    sidebar: "appearance-sidebar-size",
    tint: "appearance-wallpaper-tint",
    scrollbars: "appearance-scrollbars",
    scrollClick: "appearance-scroll-click",
};

export const appearance = {
    getTheme: () => localStorage.getItem(LS.theme) || "light",
    getAccent: () => localStorage.getItem(LS.accent) || "multicolor",
    getHighlight: () => localStorage.getItem(LS.highlight) || "accent",
    getSidebarSize: () => localStorage.getItem(LS.sidebar) || "medium",
    getTint: () => localStorage.getItem(LS.tint) || "off",
    getScrollbars: () => localStorage.getItem(LS.scrollbars) || "auto",
    getScrollClick: () => localStorage.getItem(LS.scrollClick) || "next-page",
};

/**
 * 安全写入 localStorage：写入失败（配额超限 / 存储被禁用）时只记 warn，
 * 不让 QuotaExceededError 冒泡打断「立即应用」的界面反馈。
 * 这些键都是几字节的开关值，正常情况下不会触发配额；真发生时（例如壁纸 base64
 * 已把配额占满）设置仍会即时生效，只是刷新后回退。
 * @param {string} key 存储键
 * @param {string} value 存储值
 * @returns {boolean} 是否写入成功
 */
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        console.warn(`[appearance] 写入 localStorage 失败（${key}）：`, err);
        return false;
    }
}

function hexToRgb(hex) {
    const m = (hex || "#0a82ff").replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.substring(i, i + 2), 16) || 0);
    return `${r}, ${g}, ${b}`;
}

/**
 * 刷新墙纸着色令牌：整件事交给 wallpaper.applyTint()（它按 [r,g,b] 元组换算，
 * 一次写齐 --wallpaper-tint-{color,rgb} 与 --window-tint{,-rgb}，并按 URL 缓存取色）。
 * 保留这个导出是因为设置面板与 wallpaper-change 监听都叫它，实现不再重复一份。
 * @returns {Promise<string>} 实际写入的十六进制色值
 */
export function refreshWindowTint() {
    return applyWallpaperTint();
}

function applyTheme(value) {
    const v = value || appearance.getTheme();
    const resolved = v === "auto"
        ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light")
        : v;
    document.documentElement.setAttribute("data-theme", resolved);
    // data-theme 仍是被 CSS 使用的解析值（事件 detail 也保持这个字符串不变，零破坏）；
    // 新增两个数据集属性把「用户选了 auto」这件事也留在 DOM 上，监听者无需再读存储。
    document.documentElement.dataset.themeResolved = resolved;
    document.documentElement.dataset.themeRequested = v;
    window.dispatchEvent(new CustomEvent("appearance-theme-change", { detail: resolved }));
}

function applyAccent(value) {
    const v = value || appearance.getAccent();
    const color = COLOR_MAP[v] || COLOR_MAP.multicolor;
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent-rgb", hexToRgb(color));
    // 高亮色若固定为「主题色」，则跟随强调色实时更新，避免会话内保留 stale 值
    if (localStorage.getItem(LS.highlight) === "accent") applyHighlight("accent");
    window.dispatchEvent(new CustomEvent("appearance-accent-change", { detail: v }));
}

function applyHighlight(value) {
    const v = value || appearance.getHighlight();
    const color = v === "accent"
        ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || COLOR_MAP.multicolor
        : COLOR_MAP[v] || COLOR_MAP.multicolor;
    document.documentElement.style.setProperty("--highlight", color);
    window.dispatchEvent(new CustomEvent("appearance-highlight-change", { detail: v }));
}

function applySidebar(value) {
    const v = value || appearance.getSidebarSize();
    document.documentElement.setAttribute("data-sidebar-size", v);
    window.dispatchEvent(new CustomEvent("appearance-sidebar-change", { detail: v }));
}

function applyTint(value) {
    const v = value ?? appearance.getTint();
    document.documentElement.setAttribute("data-wallpaper-tint", v);
    if (v === "on") refreshWindowTint();
    window.dispatchEvent(new CustomEvent("appearance-tint-change", { detail: v }));
}

/**
 * 滚动条「滚动时」档的辅助实现：CSS 没有 :scrolling 伪类可依据，
 * 只能由这里给正在滚动的元素挂 data-scrolling="on"，停手后再摘掉。
 * scroll 事件不冒泡（只传播），所以必须用 document 上的捕获阶段监听统一接。
 */
const SCROLL_REVEAL_MS = 900;
const scrollRevealTimers = new WeakMap();
let scrollRevealBound = false;

/** 挂上一次性滚动监听（整个会话只绑一次）。 */
function bindScrollbarReveal() {
    if (scrollRevealBound) return;
    scrollRevealBound = true;
    document.addEventListener("scroll", (e) => {
        if (appearance.getScrollbars() !== "when-scrolling") return;
        const target = e.target === document ? document.documentElement : e.target;
        if (!(target instanceof Element)) return;
        target.setAttribute("data-scrolling", "on");
        clearTimeout(scrollRevealTimers.get(target));
        scrollRevealTimers.set(target, setTimeout(() => target.removeAttribute("data-scrolling"), SCROLL_REVEAL_MS));
    }, { capture: true, passive: true });
}

/** 切出「滚动时」档时清掉残留标记，否则最后滚动的那个区域会一直留着滚动条。 */
function clearScrollFlags() {
    document.querySelectorAll("[data-scrolling]").forEach((el) => el.removeAttribute("data-scrolling"));
}

function applyScrollbars(value) {
    const v = value || appearance.getScrollbars();
    document.documentElement.setAttribute("data-scrollbars", v);
    if (v !== "when-scrolling") clearScrollFlags();
    bindScrollbarReveal();
    window.dispatchEvent(new CustomEvent("appearance-scrollbars-change", { detail: v }));
}

function applyScrollClick(value) {
    const v = value || appearance.getScrollClick();
    document.documentElement.setAttribute("data-scroll-click", v);
    window.dispatchEvent(new CustomEvent("appearance-scroll-click-change", { detail: v }));
}

export function setTheme(v) { safeSetItem(LS.theme, v); applyTheme(v); }
export function setAccent(v) { safeSetItem(LS.accent, v); applyAccent(v); }
export function setHighlight(v) { safeSetItem(LS.highlight, v); applyHighlight(v); }
export function setSidebarSize(v) { safeSetItem(LS.sidebar, v); applySidebar(v); }
export function setTint(v) { safeSetItem(LS.tint, v); applyTint(v); }
export function setScrollbars(v) { safeSetItem(LS.scrollbars, v); applyScrollbars(v); }
export function setScrollClick(v) { safeSetItem(LS.scrollClick, v); applyScrollClick(v); }

let _mqBound = false;
let _wallpaperTintBound = false;
export function initAppearance() {
    applyTheme();
    applyAccent();
    applyHighlight();
    applySidebar();
    applyTint();
    applyScrollbars();
    applyScrollClick();

    // 「自动」模式下跟随系统明暗变化
    if (window.matchMedia && !_mqBound) {
        _mqBound = true;
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => { if (appearance.getTheme() === "auto") applyTheme("auto"); };
        (mq.addEventListener || mq.addListener).call(mq, "change", onChange);
    }

    // 换壁纸后主色要跟着换，否则着色开关开着却一直是旧壁纸的颜色
    if (!_wallpaperTintBound) {
        _wallpaperTintBound = true;
        window.addEventListener("wallpaper-change", () => { refreshWindowTint(); });
    }
}
