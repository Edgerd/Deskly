/**
 * appearance.js — 全局外观（系统设置）状态管理
 *
 * 负责：读取/写入 localStorage、把外观设置实时应用到 <html> 上
 * （data-theme / --accent / --highlight / data-sidebar-size /
 *  data-wallpaper-tint / data-scrollbars / data-scroll-click），
 * 并广播 CustomEvent 供其它模块响应。
 *
 * 由 bootstrap.js 在启动时调用 initAppearance() 做全局初始化，
 * 系统设置面板 script.js 在打开时读取这些值来还原控件选中态。
 */

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

function hexToRgb(hex) {
    const m = (hex || "#0a82ff").replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.substring(i, i + 2), 16) || 0);
    return `${r}, ${g}, ${b}`;
}

function applyTheme(value) {
    const v = value || appearance.getTheme();
    const resolved = v === "auto"
        ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light")
        : v;
    document.documentElement.setAttribute("data-theme", resolved);
    window.dispatchEvent(new CustomEvent("appearance-theme-change", { detail: resolved }));
}

function applyAccent(value) {
    const v = value || appearance.getAccent();
    const color = COLOR_MAP[v] || COLOR_MAP.multicolor;
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent-rgb", hexToRgb(color));
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
    window.dispatchEvent(new CustomEvent("appearance-tint-change", { detail: v }));
}

function applyScrollbars(value) {
    const v = value || appearance.getScrollbars();
    document.documentElement.setAttribute("data-scrollbars", v);
    window.dispatchEvent(new CustomEvent("appearance-scrollbars-change", { detail: v }));
}

function applyScrollClick(value) {
    const v = value || appearance.getScrollClick();
    document.documentElement.setAttribute("data-scroll-click", v);
    window.dispatchEvent(new CustomEvent("appearance-scroll-click-change", { detail: v }));
}

export function setTheme(v) { localStorage.setItem(LS.theme, v); applyTheme(v); }
export function setAccent(v) { localStorage.setItem(LS.accent, v); applyAccent(v); }
export function setHighlight(v) { localStorage.setItem(LS.highlight, v); applyHighlight(v); }
export function setSidebarSize(v) { localStorage.setItem(LS.sidebar, v); applySidebar(v); }
export function setTint(v) { localStorage.setItem(LS.tint, v); applyTint(v); }
export function setScrollbars(v) { localStorage.setItem(LS.scrollbars, v); applyScrollbars(v); }
export function setScrollClick(v) { localStorage.setItem(LS.scrollClick, v); applyScrollClick(v); }

let _mqBound = false;
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
}
