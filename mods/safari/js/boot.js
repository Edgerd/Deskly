/** 启动编排：重置跨次复用的模块状态，装配 API，创建首个起始页标签。 */

import { app, collectDom, resetApp } from "./app.js";
import { HOME } from "./constants.js";
import { loadSettings, loadZoomMap } from "./store.js";
import { actionsApi } from "./actions.js";
import { initEvents } from "./events.js";
import { menusApi } from "./menus.js";
import { overviewApi } from "./overview.js";
import { sidebarApi } from "./sidebar.js";
import { startApi } from "./start.js";
import { suggestionsApi } from "./suggestions.js";
import { tabsApi } from "./tabs.js";

export function boot() {
    const root = document.querySelector(".safari.window");
    if (!root || root._safariInited) return;
    root._safariInited = true;

    resetApp(root);
    collectDom();
    if (!app.dom.tabsEl || !app.dom.toolbar || !app.dom.startEl) return;

    app.state.settings = loadSettings();
    app.state.zoom = loadZoomMap();

    app.api.tabs = tabsApi;
    app.api.start = startApi;
    app.api.sidebar = sidebarApi;
    app.api.overview = overviewApi;
    app.api.suggestions = suggestionsApi;
    app.api.menus = menusApi;
    app.api.actions = actionsApi;

    initEvents();
    app.api.tabs.create(HOME, { select: true, focusAddress: false });
    app.api.sidebar.render();
    app.api.tabs.syncToolbar();
    app.api.tabs.syncStage();
}
