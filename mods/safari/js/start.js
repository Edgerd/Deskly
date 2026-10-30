/** 起始页：个人收藏、经常访问、阅读列表与空状态。 */

import { app } from "./app.js";
import { frequentItems, loadBookmarks, loadReading } from "./store.js";
import { escapeHtml, faviconMarkup, hostOf, icon } from "./utils.js";

function renderStart() {
    if (!app.dom.startEl) return;
    app.dom.startEl.dataset.bg = app.state.settings.background;
    app.dom.sectionFavorites.hidden = !app.state.settings.showFavorites;
    renderFavorites();
    renderFrequent();
    renderStartReading();
}

function renderFavorites() {
    const bookmarks = loadBookmarks();
    const target = app.dom.favoritesEl;
    target.replaceChildren();
    if (!bookmarks.length) {
        const empty = document.createElement("div");
        empty.className = "safari-start-empty";
        empty.innerHTML = `${icon("star")}<div class="safari-start-empty-text">还没有个人收藏。打开网页后按 ⌘D，或用页面菜单添加书签。</div>` +
            `<button class="safari-start-empty-btn" type="button">打开书签侧栏</button>`;
        empty.querySelector("button").addEventListener("click", () => app.api.sidebar?.open?.("bookmarks"));
        target.appendChild(empty);
        return;
    }
    for (const bookmark of bookmarks) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "safari-fav";
        button.title = `${bookmark.title}\n${hostOf(bookmark.url)}`;
        button.innerHTML = faviconMarkup(bookmark.url, bookmark.title, "safari-fav-icon") +
            `<span class="safari-fav-label">${escapeHtml(bookmark.title)}</span>`;
        button.addEventListener("click", (event) => {
            if (event.metaKey || event.ctrlKey) app.api.actions?.openUrl?.(bookmark.url, { newTab: true, title: bookmark.title });
            else app.api.actions?.openUrl?.(bookmark.url, { title: bookmark.title });
        });
        button.addEventListener("auxclick", (event) => {
            if (event.button === 1) {
                event.preventDefault();
                app.api.actions?.openUrl?.(bookmark.url, { newTab: true, title: bookmark.title });
            }
        });
        button.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            app.api.menus?.openFavoriteContext?.(bookmark, event.clientX, event.clientY);
        });
        target.appendChild(button);
    }
}

function renderFrequent() {
    const items = app.state.settings.showFrequent ? frequentItems(8) : [];
    app.dom.sectionFrequent.hidden = !items.length;
    const target = app.dom.frequentEl;
    target.replaceChildren();
    for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "safari-freq-card";
        button.title = item.url;
        button.innerHTML = faviconMarkup(item.url, item.title, "safari-freq-icon") +
            `<span class="safari-freq-info"><span class="safari-freq-title">${escapeHtml(item.title)}</span>` +
            `<span class="safari-freq-host">${escapeHtml(item.host)}</span></span>`;
        button.addEventListener("click", (event) => {
            if (event.metaKey || event.ctrlKey) app.api.actions?.openUrl?.(item.url, { newTab: true, title: item.title });
            else app.api.actions?.openUrl?.(item.url, { title: item.title });
        });
        button.addEventListener("auxclick", (event) => {
            if (event.button === 1) {
                event.preventDefault();
                app.api.actions?.openUrl?.(item.url, { newTab: true, title: item.title });
            }
        });
        button.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            app.api.menus?.openFrequentContext?.(item, event.clientX, event.clientY);
        });
        target.appendChild(button);
    }
}

function renderStartReading() {
    const all = app.state.settings.showReading ? loadReading() : [];
    app.dom.sectionReading.hidden = !all.length;
    const target = app.dom.readingEl;
    target.replaceChildren();
    for (const item of all.slice(0, 4)) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "safari-reading-row" + (item.read ? " is-read" : "");
        row.title = item.url;
        row.innerHTML = `<span class="safari-reading-dot" aria-hidden="true"></span>` +
            `<span class="safari-reading-info"><span class="safari-reading-title">${escapeHtml(item.title)}</span>` +
            `<span class="safari-reading-host">${escapeHtml(hostOf(item.url))}</span></span>` +
            icon("forward");
        row.addEventListener("click", (event) => {
            if (event.metaKey || event.ctrlKey) app.api.actions?.openUrl?.(item.url, { newTab: true, title: item.title });
            else app.api.actions?.openReading?.(item);
        });
        row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            app.api.menus?.openReadingContext?.(item, event.clientX, event.clientY);
        });
        target.appendChild(row);
    }
    if (all.length > 4) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "safari-reading-row";
        more.innerHTML = `<span class="safari-reading-info"><span class="safari-reading-title">查看全部 ${all.length} 项阅读列表</span>` +
            `<span class="safari-reading-host">在侧栏中打开</span></span>${icon("book")}`;
        more.addEventListener("click", () => app.api.sidebar?.open?.("reading"));
        target.appendChild(more);
    }
}

export const startApi = { render: renderStart };
