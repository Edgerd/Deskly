/**
 * script.js — 聚焦（Spotlight）：系统级统一搜索，独立系统应用
 *
 * 形态：manifest.entry = "background" 的系统应用（启动台/设置/访达不显示，不可卸载，
 * 由 app-registry 的可见性 API 声明）；本脚本由内核适配层 src/javascripts/spotlight.js
 * 在引导空闲期点亮，插件管理器只为它登记清单，不做窗口注入。
 *
 * 组成：
 * - 提供者宿主：内置 providers（应用/设置/文件/命令/书签/手册/日期）+ 插件 providers
 *   （manifest.spotlightProviders 声明，首次查询时惰性 import，计算器是第一个）；
 * - 查询引擎（engine.js）：异步、AbortSignal 取消、逐 provider 错误隔离、分组排序；
 * - 面板：⌥Space（默认，可改）呼出、输入即搜（60ms 防抖 + 取消）、↑↓/Tab 选择、
 *   回车执行（copyText 优先复制）、Esc/点外部关闭、分组小标题、结果分块渲染（虚拟列表）、
 *   呼出/关闭动画走项目非线性曲线并遵守「减少动态效果」。
 *
 * 索引纪律：不开机全量构建 —— 每类索引首次被命中才建（index.js），
 * 插件装卸/设置变更/语言切换经事件广播触发对应失效，文件目录走 30s TTL。
 */

import { settings } from "../../src/javascripts/settings.js";
import { i18n } from "../../src/javascripts/i18n.js";
import { Z } from "../../src/javascripts/zindex.js";
import { glyph, modFile } from "../../src/javascripts/paths.js";
import { setShortcutText } from "../../src/javascripts/keyboard.js";
import {
    registerSpotlightProvider, unregisterSpotlightProvider, listSpotlightProviders,
    runSpotlightQuery, invalidateProviders, GROUPS,
} from "./engine.js";
import { appsProvider } from "./providers/apps.js";
import { settingsProvider } from "./providers/settings.js";
import { filesProvider } from "./providers/files.js";
import { commandsProvider } from "./providers/commands.js";
import { bookmarksProvider } from "./providers/bookmarks.js";
import { manualProvider } from "./providers/manual.js";
import { datetimeProvider } from "./providers/datetime.js";
import { webSearchFallback } from "./providers/websearch.js";

/* ───────────────────────── 四语文案 ───────────────────────── */

const MESSAGES = {
    "zh-CN": {
        spotlight: {
            placeholder: "搜索应用、设置、文件与命令", emptyHint: "输入以开始搜索", noResults: "无匹配结果",
            resultsCount: "条结果", historyTitle: "最近搜索", historyEmpty: "最近搜索：还没有记录", historyClear: "清除",
            openHint: "回车打开", runHint: "回车执行", copyHint: "回车复制", gotoHint: "回车前往",
            revealHint: "回车在访达中打开", openBrowserHint: "回车在浏览器打开", openPaneHint: "回车打开面板",
            appKind: "应用程序", subApp: "子应用", recentApp: "最近使用",
            settingsKind: "设置", paneKind: "设置面板", paneSuffix: "面板",
            calcSub: "计算", convertSub: "单位换算", currencySub: "货币换算", rateDate: "汇率快照",
            dateSub: "日期换算", websearchLabel: "搜索网页", manualHint: "手册",
            group: {
                calculation: "计算", app: "应用程序", command: "系统命令", setting: "系统设置",
                file: "文件", bookmark: "书签", manual: "使用手册", websearch: "网页", other: "其他",
            },
        },
    },
    "en": {
        spotlight: {
            placeholder: "Search apps, settings, files & commands", emptyHint: "Type to search", noResults: "No Results",
            resultsCount: "results", historyTitle: "Recent Searches", historyEmpty: "No recent searches", historyClear: "Clear",
            openHint: "Return to open", runHint: "Return to run", copyHint: "Return to copy", gotoHint: "Return to go",
            revealHint: "Return to reveal in Finder", openBrowserHint: "Return to open in browser", openPaneHint: "Return to open pane",
            appKind: "Application", subApp: "Sub-app", recentApp: "Recently Used",
            settingsKind: "Settings", paneKind: "Settings Pane", paneSuffix: " pane",
            calcSub: "Calculation", convertSub: "Unit Conversion", currencySub: "Currency", rateDate: "Rates snapshot",
            dateSub: "Date", websearchLabel: "Search the Web", manualHint: "User Guide",
            group: {
                calculation: "Calculation", app: "Applications", command: "System Commands", setting: "System Settings",
                file: "Files", bookmark: "Bookmarks", manual: "User Guide", websearch: "Web", other: "Other",
            },
        },
    },
    "ja-JP": {
        spotlight: {
            placeholder: "アプリ・設定・ファイル・コマンドを検索", emptyHint: "入力して検索", noResults: "結果なし",
            resultsCount: "件の結果", historyTitle: "最近の検索", historyEmpty: "最近の検索はありません", historyClear: "消去",
            openHint: "Return で開く", runHint: "Return で実行", copyHint: "Return でコピー", gotoHint: "Return で移動",
            revealHint: "Return で Finder に表示", openBrowserHint: "Return でブラウザを開く", openPaneHint: "Return でパネルを開く",
            appKind: "アプリケーション", subApp: "サブアプリ", recentApp: "最近使用",
            settingsKind: "設定", paneKind: "設定パネル", paneSuffix: "パネル",
            calcSub: "計算", convertSub: "単位換算", currencySub: "通貨換算", rateDate: "レートスナップショット",
            dateSub: "日付換算", websearchLabel: "Web を検索", manualHint: "ユーザガイド",
            group: {
                calculation: "計算", app: "アプリケーション", command: "システムコマンド", setting: "システム設定",
                file: "ファイル", bookmark: "ブックマーク", manual: "ユーザガイド", websearch: "Web", other: "その他",
            },
        },
    },
    "cat": {
        spotlight: {
            placeholder: "搜应用、设置、文件同命令喵", emptyHint: "打两个字先喵", noResults: "什么都搜不到喵",
            resultsCount: "条结果喵", historyTitle: "最近搜过", historyEmpty: "还没搜过任何东西喵", historyClear: "清空喵",
            openHint: "回车打开喵", runHint: "回车执行喵", copyHint: "回车复制喵", gotoHint: "回车前往喵",
            revealHint: "回车去访达喵", openBrowserHint: "回车开浏览器喵", openPaneHint: "回车开面板喵",
            appKind: "应用程序喵", subApp: "子应用喵", recentApp: "最近用过喵",
            settingsKind: "设置", paneKind: "设置面板", paneSuffix: "面板喵",
            calcSub: "算数喵", convertSub: "单位换算喵", currencySub: "钱币换算喵", rateDate: "汇率快照",
            dateSub: "日期换算喵", websearchLabel: "去网页搜喵", manualHint: "说明书喵",
            group: {
                calculation: "计算喵", app: "应用程序", command: "系统命令", setting: "系统设置",
                file: "文件", bookmark: "书签", manual: "使用手册", websearch: "网页", other: "其他",
            },
        },
    },
};

if (typeof i18n.registerMessagesAll === "function") i18n.registerMessagesAll(MESSAGES);

/** 面板文案快捷取值。 */
function t(key, fallback) {
    return i18n.t(key, fallback);
}

/* ───────────────────────── 设置项 ───────────────────────── */

/** 搜索历史槽与上限。 */
const HISTORY_SLOT = "deskly-spotlight-history";
const HISTORY_MAX = 10;

/** 快捷键候选（与设置项 values 一致；顺序即设置下拉的顺序）。 */
const HOTKEYS = ["alt+space", "ctrl+shift+space", "ctrl+meta+space", "cmd+space", "ctrl+space", "off"];

/**
 * 唤起键 → 修饰键要求。
 * 默认 ⌥Space：⌘Space（macOS 聚焦 / Windows 输入法）与 ⌃Space（CJK 输入法切换 / macOS
 * 输入源）在两大平台都被系统先抢走，页面根本收不到；⌥Space 在 macOS 产生的是
 * U+00A0（经 event.code 判定），在 Windows 可被 preventDefault 拦住系统菜单。
 */
const HOTKEY_MAP = {
    "alt+space": { alt: true },
    "ctrl+shift+space": { ctrl: true, shift: true },
    "ctrl+meta+space": { ctrl: true, meta: true },
    "cmd+space": { meta: true },
    "ctrl+space": { ctrl: true },
};

/** 设置里显示的键位字形（跨语言中立的记号写法）。 */
const HOTKEY_LABELS = {
    "alt+space": "⌥Space",
    "ctrl+shift+space": "⌃⇧Space",
    "ctrl+meta+space": "⌃⌘Space",
    "cmd+space": "⌘Space",
    "ctrl+space": "⌃Space",
    "off": "—",
};

/** 注册本应用托管的设置项（其余 spotlight.* 由定义表声明；新开关等设置 UI 放行后呈现）。 */
function defineSchema() {
    settings.define({
        key: "spotlight.hotkey", type: "string", default: "alt+space",
        values: HOTKEYS,
        valuesLabel: HOTKEYS.map((key) => HOTKEY_LABELS[key] || key),
        control: "dropdown", pane: "spotlight", group: "聚焦", order: 5,
        label: "打开快捷键",
    });
    settings.define({
        key: "spotlight.bookmarks", type: "boolean", default: true,
        control: "switch", pane: "spotlight", group: "搜索范围", order: 46,
        label: "浏览器书签",
    });
    settings.define({
        key: "spotlight.datetime", type: "boolean", default: true,
        control: "switch", pane: "spotlight", group: "搜索范围", order: 47,
        label: "日期换算",
    });
    settings.define({
        key: "spotlight.convert", type: "boolean", default: true,
        control: "switch", pane: "spotlight", group: "搜索范围", order: 48,
        label: "计算与换算",
    });
    settings.define({
        key: "spotlight.websearch", type: "boolean", default: true,
        control: "switch", pane: "spotlight", group: "搜索范围", order: 49,
        label: "网页搜索回退",
    });
}

/** 来源开关（未注册/未设置时按开启处理）。 */
function enabled(key) {
    const value = settings.get(key);
    return value === undefined || value === null ? true : Boolean(value);
}

/** 结果总数上限。 */
function maxResults() {
    const value = Number(settings.get("spotlight.maxResults"));
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 12;
}

/* ───────────────────────── 提供者宿主 ───────────────────────── */

/** 内置 provider → 设置开关键（保持旧的五个开关键位不变；新类型走新键）。 */
const BUILTIN_GATES = {
    apps: "spotlight.apps",
    settings: "spotlight.settings",
    files: "spotlight.files",
    commands: "spotlight.commands",
    manual: "spotlight.manual",
    bookmarks: "spotlight.bookmarks",
    datetime: "spotlight.datetime",
    calculator: "spotlight.convert",
};

/**
 * provider 的开关键：内置映射优先，插件 provider 用 spotlight.provider.<id>
 * （设置 UI 落地前这些键只有数据与 API，默认全开）。
 */
function gateKeyFor(providerId) {
    return BUILTIN_GATES[providerId] || `spotlight.provider.${providerId}`;
}

/** 当前查询允许哪些 provider 上场。 */
function enabledProviderIds() {
    const only = new Set();
    for (const info of listSpotlightProviders()) {
        if (enabled(gateKeyFor(info.id))) only.add(info.id);
    }
    return only;
}

/** 已加载的插件 provider：插件 id -> 注销函数数组（插件卸载时摘干净）。 */
const loadedPluginProviders = new Map();

/** 插件资源名的合法形态（与 plugin-manager 同一套，防越界读取）。 */
const SAFE_PROVIDER_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/**
 * 装载一个插件声明的全部聚焦 provider。幂等：同一插件重复调用直接跳过。
 * @param {object} manifest 插件清单
 * @returns {Promise<void>}
 */
async function loadPluginProviders(manifest) {
    if (!manifest || !manifest.id || loadedPluginProviders.has(manifest.id)) return;
    const files = Array.isArray(manifest.spotlightProviders) ? manifest.spotlightProviders : [];
    if (!files.length) return;
    loadedPluginProviders.set(manifest.id, []);
    const unsubs = loadedPluginProviders.get(manifest.id);
    for (const file of files) {
        const name = String(file).replace(/^\.\//, "");
        if (!SAFE_PROVIDER_FILE.test(name) || name.includes("..")) {
            console.warn(`[spotlight] 插件 ${manifest.id} 的 provider 资源名不合法，已跳过：${file}`);
            continue;
        }
        try {
            // 动态 import 按**本模块**的 URL 解析：mods/spotlight/ → 站根 mods/<id>/<file>。
            // （已安装 ZIP 插件的同形 URL 由 Service Worker 从 IndexedDB 回源。）
            const mod = await import(`../../mods/${manifest.id}/${name}`);
            const provider = mod.provider || mod.default;
            if (!provider || typeof provider.search !== "function") {
                console.warn(`[spotlight] 插件 ${manifest.id} 的 ${name} 未导出 provider`);
                continue;
            }
            unsubs.push(registerSpotlightProvider(provider, { source: manifest.id }));
        } catch (err) {
            console.warn(`[spotlight] 加载插件 ${manifest.id} 的 provider 失败（${name}）：`, err);
        }
    }
}

/** 卸下插件的全部 provider（插件注销时调用）。 */
function unloadPluginProviders(id) {
    const unsubs = loadedPluginProviders.get(id) || [];
    unsubs.forEach((fn) => fn());
    loadedPluginProviders.delete(id);
}

/** 首次需要时扫描注册表，装载各插件声明的 provider（共享 Promise，只扫一次）。 */
let discoveryPromise = null;
function discoverPluginProviders() {
    if (!discoveryPromise) {
        discoveryPromise = (async () => {
            const { getPlugins, whenReady } = await import("../../src/javascripts/app-registry.js");
            await whenReady();
            for (const manifest of getPlugins()) {
                await loadPluginProviders(manifest);
            }
        })().catch((err) => console.warn("[spotlight] 插件 provider 发现失败：", err));
    }
    return discoveryPromise;
}

/** 新插件注册后补装它的 provider（不再等整表）。 */
function onPluginRegistered(event) {
    invalidateProviders("plugin-registered");
    loadPluginProviders(event && event.detail).catch(() => {});
}

function onPluginUnregistered(event) {
    invalidateProviders("plugin-unregistered");
    if (event && event.detail && event.detail.id) unloadPluginProviders(event.detail.id);
}

/* ───────────────────────── 搜索历史 ───────────────────────── */

function readHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_SLOT) || "[]");
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, HISTORY_MAX) : [];
    } catch {
        return [];
    }
}

/** 纯数字与超长文本不入库（误触与粘贴板内容）。 */
function storable(query) {
    const text = String(query || "").trim();
    if (!text || text.length > 40) return false;
    return !/^\d[\d\s.,-]*$/.test(text);
}

function recordHistory(query) {
    const text = String(query || "").trim();
    if (!enabled("spotlight.keepHistory") || !storable(text)) return readHistory();
    const next = [text, ...readHistory().filter((item) => item !== text)].slice(0, HISTORY_MAX);
    try {
        localStorage.setItem(HISTORY_SLOT, JSON.stringify(next));
    } catch { /* 配额满：历史丢掉即可 */ }
    return next;
}

function clearHistory() {
    try { localStorage.removeItem(HISTORY_SLOT); } catch { /* 忽略 */ }
    if (ui.open) renderHistory();
}

/* ───────────────────────── 面板 ───────────────────────── */

/** 结果分块渲染：首块行数（滚动到底再追加），结果多时不一次性渲染全部。 */
const RENDER_CHUNK = 14;

const ui = {
    root: null,
    panel: null,
    input: null,
    listEl: null,
    emptyEl: null,
    historyEl: null,
    badge: null,
    items: [],
    renderedCount: 0,
    active: -1,
    token: 0,
    open: false,
    closing: false,
    restoreFocus: null,
    detach: null,
    observer: null,
    abort: null,
};

function reduceMotion() {
    return document.documentElement.dataset.reduceMotion === "on";
}

/** 建一个纯文本节点。 */
function textNode(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
}

/** 取（或建）面板根节点。 */
function ensureRoot() {
    if (ui.root && ui.root.isConnected) return ui.root;
    const backdrop = document.createElement("div");
    backdrop.id = "deskly-spotlight-backdrop";
    backdrop.className = "spotlight-backdrop os-overlay";
    backdrop.style.zIndex = String(Z.SPOTLIGHT);
    backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) closeSpotlight();
    });

    const panel = document.createElement("div");
    panel.id = "deskly-spotlight";
    panel.className = "spotlight-panel os-overlay";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("spotlight.placeholder", "聚焦搜索"));
    // 面板是主题化亚克力表面：局部文字令牌按它自己的底色算，深浅主题都能取对墨色
    globalThis.__surface?.apply?.(panel, { role: 3 });

    const head = document.createElement("div");
    head.className = "spotlight-head";
    const mark = document.createElement("img");
    mark.src = glyph("magnifyingglass");
    mark.alt = "";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "spotlight-input";
    input.id = "deskly-spotlight-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("spotlight.placeholder", "搜索应用、设置、文件与命令");
    input.setAttribute("aria-label", t("spotlight.placeholder", "搜索"));
    const badge = textNode("span", "", "spotlight-badge");
    badge.id = "deskly-spotlight-count";
    head.append(mark, input, badge);

    const listEl = document.createElement("div");
    listEl.id = "deskly-spotlight-results";
    listEl.className = "spotlight-results";
    listEl.setAttribute("role", "listbox");

    const emptyEl = textNode("div", t("spotlight.emptyHint", "输入以开始搜索"), "spotlight-empty");
    const historyEl = document.createElement("div");
    historyEl.id = "deskly-spotlight-history";
    historyEl.className = "spotlight-history";

    panel.append(head, listEl, emptyEl, historyEl);
    backdrop.appendChild(panel);

    ui.root = backdrop;
    ui.panel = panel;
    ui.input = input;
    ui.listEl = listEl;
    ui.emptyEl = emptyEl;
    ui.historyEl = historyEl;
    ui.badge = badge;

    input.addEventListener("input", () => scheduleSearch(input.value));
    input.addEventListener("keydown", onInputKeydown);
    return backdrop;
}

/** 历史标签行：只在没有输入时显示。 */
function renderHistory() {
    if (!ui.historyEl) return;
    ui.historyEl.textContent = "";
    const onEmpty = !String(ui.input?.value || "").trim();
    const show = onEmpty && enabled("spotlight.keepHistory");
    ui.historyEl.style.display = show ? "flex" : "none";
    if (!show) return;
    const items = readHistory();
    if (!items.length) {
        ui.historyEl.appendChild(textNode("span", t("spotlight.historyEmpty", "最近搜索：还没有记录"), "history-title"));
        return;
    }
    ui.historyEl.appendChild(textNode("span", t("spotlight.historyTitle", "最近搜索"), "history-title"));
    items.forEach((query) => {
        const chip = textNode("button", query, "history-chip");
        chip.type = "button";
        chip.addEventListener("click", () => {
            if (ui.input) {
                ui.input.value = query;
                scheduleSearch(query);
                ui.input.focus();
            }
        });
        ui.historyEl.appendChild(chip);
    });
    const clear = textNode("button", t("spotlight.historyClear", "清除"), "history-clear");
    clear.type = "button";
    clear.addEventListener("click", clearHistory);
    ui.historyEl.appendChild(clear);
}

/** 画一行结果（全部 textContent，绝不拼 HTML）。 */
function renderRow(item, index) {
    const row = document.createElement("div");
    row.className = "spotlight-row";
    row.setAttribute("role", "option");
    row.dataset.index = String(index);
    if (item.icon) {
        const img = document.createElement("img");
        img.src = item.icon;
        img.alt = "";
        row.appendChild(img);
    }
    const body = document.createElement("div");
    body.className = "row-body";
    body.appendChild(textNode("div", item.label, "row-label"));
    if (item.sub) body.appendChild(textNode("div", item.sub, "row-sub"));
    row.appendChild(body);
    if (item.hint) row.appendChild(textNode("span", item.hint, "row-hint"));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("mouseenter", () => setActive(index));
    row.addEventListener("click", () => runItem(item));
    return row;
}

/**
 * 渲染一「块」结果（虚拟列表）：从 startAt 起追加至多 RENDER_CHUNK 行，
 * 组边界处先插分组小标题。滚动触底时由 IntersectionObserver 调下一块。
 */
function renderChunk(startAt) {
    const end = Math.min(startAt + RENDER_CHUNK, ui.items.length);
    const multiGroup = new Set(ui.items.map((item) => item.group)).size > 1;
    let lastGroup = startAt > 0 ? ui.items[startAt - 1].group : null;
    for (let index = startAt; index < end; index += 1) {
        const item = ui.items[index];
        if (multiGroup && item.group !== lastGroup) {
            const meta = GROUPS[item.group] || GROUPS.other;
            ui.listEl.appendChild(textNode("div", t(`spotlight.group.${item.group}`, meta.label), "spotlight-group-header"));
            lastGroup = item.group;
        }
        ui.listEl.appendChild(renderRow(item, index));
    }
    ui.renderedCount = end;
    // 还有未渲染的行：放哨兵行，进入视口再渲染下一块
    if (end < ui.items.length) {
        const sentinel = document.createElement("div");
        sentinel.className = "spotlight-sentinel";
        ui.listEl.appendChild(sentinel);
        ui.observer?.observe(sentinel);
    }
}

/** 全量重渲染（重置滚动与分块进度）。 */
function renderResults(items) {
    if (!ui.listEl) return;
    ui.observer?.disconnect();
    ui.items = items;
    ui.renderedCount = 0;
    ui.listEl.textContent = "";
    const total = items.length;
    const query = String(ui.input?.value || "").trim();
    if (ui.badge) ui.badge.textContent = total ? `${total} ${t("spotlight.resultsCount", "条结果")}` : "";
    ui.emptyEl.textContent = t("spotlight.noResults", "无匹配结果");
    ui.emptyEl.style.display = query && !total ? "block" : "none";
    renderChunk(0);
    setActive(total ? 0 : -1);
}

/** 高亮第 index 行并滚动到可视区（行未渲染时先补渲染一块）。 */
function setActive(index) {
    if (index >= ui.renderedCount && ui.renderedCount < ui.items.length) renderChunk(ui.renderedCount);
    ui.active = index;
    const rows = ui.listEl?.querySelectorAll(".spotlight-row") || [];
    rows.forEach((row) => {
        const on = Number(row.dataset.index) === index;
        row.classList.toggle("is-active", on);
        if (on) row.setAttribute("aria-selected", "true");
        else row.removeAttribute("aria-selected");
    });
    const row = [...rows].find((el) => Number(el.dataset.index) === index);
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
}

/** 执行一条结果：copyText 优先复制；action 次之；先记历史再关面板。 */
function runItem(item) {
    if (!item) return;
    const query = String(ui.input?.value || "").trim();
    if (query) recordHistory(query);
    closeSpotlight();
    try {
        if (item.copyText && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(String(item.copyText)).catch(() => {});
        }
        if (!item.copyText && typeof item.action === "function") {
            const result = item.action();
            if (result && typeof result.catch === "function") result.catch(() => { /* 打开失败由被调用方记日志 */ });
        }
    } catch { /* 单条结果的失败不该影响搜索本身 */ }
}

/** 键盘：上下选择、回车执行、Esc 关闭。 */
function onInputKeydown(event) {
    const count = ui.items.length;
    if (event.key === "Escape") {
        event.preventDefault();
        closeSpotlight();
        return;
    }
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        if (count) setActive((ui.active + 1) % count);
        return;
    }
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault();
        if (count) setActive((ui.active - 1 + count) % count);
        return;
    }
    if (event.key === "Enter") {
        event.preventDefault();
        runItem(ui.items[Math.max(0, ui.active)]);
    }
}

/* ───────────────────────── 查询流 ───────────────────────── */

let searchTimer = null;

/**
 * 一次搜索：防抖 60ms + AbortController 作废上一查询 + 流式部分结果。
 * 本地结果为空且开了网页回退时，追加「搜索网页」行（不联网，只拼 URL）。
 */
function scheduleSearch(query) {
    const token = ++ui.token;
    renderHistory();
    if (searchTimer) clearTimeout(searchTimer);
    if (ui.abort) { ui.abort.abort(); ui.abort = null; }
    if (!String(query || "").trim()) {
        renderResults([]);
        return;
    }
    searchTimer = setTimeout(async () => {
        ui.abort = new AbortController();
        const signal = ui.abort.signal;
        await discoverPluginProviders();
        if (token !== ui.token || !ui.open || signal.aborted) return;
        let outcome;
        try {
            outcome = await runSpotlightQuery(query, {
                signal,
                limit: 6,
                only: enabledProviderIds(),
                onPartial: (items) => {
                    if (token === ui.token && ui.open && !signal.aborted) {
                        renderResults(items.slice(0, maxResults()));
                    }
                },
            });
        } catch {
            outcome = { results: [], failures: [] };
        }
        if (token !== ui.token || !ui.open || signal.aborted) return;
        let items = outcome.results || [];
        if (!items.length && enabled("spotlight.websearch")) {
            const fallback = webSearchFallback(query);
            if (fallback) items = [fallback];
        }
        renderResults(items.slice(0, maxResults()));
    }, 60);
}

/**
 * 搜索（供外部调用与探针）：不问界面状态，直接跑引擎。
 * @param {string} query 查询文本
 * @returns {Promise<Array<object>>} 结果数组
 */
async function searchAll(query) {
    await discoverPluginProviders();
    const outcome = await runSpotlightQuery(query, { limit: 6, only: enabledProviderIds() });
    let items = outcome.results || [];
    if (!items.length && enabled("spotlight.websearch")) {
        const fallback = webSearchFallback(query);
        if (fallback) items = [fallback];
    }
    return items.slice(0, maxResults());
}

/* ───────────────────────── 开合 ───────────────────────── */

/**
 * 打开聚焦。
 * @param {string} [prefill] 预填查询文本
 * @returns {boolean} 是否已打开
 */
function openSpotlight(prefill = "") {
    if (ui.open) {
        if (ui.input) {
            ui.input.value = String(prefill || "");
            ui.input.focus();
            scheduleSearch(ui.input.value);
        }
        return true;
    }
    const root = ensureRoot();
    ui.restoreFocus = document.activeElement;
    document.body.appendChild(root);
    ui.open = true;
    ui.closing = false;
    // 打开动画：非线性曲线；减少动态效果时只淡入
    root.classList.toggle("reduce-motion", reduceMotion());
    requestAnimationFrame(() => root.classList.add("is-open"));
    ui.input.value = String(prefill || "");
    renderResults([]);
    renderHistory();
    ui.input.focus();
    const onDocKey = (event) => { if (event.key === "Escape") closeSpotlight(); };
    document.addEventListener("keydown", onDocKey, true);
    ui.detach = () => document.removeEventListener("keydown", onDocKey, true);
    window.__log?.debug("plugin/spotlight", "聚焦已打开");
    return true;
}

/**
 * 关闭聚焦：反向动画，transitionend 后移除 DOM（无动画环境立即移除）。
 * @returns {boolean} 是否从打开态被关闭
 */
function closeSpotlight() {
    if (!ui.open || ui.closing) return false;
    ui.closing = true;
    ui.detach?.();
    ui.detach = null;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    if (ui.abort) { ui.abort.abort(); ui.abort = null; }
    ui.token += 1;
    const root = ui.root;
    const finish = () => {
        root?.remove();
        ui.closing = false;
    };
    if (root && !reduceMotion()) {
        root.classList.remove("is-open");
        root.addEventListener("transitionend", finish, { once: true });
        setTimeout(finish, 240); // 兜底：transitionend 丢失也不留残层
    } else {
        finish();
    }
    ui.open = false;
    ui.items = [];
    ui.active = -1;
    const focus = ui.restoreFocus;
    ui.restoreFocus = null;
    if (focus && typeof focus.focus === "function" && focus.isConnected) {
        try { focus.focus(); } catch { /* 原焦点元素已消失 */ }
    }
    return true;
}

/**
 * 切换聚焦。
 * @returns {boolean} 切换后是否处于打开态
 */
function toggleSpotlight() {
    if (ui.open) {
        closeSpotlight();
        return false;
    }
    return openSpotlight();
}

/* ───────────────────────── 快捷键 ───────────────────────── */

/** 事件是否命中给定的快捷键描述。修饰键四枚严格相等；空格本体兼容 nbsp/Spacebar/code。 */
function hotkeyMatches(spec, event) {
    if (!spec || spec === "off" || event.repeat) return false;
    const want = HOTKEY_MAP[spec];
    if (!want) return false;
    const isSpace = event.key === " " || event.key === "Spacebar" || event.key === " " || event.code === "Space";
    if (!isSpace) return false;
    return Boolean(want.meta) === Boolean(event.metaKey)
        && Boolean(want.ctrl) === Boolean(event.ctrlKey)
        && Boolean(want.alt) === Boolean(event.altKey)
        && Boolean(want.shift) === Boolean(event.shiftKey);
}

/** 当前生效的快捷键（设置缺失时走默认 ⌥Space）。 */
function currentHotkey() {
    return settings.get("spotlight.hotkey") || "alt+space";
}

/** document 级快捷键入口。 */
function onHotkey(event) {
    // F4：手册里的「聚焦」键，无修饰键时归聚焦（启动台改用 ⌃↓，见 keyboard.js 键位表）
    const plainF4 = event.key === "F4"
        && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat;
    if (!plainF4 && !hotkeyMatches(currentHotkey(), event)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSpotlight();
}

/** 顶栏图标：finderbar 的注册函数由它自己的模块提供，取不到就安静跳过。 */
async function mountMenuBarIcon() {
    try {
        const mod = await import("../../src/javascripts/finderbar.js");
        mod.registerFinderbarIcon?.({
            id: "spotlight",
            icon: glyph("magnifyingglass"),
            order: 30,
            onClick: () => toggleSpotlight(),
        });
    } catch { /* finderbar 尚未提供该导出：顶栏图标是加分项 */ }
}

/* ───────────────────────── 初始化 ───────────────────────── */

let initialized = false;

/** 注入本应用的独立样式表（背景型系统应用：插件管理器不做窗口注入，样式自己挂）。 */
function ensureStylesheet() {
    if (document.getElementById("plugin-style-spotlight")) return;
    const link = document.createElement("link");
    link.id = "plugin-style-spotlight";
    link.rel = "stylesheet";
    link.href = modFile("spotlight", "style.css");
    document.head.appendChild(link);
}

/**
 * 初始化聚焦：注册内置 providers、绑定快捷键、挂顶栏图标、接失效事件。
 * @returns {boolean} 是否完成初始化（重复调用幂等）
 */
function initSpotlight() {
    if (initialized) return true;
    initialized = true;

    ensureStylesheet();
    // 内置 providers（注册即生效；插件 providers 在首次查询时惰性发现）
    registerSpotlightProvider(appsProvider);
    registerSpotlightProvider(settingsProvider);
    registerSpotlightProvider(commandsProvider);
    registerSpotlightProvider(filesProvider);
    registerSpotlightProvider(manualProvider);
    registerSpotlightProvider(bookmarksProvider);
    registerSpotlightProvider(datetimeProvider);

    // 快捷键 + 总表动态文本（用户改绑后设置 › 键盘的显示不撒谎）
    document.addEventListener("keydown", onHotkey, true);
    setShortcutText("spotlight", () => `${HOTKEY_LABELS[currentHotkey()] || currentHotkey()} / F4`);

    // 失效事件：插件装卸触发索引失效与 provider 装卸；设置与语言变化刷新惰性索引
    document.addEventListener("plugin-registered", onPluginRegistered);
    document.addEventListener("plugin-unregistered", onPluginUnregistered);
    document.addEventListener("plugin-enabled-change", () => invalidateProviders("plugin-enabled-change"));
    document.addEventListener("settings-changed", () => invalidateProviders("settings-changed"));
    document.addEventListener("languagechange", () => {
        invalidateProviders("languagechange");
        if (ui.open && ui.input) {
            ui.input.placeholder = t("spotlight.placeholder", "搜索应用、设置、文件与命令");
            scheduleSearch(ui.input.value);
        }
    });

    mountMenuBarIcon();
    window.__log?.info("plugin/spotlight",
        `聚焦就绪：快捷键 ${HOTKEY_LABELS[currentHotkey()] || currentHotkey()}`);
    return true;
}

defineSchema();

globalThis.__spotlight = {
    open: openSpotlight,
    close: closeSpotlight,
    toggle: toggleSpotlight,
    search: searchAll,
    history: readHistory,
    clearHistory,
    registerProvider: (provider) => registerSpotlightProvider(provider, { source: "external" }),
    unregisterProvider: unregisterSpotlightProvider,
    listProviders: listSpotlightProviders,
    /** 当前是否处于打开态（只读） */
    get isOpen() { return ui.open; },
};

export {
    openSpotlight, closeSpotlight, toggleSpotlight, searchAll, initSpotlight,
    readHistory, recordHistory, clearHistory, HOTKEYS, hotkeyMatches,
};
