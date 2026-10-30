/** 地址栏建议：本地历史 / 书签 / 阅读列表匹配 + 搜索或打开地址。 */

import { app } from "./app.js";
import { loadBookmarks, loadHistory, loadReading } from "./store.js";
import { clamp, escapeHtml, hostOf, icon, resolveInput } from "./utils.js";
import { SEARCH_NAME } from "./constants.js";

function quickPickItems() {
    const items = [];
    const seen = new Set();
    for (const entry of loadHistory().sort((a, b) => b.visitedAt - a.visitedAt).slice(0, 6)) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        items.push({
            group: "快速访问",
            type: "history",
            icon: "clock",
            title: entry.title,
            sub: hostOf(entry.url),
            url: entry.url,
        });
    }
    for (const bookmark of loadBookmarks().slice(0, 6)) {
        if (seen.has(bookmark.url)) continue;
        seen.add(bookmark.url);
        items.push({
            group: "快速访问",
            type: "bookmark",
            icon: "star",
            title: bookmark.title,
            sub: hostOf(bookmark.url),
            url: bookmark.url,
        });
    }
    for (const entry of loadReading().slice(0, 4)) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        items.push({
            group: "快速访问",
            type: "reading",
            icon: "book",
            title: entry.title,
            sub: hostOf(entry.url),
            url: entry.url,
        });
    }
    return items.slice(0, 8);
}

function matchItems(query) {
    const q = query.toLowerCase();
    const seen = new Set();
    const out = [];
    const push = (item, iconName, type) => {
        if (!item || seen.has(item.url)) return;
        if (!String(item.title || "").toLowerCase().includes(q) &&
            !String(item.url).toLowerCase().includes(q) &&
            !hostOf(item.url).toLowerCase().includes(q)) return;
        seen.add(item.url);
        out.push({
            group: "书签与历史记录",
            type,
            icon: iconName,
            title: item.title || item.url,
            sub: hostOf(item.url),
            url: item.url,
        });
    };
    loadBookmarks().forEach((item) => push(item, "star", "bookmark"));
    loadReading().forEach((item) => push(item, "book", "reading"));
    loadHistory().sort((a, b) => b.visitedAt - a.visitedAt).forEach((item) => push(item, "clock", "history"));
    return out.slice(0, 6);
}

function suggestionItems() {
    const input = app.api.tabs?.addressInput?.();
    const raw = input ? input.value.trim() : "";
    if (!raw) return quickPickItems();
    const items = [];
    const resolved = resolveInput(raw);
    if (resolved && !resolved.error) {
        if (resolved.kind === "search") {
            items.push({
                group: "搜索建议",
                type: "search",
                icon: "magnifier",
                title: `搜索 “${raw}”`,
                sub: SEARCH_NAME,
                query: raw,
            });
        } else if (resolved.kind === "url") {
            items.push({
                group: "搜索建议",
                type: "url",
                icon: "globe",
                title: `访问 “${hostOf(resolved.url)}”`,
                sub: hostOf(resolved.url),
                url: resolved.url,
            });
        }
    }
    items.push(...matchItems(raw));
    return items;
}

function positionSuggestions() {
    const input = app.api.tabs?.addressInput?.();
    const tabEl = app.api.tabs?.activeTabEl?.();
    if (!input || !tabEl) return;
    const rootRect = app.root.getBoundingClientRect();
    const tabRect = tabEl.getBoundingClientRect();
    const toolbarBottom = app.dom.toolbar.getBoundingClientRect().bottom;
    const width = clamp(tabRect.width, 320, app.root.clientWidth - 24);
    const left = clamp(
        tabRect.left - rootRect.left + (tabRect.width - width) / 2,
        10,
        app.root.clientWidth - width - 10
    );
    app.dom.suggestions.style.width = `${Math.round(width)}px`;
    app.dom.suggestions.style.left = `${Math.round(left)}px`;
    app.dom.suggestions.style.top = `${Math.round(toolbarBottom - rootRect.top + 4)}px`;
}

function openSuggestions() {
    const input = app.api.tabs?.addressInput?.();
    if (!input || document.activeElement !== input) return;
    app.state.sugg.items = suggestionItems();
    app.state.sugg.index = 0;
    if (!app.state.sugg.items.length) {
        closeSuggestions();
        return;
    }
    const target = app.dom.suggestions;
    target.replaceChildren();
    let lastGroup = "";
    app.state.sugg.items.forEach((item, index) => {
        if (item.group !== lastGroup) {
            lastGroup = item.group;
            const head = document.createElement("div");
            head.className = "safari-sug-head";
            head.textContent = item.group;
            target.appendChild(head);
        }
        const row = document.createElement("button");
        row.type = "button";
        row.className = "safari-sug-row" + (index === 0 ? " is-selected" : "");
        row.setAttribute("role", "option");
        row.dataset.index = String(index);
        row.innerHTML = icon(item.icon) +
            `<span class="safari-sug-text">${escapeHtml(item.title)}</span>` +
            `<span class="safari-sug-sub">${escapeHtml(item.sub || "")}</span>`;
        row.addEventListener("mouseenter", () => setSuggestionIndex(index));
        row.addEventListener("click", () => activateSuggestion(index));
        target.appendChild(row);
    });
    app.state.sugg.open = true;
    target.hidden = false;
    input.setAttribute("aria-expanded", "true");
    positionSuggestions();
}

function setSuggestionIndex(index) {
    if (!app.state.sugg.items.length) return;
    app.state.sugg.index = clamp(index, 0, app.state.sugg.items.length - 1);
    app.dom.suggestions.querySelectorAll(".safari-sug-row").forEach((row) => {
        row.classList.toggle("is-selected", Number(row.dataset.index) === app.state.sugg.index);
    });
    const selected = app.dom.suggestions.querySelector(`.safari-sug-row[data-index="${app.state.sugg.index}"]`);
    if (selected) selected.scrollIntoView({ block: "nearest" });
}

function moveSuggestion(delta) {
    setSuggestionIndex(app.state.sugg.index + delta);
}

function activateSuggestion(index) {
    const item = app.state.sugg.items[index];
    if (!item) return;
    closeSuggestions();
    app.api.tabs?.blurAddress?.();
    if (item.type === "search") app.api.tabs?.navigateTo?.(item.query);
    else if (item.url) app.api.tabs?.navigateTo?.(item.url);
}

function closeSuggestions() {
    app.state.sugg.open = false;
    app.state.sugg.items = [];
    app.state.sugg.index = 0;
    if (app.dom.suggestions) app.dom.suggestions.hidden = true;
    const input = app.api.tabs?.addressInput?.();
    if (input) input.setAttribute("aria-expanded", "false");
}

export const suggestionsApi = {
    open: openSuggestions,
    close: closeSuggestions,
    move: moveSuggestion,
    setIndex: setSuggestionIndex,
    activate: activateSuggestion,
};
