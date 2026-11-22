/**
 * registry.js — 面板注册表（界面上出现什么，由这一张表说了算）
 *
 * 为什么要注册表而不是把侧栏写死在 HTML 里：
 * 旧版 23 个侧栏项里有 16 个是 `<p class="b">还没做😡😭</p>` 的占位页，用户点进去
 * 只能看到「未完成」，界面被自己的未完成项占满。现在每一项显式声明 `implemented`：
 * - `implemented: true` —— 渲染进侧栏，并可被搜索与深链跳转命中；
 * - `implemented: false` —— **只留接口**：条目、图标、分组、模块路径都在表里，
 *   将来补上 `panes/<module>.js` 并把标记改成 true 即可上架，但不再出现在界面上，
 *   也不再生成任何占位 DOM。`reason` 写明为什么还没做（多为浏览器能力边界）。
 *
 * 每项的 `module` 是 `panes/` 下的文件名，由 app.js 动态 import；未实现项不会被 import。
 */

import { assetPath, glyph } from "../../src/javascripts/paths.js";
import { i18n } from "../../src/javascripts/i18n.js";

/**
 * 侧栏图标统一为单色字形：与 assets/images 的 glyph() 同一观感（同网格、同视觉重量），
 * 靠 style.css 的 brightness(0) 压黑 + 主题反白，不再混入彩色拟物 PNG。
 * glyph() 库里没有的四枚（存储 / Siri / App / 开发者）以内联 data-URI 补，风格对齐。
 */
const ICON_STORAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 7c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2H4zm0 2h16v6H4V9zm13.5 3.7a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9z'/%3E%3C/svg%3E";
const ICON_SIRI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 1.8a7.2 7.2 0 1 1 0 14.4 7.2 7.2 0 0 1 0-14.4zm0 3a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4z'/%3E%3C/svg%3E";
const ICON_PLUGINS = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4.5 4.5h6.5v6.5H4.5V4.5zm8.5 0h6.5v6.5H13V4.5zM4.5 13h6.5v6.5H4.5V13zm8.5 0h6.5v6.5H13V13z'/%3E%3C/svg%3E";
const ICON_DEBUG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2H4zm0 2h16v10H4V7zm1.3 1.2l3 3.3-3 3.3 1.1 1 4-4.3-4-4.3-1.1 1zm6.7 5.1h5v1.5h-5v-1.5z'/%3E%3C/svg%3E";
const ICON_DATETIME = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 1.8a7.2 7.2 0 1 1 0 14.4 7.2 7.2 0 0 1 0-14.4zM11.1 7v5.4l4.2 2.5.9-1.5-3.3-2V7h-1.8z'/%3E%3C/svg%3E";
const ICON_ABOUT = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 1.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4zM11.1 6.5a1.1 1.1 0 1 0 1.8.8 1.1 1.1 0 0 0-1.8-.8zM10.9 10v7.5h2.2V10h-2.2z'/%3E%3C/svg%3E";
const ICON_ACCESSIBILITY = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4.2 8.1c-.5-.1-.9.3-.9.8 0 .4.2.7.6.8l5.1 1.2v2.4l-1.5 6c-.1.4.2.8.6.8.3 0 .6-.2.7-.5l1.7-5.2h3l1.7 5.2c.1.3.4.5.7.5.4 0 .7-.4.6-.8l-1.5-6v-2.4l5.1-1.2c.4-.1.6-.4.6-.8 0-.5-.4-.9-.9-.8-2.1.5-4.3.8-6.8.8s-4.7-.3-6.8-.8z'/%3E%3C/svg%3E";
const ICON_FILE_TYPES = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 2H6v16h11V8h-4V4zM8.5 11h6v1.6h-6V11zm0 3.4h6v1.6h-6v-1.6z'/%3E%3C/svg%3E";
const ICON_PROTOCOLS = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M9.6 14.4a3.2 3.2 0 0 1-4.5 0l-1-1a3.2 3.2 0 0 1 4.5-4.5l1.4 1.4-1.3 1.3-1.4-1.4a1.4 1.4 0 1 0-2 2l1 1a1.4 1.4 0 0 0 2 0l1.3 1.2zm1-5.6l1.3-1.2a3.2 3.2 0 0 1 4.5 4.5l-1 1a3.2 3.2 0 0 1-4.5 0l1.3-1.3a1.4 1.4 0 0 0 2 0l1-1a1.4 1.4 0 1 0-2-2l-1.3 1.3-1.3-1.3z'/%3E%3C/svg%3E";
const ICON_COLORS = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.6-1.4-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zm-4.5 9a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm3-4a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4.5 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm3 4a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z'/%3E%3C/svg%3E";
const ICON_SURFACE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4h16v4H4V4zm0 6h16v4H4v-4zm0 6h16v4H4v-4z'/%3E%3C/svg%3E";
const ICON_TINT = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3c3.3 4 6 7.1 6 10a6 6 0 0 1-12 0c0-2.9 2.7-6 6-10zm0 3.6C10.4 8.4 8 10.9 8 13a4 4 0 0 0 8 0c0-2.1-2.4-4.6-4-6.4z'/%3E%3C/svg%3E";
const ICON_DESKTOP = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 4h18v12H3V4zm2 2v8h14V6H5zm4 11h6v2h3v2H6v-2h3v-2z'/%3E%3C/svg%3E";
const ICON_WALLPAPER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 4h18v16H3V4zm2 2v9l4-4 3 3 3-4 4 5V6H5zm2.5 2.5A1.5 1.5 0 1 1 7.5 12 1.5 1.5 0 0 1 7.5 8.5z'/%3E%3C/svg%3E";

/**
 * 侧栏面板名与分组名的四语词条。
 *
 * 为什么放在注册表里而不是各面板的 messages 里：这两个字符串是**外壳**要显示的
 * （app.js 用 t(entry.i18nKey, entry.label) 渲染侧栏与工具栏标题），
 * 而外壳先于任何面板求值。放在这里随注册表一起注册，切语言时侧栏才跟着变；
 * 散到 19 个面板模块里则会出现「面板已注册、侧栏还是中文」的半截状态。
 */
const LABELS = {
    "zh-CN": {
        ss: {
            group: { account: "Edgerd 账户", connectivity: "网络与连接", alerts: "通知", system: "通用与外观", desktop: "桌面与显示器", peripherals: "键盘与鼠标", developer: "开发者" },
            pane: {
                account: "Edgerd 账户", general: "通用", storage: "储存", datetime: "时间与地区", about: "关于本机",
                spotlight: "聚焦", search: "网络",
                controlcenter: "控制中心", wallpaper: "墙纸", appearance: "外观", accessibility: "辅助功能", display: "显示器",
                "controlcenter-switches": "开关", "controlcenter-menubar": "菜单栏状态项", "controlcenter-live": "实时状态",
                "appearance-colors": "颜色与主题", "appearance-surface": "侧栏与模糊",
                "appearance-tint": "窗口与菜单栏", "appearance-desktop": "桌面与滚动", "appearance-wallpaper": "墙纸",
                dock: "桌面与程序坞", siri: "Apple 智能与 Siri", notifications: "通知", sound: "声音", focus: "专注模式",
                "dock-main": "程序坞", "dock-desktop": "桌面", "dock-stage": "台前调度", "dock-windows": "窗口与启动台",
                screenTime: "屏幕使用时间", "lock-screen": "锁定屏幕", password: "密码", screensaver: "屏幕保护程序",
                "screen-time-usage": "使用情况", "screen-time-downtime": "停用时间", "screen-time-allow": "始终允许",
                privacy: "隐私与安全性", users: "用户与群组", icloud: "iCloud",
                keyboard: "键盘", mouse: "鼠标", plugins: "App", debug: "开发者", defaultApps: "默认应用",
                "file-types": "文件类型", "file-protocols": "协议与网页",
                whatsNew: "新功能",
            },
        },
    },
    "en": {
        ss: {
            group: { account: "Edgerd Account", connectivity: "Network & Connections", alerts: "Notifications", system: "General & Appearance", desktop: "Desktop & Displays", peripherals: "Keyboard & Mouse", developer: "Developer" },
            pane: {
                account: "Edgerd Account", general: "General", storage: "Storage", datetime: "Date & Time", about: "About This Mac",
                spotlight: "Spotlight", search: "Network",
                controlcenter: "Control Center", wallpaper: "Wallpaper", appearance: "Appearance", accessibility: "Accessibility", display: "Displays",
                "controlcenter-switches": "Switches", "controlcenter-menubar": "Menu Bar Status Items", "controlcenter-live": "Live State",
                "appearance-colors": "Colors & Theme", "appearance-surface": "Sidebar & Blur",
                "appearance-tint": "Windows & Menu Bar", "appearance-desktop": "Desktop & Scrolling", "appearance-wallpaper": "Wallpaper",
                dock: "Desktop & Dock", siri: "Apple Intelligence & Siri", notifications: "Notifications", sound: "Sound", focus: "Focus",
                "dock-main": "Dock", "dock-desktop": "Desktop", "dock-stage": "Stage Manager", "dock-windows": "Windows & Launchpad",
                screenTime: "Screen Time", "lock-screen": "Lock Screen", password: "Passwords", screensaver: "Screen Saver",
                "screen-time-usage": "Usage", "screen-time-downtime": "Downtime", "screen-time-allow": "Always Allowed",
                privacy: "Privacy & Security", users: "Users & Groups", icloud: "iCloud",
                keyboard: "Keyboard", mouse: "Mouse", plugins: "Apps", debug: "Developer", defaultApps: "Default Apps",
                "file-types": "File Types", "file-protocols": "Protocols & Web",
                whatsNew: "What's New",
            },
        },
    },
    "ja-JP": {
        ss: {
            group: { account: "Edgerd アカウント", connectivity: "ネットワークと接続", alerts: "通知", system: "一般と外観", desktop: "デスクトップとディスプレイ", peripherals: "キーボードとマウス", developer: "開発者" },
            pane: {
                account: "Edgerd アカウント", general: "一般", storage: "ストレージ", datetime: "日付と時刻", about: "この Mac について",
                spotlight: "Spotlight", search: "ネットワーク",
                controlcenter: "コントロールセンター", wallpaper: "壁紙", appearance: "外観", accessibility: "アクセシビリティ", display: "ディスプレイ",
                "controlcenter-switches": "スイッチ", "controlcenter-menubar": "メニューバーのステータス項目", "controlcenter-live": "ライブ状態",
                "appearance-colors": "色とテーマ", "appearance-surface": "サイドバーとぼかし",
                "appearance-tint": "ウインドウとメニューバー", "appearance-desktop": "デスクトップとスクロール", "appearance-wallpaper": "壁紙",
                dock: "デスクトップとDock", siri: "Apple Intelligence と Siri", notifications: "通知", sound: "サウンド", focus: "集中モード",
                "dock-main": "Dock", "dock-desktop": "デスクトップ", "dock-stage": "ステージマネージャ", "dock-windows": "ウインドウとLaunchpad",
                screenTime: "スクリーンタイム", "lock-screen": "ロック画面", password: "パスワード", screensaver: "スクリーンセーバ",
                "screen-time-usage": "使用状況", "screen-time-downtime": "ダウンタイム", "screen-time-allow": "常に許可",
                privacy: "プライバシーとセキュリティ", users: "ユーザーとグループ", icloud: "iCloud",
                keyboard: "キーボード", mouse: "マウス", plugins: "App", debug: "開発者", defaultApps: "デフォルトアプリ",
                "file-types": "ファイル形式", "file-protocols": "プロトコルとウェブ",
                whatsNew: "新機能",
            },
        },
    },
    cat: {
        ss: {
            group: { account: "Edgerd 账户喵", connectivity: "网络同连接喵", alerts: "通知喵", system: "通用同外观喵", desktop: "桌面同显示器喵", peripherals: "键盘同鼠标喵", developer: "开发者喵" },
            pane: {
                account: "Edgerd 账户喵", general: "通用喵", storage: "存东西的地方喵", datetime: "日子同地方喵", about: "呢部机嘅档案喵",
                spotlight: "聚焦喵", search: "网络喵",
                controlcenter: "控制中心喵", wallpaper: "墙纸喵", appearance: "外观喵", accessibility: "辅助功能喵", display: "显示器喵",
                "controlcenter-switches": "开关喵", "controlcenter-menubar": "菜单栏的小状态喵", "controlcenter-live": "现在什么样喵",
                "appearance-colors": "颜色同主题喵", "appearance-surface": "侧栏同模糊喵",
                "appearance-tint": "窗口同菜单栏喵", "appearance-desktop": "桌面同滚动喵", "appearance-wallpaper": "墙纸喵",
                dock: "桌面与程序坞喵", siri: "Apple 智能同 Siri 喵", notifications: "通知喵", sound: "声音喵", focus: "专注模式喵",
                "dock-main": "程序坞喵", "dock-desktop": "桌面喵", "dock-stage": "台前调度喵", "dock-windows": "窗口同启动台喵",
                screenTime: "屏幕使用时间喵", "lock-screen": "锁定屏幕喵", password: "密码喵", screensaver: "屏幕保护程序喵",
                "screen-time-usage": "用咗几多喵", "screen-time-downtime": "停用时间喵", "screen-time-allow": "一直准许喵",
                privacy: "隐私与安全性喵", users: "用户与群组喵", icloud: "iCloud 喵",
                keyboard: "键盘喵", mouse: "鼠标喵", plugins: "App 喵", debug: "开发者喵", defaultApps: "开东西的应用喵",
                "file-types": "文件格式喵", "file-protocols": "协议跟网页喵",
                whatsNew: "新功能喵",
            },
        },
    },
};

/**
 * 侧栏分组：照 macOS 15 系统设置的簇划分，不再按「先外观、再输入」自拟顺序。
 * 苹果自上而下的五簇是：连接（Wi‑Fi / 蓝牙 / 网络）→ 通知与专注（通知 / 声音 / 专注 /
 * 屏幕使用时间）→ 通用与外观（通用 / 外观 / 辅助功能 / 控制中心 / Siri 与聚焦 /
 * 隐私与安全性）→ 桌面与显示器（桌面与程序坞 / 显示器 / 墙纸 / 电池 / 锁屏 /
 * 触控 ID 与密码 / 用户与群组 / 互联网账户 / 游戏中心 / 钱包）→ 键盘与鼠标
 * （键盘 / 触控板 / 鼠标 / 打印机与扫描仪）。
 * 账户行在苹果那里独立于所有分组，压在最上面，这里同样单独成组（未实现，不占位置）。
 * 本机没有可用面板的簇整簇省略（sidebarGroups 会滤掉空组），不留空档。
 * 「开发者」没有对应的苹果簇，单列一簇压在最后，与「键盘与鼠标」之间留出分组空隙。
 */
const PANE_GROUPS = [
    { id: "account", label: "Edgerd 账户", i18nKey: "ss.group.account" },
    { id: "connectivity", label: "网络与连接", i18nKey: "ss.group.connectivity" },
    { id: "alerts", label: "通知与专注", i18nKey: "ss.group.alerts" },
    { id: "system", label: "通用与外观", i18nKey: "ss.group.system" },
    { id: "desktop", label: "桌面与显示器", i18nKey: "ss.group.desktop" },
    { id: "peripherals", label: "键盘与鼠标", i18nKey: "ss.group.peripherals" },
    { id: "developer", label: "开发者", i18nKey: "ss.group.developer" },
];

/**
 * 全部面板条目，数组顺序即侧栏显示顺序（分组内再按 `order` 排）。
 * 相对位置对齐 macOS 15 系统设置；苹果有而本机没有的面板不占位，本机独有的条目
 * 插在语义最近的邻居旁（见各项 `inserted` 说明）。
 * `keywords` 供侧栏搜索框与「聚焦」统一搜索命中（中文同义词写在这里，不进译文表）。
 */
const PANES = [
    {
        id: "account", group: "account", module: "account", implemented: false,
        icon: assetPath("images/author.webp"), label: "Edgerd 账户", i18nKey: "ss.pane.account",
        reason: "账户体系需要服务端登录态，纯前端扩展内没有可对接的身份源；只保留条目与跳转接口。",
        keywords: ["账户", "apple", "id", "登录"],
    },
    {
        // 苹果把它放在「Wi‑Fi / 蓝牙」同一簇，本机没有那两项，这条也未实现，因此整簇不上架。
        id: "search", group: "connectivity", module: "search", implemented: false,
        icon: glyph("network"), label: "网络", i18nKey: "ss.pane.search",
        reason: "与「聚焦」是同一能力的两个入口，0.2.37 把「网络」改名「搜索」后一直空置；合并进聚焦，不再单列。",
        keywords: ["搜索", "网络"],
    },
    {
        id: "notifications", group: "alerts", module: "notifications", implemented: true, order: 1,
        icon: glyph("bell.badge.fill"), label: "通知", i18nKey: "ss.pane.notifications",
        keywords: ["通知", "横幅", "权限", "时长", "提示音"],
    },
    {
        id: "sound", group: "alerts", module: "sound", implemented: true, order: 2,
        icon: glyph("speaker.wave.3.fill"), label: "声音", i18nKey: "ss.pane.sound",
        keywords: ["音量", "静音", "提示音", "声音"],
    },
    {
        id: "screenTime", group: "alerts", module: "screen-time", implemented: true, order: 3,
        icon: glyph("hourglass"), label: "屏幕使用时间", i18nKey: "ss.pane.screenTime",
        keywords: ["屏幕时间", "使用统计", "停用时间", "前台时长"],
    },
    {
        // 屏幕使用时间的子页：父页只摆跳转行。
        id: "screen-time-usage", group: "alerts", module: "screen-time-usage", implemented: true, order: 3.1, parent: "screenTime",
        icon: glyph("hourglass"), label: "使用情况", i18nKey: "ss.pane.screen-time-usage",
        keywords: ["屏幕时间", "今日使用", "记录", "榜单"],
    },
    {
        id: "screen-time-downtime", group: "alerts", module: "screen-time-downtime", implemented: true, order: 3.2, parent: "screenTime",
        icon: glyph("moon.fill"), label: "停用时间", i18nKey: "ss.pane.screen-time-downtime",
        keywords: ["停用时间", "计划", "星期", "口令"],
    },
    {
        id: "screen-time-allow", group: "alerts", module: "screen-time-allow", implemented: true, order: 3.3, parent: "screenTime",
        icon: glyph("hand.raised.fill"), label: "始终允许", i18nKey: "ss.pane.screen-time-allow",
        keywords: ["始终允许", "白名单", "停用期间"],
    },
    {
        // 「App」提前到通用簇首位：它既是 App 清单，也是默认应用与 App 自注册设置项的入口。
        id: "plugins", group: "system", module: "plugins", implemented: true, order: 1,
        icon: ICON_PLUGINS, label: "App", i18nKey: "ss.pane.plugins",
        keywords: ["App", "apps", "应用", "扩展", "插件", "第三方设置", "应用设置", "默认应用", "打开方式"],
    },
    {
        // App 下的子项：不出现在左栏，由 App 页顶部的跳转行（.ss-linkrow）进入。
        id: "file-types", group: "system", module: "file-types", implemented: true, order: 1.1, parent: "plugins",
        icon: ICON_FILE_TYPES, label: "文件类型", i18nKey: "ss.pane.file-types",
        keywords: ["文件类型", "默认应用", "打开方式", "扩展名", "后缀"],
    },
    {
        id: "file-protocols", group: "system", module: "file-protocols", implemented: true, order: 1.2, parent: "plugins",
        icon: ICON_PROTOCOLS, label: "协议与网页", i18nKey: "ss.pane.file-protocols",
        keywords: ["协议", "网页", "链接", "默认应用", "打开方式"],
    },
    {
        id: "general", group: "system", module: "general", implemented: true, order: 2,
        icon: glyph("gear"), label: "通用", i18nKey: "ss.pane.general",
        keywords: ["通用", "启动", "备份", "恢复", "更新"],
    },
    {
        // 通用下的子项：不出现在左栏，由通用页顶部的跳转行（.ss-linkrow）进入。
        id: "about", group: "system", module: "about", implemented: true, order: 2.3, parent: "general",
        icon: ICON_ABOUT, label: "关于本机", i18nKey: "ss.pane.about",
        keywords: ["关于", "版本", "插件", "更新日志", "新功能", "系统信息"],
    },
    {
        id: "storage", group: "system", module: "storage", implemented: true, order: 2.1, parent: "general",
        icon: ICON_STORAGE, label: "储存", i18nKey: "ss.pane.storage",
        keywords: ["储存", "存储", "根目录", "文件夹", "授权", "下载", "文档", "图片", "空间"],
    },
    {
        id: "datetime", group: "system", module: "datetime", implemented: true, order: 2.2, parent: "general",
        icon: ICON_DATETIME, label: "时间与地区", i18nKey: "ss.pane.datetime",
        keywords: ["时间", "日期", "语言", "地区", "时区", "格式"],
    },
    {
        id: "appearance", group: "system", module: "appearance", implemented: true, order: 3,
        icon: glyph("moonphase.last.quarter.inverse"), label: "外观", i18nKey: "ss.pane.appearance",
        keywords: ["浅色", "深色", "自动", "强调色", "高亮", "滚动条", "透明度", "动画"],
    },
    {
        // 外观的子页：父页只摆跳转行，具体设置按主题分开。
        id: "appearance-colors", group: "system", module: "appearance-colors", implemented: true, order: 3.1, parent: "appearance",
        icon: ICON_COLORS, label: "颜色与主题", i18nKey: "ss.pane.appearance-colors",
        keywords: ["外观", "颜色", "主题", "浅色", "深色", "强调色", "高亮"],
    },
    {
        id: "appearance-surface", group: "system", module: "appearance-surface", implemented: true, order: 3.2, parent: "appearance",
        icon: ICON_SURFACE, label: "侧栏与模糊", i18nKey: "ss.pane.appearance-surface",
        keywords: ["侧栏", "边栏", "模糊", "毛玻璃", "图标大小", "表面"],
    },
    {
        id: "appearance-tint", group: "system", module: "appearance-tint", implemented: true, order: 3.3, parent: "appearance",
        icon: ICON_TINT, label: "窗口与菜单栏", i18nKey: "ss.pane.appearance-tint",
        keywords: ["着色", "墙纸", "菜单栏", "顶栏", "文字颜色", "窗口"],
    },
    {
        id: "appearance-desktop", group: "system", module: "appearance-desktop", implemented: true, order: 3.4, parent: "appearance",
        icon: ICON_DESKTOP, label: "桌面与滚动", i18nKey: "ss.pane.appearance-desktop",
        keywords: ["桌面", "程序坞", "启动台", "滚动条", "动效", "透明度"],
    },
    {
        id: "appearance-wallpaper", group: "system", module: "appearance-wallpaper", implemented: true, order: 3.5, parent: "appearance",
        icon: ICON_WALLPAPER, label: "墙纸", i18nKey: "ss.pane.appearance-wallpaper",
        keywords: ["墙纸", "壁纸", "背景", "图片"],
    },
    {
        id: "accessibility", group: "system", module: "accessibility", implemented: true, order: 4,
        icon: ICON_ACCESSIBILITY, label: "辅助功能", i18nKey: "ss.pane.accessibility",
        keywords: ["辅助功能", "缩放", "对比度", "减少动态", "指针", "字幕"],
    },
    {
        id: "controlcenter", group: "system", module: "controlcenter", implemented: true, order: 5,
        icon: glyph("switch.2"), label: "控制中心", i18nKey: "ss.pane.controlcenter",
        keywords: ["控制中心", "菜单", "图标", "开关", "wi-fi", "蓝牙"],
    },
    {
        // 控制中心的子页：父页只摆跳转行。
        id: "controlcenter-switches", group: "system", module: "controlcenter-switches", implemented: true, order: 5.1, parent: "controlcenter",
        icon: glyph("switch.2"), label: "开关", i18nKey: "ss.pane.controlcenter-switches",
        keywords: ["控制中心", "开关", "台前调度", "菜单栏图标"],
    },
    {
        id: "controlcenter-menubar", group: "system", module: "controlcenter-menubar", implemented: true, order: 5.2, parent: "controlcenter",
        icon: glyph("menubar.dock.rectangle"), label: "菜单栏状态项", i18nKey: "ss.pane.controlcenter-menubar",
        keywords: ["菜单栏", "状态项", "电池", "台前调度", "拖动", "恢复默认"],
    },
    {
        id: "controlcenter-live", group: "system", module: "controlcenter-live", implemented: true, order: 5.3, parent: "controlcenter",
        icon: glyph("antenna.radiowaves.left.and.right"), label: "实时状态", i18nKey: "ss.pane.controlcenter-live",
        keywords: ["实时", "当前状态", "打开控制中心", "不可用"],
    },
    {
        id: "siri", group: "system", module: "siri", implemented: true, order: 6,
        icon: ICON_SIRI, label: "Apple 智能与 Siri", i18nKey: "ss.pane.siri",
        keywords: ["apple 智能", "人工智能", "ai", "密钥", "模型", "服务商", "siri", "语音"],
    },
    {
        // 苹果把「Siri」与「Spotlight」合成一项「Siri 与聚焦」；本机是两个独立面板，按苹果顺序相邻摆。
        id: "spotlight", group: "system", module: "spotlight", implemented: true, order: 7,
        icon: glyph("magnifyingglass"), label: "聚焦", i18nKey: "ss.pane.spotlight",
        keywords: ["搜索", "聚焦", "spotlight", "快捷键"],
    },
    {
        id: "privacy", group: "system", module: "privacy", implemented: true, order: 8,
        icon: glyph("hand.raised.fill"), label: "隐私与安全性", i18nKey: "ss.pane.privacy",
        keywords: ["隐私", "权限", "麦克风", "相机", "定位", "通知授权", "清除数据"],
    },
    {
        id: "dock", group: "desktop", module: "dock", implemented: true, order: 1,
        icon: glyph("menubar.dock.rectangle"), label: "桌面与程序坞", i18nKey: "ss.pane.dock",
        keywords: ["程序坞", "dock", "放大", "位置", "废纸篓", "右键菜单", "指示灯"],
    },
    {
        // 桌面与程序坞的子页：父页只摆跳转行。
        id: "dock-main", group: "desktop", module: "dock-main", implemented: true, order: 1.1, parent: "dock",
        icon: ICON_SURFACE, label: "程序坞", i18nKey: "ss.pane.dock-main",
        keywords: ["程序坞", "大小", "位置", "自动隐藏", "放大", "最小化"],
    },
    {
        id: "dock-desktop", group: "desktop", module: "dock-desktop", implemented: true, order: 1.2, parent: "dock",
        icon: ICON_DESKTOP, label: "桌面", i18nKey: "ss.pane.dock-desktop",
        keywords: ["桌面", "废纸篓", "右键菜单", "台前调度桌面"],
    },
    {
        id: "dock-stage", group: "desktop", module: "dock-stage", implemented: true, order: 1.3, parent: "dock",
        icon: ICON_WALLPAPER, label: "台前调度", i18nKey: "ss.pane.dock-stage",
        keywords: ["台前调度", "stage manager", "窗口排列", "最近使用"],
    },
    {
        id: "dock-windows", group: "desktop", module: "dock-windows", implemented: true, order: 1.4, parent: "dock",
        icon: ICON_DEBUG, label: "窗口与启动台", i18nKey: "ss.pane.dock-windows",
        keywords: ["窗口", "平铺", "启动台", "图标大小", "文字大小"],
    },
    {
        // 苹果的「锁屏」与「触控 ID 与密码」在「电池」之后、同一簇；本机把两者合成一个面板。
        id: "lock-screen", group: "desktop", module: "lock-screen", implemented: true, order: 2,
        icon: glyph("lock.fill"), label: "锁定屏幕", i18nKey: "ss.pane.lock-screen",
        keywords: ["锁屏", "空闲", "自动锁定", "会话", "密码", "解锁", "口令"],
    },
    {
        id: "password", group: "desktop", module: "password", implemented: false,
        reason: "锁屏密码与自动锁定已并入「锁定屏幕」面板，不再单独占一栏。",
        icon: glyph("at"), label: "密码", i18nKey: "ss.pane.password",
        keywords: ["密码", "登录密码", "解锁", "口令"],
    },
    {
        id: "users", group: "desktop", module: "users", implemented: false,
        icon: glyph("person.2.fill"), label: "用户与群组", i18nKey: "ss.pane.users",
        reason: "多用户需要各自隔离的存储命名空间，而现在所有设置共用一套 localStorage 槽；接口保留待接。",
        keywords: ["用户", "群组", "账户"],
    },
    {
        id: "icloud", group: "desktop", module: "icloud", implemented: false,
        icon: assetPath("images/icloud.webp"), label: "iCloud", i18nKey: "ss.pane.icloud",
        reason: "同步需要远端账户与服务器；扩展只申请了书签权限，无可用的云存储通道。",
        keywords: ["icloud", "同步", "备份"],
    },
    {
        id: "keyboard", group: "peripherals", module: "keyboard", implemented: true, order: 1,
        icon: glyph("keyboard.fill"), label: "键盘", i18nKey: "ss.pane.keyboard",
        keywords: ["键盘", "快捷键", "按键", "修饰键"],
    },
    {
        id: "mouse", group: "peripherals", module: "mouse", implemented: true, order: 2,
        icon: glyph("magicmouse.fill"), label: "鼠标", i18nKey: "ss.pane.mouse",
        keywords: ["鼠标", "光标", "阴影", "大小"],
    },
    {
        // 苹果没有开发者面板；单列一簇压在整条侧栏最后，与「键盘与鼠标」之间留出分组空隙。
        id: "debug", group: "developer", module: "debug", implemented: true, order: 1,
        icon: ICON_DEBUG, label: "开发者", i18nKey: "ss.pane.debug",
        keywords: ["开发者", "调试", "日志", "运行记录", "诊断", "console"],
    },
];

/**
 * 侧栏要显示的面板（未实现项在这里被过滤掉，不生成任何 DOM）。
 * @param {string} [groupId] 只看某个分组
 * @returns {Array<object>} 面板条目
 */
function implementedPanes(groupId) {
    return PANES
        .filter((p) => p.implemented && (!groupId || p.group === groupId))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

/**
 * 某个面板的二级项（带 parent 的条目），按 order 排。
 * 这些条目不出现在左栏，由父面板页内的 .ss-linkrow 跳转行进入。
 * @param {string} id 一级面板 id
 * @returns {Array<object>} 子项数组
 */
function childPanes(id) {
    return PANES
        .filter((p) => p.implemented && p.parent === id)
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

/**
 * 按分组顺序输出侧栏结构，空分组自动省略。
 * 左栏只放一级面板：带 parent 的子项走父页内的跳转行，不重复占位。
 * @returns {Array<{group:object, panes:Array<object>}>} 分组数组
 */
function sidebarGroups() {
    return PANE_GROUPS
        .map((group) => ({ group, panes: implementedPanes(group.id).filter((p) => !p.parent) }))
        .filter((entry) => entry.panes.length > 0);
}

/**
 * 查面板条目。
 * @param {string} id 面板 id
 * @returns {object|undefined} 条目
 */
function findPane(id) {
    return PANES.find((p) => p.id === id);
}

/**
 * 关键字匹配（标题 + 中文关键词），供侧栏过滤与聚焦搜索共用。
 * @param {string} query 用户输入
 * @param {boolean} [includeUnimplemented] 是否连未实现项一起匹配（聚焦搜索里用于提示「未提供」）
 * @returns {Array<object>} 命中的面板条目
 */
function matchPanes(query, includeUnimplemented = false) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    return PANES.filter((p) => (includeUnimplemented || p.implemented))
        .filter((p) => p.label.toLowerCase().includes(q)
            || p.id.toLowerCase().includes(q)
            || (p.keywords || []).some((k) => String(k).toLowerCase().includes(q)));
}

export { PANES, PANE_GROUPS, implementedPanes, sidebarGroups, childPanes, findPane, matchPanes };

// 注册表一求值就把词条交给 i18n：外壳渲染侧栏早于任何面板加载，
// 晚一步注册就会有一帧「界面是英文、侧栏是中文」。
// registerMessages 缺位时（老内核）不报错，界面退回条目里的中文 label。
if (typeof i18n.registerMessagesAll === "function") i18n.registerMessagesAll(LABELS);
