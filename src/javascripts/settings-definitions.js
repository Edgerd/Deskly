/**
 * settings-definitions.js — 既有 owner 模块的设置定义表（schema 单一来源）
 *
 * 本文件把「键名 / 存储槽 / 类型 / 默认值 / 合法取值 / 生效函数 / 界面控件元数据」
 * 集中在一张表里，系统设置插件据此渲染控件，其它模块据此读值，双方不再各抄一份键名。
 *
 * 三条约定：
 * 1. **默认值必须与 owner 现读逻辑逐一对齐**。dock.js 里 `dock-zoom !== "off"` 意味着
 *    默认开启，这里的 default 就得是 true；写反会让从没碰过该设置的用户在升级后翻转。
 * 2. **`event` 与 `apply` 二选一**：owner 自己会广播事件的（appearance/cursor/wallpaper 等）
 *    只填 `apply`，由 owner 发事件，避免同一事件派发两次；owner 只有监听没有 setter 的
 *    （dock.js 的 7 个布局项、siri）填 `event`，由设置中枢按旧格式补发，owner 零改动。
 * 3. **新模块自带定义**：锁屏、声音、显示器、聚焦搜索等新内核模块在自己文件里
 *    `settings.define()`，不塞进本表 —— owner 才是取值范围的权威。
 *
 * `pane` 取的是 `mods/system-settings/registry.js` 里的面板 id（不是旧的 data-page 名），
 * `dev/settings-fulltest.mjs` 会逐条校验两者对得上，改一边忘了改另一边会直接红。
 * 界面元数据（label / hint / control / format / units / group / order / hidden）
 * 只被系统设置读取，内核逻辑一律忽略。
 */

import { settings } from "./settings.js";
import { setTheme, setAccent, setHighlight, setSidebarSize, setTint, setScrollbars, setScrollClick } from "./appearance.js";
import { setCursorSize, setCursorShadow } from "./cursor.js";
import { setTrashIcon, TRASH_KEYS } from "./trashIcon.js";
import { setNativeContextMenuEnabled } from "./contextMenuSettings.js";
import { wallpaper } from "./wallpaper.js";
import { i18n } from "./i18n.js";
import { setValue as setControlCenterValue, CONTROL_CENTER_FIELDS } from "./controlcenter.js";

/** 强调色候选（与 appearance.js 的 COLOR_MAP 同序，色值由界面侧的 swatches 呈现）。 */
const ACCENT_KEYS = ["multicolor", "blue", "purple", "pink", "red", "orange", "yellow", "green", "gray"];

/** 控制中心各字段归属哪个面板：专注模式相关两项有独立面板，其余留在控制中心。 */
const FOCUS_FIELDS = ["focus", "focusMode"];

/**
 * 注册全部既有 owner 的设置定义。
 * @returns {number} 注册成功的项数
 */
function initSettingsSchema() {
    const count = settings.defineMany([
        // ── 外观 appearance.* ────────────────────────────────────────────
        {
            key: "appearance.theme", slot: "appearance-theme", type: "string", default: "light",
            values: ["light", "dark", "auto"], control: "cards", pane: "appearance", group: "外观", order: 10,
            label: "外观",
            apply: (value) => setTheme(value),
        },
        {
            key: "appearance.accent", slot: "appearance-accent", type: "string", default: "multicolor",
            values: ACCENT_KEYS, control: "swatches", pane: "appearance", group: "外观", order: 20,
            label: "强调色",
            apply: (value) => setAccent(value),
        },
        {
            key: "appearance.highlight", slot: "appearance-highlight", type: "string", default: "accent",
            values: ["accent", ...ACCENT_KEYS], control: "dropdown", pane: "appearance", group: "外观", order: 30,
            label: "高亮颜色",
            apply: (value) => setHighlight(value),
        },
        {
            key: "appearance.sidebar.size", slot: "appearance-sidebar-size", type: "string", default: "medium",
            values: ["small", "medium", "large"], control: "dropdown", pane: "appearance", group: "外观", order: 40,
            label: "边栏图标大小",
            apply: (value) => setSidebarSize(value),
        },
        {
            key: "appearance.wallpaper.tint", slot: "appearance-wallpaper-tint", type: "boolean", default: false,
            control: "switch", pane: "appearance", group: "外观", order: 50,
            label: "允许墙纸为窗口着色",
            apply: (value) => setTint(value ? "on" : "off"),
        },
        {
            key: "appearance.scrollbars", slot: "appearance-scrollbars", type: "string", default: "auto",
            values: ["auto", "when-scrolling", "always"], control: "radio", pane: "appearance", group: "外观", order: 60,
            label: "显示滚动条",
            apply: (value) => setScrollbars(value),
        },
        {
            // 滚动条「点按位置」是浏览器原生滚动条行为，网页无法接管（没有对应的 CSS/JS 能力），
            // 因此只保留键与持久化，不再出现在界面上占位。
            key: "appearance.scroll.click", slot: "appearance-scroll-click", type: "string", default: "next-page",
            values: ["next-page", "spot"], control: "radio", pane: "appearance", group: "外观", order: 70,
            hidden: true, label: "在滚动条中点按",
            apply: (value) => setScrollClick(value),
        },
        {
            key: "appearance.reduceMotion", type: "boolean", default: false,
            control: "switch", pane: "appearance", group: "外观", order: 80,
            label: "减少动态效果",
            apply: (value) => { document.documentElement.dataset.reduceMotion = value ? "on" : "off"; },
        },
        {
            key: "appearance.transparency", type: "boolean", default: true,
            control: "switch", pane: "appearance", group: "外观", order: 90,
            label: "窗口毛玻璃",
            apply: (value) => { document.documentElement.dataset.transparency = value ? "on" : "off"; },
        },

        // ── 通用 general.* ───────────────────────────────────────────────
        {
            key: "general.language", slot: "webstartos_language", type: "string", default: "zh-CN",
            values: ["zh-CN", "en", "ja-JP", "cat"], control: "dropdown", pane: "general", group: "通用", order: 10,
            label: "语言",
            apply: (value) => { if (i18n.getLanguage() !== value) i18n.setLanguage(value); },
        },
        {
            key: "general.nativeContextMenu", slot: "native-context-menu", type: "boolean", default: false,
            control: "switch", pane: "dock", group: "桌面", order: 200,
            label: "显示原生右键菜单",
            apply: (value) => setNativeContextMenuEnabled(value),
        },
        {
            key: "general.timeFormat", type: "string", default: "24h", values: ["24h", "12h"],
            valuesLabel: ["24 小时", "12 小时"], control: "segmented", pane: "general", group: "通用", order: 20,
            label: "时间格式",
            apply: () => window.dispatchEvent(new CustomEvent("datetime-format-change")),
        },
        {
            key: "general.showSeconds", type: "boolean", default: false,
            control: "switch", pane: "general", group: "通用", order: 30,
            label: "显示秒",
            apply: () => window.dispatchEvent(new CustomEvent("datetime-format-change")),
        },
        {
            key: "general.weekStart", type: "number", default: 1, min: 0, max: 1, step: 1,
            values: [0, 1], valuesLabel: ["周日", "周一"], control: "segmented",
            pane: "general", group: "通用", order: 40,
            label: "周起始日",
            apply: () => window.dispatchEvent(new CustomEvent("datetime-format-change")),
        },

        // ── 程序坞与桌面 dock.* ──────────────────────────────────────────
        {
            key: "dock.autohide", slot: "dock-autohide", type: "boolean", default: false,
            control: "switch", pane: "dock", group: "程序坞", order: 10,
            label: "自动隐藏并最大化程序坞", event: "dock-autohide-change",
        },
        {
            key: "dock.zoom", slot: "dock-zoom", type: "boolean", default: true,
            control: "switch", pane: "dock", group: "程序坞", order: 20,
            label: "程序坞放大", event: "dock-zoom-change",
        },
        {
            key: "dock.size", slot: "dock-size", type: "number", default: 50, min: 32, max: 128, step: 2,
            control: "slider", units: "px", pane: "dock", group: "程序坞", order: 30,
            label: "图标大小", event: "dock-size-change",
        },
        {
            key: "dock.position", slot: "dock-position", type: "string", default: "bottom",
            values: ["left", "bottom", "right"], valuesLabel: ["左侧", "底部", "右侧"],
            control: "segmented", pane: "dock", group: "程序坞", order: 40,
            label: "位置", event: "dock-position-change",
        },
        {
            key: "dock.zoom.amount", slot: "dock-zoom-amount", type: "number", default: 1.8, min: 1.1, max: 3, step: 0.1,
            control: "slider", units: "倍", pane: "dock", group: "程序坞", order: 50,
            label: "放大倍数", event: "dock-zoom-amount-change",
        },
        {
            key: "dock.show.indicators", slot: "dock-show-indicators", type: "boolean", default: true,
            control: "switch", pane: "dock", group: "程序坞", order: 60,
            label: "显示打开的应用指示器", event: "dock-show-indicators-change",
        },
        {
            key: "dock.show.recent", slot: "dock-show-recent", type: "boolean", default: true,
            control: "switch", pane: "dock", group: "程序坞", order: 70,
            label: "显示最近使用的应用", event: "dock-show-recent-change",
        },
        {
            // 收藏顺序与「最近使用」列表由 dock.js 自己维护（数组形态），这里只登记类型与默认值，
            // 供设置面板做「恢复默认顺序」与存储诊断使用。
            key: "dock.order", slot: "webstartos_dock_order", type: "json",
            default: ["访达", "启动台", "Safari浏览器", "系统设置", "App Store", "下载"],
            control: "json", pane: "dock", group: "程序坞", order: 80, hidden: true,
            label: "程序坞收藏顺序", event: "dock-order-change",
        },
        {
            key: "dock.recents", slot: "webstartos_dock_recents", type: "json", default: [],
            control: "json", pane: "dock", group: "程序坞", order: 90, hidden: true,
            label: "最近使用的应用程序", event: "dock-recents-change",
        },
        {
            key: "trash.icon", slot: "trash-icon", type: "string", default: "light",
            values: TRASH_KEYS, control: "cards", pane: "dock", group: "桌面", order: 100,
            label: "废纸篓图标", apply: (value) => setTrashIcon(value),
        },

        // ── 启动台 launchpad.* ──────────────────────────────────────────
        // 启动台是插件（关闭即卸载），没有常驻 owner 可读值生效，因此这里只登记
        // 取值范围与事件名：设置面板落盘后广播，启动台在打开时读存储、在已打开时收事件。
        {
            key: "launchpad.icon.size", slot: "launchpad-icon-size", type: "number", default: 84, min: 56, max: 128, step: 2,
            control: "slider", units: "px", pane: "dock", group: "启动台", order: 110,
            label: "启动台图标大小", event: "launchpad-icon-size-change",
        },
        {
            key: "launchpad.font.size", slot: "launchpad-font-size", type: "number", default: 13, min: 10, max: 20, step: 1,
            control: "slider", units: "px", pane: "dock", group: "启动台", order: 120,
            label: "启动台文字大小", event: "launchpad-font-size-change",
        },

        // ── 墙纸 wallpaper.* ─────────────────────────────────────────────
        {
            key: "wallpaper.config", slot: "wallpaper-config", type: "json",
            default: { type: "default", url: "", name: "Sequoia 经典" },
            control: "json", pane: "wallpaper", group: "墙纸", order: 10, hidden: true,
            label: "当前墙纸",
        },
        {
            key: "wallpaper.autoBing", type: "boolean", default: false,
            control: "switch", pane: "wallpaper", group: "墙纸", order: 20,
            label: "Bing 每日墙纸",
            apply: (value) => wallpaper.setAutoBing(value),
        },

        // ── 光标 cursor.* ────────────────────────────────────────────────
        {
            key: "cursor.size", slot: "cursor-size", type: "number", default: 28, min: 16, max: 64, step: 1,
            control: "slider", units: "px", pane: "mouse", group: "鼠标", order: 10,
            label: "光标大小", apply: (value) => setCursorSize(value),
        },
        {
            key: "cursor.shadow", slot: "cursor-shadow", type: "boolean", default: true,
            control: "switch", pane: "mouse", group: "鼠标", order: 20,
            label: "光标阴影", apply: (value) => setCursorShadow(value),
        },
        {
            // 晃动指针放大由 pointer-shake.js 直接读值决定是否响应，无需 apply；
            // 放在 cursor.* 之后，与「光标」分组保持同一块设置。
            key: "mouse.shakeToFind", type: "boolean", default: true,
            control: "switch", pane: "mouse", group: "鼠标", order: 30,
            label: "晃动指针以查找",
        },

        // ── Siri siri.* ─────────────────────────────────────────────────
        {
            key: "siri.orb.size", slot: "siri-orb-size", type: "number", default: 150, min: 80, max: 300, step: 2,
            control: "slider", units: "px", pane: "siri", group: "Siri", order: 10,
            label: "光球大小", event: "siri-orb-size-change",
        },

        // ── 办公套件品牌包 office.* ─────────────────────────────────────
        {
            key: "office.brandPack", type: "string", default: "iwork",
            values: ["iwork", "ms"], control: "radio", pane: "plugins", group: "办公套件", order: 5,
            hidden: true, label: "名称与图标",
        },

        // ── 控制中心 controlcenter.*（共用一个 JSON 存储槽） ────────────
        ...CONTROL_CENTER_FIELDS.map((field) => ({
            ...field,
            slot: "webstartos_controlcenter",
            jsonPath: field.path,
            control: field.type === "boolean" ? "switch" : (field.values ? "dropdown" : "slider"),
            pane: FOCUS_FIELDS.includes(field.path) ? "focus" : "controlcenter",
            group: FOCUS_FIELDS.includes(field.path) ? "专注模式" : "控制中心",
            apply: (value) => setControlCenterValue(field.path, value),
        })),

        // ── 通知 notify.* ───────────────────────────────────────────────
        {
            key: "notify.enabled", type: "boolean", default: true,
            control: "switch", pane: "notifications", group: "通知", order: 10,
            label: "通知横幅",
            apply: (value) => window.dispatchEvent(new CustomEvent("notify-config-change", { detail: { key: "enabled", value } })),
        },
        {
            key: "notify.sound", type: "boolean", default: true,
            control: "switch", pane: "notifications", group: "通知", order: 20,
            label: "通知提示音",
            apply: (value) => window.dispatchEvent(new CustomEvent("notify-config-change", { detail: { key: "sound", value } })),
        },
        {
            key: "notify.duration", type: "number", default: 5500, min: 2000, max: 15000, step: 500,
            control: "slider", format: "ms", pane: "notifications", group: "通知", order: 30,
            label: "通知停留时长",
            apply: (value) => window.dispatchEvent(new CustomEvent("notify-config-change", { detail: { key: "duration", value } })),
        },

        // ── 键盘 keyboard.* ─────────────────────────────────────────────
        {
            key: "keyboard.menuShortcuts", type: "boolean", default: true,
            control: "switch", pane: "keyboard", group: "键盘", order: 10,
            label: "显示快捷键提示",
            apply: () => window.dispatchEvent(new CustomEvent("keyboard-shortcut-hints-change")),
        },

        // ── 聚焦搜索 spotlight.* ────────────────────────────────────────
        {
            key: "spotlight.apps", type: "boolean", default: true,
            control: "switch", pane: "spotlight", group: "搜索范围", order: 10,
            label: "应用程序",
        },
        {
            key: "spotlight.settings", type: "boolean", default: true,
            control: "switch", pane: "spotlight", group: "搜索范围", order: 20,
            label: "系统设置",
        },
        {
            key: "spotlight.files", type: "boolean", default: true,
            control: "switch", pane: "spotlight", group: "搜索范围", order: 30,
            label: "本地文件", hint: "需先授权文件夹。",
        },
        {
            key: "spotlight.commands", type: "boolean", default: true,
            control: "switch", pane: "spotlight", group: "搜索范围", order: 40,
            label: "系统命令",
        },
        {
            // 手册 App 随扩展内置；索引在首次搜索时才加载（约 70KB），关掉即完全不参与。
            key: "spotlight.manual", type: "boolean", default: true,
            control: "switch", pane: "spotlight", group: "搜索范围", order: 45,
            label: "使用手册",
        },
        {
            key: "spotlight.maxResults", type: "number", default: 12, min: 5, max: 30, step: 1,
            control: "slider", units: "条", pane: "spotlight", group: "聚焦", order: 50,
            label: "最多显示结果",
        },
        {
            key: "spotlight.keepHistory", type: "boolean", default: true,
            control: "switch", pane: "spotlight", group: "聚焦", order: 60,
            label: "保留搜索历史",
        },
    ]);

    // 定义注册完成后，把「只有 CSS 消费者、没有 owner setter」的两项按当前值落到 <html>，
    // 否则首屏要等到用户第一次拨动开关才会带上 data-* 属性。
    document.documentElement.dataset.reduceMotion = settings.get("appearance.reduceMotion") ? "on" : "off";
    document.documentElement.dataset.transparency = settings.get("appearance.transparency") ? "on" : "off";
    return count;
}

export { initSettingsSchema, ACCENT_KEYS };
