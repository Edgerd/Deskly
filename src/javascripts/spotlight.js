/**
 * spotlight.js — 聚焦搜索：系统级统一检索面板（⌃/⌥ + Space）
 *
 * 系统设置里「聚焦」与「搜索」两个面板长期是占位页，而整个桌面确实缺一个
 * 「不记得东西在哪就问一句」的入口。本模块把这件事做成真的：一次输入同时问四类来源
 * （全部按 `spotlight.*` 的开关逐个门控，结果合并后按「精确 > 前缀 > 包含 > 副标题」排序）：
 *
 * - **应用**：`listApps()`（app-registry，插件与其子应用都在内），按 name / windowName /
 *   id / appId 取子串，回车经 plugin-manager 的 `openApp()` 打开。
 * - **设置**：`settings.list()` 的 label / key / hint / group —— 刻意**不 import 系统设置插件**
 *   （面板清单是插件的私有物，内核反向依赖插件会形成环），命中项按 `pane` 归并出
 *   「设置面板」结果，面板名由本模块自带的一张中文名表给出。
 *   跳转 = 先 `openApp("系统设置")` 再向 document 派发 `system-settings-open-pane`。
 * - **文件**：`VFS.getRecentFiles()` + 逐个顶层目录的 `VFS.list()`（根目录始终存在，
 *   不再按授权状态清空；`AppData` 属插件内部目录，不参与搜索）。
 *   结果 = 打开访达并派发 `finder-command` navigate。
 * - **命令**：取自 `globalThis.__menuActions` 里**确实存在**的函数名（菜单命令即注册表键名），
 *   配一张中文标签表；绝不 eval、绝不 new Function。
 *
 * 搜索历史只在 `spotlight.keepHistory` 为真时落到 `deskly-spotlight-history` 槽，
 * 上限 10 条，纯数字与超过 40 字的查询不入库（前者多是误触，后者不是搜索词是粘贴板）。
 *
 * 界面两条铁律：面板用 `Z.SPOTLIGHT`（高于弹层、低于菜单栏），且带 backdrop-filter 的
 * 面板本体**不加 transform**（居中靠父层 flex，不靠 translate）；结果文本一律 textContent。
 */
import { settings } from "./settings.js";
import { i18n } from "./i18n.js";
import { Z } from "./zindex.js";
import { assetIcon, assetPath, glyph, modFile, FOLDER_ICON, GENERIC_DOC_ICON, GENERIC_APP_ICON } from "./paths.js";
import { listApps, isPluginEnabled, displayNameFor } from "./app-registry.js";
import { VFS } from "./vfs.js";

/** 搜索历史槽与上限。 */
const HISTORY_SLOT = "deskly-spotlight-history";
const HISTORY_MAX = 10;
/** 单个来源家族最多贡献的结果数，免得文件列表把设置挤掉。 */
const PER_FAMILY_LIMIT = 6;

/** 快捷键候选（与设置项 values 一致）。 */
const HOTKEYS = ["cmd+space", "ctrl+space", "alt+space", "off"];

/** 唤起键 → 修饰键要求（三选一，空格键本体由 hotkeyMatches 判定）。 */
const HOTKEY_MAP = {
    "cmd+space": { meta: true },
    "ctrl+space": { ctrl: true },
    "alt+space": { alt: true },
};

/**
 * 设置面板 id -> 中文名与图标。
 * 键取自系统设置面板注册表的 pane id（这里**不 import 那个插件**：内核反向依赖插件会
 * 形成加载环，一张静态表换来的是零耦合）。同时保留若干以字形名当 pane 的旧写法作别名。
 */
const PANE_META = {
    general: { label: "通用", icon: glyph("gear") },
    storage: { label: "本地存储", icon: FOLDER_ICON },
    spotlight: { label: "聚焦", icon: glyph("magnifyingglass") },
    controlcenter: { label: "控制中心", icon: glyph("switch.2") },
    focus: { label: "专注模式", icon: glyph("moon.fill") },
    wallpaper: { label: "墙纸", icon: glyph("photo.circle") },
    appearance: { label: "外观", icon: glyph("moonphase.last.quarter.inverse") },
    display: { label: "显示器", icon: glyph("sun.max.fill") },
    dock: { label: "桌面与程序坞", icon: glyph("menubar.dock.rectangle") },
    siri: { label: "Siri", icon: assetIcon("Siri") },
    Siri: { label: "Siri", icon: assetIcon("Siri") },
    notifications: { label: "通知", icon: glyph("bell.badge.fill") },
    sound: { label: "声音", icon: glyph("speaker.wave.3.fill") },
    lockScreen: { label: "锁定屏幕", icon: glyph("lock.fill") },
    password: { label: "登录密码", icon: glyph("at") },
    privacy: { label: "隐私与安全性", icon: glyph("hand.raised.fill") },
    keyboard: { label: "键盘", icon: glyph("keyboard.fill") },
    mouse: { label: "鼠标", icon: glyph("magicmouse.fill") },
    plugins: { label: "App", icon: assetIcon("Automator") },
    debug: { label: "调试", icon: assetIcon("Console") },
    // 别名：部分定义以字形名当 pane
    gear: { label: "通用", icon: glyph("gear") },
    magnifyingglass: { label: "聚焦", icon: glyph("magnifyingglass") },
    "switch.2": { label: "控制中心", icon: glyph("switch.2") },
    "bell.badge.fill": { label: "通知", icon: glyph("bell.badge.fill") },
    "photo.circle": { label: "墙纸", icon: glyph("photo.circle") },
    "magicmouse.fill": { label: "鼠标", icon: glyph("magicmouse.fill") },
    "keyboard.fill": { label: "键盘", icon: glyph("keyboard.fill") },
    "menubar.dock.rectangle": { label: "桌面与程序坞", icon: glyph("menubar.dock.rectangle") },
};

/**
 * 命令类结果：动作名必须是 window.__menuActions 里真实存在的键，
 * 取不到函数的条目在渲染时被过滤掉（菜单命令即注册表键名，不使用 eval）。
 */
const COMMANDS = [
    { action: "lockScreen", label: "锁定屏幕", sub: "会话命令", icon: glyph("lock.fill") },
    { action: "sleep", label: "睡眠", sub: "会话命令", icon: glyph("moon.fill") },
    { action: "shutdown", label: "关机", sub: "会话命令", icon: glyph("moon.stars.circle") },
    { action: "restart", label: "重新启动", sub: "会话命令 · 重新加载页面", icon: glyph("arrow.up.left.and.arrow.down.right") },
    { action: "forceQuit", label: "强制退出全部应用", sub: "会话命令", icon: glyph("hand.raised.fill") },
    { action: "logOut", label: "退出登录", sub: "会话命令", icon: glyph("person.2.fill") },
    { action: "emptyTrash", label: "清倒废纸篓", sub: "桌面", icon: assetPath("icons/trash/trash_light.png") },
    { action: "hideActiveApp", label: "隐藏当前应用", sub: "窗口", icon: glyph("chevron.down") },
    { action: "showAll", label: "显示全部窗口", sub: "窗口", icon: glyph("menubar.dock.rectangle") },
    { action: "aboutThisMac", label: "关于本机", sub: "会话命令", icon: glyph("gear") },
    { action: "reloadActivePlugin", label: "重新载入当前插件", sub: "调试", icon: glyph("switch.2") },
];

/** 界面状态。 */
const ui = {
    root: null,
    input: null,
    listEl: null,
    emptyEl: null,
    historyEl: null,
    badge: null,
    items: [],
    rows: [],
    active: -1,
    token: 0,
    open: false,
    restoreFocus: null,
    detach: null,
};

/** 注册本模块托管的设置项（其余 spotlight.* 由定义表声明）。 */
function defineSchema() {
    settings.define({
        key: "spotlight.hotkey", type: "string", default: "cmd+space",
        values: HOTKEYS, valuesLabel: ["Command + 空格", "Control + 空格", "Option + 空格", "关闭"],
        control: "dropdown", pane: "spotlight", group: "聚焦", order: 5,
        label: "打开快捷键",
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

// ---- 匹配打分 ----

/** 一个字段命中该查询的程度：0 精确、1 前缀、2 包含、3 未命中。 */
function rankOf(query, ...fields) {
    let best = 3;
    fields.forEach((field) => {
        const text = String(field || "").toLowerCase();
        if (!text) return;
        let rank = 3;
        if (text === query) rank = 0;
        else if (text.startsWith(query)) rank = 1;
        else if (text.includes(query)) rank = 2;
        if (rank < best) best = rank;
    });
    return best;
}

/** 家族间的默认次序：应用 > 命令 > 设置 > 文件。 */
const FAMILY_ORDER = { app: 0, command: 1, setting: 2, pane: 2, file: 3, folder: 3 };

/**
 * 统一排序并截断：先按命中程度，再按来源家族，最后按名称。
 * @param {Array<object>} items 带 rank 的候选结果
 * @returns {Array<object>} 排好并去掉内部 rank 字段的结果
 */
function rank(items) {
    return items
        .sort((a, b) => (a.rank - b.rank) || ((FAMILY_ORDER[a.type] ?? 9) - (FAMILY_ORDER[b.type] ?? 9))
            || String(a.label).localeCompare(String(b.label), "zh-CN"))
        .slice(0, maxResults())
        // 内部打分字段不外泄：对外结果只有 type / label / sub / hint / icon / onSelect
        .map((item) => Object.fromEntries(Object.entries(item).filter(([field]) => field !== "rank")));
}

// ---- 四类来源 ----

/** plugin-manager 只在真要打开应用时才被拉进来：它静态依赖 window.js -> finderbar.js，
 *  内核侧任何一条静态说明符都可能与该链形成环，动态导入一次拿到的还是同一个实例。 */
let pmModule = null;
function pluginManager() {
    if (!pmModule) pmModule = import("./plugin-manager.js");
    return pmModule;
}

/**
 * 打开一个应用（经 plugin-manager 的统一入口）。
 * @param {string} nameOrId 显示名 / 插件 id / appId
 * @param {object} [opts] 透传给 openApp 的选项
 * @returns {Promise<*>} openApp 的结果
 */
async function openAppByName(nameOrId, opts = {}) {
    const { openApp } = await pluginManager();
    return openApp(nameOrId, opts);
}

/** 应用类结果。 */
async function appResults(query) {
    // 禁用的插件不参与搜索：搜到了却打不开，比搜不到更让人困惑
    const apps = listApps()
        .filter((rec) => isPluginEnabled(rec.id))
        // displayName 也进匹配：非中文语言下用户会打英文/日文名搜应用
        .map((rec) => ({ rec, rank: rankOf(query, rec.name, rec.windowName, rec.displayName, rec.id, rec.appId) }))
        .filter((hit) => hit.rank < 3)
        .slice(0, PER_FAMILY_LIMIT);
    const { getIconForName } = await pluginManager().catch(() => ({}));
    return apps.map(({ rec, rank: score }) => ({
        type: "app",
        rank: score,
        label: rec.displayName || rec.name || rec.appId,
        sub: rec.app ? `${displayNameFor(rec.id)} · 子应用` : "应用程序",
        hint: "回车打开",
        icon: (typeof getIconForName === "function" && getIconForName(rec.appId)) || GENERIC_APP_ICON,
        onSelect: () => openAppByName(rec.windowName || rec.name),   // 打开仍用跨语言不变的身份名
    }));
}

/**
 * 面板名与图标。名字以系统设置的注册表为唯一来源：registry.js 开机时把四语的
 * `ss.pane.<id>` 注册进 i18n，这里只兜底「还没注册」与图标。
 * 下面这张表里的 label 以前是第二份名字来源，已经漂过一次（注册表叫「存储」、
 * 这里叫「本地存储」），所以取名字时先问 i18n。
 * @param {string} pane 面板 id（设置项定义里的 pane 字段）
 * @returns {{label:string, icon:string}} 显示名与图标
 */
function paneMeta(pane) {
    const meta = PANE_META[pane] || { label: pane || "设置", icon: glyph("gear") };
    return { icon: meta.icon, label: i18n.t(`ss.pane.${pane}`, meta.label) };
}

/**
 * 打开系统设置的某个面板：先确保插件已加载，再派发深链事件。
 * @param {string} pane 面板 id（设置项定义里的 pane 字段）
 * @returns {Promise<void>}
 */
async function openPane(pane) {
    if (!pane) return;
    await (typeof globalThis.__pluginManagerReady === "function" ? globalThis.__pluginManagerReady() : Promise.resolve());
    await openAppByName("系统设置");
    document.dispatchEvent(new CustomEvent("system-settings-open-pane", { detail: { pane }, bubbles: true }));
}

/** 设置类结果：命中项 + 按面板归并出的「设置面板」条目。 */
function settingResults(query) {
    const hits = settings.list()
        .filter((def) => !def.hidden)
        .map((def) => ({ def, rank: rankOf(query, def.label, def.key, def.hint, def.group) }))
        .filter((hit) => hit.rank < 3)
        .slice(0, PER_FAMILY_LIMIT);
    const items = hits.map(({ def, rank: score }) => ({
        type: "setting",
        rank: score,
        label: String(def.label || def.key),
        sub: `设置 · ${paneMeta(def.pane).label}`,
        hint: def.hint ? String(def.hint) : `回车打开「${paneMeta(def.pane).label}」`,
        icon: paneMeta(def.pane).icon,
        onSelect: () => openPane(def.pane),
    }));
    const panes = [...new Set(hits.map(({ def }) => def.pane).filter(Boolean))];
    panes.slice(0, 3).forEach((pane) => {
        const meta = paneMeta(pane);
        items.push({
            type: "pane",
            rank: 2,
            label: `${meta.label}面板`,
            sub: "设置面板",
            hint: "回车前往",
            icon: meta.icon,
            onSelect: () => openPane(pane),
        });
    });
    return items;
}

/** 命令类结果：只认确实能解析到函数的动作名。 */
function commandResults(query) {
    return COMMANDS
        .map((meta) => ({ meta, fn: resolveAction(meta.action) }))
        .filter(({ fn }) => Boolean(fn))
        .map(({ meta, fn }) => ({ meta, fn, score: rankOf(query, meta.label, meta.action, meta.sub) }))
        .filter(({ score }) => score < 3)
        .slice(0, PER_FAMILY_LIMIT)
        .map(({ meta, fn, score }) => ({
            type: "command",
            rank: score,
            label: meta.label,
            sub: meta.sub,
            hint: "回车执行",
            icon: meta.icon,
            onSelect: () => { fn(); },
        }));
}

/**
 * 把一个动作名解析成可执行函数：`window.__menuActions` 是唯一权威
 * （菜单命令即注册表键名，绝不按名字去 eval / new Function 出代码），
 * 只有「重新载入当前插件」这类活在 debug.js 里的命令按导出名补一份。
 * @param {string} name 动作名
 * @returns {Function|null} 可执行函数；不存在时 null（该命令就不出现在结果里）
 */
function resolveAction(name) {
    const fromMenu = (globalThis.__menuActions || {})[name];
    if (typeof fromMenu === "function") return fromMenu;
    if (name === "reloadActivePlugin") {
        return async () => {
            const { reloadActivePlugin } = await import("./debug.js");
            if (typeof reloadActivePlugin === "function") reloadActivePlugin();
        };
    }
    return null;
}

/**
 * 文件类结果：先查最近使用，再逐个顶层目录列目录。
 * 根目录现在始终存在（没挂载本地文件夹时就在应用内），所以不再按授权状态整类清空；
 * `AppData` 是插件内部目录，不进搜索结果。
 */
async function fileResults(query) {
    try {
        await VFS.init(); // 幂等：访达没打开过时这里补齐根目录装载，已就绪则立即返回
    } catch {
        return [];
    }
    const found = [];
    const push = (entry, where) => {
        const score = rankOf(query, entry.name, entry.path);
        if (score === 3) return;
        found.push({ entry, where, score });
    };
    try {
        (await VFS.getRecentFiles(80) || []).forEach((entry) => push(entry, "最近使用"));
    } catch { /* 单个来源失败不影响其它来源 */ }
    for (const def of Object.values(VFS.TOP_FOLDERS)) {
        if (def.internal) continue;
        try {
            const entries = await VFS.list(def.path);
            (entries || []).forEach((entry) => push(entry, def.label));
        } catch { /* 权限待补或目录不可读：跳过这个来源 */ }
    }
    const seen = new Set();
    return found
        .sort((a, b) => a.score - b.score)
        .filter(({ entry }) => {
            if (seen.has(entry.path)) return false;
            seen.add(entry.path);
            return true;
        })
        .slice(0, PER_FAMILY_LIMIT)
        .map(({ entry, where, score }) => ({
            type: entry.type === "folder" ? "folder" : "file",
            rank: score,
            label: String(entry.name),
            sub: `${where} · ${entry.path}`,
            hint: VFS.formatDate ? VFS.formatDate(entry.modified) : "回车在访达中打开",
            icon: entry.type === "folder" ? FOLDER_ICON : GENERIC_DOC_ICON,
            onSelect: () => revealInFinder(entry),
        }));
}

/**
 * 在访达里定位一个条目：打开访达窗口后派发它已监听的 navigate 命令。
 * @param {object} entry VFS 条目
 * @returns {Promise<void>}
 */
async function revealInFinder(entry) {
    await openAppByName("访达");
    const path = entry.type === "folder" ? entry.path : entry.path.replace(/\/[^/]*$/, "") || "/";
    const win = document.getElementById("访达");
    if (win) {
        win.dispatchEvent(new CustomEvent("finder-command", { detail: { command: "navigate", args: { path } }, bubbles: true }));
        return;
    }
    const navigate = (globalThis.__menuActions || {}).finderNavigate;
    if (typeof navigate === "function") navigate(path);
}

/**
 * 一次搜索：四类来源合并。
 * @param {string} query 查询文本
 * @returns {Promise<Array<{type:string,label:string,sub:string,hint:string,icon?:string,onSelect:Function}>>} 结果
 */
async function searchAll(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const batches = [];
    if (enabled("spotlight.apps")) batches.push(await appResults(q));
    if (enabled("spotlight.settings")) batches.push(settingResults(q));
    if (enabled("spotlight.commands")) batches.push(commandResults(q));
    if (enabled("spotlight.manual")) batches.push(await manualResults(q));
    if (enabled("spotlight.files")) batches.push(await fileResults(q));
    return rank(batches.flat());
}

// ---- 使用手册 ----

/** 手册索引：首次搜索时加载一次；失败也记住结果，避免每次输入都重复请求。 */
let manualIndexPromise = null;

/**
 * 读手册索引（由 dev/build-manual-content.mjs 生成）。
 * @returns {Promise<object|null>} 索引对象；不可用时 null
 */
function manualIndex() {
    if (!manualIndexPromise) {
        manualIndexPromise = fetch(modFile("manual", "content/index.json"))
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null);
    }
    return manualIndexPromise;
}

/** 手册类结果：小节标题与摘要都参与匹配，点按打开对应章节。 */
async function manualResults(query) {
    const index = await manualIndex();
    if (!index || !Array.isArray(index.search)) return [];
    const hits = [];
    index.search.forEach((entry) => {
        const score = rankOf(query, entry.section, entry.text, entry.chapterTitle);
        if (score === 3) return;
        hits.push({ entry, score });
    });
    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, PER_FAMILY_LIMIT).map(({ entry }) => ({
        type: "manual",
        label: entry.section,
        sub: `${entry.chapterTitle} · ${i18n.t("spotlight.manualHint", "手册")}`,
        icon: glyph("document.blue"),
        onSelect: () => openManualAt(entry),
    }));
}

/**
 * 打开手册并跳到该节。手册是插件，首次打开要等外壳与脚本就位，
 * 这里轮询中栏条目出现后再派发（固定延时在慢机器上会赶在监听注册之前）。
 * @param {{chapter:string,h:number}} entry 命中的索引条目
 * @returns {Promise<void>}
 */
async function openManualAt(entry) {
    await openAppByName("Mac 使用手册");
    const jump = () => document.dispatchEvent(new CustomEvent("manual-open", {
        detail: { chapter: entry.chapter, h: entry.h }, bubbles: true,
    }));
    let tries = 0;
    const tick = () => {
        if (document.querySelector(".manual__chapters .manual__row")) { setTimeout(jump, 60); return; }
        if (tries++ < 50) setTimeout(tick, 100);
    };
    tick();
}

// ---- 搜索历史 ----

/**
 * 读历史列表。
 * @returns {string[]} 查询文本，最新在前
 */
function readHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_SLOT) || "[]");
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, HISTORY_MAX) : [];
    } catch {
        return [];
    }
}

/**
 * 是否值得入库：纯数字（误触/粘贴数字）与超长文本都不是搜索词。
 * @param {string} query 查询文本
 * @returns {boolean} 是否记录
 */
function storable(query) {
    const text = String(query || "").trim();
    if (!text || text.length > 40) return false;
    return !/^\d[\d\s.,-]*$/.test(text);
}

/**
 * 记一条历史（去重、截断到 HISTORY_MAX）。
 * @param {string} query 查询文本
 * @returns {string[]} 最新历史
 */
function recordHistory(query) {
    const text = String(query || "").trim();
    if (!enabled("spotlight.keepHistory") || !storable(text)) return readHistory();
    const next = [text, ...readHistory().filter((item) => item !== text)].slice(0, HISTORY_MAX);
    try {
        localStorage.setItem(HISTORY_SLOT, JSON.stringify(next));
    } catch { /* 配额满：历史丢掉即可，搜索照常 */ }
    return next;
}

/** 清空历史。 */
function clearHistory() {
    try { localStorage.removeItem(HISTORY_SLOT); } catch { /* 忽略 */ }
    if (ui.open) renderHistory();
}

// ---- 界面 ----

/** 建一个纯文本节点。 */
function textNode(tag, text, style) {
    const el = document.createElement(tag);
    el.textContent = text;
    if (style) el.style.cssText = style;
    return el;
}

const ROW_STYLE = "display:flex;align-items:center;gap:10px;padding:7px 14px;cursor:default;";

/** 取（或建）面板根节点。 */
function ensureRoot() {
    if (ui.root && ui.root.isConnected) return ui.root;
    const backdrop = textNode("div", "", "position:fixed;inset:0;z-index:" + Z.SPOTLIGHT
        + ";background:rgba(18,18,22,0.24);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;");
    backdrop.id = "deskly-spotlight-backdrop";
    backdrop.className = "spotlight-backdrop os-overlay";
    backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) closeSpotlight();
    });

    const panel = document.createElement("div");
    panel.id = "deskly-spotlight";
    panel.className = "spotlight-panel os-overlay";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "聚焦搜索");
    panel.style.cssText = "width:min(680px,88vw);box-sizing:border-box;border-radius:14px;overflow:hidden;"
        + "background:rgba(246,246,246,0.72);backdrop-filter:blur(var(--surface-blur-3)) saturate(var(--surface-saturate));"
        + "-webkit-backdrop-filter:blur(var(--surface-blur-3)) saturate(var(--surface-saturate));color:var(--surface-text);"
        + "box-shadow:0 24px 70px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08);";
    // 面板底色写死为浅色（与主题无关），所以按它自己的底色取局部文字色，
    // 不能沿用全局 --surface-text（深色主题下那是白字）。
    globalThis.__surface?.apply?.(panel, { role: 3 });

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.08);";
    const mark = document.createElement("img");
    mark.src = glyph("magnifyingglass");
    mark.alt = "";
    mark.style.cssText = "width:18px;height:18px;opacity:.55;flex:0 0 18px;";
    const input = document.createElement("input");
    input.type = "search";
    input.id = "deskly-spotlight-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "搜索应用、设置、文件与命令";
    input.setAttribute("aria-label", "搜索");
    input.style.cssText = "flex:1;min-width:0;border:0;background:transparent;outline:none;font-size:19px;color:inherit;";
    const badge = textNode("span", "", "font-size:11px;opacity:.5;flex:0 0 auto;");
    badge.id = "deskly-spotlight-count";
    head.append(mark, input, badge);

    const listEl = document.createElement("div");
    listEl.id = "deskly-spotlight-results";
    listEl.setAttribute("role", "listbox");
    listEl.style.cssText = "max-height:46vh;overflow:auto;padding:6px 0;";

    const emptyEl = textNode("div", "输入以开始搜索", "padding:18px 14px;font-size:13px;opacity:.55;");
    const historyEl = document.createElement("div");
    historyEl.id = "deskly-spotlight-history";
    historyEl.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 12px;";

    panel.append(head, listEl, emptyEl, historyEl);
    backdrop.appendChild(panel);

    ui.root = backdrop;
    ui.input = input;
    ui.listEl = listEl;
    ui.emptyEl = emptyEl;
    ui.historyEl = historyEl;
    ui.badge = badge;

    input.addEventListener("input", () => { scheduleSearch(input.value); });
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
        ui.historyEl.appendChild(textNode("span", "最近搜索：还没有记录", "font-size:11px;opacity:.45;"));
        return;
    }
    ui.historyEl.appendChild(textNode("span", "最近搜索", "font-size:11px;opacity:.45;align-self:center;"));
    items.forEach((query) => {
        const chip = textNode("button", query, "border:1px solid rgba(0,0,0,.12);background:rgba(0,0,0,.05);"
            + "border-radius:12px;padding:3px 10px;font-size:12px;color:inherit;cursor:pointer;max-width:180px;"
            + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
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
    const clear = textNode("button", "清除", "border:0;background:transparent;color:rgba(0,0,0,.45);"
        + "font-size:11px;cursor:pointer;text-decoration:underline;");
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
    row.style.cssText = ROW_STYLE;
    if (item.icon) {
        const img = document.createElement("img");
        img.src = item.icon;
        img.alt = "";
        img.style.cssText = "width:22px;height:22px;flex:0 0 22px;object-fit:contain;";
        row.appendChild(img);
    }
    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-width:0;";
    body.appendChild(textNode("div", item.label, "font-size:14px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"));
    if (item.sub) body.appendChild(textNode("div", item.sub, "font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"));
    row.appendChild(body);
    if (item.hint) row.appendChild(textNode("span", item.hint, "font-size:11px;opacity:.45;flex:0 0 auto;"));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("mouseenter", () => setActive(index));
    row.addEventListener("click", () => runItem(item));
    return row;
}

/** 渲染结果列表。 */
function renderResults(items) {
    if (!ui.listEl) return;
    ui.items = items;
    ui.rows = [];
    ui.listEl.textContent = "";
    items.forEach((item, index) => {
        const row = renderRow(item, index);
        ui.listEl.appendChild(row);
        ui.rows.push(row);
    });
    const total = items.length;
    const query = String(ui.input?.value || "").trim();
    if (ui.badge) ui.badge.textContent = total ? `${total} 条结果` : "";
    ui.emptyEl.textContent = "无匹配结果";
    ui.emptyEl.style.display = query && !total ? "block" : "none";
    setActive(total ? 0 : -1);
}

/** 高亮第 index 行并滚动到可视区。 */
function setActive(index) {
    if (!ui.rows) return;
    ui.active = index;
    ui.rows.forEach((row, i) => {
        row.style.background = i === index ? "rgba(0,122,255,0.16)" : "transparent";
        if (i === index) row.setAttribute("aria-selected", "true");
        else row.removeAttribute("aria-selected");
    });
    const row = ui.rows[index];
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
}

/** 执行一条结果：先记历史再关面板，最后跑 onSelect。 */
function runItem(item) {
    if (!item) return;
    const query = String(ui.input?.value || "").trim();
    if (query) recordHistory(query);
    closeSpotlight();
    try {
        const result = item.onSelect?.();
        if (result && typeof result.catch === "function") result.catch(() => { /* 打开失败由被调用方记日志 */ });
    } catch { /* 单条结果的失败不该影响搜索本身 */ }
}

/** 键盘：上下选择、回车执行、Esc 关闭。 */
function onInputKeydown(event) {
    const count = ui.rows.length;
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

/** 搜索结果异步到达：用 token 丢弃过期响应。 */
let searchTimer = null;
function scheduleSearch(query) {
    const token = ++ui.token;
    renderHistory();
    if (searchTimer) clearTimeout(searchTimer);
    const run = async () => {
        let items = [];
        try {
            items = await searchAll(query);
        } catch {
            items = [];
        }
        if (token !== ui.token || !ui.open) return;
        renderResults(items);
    };
    if (!String(query || "").trim()) {
        renderResults([]);
        return;
    }
    searchTimer = setTimeout(run, 60);
}

/**
 * 打开聚焦搜索。
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
    ui.input.value = String(prefill || "");
    renderResults([]);
    renderHistory();
    ui.input.focus();
    // 面板外的点击与按键都归面板自己处理；这里只挂一个 Esc 兜底（输入框没焦点时也能关）
    const onDocKey = (event) => { if (event.key === "Escape") closeSpotlight(); };
    document.addEventListener("keydown", onDocKey, true);
    ui.detach = () => document.removeEventListener("keydown", onDocKey, true);
    window.__log?.debug("kernel/spotlight", "聚焦搜索已打开");
    return true;
}

/**
 * 关闭聚焦搜索。
 * @returns {boolean} 是否从打开态被关闭
 */
function closeSpotlight() {
    if (!ui.open) return false;
    ui.detach?.();
    ui.detach = null;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    ui.root?.remove();
    ui.open = false;
    ui.items = [];
    ui.rows = [];
    ui.active = -1;
    const focus = ui.restoreFocus;
    ui.restoreFocus = null;
    if (focus && typeof focus.focus === "function" && focus.isConnected) {
        try { focus.focus(); } catch { /* 原焦点元素已消失 */ }
    }
    return true;
}

/**
 * 切换聚焦搜索。
 * @returns {boolean} 切换后是否处于打开态
 */
function toggleSpotlight() {
    if (ui.open) {
        closeSpotlight();
        return false;
    }
    return openSpotlight();
}

// ---- 快捷键 ----

/** 事件是否命中给定的快捷键描述。 */
function hotkeyMatches(spec, event) {
    if (!spec || spec === "off" || event.repeat || event.shiftKey) return false;
    const want = HOTKEY_MAP[spec];
    if (!want) return false;
    if (event.key !== " " && event.code !== "Space") return false;
    return Boolean(want.meta) === Boolean(event.metaKey)
        && Boolean(want.ctrl) === Boolean(event.ctrlKey)
        && Boolean(want.alt) === Boolean(event.altKey);
}

/** document 级快捷键入口。 */
function onHotkey(event) {
    // F4：手册里的「聚焦」键，无修饰键时归聚焦（启动台改用 ⌃↓，见 keyboard.js 键位表）
    const plainF4 = event.key === "F4"
        && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat;
    if (!plainF4 && !hotkeyMatches(settings.get("spotlight.hotkey"), event)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSpotlight();
}

/** 顶栏图标：finderbar 的注册函数由它自己的模块提供，取不到就安静跳过。 */
async function mountMenuBarIcon() {
    try {
        const mod = await import("./finderbar.js");
        const icon = glyph("magnifyingglass");
        mod.registerFinderbarIcon?.({
            id: "spotlight",
            icon,
            order: 30,
            onClick: () => toggleSpotlight(),
        });
    } catch { /* finderbar 尚未提供该导出：顶栏图标是加分项，不是前置条件 */ }
}

let initialized = false;

/**
 * 初始化聚焦搜索：注册设置、绑定快捷键、挂顶栏图标。
 * @returns {boolean} 是否完成初始化（重复调用幂等）
 */
function initSpotlight() {
    if (initialized) return true;
    initialized = true;
    document.addEventListener("keydown", onHotkey, true);
    mountMenuBarIcon();
    window.__log?.info("kernel/spotlight",
        `聚焦搜索就绪：快捷键 ${settings.get("spotlight.hotkey") || "off"}`
        + `，来源 ${["apps", "settings", "files", "commands"].filter((key) => enabled(`spotlight.${key}`)).join("/")}`);
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
    /** 当前是否处于打开态（只读） */
    get isOpen() { return ui.open; },
};

export {
    openSpotlight, closeSpotlight, toggleSpotlight, searchAll, initSpotlight,
    readHistory, recordHistory, clearHistory, HOTKEYS,
};
