/** 标签页：状态机、独立 iframe、紧凑标签栏、前进后退与地址栏。 */

import { closeWindow } from "../../../src/javascripts/window.js";
import { app } from "./app.js";
import { HOME, LOAD_TIMEOUT, SANDBOX, TAB_HISTORY_LIMIT } from "./constants.js";
import { compactUrl, escapeHtml, faviconMarkup, hostOf, icon, isHttpUrl, resolveInput } from "./utils.js";
import { recordVisit, titleOfTab, titleOfUrl } from "./store.js";
import { showToast } from "./ui.js";

function activeTab() {
    return app.state.tabs.find((tab) => tab.id === app.state.activeId) || null;
}

function tabById(id) {
    return app.state.tabs.find((tab) => tab.id === id) || null;
}

function isAlive(tab) {
    return !!tab && app.state.tabs.includes(tab);
}

function activeTabEl() {
    return app.dom.tabsEl ? app.dom.tabsEl.querySelector(".safari-tab--active") : null;
}

function addressInput() {
    return app.dom.tabsEl ? app.dom.tabsEl.querySelector(".safari-address") : null;
}

function closeTransient() {
    app.api.menus?.closeAll?.();
    app.api.suggestions?.close?.();
}

/**
 * 舞台淡入：切换标签 / 新开标签 / 网页加载完成时给当前内容一个很短的
 * 透明度过渡。整体只动 opacity，不动 iframe 的几何，避免跨域页面闪烁。
 */
function pulseStage(target) {
    if (!target) return;
    clearTimeout(app.state.stageAnimTimer);
    for (const tab of app.state.tabs) tab.frame?.classList.remove("is-entering");
    app.dom.startEl.classList.remove("is-entering");
    void target.offsetWidth;
    target.classList.add("is-entering");
    app.state.stageAnimTimer = setTimeout(() => {
        target.classList.remove("is-entering");
        app.state.stageAnimTimer = null;
    }, 240);
}

function animateActiveStage() {
    const tab = activeTab();
    if (!tab || tab.url === HOME) pulseStage(app.dom.startEl);
    else if (tab.frame) pulseStage(tab.frame);
}

/** 新标签胶囊弹入；元素随标签重建时动画自然结束即可。 */
function animateNewTab(id) {
    requestAnimationFrame(() => {
        const element = app.dom.tabsEl?.querySelector(`.safari-tab[data-tab-id="${id}"]`);
        if (!element) return;
        element.classList.add("is-new");
        setTimeout(() => element.classList.remove("is-new"), 280);
    });
}

function notifyViews({ start = false } = {}) {
    if (start) app.api.start?.render?.();
    app.api.sidebar?.renderIfOpen?.();
    app.api.overview?.renderIfOpen?.();
}

/* ── 生命周期 ── */

function createTab(url = HOME, opts = {}) {
    if (app.state.overviewOpen) app.api.overview?.close?.();
    const tab = {
        id: ++app.state.seq,
        url: HOME,
        title: "起始页",
        history: [HOME],
        historyIndex: 0,
        frame: null,
        loading: false,
        timedOut: false,
        loadTimer: null,
    };
    const external = url !== HOME && isHttpUrl(url);
    if (external) {
        tab.url = url;
        tab.history = [url];
        tab.historyIndex = 0;
        tab.title = opts.title || titleOfUrl(url);
        tab.loading = true;
    }
    app.state.tabs.push(tab);
    if (opts.select !== false) app.state.activeId = tab.id;

    closeTransient();
    renderTabs();
    syncToolbar();
    syncStage();
    if (external) {
        loadTab(tab);
        recordVisit(tab.url, tab.title);
    } else if (opts.focusAddress) {
        focusAddress();
    }
    notifyViews({ start: !external });
    animateNewTab(tab.id);
    if (opts.select !== false && !external) pulseStage(app.dom.startEl);
    return tab;
}

function switchTab(id) {
    if (app.state.activeId === id) return;
    if (!tabById(id)) return;
    if (app.state.overviewOpen) app.api.overview?.close?.();
    blurAddress();
    closeTransient();
    app.state.activeId = id;
    renderTabs();
    syncToolbar();
    syncStage();
    notifyViews({ start: activeTab()?.url === HOME });
    animateActiveStage();
}

function closeTab(id) {
    const index = app.state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = app.state.activeId === id;
    const tab = app.state.tabs[index];
    app.state.closed.push({ url: tab.url, title: tab.title });
    if (app.state.closed.length > 12) app.state.closed.shift();
    clearTimeout(tab.loadTimer);
    if (tab.frame) {
        tab.frame.remove();
        tab.frame = null;
    }
    app.state.tabs.splice(index, 1);
    if (!app.state.tabs.length) {
        closeWindow(app.root);
        return;
    }
    if (app.state.activeId === id) {
        app.state.activeId = app.state.tabs[Math.min(index, app.state.tabs.length - 1)].id;
    }
    closeTransient();
    renderTabs();
    syncToolbar();
    syncStage();
    notifyViews({ start: activeTab()?.url === HOME });
    if (wasActive) animateActiveStage();
}

function closeActiveTab() {
    closeTab(app.state.activeId);
}

function closeOtherTabs(keepId) {
    const keep = tabById(keepId);
    if (!keep) return;
    for (const tab of app.state.tabs) {
        if (tab.id === keepId) continue;
        clearTimeout(tab.loadTimer);
        if (tab.frame) tab.frame.remove();
    }
    const wasActive = app.state.activeId === keepId;
    app.state.tabs = [keep];
    app.state.activeId = keep.id;
    renderTabs();
    syncToolbar();
    syncStage();
    notifyViews({ start: keep.url === HOME });
    if (!wasActive) animateActiveStage();
}

function newTab() {
    closeTransient();
    createTab(HOME, { select: true, focusAddress: true });
}

function reopenClosedTab() {
    const item = app.state.closed.pop();
    if (!item) {
        showToast("没有可恢复的标签页");
        return;
    }
    createTab(item.url, { select: true, title: item.title });
}

function cycleTab(delta) {
    if (app.state.tabs.length < 2) return;
    const index = app.state.tabs.findIndex((tab) => tab.id === app.state.activeId);
    if (index < 0) return;
    const next = (index + delta + app.state.tabs.length) % app.state.tabs.length;
    switchTab(app.state.tabs[next].id);
}

function selectTabByNumber(number) {
    if (!app.state.tabs.length) return;
    const index = number === 9 ? app.state.tabs.length - 1 : number - 1;
    const tab = app.state.tabs[index];
    if (tab) switchTab(tab.id);
}

/* ── iframe ── */

function ensureFrame(tab) {
    if (tab.frame) return tab.frame;
    const frame = document.createElement("iframe");
    frame.className = "safari-frame";
    frame.title = "网页内容";
    frame.setAttribute("sandbox", SANDBOX);
    frame.src = tab.url;
    tab.frame = frame;
    app.dom.pages.appendChild(frame);
    frame.addEventListener("load", () => onFrameLoad(tab));
    return frame;
}

function loadTab(tab) {
    if (!tab || !isHttpUrl(tab.url)) return;
    clearTimeout(tab.loadTimer);
    tab.loading = true;
    tab.timedOut = false;
    const hadFrame = !!tab.frame;
    const frame = ensureFrame(tab);
    syncStage();
    applyZoom(tab);
    tab.loadTimer = setTimeout(() => onLoadTimeout(tab), LOAD_TIMEOUT);
    if (hadFrame) frame.src = tab.url;
    refreshTabChrome();
}

function onLoadTimeout(tab) {
    if (!isAlive(tab) || !tab.loading) return;
    tab.loading = false;
    tab.timedOut = true;
    if (tab.id === app.state.activeId) {
        showError(tab);
        refreshTabChrome();
    }
}

function onFrameLoad(tab) {
    if (!isAlive(tab)) return;
    clearTimeout(tab.loadTimer);
    tab.loadTimer = null;
    tab.loading = false;
    tab.timedOut = false;
    if (tab.id === app.state.activeId) {
        hideError();
        refreshTabChrome();
        if (tab.url !== HOME && tab.frame) pulseStage(tab.frame);
    }
}

function stopLoading() {
    const tab = activeTab();
    if (!tab || !tab.loading) return;
    try {
        tab.frame?.contentWindow?.stop();
    } catch { /* 跨域 stop 在个别环境会被拒，忽略即可 */ }
    clearTimeout(tab.loadTimer);
    tab.loadTimer = null;
    tab.loading = false;
    refreshTabChrome();
}

function applyZoom(tab) {
    if (!tab?.frame) return;
    const origin = (() => {
        try { return new URL(tab.url).origin; } catch { return ""; }
    })();
    const zoom = (origin && app.state.zoom[origin]) || 100;
    tab.frame.style.zoom = String(zoom / 100);
}

function showError(tab) {
    app.dom.errorText.textContent = `“${hostOf(tab.url)}” 未能在应用内载入。可能是网络连接中断，或该网站不允许被嵌入显示。`;
    app.dom.error.hidden = false;
}

function hideError() {
    app.dom.error.hidden = true;
}

/* ── 导航 ── */

function navigateTab(tab, url, opts = {}) {
    if (!tab) return;
    if (url !== HOME && !isHttpUrl(url)) return;
    if (app.state.overviewOpen) app.api.overview?.close?.();
    const { push = true, title } = opts;
    if (push) pushTabHistory(tab, url);
    tab.url = url;
    tab.title = title || titleOfUrl(url);
    tab.timedOut = false;
    if (tab.id === app.state.activeId) hideError();

    if (url === HOME) {
        clearTimeout(tab.loadTimer);
        tab.loadTimer = null;
        tab.loading = false;
    } else {
        tab.loading = true;
        loadTab(tab);
        recordVisit(url, tab.title);
    }

    closeTransient();
    renderTabs();
    syncToolbar();
    syncStage();
    notifyViews({ start: url === HOME });
    if (tab.id === app.state.activeId && url === HOME) pulseStage(app.dom.startEl);
}

function navigateActiveTo(raw, opts = {}) {
    const tab = activeTab();
    if (!tab) return;
    const resolved = resolveInput(raw);
    if (!resolved) return;
    if (resolved.error) {
        showToast(resolved.error);
        return;
    }
    if (resolved.url === tab.url) {
        if (tab.url === HOME) {
            app.api.start?.render?.();
            app.dom.startScroll.scrollTop = 0;
        } else {
            reloadActive();
        }
        return;
    }
    blurAddress();
    navigateTab(tab, resolved.url, {
        push: opts.push !== false,
        title: resolved.kind === "search" ? `搜索：${resolved.query}` : (opts.title || undefined),
    });
}

function pushTabHistory(tab, url) {
    tab.history.splice(tab.historyIndex + 1);
    if (tab.history[tab.historyIndex] !== url) {
        tab.history.push(url);
        tab.historyIndex = tab.history.length - 1;
    }
    if (tab.history.length > TAB_HISTORY_LIMIT) {
        const overflow = tab.history.length - TAB_HISTORY_LIMIT;
        tab.history.splice(0, overflow);
        tab.historyIndex = Math.max(0, tab.historyIndex - overflow);
    }
}

function goBack() {
    const tab = activeTab();
    if (!tab || tab.historyIndex <= 0) return;
    tab.historyIndex -= 1;
    blurAddress();
    navigateTab(tab, tab.history[tab.historyIndex], { push: false });
}

function goForward() {
    const tab = activeTab();
    if (!tab || tab.historyIndex >= tab.history.length - 1) return;
    tab.historyIndex += 1;
    blurAddress();
    navigateTab(tab, tab.history[tab.historyIndex], { push: false });
}

function reloadActive() {
    const tab = activeTab();
    if (!tab || tab.url === HOME) return;
    hideError();
    loadTab(tab);
}

function goHome() {
    const tab = activeTab();
    if (!tab) return;
    if (tab.url === HOME) {
        app.api.start?.render?.();
        app.dom.startScroll.scrollTop = 0;
        return;
    }
    blurAddress();
    navigateTab(tab, HOME, { push: true });
}

/* ── 标签栏 ── */

function buildInactiveTab(tab) {
    const element = document.createElement("div");
    element.className = "safari-tab safari-tab--inactive finder-no-drag";
    element.dataset.tabId = String(tab.id);
    element.setAttribute("role", "tab");
    element.setAttribute("aria-selected", "false");
    element.tabIndex = 0;
    element.title = titleOfTab(tab);
    const favicon = tab.url === HOME
        ? `<span class="safari-tab-favicon">${icon("globe")}</span>`
        : faviconMarkup(tab.url, tab.title, "safari-tab-favicon", { globe: true });
    element.innerHTML = favicon +
        `<span class="safari-tab-title">${escapeHtml(titleOfTab(tab))}</span>` +
        `<button class="safari-tab-close" type="button" tabindex="-1" title="关闭标签页" aria-label="关闭标签页">${icon("close")}</button>`;
    element.addEventListener("click", (event) => {
        if (event.target.closest(".safari-tab-close")) {
            event.stopPropagation();
            closeTab(tab.id);
            return;
        }
        switchTab(tab.id);
    });
    element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            switchTab(tab.id);
        }
    });
    element.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
            event.preventDefault();
            closeTab(tab.id);
        }
    });
    element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        app.api.menus?.openTabContext?.(tab, event.clientX, event.clientY);
    });
    return element;
}

function buildActiveTab(tab) {
    const element = document.createElement("div");
    element.className = "safari-tab safari-tab--active finder-no-drag" + (tab.url === HOME ? " safari-tab--start" : "");
    element.dataset.tabId = String(tab.id);
    element.setAttribute("role", "tab");
    element.setAttribute("aria-selected", "true");
    element.title = titleOfTab(tab);
    element.innerHTML =
        `<button class="safari-tab-pagebtn safari-popover-trigger" type="button" title="页面菜单" aria-label="页面菜单" aria-haspopup="menu" aria-expanded="false">${icon("page")}</button>` +
        `<span class="safari-tab-search" aria-hidden="true">${icon("magnifier")}</span>` +
        `<span class="safari-tab-insecure" title="此网站未使用安全连接" hidden>${icon("warning")}</span>` +
        `<input class="safari-address" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" ` +
        `placeholder="搜索或输入网站名称" aria-label="地址与搜索" aria-autocomplete="list" aria-controls="safari-suggestions" aria-expanded="false">` +
        `<button class="safari-tab-reload" type="button" title="重新载入" aria-label="重新载入">${icon("reload")}</button>` +
        `<button class="safari-tab-close" type="button" title="关闭标签页" aria-label="关闭标签页">${icon("close")}</button>`;

    const input = element.querySelector(".safari-address");
    input.value = tab.url === HOME ? "" : compactUrl(tab.url);
    input.addEventListener("focus", onAddressFocus);
    input.addEventListener("input", () => app.api.suggestions?.open?.());
    input.addEventListener("keydown", onAddressKeydown);
    input.addEventListener("blur", onAddressBlur);

    element.querySelector(".safari-tab-pagebtn").addEventListener("click", (event) => {
        event.stopPropagation();
        app.api.menus?.togglePageMenu?.();
    });
    element.querySelector(".safari-tab-reload").addEventListener("click", (event) => {
        event.stopPropagation();
        if (tab.loading) stopLoading();
        else reloadActive();
    });
    element.querySelector(".safari-tab-close").addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id);
    });
    element.addEventListener("contextmenu", (event) => {
        if (event.target.closest("input")) return;
        event.preventDefault();
        app.api.menus?.openTabContext?.(tab, event.clientX, event.clientY);
    });
    return element;
}

function renderTabs() {
    if (!app.dom.tabsEl) return;
    const editing = document.activeElement && document.activeElement.classList.contains("safari-address");
    if (editing) {
        updateActiveTabState();
        return;
    }
    app.dom.tabsEl.replaceChildren();
    if (!activeTab()) return;
    for (const tab of app.state.tabs) {
        app.dom.tabsEl.appendChild(tab.id === app.state.activeId ? buildActiveTab(tab) : buildInactiveTab(tab));
    }
    updateActiveTabState();
    requestAnimationFrame(scrollActiveTabIntoView);
}

function updateActiveTabState() {
    const tab = activeTab();
    const element = activeTabEl();
    if (!tab || !element) return;
    element.classList.toggle("is-loading", tab.loading);
    const reload = element.querySelector(".safari-tab-reload");
    if (reload) {
        reload.innerHTML = icon(tab.loading ? "stop" : "reload");
        reload.title = tab.loading ? "停止载入" : "重新载入";
        reload.setAttribute("aria-label", reload.title);
    }
    const close = element.querySelector(".safari-tab-close");
    if (close) {
        const multiple = app.state.tabs.length >= 2;
        close.hidden = !multiple;
        close.classList.toggle("is-shown", multiple);
    }
    const insecure = element.querySelector(".safari-tab-insecure");
    if (insecure) insecure.hidden = !(tab.url !== HOME && /^http:/i.test(tab.url));
    const pageButton = element.querySelector(".safari-tab-pagebtn");
    if (pageButton && app.dom.pageMenu) {
        pageButton.setAttribute("aria-expanded", String(!app.dom.pageMenu.hidden));
    }
}

function refreshTabChrome() {
    const editing = document.activeElement && document.activeElement.classList.contains("safari-address");
    if (editing) {
        updateActiveTabState();
        syncToolbar();
        return;
    }
    renderTabs();
    syncToolbar();
}

function scrollActiveTabIntoView() {
    const element = activeTabEl();
    if (!element || !app.dom.tabsEl) return;
    const strip = app.dom.tabsEl.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.left < strip.left + 6) {
        app.dom.tabsEl.scrollLeft -= strip.left + 6 - rect.left;
    } else if (rect.right > strip.right - 6) {
        app.dom.tabsEl.scrollLeft += rect.right - (strip.right - 6);
    }
}

function syncToolbar() {
    const tab = activeTab();
    const canBack = !!tab && tab.historyIndex > 0;
    const canForward = !!tab && tab.historyIndex < tab.history.length - 1;
    app.dom.backBtn.disabled = !canBack;
    app.dom.forwardBtn.disabled = !canForward;
    const external = !!tab && tab.url !== HOME;
    app.dom.shareBtn.disabled = !external;
    app.dom.sidebarToggle.classList.toggle("is-active", app.state.sidebarOpen);
    app.dom.sidebarToggle.setAttribute("aria-pressed", String(app.state.sidebarOpen));
    app.dom.sidebarToggle.title = app.state.sidebarOpen ? "隐藏侧栏（⌃⌘S）" : "显示侧栏（⌃⌘S）";
    app.dom.sidebarToggle.setAttribute("aria-label", app.state.sidebarOpen ? "隐藏侧栏" : "显示侧栏");
    app.dom.overviewToggle.classList.toggle("is-active", app.state.overviewOpen);
    app.dom.overviewToggle.setAttribute("aria-pressed", String(app.state.overviewOpen));
}

function syncStage() {
    const tab = activeTab();
    const home = !tab || tab.url === HOME;
    app.dom.startEl.hidden = !home;
    app.dom.pages.hidden = home;
    for (const item of app.state.tabs) {
        if (item.frame) item.frame.hidden = !(item.id === app.state.activeId && !home);
    }
    if (home || !tab.timedOut) hideError();
    else showError(tab);
    if (tab?.frame) applyZoom(tab);
}

/* ── 地址栏焦点 ── */

function onAddressFocus() {
    const input = addressInput();
    const tab = activeTab();
    if (!input || !tab) return;
    if (app.state.overviewOpen) app.api.overview?.close?.();
    activeTabEl()?.classList.add("is-editing");
    input.value = tab.url === HOME ? "" : tab.url;
    requestAnimationFrame(() => {
        try { input.select(); } catch { /* 忽略 */ }
    });
    app.api.menus?.closeAll?.();
    app.api.suggestions?.open?.();
}

function onAddressBlur() {
    const input = addressInput();
    const tab = activeTab();
    if (input && tab) input.value = tab.url === HOME ? "" : compactUrl(tab.url);
    activeTabEl()?.classList.remove("is-editing");
    app.api.suggestions?.close?.();
}

function onAddressKeydown(event) {
    if (event.isComposing) return;
    const input = event.currentTarget;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!app.state.sugg.open) {
            app.api.suggestions?.open?.();
            return;
        }
        app.api.suggestions?.move?.(event.key === "ArrowDown" ? 1 : -1);
        return;
    }
    if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const value = input.value.trim();
        if (!value) return;
        if (app.state.sugg.open && app.state.sugg.items.length) {
            app.api.suggestions?.activate?.(app.state.sugg.index);
        } else {
            navigateActiveTo(value);
        }
        return;
    }
    if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (app.state.sugg.open) app.api.suggestions?.close?.();
        else input.blur();
        return;
    }
    if (event.key === "Tab") app.api.suggestions?.close?.();
}

function blurAddress() {
    const input = addressInput();
    if (input && document.activeElement === input) input.blur();
}

function focusAddress() {
    requestAnimationFrame(() => {
        const input = addressInput();
        if (!input) return;
        input.focus();
        try { input.select(); } catch { /* 忽略 */ }
    });
}

export const tabsApi = {
    active: activeTab,
    byId: tabById,
    create: createTab,
    switchTo: switchTab,
    close: closeTab,
    closeActive: closeActiveTab,
    closeOthers: closeOtherTabs,
    newTab,
    reopenClosedTab,
    cycle: cycleTab,
    selectByNumber: selectTabByNumber,
    render: renderTabs,
    refreshChrome: refreshTabChrome,
    syncToolbar,
    syncStage,
    navigateTo: navigateActiveTo,
    navigateTab,
    goBack,
    goForward,
    goHome,
    reload: reloadActive,
    stop: stopLoading,
    focusAddress,
    blurAddress,
    addressInput,
    activeTabEl,
    closeWindow: () => closeWindow(app.root),
};
