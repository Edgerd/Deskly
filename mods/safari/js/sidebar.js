/** 侧栏：根目录 + 书签 / 阅读列表 / 历史记录三个真实集合。 */

import { app } from "./app.js";
import { loadBookmarks, loadHistory, loadReading } from "./store.js";
import { dayLabel, escapeHtml, faviconMarkup, gradientFor, hostOf, icon, timeLabel } from "./utils.js";

function activeTab() {
    return app.api.tabs?.active?.() || null;
}

function pulseSidebarBody() {
    const body = app.dom.sidebarBody;
    if (!body) return;
    clearTimeout(app.state.sidebarAnimTimer);
    body.classList.remove("is-entering");
    void body.offsetWidth;
    body.classList.add("is-entering");
    app.state.sidebarAnimTimer = setTimeout(() => {
        body.classList.remove("is-entering");
        app.state.sidebarAnimTimer = null;
    }, 220);
}

function openSidebar(view = app.state.sidebarView || "root") {
    const changed = view !== app.state.sidebarView;
    app.state.sidebarOpen = true;
    if (changed) {
        app.state.sidebarView = view;
        app.state.sidebarQuery = "";
        if (app.dom.sidebarInput) app.dom.sidebarInput.value = "";
    }
    renderSidebar();
    if (changed) pulseSidebarBody();
}

function closeSidebar() {
    app.state.sidebarOpen = false;
    app.api.menus?.closeAll?.();
    renderSidebar();
}

function toggleSidebar() {
    if (app.state.sidebarOpen) closeSidebar();
    else openSidebar();
}

function setSidebarView(view) {
    app.state.sidebarView = view;
    app.state.sidebarQuery = "";
    if (app.dom.sidebarInput) app.dom.sidebarInput.value = "";
    renderSidebar();
    pulseSidebarBody();
}

function renderSidebarIfOpen() {
    if (app.state.sidebarOpen) renderSidebar();
}

function renderSidebar() {
    const d = app.dom;
    if (!d.sidebar) return;
    d.sidebar.classList.toggle("is-open", app.state.sidebarOpen);
    d.sidebar.setAttribute("aria-hidden", String(!app.state.sidebarOpen));
    // width:0 仍会让里面的按钮被 Tab 聚焦，收起时用 inert 一并切断交互。
    d.sidebar.inert = !app.state.sidebarOpen;
    const view = app.state.sidebarView;
    const titles = { root: "Safari", bookmarks: "书签", reading: "阅读列表", history: "历史记录" };
    d.sidebarTitle.textContent = titles[view] || "侧栏";
    d.sidebarBack.hidden = view === "root";
    d.sidebarAdd.hidden = view === "root" || view === "history";
    d.sidebarClear.hidden = view !== "history";
    d.sidebarSearchWrap.hidden = view === "root";
    const tab = activeTab();
    d.sidebarAdd.disabled = !tab || tab.url === "safari:start";
    d.sidebarInput.placeholder = view === "bookmarks" ? "搜索书签"
        : view === "reading" ? "搜索阅读列表"
            : "搜索历史记录";
    renderSidebarBody();
}

function renderSidebarBody() {
    const target = app.dom.sidebarBody;
    if (!target) return;
    target.replaceChildren();
    const view = app.state.sidebarView;
    if (view === "root") return renderSidebarRoot();
    if (view === "bookmarks") return renderSidebarBookmarks();
    if (view === "reading") return renderSidebarReading();
    return renderSidebarHistory();
}

function sidebarEmpty(text) {
    const element = document.createElement("div");
    element.className = "safari-sb-empty";
    element.innerHTML = icon("globe");
    const label = document.createElement("span");
    label.textContent = text;
    element.appendChild(label);
    return element;
}

function renderSidebarRoot() {
    const rows = [
        { icon: "star", label: "书签", count: loadBookmarks().length, view: "bookmarks" },
        { icon: "book", label: "阅读列表", count: loadReading().length, view: "reading" },
        { icon: "clock", label: "历史记录", count: loadHistory().length, view: "history" },
    ];
    for (const row of rows) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "safari-sb-row";
        button.innerHTML = `${icon(row.icon)}<span class="safari-sb-row-label">${escapeHtml(row.label)}</span>` +
            `<span class="safari-sb-row-count">${row.count}</span>`;
        button.addEventListener("click", () => setSidebarView(row.view));
        app.dom.sidebarBody.appendChild(button);
    }
}

function sidebarMatches(item, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return String(item.title || "").toLowerCase().includes(q) ||
        String(item.url || "").toLowerCase().includes(q) ||
        hostOf(item.url).toLowerCase().includes(q);
}

function appendRecentCards(list) {
    const recent = list.slice(0, 3);
    if (!recent.length) return;
    const heading = document.createElement("div");
    heading.className = "safari-sb-section";
    heading.textContent = "最近添加";
    app.dom.sidebarBody.appendChild(heading);
    const grid = document.createElement("div");
    grid.className = "safari-sb-recent";
    for (const item of recent) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "safari-sb-recent-card";
        card.style.setProperty("--safari-sb-hue", gradientFor(item.url));
        card.title = item.url;
        card.innerHTML = faviconMarkup(item.url, item.title, "safari-sb-recent-icon") +
            `<span class="safari-sb-recent-title">${escapeHtml(item.title)}</span>` +
            `<span class="safari-sb-recent-host">${escapeHtml(hostOf(item.url))}</span>`;
        card.addEventListener("click", () => app.api.actions?.openUrl?.(item.url, { title: item.title }));
        card.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            app.api.menus?.openFavoriteContext?.(item, event.clientX, event.clientY);
        });
        grid.appendChild(card);
    }
    app.dom.sidebarBody.appendChild(grid);
}

function appendSidebarItem({ url, title, sub, read = false, time = "", onClick, onContext }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "safari-sb-item" + (read ? " is-read" : "");
    row.title = url;
    row.innerHTML = faviconMarkup(url, title, "safari-sb-item-icon", { globe: true }) +
        `<span class="safari-sb-item-info"><span class="safari-sb-item-title">${escapeHtml(title)}</span>` +
        `<span class="safari-sb-item-sub">${escapeHtml(sub)}</span></span>` +
        (time ? `<span class="safari-sb-item-time">${escapeHtml(time)}</span>` : "");
    row.addEventListener("click", onClick);
    row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        onContext(event.clientX, event.clientY);
    });
    app.dom.sidebarBody.appendChild(row);
}

function renderSidebarBookmarks() {
    const query = app.state.sidebarQuery.trim();
    const list = loadBookmarks().filter((item) => sidebarMatches(item, query));
    if (!list.length) {
        app.dom.sidebarBody.appendChild(sidebarEmpty(query ? "没有匹配的书签" : "暂无书签"));
        return;
    }
    if (!query) appendRecentCards(list);
    const heading = document.createElement("div");
    heading.className = "safari-sb-section";
    heading.textContent = query ? "搜索结果" : "全部书签";
    app.dom.sidebarBody.appendChild(heading);
    for (const item of list) {
        appendSidebarItem({
            url: item.url,
            title: item.title,
            sub: hostOf(item.url),
            onClick: () => app.api.actions?.openUrl?.(item.url, { title: item.title }),
            onContext: (x, y) => app.api.menus?.openBookmarkContext?.(item, x, y),
        });
    }
}

function renderSidebarReading() {
    const query = app.state.sidebarQuery.trim();
    const list = loadReading().filter((item) => sidebarMatches(item, query));
    if (!list.length) {
        app.dom.sidebarBody.appendChild(sidebarEmpty(query ? "没有匹配的阅读列表项目" : "暂无阅读列表项目"));
        return;
    }
    const heading = document.createElement("div");
    heading.className = "safari-sb-section";
    heading.textContent = query ? "搜索结果" : "阅读列表";
    app.dom.sidebarBody.appendChild(heading);
    for (const item of list) {
        appendSidebarItem({
            url: item.url,
            title: item.title,
            sub: hostOf(item.url),
            read: item.read,
            onClick: () => app.api.actions?.openReading?.(item),
            onContext: (x, y) => app.api.menus?.openReadingContext?.(item, x, y),
        });
    }
}

function renderSidebarHistory() {
    const query = app.state.sidebarQuery.trim();
    const list = loadHistory()
        .filter((item) => sidebarMatches(item, query))
        .sort((a, b) => b.visitedAt - a.visitedAt);
    if (!list.length) {
        app.dom.sidebarBody.appendChild(sidebarEmpty(query ? "没有匹配的历史记录" : "暂无历史记录"));
        return;
    }
    let currentDay = "";
    for (const item of list) {
        const label = dayLabel(item.visitedAt || Date.now());
        if (label !== currentDay) {
            currentDay = label;
            const heading = document.createElement("div");
            heading.className = "safari-sb-day";
            heading.textContent = label;
            app.dom.sidebarBody.appendChild(heading);
        }
        appendSidebarItem({
            url: item.url,
            title: item.title,
            sub: hostOf(item.url),
            time: timeLabel(item.visitedAt || Date.now()),
            onClick: () => app.api.actions?.openUrl?.(item.url, { title: item.title }),
            onContext: (x, y) => app.api.menus?.openHistoryContext?.(item, x, y),
        });
    }
}

export const sidebarApi = {
    open: openSidebar,
    close: closeSidebar,
    toggle: toggleSidebar,
    setView: setSidebarView,
    render: renderSidebar,
    renderBody: renderSidebarBody,
    renderIfOpen: renderSidebarIfOpen,
};
