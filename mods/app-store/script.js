/**
 * script.js — App Store 界面：Today / 应用列表 / 应用详情 / 更新日志 / 安装记录。
 *
 * 分层：本文件只做界面与交互，数据与动作全部来自 src/javascripts/store-api.js
 * 与 src/javascripts/changelog.js；商店 DOM 只由这里生成，宿主不认识商店的界面。
 *
 * 只渲染清单里真实存在的内容：
 * - 详情页没有截图就不留空位，没有评分数据就不摆分数；
 * - 权限与隐私两个卡片读的是 manifest.permissions，与授权账本同源；
 * - 详情页不出现任何「推荐应用 / 你可能也喜欢」之类的板块。
 *
 * 亚克力禁忌：带 backdrop-filter 的元素不加 transform / will-change:transform，
 * 悬停反馈一律走 background / box-shadow / border-color。
 */

import { i18n } from "../../src/javascripts/i18n.js";
import { openApp, whenReady } from "../../src/javascripts/plugin-manager.js";
import {
    getEntry,
    listEntries,
    categories,
    filterEntries,
    history,
    installZip,
    uninstall,
    uninstallPreview,
    verifyInstall,
    swStatus,
    versionDiff,
    setEnabled,
    PLACEHOLDER_ICON,
} from "../../src/javascripts/store-api.js";
import {
    getSystemChangelog,
    getPluginChangelog,
    versionGroups,
    latestGroup,
    summaryOf,
    relativeTime,
    versionLabel,
} from "../../src/javascripts/changelog.js";
import { STORE_MESSAGES as MESSAGES } from "./messages.js";
import { iconEl } from "../../src/javascripts/ui/phosphor-icons.js";

/* ───────────────────────── 四语文案 ───────────────────────── */

try {
    if (typeof i18n.registerMessagesAll === "function") i18n.registerMessagesAll(MESSAGES);
} catch (err) {
    console.warn("[app-store] 注册文案失败", err);
}

/** 取词条：始终带中文回退，缺词条时不至于露出键名。 */
function t(key, fallback) {
    return i18n.t(key, fallback);
}

/* ───────────────────────── 基础 ───────────────────────── */

// 窗口根元素：整份脚本只服务这一个窗口。
const win = document.querySelector(".appstore.window");

// 视图状态：模块级可变，init() 复位（窗口关闭再打开时重新执行本脚本）
let view = "today";          // today | list | detail | changelog | history
let categoryKey = "all";     // all | builtin | installed | cat:<分类名>
let keyword = "";
let currentId = null;        // 详情页 / 插件日志对应的插件 id
let logTarget = null;        // {kind:"system"} | {kind:"plugin", id, name}
let activeNavSync = null;

const PANES = ["today", "list", "detail", "changelog"];

function $(role) { return win.querySelector(`[data-role="${role}"]`); }

/** 建元素：文本一律走 textContent，清单里的字段是不可信输入，不能拼 HTML。 */
function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}

/** 图片一律禁掉原生拖拽：否则按住拖会变成浏览器在拖一个图片文件，还留半透明拖影。 */
function pic(src, alt, cls) {
    const el = h("img", cls);
    el.src = src;
    el.alt = alt || "";
    el.draggable = false;
    el.addEventListener("error", () => { if (el.src !== PLACEHOLDER_ICON) el.src = PLACEHOLDER_ICON; }, { once: true });
    return el;
}

/** 分组小标题 + 内容块 */
function section(title, rows) {
    const box = h("section", "dblock");
    box.appendChild(h("h3", null, title));
    rows.forEach((r) => box.appendChild(r));
    return box;
}

/**
 * 清单没写 `store` 时 store-api 返回 null（用来区分「没声明」与「声明了但为空」）。
 * 详情页按字段逐个判空，所以这里补一份全空骨架。
 */
function normalizeStore(store) {
    return Object.assign(
        { category: "", tagline: "", summary: "", features: [], usage: "", updated: "", homepage: "", author: "", screenshots: [] },
        store || {},
    );
}

function setPane(which) {
    PANES.forEach((role) => { $(role).hidden = role !== which; });
}

function setHeading(title, count) {
    $("cat-title").textContent = title;
    $("count").textContent = count || "";
}

function init() {
    view = "today";
    categoryKey = "all";
    keyword = "";
    currentId = null;
    logTarget = null;

    const search = $("search");
    search.value = "";
    search.placeholder = t("as.sidebar.search", "搜索应用");
    search.addEventListener("input", () => {
        keyword = search.value.trim();
        // 输入即回到结果列表：停在详情页改搜索词会「输了没反应」
        showList();
    });

    $("back").textContent = t("as.toolbar.back", "返回");
    $("back").addEventListener("click", goBack);
    $("catshead").textContent = t("as.sidebar.categories", "类别");
    paintHistoryBtn();
    $("history").addEventListener("click", showHistory);
    $("pick").textContent = t("as.toolbar.install", "安装 ZIP…");

    const file = $("file");
    $("pick").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
        const f = file.files && file.files[0];
        file.value = "";
        if (f) install(f);
    });

    bindDrop();

    // 注册表变化实时对账：安装/卸载/启用都会重画当前视图
    const touched = () => refresh();
    document.addEventListener("plugin-registered", touched);
    document.addEventListener("plugin-unregistered", touched);
    document.addEventListener("plugin-enabled-change", touched);
    window.addEventListener("plugins-ready", touched);
    win._storeCleanup = () => {
        document.removeEventListener("plugin-registered", touched);
        document.removeEventListener("plugin-unregistered", touched);
        document.removeEventListener("plugin-enabled-change", touched);
        window.removeEventListener("plugins-ready", touched);
    };

    win.addEventListener("keydown", onKeynav);

    // 兜底：将来任何动态加的 img 也不许被拖出窗口
    win.addEventListener("dragstart", (ev) => {
        if (ev.target instanceof Element && ev.target.closest("img")) ev.preventDefault();
    });

    // 窗口宽度变了，截图条的可滚范围跟着变
    const onResize = () => { if (activeNavSync) activeNavSync(); };
    window.addEventListener("resize", onResize);
    const prevCleanup = win._storeCleanup;
    win._storeCleanup = () => { prevCleanup(); window.removeEventListener("resize", onResize); };

    // 切语言后重画当前视图：文案都在本模块的四语表里，不重画会停在旧语言
    if (typeof i18n.onChange === "function") {
        const offLang = i18n.onChange(() => {
            search.placeholder = t("as.sidebar.search", "搜索应用");
            $("back").textContent = t("as.toolbar.back", "返回");
            $("catshead").textContent = t("as.sidebar.categories", "类别");
            paintHistoryBtn();
            $("pick").textContent = t("as.toolbar.install", "安装 ZIP…");
            refresh();
        });
        const prev = win._storeCleanup;
        win._storeCleanup = () => { prev(); if (typeof offLang === "function") offLang(); };
    }

    // 先把骨架画出来：插件注册表就绪前侧栏也不该是空的
    renderNav();
    renderCats();
    whenReady().then(refresh);
    renderSwStatus();
}

function refresh() {
    renderNav();
    renderCats();
    if (view === "detail" && currentId) renderDetail(currentId);
    else if (view === "history") renderHistory();
    else if (view === "changelog" && logTarget) renderLog(logTarget);
    else if (view === "list") renderList();
    else renderToday();
}

/* ───────────────────────── 边栏 ───────────────────────── */

function showToday() {
    closeLightbox();
    activeNavSync = null;
    view = "today";
    currentId = null;
    logTarget = null;
    setPane("today");
    $("back").hidden = true;
    renderNav();
    renderCats();
    renderToday();
}

function showList() {
    closeLightbox();
    activeNavSync = null;
    view = "list";
    currentId = null;
    logTarget = null;
    setPane("list");
    $("back").hidden = true;
    renderNav();
    renderCats();
    renderList();
}

function showDetail(id) {
    closeLightbox();
    activeNavSync = null;
    view = "detail";
    currentId = id;
    logTarget = null;
    setPane("detail");
    $("back").hidden = false;
    renderNav();
    renderCats();
    renderDetail(id);
}

function showHistory() {
    closeLightbox();
    activeNavSync = null;
    view = "history";
    currentId = null;
    logTarget = null;
    setPane("detail");
    $("back").hidden = false;
    renderNav();
    renderCats();
    renderHistory();
}

/** 返回：日志回到它被打开的地方，详情 / 记录回到列表。 */
function goBack() {
    if (view === "changelog") {
        if (logTarget && logTarget.kind === "plugin" && logTarget.id) showDetail(logTarget.id);
        else showToday();
        return;
    }
    if (view === "detail" || view === "history") {
        showList();
        return;
    }
    showToday();
}

/** 分组导航：Today / 应用 / 插件 / 新功能。图标统一从 phosphor-icons 取。 */
function renderNav() {
    const box = $("nav");
    if (!box) return;
    box.innerHTML = "";
    const items = [
        { key: "today", icon: "star", label: t("as.tabs.today", "Today"), active: () => view === "today" },
        { key: "builtin", icon: "squares-four", label: t("as.tabs.apps", "应用"), active: () => view === "list" && categoryKey === "builtin" },
        { key: "installed", icon: "puzzle-piece", label: t("as.tabs.plugins", "插件"), active: () => view === "list" && categoryKey === "installed" },
        { key: "log", icon: "sparkle", label: t("as.tabs.whatsNew", "新功能"), active: () => view === "changelog" && logTarget && logTarget.kind === "system" },
    ];
    items.forEach((it) => {
        if (it.key === "log") box.appendChild(h("div", "as-navsep"));
        const btn = h("button", "as-navitem" + (it.active() ? " active" : ""));
        btn.type = "button";
        const ico = iconEl(it.icon);
        if (ico) btn.appendChild(ico);
        btn.appendChild(h("span", "as-navitem__label", it.label));
        if (it.key === "today") btn.addEventListener("click", showToday);
        else if (it.key === "log") btn.addEventListener("click", showSystemLog);
        else btn.addEventListener("click", () => { categoryKey = it.key; showList(); });
        box.appendChild(btn);
    });
}

/** 底部「安装记录」：文字会随语言重画，所以图标和文案一起重建，避免 textContent 把图标冲掉。 */
function paintHistoryBtn() {
    const btn = $("history");
    if (!btn) return;
    btn.textContent = "";
    const ico = iconEl("clock-counter-clockwise");
    if (ico) btn.appendChild(ico);
    btn.appendChild(h("span", "as-sidebtn__label", t("as.sidebar.history", "安装记录")));
}

/** 类别组：只列真实存在的分类（来自各插件 manifest.store.category）+ 全部。 */
function renderCats() {
    const box = $("cats");
    if (!box) return;
    box.innerHTML = "";
    categories()
        .filter((c) => c.key === "all" || c.key.startsWith("cat:"))
        .forEach((c) => {
            const label = c.key === "all" ? t("as.sidebar.all", "全部") : c.label;
            const btn = h("button", "cat" + (view === "list" && c.key === categoryKey ? " active" : ""), label);
            btn.type = "button";
            btn.appendChild(h("span", "n", String(c.count)));
            btn.addEventListener("click", () => {
                categoryKey = c.key;
                showList();
            });
            box.appendChild(btn);
        });
    $("history").classList.toggle("active", view === "history");
}

/** 资源代理状态：ZIP 插件的资源全靠 SW 从 IndexedDB 回源，没接管就装不了。 */
async function renderSwStatus() {
    const foot = $("sw");
    foot.innerHTML = "";
    const { controlled, registered } = await swStatus();
    const ico = iconEl("plugs-connected", { size: 14 });
    if (ico) foot.appendChild(ico);
    const dot = h("i", "dot " + (controlled ? "on" : "off"));
    foot.appendChild(dot);
    foot.appendChild(h("span", null,
        controlled ? "资源代理已接管" : registered ? "资源代理未接管（无法安装 ZIP）" : "资源代理未注册（无法安装 ZIP）"));
    foot.title = controlled
        ? "已安装插件的资源由 Service Worker 从本地库返回"
        : "页面未被 Service Worker 接管，ZIP 安装无法生效。刷新一次页面通常可恢复。";
}

/* ───────────────────────── Today ───────────────────────── */

function renderToday() {
    const box = $("today");
    box.innerHTML = "";
    const wrap = h("div", "as-today");
    box.appendChild(wrap);
    const entries = listEntries();
    setHeading(t("as.tabs.today", "Today"), "");

    if (!entries.length) {
        wrap.appendChild(h("p", "empty", t("as.today.empty", "这里还没有应用")));
        return;
    }

    const withTag = entries.filter((e) => e.store && e.store.tagline);
    const featured = withTag.find((e) => e.store.screenshots.length) || withTag[0] || entries[0];
    const side = withTag.find((e) => e.id !== featured.id) || entries.find((e) => e.id !== featured.id) || null;

    const row = h("div", "as-today__row");
    row.appendChild(heroCard(featured));
    if (side) row.appendChild(sideCard(side));
    wrap.appendChild(row);

    const shelf = h("div", "as-shelf");
    shelf.appendChild(shelfColumn(t("as.today.weeklyApps", "本周热门应用"), entries.filter((e) => e.source === "builtin")));
    shelf.appendChild(shelfColumn(t("as.today.weeklyPlugins", "本周热门插件"), entries.filter((e) => e.source === "installed"),
        t("as.today.noPlugins", "还没有安装第三方插件")));
    wrap.appendChild(shelf);

    // 「新功能」：只取真实日志的最新一条，读不到就整块不渲染
    getSystemChangelog().then((log) => {
        if (view !== "today" || !wrap.isConnected) return;
        const group = latestGroup(log);
        if (!group) return;
        wrap.appendChild(whatsNewBlock(t("cl.title", "新功能"), group, showSystemLog));
    });
}

function heroCard(e) {
    const card = h("article", "as-hero");
    const text = h("div", "as-hero__text");
    text.appendChild(h("p", "as-hero__kicker", t("as.today.cover", "编辑推荐")));
    text.appendChild(h("h3", "as-hero__name", e.name));
    const desc = (e.store && e.store.tagline) || e.description || "";
    if (desc) text.appendChild(h("p", "as-hero__desc", desc));
    const cta = h("button", "as-hero__cta", t("as.today.view", "查看"));
    cta.type = "button";
    cta.addEventListener("click", () => showDetail(e.id));
    text.appendChild(cta);

    const art = h("div", "as-hero__art");
    art.appendChild(pic(e.icon || PLACEHOLDER_ICON, e.name));
    art.appendChild(h("span", "as-hero__badge", t("as.today.cover", "编辑推荐")));

    card.append(text, art);
    return card;
}

function sideCard(e) {
    const card = h("article", "as-today__side");
    card.appendChild(pic(e.icon || PLACEHOLDER_ICON, e.name, "as-side__icon"));
    card.appendChild(h("h3", null, e.name));
    const desc = (e.store && e.store.tagline) || e.description || "";
    if (desc) card.appendChild(h("p", "as-side__desc", desc));
    const cta = h("button", "as-hero__cta", t("as.today.view", "查看"));
    cta.type = "button";
    cta.addEventListener("click", () => showDetail(e.id));
    card.appendChild(cta);
    return card;
}

function shelfColumn(title, list, emptyText) {
    const col = h("section", "as-shelfcol");
    col.appendChild(h("h3", null, title));
    const rows = list.slice(0, 4);
    if (!rows.length) {
        col.appendChild(h("p", "as-shelf__empty", emptyText || t("as.today.empty", "这里还没有应用")));
        return col;
    }
    rows.forEach((e) => col.appendChild(shelfItem(e)));
    return col;
}

function shelfItem(e) {
    const btn = h("button", "as-shelfitem");
    btn.type = "button";
    btn.appendChild(pic(e.icon || PLACEHOLDER_ICON, e.name));
    const text = h("span", "as-shelfitem__text");
    text.appendChild(h("span", "as-shelfitem__name", e.name));
    const desc = (e.store && e.store.tagline) || e.description || "";
    if (desc) text.appendChild(h("span", "as-shelfitem__desc", desc));
    btn.appendChild(text);
    btn.appendChild(h("span", "as-shelfitem__view", t("as.today.view", "查看")));
    btn.addEventListener("click", () => showDetail(e.id));
    return btn;
}

/* ───────────────────────── 列表 ───────────────────────── */

function renderList() {
    const list = filterEntries(categoryKey, keyword);
    const cat = categories().find((c) => c.key === categoryKey);
    const title = categoryKey === "builtin"
        ? t("as.tabs.apps", "应用")
        : categoryKey === "installed"
            ? t("as.tabs.plugins", "插件")
            : categoryKey === "all"
                ? t("as.sidebar.all", "全部")
                : (cat ? cat.label : t("as.sidebar.all", "全部"));
    setHeading(title, list.length ? `${list.length} ${t("as.count.apps", "个应用")}` : "");

    const grid = $("grid");
    grid.innerHTML = "";
    if (!list.length) {
        grid.appendChild(h("div", "empty",
            keyword ? `${t("as.list.noMatch", "没有匹配的应用")}：${keyword}` : t("as.today.empty", "这里还没有应用")));
        return;
    }
    list.forEach((e) => grid.appendChild(card(e)));
}

function card(e) {
    const el = h("article", "card" + (e.enabled ? "" : " off"));
    el.dataset.id = e.id;
    el.tabIndex = 0;

    el.appendChild(pic(e.icon || PLACEHOLDER_ICON, e.name, "icon"));
    el.appendChild(h("h4", "name", e.name));
    el.appendChild(h("p", "tag", (e.store && e.store.tagline) || e.description || ""));

    const meta = h("p", "meta");
    meta.appendChild(h("span", "ver", e.version ? `v${e.version}` : "v—"));
    meta.appendChild(h("span", "src", e.source === "installed" ? t("as.detail.fromZip", "本地安装") : t("as.detail.builtin", "系统内置")));
    if (!e.enabled) meta.appendChild(h("span", "chip disabled", t("as.detail.disable", "禁用")));
    el.appendChild(meta);

    const btn = h("button", "cta", e.enabled ? t("as.detail.open", "打开") : t("as.detail.enable", "启用"));
    btn.type = "button";
    btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (e.enabled) openEntry(e.id);
        else enable(e.id, true);
    });
    el.appendChild(btn);

    el.addEventListener("click", () => showDetail(e.id));
    return el;
}

/* ───────────────────────── 详情 ───────────────────────── */

function renderDetail(id) {
    const e = getEntry(id);
    const box = $("detail");
    box.innerHTML = "";
    if (!e) {
        box.appendChild(h("p", "empty", t("as.list.gone", "这个应用已经不在了")));
        return;
    }
    const store = normalizeStore(e.store);
    setHeading(e.name, store.category || "");

    const head = h("header", "as-dhead");
    head.appendChild(pic(e.icon || PLACEHOLDER_ICON, e.name, "as-dhead__icon"));

    const info = h("div", "as-dhead__info");
    info.appendChild(h("h2", null, e.name));
    const tagline = store.tagline || e.description || "";
    if (tagline) info.appendChild(h("p", "as-dhead__tagline", tagline));
    head.appendChild(info);

    const acts = h("div", "as-dhead__acts");
    acts.appendChild(h("span", "as-dstate", t("as.detail.installed", "已安装")));
    const primary = h("button", "as-get", e.enabled ? t("as.detail.open", "打开") : t("as.detail.enable", "启用"));
    primary.type = "button";
    primary.addEventListener("click", () => {
        if (e.enabled) openEntry(e.id);
        else enable(e.id, true);
    });
    acts.appendChild(primary);
    head.appendChild(acts);
    box.appendChild(head);

    // 元数据行：只列真实存在的项，没有的（年龄分级 / 排名 / 语言 / 评分）不占位
    const meta = h("div", "as-meta");
    const put = (k, v) => {
        if (!v) return;
        const item = h("div", "as-meta__item");
        item.appendChild(h("span", "as-meta__k", k));
        item.appendChild(h("span", "as-meta__v", v));
        meta.appendChild(item);
    };
    put(t("as.detail.metaCategory", "类别"), store.category);
    put(t("as.detail.metaDeveloper", "开发者"), store.author);
    put(t("as.detail.metaVersion", "版本"), e.version);
    put(t("as.detail.metaSize", "大小"), e.source === "installed" && e.bytes ? `${(e.bytes / 1024).toFixed(0)} KB` : "");
    put(t("as.detail.metaSource", "来源"), e.source === "installed" ? t("as.detail.fromZip", "本地安装") : t("as.detail.builtin", "系统内置"));
    box.appendChild(meta);

    const more = h("div", "as-more");
    if (e.enabled && e.disableable !== false) {
        const off = h("button", "ghost", t("as.detail.disable", "禁用"));
        off.type = "button";
        off.addEventListener("click", () => enable(e.id, false));
        more.appendChild(off);
    }
    if (e.disableable === false && e.disableReason) {
        more.appendChild(h("p", "as-note", e.disableReason));
    }
    if (e.source === "installed") {
        const check = h("button", "ghost", t("as.detail.verify", "校验资源"));
        check.type = "button";
        check.addEventListener("click", () => verify(e.id));
        more.appendChild(check);
        const del = h("button", "danger", t("as.detail.uninstall", "卸载"));
        del.type = "button";
        del.addEventListener("click", () => doUninstall(e.id));
        more.appendChild(del);
    }
    if (more.childElementCount) box.appendChild(more);

    // 截图：清单声明了才显示；某张取不到就把那一格摘掉（不摆占位图骗人）
    if (e.screenshots.length) box.appendChild(section(t("as.detail.shots", "界面截图"), [shotsCarousel(e)]));

    // 简介：描述与清单声明的能力放在同一块，避免出现两个同名小节
    const summary = store.summary || e.description;
    const summaryRows = [];
    if (summary) summaryRows.push(h("p", "para", summary));
    if (store.features.length) {
        const ul = h("ul", "feats");
        store.features.forEach((f) => ul.appendChild(h("li", null, f)));
        summaryRows.push(ul);
    }
    if (summaryRows.length) box.appendChild(section(t("as.detail.summary", "简介"), summaryRows));

    if (e.apps.length) {
        const row = h("div", "apps");
        e.apps.forEach((a) => {
            const chip = h("button", "appchip");
            chip.type = "button";
            chip.appendChild(pic(a.icon || PLACEHOLDER_ICON, a.name));
            chip.appendChild(h("span", null, a.name));
            chip.addEventListener("click", () => openApp(a.appId));
            row.appendChild(chip);
        });
        box.appendChild(section(t("as.detail.included", "包含的应用"), [row]));
    }

    // 评分及评论：没有任何真实评分来源，只说明，不给数字
    const ratingBox = section(t("as.detail.rating", "评分及评论"), [
        h("p", "as-rating__none", t("as.detail.ratingNone", "暂无评分")),
        h("p", "as-note", t("as.detail.ratingNote", "本机商店没有评分数据来源，这里不显示编造的分数。")),
    ]);

    // App 隐私：两张卡片，内容全部来自 manifest.permissions
    const privacy = h("div", "as-privacy");
    privacy.appendChild(privacyCard(
        t("as.detail.privacyTrack", "用于追踪你的数据"),
        t("as.detail.privacyTrackNone", "没有声明用于追踪的数据。"),
    ));
    const linked = h("div", "as-pcard");
    linked.appendChild(h("h4", null, t("as.detail.privacyLinked", "与你关联的数据")));
    if (e.permissions.length) {
        const ul = h("ul", null);
        e.permissions.forEach((p) => {
            const li = h("li");
            li.appendChild(h("b", null, p.label));
            if (p.hint) li.appendChild(h("span", null, p.hint));
            ul.appendChild(li);
        });
        linked.appendChild(ul);
    } else {
        linked.appendChild(h("p", "none", t("as.detail.privacyLinkedNone", "不需要访问任何数据。")));
    }
    privacy.appendChild(linked);
    const privacyBox = section(t("as.detail.privacy", "App 隐私"), [
        privacy,
        h("p", "as-note", t("as.detail.privacyNote", "以上内容来自插件清单声明的能力，与安装时的授权记录一致。")),
    ]);

    // 顺序按参考图：简介 → 包含的应用 → 新功能 → 评分及评论 → App 隐私。
    // 「新功能」行要等日志读完，三块统一放进回调，避免异步把它挤到页面最底部。
    getPluginChangelog(e.id).catch(() => null).then((log) => {
        if (view !== "detail" || currentId !== e.id) return;
        const group = log ? latestGroup(log) : null;
        if (group) {
            box.appendChild(whatsNewBlock(t("as.detail.whatsNew", "新功能"), group, () => showPluginLog(e.id, e.name)));
        }
        box.appendChild(ratingBox);
        box.appendChild(privacyBox);
    });
}

function privacyCard(title, text) {
    const card = h("div", "as-pcard");
    card.appendChild(h("h4", null, title));
    card.appendChild(h("p", "none", text));
    return card;
}

/**
 * 「新功能」板块：箭头跟标题同一行（点击标题整行进日志），下方只放一行摘要。
 * 摘要里不再重复「新功能」字样，避免出现第二个入口。
 */
function whatsNewBlock(title, group, onOpen) {
    const block = h("section", "dblock as-wnblock");
    const head = h("button", "as-wnhead");
    head.type = "button";
    head.appendChild(h("span", "as-wnhead__title", title));
    head.appendChild(h("span", "as-wnhead__chevron", "›"));
    const right = h("span", "as-wnhead__meta");
    right.appendChild(h("span", "as-wnhead__ver", `${t("cl.version", "版本")} ${versionLabel(group.version)}`));
    right.appendChild(h("span", "as-wnhead__when", relativeTime(group.date)));
    head.appendChild(right);
    head.addEventListener("click", onOpen);
    block.appendChild(head);
    block.appendChild(h("p", "as-wnbody", summaryOf(group) || t("cl.empty", "暂无更新记录")));
    return block;
}

/* ───────────────────────── 更新日志 ───────────────────────── */

function showSystemLog() {
    closeLightbox();
    activeNavSync = null;
    view = "changelog";
    currentId = null;
    logTarget = { kind: "system" };
    setPane("changelog");
    $("back").hidden = false;
    renderNav();
    renderCats();
    setHeading(t("as.tabs.whatsNew", "新功能"), "");
    renderLog(logTarget);
}

function showPluginLog(id, name) {
    closeLightbox();
    activeNavSync = null;
    view = "changelog";
    currentId = id;
    logTarget = { kind: "plugin", id, name };
    setPane("changelog");
    $("back").hidden = false;
    renderNav();
    renderCats();
    setHeading(name, t("as.detail.whatsNew", "新功能"));
    renderLog(logTarget);
}

async function renderLog(target) {
    const box = $("changelog");
    box.innerHTML = "";
    box.appendChild(h("p", "empty", t("as.log.loading", "正在读取…")));

    const log = target.kind === "system"
        ? await getSystemChangelog()
        : await getPluginChangelog(target.id);

    // 异步返回时视图可能已经切走：再写就把别的内容盖掉了
    if (view !== "changelog" || !logTarget || logTarget.kind !== target.kind || logTarget.id !== target.id) return;

    box.innerHTML = "";
    if (!log) {
        box.appendChild(h("p", "empty", t("as.log.failed", "更新日志暂时无法读取")));
        return;
    }
    const groups = versionGroups(log);
    if (!groups.length) {
        box.appendChild(h("p", "empty", t("cl.empty", "暂无更新记录")));
        return;
    }
    groups.forEach((group) => box.appendChild(logBlock(group)));
}

const TYPE_LABELS = () => ({
    added: t("cl.type.added", "新增"),
    improved: t("cl.type.improved", "优化"),
    fixed: t("cl.type.fixed", "修复"),
});

function logBlock(group) {
    const block = h("section", "dblock");
    const head = h("header", "as-loghead");
    head.appendChild(h("h3", null, `${t("cl.version", "版本")} ${versionLabel(group.version)}`));
    head.appendChild(h("span", null, `${group.date} · ${relativeTime(group.date)}`));
    block.appendChild(head);

    const labels = TYPE_LABELS();
    group.types.forEach((bucket) => {
        block.appendChild(h("h4", "as-logtype", labels[bucket.type] || bucket.type));
        const ul = h("ul", "as-logitems");
        bucket.items.forEach((text) => ul.appendChild(h("li", null, text)));
        block.appendChild(ul);
    });
    return block;
}

/* ───────────────────────── 界面截图：翻页与大图 ───────────────────────── */

/**
 * 截图条：一条横向滚动带，配左右箭头 + 滚轮横滑 + 方向键，点任意一张开大图。
 * 230px 高的卡片在窄面板里一屏放不下两张，没有箭头时鼠标用户根本没法翻（触控板能横滑）。
 */
function shotsCarousel(entry) {
    const wrap = h("div", "shots-wrap");
    const row = h("div", "shots");
    row.tabIndex = 0;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "应用截图：滚轮或方向键翻页，点任意一张看大图");

    entry.screenshots.forEach((url, i) => {
        const fig = h("figure", "shot");
        const im = pic(url, `${entry.name} 截图 ${i + 1}`);
        im.loading = "lazy";
        im.addEventListener("load", () => sync());
        im.addEventListener("error", () => { fig.remove(); sync(); }, { once: true });
        fig.appendChild(im);
        fig.addEventListener("click", () => openLightbox(row, entry.name, fig));
        row.appendChild(fig);
    });

    const prev = h("button", "shots-nav shots-nav--prev", "‹");
    const next = h("button", "shots-nav shots-nav--next", "›");
    prev.type = "button";
    next.type = "button";
    prev.setAttribute("aria-label", "向前翻一页");
    next.setAttribute("aria-label", "向后翻一页");

    const maxScroll = () => row.scrollWidth - row.clientWidth;
    function sync() {
        const max = maxScroll();
        wrap.classList.toggle("has-nav", max > 2);
        prev.disabled = row.scrollLeft <= 1;
        next.disabled = row.scrollLeft >= max - 1;
    }
    const page = (dir) => row.scrollBy({ left: dir * Math.max(200, row.clientWidth * 0.86), behavior: "smooth" });
    prev.addEventListener("click", () => page(-1));
    next.addEventListener("click", () => page(1));
    row.addEventListener("scroll", () => requestAnimationFrame(sync));

    // 竖滚轮在这里改成横滑；到头 / 到底就放行，让详情页继续上下滚（不抢滚动）
    row.addEventListener("wheel", (ev) => {
        const max = maxScroll();
        if (max <= 2) return;
        const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
        if (!delta) return;
        if ((delta < 0 && row.scrollLeft <= 0) || (delta > 0 && row.scrollLeft >= max - 1)) return;
        ev.preventDefault();
        row.scrollLeft += delta;
    }, { passive: false });

    row.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        ev.preventDefault();
        page(ev.key === "ArrowLeft" ? -1 : 1);
    });

    wrap.append(prev, row, next);
    requestAnimationFrame(sync);
    activeNavSync = sync;
    return wrap;
}

let lightboxEl = null;
let lightboxKeys = null;

/** 大图查看：窗口内模态，Esc / 点背景 / 关闭键退出，←/→ 翻页。 */
function openLightbox(row, name, target) {
    const figs = [...row.querySelectorAll(".shot")];
    const urls = figs.map((f) => f.querySelector("img")).filter(Boolean).map((im) => im.src);
    if (!urls.length) return;
    let index = Math.max(0, figs.indexOf(target));

    closeLightbox();
    const overlay = h("div", "lightbox");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `${name} 截图`);
    overlay.tabIndex = -1;

    const stage = h("div", "lightbox__stage");
    const im = pic(urls[index], `${name} 截图 ${index + 1}`, "lightbox__img");
    stage.appendChild(im);

    const count = h("span", "lightbox__count", `${index + 1} / ${urls.length}`);
    const close = h("button", "lightbox__btn lightbox__close", "✕");
    const prev = h("button", "lightbox__btn lightbox__nav lightbox__nav--prev", "‹");
    const next = h("button", "lightbox__btn lightbox__nav lightbox__nav--next", "›");
    [close, prev, next].forEach((b) => { b.type = "button"; });
    close.setAttribute("aria-label", "关闭大图");
    prev.setAttribute("aria-label", "上一张");
    next.setAttribute("aria-label", "下一张");

    const go = (dir) => {
        index = (index + dir + urls.length) % urls.length;
        im.src = urls[index];
        im.alt = `${name} 截图 ${index + 1}`;
        count.textContent = `${index + 1} / ${urls.length}`;
    };
    prev.addEventListener("click", (ev) => { ev.stopPropagation(); go(-1); });
    next.addEventListener("click", (ev) => { ev.stopPropagation(); go(1); });
    close.addEventListener("click", closeLightbox);
    if (urls.length < 2) { prev.hidden = true; next.hidden = true; }

    overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay || ev.target === stage) closeLightbox();
    });
    // 键位挂在窗口上并走捕获：焦点跑到别处（比如点了图）也还能 Esc / 翻页
    lightboxKeys = (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeLightbox(); return; }
        if (ev.key === "ArrowLeft") { ev.preventDefault(); ev.stopPropagation(); go(-1); return; }
        if (ev.key === "ArrowRight") { ev.preventDefault(); ev.stopPropagation(); go(1); }
    };
    win.addEventListener("keydown", lightboxKeys, true);

    overlay.append(stage, count, prev, next, close);
    win.appendChild(overlay);
    lightboxEl = overlay;
    close.focus();
}

function closeLightbox() {
    if (lightboxKeys) { win.removeEventListener("keydown", lightboxKeys, true); lightboxKeys = null; }
    if (!lightboxEl) return;
    lightboxEl.remove();
    lightboxEl = null;
}

/* ───────────────────────── 安装记录 ───────────────────────── */

function renderHistory() {
    const box = $("detail");
    box.innerHTML = "";
    const list = history();
    setHeading(t("as.sidebar.history", "安装记录"), list.length ? `${list.length} ${t("as.count.entries", "条记录")}` : "");
    if (!list.length) {
        box.appendChild(h("p", "empty", "还没有安装过插件。把 .zip 拖到窗口里，或点右上角「安装 ZIP…」。"));
        return;
    }
    const table = h("div", "hist");
    list.forEach((r) => {
        const row = h("div", "hrow");
        row.appendChild(h("span", "hwhen", new Date(r.at).toLocaleString()));
        row.appendChild(h("span", "hwhat", `${r.name || r.id}${r.version ? ` v${r.version}` : ""}`));
        row.appendChild(h("span", "hkind", r.action === "uninstall" ? "已卸载" : r.replaced ? "已覆盖" : "已安装"));
        row.appendChild(h("span", "hsiz", r.bytes ? `${(r.bytes / 1024).toFixed(0)} KB` : ""));
        table.appendChild(row);
    });
    box.appendChild(table);
}

/* ───────────────────────── 动作 ───────────────────────── */

function dialog() { return window.__dialog || null; }

function status(text) {
    const bar = $("status");
    bar.textContent = text || "";
    bar.hidden = !text;
}

function openEntry(id) {
    const e = getEntry(id);
    if (!e) return;
    if (!e.enabled) {
        const d = dialog();
        if (d) d.alert("应用已禁用", `「${e.name}」处于禁用状态，先在详情页点「启用」。`);
        return;
    }
    openApp(id);
}

function enable(id, on) {
    const res = setEnabled(id, on);
    if (!res.ok) {
        const d = dialog();
        if (d) d.alert("操作未完成", res.reason);
        return;
    }
    status(on ? "已启用" : "已禁用 —— 启动台与程序坞里不再出现，仍可在系统设置或 App Store 中重新启用");
    refresh();
}

async function verify(id) {
    status("正在逐个回读清单声明的资源…");
    const r = await verifyInstall(id);
    status("");
    const d = dialog();
    const optional = r.optionalMissing && r.optionalMissing.length
        ? `\n详情图取不到（不影响使用）：\n${r.optionalMissing.join("\n")}`
        : "";
    if (r.ok) {
        if (d) d.alert("资源完整", "清单声明的入口、样式、脚本与图标都能从本地库取到。" + optional);
        return;
    }
    const lines = r.problems.map((p) => `${p.file} —— ${p.reason}`).join("\n");
    if (d) d.error("资源不完整", `有 ${r.problems.length} 项取不到：\n${lines}${optional}`);
}

async function doUninstall(id) {
    const e = getEntry(id);
    const prev = uninstallPreview(id) || { name: e ? e.name : id, files: 0, bytes: 0 };
    const d = dialog();
    if (d) {
        const detail = prev.bytes
            ? `将删除 ${prev.files} 个文件，约 ${(prev.bytes / 1024).toFixed(0)} KB。重新安装需要再次拖入安装包。`
            : "将注销这个插件。重新安装需要再次拖入安装包。";
        if (!(await d.confirm(`要卸载「${prev.name}」吗？`, detail, { danger: true, okText: "卸载", cancelText: "取消" }))) return;
    }
    status("正在卸载…");
    // 先关窗口再摘记录：关闭流程需要注册表还在（按 manifest 判断入口类型、拆外壳）
    closeWindowsOf(id);
    const r = await uninstall(id);
    if (!r.ok) {
        status("");
        if (d) d.error("卸载失败", r.reason);
        return;
    }
    showList();
    status(`已卸载 ${prev.name}${r.freed ? `，释放 ${(r.freed / 1024).toFixed(0)} KB` : ""}`);
}

/**
 * 卸载后收掉该插件还开着的窗口。
 * 必须走窗口自己的关闭流程（_closeWindow），而不是直接 remove：
 * 直接删 DOM 会让 appStatus 停在 true，程序坞留下「有小圆点没界面」的钉子户。
 * @param {string} id 插件 id
 */
function closeWindowsOf(id) {
    const esc = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(id) : id;
    document.querySelectorAll(`.window[data-plugin-id="${esc}"]`).forEach((w) => {
        if (typeof w._closeWindow === "function") w._closeWindow();
        else w.remove();
    });
}

/**
 * 安装一个 ZIP：解包 → 权限确认 → 落库 → 逐个回读校验，任一步失败都不留半成品。
 * 同 id 已安装时先问是否覆盖（带版本差异），再走同一套流程。
 */
async function install(file, overwrite) {
    const d = dialog();
    const at = (_stage, text) => status(text);
    let res = await installZip(file, { overwrite: !!overwrite, onProgress: at });

    if (!res.ok && res.reason === "already-installed") {
        status("");
        const id = (res.detail && res.detail.id) || "";
        const diff = versionDiff(id, (res.detail && res.detail.nextVersion) || "");
        const name = (res.detail && res.detail.name) || id;
        if (!d || !(await d.confirm(`已经安装过「${name}」`,
            `本地库里是 ${diff.current || "未知"}，这个包是 ${diff.next || "未知"}。覆盖安装会用新版本替换现有文件。`,
            { danger: true, okText: "覆盖安装" }))) {
            return;
        }
        res = await installZip(file, { overwrite: true, onProgress: at });
    }

    status("");
    if (res.ok) {
        showList();
        const shots = res.warnings && res.warnings.length ? `（详情图缺 ${res.warnings.length} 张，可在详情页「校验资源」查看）` : "";
        status(`已安装 ${res.name}（${(res.bytes / 1024).toFixed(0)} KB · ${res.fileCount} 个文件）${shots}`);
        renderSwStatus();
        return;
    }
    if (res.reason === "cancelled") {
        status("已取消安装（未授权）");
        return;
    }
    const extra = res.detail && Array.isArray(res.detail.problems)
        ? `\n${res.detail.problems.map((p) => `${p.file} —— ${p.reason}`).join("\n")}`
        : "";
    if (d) d.error("安装失败", `${res.reason}${extra}`);
    else status(`安装失败：${res.reason}`);
}

/* ───────────────────────── 拖放 ───────────────────────── */

function bindDrop() {
    const veil = $("veil");
    let depth = 0;
    const isZip = (f) => /\.zip$/i.test((f && f.name) || "");
    // 只认真正的 zip 名：dragover 阶段 files 在部分内核里拿不到名字，退回 items 的 type
    const hasZip = (dt) => Array.from((dt && dt.files) || []).some(isZip)
        || Array.from((dt && dt.items) || []).some((it) => it.kind === "file"
            && (/\.zip$/i.test(it.name || "") || it.type === "application/zip"));
    win.addEventListener("dragenter", (e) => {
        if (!hasZip(e.dataTransfer)) return;
        e.preventDefault();
        depth++;
        veil.hidden = false;
    });
    win.addEventListener("dragover", (e) => {
        if (!hasZip(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    win.addEventListener("dragleave", () => {
        depth = Math.max(0, depth - 1);
        if (!depth) veil.hidden = true;
    });
    win.addEventListener("drop", (e) => {
        e.preventDefault();
        depth = 0;
        veil.hidden = true;
        const zip = Array.from(e.dataTransfer.files || []).find((f) => /\.zip$/i.test(f.name || ""));
        if (zip) install(zip);
        else status("拖进来的不是 .zip 插件包");
    });
}

/* ───────────────────────── 键盘 ───────────────────────── */

function onKeynav(e) {
    if (lightboxEl) return;   // 大图打开时键盘归浮层自己处理
    if (e.key === "Escape") {
        if (view !== "today" && view !== "list") goBack();
        return;
    }
    if (view !== "list") return;
    const grid = $("grid");
    const cards = Array.from(grid.querySelectorAll(".card"));
    if (!cards.length) return;
    const at = cards.indexOf(document.activeElement);
    if (e.key === "Enter") {
        if (at >= 0) cards[at].click();
        return;
    }
    let step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 0, ArrowUp: 0 }[e.key];
    if (step === undefined) return;
    if (step === 0) {
        // 行跨度按实测列数算：网格是 auto-fill，列数随窗口宽度变，不能写死
        const per = Math.max(1, Math.round(grid.clientWidth / (cards[0].offsetWidth + 14)));
        step = e.key === "ArrowDown" ? per : -per;
    }
    e.preventDefault();
    const next = at < 0 ? 0 : Math.min(cards.length - 1, Math.max(0, at + step));
    cards[next].focus();
    cards[next].scrollIntoView({ block: "nearest" });
}

/* ───────────────────────── 顶栏菜单命令 ───────────────────────── */

// manifest.menus 里声明的命令靠这几个入口驱动（见 menuCommands.js：
// 命令只能是注册表键名 + 至多一个字符串实参，CSP 下不能求值任意代码）。
const MENU_KEYS = ["storeShowToday", "storeShowCategory", "storeShowHistory", "storeShowWhatsNew", "storePickZip", "storeVerifyCurrent"];
const menuCommands = {
    storeShowToday() { showToday(); },
    storeShowCategory(key) {
        categoryKey = key || "all";
        showList();
    },
    storeShowHistory() { showHistory(); },
    storeShowWhatsNew() { showSystemLog(); },
    storePickZip() { $("file").click(); },
    storeVerifyCurrent() {
        if (view === "detail" && currentId) { verify(currentId); return; }
        status("先打开某个应用的详情页，再校验它声明的资源");
    },
};
window.__menuActions = window.__menuActions || {};
MENU_KEYS.forEach((key) => { window.__menuActions[key] = menuCommands[key]; });

// 资源释放：卸载时摘掉挂在 window/document 上的监听（插件脚本重复注入会叠加监听）
const onAppStoreUnload = (e) => {
    if (e.detail.id !== "app-store") return;
    window.removeEventListener("plugin-unload", onAppStoreUnload);
    if (win._storeCleanup) win._storeCleanup();
    // 只摘自己注册的那份：重载后新脚本实例已经覆盖了同名键，误删会让菜单命令失踪
    MENU_KEYS.forEach((key) => {
        if (window.__menuActions && window.__menuActions[key] === menuCommands[key]) delete window.__menuActions[key];
    });
};
window.addEventListener("plugin-unload", onAppStoreUnload);

/* ───────────────────────── 启动 ─────────────────────────
   必须放在所有模块级状态与函数声明之后：init() 会给 view / categoryKey 等 `let` 赋值，
   早于声明执行会撞 TDZ（ReferenceError），整个商店界面就不会初始化。 */
if (!win) {
    console.warn("[app-store] 未找到窗口根元素，跳过初始化");
} else {
    init();
}
