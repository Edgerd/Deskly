/** 用户动作：书签 / 阅读列表 / 历史、缩放、共享、打开链接。 */

import { app } from "./app.js";
import { ZOOM_LEVELS } from "./constants.js";
import {
    loadBookmarks,
    loadHistory,
    loadReading,
    saveBookmarks,
    saveHistory,
    saveReading,
    setZoomFor,
    titleOfTab,
    zoomFor,
} from "./store.js";
import { isHttpUrl } from "./utils.js";
import { askConfirm, showToast } from "./ui.js";

function refreshDataViews() {
    app.api.start?.render?.();
    app.api.sidebar?.renderIfOpen?.();
    app.api.overview?.renderIfOpen?.();
}

/* ── 书签 ── */

function toggleBookmarkCurrent() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("起始页不能添加书签");
        return false;
    }
    const list = loadBookmarks();
    const index = list.findIndex((item) => item.url === tab.url);
    const added = index < 0;
    if (added) list.unshift({ url: tab.url, title: titleOfTab(tab), addedAt: Date.now() });
    else list.splice(index, 1);
    saveBookmarks(list);
    showToast(added ? "已添加书签" : "已移除书签");
    refreshDataViews();
    return added;
}

function addBookmarkCurrent() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("起始页不能添加书签");
        return;
    }
    const list = loadBookmarks();
    if (list.some((item) => item.url === tab.url)) {
        showToast("已在书签中");
        return;
    }
    list.unshift({ url: tab.url, title: titleOfTab(tab), addedAt: Date.now() });
    saveBookmarks(list);
    showToast("已添加书签");
    refreshDataViews();
}

function removeBookmark(url) {
    saveBookmarks(loadBookmarks().filter((item) => item.url !== url));
    showToast("已移除书签");
    refreshDataViews();
}

/* ── 阅读列表 ── */

function toggleReadingCurrent() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("起始页不能加入阅读列表");
        return false;
    }
    const list = loadReading();
    const index = list.findIndex((item) => item.url === tab.url);
    const added = index < 0;
    if (added) list.unshift({ url: tab.url, title: titleOfTab(tab), addedAt: Date.now(), read: false });
    else list.splice(index, 1);
    saveReading(list);
    showToast(added ? "已添加到阅读列表" : "已从阅读列表移除");
    refreshDataViews();
    return added;
}

function addReadingCurrent() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("起始页不能加入阅读列表");
        return;
    }
    const list = loadReading();
    if (list.some((item) => item.url === tab.url)) {
        showToast("已在阅读列表中");
        return;
    }
    list.unshift({ url: tab.url, title: titleOfTab(tab), addedAt: Date.now(), read: false });
    saveReading(list);
    showToast("已添加到阅读列表");
    refreshDataViews();
}

function removeReading(url) {
    saveReading(loadReading().filter((item) => item.url !== url));
    showToast("已从阅读列表移除");
    refreshDataViews();
}

function toggleReadingRead(url) {
    const list = loadReading();
    const item = list.find((entry) => entry.url === url);
    if (!item) return;
    item.read = !item.read;
    saveReading(list);
    refreshDataViews();
}

/* ── 历史 ── */

function removeHistory(url) {
    saveHistory(loadHistory().filter((item) => item.url !== url));
    showToast("已从历史记录中删除");
    refreshDataViews();
}

function clearHistory() {
    if (!loadHistory().length) {
        showToast("没有历史记录");
        return;
    }
    askConfirm({
        title: "清除历史记录？",
        message: "清除后无法恢复，起始页的“经常访问”也会一并清空。",
        okLabel: "清除历史记录",
    }).then((ok) => {
        if (!ok) return;
        saveHistory([]);
        showToast("历史记录已清除");
        refreshDataViews();
    });
}

/* ── 缩放 ── */

function applyZoomValue(tab, value) {
    setZoomFor(app.state.zoom, tab.url, value);
    if (tab.frame) tab.frame.style.zoom = String(value / 100);
    if (app.dom.pageMenu && !app.dom.pageMenu.hidden) app.api.menus?.refreshPageMenu?.();
}

function stepZoom(direction) {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") return;
    const current = zoomFor(app.state.zoom, tab.url);
    let index = ZOOM_LEVELS.indexOf(current);
    if (index < 0) index = ZOOM_LEVELS.indexOf(100);
    const next = ZOOM_LEVELS[Math.min(Math.max(index + direction, 0), ZOOM_LEVELS.length - 1)];
    applyZoomValue(tab, next);
}

function resetZoom() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") return;
    applyZoomValue(tab, 100);
}

function zoomIn() {
    stepZoom(1);
}

function zoomOut() {
    stepZoom(-1);
}

/* ── 剪贴板 / 共享 / 外部打开 ── */

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { /* 落回 execCommand */ }
    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
}

async function copyLink(url) {
    if (!url) return;
    const ok = await copyText(url);
    showToast(ok ? "链接已拷贝" : "拷贝失败");
}

function openExternal(url) {
    if (!isHttpUrl(url)) {
        showToast("没有可打开的网页");
        return;
    }
    try {
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (!opened) showToast("浏览器拦截了打开请求");
    } catch {
        showToast("无法打开默认浏览器");
    }
}

function openCurrentExternal() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("没有可打开的网页");
        return;
    }
    openExternal(tab.url);
}

async function shareCurrent() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("起始页没有可共享的链接");
        return;
    }
    if (typeof navigator.share === "function") {
        try {
            await navigator.share({ title: titleOfTab(tab), url: tab.url });
            return;
        } catch (error) {
            if (error && error.name === "AbortError") return;
        }
    }
    copyLink(tab.url);
}

/* ── 打开 ── */

function openUrl(url, opts = {}) {
    if (!isHttpUrl(url)) {
        showToast("地址无效");
        return;
    }
    if (opts.newTab) {
        app.api.tabs?.create?.(url, { select: true, title: opts.title });
        return;
    }
    app.api.tabs?.navigateTo?.(url, { title: opts.title });
}

function openReading(item) {
    if (!item) return;
    const list = loadReading();
    const target = list.find((entry) => entry.url === item.url);
    if (target) {
        target.read = true;
        saveReading(list);
    }
    openUrl(item.url, { title: item.title });
    refreshDataViews();
}

export const actionsApi = {
    refreshDataViews,
    toggleBookmarkCurrent,
    addBookmarkCurrent,
    removeBookmark,
    toggleReadingCurrent,
    addReadingCurrent,
    removeReading,
    toggleReadingRead,
    removeHistory,
    clearHistory,
    stepZoom,
    resetZoom,
    zoomIn,
    zoomOut,
    copyText,
    copyLink,
    openExternal,
    openCurrentExternal,
    shareCurrent,
    openUrl,
    openReading,
};
