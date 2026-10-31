/**
 * keyboard.js — 全局快捷键的单一真源（F-32 第一步）
 *
 * 过去的问题：菜单里印着 90 条 `shortcut` 字面量，真正被监听的只有 4 个键；
 * 设置里的「快捷键总表」只是把字面量搬了一遍，无法回答「这条到底能不能按」。
 *
 * 这里把「键位 → 命令 → 状态」收成一张表：
 *   native   已绑定：本模块直接监听并分发（或由某个 owner 模块真实监听）
 *   fallback 等价键：原版键被浏览器占用，用替代键实现
 *   reserved 浏览器/系统保留：页面收不到，只能从菜单点
 *   planned  尚未实现：等对应功能落地（调度中心、截屏等）
 *
 * 使用者：
 *   - 本模块：document 捕获阶段匹配 native + command 的条目并分发；
 *   - finderbar.getShortcutMap()：总表数据源（菜单显示与设置面板共用）；
 *   - 设置 › 键盘：状态列；
 *   - finderbar 菜单：保留键的条目加虚线与说明，避免「显示 ≠ 能按」。
 */

import { dispatchMenuCommand } from "./ui/menuCommands.js";

/** 状态 → 展示文案（键 + 中文兜底，四语由语言包覆盖）。 */
export const TIER_LABEL = {
    native: ["keyboard.tier.native", "已绑定"],
    fallback: ["keyboard.tier.fallback", "等价键"],
    reserved: ["keyboard.tier.reserved", "浏览器保留"],
    planned: ["keyboard.tier.planned", "尚未实现"],
    menu: ["keyboard.tier.menu", "菜单可用"],
};

/**
 * 快捷键表。`combo` 只给本模块真正监听的条目；owner 条目说明由谁监听，
 * 避免两处同时 preventDefault 抢同一个键。
 */
const ENTRIES = [
    {
        id: "settings", keys: "⌘,", label: "打开系统设置", combo: { meta: true, key: "," },
        tier: "native", command: "openAppByName('系统设置')",
    },
    {
        id: "hide", keys: "⌘H", label: "隐藏当前应用", combo: { meta: true, key: "h" },
        tier: "native", command: "hideActiveApp",
    },
    {
        id: "lock", keys: "⌃⌘Q", label: "锁定屏幕", combo: { ctrl: true, meta: true, key: "q" },
        tier: "native", command: "lockScreen",
    },
    {
        id: "forceQuit", keys: "⌘⌥Esc", label: "强制退出…", combo: { meta: true, alt: true, key: "Escape" },
        tier: "native", command: "forceQuit",
    },
    {
        id: "fullscreen", keys: "⌃⌘F", label: "进入/退出全屏幕",
        tier: "native", owner: "window-manager.js",
    },
    {
        id: "spotlight", keys: "⌘Space / F4", label: "打开聚焦",
        tier: "native", owner: "spotlight.js",
    },
    {
        id: "launchpad", keys: "⌃↓", label: "打开启动台", combo: { ctrl: true, key: "ArrowDown" },
        tier: "native", command: "toggleLaunchpad",
    },
    {
        id: "dockNav", keys: "⌃⌘F3", label: "程序坞键盘导航",
        tier: "native", owner: "dock.js",
    },
    { id: "mission", keys: "⌃↑", label: "调度中心", tier: "planned" },
    { id: "switchApp", keys: "⌘Tab", label: "切换应用", tier: "planned" },
    { id: "screenshot", keys: "⌘⇧5", label: "截屏", tier: "planned" },
    { id: "splitView", keys: "—", label: "分屏浏览", tier: "planned" },

    { id: "minimize", keys: "⌘M", label: "最小化", tier: "reserved" },
    { id: "close", keys: "⌘W", label: "关闭窗口", tier: "reserved" },
    { id: "quit", keys: "⌘Q", label: "退出应用", tier: "reserved" },
    { id: "newWindow", keys: "⌘N", label: "新建窗口", tier: "reserved" },
    { id: "open", keys: "⌘O", label: "打开", tier: "reserved" },
    { id: "print", keys: "⌘P", label: "打印", tier: "reserved" },
    { id: "save", keys: "⌘S", label: "存储", tier: "reserved" },
    { id: "find", keys: "⌘F", label: "查找", tier: "reserved" },
    { id: "newTab", keys: "⌘T", label: "新建标签页", tier: "reserved" },
    { id: "location", keys: "⌘L", label: "打开位置", tier: "reserved" },
    { id: "reload", keys: "⌘R", label: "重新载入", tier: "reserved" },
    { id: "undo", keys: "⌘Z", label: "撤销", tier: "reserved" },
    { id: "cut", keys: "⌘X", label: "剪切", tier: "reserved" },
    { id: "copy", keys: "⌘C", label: "拷贝", tier: "reserved" },
    { id: "paste", keys: "⌘V", label: "粘贴", tier: "reserved" },
    { id: "selectAll", keys: "⌘A", label: "全选", tier: "reserved" },
];

/** 菜单里显示的快捷键文本 → 状态（保留键加虚线并在 title 里说明）。 */
const STATUS_BY_TEXT = new Map(ENTRIES.map((entry) => [entry.keys, entry.tier]));

/** 键位集合 → 状态；菜单项查这个决定是否标注。 */
export function statusForShortcut(text) {
    return STATUS_BY_TEXT.get(String(text || "").trim()) || null;
}

/** 状态文案（i18n 键 + 中文兜底）。 */
export function tierText(tier, t) {
    const [key, fallback] = TIER_LABEL[tier] || TIER_LABEL.planned;
    return typeof t === "function" ? t(key, fallback) : fallback;
}

/**
 * 总表：给设置面板与菜单显示用。
 * @returns {Array<{app:string, menu:string, label:string, shortcut:string, status:string, tier:string}>}
 */
export function getKeyboardEntries() {
    return ENTRIES.map((entry) => ({
        app: "通用",
        menu: "键盘",
        label: entry.label,
        shortcut: entry.keys,
        status: entry.tier,
        tier: entry.tier,
        owner: entry.owner || "",
    }));
}

/**
 * 事件是否命中某条 combo：修饰键必须完全一致（多余修饰键不算命中）。
 * @param {object} combo 条目里的组合键
 * @param {KeyboardEvent} event 键盘事件
 * @returns {boolean}
 */
function matches(combo, event) {
    if (!combo) return false;
    const key = event.key === " " ? " " : event.key;
    const want = combo.key;
    const sameKey = want === " " ? (key === " " || event.code === "Space") : key.toLowerCase() === String(want).toLowerCase();
    if (!sameKey) return false;
    return Boolean(combo.meta) === Boolean(event.metaKey)
        && Boolean(combo.ctrl) === Boolean(event.ctrlKey)
        && Boolean(combo.alt) === Boolean(event.altKey)
        && Boolean(combo.shift) === Boolean(event.shiftKey);
}

/** 是否在文本输入环境（保留给将来的应用内快捷键，不拦系统级组合）。 */
function inEditable(target) {
    if (!target || !target.closest) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * 启动全局分发：只处理 tier=native 且带 command 的条目；
 * owner 条目由各自模块监听，这里不重复抢键。
 * @returns {void}
 */
export function initKeyboard() {
    if (globalThis.__keyboardReady) return;
    globalThis.__keyboardReady = true;
    document.addEventListener("keydown", (event) => {
        if (event.repeat || event.isComposing) return;
        for (const entry of ENTRIES) {
            if (entry.tier !== "native" || !entry.command || !matches(entry.combo, event)) continue;
            // ⌘, 与 ⌘H 在输入框里也要生效（macOS 行为），其余条目未来若加文本类快捷键再按 inEditable 排除。
            event.preventDefault();
            event.stopPropagation();
            dispatchMenuCommand(entry.command);
            return;
        }
    }, true);
}

export { inEditable };
