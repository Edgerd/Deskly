/** 标签页概览：真实标签卡片、关闭与新建；不伪造网页截图。 */

import { app } from "./app.js";
import { titleOfTab } from "./store.js";
import { faviconMarkup, hostOf, hueFor, icon } from "./utils.js";

function openOverview() {
    if (app.state.overviewOpen) return;
    app.api.menus?.closeAll?.();
    app.api.suggestions?.close?.();
    app.state.overviewOpen = true;
    app.dom.overview.hidden = false;
    renderOverview();
    app.api.tabs?.syncToolbar?.();
}

function closeOverview() {
    app.state.overviewOpen = false;
    app.dom.overview.hidden = true;
    app.api.tabs?.syncToolbar?.();
}

function toggleOverview() {
    if (app.state.overviewOpen) closeOverview();
    else openOverview();
}

function renderOverviewIfOpen() {
    if (app.state.overviewOpen) renderOverview();
}

function renderOverview() {
    if (!app.state.overviewOpen) return;
    const d = app.dom;
    d.overviewSub.textContent = `${app.state.tabs.length} 个标签页`;
    d.overviewGrid.replaceChildren();

    for (const tab of app.state.tabs) {
        const card = document.createElement("div");
        card.className = "safari-ov-card" + (tab.id === app.state.activeId ? " is-active" : "");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", titleOfTab(tab));

        const preview = document.createElement("div");
        preview.className = "safari-ov-preview";
        if (tab.url === "safari:start") {
            preview.classList.add("safari-ov-preview--start");
            preview.dataset.startBg = app.state.settings.background;
        } else {
            preview.classList.add("safari-ov-preview--site");
            preview.style.setProperty("--site-h", String(hueFor(hostOf(tab.url))));
            preview.insertAdjacentHTML("beforeend", faviconMarkup(tab.url, tab.title, "safari-ov-icon", { globe: true }));
        }

        const close = document.createElement("button");
        close.type = "button";
        close.className = "safari-ov-close";
        close.title = "关闭标签页";
        close.setAttribute("aria-label", "关闭标签页");
        close.innerHTML = icon("close");
        close.addEventListener("click", (event) => {
            event.stopPropagation();
            app.api.tabs.close(tab.id);
        });

        const foot = document.createElement("div");
        foot.className = "safari-ov-foot";
        const footIcon = document.createElement("span");
        footIcon.className = "safari-ov-foot-icon";
        footIcon.innerHTML = tab.url === "safari:start"
            ? icon("globe")
            : faviconMarkup(tab.url, tab.title, "safari-ov-foot-fav", { globe: true });
        const footInfo = document.createElement("span");
        footInfo.className = "safari-ov-foot-info";
        const title = document.createElement("span");
        title.className = "safari-ov-title";
        title.textContent = titleOfTab(tab);
        const host = document.createElement("span");
        host.className = "safari-ov-host";
        host.textContent = tab.url === "safari:start" ? "Safari 起始页" : hostOf(tab.url);
        footInfo.append(title, host);
        foot.append(footIcon, footInfo);

        card.append(preview, close, foot);
        card.addEventListener("click", () => {
            app.api.tabs.switchTo(tab.id);
            closeOverview();
        });
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                app.api.tabs.switchTo(tab.id);
                closeOverview();
            }
        });
        d.overviewGrid.appendChild(card);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.className = "safari-ov-new";
    add.innerHTML = `${icon("plus")}<span>新建标签页</span>`;
    add.addEventListener("click", () => {
        closeOverview();
        app.api.tabs.newTab();
    });
    d.overviewGrid.appendChild(add);
}

export const overviewApi = {
    open: openOverview,
    close: closeOverview,
    toggle: toggleOverview,
    render: renderOverview,
    renderIfOpen: renderOverviewIfOpen,
};
