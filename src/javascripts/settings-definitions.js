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
 *    （dock.js 的 7 个布局项）填 `event`，由设置中枢按旧格式补发，owner 零改动。
 * 3. **新模块自带定义**：锁屏、声音、显示器、聚焦搜索等新内核模块在自己文件里
 *    `settings.define()`，不塞进本表 —— owner 才是取值范围的权威。
 *
 * `pane` 取的是 `mods/system-settings/registry.js` 里的面板 id（不是旧的 data-page 名），
 * `dev/settings-fulltest.mjs` 会逐条校验两者对得上，改一边忘了改另一边会直接红。
 * 界面元数据（label / hint / control / format / units / group / order / hidden）
 * 只被系统设置读取，内核逻辑一律忽略。
 */

import { settings } from "./settings.js";
import { setTheme, setAccent, setHighlight, setSidebarSize, setTint, setScrollbars } from "./appearance.js";
import { setCursorSize, setCursorShadow } from "./cursor.js";
import { setTrashIcon, TRASH_KEYS } from "./trashIcon.js";
import { setNativeContextMenuEnabled } from "./contextMenuSettings.js";
import { wallpaper } from "./wallpaper.js";
import { i18n } from "./i18n.js";
import { setValue as setControlCenterValue, CONTROL_CENTER_FIELDS } from "./controlcenter.js";
import { initUsageTracker } from "./usage-tracker.js";

/** 强调色候选（与 appearance.js 的 COLOR_MAP 同序，色值由界面侧的 swatches 呈现）。 */
const ACCENT_KEYS = ["multicolor", "blue", "purple", "pink", "red", "orange", "yellow", "green", "gray"];

/** 控制中心各字段统一留在控制中心面板。 */

/**
 * 界面整体缩放落到 <html> 的 style.zoom（Chromium 支持布局级缩放）。
 * 100% 时清掉内联值；Node 环境（settings-fulltest）没有 document，直接跳过。
 * @param {number} value 90..150 的百分比
 * @returns {void}
 */
function applyZoom(value) {
    if (typeof document === "undefined") return;
    const pct = Number(value);
    document.documentElement.style.zoom = (Number.isFinite(pct) && pct !== 100) ? String(pct / 100) : "";
}

/**
 * 增强对比度落到 <html data-contrast>，规则（抬亮 --text-* 令牌）在 main.css。
 * @param {boolean} on 是否开启
 * @returns {void}
 */
function applyContrast(on) {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.contrast = on ? "high" : "off";
}

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
            values: ["zh-CN", "en", "ja-JP", "cat"], control: "dropdown", pane: "datetime", group: "通用", order: 10,
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
            valuesLabel: ["24 小时", "12 小时"], control: "segmented", pane: "datetime", group: "通用", order: 20,
            label: "时间格式",
            apply: () => window.dispatchEvent(new CustomEvent("datetime-format-change")),
        },
        {
            key: "general.showSeconds", type: "boolean", default: false,
            control: "switch", pane: "datetime", group: "通用", order: 30,
            label: "显示秒",
            apply: () => window.dispatchEvent(new CustomEvent("datetime-format-change")),
        },
        {
            key: "general.weekStart", type: "number", default: 1, min: 0, max: 1, step: 1,
            values: [0, 1], valuesLabel: ["周日", "周一"], control: "segmented",
            pane: "datetime", group: "通用", order: 40,
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
            key: "dock.minimize.effect", type: "string", default: "genie",
            values: ["genie", "scale"], valuesLabel: ["神奇效果", "缩放淡出"],
            control: "segmented", pane: "dock", group: "程序坞", order: 45,
            label: "最小化窗口使用", event: "dock-minimize-effect-change",
        },
        {
            // F-16：最小化窗口的落点。app = 吸入应用图标（出厂默认，落点是带运行指示灯的
            // 那枚图标）；tile = 程序坞分隔条右侧的独立磁贴区。消费方 dock.js。
            key: "dock.minimizeStyle", slot: "dock-minimize-style", type: "string", default: "app",
            values: ["app", "tile"], valuesLabel: ["放入应用图标", "放在程序坞右侧"],
            control: "segmented", pane: "dock", group: "程序坞", order: 46,
            label: "最小化窗口时", event: "dock-minimize-style-change",
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
        {
            // 与存储面板的推荐项共用同一个槽位：面板上的开关和这里的定义是同一条设置，
            // 真正的清理由 trash.js 的 pruneOldTrash 执行（见 trash.js 的设置监听）。
            key: "trash.autoEmpty", slot: "trash-autoEmpty", type: "boolean", default: false,
            control: "switch", pane: "dock", group: "桌面", order: 105,
            label: "自动清倒废纸篓", hint: "抹掉超过 30 天的项目",
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
            control: "json", pane: "appearance", group: "墙纸", order: 10, hidden: true,
            label: "当前墙纸",
        },
        {
            key: "wallpaper.autoBing", type: "boolean", default: false,
            control: "switch", pane: "appearance", group: "墙纸", order: 20,
            label: "Bing 每日墙纸",
            apply: (value) => wallpaper.setAutoBing(value),
        },
        {
            // macOS 式动态墙纸：wallpaper.js 的引擎按时段在系统三张壁纸间自动切换。
            key: "wallpaper.dynamic", type: "boolean", default: false,
            control: "switch", pane: "appearance", group: "墙纸", order: 30,
            label: "动态墙纸",
            apply: (value) => wallpaper.setDynamicEnabled(value),
        },
        {
            // 动态时段表（小时 -> 系统壁纸 id）：黎明 5-8 经典 / 白天 8-17 白昼 / 17 点起夜色。
            // 黄昏与深夜共用夜色一张图，所以视觉上是三档；表留成数据，将来可换多套素材。
            key: "wallpaper.dynamicSet", type: "json",
            default: {
                slots: [
                    { from: 5, systemId: "sequoia-default" },
                    { from: 8, systemId: "sequoia-day" },
                    { from: 17, systemId: "sequoia-night" },
                ],
            },
            control: "json", pane: "appearance", group: "墙纸", order: 40, hidden: true,
            label: "动态时段表",
        },
        {
            // 图集墙纸：地址数组按 albumInterval 分钟轮换，交叉淡入由 wallpaper.js 完成。
            key: "wallpaper.album", type: "json", default: [],
            control: "json", pane: "appearance", group: "墙纸", order: 50, hidden: true,
            label: "图集地址列表",
        },
        {
            key: "wallpaper.albumInterval", type: "number", default: 30, min: 5, max: 120, step: 5,
            control: "slider", units: "分钟", pane: "appearance", group: "墙纸", order: 60,
            label: "图集换图间隔",
        },

        // ── 辅助功能 accessibility.*（无独立 owner，生效函数就地写 <html>） ─
        {
            // 界面整体缩放：写 <html> 的 style.zoom，Chromium 原生支持，布局随缩放重排。
            key: "accessibility.zoom", type: "number", default: 100, min: 90, max: 150, step: 5,
            control: "slider", units: "%", pane: "accessibility", group: "视觉", order: 10,
            label: "缩放",
            apply: (value) => applyZoom(value),
        },
        {
            // 增强对比度：抬高 --text-* 令牌不透明度、窗口描边加深，规则见 main.css 的 data-contrast 块。
            key: "accessibility.contrast", type: "boolean", default: false,
            control: "switch", pane: "accessibility", group: "视觉", order: 20,
            label: "增强对比度",
            apply: (value) => applyContrast(value),
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
        {
            // 晃动放大的目标倍数：cursor.js 在 pulse 起跳帧现读（shakeFactor），无需 apply。
            // 上限 4 倍：配合 cursor.js 的放大像素上限（128px）保证大基准下也能看出差别。
            key: "mouse.shakeScale", type: "number", default: 1.6, min: 1.1, max: 4, step: 0.1,
            units: "倍", control: "slider", pane: "mouse", group: "鼠标", order: 40,
            label: "晃动放大倍数",
        },
        {
            // 触发放大所需的累计位移阈值：pointer-shake.js 判定时现读。
            key: "mouse.shakeDistance", type: "number", default: 48, min: 24, max: 200, step: 4,
            units: "px", control: "slider", pane: "mouse", group: "鼠标", order: 41,
            label: "晃动触发距离",
        },
        {
            // 放大后的保持时长：pointer-shake.js 触发时现读并传给 pulseCursor。
            key: "mouse.shakeHold", type: "number", default: 1200, min: 400, max: 3000, step: 100,
            units: "毫秒", control: "slider", pane: "mouse", group: "鼠标", order: 42,
            label: "放大后停留",
        },
        {
            // 回弹强度（过冲系数）：cursor.js 起跳帧现读；1 = 无过冲（直接到位）。
            key: "mouse.shakeOvershoot", type: "number", default: 1.12, min: 1, max: 1.4, step: 0.02,
            units: "倍", control: "slider", pane: "mouse", group: "鼠标", order: 43,
            label: "回弹强度",
        },

        // ── 统一 AI ai.* ───────────────────────────────────────────────
        {
            key: "ai.provider", type: "string", default: "deepseek",
            values: ["deepseek", "openai", "moonshot", "qwen", "ollama", "custom"],
            pane: "siri", group: "AI 服务", order: 20, hidden: true, label: "服务商",
        },
        {
            key: "ai.model", type: "string", default: "",
            pane: "siri", group: "AI 服务", order: 21, hidden: true, label: "模型",
        },
        {
            key: "ai.baseUrl", type: "string", default: "",
            pane: "siri", group: "AI 服务", order: 22, hidden: true, label: "服务地址",
        },
        {
            key: "ai.keys", type: "json", default: {},
            pane: "siri", group: "AI 服务", order: 23, hidden: true, label: "密钥",
        },
        {
            key: "ai.temperature", type: "number", default: 1, min: 0, max: 2, step: 0.1,
            control: "slider", pane: "siri", group: "高级", order: 30, label: "温度",
        },
        {
            key: "ai.thinking", type: "string", default: "medium",
            values: ["off", "low", "medium", "high"],
            valuesLabel: ["关闭", "低", "中", "高"],
            pane: "siri", group: "高级", order: 31, label: "思考强度",
        },
        {
            key: "ai.maxTokens", type: "number", default: 4096, min: 512, max: 8192, step: 256,
            control: "slider", units: "tokens", pane: "siri", group: "高级", order: 32, label: "最多输出",
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
            pane: "controlcenter",
            group: "控制中心",
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

        // ── 屏幕使用时间 screenTime.*（账本与停用时间引擎在 usage-tracker.js） ─
        {
            key: "screenTime.enabled", type: "boolean", default: true,
            control: "switch", pane: "screenTime", group: "屏幕使用时间", order: 10,
            label: "记录使用情况",
        },
        {
            // 停用时间：{enabled,start,end,days}，days 为 0-6（周日=0）。
            // 到点由 usage-tracker 发一条真实横幅，并弹出可用口令解除的闸门。
            key: "screenTime.downtime", type: "json",
            default: { enabled: false, start: "23:00", end: "07:00", days: [1, 2, 3, 4, 5] },
            control: "json", pane: "screenTime", group: "屏幕使用时间", order: 20, hidden: true,
            label: "停用时间计划",
        },
        {
            // 停用期间仍可使用的应用（[{id,name}]，由面板勾选写入）。
            key: "screenTime.allowAlways", type: "json", default: [],
            control: "json", pane: "screenTime", group: "屏幕使用时间", order: 30, hidden: true,
            label: "始终允许的应用",
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
    // 辅助功能两项同理：缩放与对比度只有 CSS/DOM 消费者，开机先把当前值铺上。
    applyZoom(settings.get("accessibility.zoom"));
    applyContrast(settings.get("accessibility.contrast"));
    // 屏幕使用时间的账本与停用时间引擎随 boot 一起点亮（内部自带幂等与 Node 环境短路）。
    initUsageTracker();
    return count;
}

export { initSettingsSchema, ACCENT_KEYS };
