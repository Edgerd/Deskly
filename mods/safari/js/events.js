/** 事件层：工具栏/侧栏绑定、全局快捷键、资源降级、菜单 API 与卸载清理。 */

import { app } from "./app.js";
import { PLUGIN_ID } from "./constants.js";
import { closeMenus, settleConfirm } from "./ui.js";
import { titleOfTab } from "./store.js";

function isSafariFrontmost() {
    const windows = Array.from(document.querySelectorAll(".window")).filter((win) => (
        win.isConnected &&
        !win.classList.contains("closing") &&
        !win.classList.contains("minimized") &&
        !win._minimized &&
        win.style.display !== "none"
    ));
    let top = null;
    let topZ = -Infinity;
    for (const win of windows) {
        const z = parseInt(window.getComputedStyle(win).zIndex, 10) || 0;
        if (z > topZ) {
            topZ = z;
            top = win;
        }
    }
    return top === app.root;
}

function onResourceError(event) {
    const element = event.target;
    if (!(element instanceof HTMLImageElement) || !app.root.contains(element)) return;
    element.hidden = true;
    const fallback = element.nextElementSibling;
    if (fallback) fallback.hidden = false;
}

function onDocumentPointerDown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const d = app.dom;
    if (!app.root.contains(target)) {
        closeMenus();
        app.api.suggestions?.close?.();
        return;
    }
    if (d.confirm.contains(target)) return;
    if (d.suggestions.contains(target) ||
        d.pageMenu.contains(target) ||
        d.shareMenu.contains(target) ||
        d.tabList.contains(target) ||
        d.editPanel.contains(target) ||
        d.contextMenu.contains(target)) {
        return;
    }
    if (target.closest(".safari-popover-trigger")) return;
    closeMenus();
    if (!target.closest(".safari-address")) app.api.suggestions?.close?.();
}

function onDocumentKeyDown(event) {
    if (event.isComposing) return;
    if (event.key === "Escape") {
        if (!app.dom.confirm.hidden) {
            event.preventDefault();
            settleConfirm(false);
            return;
        }
        if (!app.dom.contextMenu.hidden || !app.dom.pageMenu.hidden || !app.dom.shareMenu.hidden ||
            !app.dom.tabList.hidden || !app.dom.editPanel.hidden) {
            event.preventDefault();
            closeMenus();
            return;
        }
        if (app.state.overviewOpen) {
            event.preventDefault();
            app.api.overview.close();
            return;
        }
        if (app.state.sugg.open) {
            event.preventDefault();
            app.api.suggestions.close();
        }
        return;
    }
    if (!isSafariFrontmost()) return;
    if (event.ctrlKey && !event.metaKey && event.key === "Tab") {
        event.preventDefault();
        app.api.tabs.cycle(event.shiftKey ? -1 : 1);
        return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    if (event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    const handled = (fn) => {
        event.preventDefault();
        event.stopPropagation();
        fn();
    };

    if (event.shiftKey) {
        if (key === "t") { handled(() => app.api.tabs.reopenClosedTab()); return; }
        if (key === "w") { handled(() => app.api.tabs.closeWindow()); return; }
        if (key === "d") { handled(() => app.api.actions.addReadingCurrent()); return; }
        if (key === "h") { handled(() => app.api.tabs.goHome()); return; }
    } else {
        if (key === "t") { handled(() => app.api.tabs.newTab()); return; }
        if (key === "w") { handled(() => app.api.tabs.closeActive()); return; }
        if (key === "r") { handled(() => app.api.tabs.reload()); return; }
        if (key === "l") { handled(() => app.api.tabs.focusAddress()); return; }
        if (key === "d") { handled(() => app.api.actions.toggleBookmarkCurrent()); return; }
        if (key === "[") { handled(() => app.api.tabs.goBack()); return; }
        if (key === "]") { handled(() => app.api.tabs.goForward()); return; }
        if (key === "0") { handled(() => app.api.actions.resetZoom()); return; }
        if (key === "=" || key === "+") { handled(() => app.api.actions.zoomIn()); return; }
        if (key === "-") { handled(() => app.api.actions.zoomOut()); return; }
        if (/^[1-9]$/.test(key)) { handled(() => app.api.tabs.selectByNumber(Number(key))); return; }
        if (event.ctrlKey && event.metaKey && key === "s") { handled(() => app.api.sidebar.toggle()); return; }
    }
}

function onWindowResize() {
    closeMenus();
    app.api.suggestions?.close?.();
}

function bindStaticEvents() {
    const d = app.dom;
    d.tabgroupBtn.classList.add("safari-popover-trigger");
    d.shareBtn.classList.add("safari-popover-trigger");
    d.editBtn.classList.add("safari-popover-trigger");

    d.sidebarToggle.addEventListener("click", () => app.api.sidebar.toggle());
    d.tabgroupBtn.addEventListener("click", () => app.api.menus.openTabList());
    d.backBtn.addEventListener("click", () => app.api.tabs.goBack());
    d.forwardBtn.addEventListener("click", () => app.api.tabs.goForward());
    d.shareBtn.addEventListener("click", () => app.api.menus.openShareMenu());
    d.newTabBtn.addEventListener("click", () => app.api.tabs.newTab());
    d.overviewToggle.addEventListener("click", () => app.api.overview.toggle());
    d.sidebarBack.addEventListener("click", () => app.api.sidebar.setView("root"));
    d.sidebarAdd.addEventListener("click", () => {
        if (app.state.sidebarView === "bookmarks") app.api.actions.addBookmarkCurrent();
        else if (app.state.sidebarView === "reading") app.api.actions.addReadingCurrent();
    });
    d.sidebarClear.addEventListener("click", () => app.api.actions.clearHistory());
    d.sidebarInput.addEventListener("input", () => {
        app.state.sidebarQuery = d.sidebarInput.value;
        app.api.sidebar.renderBody();
    });
    d.editBtn.addEventListener("click", () => app.api.menus.toggleEditPanel());
    d.errorExternal.addEventListener("click", () => app.api.actions.openCurrentExternal());
    d.errorReload.addEventListener("click", () => app.api.tabs.reload());
    d.overviewDone.addEventListener("click", () => app.api.overview.close());
    d.confirmCancel.addEventListener("click", () => settleConfirm(false));
    d.confirmOk.addEventListener("click", () => settleConfirm(true));
    d.suggestions.addEventListener("mousedown", (event) => {
        // 只阻止点选建议行导致的输入框失焦；点滚动条/空白仍按普通交互处理。
        if (event.target.closest(".safari-sug-row")) event.preventDefault();
    });
    d.startScroll.addEventListener("scroll", closeMenus, { passive: true });
    d.sidebarBody.addEventListener("scroll", closeMenus, { passive: true });
    d.overviewGrid.addEventListener("scroll", closeMenus, { passive: true });
}

function exposeMenuApi() {
    app.root._safariNewTab = () => app.api.tabs.newTab();
    app.root._safariCloseTab = () => app.api.tabs.closeActive();
    app.root._safariShowHistory = () => app.api.sidebar.open("history");
    app.root._safariShowBookmarks = () => app.api.sidebar.open("bookmarks");
    app.root._safariShowReading = () => app.api.sidebar.open("reading");
    app.root._safariShowStartPage = () => app.api.tabs.goHome();
    app.root._safariToggleSidebar = () => app.api.sidebar.toggle();
    app.root._safariToggleBookmark = () => app.api.actions.toggleBookmarkCurrent();
    app.root._safariAddReading = () => app.api.actions.addReadingCurrent();
    app.root._safariClearHistory = () => app.api.actions.clearHistory();
    app.root._safariReload = () => app.api.tabs.reload();
    app.root._safariGoBack = () => app.api.tabs.goBack();
    app.root._safariGoForward = () => app.api.tabs.goForward();
    app.root._safariZoomIn = () => app.api.actions.zoomIn();
    app.root._safariZoomOut = () => app.api.actions.zoomOut();
    app.root._safariZoomReset = () => app.api.actions.resetZoom();
    app.root._safariToggleTabOverview = () => app.api.overview.toggle();
    app.root._safariShare = () => app.api.menus.openShareMenu();
    app.root._safariOpenExternal = () => app.api.actions.openCurrentExternal();
    app.root._safariReopenClosedTab = () => app.api.tabs.reopenClosedTab();
    app.root._safariFocusAddress = () => app.api.tabs.focusAddress();
    app.root._safariTest = {
        snapshot: () => ({
            tabs: app.state.tabs.map((tab) => ({
                id: tab.id,
                url: tab.url,
                title: titleOfTab(tab),
                loading: tab.loading,
                historyIndex: tab.historyIndex,
                history: tab.history.slice(),
            })),
            activeId: app.state.activeId,
            sidebarOpen: app.state.sidebarOpen,
            sidebarView: app.state.sidebarView,
            overviewOpen: app.state.overviewOpen,
            settings: { ...app.state.settings },
            zoom: { ...app.state.zoom },
        }),
    };
}

function onPluginUnload(event) {
    if (!event.detail || event.detail.id !== PLUGIN_ID) return;
    document.removeEventListener("plugin-unload", onPluginUnload);
    dispose();
}

function dispose() {
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown);
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("error", onResourceError, true);
    for (const tab of app.state.tabs) clearTimeout(tab.loadTimer);
    clearTimeout(app.state.toastTimer);
    clearTimeout(app.state.stageAnimTimer);
    clearTimeout(app.state.sidebarAnimTimer);
    app.state.toastTimer = null;
    app.state.stageAnimTimer = null;
    app.state.sidebarAnimTimer = null;
    if (app.state.confirmResolver) {
        const resolver = app.state.confirmResolver;
        app.state.confirmResolver = null;
        resolver(false);
    }
}

export function initEvents() {
    bindStaticEvents();
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("error", onResourceError, true);
    document.addEventListener("plugin-unload", onPluginUnload);
    exposeMenuApi();
}
