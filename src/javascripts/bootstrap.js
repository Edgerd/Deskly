/**
 * bootstrap.js — 入口引导模块
 *
 * 取代 index.html 中的内联 <script> 与内联 onclick 处理器，
 * 以满足 MV3 扩展 CSP（script-src 'self'，禁止远程脚本与内联脚本）要求。
 *
 * 职责：
 * 1. 设置全局钩子 window.moduleItems（菜单/窗口/桌面文件创建入口）。
 * 2. 将 index.html 静态菜单项的 onclick="moduleItems.clickMenuItem(this)"
 *    改为 JS 事件绑定（避免内联事件处理器被 CSP 拦截）。
 * 3. 初始化插件管理器（冷加载）与多语言、桌面背景系统。
 */

import { clickMenuItem } from "./ui/menu.js";
import { parentMenuStates, updateMenu } from "./finderbar.js";
import { create, resetWindowListeners } from "./window.js";
import { createDesktopFile } from "./ui/contextMenu.js";
import { init as initPlugins } from "./plugin-manager.js";
import { i18n } from "./i18n.js";
import { wallpaper } from "./wallpaper.js";
import { initAppearance } from "./appearance.js";

// 1. 暴露全局钩子（原内联脚本逻辑）
window.moduleItems = {
    clickMenuItem,
    parentMenuStates,
    create,
    resetWindowListeners,
    updateMenu,
    createDesktopFile,
};

// 2. 将 index.html 菜单项的 onclick="moduleItems.clickMenuItem(this)"
//    改为 JS 事件绑定（内联处理器在 MV3 CSP 下会被拦截）
document.querySelectorAll(".menu p[cmd]").forEach((p) => {
    p.addEventListener("click", () => clickMenuItem(p));
});

// 3. 初始化插件管理器（冷加载：仅注册清单）与多语言、桌面背景系统
//    先注册 Service Worker：让已安装（ZIP）插件的资源请求从 IndexedDB 返回，
//    实现刷新后持久化与相对 import 正确解析；注册失败仅影响已安装插件，不阻塞内置插件。
async function ensureServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
        await navigator.serviceWorker.register("./sw.js");
        await navigator.serviceWorker.ready;
    } catch (err) {
        console.warn("[bootstrap] Service Worker 注册失败，已安装插件将无法持久化加载：", err);
    }
}

(async () => {
    await ensureServiceWorker();
    initAppearance();
    initPlugins();
    i18n.init("zh-CN").then(() => wallpaper.init());
})();
