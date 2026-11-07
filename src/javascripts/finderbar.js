/**
 * finderbar.js — 菜单栏（顶栏）核心逻辑
 *
 * 职责：
 * 1. 渲染左侧 Apple 图标 + 活动应用名 + 菜单项（文件/编辑/显示等）。
 * 2. 渲染右侧系统状态图标与日期时间（格式读 general.* 设置，语言切换后重排）。
 * 3. 动态生成各应用的子菜单（下拉内容）与操作命令；菜单项右侧渲染快捷键提示。
 * 4. 管理菜单的打开/关闭状态与层级。
 * 5. 按 debug.developerMode 决定「调试」菜单是否出现（命令实现在 debug.js）。
 *
 * 日志：本模块所有输出走 window.__log（来源 kernel/finderbar），不再用裸 console ——
 * 裸 console 只在当前标签页控制台里存在，用户报「菜单不对」时什么都留不下。
 */

import { i18n } from "./i18n.js";
import { settings } from "./settings.js";
import { mountToFinderbar } from "./controlcenter.js";
import { initDatetimePopover } from "./datetime_popover.js";
import { bringToFront } from "./zindex.js";
import { assetPath, SIRI_BAR_ICON } from "./paths.js";
import { dispatchMenuCommand } from "./ui/menuCommands.js";
import { SESSION_ACTIONS } from "./session.js";
import { listApps, displayNameFor } from "./app-registry.js";
import { initDebug, isDeveloperMode, DEBUG_MENU_ITEMS } from "./debug.js";
import { getKeyboardEntries, statusForShortcut, tierText } from "./keyboard.js";

/** 可选日志出口（来源固定 kernel/finderbar），log.js 未求值时退回 console。 */
function writeLog(level, message, data) {
    const logger = globalThis.__log;
    if (logger && typeof logger[level] === "function") logger[level]("kernel/finderbar", message, data);
    else (console[level] || console.log).call(console, `[finderbar] ${message}`, data);
}

// 空闲调度工具：非关键 DOM 构建拆到主线程空闲期执行，避免初始化长任务阻塞首屏。
// requestIdleCallback 优先（带 timeout 兜底）；不支持时退化为双 rAF（下一帧后）。
function scheduleIdle(fn, timeout = 800) {
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(fn, { timeout });
    } else {
        requestAnimationFrame(() => requestAnimationFrame(fn));
    }
}

// 顶层菜单文本键映射（用于应用菜单国际化）
const MENU_KEYS = {
    "应用": "finderbar.app",
    "文件": "finderbar.file",
    "编辑": "finderbar.edit",
    "显示": "finderbar.view",
    "前往": "finderbar.go",
    "窗口": "finderbar.window",
    "帮助": "finderbar.help",
    "历史记录": "finderbar.history",
    "书签": "finderbar.bookmarks",
    "调试": "finderbar.debug",
};

/** 「调试」菜单标题：开发者模式开启时才注入到任何应用的菜单里（实现见 debug.js）。 */
const DEBUG_MENU_TITLE = "调试";

/**
 * 子菜单定义：每个应用 → 每个菜单 → 菜单项数组。
 * 菜单项字段：
 *   - label:     {string}           显示文本（可被 i18n 覆盖）
 *   - i18nKey:   {string}           可选：i18n 翻译键，缺失时直接显示 label
 *   - shortcut:  {string}           可选：快捷键提示（如 "⌘N"）
 *   - cmd:       {string|function}  点击后执行：字符串走 moduleItems.create 等全局入口；函数直接调用
 *   - disabled:  {boolean}          可选：是否置灰不可点击
 *   - separator: {boolean}          可选：true 则该项为分割线 <hr/>
 */
const SUB_MENUS = {
    "访达": {
        "文件": [
            { label: "新建访达窗口", shortcut: "⌘N", cmd: "openAppByName('访达')" },
            { label: "新建文件夹", shortcut: "⌘⇧N", cmd: "finderNewFolder" },
            { separator: true },
            { label: "打开", shortcut: "⌘O", disabled: true },
            { label: "打印", shortcut: "⌘P", disabled: true },
            { separator: true },
            { label: "关闭窗口", shortcut: "⌘W", cmd: "closeActiveWindow()" },
            { label: "清倒废纸篓...", shortcut: "⌘⇧⌫", cmd: "emptyTrash()" },
        ],
        "编辑": [
            { label: "撤销", shortcut: "⌘Z", disabled: true },
            { label: "重做", shortcut: "⌘⇧Z", disabled: true },
            { separator: true },
            { label: "剪切", shortcut: "⌘X", disabled: true },
            { label: "拷贝", shortcut: "⌘C", disabled: true },
            { label: "粘贴", shortcut: "⌘V", disabled: true },
            { label: "全选", shortcut: "⌘A", disabled: true },
            { separator: true },
            { label: "显示简介", shortcut: "⌘I", cmd: "finderShowInfo" },
        ],
        "显示": [
            { label: "以图标方式", shortcut: "⌘1", cmd: "finderViewMode('icon')" },
            { label: "以列表方式", shortcut: "⌘2", cmd: "finderViewMode('list')" },
            { label: "以分栏方式", shortcut: "⌘3", cmd: "finderViewMode('column')" },
            { label: "以画廊方式", shortcut: "⌘4", cmd: "finderViewMode('gallery')" },
            { separator: true },
            { label: "显示标签栏", cmd: "finderToggleTabBar" },
            { separator: true },
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
            { label: "隐藏工具栏", disabled: true },
        ],
        "前往": [
            { label: "最近使用", shortcut: "⌘⇧F", cmd: "finderNavigate('/最近使用')" },
            { label: "文稿", shortcut: "⌘⇧D", cmd: "finderNavigate('/文档')" },
            { label: "桌面", shortcut: "⌘⇧⌥D", cmd: "finderNavigate('/桌面')" },
            { separator: true },
            { label: "下载", shortcut: "⌘⌥L", cmd: "finderNavigate('/下载')" },
            { label: "应用程序", shortcut: "⌘⇧A", cmd: "finderNavigate('/')" },
            { label: "实用工具", shortcut: "⌘⇧U", disabled: true },
            { separator: true },
            { label: "废纸篓", i18nKey: "finderbar.goTrash", cmd: "finderNavigate('/废纸篓')" },
            { separator: true },
            { label: "前往文件夹...", shortcut: "⌘⇧G", cmd: "finderGoToFolder" },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "平铺到左侧", i18nKey: "finderbar.tileLeft", cmd: "tileActiveWindow('left')" },
            { label: "平铺到右侧", i18nKey: "finderbar.tileRight", cmd: "tileActiveWindow('right')" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "访达帮助", cmd: "openManual('finder')" },
        ],
    },
    "系统设置": {
        "编辑": [
            { label: "撤销", shortcut: "⌘Z", disabled: true },
            { label: "重做", shortcut: "⌘⇧Z", disabled: true },
            { separator: true },
            { label: "剪切", shortcut: "⌘X", disabled: true },
            { label: "拷贝", shortcut: "⌘C", disabled: true },
            { label: "粘贴", shortcut: "⌘V", disabled: true },
            { label: "全选", shortcut: "⌘A", disabled: true },
        ],
        "显示": [
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
            { label: "工具栏", disabled: true },
            { label: "自定义工具栏...", disabled: true },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "系统设置帮助", cmd: "openManual('settings')" },
        ],
    },
    "计算器": {
        "编辑": [
            { label: "撤销", shortcut: "⌘Z", disabled: true },
            { label: "重做", shortcut: "⌘⇧Z", disabled: true },
            { separator: true },
            { label: "剪切", shortcut: "⌘X", disabled: true },
            { label: "拷贝", shortcut: "⌘C", disabled: true },
            { label: "粘贴", shortcut: "⌘V", disabled: true },
            { label: "全选", shortcut: "⌘A", disabled: true },
        ],
        // 「显示」整组交给 mods/calculator/manifest.json 的 menus：
        // 旧那五行里除「进入全屏」外全是 disabled:true 的装饰，按下去没有任何反应。
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "计算器帮助", cmd: "openManual('calculator')" },
        ],
    },
    "App Store": {
        "编辑": [
            { label: "撤销", shortcut: "⌘Z", disabled: true },
            { label: "重做", shortcut: "⌘⇧Z", disabled: true },
            { separator: true },
            { label: "剪切", shortcut: "⌘X", disabled: true },
            { label: "拷贝", shortcut: "⌘C", disabled: true },
            { label: "粘贴", shortcut: "⌘V", disabled: true },
            { label: "全选", shortcut: "⌘A", disabled: true },
        ],
        // 「显示」不再写死：商店分类与安装动作由 mods/app-store/manifest.json 的 menus 声明并实现；
        // 旧三行占位全是 disabled 装饰（「仅可更新」对应的分类本身未实现）。
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "App Store 帮助", cmd: "openManual('appstore')" },
        ],
    },
    "Safari浏览器": {
        "文件": [
            { label: "新建标签页", shortcut: "⌘T", cmd: "safariNewTab()" },
            { label: "恢复关闭的标签页", shortcut: "⇧⌘T", cmd: "safariReopenClosedTab()" },
            { label: "打开位置…", shortcut: "⌘L", cmd: "safariFocusAddress()" },
            { label: "关闭标签页", shortcut: "⌘W", cmd: "safariCloseTab()" },
            { label: "关闭窗口", shortcut: "⌘⇧W", cmd: "closeActiveWindow()" },
            { separator: true },
            { label: "共享…", cmd: "safariShare()" },
            { label: "在默认浏览器中打开", cmd: "safariOpenExternal()" },
        ],
        "显示": [
            { label: "显示/隐藏侧栏", shortcut: "⌃⌘S", cmd: "safariToggleSidebar()" },
            { label: "标签页概览", cmd: "safariTabOverview()" },
            { separator: true },
            { label: "重新载入", shortcut: "⌘R", cmd: "safariReload()" },
            { label: "后退", shortcut: "⌘[", cmd: "safariGoBack()" },
            { label: "前进", shortcut: "⌘]", cmd: "safariGoForward()" },
            { separator: true },
            { label: "实际大小", shortcut: "⌘0", cmd: "safariZoomReset()" },
            { label: "放大", shortcut: "⌘+", cmd: "safariZoomIn()" },
            { label: "缩小", shortcut: "⌘-", cmd: "safariZoomOut()" },
            { separator: true },
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
        ],
        "历史记录": [
            { label: "显示所有历史记录", cmd: "safariShowHistory()" },
            { label: "后退", shortcut: "⌘[", cmd: "safariGoBack()" },
            { label: "前进", shortcut: "⌘]", cmd: "safariGoForward()" },
            { separator: true },
            { label: "清除历史记录…", cmd: "safariClearHistory()" },
        ],
        "书签": [
            { label: "显示书签", cmd: "safariShowBookmarks()" },
            { label: "显示阅读列表", cmd: "safariShowReadingList()" },
            { label: "显示起始页", shortcut: "⇧⌘H", cmd: "safariShowStartPage()" },
            { separator: true },
            { label: "添加/移除书签", shortcut: "⌘D", cmd: "safariToggleBookmark()" },
            { label: "添加阅读列表", shortcut: "⇧⌘D", cmd: "safariAddReading()" },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
    },
    "关于本机": {
        "编辑": [
            { label: "拷贝", shortcut: "⌘C", disabled: true },
            { label: "全选", shortcut: "⌘A", disabled: true },
        ],
        "显示": [
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "macOS 帮助", cmd: "openManual('home')" },
        ],
    },
};

/** 应用顶层菜单列表（保持顺序，用于渲染顶栏左侧菜单）。 */
export let appMenu = {
    "访达": ["文件", "编辑", "显示", "前往", "窗口", "帮助"],
    "系统设置": ["编辑", "显示", "窗口", "帮助"],
    "计算器": ["编辑", "显示", "窗口", "帮助"],
    "App Store": ["编辑", "显示", "窗口", "帮助"],
    "Safari浏览器": ["文件", "显示", "历史记录", "书签", "窗口"],
    "关于本机": ["编辑", "显示", "窗口", "帮助"],
};

/**
 * 通用默认菜单：不在 SUB_MENUS 表里的应用（记事本/照片/
 * 启动台/vs_code 等注册插件）用它。此前 updateMenu 对这些应用直接早退，菜单栏
 * 停留在上一个应用的菜单。默认集只接线「作用于当前窗口」的通用命令，
 * 其余项置灰，避免出现点了没反应的假功能。
 */
const DEFAULT_APP_MENU = ["应用", "文件", "编辑", "显示", "前往", "窗口", DEBUG_MENU_TITLE, "帮助"];
const DEFAULT_SUB_MENU = {
    "应用": [
        { label: "退出", i18nKey: "finderbar.quit", shortcut: "⌘Q", cmd: "closeActiveWindow()" },
    ],
    "文件": [
        { label: "新建", i18nKey: "finderbar.new", shortcut: "⌘N", disabled: true },
        { label: "打开", i18nKey: "common.open", shortcut: "⌘O", disabled: true },
        { separator: true },
        { label: "关闭窗口", i18nKey: "common.close", shortcut: "⌘W", cmd: "closeActiveWindow()" },
        { label: "保存", i18nKey: "common.save", shortcut: "⌘S", disabled: true },
    ],
    "编辑": [
        { label: "撤销", i18nKey: "finderbar.undo", shortcut: "⌘Z", disabled: true },
        { label: "重做", i18nKey: "finderbar.redo", shortcut: "⌘⇧Z", disabled: true },
        { separator: true },
        { label: "剪切", i18nKey: "finderbar.cut", shortcut: "⌘X", disabled: true },
        { label: "拷贝", i18nKey: "finderbar.copy", shortcut: "⌘C", disabled: true },
        { label: "粘贴", i18nKey: "finderbar.paste", shortcut: "⌘V", disabled: true },
        { label: "全选", i18nKey: "finderbar.selectAll", shortcut: "⌘A", disabled: true },
    ],
    "显示": [
        { label: "进入全屏", i18nKey: "finderbar.enterFullscreen", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
    ],
    "前往": [
        { label: "桌面", i18nKey: "finderbar.goDesktop", shortcut: "⌘⇧⌥D", cmd: "finderNavigate('/桌面')" },
        { label: "文稿", i18nKey: "finderbar.goDocuments", shortcut: "⌘⇧D", cmd: "finderNavigate('/文档')" },
        { label: "下载", i18nKey: "finderbar.goDownloads", shortcut: "⌘⌥L", cmd: "finderNavigate('/下载')" },
    ],
    "窗口": [
        { label: "最小化", i18nKey: "finderbar.minimize", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
        { label: "缩放", i18nKey: "finderbar.zoom", cmd: "toggleActiveWindowStretch()" },
        { separator: true },
        { label: "平铺到左侧", i18nKey: "finderbar.tileLeft", cmd: "tileActiveWindow('left')" },
        { label: "平铺到右侧", i18nKey: "finderbar.tileRight", cmd: "tileActiveWindow('right')" },
        { separator: true },
        { label: "前置全部窗口", i18nKey: "finderbar.bringAllToFront", cmd: "bringAllWindowsToFront()" },
    ],
    // 「调试」子菜单整组来自 debug.js 的 DEBUG_MENU_ITEMS：菜单层只拿得到 label/cmd，
    // 实现留在命令后端，顶栏不必知道任何一条命令怎么做。
    [DEBUG_MENU_TITLE]: DEBUG_MENU_ITEMS,
    "帮助": [
        { label: "帮助", i18nKey: "finderbar.helpItem", cmd: "openManual('home')" },
    ],
};

/**
 * 读取插件 manifest 的可选 menus 声明（应用自定义菜单）：
 *   "menus": { "文件": [ { label, i18nKey?, shortcut?, cmd?, disabled?, separator? }, ... ], ... }
 * 键为顶层菜单标题，声明顺序即渲染顺序；cmd 仍走 menuCommands 注册表分发
 * （name 或 name('arg') 或内联函数），非法形态会被分发层拒绝并打印日志。
 * 未声明 / 形态非法返回 null，调用方落回默认菜单——清单无需为此改动。
 */
function getManifestMenus(app) {
    if (typeof window.__getAppByName !== "function") return null;
    let rec;
    try {
        rec = window.__getAppByName(app);
    } catch (_) {
        return null;
    }
    const manifest = rec && rec.manifest;
    // 应用级 menus 优先：同一套件里文稿 / 表格 / 演示的「文件」内容必然不同，
    // 只读插件级声明会让三个应用顶栏一模一样。
    const menus = (rec && rec.app && rec.app.menus) || (manifest && manifest.menus);
    if (!menus || typeof menus !== "object" || Array.isArray(menus)) return null;
    const order = [];
    const defs = {};
    Object.keys(menus).forEach((title) => {
        if (!title || !Array.isArray(menus[title])) return;
        const items = menus[title]
            .map((raw) => {
                if (!raw || typeof raw !== "object") return null;
                if (raw.separator) return { separator: true };
                if (typeof raw.label !== "string" || !raw.label) return null;
                const item = { label: raw.label };
                if (typeof raw.i18nKey === "string") item.i18nKey = raw.i18nKey;
                if (typeof raw.shortcut === "string") item.shortcut = raw.shortcut;
                if (typeof raw.cmd === "string" || typeof raw.cmd === "function") item.cmd = raw.cmd;
                if (raw.disabled) item.disabled = true;
                return item;
            })
            .filter(Boolean);
        if (!items.length) return;
        order.push(title);
        defs[title] = items;
    });
    return order.length ? { order, defs } : null;
}

/**
 * 按开发者模式增删「调试」菜单（可见性判据只有 debug.developerMode 一项）。
 *
 * 为什么在这里做而不是往各应用菜单表里抄一份：SUB_MENUS 里的 6 个应用与清单声明的插件
 * 各有各的菜单，逐个补「调试」等于把同一个开关抄 6 遍，还会漏掉新插件；
 * 关掉时也必须能从任何应用上摘掉。开与关都走这一条路径，菜单表因此不含条件逻辑。
 * @param {string[]} order 顶层菜单标题顺序
 * @param {Object} defs 各菜单的项定义
 * @returns {{order: string[], defs: Object}} 处理后的菜单
 */
function applyDeveloperMenu(order, defs) {
    const titles = order.filter((title) => title !== DEBUG_MENU_TITLE);
    const nextDefs = { ...defs };
    delete nextDefs[DEBUG_MENU_TITLE];
    if (!isDeveloperMode()) return { order: titles, defs: nextDefs };
    nextDefs[DEBUG_MENU_TITLE] = DEBUG_MENU_ITEMS;
    // 插在末项（惯例是「帮助」）之前，与 macOS 的菜单收尾习惯一致
    titles.splice(titles.length ? titles.length - 1 : 0, 0, DEBUG_MENU_TITLE);
    return { order: titles, defs: nextDefs };
}

/**
 * 全站快捷键提示总表：系统设置「键盘」面板据此列出菜单里出现过的组合键。
 *
 * 来源是 SUB_MENUS / DEFAULT_SUB_MENU / 各插件清单声明的 menus 三处，只收带 `shortcut`
 * 的项，并按「应用 + 菜单 + 文本 + 组合键」去重（同一个套件里三个应用常抄同一份菜单）。
 * `menu` 给的是当前语言下的菜单名（内部标题只用于查表，不进结果）。
 * @returns {Array<{app: string|null, menu: string, label: string, shortcut: string}>}
 *          app 为所属应用名；null 表示通用默认菜单（未单独声明菜单的应用都用它）
 */
export function getShortcutMap() {
    // 先放全局键位表：这一段的 status 是「已绑定 / 等价键 / 浏览器保留」的唯一来源；
    // 菜单扫描出的条目只补充应用级快捷键，状态按同一张表反查。
    const rows = getKeyboardEntries().map((entry) => ({
        app: entry.app,
        menu: "键盘",
        label: entry.label,
        shortcut: entry.shortcut,
        status: entry.status,
    }));
    const seen = new Set(rows.map((row) => `${row.app}|${row.menu}|${row.label}|${row.shortcut}`));
    const seenKey = new Set(rows.map((row) => `${row.label}|${row.shortcut}`));
    const collect = (app, menuTitle, items) => {
        (items || []).forEach((item) => {
            if (!item || item.separator || typeof item.shortcut !== "string" || !item.shortcut) return;
            const label = item.i18nKey ? i18n.t(item.i18nKey, item.label) : item.label;
            if (!label) return;
            const id = `${app || "*"}|${menuTitle}|${label}|${item.shortcut}`;
            if (seen.has(id)) return;
            // 全局表里已有同名同键的，不重复列（保留全局表里的真实状态）
            if (seenKey.has(`${label}|${item.shortcut}`)) return;
            seen.add(id);
            rows.push({
                app,
                menu: MENU_KEYS[menuTitle] ? i18n.t(MENU_KEYS[menuTitle], menuTitle) : menuTitle,
                label,
                shortcut: item.shortcut,
                status: statusForShortcut(item.shortcut) || (item.disabled ? "planned" : "menu"),
            });
        });
    };
    Object.keys(SUB_MENUS).forEach((app) => {
        Object.keys(SUB_MENUS[app]).forEach((menuTitle) => collect(app, menuTitle, SUB_MENUS[app][menuTitle]));
    });
    DEFAULT_APP_MENU.forEach((menuTitle) => collect(null, menuTitle, DEFAULT_SUB_MENU[menuTitle]));
    listApps().forEach((rec) => {
        const fromManifest = getManifestMenus(rec.name);
        if (!fromManifest) return;
        fromManifest.order.forEach((menuTitle) => collect(rec.name, menuTitle, fromManifest.defs[menuTitle]));
    });
    return rows;
}

/**
 * 统一菜单来源解析：清单声明的顶层标题整组替换宿主默认集，未声明的标题保留。
 * 「只声明一个『文件』就只改『文件』」，插件不必为改一项而重抄七项菜单；
 * 宿主级的「应用 / 显示 / 窗口」仍由默认集提供，避免插件忘写导致窗口命令消失。
 * 「调试」不进任何一张菜单表，由 applyDeveloperMenu 按设置注入或摘除。
 * @returns {{order: string[], defs: Object}} 顶层菜单标题顺序与各项定义
 */
/**
 * FS-03 补充：把当前全屏空间里的窗口追加到「窗口」菜单末尾（macOS 在「窗口」
 * 菜单里列出各全屏空间，点一项即切过去）。没有全屏窗口时菜单保持一字不动。
 * @param {{order: string[], defs: Object}} menus applyDeveloperMenu 的结果
 * @returns {{order: string[], defs: Object}}
 */
function withSpacesMenu(menus) {
    const api = globalThis.__wmApi;
    if (!api || typeof api.spacesList !== "function" || !menus.defs["窗口"]) return menus;
    let list = [];
    try { list = api.spacesList(); } catch { return menus; }
    if (!list.length) return menus;
    const items = menus.defs["窗口"].slice();
    if (items.length && !items[items.length - 1].separator) items.push({ separator: true });
    list.forEach((space) => {
        items.push({ label: space.name, cmd: () => api.focusWindowById(space.id) });
    });
    return { order: menus.order, defs: { ...menus.defs, "窗口": items } };
}

function getMenusForApp(app) {
    const base = appMenu[app]
        ? { order: appMenu[app], defs: SUB_MENUS[app] || {} }
        : { order: DEFAULT_APP_MENU, defs: DEFAULT_SUB_MENU };
    const fromManifest = getManifestMenus(app);
    if (!fromManifest) return withSpacesMenu(applyDeveloperMenu(base.order, base.defs));
    const order = base.order.slice();
    const defs = { ...base.defs };
    fromManifest.order.forEach((title) => {
        defs[title] = fromManifest.defs[title];
        // 新标题插在末项（「帮助」）之前，保持 macOS 的菜单收尾习惯
        if (!order.includes(title)) order.splice(Math.max(order.length - 1, 0), 0, title);
    });
    return withSpacesMenu(applyDeveloperMenu(order, defs));
}

// P0-5：wifi 装饰图已移除（无监听的死图），真实 Wi-Fi 状态在控制中心面板
let appControl = ["switch.2", "magnifyingglass"];
// 临时元素：由 updateMenu 动态创建的顶栏菜单项与下拉子菜单 DOM
let tempMenuElements = [];

export const finderbar = document.getElementById("finderbar");

// 顶栏容器与日期控件（模块级，供 updateMenu / updateControl / updateTime 复用）
let appMenuContainer = null;
let appControlContainer = null;
let timeControl = null;
let dateControl = null;

// 防止模块因 URL 缓存戳不一致（index.html 带 ?v= 而内部 import 不带）
// 被浏览器当作两个模块重复执行，导致顶栏被渲染两份。
function initFinderbar() {
    if (finderbar.querySelector(".left") || finderbar.querySelector(".right")) {
        writeLog("warn", "已初始化过，跳过重复初始化");
        return;
    }

    appMenuContainer = document.createElement("div");
    appMenuContainer.classList.add("left");
    appMenuContainer.id = "left";
    finderbar.appendChild(appMenuContainer);
    appControlContainer = document.createElement("div");
    appControlContainer.classList.add("right");
    appControlContainer.id = "right";
    finderbar.appendChild(appControlContainer);

    const logoMenu = document.createElement("p");
    logoMenu.classList.add("logo");
    logoMenu.innerHTML = "";
    appMenuContainer.appendChild(logoMenu);
    timeControl = document.createElement("p");
    timeControl.classList.add("time");
    dateControl = document.createElement("p");
    dateControl.classList.add("date");
    // 时间/日期不写占位文本：下方 updateTime() 在首帧前同步渲染真实值。

    appControlContainer.appendChild(timeControl);
    appControlContainer.appendChild(dateControl);

    updateMenu("访达");
    updateControl();
    updateTime();
    scheduleClock();
    // addEventListener 而非 window.onload 赋值：client.js 也在 load 上挂处理器，
    // 两处都用赋值时后求值的会覆盖前一个，导致这里的菜单绑定永远不执行。
    window.addEventListener("load", resetMenuHandle);

    // 绑定菜单栏时间/日期点击弹出日历面板（独立模块）
    initDatetimePopover(timeControl, dateControl);

    // 在右侧状态栏挂载控制中心图标
    mountToFinderbar(appControlContainer, finderbar);

    registerSiriIcon();
}

/**
 * Siri 顶栏图标：冷加载约定（dev/devdoc/cold-load.md「启动时只注册清单」）——
 * finderbar 此前在页面加载即 import 其脚本（渲染层 + 设置联动数百行），
 * 每个新标签页都在为此付费。siri 已入 plugin-manager BUILTIN_IDS，
 * 首次点击图标时才 import 脚本；图标显示不等待任何脚本加载。
 *
 * 顶栏图标用彩色光球 `assets/icons/Siri-Orb.png`（SIRI_BAR_ICON，路径集中在 paths.js）。
 * 它与「应用/启动台图标」manifest.icon（mods/siri/Siri.png）是两张不同的图，
 * 宿主侧不写死插件路径；旧的单色 SVG glyph（assets/images/siri.svg）已彻底删除，不再引用。
 */
function registerSiriIcon() {
    registerFinderbarIcon({
        id: "siri",
        icon: SIRI_BAR_ICON,
        onClick: toggleSiri,
        order: -1, // 靠右优先（row-reverse 下负值 = 更靠右）
    });
}

let siriLoading = false;
function toggleSiri() {
    if (window.__siri) {
        window.__siri.toggle();
        return;
    }
    if (siriLoading) return; // 连点去重：脚本只 import 一次
    siriLoading = true;
    // 注意：finderbar.js 位于 src/javascripts/，需跳出两层到项目根再进 mods/
    import("../../mods/siri/script.js")
        .then(() => {
            if (window.__siri) window.__siri.toggle();
            else writeLog("warn", "Siri 脚本已加载但未暴露 window.__siri");
        })
        .catch((err) => writeLog("warn", "Siri 脚本加载失败", err))
        .finally(() => { siriLoading = false; });
}

let openingMenu = null;

/**
 * 根据字符串菜单键名生成 CSS class 名（去掉中文，使用拼音/英文替代）。
 * 例如："文件" → "file"，"历史记录" → "history"
 *
 * 顶栏段落会加上这个 class（resetMenuHandle 靠 `p.<class>` 反查父项），
 * 因此取值不得与全局样式选择器重名："窗口" 曾用 "window"，使顶栏段落命中
 * window.css 的 `.window`（绝对定位 + 入场动画），菜单项直接被推出可视区。
 */
const MENU_CLASS = {
    "应用": "appmenu", "文件": "file", "编辑": "edit", "显示": "view", "前往": "go",
    "窗口": "win", "帮助": "help", "历史记录": "history", "书签": "bookmarks",
    // 「调试」走兜底清洗也能得到合法 class（中文是合法 CSS 标识符），显式登记是为了
    // 与 resetMenuHandle 的选择器写法保持同一份事实来源，不必依赖清洗规则。
    [DEBUG_MENU_TITLE]: "debugmenu",
};

function menuKeyToClass(menuKey) {
    if (MENU_CLASS[menuKey]) return MENU_CLASS[menuKey];
    // manifest 自定义菜单标题是任意文本：剔除不能进 CSS class / querySelector
    // 的字符（空格、#、% 等），防止 classList.add 分裂成多个 class 导致绑定失效。
    // 中文字符是合法 CSS 标识符，保留。
    return String(menuKey).replace(/[^A-Za-z0-9_\u4e00-\u9fff-]/g, "-");
}

/** 是否显示快捷键提示（keyboard.menuShortcuts；定义尚未注册时按默认值显示）。 */
function shortcutHintsEnabled() {
    return settings.get("keyboard.menuShortcuts", true) !== false;
}

/**
 * 置灰菜单项的归类说明（F-05）。
 *
 * 为什么按文案归类而不是逐项写 reason：同一条文案在多个应用菜单里语义完全一致
 * （「撤销」在访达/计算器/商店都是"编辑命令未接入"），逐项标注只会制造 48 份重复。
 * type 决定首句（尚未实现 / 浏览器限制 / 当前不可用），noteKey 给出具体原因；
 * 帮助类菜单统一走「帮助手册正在接入」。
 */
const DISABLED_REASONS = {
    "打开": { type: "planned", noteKey: "menu.note.fileOps" },
    "新建": { type: "planned", noteKey: "menu.note.fileOps" },
    "保存": { type: "planned", noteKey: "menu.note.fileOps" },
    "打印": { type: "browser", noteKey: "menu.note.print" },
    "撤销": { type: "planned", noteKey: "menu.note.editOps" },
    "重做": { type: "planned", noteKey: "menu.note.editOps" },
    "剪切": { type: "planned", noteKey: "menu.note.editOps" },
    "拷贝": { type: "planned", noteKey: "menu.note.editOps" },
    "粘贴": { type: "planned", noteKey: "menu.note.editOps" },
    "全选": { type: "planned", noteKey: "menu.note.editOps" },
    "隐藏工具栏": { type: "planned", noteKey: "menu.note.toolbar" },
    "工具栏": { type: "planned", noteKey: "menu.note.toolbar" },
    "自定义工具栏...": { type: "planned", noteKey: "menu.note.toolbar" },
    "实用工具": { type: "context", noteKey: "menu.note.utilities" },
};

/** 三类原因的首句（键 + 中文兜底）。 */
const REASON_LABEL = {
    planned: ["menu.reason.planned", "尚未实现"],
    browser: ["menu.reason.browser", "浏览器限制"],
    context: ["menu.reason.context", "当前不可用"],
};

/** 按菜单项文案取原因；帮助类统一归到「帮助手册正在接入」。 */
function reasonFor(item) {
    if (item.reason) return item.reason;
    const label = String(item.label || "");
    if (label.includes("帮助")) return { type: "planned", noteKey: "menu.note.help" };
    return DISABLED_REASONS[label] || { type: "planned", noteKey: "menu.note.fileOps" };
}

/** 悬浮说明单例：挂在 body 上（.menu 有 overflow:hidden，放菜单里会被裁掉）。 */
let reasonHintEl = null;
function ensureReasonHint() {
    if (reasonHintEl) return reasonHintEl;
    reasonHintEl = document.createElement("div");
    reasonHintEl.id = "deskly-menu-reason";
    reasonHintEl.setAttribute("role", "tooltip");
    reasonHintEl.hidden = true;
    document.body.appendChild(reasonHintEl);
    return reasonHintEl;
}

function hideReasonHint() {
    if (reasonHintEl) reasonHintEl.hidden = true;
}

/**
 * 在目标菜单项旁显示原因说明；下方放不下时翻到上方，左右不出视口。
 * @param {HTMLElement} target 置灰菜单项
 * @param {{type:string, noteKey:string}} reason 原因
 */
function showReasonHint(target, reason) {
    const el = ensureReasonHint();
    const [labelKey, labelFallback] = REASON_LABEL[reason.type] || REASON_LABEL.planned;
    const head = i18n.t(labelKey, labelFallback);
    const note = reason.noteKey ? i18n.t(reason.noteKey, "") : "";
    el.textContent = note ? `${head} · ${note}` : head;
    el.hidden = false;
    const rect = target.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

// 菜单外的点击 / Esc / 窗口失焦都要收起说明，避免它跟着菜单留在屏幕上。
document.addEventListener("click", hideReasonHint, true);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideReasonHint();
}, true);
window.addEventListener("blur", hideReasonHint);

/**
 * 生成一条菜单项：文本 + 右对齐的快捷键提示。
 *
 * shortcut 过去只被读取、从不渲染，是个纯粹的占位字段。这里把它显示出来，
 * 但要注意：**显示不等于已绑定**。全站真正接了按键的只有 ⌃⌘F（window.js 里
 * 显式监听）与红绿灯/弹层自己的几个键；⌘W、⌘M 一类是浏览器保留快捷键，
 * 新标签页收不到。因此这些提示的作用与 macOS 上一样是「照着按」的视觉约定，
 * 用 keyboard.menuShortcuts 可以整组关掉，不想要假提示的用户能关掉它。
 *
 * 布局用行内样式而不是新建样式表：`.menu p` 的字号/配色来自 ui.css 的既有规则，
 * 这里只加一条横向 flex 与右推，不新增任何选择器，也就不与别的层的规则打架。
 * @param {object} item 菜单项定义
 * @returns {HTMLElement} 菜单项段落
 */
/**
 * 当前顶层窗口的状态快照（FS-12/13 的菜单文案与禁用态判据）。
 * window-manager 未求值时按无窗口处理。
 */
function topWindowState() {
    const wm = window.__wmApi;
    if (!wm || typeof wm.getTopWindow !== "function" || typeof wm.stateOf !== "function") return null;
    const top = wm.getTopWindow();
    return top ? wm.stateOf(top) : null;
}

function buildMenuItem(item) {
    const p = document.createElement("p");
    p.style.cssText = "display:flex;align-items:center;";
    const label = document.createElement("span");
    label.className = "label";
    // FS-12：菜单文案随窗口状态切换（进入/退出全屏幕）
    let text = item.i18nKey ? i18n.t(item.i18nKey, item.label) : item.label;
    if (item.cmd === "toggleActiveWindowFullscreen()") {
        const top = topWindowState();
        if (top && top.fullscreen) text = i18n.t("window.exitFullscreen", "退出全屏");
    }
    // FS-13：全屏空间内没有平铺/缩放概念，相应项置灰（保留「退出全屏」可用）
    if (/^tileActiveWindow\(|^toggleActiveWindowStretch\(\)/.test(item.cmd || "")) {
        const top = topWindowState();
        if (top && top.fullscreen) item = { ...item, disabled: true };
    }
    label.textContent = text;
    p.appendChild(label);
    if (item.shortcut && shortcutHintsEnabled()) {
        const hint = document.createElement("span");
        hint.className = "shortcut";
        hint.textContent = item.shortcut;
        hint.style.cssText = "margin-left:auto;padding-left:18px;font-size:12px;opacity:.6;white-space:nowrap;";
        // 浏览器保留键：菜单仍显示原键位（与 macOS 一致），但加虚线并在 title 里说明只能从菜单点。
        if (statusForShortcut(item.shortcut) === "reserved") {
            hint.classList.add("shortcut--reserved");
            hint.title = `${tierText("reserved", i18n.t.bind(i18n))}：页面收不到该组合键，请从菜单执行`;
        }
        p.appendChild(hint);
    }
    if (item.disabled) {
        p.setAttribute("disabled", "disabled");
        p.setAttribute("aria-disabled", "true");
        // 置灰项也要能被键盘聚焦：焦点落在它身上时同样弹出原因说明。
        p.tabIndex = 0;
        const reason = reasonFor(item);
        p.dataset.reason = reason.type;
        p.addEventListener("mouseenter", () => showReasonHint(p, reason));
        p.addEventListener("mouseleave", hideReasonHint);
        p.addEventListener("focus", () => showReasonHint(p, reason));
        p.addEventListener("blur", hideReasonHint);
    }
    if (!item.disabled && item.cmd) {
        p.addEventListener("click", (e) => {
            e.stopPropagation();
            // 与静态菜单项（ui/menu.js clickMenuItem）同一条路径：先关菜单再执行，
            // 不触发菜单重建的命令（前往文件夹等）执行完菜单不能悬留（BUG-03）。
            closeAllMenus();
            dispatchMenuCommand(item.cmd);
        });
    }
    return p;
}

/**
 * 根据活动应用名动态构建该应用的全部子菜单（div.menu）并挂载到 body。
 * 同时返回生成的 DOM 数组，用于下次切换时销毁。
 *
 * @param {string} app  应用显示名，如 "App Store"
 * @returns {HTMLElement[]} 新建的子菜单 DOM 元素
 */
function buildSubMenusForApp(app) {
    const created = [];
    const { order: menus, defs } = getMenusForApp(app);
    menus.forEach((menuKey) => {
        const sub = document.createElement("div");
        sub.className = "menu";
        sub.setAttribute("menu", menuKeyToClass(menuKey));
        sub.setAttribute("app", app);

        const items = defs[menuKey] || [];
        items.forEach((item) => {
            if (item.separator) {
                sub.appendChild(document.createElement("hr"));
                return;
            }
            sub.appendChild(buildMenuItem(item));
        });
        document.body.appendChild(sub);
        created.push(sub);
    });
    return created;
}

/**
 * 执行菜单项命令的能力已统一到 ui/menuCommands.js（无 eval 的注册表分发）。
 * 本模块只负责把命令实现挂到 window.__menuActions 上。
 */

// 子菜单异步构建序号：快速切换应用时作废过期构建，防止旧子菜单残留或覆盖新菜单
let menuBuildSeq = 0;

/**
 * 切出顶栏与下拉菜单：
 * 1. 销毁上一次动态生成的顶栏段落（tempMenuElements）。
 * 2. 重新生成当前 app 的顶栏段落与对应子菜单。
 * 3. 为顶栏段落绑定点击事件（控制对应子菜单显隐）。
 *
 * 性能优化：应用名与顶层菜单项同步渲染（用户立即可见）；
 * 子菜单 DOM（buildSubMenusForApp 约 40 个节点 + 事件绑定）改到空闲期构建，
 * 是初始化长任务的主要来源，延迟执行避免阻塞主线程。
 */
export function updateMenu(app) {
    // 任意应用都要出菜单：manifest.menus 声明 > 硬编码表 > 通用默认集，
    // 绝不再对表外应用直接早退（那会让菜单栏停留在这之前应用上）。
    const { order: menuOrder } = getMenusForApp(app);
    // 清理旧的顶层菜单段落（同步，立即生效）
    tempMenuElements.forEach((ele) => ele?.parentNode?.removeChild(ele));
    tempMenuElements = [];

    // 应用名（同步渲染；应用名可能是 ZIP 插件的 manifest 名称，走 textContent 防注入）
    // 入参 app 是**菜单表的键**（getMenusForApp 拿它查 appMenu[app]），不是显示文案，
    // 所以绝不能在调用方翻译 —— 传 "Finder" 进去会查不到「访达」那一行、
    // 掉进 DEFAULT_APP_MENU，应用自己的「文件 / 前往」菜单就没了。
    // 翻译只在这一处：displayNameFor 只对内核 `apps.*` 里登记过的内置应用生效，
    // 第三方插件名没有词条就原样输出，由插件自己作名，内核不越权改。
    let appMenuElement = document.createElement("p");
    appMenuElement.textContent = displayNameFor(app);
    // 表键必须单独存一份：currentMenuApp() 是把这里的文本回灌给 updateMenu 当键用的
    // （rebuildMenus 走这条链），标签一旦翻译过，键就查不到 appMenu[app]，
    // 非中文语言下设置一变、菜单就整体掉进 DEFAULT_APP_MENU。
    appMenuElement.dataset.appKey = app;
    appMenuElement.classList.add("appname");
    appMenuContainer.appendChild(appMenuElement);
    tempMenuElements.push(appMenuElement);

    // 顶层菜单项（同步渲染，用户立即可见）
    menuOrder.forEach((menu) => {
        let nowMenu = document.createElement("p");
        nowMenu.textContent = MENU_KEYS[menu] ? i18n.t(MENU_KEYS[menu], menu) : menu;
        nowMenu.classList.add(menuKeyToClass(menu));
        appMenuContainer.appendChild(nowMenu);
        tempMenuElements.push(nowMenu);
    });

    // 子菜单 DOM（空闲构建）：期间若切换了应用，seq 不匹配则丢弃本次构建
    const seq = ++menuBuildSeq;
    scheduleIdle(() => {
        if (seq !== menuBuildSeq) return;
        const subMenus = buildSubMenusForApp(app);
        subMenus.forEach(m => tempMenuElements.push(m));
        resetMenuHandle();
    });
    // 同步绑定静态菜单（logo / appname）的段落显隐，避免空闲构建前出现交互空窗；
    // parentMenu.onclick 直接赋值，空闲期重复调用幂等，无重复监听。
    resetMenuHandle();
}

/** 当前顶栏显示菜单的应用名（无菜单段落时返回空串）。
 *  返回的是**菜单表的键**，不是屏幕上那行字 —— 标签会被 APP_NAME_KEYS 翻译，
 *  而调用方（rebuildMenus → updateMenu）要拿它去查 appMenu[app]。 */
function currentMenuApp() {
    const label = appMenuContainer && appMenuContainer.querySelector("p.appname");
    if (!label) return "";
    return label.dataset ? (label.dataset.appKey || label.textContent) : label.textContent;
}

/**
 * 按当前设置重建顶栏与子菜单：快捷键提示开关、「调试」可见性都只改这张表的外部条件，
 * 菜单 DOM 是一次性构建的，所以必须重走 updateMenu 才能反映出来。
 */
function rebuildMenus() {
    const app = currentMenuApp();
    if (app) updateMenu(app);
}

// 同一次设置变更里，owner 的 window 事件与 settings-changed 会先后到达，
// 用一帧内的合流去重，避免菜单被重建两次（重建会重挂 40+ 节点与监听）。
let menuRebuildQueued = false;
function requestMenuRebuild(reason) {
    writeLog("debug", `菜单待重建：${reason}`, { developerMode: isDeveloperMode() });
    if (menuRebuildQueued) return;
    menuRebuildQueued = true;
    const flush = () => {
        menuRebuildQueued = false;
        rebuildMenus();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 0);
}

// 开发者模式（debug.developerMode）与快捷键提示（keyboard.menuShortcuts）变更：
// 既听 owner 生效函数广播的 window 事件，也听设置中枢的统一变更事件，任一条到达都要重建。
window.addEventListener("debug-menu-visibility-change", () => requestMenuRebuild("debug-menu-visibility-change"));
window.addEventListener("keyboard-shortcut-hints-change", () => requestMenuRebuild("keyboard-shortcut-hints-change"));
document.addEventListener("settings-changed", (event) => {
    const key = event.detail && event.detail.key;
    if (key === "debug.developerMode" || key === "keyboard.menuShortcuts") {
        requestMenuRebuild(`settings-changed:${key}`);
    }
});

// 语言切换时刷新当前应用菜单与日期文本（日期按新语言重排格式）
window.addEventListener("languagechange", () => {
    const activeApp = document.querySelector("#finderbar p.appname");
    if (activeApp) {
        // 必须用 dataset.appKey 而不是 textContent：这条正是「重译标签」的入口，
        // 而此刻标签上已经是**旧语言**的译文（"Finder"），拿它当键去查
        // appMenu["访达"] 必然落空、整个菜单掉进 DEFAULT_APP_MENU。
        updateMenu(activeApp.dataset ? (activeApp.dataset.appKey || activeApp.textContent) : activeApp.textContent);
    }
    lastTimeKey = ""; // 跳过去重，强制重写日期/时间文本
    buildDateFormatters();
    updateTime();
});

// FS-12/13：全屏进出后重建当前应用菜单（「进入/退出全屏」文案与平铺项禁用态随状态切换）。
document.addEventListener("window:fullscreen", () => {
    const activeApp = document.querySelector("#finderbar p.appname");
    if (activeApp) {
        updateMenu(activeApp.dataset ? (activeApp.dataset.appKey || activeApp.textContent) : activeApp.textContent);
    }
});

function updateControl() {
    appControl.forEach((control) => {
        let nowControl = document.createElement("img");
        nowControl.src = assetPath(`images/${control}.svg`);
        appControlContainer.appendChild(nowControl);
    });
}

// ---- 插件顶栏图标注册接口：允许插件动态注册/注销右侧自定义图标 ----

/**
 * 插件图标注册表：id → { icon, onClick, order, element }
 * @type {Map<string, object>}
 */
const pluginIcons = new Map();

/** 占位容器：所有插件图标统一插入此容器，置于时间控件之前 */
let pluginIconContainer = null;

/**
 * 确保 pluginIconContainer 存在且位于 timeControl 之前。
 * 仅在首次注册或容器丢失时创建。
 */
function _ensurePluginIconContainer() {
    if (pluginIconContainer && pluginIconContainer.parentNode === appControlContainer) return;
    pluginIconContainer = document.createElement("div");
    pluginIconContainer.classList.add("plugin-icons");
    // 插入到时间控件之前（系统内置图标之后）
    if (timeControl && timeControl.parentNode === appControlContainer) {
        appControlContainer.insertBefore(pluginIconContainer, timeControl);
    } else {
        appControlContainer.appendChild(pluginIconContainer);
    }
}

/**
 * 按 order 升序重排 pluginIconContainer 内的图标元素。
 */
function _sortPluginIcons() {
    if (!pluginIconContainer) return;
    const entries = Array.from(pluginIcons.values()).sort((a, b) => a.order - b.order);
    entries.forEach(entry => {
        if (entry.element && entry.element.parentNode === pluginIconContainer) {
            pluginIconContainer.appendChild(entry.element);
        }
    });
}

/**
 * 注册一个插件顶栏图标。
 *
 * @param {object} config
 * @param {string} config.id       - 唯一标识（如 "siri"），重复注册会先注销旧的
 * @param {string} config.icon     - 图标源：SVG 文件路径、DataURL 或 HTML 字符串（<svg>...</svg>）
 * @param {Function} config.onClick - 点击回调
 * @param {number}   [config.order=0] - 排序权重，越小越靠左
 * @returns {boolean} 是否成功注册
 */
export function registerFinderbarIcon({ id, icon, onClick, order = 0 }) {
    if (!id || !icon) {
        writeLog("warn", "registerFinderbarIcon 缺少 id 或 icon");
        return false;
    }

    // 先注销同名旧图标
    if (pluginIcons.has(id)) {
        unregisterFinderbarIcon(id);
    }

    _ensurePluginIconContainer();

    let el;
    if (icon.trim().startsWith("<")) {
        // HTML 字符串（如内联 SVG）
        el = document.createElement("span");
        el.innerHTML = icon;
        el.classList.add("plugin-icon", "plugin-icon-html");
        el.dataset.pluginIconId = id;
    } else {
        // 路径 / DataURL
        el = document.createElement("img");
        el.src = icon;
        el.classList.add("plugin-icon", "plugin-icon-img");
        el.dataset.pluginIconId = id;
        el.alt = id;
    }

    el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof onClick === "function") onClick(e);
    });

    pluginIconContainer.appendChild(el);
    pluginIcons.set(id, { icon, onClick, order, element: el });
    _sortPluginIcons();

    writeLog("info", `插件图标已注册：${id}`, { order });
    return true;
}

/**
 * 注销一个插件顶栏图标。
 *
 * @param {string} id - 注册时的唯一标识
 * @returns {boolean} 是否找到并移除
 */
export function unregisterFinderbarIcon(id) {
    const entry = pluginIcons.get(id);
    if (!entry) return false;

    if (entry.element && entry.element.parentNode) {
        entry.element.parentNode.removeChild(entry.element);
    }
    pluginIcons.delete(id);

    // 容器为空时不移除，保留占位避免频繁创建
    writeLog("info", `插件图标已注销：${id}`);
    return true;
}

export let parentMenuStates = {};

/**
 * 关闭所有下拉菜单并清除激活态。
 */
export function closeAllMenus() {
    document.querySelectorAll("div.menu:not(.contextmenu)").forEach((subMenu) => {
        subMenu.classList.remove("visible");
        parentMenuStates[`${subMenu.getAttribute("menu")}_${subMenu.getAttribute("app")}`] = false;
        setTimeout(() => { subMenu.style.transition = "none"; }, 300);
    });
    document.querySelectorAll("#finderbar p.active").forEach((p) => p.classList.remove("active"));
    openingMenu = null;
    hideReasonHint();
}

/**
 * 重新绑定所有子菜单与其父段落的点击。
 */
function resetMenuHandle() {
    let subMenus = document.querySelectorAll("div.menu:not(.contextmenu)");

    subMenus.forEach(subMenu => {
        const subApp = subMenu.getAttribute("app");
        // 身份比对必须用 dataset.appKey（中文身份键），不能拿译后显示名当键（BUG-01）：
        // innerHTML 是 displayNameFor 的译文，英文界面下与 app 属性永不相等，
        // 整个下拉菜单绑定被 return 跳过。
        const appEl = document.querySelector("#finderbar p.appname");
        const curApp = appEl && appEl.dataset ? (appEl.dataset.appKey || "") : "";
        const nomatch = subMenu.getAttribute("nomatchapp");
        if (curApp && curApp !== subApp) {
            if (!nomatch) return;
        }

        let parentMenu = document.querySelector(`#finderbar p.${subMenu.getAttribute("menu")}`);
        if (!parentMenu) return;

        const menuKey = `${subMenu.getAttribute("menu")}_${subMenu.getAttribute("app")}`;
        parentMenuStates[menuKey] = false;
        const newHandler = function (e) {
            e.stopPropagation();

            if (parentMenuStates[menuKey] === false) {
                if (openingMenu && openingMenu !== subMenu) {
                    closeAllMenus();
                }

                subMenu.classList.add("visible");
                parentMenu.classList.add("active");
                subMenu.style.left = `${parentMenu.offsetLeft}px`;
                subMenu.style.top = "25px";
                parentMenuStates[menuKey] = true;

                setTimeout(() => {
                    subMenu.style.transition = "opacity 0.15s ease";
                    openingMenu = subMenu;
                }, 50);
            } else {
                closeAllMenus();
            }
        };

        parentMenu.onclick = newHandler;
    });
}

document.addEventListener("click", () => {
    closeAllMenus();
});

// 菜单打开/点击时动态提升层级：捕获阶段监听可穿透菜单项的 stopPropagation，
// 确保当前菜单盖过之前残留的同级菜单与高 z-index 窗口（窗口递增后可能超过 7000）。
document.addEventListener("click", (e) => {
    const menu = e.target.closest && e.target.closest(".menu");
    if (menu) bringToFront(menu);
}, true);

// 上次渲染的时间键：文本按当前设置的最细粒度（分或秒）去重，同一粒度内不重复写 DOM，
// 免得每秒两次重写带来布局与 GC 开销。键含格式与语言码：改设置或切语言后立即重渲染。
let lastTimeKey = "";

/** 宽容的布尔读法：定义表尚未注册时，存储里存的是 "on"/"off" 裸串而不是布尔。 */
function flagOn(key, fallback) {
    const value = settings.get(key, fallback);
    if (typeof value === "boolean") return value;
    if (value === "on" || value === "true" || value === "1") return true;
    if (value === "off" || value === "false" || value === "0") return false;
    return Boolean(value);
}

/** 顶栏时钟的两项设置：general.timeFormat 与 general.showSeconds。 */
function clockFormat() {
    return {
        format: settings.get("general.timeFormat", "24h") === "12h" ? "12h" : "24h",
        seconds: flagOn("general.showSeconds", false),
    };
}

/**
 * 生成顶栏时间文本。
 * 24 小时制保留原有的全角冒号写法；12 小时制用半角冒号并把上午/下午交给 i18n，
 * 因为 dayPeriod 在各语言里形态差别很大（en「AM/PM」、ja「午前/午後」、zh「上午/下午」），
 * 写死英文会在中文界面上露怯。
 * @param {Date} now 当前时间
 * @returns {string} 时间文本
 */
function formatClock(now) {
    const { format, seconds } = clockFormat();
    const pad = (n) => String(n).padStart(2, "0");
    const minute = pad(now.getMinutes());
    if (format === "12h") {
        const hour = now.getHours() % 12 || 12;
        const dayPeriod = now.getHours() < 12
            ? i18n.t("datetime.am", "AM")
            : i18n.t("datetime.pm", "PM");
        return `${hour}:${minute}${seconds ? `:${pad(now.getSeconds())}` : ""} ${dayPeriod}`;
    }
    return `${pad(now.getHours())}：${minute}${seconds ? `：${pad(now.getSeconds())}` : ""}`;
}

// 菜单栏日期格式化器：星期与月日按当前语言交给 Intl 内置数据，
// 不再手写中文星期数组与 "月/日" 拼接（萌猫语言以中文为基底，映射 zh-CN）。
const INTL_LOCALES = { "zh-CN": "zh-CN", "en": "en-US", "ja-JP": "ja-JP", "cat": "zh-CN" };
let weekdayFmt = null;
let monthDayFmt = null;
function buildDateFormatters() {
    const make = (locale) => ({
        weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }),
        monthDay: new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }),
    });
    const locale = INTL_LOCALES[i18n.getLanguage()] || "zh-CN";
    let fmts;
    try {
        fmts = make(locale);
    } catch (_) {
        // 语言码不在映射表且不是合法 BCP-47 标签时回退中文
        fmts = make("zh-CN");
    }
    weekdayFmt = fmts.weekday;
    monthDayFmt = fmts.monthDay;
}

function updateTime() {
    if (!timeControl || !dateControl) return;
    if (!weekdayFmt) buildDateFormatters();
    const now = new Date();
    const { format, seconds } = clockFormat();
    const granularity = seconds ? String(now.getSeconds()) : "0";
    const key = `${now.getFullYear()}:${now.getMonth()}:${now.getDate()}:`
        + `${now.getHours()}:${now.getMinutes()}:${granularity}:${format}:${seconds}:${i18n.getLanguage()}`;
    if (key === lastTimeKey) return;
    lastTimeKey = key;
    dateControl.textContent = `${monthDayFmt.format(now)} ${weekdayFmt.format(now)}`;
    timeControl.textContent = formatClock(now);
}

/**
 * 下一次时钟刷新延迟：显示秒时对齐到整秒，否则对齐到下一分钟边界（+1s 冗余避开竞态）。
 * 秒开关一变就要重排（见下方 datetime-format-change 监听），否则要么停摆要么空转。
 * @returns {number} 毫秒
 */
function nextClockDelay() {
    return clockFormat().seconds
        ? 1000 - (Date.now() % 1000)
        : 60000 - (Date.now() % 60000) + 1000;
}

// 时钟定时：不用每 1s 的 setInterval 空转（updateTime 内部已按最细粒度去重，
// 旧实现每小时空跑 ~3600 次只为确认「没变」）。改为自续 setTimeout 精确对齐边界，
// 标签页隐藏时挂起、切回时立即校正一次再续排——
// 后台冻结时浏览器本就会节流/暂停 setTimeout，切回可见再补一次能避免时间戳停留在冻结瞬间。
let clockTimer = null;
function scheduleClock() {
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = setTimeout(() => { updateTime(); scheduleClock(); }, nextClockDelay());
}

// 时间格式 / 显示秒 / 周起始日变更（general.* 的生效函数广播）：
// 强制重写一次文本，并按新粒度重排定时器；日期格式化器与语言无关，不用重建。
window.addEventListener("datetime-format-change", () => {
    lastTimeKey = "";
    updateTime();
    scheduleClock();
    writeLog("info", "顶栏时钟按新的时间设置重排", clockFormat());
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; }
    } else {
        updateTime();
        scheduleClock();
    }
});

// 调试后端先于首次菜单构建：initDebug 注册 debug.developerMode 与「调试」菜单的命令，
// updateMenu 在构建菜单时要读 isDeveloperMode()，顺序颠倒会让首屏少一个菜单。
initDebug();
initFinderbar();

// ---- 菜单命令实现：挂在 window.__menuActions 上，供 dispatchMenuCommand 分发 ----

/**
 * 使用手册的目标位置：帮助菜单只写一个键，章节号与小节标题集中在这里。
 * 小节用「标题包含」匹配，索引重排也不会跳错（解析在 mods/manual/script.js）。
 */
const MANUAL_TARGETS = {
    home: { chapter: "07", section: "使用《Mac 使用手册》" },
    finder: { chapter: "03", section: "访达" },
    settings: { chapter: "04", section: "系统设置" },
    calculator: { chapter: "06", section: "在 iMac 上使用 App" },
    appstore: { chapter: "06", section: "获取更多 App" },
};

/**
 * 打开「Mac 使用手册」并跳到帮助菜单对应的章节。
 * 手册是插件，首次打开要等外壳与脚本就位；这里轮询中栏出现条目后再派发，
 * 固定延时在慢机器上会赶在监听注册之前（设置面板深链踩过同一个坑）。
 * @param {string} target MANUAL_TARGETS 的键
 * @returns {void}
 */
function openManual(target = "home") {
    const dest = MANUAL_TARGETS[target] || MANUAL_TARGETS.home;
    openAppByName("Mac 使用手册");
    const jump = () => document.dispatchEvent(new CustomEvent("manual-open", { detail: dest, bubbles: true }));
    let tries = 0;
    const tick = () => {
        if (document.querySelector(".manual__chapters .manual__row")) { setTimeout(jump, 60); return; }
        if (tries++ < 50) setTimeout(tick, 100);
    };
    tick();
}

/** 开关启动台：插件已加载则驱动其暴露的状态机，未加载则按应用名打开（首次按键也能用）。 */
function toggleLaunchpad() {
    const lp = window.__launchpad;
    if (lp && typeof lp.isOpen === "function") {
        if (lp.isOpen()) { lp.close(); return; }
        const light = document.querySelector('#dock .container[data-app="启动台"] .light');
        lp.open(light);
        return;
    }
    openAppByName("启动台");
}

/** 根据应用显示名启动该应用（用于「文件 → 新建访达窗口」等）。 */
function openAppByName(name) {
    // 全部应用现均经插件注册表解析（Safari 已迁为插件，assets/apps/ 目录已清空）；
    // 旧的 `moduleItems.create('./assets/apps/<name>.html')` 回退分支会去 fetch
    // 一个根本不存在的路径、弹出假 404，故删除。未注册的应用名不再处理。
    if (window.__getPluginByName) {
        const plugin = window.__getPluginByName(name);
        if (plugin) {
            Promise.all([import("./plugin-manager.js"), import("./app-registry.js")])
                .then(async ([pm, registry]) => {
                    // 系统设置 / App Store 被禁用后从程序坞与启动台消失，但苹果菜单是
                    // 常驻入口：在这里提供「重新启用并打开」，避免两个都禁用后无路可走。
                    if (!registry.isPluginEnabled(plugin.id)) {
                        const dialog = window.__dialog;
                        if (!dialog || typeof dialog.confirm !== "function") return;
                        const ok = await dialog.confirm("应用已禁用", `「${name}」已禁用。要重新启用并打开吗？`);
                        if (!ok) return;
                        const { setEnabled } = await import("./store-api.js");
                        const res = setEnabled(plugin.id, true);
                        if (!res.ok) { dialog.alert("无法启用", res.reason || ""); return; }
                    }
                    // 用 openApp 而非 load：按名称解析 appId，
                    // 多应用插件的子应用（如「文稿」）才不会永远落到套件的首个应用。
                    pm.openApp(name, { centered: true });
                })
                .catch((err) => writeLog("error", `按名称启动应用失败：${name}`, err));
        }
    }
}

/**
 * 对当前活动（最靠上的可见）窗口执行一条窗口命令。
 *
 * 旧实现按「实例上的私有方法名字符串」查找（runOnTopWindow("_closeWindow")），
 * 命令名与窗口实现就此脱钩：改名不报错、点了没反应。现在直接取 window-manager
 * 的具名 API，编译期就能对上。getTopWindow 已过滤最小化 / 关闭中的窗口，
 * 菜单命令不会作用到用户根本看不见的窗口上。
 * @param {(wm:object, win:HTMLElement)=>void} apply 命令
 */
function runOnTopWindow(apply) {
    import("./window.js").then((wm) => {
        const top = wm.getTopWindow();
        if (top) apply(wm, top);
    });
}

/** 关闭当前活动（z-index 最高）的窗口。 */
function closeActiveWindow() { runOnTopWindow((wm, top) => wm.closeWindow(top)); }
/** 切换当前活动窗口的全屏（覆盖整块视口）。 */
function toggleActiveWindowFullscreen() { runOnTopWindow((wm, top) => wm.toggleFullscreen(top)); }
/** 切换当前活动窗口的缩放态（填充菜单栏与程序坞之间的可视区）。 */
function toggleActiveWindowStretch() { runOnTopWindow((wm, top) => wm.toggleStretch(top)); }
/** 最小化 / 还原当前活动窗口（顶栏菜单「窗口 → 最小化」统一入口）。 */
function minimizeActiveWindow() { runOnTopWindow((wm, top) => wm.toggleMinimize(top)); }
/** 将当前活动窗口平铺到指定区域。 */
function tileActiveWindow(region) { runOnTopWindow((wm, top) => wm.tile(top, region)); }

function findWindowById(id) {
    return document.getElementById(id);
}

function safariNewTab() {
    const win = findWindowById('Safari浏览器');
    if (win && win._safariNewTab) win._safariNewTab();
}

function safariCloseTab() {
    const win = findWindowById('Safari浏览器');
    if (win && win._safariCloseTab) win._safariCloseTab();
}

function safariShowHistory() {
    const win = findWindowById('Safari浏览器');
    if (win && win._safariShowHistory) win._safariShowHistory();
}

function safariToggleBookmark() {
    const win = findWindowById('Safari浏览器');
    if (win && win._safariToggleBookmark) win._safariToggleBookmark();
}

function safariClearHistory() {
    const win = findWindowById('Safari浏览器');
    if (win && win._safariClearHistory) win._safariClearHistory();
}

/** 统一转发到 Safari 窗口暴露的方法；窗口不存在时静默忽略。 */
function safariCall(method) {
    const win = findWindowById('Safari浏览器');
    if (win && typeof win[method] === 'function') win[method]();
}

function safariShowBookmarks() { safariCall('_safariShowBookmarks'); }
function safariShowReadingList() { safariCall('_safariShowReading'); }
function safariToggleSidebar() { safariCall('_safariToggleSidebar'); }
function safariShowStartPage() { safariCall('_safariShowStartPage'); }
function safariReload() { safariCall('_safariReload'); }
function safariGoBack() { safariCall('_safariGoBack'); }
function safariGoForward() { safariCall('_safariGoForward'); }
function safariZoomIn() { safariCall('_safariZoomIn'); }
function safariZoomOut() { safariCall('_safariZoomOut'); }
function safariZoomReset() { safariCall('_safariZoomReset'); }
function safariTabOverview() { safariCall('_safariToggleTabOverview'); }
function safariShare() { safariCall('_safariShare'); }
function safariOpenExternal() { safariCall('_safariOpenExternal'); }
function safariAddReading() { safariCall('_safariAddReading'); }
function safariReopenClosedTab() { safariCall('_safariReopenClosedTab'); }
function safariFocusAddress() { safariCall('_safariFocusAddress'); }

/**
 * 将全部可见窗口按层级依次置顶一遍（模拟 macOS「前置全部窗口」）。
 * 排序与最小化过滤都交给窗口管理器，这里不再自己按 z-index 捞一遍 DOM。
 */
function bringAllWindowsToFront() {
    import("./window.js").then((wm) => wm.bringAllWindowsToFront());
}

/**
 * 清倒废纸篓（P0-4）：真实删除 /废纸篓 内的全部条目，带确认；权限未批时如实提示。
 */
async function emptyTrash() {
    const dialog = window.__dialog;
    if (dialog && typeof dialog.confirm === "function") {
        const ok = await dialog.confirm(
            i18n.t("finder.emptyTrash", "清倒废纸篓…"),
            i18n.t("finder.emptyTrashConfirm", "废纸篓里的项目将被永久删除，无法撤销。"),
            { danger: true });
        if (!ok) return;
    }
    const { emptyTrash: emptyAll } = await import("./trash.js");
    const r = await emptyAll().catch((err) => {
        // 权限没批：弹重新授权说明，不装作清掉了
        if (err && err.name === "NeedsReauthError") {
            window.__dialog?.error?.(
                i18n.t("finder.title", "访达"),
                i18n.t("finder.auth.needsReauth", "根目录的读写权限需要重新授权，在此之前访达动不了里面的文件。"));
            return { ok: false };
        }
        throw err;
    });
    if (!r || !r.ok) return;
    const tip = document.querySelector(".tip");
    if (tip) {
        tip.textContent = i18n.t("finderbar.trashEmptied", "废纸篓已清倒");
        tip.style.opacity = 1;
        setTimeout(() => { tip.style.opacity = 0; }, 1200);
    }
}

/**
 * 向访达窗口发送命令事件。
 * @param {string} command 命令名
 * @param {object} [args] 参数
 */
function dispatchFinderCommand(command, args) {
    const finderEl = document.getElementById('访达');
    if (!finderEl) return;
    finderEl.dispatchEvent(new CustomEvent('finder-command', {
        detail: { command, args },
        bubbles: true,
    }));
}

/**
 * 切换访达视图模式。
 * @param {string} mode icon | list | column | gallery
 */
function finderViewMode(mode) {
    dispatchFinderCommand('view-mode', { mode });
}

/**
 * 导航访达到指定路径。
 * @param {string} path
 */
function finderNavigate(path) {
    dispatchFinderCommand('navigate', { path });
}

/**
 * 切换访达标签栏显示。
 */
function finderToggleTabBar() {
    dispatchFinderCommand('toggle-tab-bar');
}

/**
 * 前往文件夹（弹窗输入路径）。
 */
function finderGoToFolder() {
    dispatchFinderCommand('go-to-folder');
}

/**
 * 新建文件夹（访达内）。
 */
function finderNewFolder() {
    dispatchFinderCommand('new-folder');
}

/**
 * 显示简介（访达内，⌘I）：交给访达窗口按当前选中项打开内核的单例简介面板。
 */
function finderShowInfo() {
    dispatchFinderCommand('get-info');
}

// 导出到全局，供 ui/menuCommands.js 按命令名分发（不做代码求值，命令即注册表键名）。
// 用合并而不是整体赋值：debug.js 在更早的时机往同一张表里并进了「调试」菜单的命令，
// 覆盖式赋值会把它们抹掉（菜单还在、点击报「命令未注册」）。
window.__menuActions = {
    ...(window.__menuActions || {}),
    ...SESSION_ACTIONS,
    openAppByName,
    openManual,
    toggleLaunchpad,
    closeActiveWindow,
    toggleActiveWindowFullscreen,
    toggleActiveWindowStretch,
    minimizeActiveWindow,
    tileActiveWindow,
    bringAllWindowsToFront,
    emptyTrash,
    finderViewMode,
    finderNavigate,
    finderToggleTabBar,
    finderGoToFolder,
    finderNewFolder,
    finderShowInfo,
    safariNewTab,
    safariCloseTab,
    safariShowHistory,
    safariToggleBookmark,
    safariClearHistory,
    safariShowBookmarks,
    safariShowReadingList,
    safariToggleSidebar,
    safariShowStartPage,
    safariReload,
    safariGoBack,
    safariGoForward,
    safariZoomIn,
    safariZoomOut,
    safariZoomReset,
    safariTabOverview,
    safariShare,
    safariOpenExternal,
    safariAddReading,
    safariReopenClosedTab,
    safariFocusAddress,
};
