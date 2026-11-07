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
 *   - 锁屏闸门：window 捕获阶段，锁定态吞掉一切非口令输入按键（BUG-37）；
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
        id: "spotlight", keys: "⌥Space / F4", label: "打开聚焦",
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
    { id: "mission", keys: "⌃↑", label: "窗口总览", tier: "native", owner: "wm/overview.js" },
    { id: "cycleSpaces", keys: "⌃← / ⌃→", label: "全屏空间轮换", tier: "native", owner: "window-manager.js" },
    { id: "switchApp", keys: "⌘Tab", label: "切换应用", tier: "planned" },
    { id: "screenshot", keys: "⌘⇧5", label: "截屏", tier: "planned" },
    { id: "splitView", keys: "—", label: "分屏浏览", tier: "menu" },

    // macOS 15 平铺快捷键族（Fn-Control-*）的浏览器可落等价键（FS-10，Fn 键浏览器拿不到）
    { id: "tileLeft", keys: "⌃⌥←", label: "平铺到左半屏", tier: "fallback", owner: "window-manager.js" },
    { id: "tileRight", keys: "⌃⌥→", label: "平铺到右半屏", tier: "fallback", owner: "window-manager.js" },
    { id: "tileTop", keys: "⌃⌥↑", label: "平铺到上半屏", tier: "fallback", owner: "window-manager.js" },
    { id: "tileBottom", keys: "⌃⌥↓", label: "平铺到下半屏", tier: "fallback", owner: "window-manager.js" },
    { id: "tileFill", keys: "⌃⌥⏎", label: "填充", tier: "fallback", owner: "window-manager.js" },
    { id: "tileCenter", keys: "⌃⌥C", label: "居中", tier: "fallback", owner: "window-manager.js" },
    { id: "tileRestore", keys: "⌃⌥R", label: "还原平铺前大小", tier: "fallback", owner: "window-manager.js" },

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

/** owner 条目（聚焦等）的当前绑定文本：由 owner 模块注入，用户改绑后总表不撒谎。 */
const DYNAMIC_TEXT = new Map();

/**
 * 注入某条目的动态键位文本。
 * @param {string} id 条目 id（如 "spotlight"）
 * @param {string|(() => string)} textOrFn 文本或取文本的函数（每次读表现取）
 * @returns {void}
 */
export function setShortcutText(id, textOrFn) {
    if (textOrFn === null || textOrFn === undefined) DYNAMIC_TEXT.delete(id);
    else DYNAMIC_TEXT.set(String(id), textOrFn);
}

/**
 * 总表：给设置面板与菜单显示用。
 * @returns {Array<{app:string, menu:string, label:string, shortcut:string, status:string, tier:string}>}
 */
export function getKeyboardEntries() {
    return ENTRIES.map((entry) => {
        const dynamic = DYNAMIC_TEXT.get(entry.id);
        const text = typeof dynamic === "function" ? dynamic() : (dynamic || entry.keys);
        return {
            app: "通用",
            menu: "键盘",
            label: entry.label,
            shortcut: text,
            status: entry.tier,
            tier: entry.tier,
            owner: entry.owner || "",
        };
    });
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

// ---- 锁屏键盘闸门（BUG-37）----

/** 锁屏模块缺失的告警只发一次：按未锁定放行，绝不因模块缺席把键盘锁死。 */
let warnedLockMissing = false;

/**
 * 口令输入必需的按键：事件落在锁屏遮罩内，且按键为字符 / 退格 / 回车 / Tab。
 * 带 ⌘/⌃ 的组合（⌘V、⌘A 一类）不算 —— 系统级组合在闸门期间一律吞掉。
 * @param {KeyboardEvent} event 键盘事件
 * @returns {boolean}
 */
function isPasswordEntryKey(event) {
    if (event.metaKey || event.ctrlKey) return false;
    const target = event.target;
    if (!target || typeof target.closest !== "function") return false;
    if (!target.closest("#deskly-lock-screen")) return false;
    return event.key === "Backspace" || event.key === "Enter" || event.key === "Tab"
        || (typeof event.key === "string" && event.key.length === 1);
}

/**
 * 锁屏键盘闸门。锁定状态只认锁屏模块本身（__lock.isLocked / isGated），
 * 每次按键现读、不缓存第二份状态 —— 解锁后下一个按键立即恢复分发，无轮询。
 *   - 模块未加载：按未锁定放行 + 告警一次；
 *   - 口令闸门锁定：只放行密码框内的输入键，其余 preventDefault +
 *     stopImmediatePropagation 一并吞掉（浏览器级默认行为也拦在闸门内）；
 *   - 无闸门锁定：任意按键即解锁输入，交给 __lock.unlock("input") 走
 *     lock.js 原有路径，事件本身吞掉，避免同一按键既解锁又触发全局命令
 *     （聚焦、Dock 导航等 document 级监听）。
 * @param {KeyboardEvent} event 键盘事件
 * @returns {boolean} true = 已吞掉，调用方不得再分发
 */
function swallowIfLocked(event) {
    const api = globalThis.__lock;
    if (!api || typeof api.isLocked !== "function") {
        if (!warnedLockMissing) {
            warnedLockMissing = true;
            window.__log?.warn("kernel/keyboard", "锁屏模块未加载，键盘闸门按未锁定处理");
        }
        return false;
    }
    if (!api.isLocked()) return false;
    if (isPasswordEntryKey(event)) return false;
    if (!api.isGated?.()) api.unlock?.("input");
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
}

/**
 * 启动全局分发：只处理 tier=native 且带 command 的条目；
 * owner 条目由各自模块监听，这里不重复抢键。
 * @returns {void}
 */
export function initKeyboard() {
    if (globalThis.__keyboardReady) return;
    globalThis.__keyboardReady = true;
    // 闸门挂 window 捕获阶段：先于一切 document 级监听（含模块求值期就注册的
    // window-manager ⌃⌘F 等），锁定态下同节点先注册的 spotlight 热键也收不到被吞的键。
    window.addEventListener("keydown", (event) => { swallowIfLocked(event); }, true);
    document.addEventListener("keydown", (event) => {
        if (event.repeat || event.isComposing) return;
        // 双保险：window 级闸门失效路径（如监听被摘）下，分发入口自己再查一次。
        if (swallowIfLocked(event)) return;
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
