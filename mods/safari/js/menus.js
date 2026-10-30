/** 浮出菜单：标签列表、页面菜单、共享、起始页设置、右键菜单。 */

import { app } from "./app.js";
import { bookmarkFor, readingFor, saveSettings, titleOfTab, zoomFor } from "./store.js";
import { ZOOM_LEVELS } from "./constants.js";
import { escapeHtml, faviconMarkup, icon } from "./utils.js";
import {
    closeMenus,
    isMenuOpen,
    makeMenuRow,
    makeSeparator,
    openContextMenu,
    placePopover,
    showToast,
} from "./ui.js";

/* ── 标签页列表 ── */

function openTabList() {
    if (isMenuOpen(app.dom.tabList)) {
        closeMenus();
        return;
    }
    closeMenus();
    app.api.suggestions?.close?.();
    const target = app.dom.tabList;
    target.replaceChildren();
    const head = document.createElement("div");
    head.className = "safari-menu-head";
    head.innerHTML = `<span>标签页</span><span>${app.state.tabs.length}</span>`;
    target.appendChild(head);

    for (const tab of app.state.tabs) {
        const row = document.createElement("div");
        row.className = "safari-tl-row" + (tab.id === app.state.activeId ? " is-active" : "");
        row.setAttribute("role", "menuitem");
        row.tabIndex = 0;
        row.title = titleOfTab(tab);
        const favicon = tab.url === "safari:start"
            ? `<span class="safari-tl-icon">${icon("globe")}</span>`
            : faviconMarkup(tab.url, tab.title, "safari-tl-icon", { globe: true });
        row.innerHTML = favicon + `<span class="safari-tl-title">${escapeHtml(titleOfTab(tab))}</span>` +
            `<button class="safari-tl-close" type="button" title="关闭标签页" aria-label="关闭标签页">${icon("close")}</button>`;
        row.addEventListener("click", (event) => {
            if (event.target.closest(".safari-tl-close")) {
                event.stopPropagation();
                closeMenus();
                app.api.tabs.close(tab.id);
                return;
            }
            closeMenus();
            app.api.tabs.switchTo(tab.id);
        });
        row.querySelector(".safari-tl-close").addEventListener("click", (event) => {
            event.stopPropagation();
            closeMenus();
            app.api.tabs.close(tab.id);
        });
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                closeMenus();
                app.api.tabs.switchTo(tab.id);
            }
        });
        target.appendChild(row);
    }

    const foot = document.createElement("div");
    foot.className = "safari-menu-foot";
    foot.appendChild(makeMenuRow({
        iconName: "plus",
        label: "新建标签页",
        key: "⌘T",
        onClick: () => {
            closeMenus();
            app.api.tabs.newTab();
        },
    }));
    foot.appendChild(makeMenuRow({
        iconName: "overview",
        label: "标签页概览",
        onClick: () => {
            closeMenus();
            app.api.overview.open();
        },
    }));
    target.appendChild(foot);

    target.style.width = "300px";
    target.hidden = false;
    app.dom.tabgroupBtn.setAttribute("aria-expanded", "true");
    const rect = app.dom.tabgroupBtn.getBoundingClientRect();
    const rootRect = app.root.getBoundingClientRect();
    placePopover(target, rect.left - rootRect.left - 4, app.dom.toolbar.offsetHeight + 3, true);
}

/* ── 页面菜单 ── */

function togglePageMenu() {
    if (isMenuOpen(app.dom.pageMenu)) closeMenus();
    else openPageMenu();
}

function openPageMenu() {
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") return;
    closeMenus();
    app.api.suggestions?.close?.();
    const target = app.dom.pageMenu;
    target.replaceChildren();
    const bookmarked = !!bookmarkFor(tab.url);
    const inReading = !!readingFor(tab.url);

    target.appendChild(makeMenuRow({
        iconName: "star",
        label: bookmarked ? "移除书签" : "添加书签",
        key: "⌘D",
        checked: bookmarked,
        onClick: () => {
            closeMenus();
            app.api.actions.toggleBookmarkCurrent();
        },
    }));
    target.appendChild(makeMenuRow({
        iconName: "book",
        label: inReading ? "从阅读列表中移除" : "添加到阅读列表",
        key: "⇧⌘D",
        checked: inReading,
        onClick: () => {
            closeMenus();
            app.api.actions.toggleReadingCurrent();
        },
    }));
    target.appendChild(makeSeparator());
    target.appendChild(makeMenuRow({
        iconName: "link",
        label: "拷贝链接",
        onClick: () => {
            closeMenus();
            app.api.actions.copyLink(tab.url);
        },
    }));
    target.appendChild(makeMenuRow({
        iconName: "external",
        label: "在默认浏览器中打开",
        onClick: () => {
            closeMenus();
            app.api.actions.openExternal(tab.url);
        },
    }));
    target.appendChild(makeSeparator());
    target.appendChild(buildZoomRow(tab));

    target.style.width = "252px";
    target.hidden = false;
    const pageButton = app.dom.tabsEl.querySelector(".safari-tab-pagebtn");
    const rect = pageButton ? pageButton.getBoundingClientRect() : app.dom.tabsEl.getBoundingClientRect();
    const rootRect = app.root.getBoundingClientRect();
    if (pageButton) pageButton.setAttribute("aria-expanded", "true");
    placePopover(target, rect.left - rootRect.left - 4, app.dom.toolbar.offsetHeight + 3, true);
}

/**
 * 缩放结果就地刷新菜单里的那一行；不要 close/reopen —— 重开会重播入场动画，
 * 连点缩放时菜单会持续闪烁。
 */
function refreshPageMenu() {
    if (!isMenuOpen(app.dom.pageMenu)) return;
    const tab = app.api.tabs?.active?.();
    if (!tab) return;
    const current = zoomFor(app.state.zoom, tab.url);
    const value = app.dom.pageMenu.querySelector(".safari-zoom-value");
    if (value) value.textContent = `${current}%`;
    const out = app.dom.pageMenu.querySelector('[data-zoom="out"]');
    const plus = app.dom.pageMenu.querySelector('[data-zoom="in"]');
    if (out) out.disabled = current <= ZOOM_LEVELS[0];
    if (plus) plus.disabled = current >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
}

function buildZoomRow(tab) {
    const wrap = document.createElement("div");
    wrap.className = "safari-zoom-row";
    const current = zoomFor(app.state.zoom, tab.url);
    wrap.innerHTML = `${icon("sliders")}<span class="safari-zoom-label">缩放</span>` +
        `<button class="safari-zoom-btn" type="button" data-zoom="out" title="缩小" aria-label="缩小">${icon("minus")}</button>` +
        `<button class="safari-zoom-value" type="button" data-zoom="reset" title="实际大小">${current}%</button>` +
        `<button class="safari-zoom-btn" type="button" data-zoom="in" title="放大" aria-label="放大">${icon("plus")}</button>`;
    const out = wrap.querySelector('[data-zoom="out"]');
    const reset = wrap.querySelector('[data-zoom="reset"]');
    const plus = wrap.querySelector('[data-zoom="in"]');
    out.disabled = current <= ZOOM_LEVELS[0];
    plus.disabled = current >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    out.addEventListener("click", (event) => {
        event.stopPropagation();
        app.api.actions.zoomOut();
    });
    plus.addEventListener("click", (event) => {
        event.stopPropagation();
        app.api.actions.zoomIn();
    });
    reset.addEventListener("click", (event) => {
        event.stopPropagation();
        app.api.actions.resetZoom();
    });
    return wrap;
}

/* ── 共享菜单 ── */

function openShareMenu() {
    if (isMenuOpen(app.dom.shareMenu)) {
        closeMenus();
        return;
    }
    const tab = app.api.tabs?.active?.();
    if (!tab || tab.url === "safari:start") {
        showToast("起始页没有可共享的链接");
        return;
    }
    closeMenus();
    app.api.suggestions?.close?.();
    const target = app.dom.shareMenu;
    target.replaceChildren();
    target.appendChild(makeMenuRow({
        iconName: "link",
        label: "拷贝链接",
        onClick: () => {
            closeMenus();
            app.api.actions.copyLink(tab.url);
        },
    }));
    target.appendChild(makeMenuRow({
        iconName: "book",
        label: readingFor(tab.url) ? "从阅读列表中移除" : "添加到阅读列表",
        onClick: () => {
            closeMenus();
            app.api.actions.toggleReadingCurrent();
        },
    }));
    target.appendChild(makeMenuRow({
        iconName: "external",
        label: "在默认浏览器中打开",
        onClick: () => {
            closeMenus();
            app.api.actions.openExternal(tab.url);
        },
    }));
    if (typeof navigator.share === "function") {
        target.appendChild(makeSeparator());
        target.appendChild(makeMenuRow({
            iconName: "share",
            label: "共享…",
            onClick: () => {
                closeMenus();
                app.api.actions.shareCurrent();
            },
        }));
    }
    target.style.width = "230px";
    target.hidden = false;
    app.dom.shareBtn.setAttribute("aria-expanded", "true");
    const rootRect = app.root.getBoundingClientRect();
    const rect = app.dom.shareBtn.getBoundingClientRect();
    placePopover(target, rect.right - rootRect.left - (target.offsetWidth || 230), app.dom.toolbar.offsetHeight + 3, false);
}

/* ── 起始页设置 ── */

function toggleEditPanel() {
    if (isMenuOpen(app.dom.editPanel)) closeMenus();
    else openEditPanel();
}

function openEditPanel() {
    closeMenus();
    app.api.suggestions?.close?.();
    const target = app.dom.editPanel;
    target.replaceChildren();

    const head = document.createElement("div");
    head.className = "safari-ep-head";
    const title = document.createElement("span");
    title.className = "safari-ep-title";
    title.textContent = "起始页";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "safari-ep-close";
    close.title = "关闭";
    close.setAttribute("aria-label", "关闭");
    close.innerHTML = icon("close");
    close.addEventListener("click", () => closeMenus());
    head.append(title, close);
    target.appendChild(head);

    const bgLabel = document.createElement("div");
    bgLabel.className = "safari-ep-label";
    bgLabel.textContent = "背景图像";
    target.appendChild(bgLabel);

    const bgGrid = document.createElement("div");
    bgGrid.className = "safari-ep-bgs";
    const backgrounds = [
        { id: "sequoia", name: "Sequoia" },
        { id: "aurora", name: "极光" },
        { id: "sunset", name: "日落" },
        { id: "none", name: "无" },
    ];
    for (const bg of backgrounds) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "safari-ep-bg" + (app.state.settings.background === bg.id ? " is-selected" : "");
        button.dataset.bg = bg.id;
        button.setAttribute("aria-pressed", String(app.state.settings.background === bg.id));
        button.title = bg.name;
        button.innerHTML = `<span class="safari-ep-thumb"><span class="safari-ep-check">${icon("check")}</span></span>` +
            `<span class="safari-ep-bg-name">${escapeHtml(bg.name)}</span>`;
        button.addEventListener("click", () => {
            app.state.settings.background = bg.id;
            saveSettings(app.state.settings);
            bgGrid.querySelectorAll(".safari-ep-bg").forEach((item) => {
                const selected = item.dataset.bg === bg.id;
                item.classList.toggle("is-selected", selected);
                item.setAttribute("aria-pressed", String(selected));
            });
            app.api.start?.render?.();
        });
        bgGrid.appendChild(button);
    }
    target.appendChild(bgGrid);

    const showLabel = document.createElement("div");
    showLabel.className = "safari-ep-label";
    showLabel.textContent = "显示";
    target.appendChild(showLabel);

    const toggles = document.createElement("div");
    toggles.className = "safari-ep-toggles";
    const options = [
        { key: "showFavorites", label: "个人收藏" },
        { key: "showFrequent", label: "经常访问" },
        { key: "showReading", label: "阅读列表" },
    ];
    for (const option of options) {
        const label = document.createElement("label");
        label.className = "safari-ep-toggle";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = app.state.settings[option.key];
        input.addEventListener("change", () => {
            app.state.settings[option.key] = input.checked;
            saveSettings(app.state.settings);
            app.api.start?.render?.();
        });
        const switchEl = document.createElement("span");
        switchEl.className = "safari-switch";
        const text = document.createElement("span");
        text.textContent = option.label;
        label.append(text, input, switchEl);
        toggles.appendChild(label);
    }
    target.appendChild(toggles);

    target.hidden = false;
    app.dom.editBtn.setAttribute("aria-expanded", "true");
    const rootRect = app.root.getBoundingClientRect();
    const rect = app.dom.editBtn.getBoundingClientRect();
    const width = target.offsetWidth || 344;
    const height = target.offsetHeight || 210;
    const left = Math.min(Math.max(rect.right - rootRect.left - width, 10), Math.max(10, app.root.clientWidth - width - 10));
    const top = Math.min(
        Math.max(rect.top - rootRect.top - height - 8, app.dom.toolbar.offsetHeight + 8),
        Math.max(10, app.root.clientHeight - height - 10)
    );
    target.style.left = `${Math.round(left)}px`;
    target.style.top = `${Math.round(top)}px`;
}

/* ── 右键菜单 ── */

function openTabContext(tab, x, y) {
    const external = tab.url !== "safari:start";
    openContextMenu(x, y, [
        { label: "新建标签页", key: "⌘T", action: () => app.api.tabs.newTab() },
        { label: "关闭标签页", key: "⌘W", action: () => app.api.tabs.close(tab.id) },
        {
            label: "关闭其他标签页",
            disabled: app.state.tabs.length < 2,
            action: () => app.api.tabs.closeOthers(tab.id),
        },
        { separator: true },
        { label: "复制链接", disabled: !external, action: () => app.api.actions.copyLink(tab.url) },
        {
            label: "重新载入",
            disabled: !external,
            action: () => {
                app.api.tabs.switchTo(tab.id);
                app.api.tabs.reload();
            },
        },
    ]);
}

function openFavoriteContext(item, x, y) {
    openContextMenu(x, y, [
        { label: "打开", action: () => app.api.actions.openUrl(item.url, { title: item.title }) },
        { label: "在新标签页中打开", action: () => app.api.actions.openUrl(item.url, { newTab: true, title: item.title }) },
        { label: "拷贝链接", action: () => app.api.actions.copyLink(item.url) },
        { separator: true },
        { label: "移除书签", danger: true, action: () => app.api.actions.removeBookmark(item.url) },
    ]);
}

function openFrequentContext(item, x, y) {
    openContextMenu(x, y, [
        { label: "打开", action: () => app.api.actions.openUrl(item.url, { title: item.title }) },
        { label: "在新标签页中打开", action: () => app.api.actions.openUrl(item.url, { newTab: true, title: item.title }) },
        { label: "拷贝链接", action: () => app.api.actions.copyLink(item.url) },
    ]);
}

function openBookmarkContext(item, x, y) {
    openContextMenu(x, y, [
        { label: "打开", action: () => app.api.actions.openUrl(item.url, { title: item.title }) },
        { label: "在新标签页中打开", action: () => app.api.actions.openUrl(item.url, { newTab: true, title: item.title }) },
        { label: "拷贝链接", action: () => app.api.actions.copyLink(item.url) },
        { separator: true },
        { label: "移除书签", danger: true, action: () => app.api.actions.removeBookmark(item.url) },
    ]);
}

function openReadingContext(item, x, y) {
    const current = readingFor(item.url);
    openContextMenu(x, y, [
        { label: "打开", action: () => app.api.actions.openReading(item) },
        { label: "在新标签页中打开", action: () => app.api.actions.openUrl(item.url, { newTab: true, title: item.title }) },
        { label: current && current.read ? "标记为未读" : "标记为已读", action: () => app.api.actions.toggleReadingRead(item.url) },
        { label: "拷贝链接", action: () => app.api.actions.copyLink(item.url) },
        { separator: true },
        { label: "从阅读列表中移除", danger: true, action: () => app.api.actions.removeReading(item.url) },
    ]);
}

function openHistoryContext(item, x, y) {
    openContextMenu(x, y, [
        { label: "打开", action: () => app.api.actions.openUrl(item.url, { title: item.title }) },
        { label: "在新标签页中打开", action: () => app.api.actions.openUrl(item.url, { newTab: true, title: item.title }) },
        { label: "拷贝链接", action: () => app.api.actions.copyLink(item.url) },
        { separator: true },
        { label: "从历史记录中删除", danger: true, action: () => app.api.actions.removeHistory(item.url) },
    ]);
}

export const menusApi = {
    closeAll: closeMenus,
    openTabList,
    togglePageMenu,
    openPageMenu,
    refreshPageMenu,
    openShareMenu,
    toggleEditPanel,
    openEditPanel,
    openTabContext,
    openFavoriteContext,
    openFrequentContext,
    openBookmarkContext,
    openReadingContext,
    openHistoryContext,
};
