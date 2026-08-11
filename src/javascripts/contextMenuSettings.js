/**
 * contextMenuSettings.js — 浏览器原生右键菜单禁用开关
 *
 * 默认禁用浏览器原生右键菜单，改用自定义菜单；可在「系统设置」中开启。
 * 读取本地存储键 `native-context-menu`（"on" 表示启用原生菜单）。
 */

const KEY = "native-context-menu";

/** 是否启用浏览器原生右键菜单 */
export function isNativeContextMenuEnabled() {
    return localStorage.getItem(KEY) === "on";
}

/** 设置是否启用浏览器原生右键菜单 */
export function setNativeContextMenuEnabled(enabled) {
    localStorage.setItem(KEY, enabled ? "on" : "off");
}

// 全局禁用浏览器原生右键菜单（默认禁用，可在设置中开启）
document.addEventListener("contextmenu", (e) => {
    if (!isNativeContextMenuEnabled()) e.preventDefault();
});