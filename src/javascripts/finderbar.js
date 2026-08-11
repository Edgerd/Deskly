/**
 * finderbar.js — 菜单栏（顶栏）核心逻辑
 *
 * 职责：
 * 1. 渲染左侧 Apple 图标 + 活动应用名 + 菜单项（文件/编辑/显示等）。
 * 2. 渲染右侧系统状态图标与日期时间。
 * 3. 动态生成各应用的子菜单（下拉内容）与操作命令。
 * 4. 管理菜单的打开/关闭状态与层级。
 */

import { zIndex } from "./window.js";
import { i18n } from "./i18n.js";
import { mountToFinderbar } from "./controlcenter.js";
import { initDatetimePopover } from "./datetime_popover.js";

// 顶层菜单文本键映射（用于应用菜单国际化）
const MENU_KEYS = {
    "文件": "finderbar.file",
    "编辑": "finderbar.edit",
    "显示": "finderbar.view",
    "前往": "finderbar.go",
    "窗口": "finderbar.window",
    "帮助": "finderbar.help",
    "历史记录": "finderbar.history",
    "书签": "finderbar.bookmarks",
};

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
            { label: "显示简介", shortcut: "⌘I", disabled: true },
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
            { label: "前往文件夹...", shortcut: "⌘⇧G", cmd: "finderGoToFolder" },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "访达帮助", disabled: true },
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
            { label: "系统设置帮助", disabled: true },
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
        "显示": [
            { label: "基础型", shortcut: "⌘1", disabled: true },
            { label: "科学型", shortcut: "⌘2", disabled: true },
            { label: "编程器", shortcut: "⌘3", disabled: true },
            { separator: true },
            { label: "千位分隔符", disabled: true },
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "计算器帮助", disabled: true },
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
        "显示": [
            { label: "仅已安装", disabled: true },
            { label: "仅可更新", disabled: true },
            { label: "显示全部", disabled: true },
            { separator: true },
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
            { label: "自定义工具栏...", disabled: true },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "App Store 帮助", disabled: true },
        ],
    },
    "Safari浏览器": {
        "文件": [
            { label: "新建窗口", shortcut: "⌘N", disabled: true },
            { label: "新建标签页", shortcut: "⌘T", disabled: true },
            { separator: true },
            { label: "打开文件...", shortcut: "⌘O", disabled: true },
            { label: "打开位置...", shortcut: "⌘L", disabled: true },
            { separator: true },
            { label: "关闭窗口", shortcut: "⌘W", cmd: "closeActiveWindow()" },
            { label: "关闭标签页", shortcut: "⌘⌥W", disabled: true },
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
            { label: "查找...", shortcut: "⌘F", disabled: true },
        ],
        "显示": [
            { label: "工具栏", disabled: true },
            { label: "边栏", disabled: true },
            { label: "状态栏", disabled: true },
            { separator: true },
            { label: "放大", shortcut: "⌘+", disabled: true },
            { label: "缩小", shortcut: "⌘-", disabled: true },
            { label: "实际大小", shortcut: "⌘0", disabled: true },
            { separator: true },
            { label: "进入全屏", shortcut: "⌃⌘F", cmd: "toggleActiveWindowFullscreen()" },
        ],
        "历史记录": [
            { label: "重新打开上次关闭的标签页", shortcut: "⌘⇧T", disabled: true },
            { label: "重新打开上次关闭的窗口", disabled: true },
            { separator: true },
            { label: "显示所有历史记录", shortcut: "⌘Y", disabled: true },
            { separator: true },
            { label: "清除历史记录...", disabled: true },
        ],
        "书签": [
            { label: "添加书签...", shortcut: "⌘D", disabled: true },
            { label: "添加此标签页到阅读列表", shortcut: "⌃⌘D", disabled: true },
            { separator: true },
            { label: "编辑书签...", disabled: true },
            { label: "显示书签边栏", shortcut: "⌃⌘1", disabled: true },
        ],
        "窗口": [
            { label: "最小化", shortcut: "⌘M", cmd: "minimizeActiveWindow()" },
            { label: "缩放", cmd: "toggleActiveWindowStretch()" },
            { separator: true },
            { label: "前置全部窗口", cmd: "bringAllWindowsToFront()" },
        ],
        "帮助": [
            { label: "Safari 帮助", disabled: true },
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
            { label: "macOS 帮助", disabled: true },
        ],
    },
};

/**
 * 应用顶层菜单列表（保持顺序，用于渲染顶栏左侧菜单）。
 */
export let appMenu = {
    "访达": ["文件", "编辑", "显示", "前往", "窗口", "帮助"],
    "系统设置": ["编辑", "显示", "窗口", "帮助"],
    "计算器": ["编辑", "显示", "窗口", "帮助"],
    "App Store": ["编辑", "显示", "窗口", "帮助"],
    "Safari浏览器": ["文件", "编辑", "显示", "历史记录", "书签", "窗口", "帮助"],
    "关于本机": ["编辑", "显示", "窗口", "帮助"],
};

let appControl = ["switch.2", "magnifyingglass", "wifi"];
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
        console.warn("[finderbar] 已初始化过，跳过重复初始化");
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
    timeControl.innerHTML = "13:20";
    dateControl = document.createElement("p");
    dateControl.classList.add("date");
    dateControl.innerHTML = "9月14日 周日";

    appControlContainer.appendChild(timeControl);
    appControlContainer.appendChild(dateControl);

    updateMenu("访达");
    updateControl();
    updateTime();
    setInterval(updateTime, 1000);
    window.onload = resetMenuHandle;

    // 绑定菜单栏时间/日期点击弹出日历面板（独立模块）
    initDatetimePopover(timeControl, dateControl);

    // 在右侧状态栏挂载控制中心图标
    mountToFinderbar(appControlContainer, finderbar);

    // 动态加载 Siri 脚本并注册顶栏图标（通过插件图标注册接口）
    // 注意：finderbar.js 位于 src/javascripts/，需跳出两层到项目根再进 mods/
    import("../../mods/siri/script.js")
        .then(() => {
            if (window.__siri) {
                registerFinderbarIcon({
                    id: "siri",
                    icon: "./assets/images/siri.svg",
                    onClick: () => window.__siri.toggle(),
                    order: -1, // 靠右优先（row-reverse 下负值 = 更靠右）
                });
                console.log("[finderbar] Siri 顶栏图标已注册");
            }
        })
        .catch((err) => console.warn("[finderbar] Siri 脚本加载失败", err));
}

let openingMenu = null;

/**
 * 根据字符串菜单键名生成 CSS class 名（去掉中文，使用拼音/英文替代）。
 * 例如："文件" → "file"，"历史记录" → "history"
 */
const MENU_CLASS = {
    "文件": "file", "编辑": "edit", "显示": "view", "前往": "go",
    "窗口": "window", "帮助": "help", "历史记录": "history", "书签": "bookmarks",
};

function menuKeyToClass(menuKey) {
    return MENU_CLASS[menuKey] || menuKey;
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
    const menus = appMenu[app];
    const defs = SUB_MENUS[app] || {};
    if (!menus) return created;
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
            const p = document.createElement("p");
            const text = item.i18nKey ? i18n.t(item.i18nKey, item.label) : item.label;
            // 不显示快捷键：仅渲染菜单项文本
            p.textContent = text;
            if (item.disabled) {
                p.setAttribute("disabled", "disabled");
            }
            // 绑定点击：字符串命令通过全局 window 执行，函数直接调用
            if (!item.disabled && item.cmd) {
                p.addEventListener("click", (e) => {
                    e.stopPropagation();
                    executeCommand(item.cmd);
                });
            }
            sub.appendChild(p);
        });
        document.body.appendChild(sub);
        created.push(sub);
    });
    return created;
}

/**
 * 执行菜单项命令。
 * - 若 cmd 为函数，直接调用；
 * - 若 cmd 为字符串，尝试在全局查找同名函数执行，
 *   回退使用 new Function（兼容 index.html 中已有的 moduleItems 样式）。
 *
 * @param {string|Function} cmd
 */
function executeCommand(cmd) {
    closeAllMenus();
    if (typeof cmd === "function") {
        try { cmd(); } catch (e) { console.error("[menu] cmd 执行失败", e); }
        return;
    }
    if (typeof cmd !== "string") return;
    // 优先匹配挂在 window.__menuActions 上的函数（我们会在本文件导出）
    if (window.__menuActions?.[cmd]) {
        try { window.__menuActions[cmd](); } catch (e) { console.error("[menu] 执行失败", cmd, e); }
        return;
    }
    // 回退：new Function 兼容历史写法
    try {
        new Function(cmd)();
    } catch (e) {
        console.error("[menu] 命令解析失败:", cmd, e);
    }
}

/**
 * 切出顶栏与下拉菜单：
 * 1. 销毁上一次动态生成的顶栏段落（tempMenuElements）。
 * 2. 重新生成当前 app 的顶栏段落与对应子菜单。
 * 3. 为顶栏段落绑定点击事件（控制对应子菜单显隐）。
 */
export function updateMenu(app) {
    if (!appMenu[app]) {
        return;
    }
    // 清理旧的顶层菜单段落
    tempMenuElements.forEach((ele) => ele?.parentNode?.removeChild(ele));
    tempMenuElements = [];

    // 应用名
    let appMenuElement = document.createElement("p");
    appMenuElement.innerHTML = app;
    appMenuElement.classList.add("appname");
    appMenuContainer.appendChild(appMenuElement);
    tempMenuElements.push(appMenuElement);

    // 动态构建该应用的子菜单 DOM
    const subMenus = buildSubMenusForApp(app);
    subMenus.forEach(m => tempMenuElements.push(m));

    // 顶层菜单项
    appMenu[app].forEach((menu) => {
        let nowMenu = document.createElement("p");
        nowMenu.innerHTML = i18n.t(MENU_KEYS[menu], menu);
        nowMenu.classList.add(menuKeyToClass(menu));
        appMenuContainer.appendChild(nowMenu);
        tempMenuElements.push(nowMenu);
    });
    resetMenuHandle();
}

// 语言切换时刷新当前应用菜单
window.addEventListener("languagechange", () => {
    const activeApp = document.querySelector("#finderbar p.appname");
    if (activeApp) {
        updateMenu(activeApp.innerHTML);
    }
});

function updateControl() {
    appControl.forEach((control) => {
        let nowControl = document.createElement("img");
        nowControl.src = `./assets/images/${control}.svg`;
        appControlContainer.appendChild(nowControl);
    });
}

/* -------------------------------------------------------------------------- *
 * 插件顶栏图标注册接口：允许插件动态注册/注销右侧自定义图标。
 * -------------------------------------------------------------------------- */

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
        console.warn("[finderbar] registerFinderbarIcon 缺少 id 或 icon");
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

    console.log(`[finderbar] 插件图标已注册: ${id}`);
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
    console.log(`[finderbar] 插件图标已注销: ${id}`);
    return true;
}

/**
 * 获取当前已注册的插件图标 ID 列表（调试用）。
 * @returns {string[]}
 */
export function getRegisteredFinderbarIcons() {
    return Array.from(pluginIcons.keys());
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
}

/**
 * 重新绑定所有子菜单与其父段落的点击。
 */
function resetMenuHandle() {
    let subMenus = document.querySelectorAll("div.menu:not(.contextmenu)");

    subMenus.forEach(subMenu => {
        const subApp = subMenu.getAttribute("app");
        const curApp = (document.querySelectorAll(".finderbar .left p")[1] || {}).innerHTML;
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

function updateTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const day = String(now.getDate());
    const month = String(now.getMonth() + 1);
    const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const weekDay = days[now.getDay()];
    dateControl.innerHTML = `${month} 月 ${day} 日 ${weekDay}`;
    timeControl.innerHTML = `${hours}：${minutes}`;
}

initFinderbar();

/* -------------------------------------------------------------------------- *
 * 菜单命令实现：挂在 window.__menuActions 上，供 executeCommand 分发。
 * -------------------------------------------------------------------------- */

/**
 * 根据应用显示名启动该应用（用于「文件 → 新建访达窗口」等）。
 */
function openAppByName(name) {
    // 优先走插件管理器；否则退回 window.create
    if (window.__getPluginByName) {
        const plugin = window.__getPluginByName(name);
        if (plugin) {
            import("./plugin-manager.js").then(({ load }) => {
                load(plugin.id, { centered: true });
            }).catch(err => console.error(err));
            return;
        }
    }
    if (window.moduleItems && window.moduleItems.create) {
        window.moduleItems.create(`./assets/apps/${name}.html`, name);
    }
}

/**
 * 对当前活动（z-index 最高）窗口调用指定方法。
 * 仅筛选未关闭且具备该方法的窗口，按 z-index 降序取最顶层。
 * @param {string} method 窗口实例方法名（如 "_closeWindow"）
 * @param {...any} args 透传给该方法的参数
 */
function runOnTopWindow(method, ...args) {
    const wins = Array.from(document.querySelectorAll(".window"))
        .filter((w) => !w.classList.contains("closing") && w[method]);
    if (!wins.length) return;
    wins.sort((a, b) => {
        const za = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
        const zb = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
        return zb - za;
    });
    wins[0][method](...args);
}

/** 关闭当前活动（z-index 最高）的窗口。 */
function closeActiveWindow() { runOnTopWindow("_closeWindow"); }
/** 切换当前活动窗口的全屏（最大化）状态。 */
function toggleActiveWindowFullscreen() { runOnTopWindow("_toggleFullscreenWindow"); }
/** 切换当前活动窗口的「拉伸」状态（macOS 双击标题栏效果）。 */
function toggleActiveWindowStretch() { runOnTopWindow("_toggleStretchWindow"); }
/** 最小化当前活动窗口（顶栏菜单「窗口 → 最小化」统一入口）。 */
function minimizeActiveWindow() { runOnTopWindow("_toggleMinimizeWindow"); }
/** 将当前活动窗口平铺到指定区域。 */
function tileActiveWindow(region) { runOnTopWindow("_tileWindow", region); }

/**
 * 将所有窗口按 z-index 依次置顶一遍（模拟「前置全部窗口」）。
 */
function bringAllWindowsToFront() {
    const wins = Array.from(document.querySelectorAll(".window"))
        .filter((w) => !w.classList.contains("closing"));
    import("./window.js").then(({ bringToFront }) => wins.forEach((w) => bringToFront(w, w.id)));
}

/**
 * 清倒废纸篓（占位：后续结合虚拟文件系统）。
 */
function emptyTrash() {
    const tip = document.querySelector(".tip");
    if (!tip) return;
    tip.textContent = "废纸篓已清倒（演示）";
    tip.style.opacity = 1;
    setTimeout(() => { tip.style.opacity = 0; }, 1200);
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
 * 最小化当前活动窗口（顶栏「窗口 → 最小化」入口，对所有应用通用）。
 */
function finderMinimize() {
    minimizeActiveWindow();
}

/**
 * 新建文件夹（访达内）。
 */
function finderNewFolder() {
    dispatchFinderCommand('new-folder');
}

// 导出到全局，供 executeCommand 按字符串查找
window.__menuActions = {
    openAppByName,
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
    finderMinimize,
    finderNewFolder,
};
