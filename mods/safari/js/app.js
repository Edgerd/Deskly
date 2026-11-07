/**
 * 应用上下文：窗口根、DOM 引用、运行期状态、跨模块 API 槽位。
 * 坑：兄弟模块 URL 稳定会命中浏览器模块缓存，app 对象跨次打开复用，
 * 每次 boot 必须先 resetApp() 清空状态与 DOM 引用，不残留上一次的标签与计时器。
 */

export function createInitialState() {
    return {
        tabs: [],
        activeId: null,
        seq: 0,
        closed: [],
        sidebarOpen: false,
        sidebarView: "root",
        sidebarQuery: "",
        overviewOpen: false,
        settings: { background: "sequoia", showFavorites: true, showFrequent: true, showReading: true },
        zoom: {},
        sugg: { items: [], index: 0, open: false },
        confirmResolver: null,
        toastTimer: null,
        stageAnimTimer: null,
        sidebarAnimTimer: null,
    };
}

export const app = {
    root: null,
    dom: {},
    state: createInitialState(),
    api: {},
};

export function resetApp(root) {
    app.root = root;
    app.dom = {};
    app.state = createInitialState();
    app.api = {};
    return app;
}

const DOM_IDS = {
    toolbar: "safari-toolbar",
    sidebarToggle: "safari-sidebar-toggle",
    tabgroupBtn: "safari-tabgroup-btn",
    backBtn: "safari-back",
    forwardBtn: "safari-forward",
    tabsEl: "safari-tabs",
    shareBtn: "safari-share",
    newTabBtn: "safari-newtab",
    overviewToggle: "safari-overview-toggle",
    sidebar: "safari-sidebar",
    sidebarBack: "safari-sidebar-back",
    sidebarTitle: "safari-sidebar-title",
    sidebarAdd: "safari-sidebar-add",
    sidebarClear: "safari-sidebar-clear",
    sidebarSearchWrap: "safari-sidebar-search-wrap",
    sidebarInput: "safari-sidebar-input",
    sidebarBody: "safari-sidebar-body",
    stage: "safari-stage",
    startEl: "safari-start",
    startScroll: "safari-start-scroll",
    sectionFavorites: "safari-section-favorites",
    sectionFrequent: "safari-section-frequent",
    sectionReading: "safari-section-reading",
    favoritesEl: "safari-favorites",
    frequentEl: "safari-frequent",
    readingEl: "safari-reading",
    editBtn: "safari-edit-btn",
    pages: "safari-pages",
    error: "safari-error",
    errorText: "safari-error-text",
    errorExternal: "safari-error-external",
    errorReload: "safari-error-reload",
    overview: "safari-overview",
    overviewSub: "safari-overview-sub",
    overviewGrid: "safari-overview-grid",
    overviewDone: "safari-overview-done",
    suggestions: "safari-suggestions",
    pageMenu: "safari-page-menu",
    shareMenu: "safari-share-menu",
    tabList: "safari-tab-list",
    editPanel: "safari-edit-panel",
    contextMenu: "safari-context-menu",
    confirm: "safari-confirm",
    confirmTitle: "safari-confirm-title",
    confirmMessage: "safari-confirm-message",
    confirmOk: "safari-confirm-ok",
    confirmCancel: "safari-confirm-cancel",
    toast: "safari-toast",
};

export function collectDom() {
    for (const [key, id] of Object.entries(DOM_IDS)) {
        app.dom[key] = document.getElementById(id);
    }
}
