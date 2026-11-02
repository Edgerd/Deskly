/**
 * image-drag-guard.js — 禁止系统内的图片被原生拖拽。
 *
 * <img> 默认 draggable=true，按住拖出窗口会变成浏览器在拖文件/链接。
 * 这里在捕获阶段统一拦截，动态插入的图片（应用内 HTML、通知、菜单等）也覆盖。
 * 程序坞排序改用 Pointer Events 后，不再需要给排序项开例外。
 */

const isImage = (node) => node instanceof HTMLImageElement;

document.addEventListener("dragstart", (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    if (!path.some(isImage)) return;
    event.preventDefault();
}, true);
