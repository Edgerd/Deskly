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
const ICON_WHATS_NEW = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2zm7 12l.9 2.8 2.8.9-2.8.9-.9 2.8-.9-2.8-2.8-.9 2.8-.9.9-2.8zM5 15l.8 2.4 2.4.8-2.4.8L5 23l-.8-2.4-2.4-.8 2.4-.8L5 15z'/%3E%3C/svg%3E";

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
            group: { account: "Edgerd 账户", connectivity: "网络与连接", alerts: "通知与专注", system: "通用与外观", desktop: "桌面与显示器", peripherals: "键盘与鼠标" },
            pane: {
                account: "Edgerd 账户", general: "通用", storage: "存储", spotlight: "聚焦", search: "网络",
                controlcenter: "控制中心", wallpaper: "墙纸", appearance: "外观", display: "显示器",
                dock: "桌面与程序坞", siri: "Siri", notifications: "通知", sound: "声音", focus: "专注模式",
                screenTime: "屏幕使用时间", "lock-screen": "锁定屏幕", password: "密码",
                privacy: "隐私与安全性", users: "用户与群组", icloud: "iCloud",
                keyboard: "键盘", mouse: "鼠标", plugins: "App", debug: "开发者", defaultApps: "默认应用",
                whatsNew: "新功能",
            },
        },
    },
    "en": {
        ss: {
            group: { account: "Edgerd Account", connectivity: "Network & Connections", alerts: "Notifications & Focus", system: "General & Appearance", desktop: "Desktop & Displays", peripherals: "Keyboard & Mouse" },
            pane: {
                account: "Edgerd Account", general: "General", storage: "Storage", spotlight: "Spotlight", search: "Network",
                controlcenter: "Control Center", wallpaper: "Wallpaper", appearance: "Appearance", display: "Displays",
                dock: "Desktop & Dock", siri: "Siri", notifications: "Notifications", sound: "Sound", focus: "Focus",
                screenTime: "Screen Time", "lock-screen": "Lock Screen", password: "Passwords",
                privacy: "Privacy & Security", users: "Users & Groups", icloud: "iCloud",
                keyboard: "Keyboard", mouse: "Mouse", plugins: "Apps", debug: "Developer", defaultApps: "Default Apps",
                whatsNew: "What's New",
            },
        },
    },
    "ja-JP": {
        ss: {
            group: { account: "Edgerd アカウント", connectivity: "ネットワークと接続", alerts: "通知と集中モード", system: "一般と外観", desktop: "デスクトップとディスプレイ", peripherals: "キーボードとマウス" },
            pane: {
                account: "Edgerd アカウント", general: "一般", storage: "ストレージ", spotlight: "Spotlight", search: "ネットワーク",
                controlcenter: "コントロールセンター", wallpaper: "壁紙", appearance: "外観", display: "ディスプレイ",
                dock: "デスクトップとDock", siri: "Siri", notifications: "通知", sound: "サウンド", focus: "集中モード",
                screenTime: "スクリーンタイム", "lock-screen": "ロック画面", password: "パスワード",
                privacy: "プライバシーとセキュリティ", users: "ユーザーとグループ", icloud: "iCloud",
                keyboard: "キーボード", mouse: "マウス", plugins: "App", debug: "開発者", defaultApps: "デフォルトアプリ",
                whatsNew: "新機能",
            },
        },
    },
    cat: {
        ss: {
            group: { account: "Edgerd 账户喵", connectivity: "网络同连接喵", alerts: "通知同专注喵", system: "通用同外观喵", desktop: "桌面同显示器喵", peripherals: "键盘同鼠标喵" },
            pane: {
                account: "Edgerd 账户喵", general: "通用喵", storage: "存东西的地方喵", spotlight: "聚焦喵", search: "网络喵",
                controlcenter: "控制中心喵", wallpaper: "墙纸喵", appearance: "外观喵", display: "显示器喵",
                dock: "桌面与程序坞喵", siri: "Siri 喵", notifications: "通知喵", sound: "声音喵", focus: "专注模式喵",
                screenTime: "屏幕使用时间喵", "lock-screen": "锁定屏幕喵", password: "密码喵",
                privacy: "隐私与安全性喵", users: "用户与群组喵", icloud: "iCloud 喵",
                keyboard: "键盘喵", mouse: "鼠标喵", plugins: "App 喵", debug: "开发者喵", defaultApps: "开东西的应用喵",
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
 */
const PANE_GROUPS = [
    { id: "account", label: "Edgerd 账户", i18nKey: "ss.group.account" },
    { id: "connectivity", label: "网络与连接", i18nKey: "ss.group.connectivity" },
    { id: "alerts", label: "通知与专注", i18nKey: "ss.group.alerts" },
    { id: "system", label: "通用与外观", i18nKey: "ss.group.system" },
    { id: "desktop", label: "桌面与显示器", i18nKey: "ss.group.desktop" },
    { id: "peripherals", label: "键盘与鼠标", i18nKey: "ss.group.peripherals" },
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
        id: "focus", group: "alerts", module: "focus", implemented: true, order: 3,
        icon: glyph("moon.fill"), label: "专注模式", i18nKey: "ss.pane.focus",
        keywords: ["专注", "免打扰", "勿扰", "静音时段"],
    },
    {
        id: "screenTime", group: "alerts", module: "screen-time", implemented: false,
        icon: glyph("hourglass"), label: "屏幕使用时间", i18nKey: "ss.pane.screenTime",
        reason: "统计需要跨会话的窗口前台时长归集与报表，当前只有窗口事件没有时长账本；接口保留待接。",
        keywords: ["屏幕时间", "使用统计"],
    },
    {
        id: "general", group: "system", module: "general", implemented: true, order: 4,
        icon: glyph("gear"), label: "通用", i18nKey: "ss.pane.general",
        keywords: ["语言", "时间", "日期", "通用", "启动", "备份", "恢复"],
    },
    {
        id: "whats-new", group: "system", module: "whats-new", implemented: false,
        reason: "新功能说明已并入「通用」面板底部，不再单独占一栏。",
        icon: ICON_WHATS_NEW, label: "新功能", i18nKey: "ss.pane.whatsNew",
        keywords: ["新功能", "更新", "日志", "版本", "changelog"],
    },
    {
        id: "storage", group: "system", module: "storage", implemented: false,
        reason: "存储占用与备份已并入「通用」面板，不再单独占一栏。",
        icon: ICON_STORAGE, label: "存储", i18nKey: "ss.pane.storage",
        keywords: ["存储", "根目录", "文件夹", "授权", "下载", "文档", "图片", "空间"],
    },
    {
        id: "appearance", group: "system", module: "appearance", implemented: true, order: 5,
        icon: glyph("moonphase.last.quarter.inverse"), label: "外观", i18nKey: "ss.pane.appearance",
        keywords: ["浅色", "深色", "自动", "强调色", "高亮", "滚动条", "透明度", "动画"],
    },
    {
        id: "controlcenter", group: "system", module: "controlcenter", implemented: true, order: 6,
        icon: glyph("switch.2"), label: "控制中心", i18nKey: "ss.pane.controlcenter",
        keywords: ["控制中心", "菜单", "图标", "开关", "wi-fi", "蓝牙"],
    },
    {
        id: "siri", group: "system", module: "siri", implemented: true, order: 7,
        icon: ICON_SIRI, label: "Siri", i18nKey: "ss.pane.siri",
        keywords: ["siri", "光球", "语音"],
    },
    {
        // 苹果把「Siri」与「Spotlight」合成一项「Siri 与聚焦」；本机是两个独立面板，按苹果顺序相邻摆。
        id: "spotlight", group: "system", module: "spotlight", implemented: true, order: 8,
        icon: glyph("magnifyingglass"), label: "聚焦", i18nKey: "ss.pane.spotlight",
        keywords: ["搜索", "聚焦", "spotlight", "快捷键"],
    },
    {
        id: "privacy", group: "system", module: "privacy", implemented: true, order: 9,
        icon: glyph("hand.raised.fill"), label: "隐私与安全性", i18nKey: "ss.pane.privacy",
        keywords: ["隐私", "权限", "麦克风", "相机", "定位", "通知授权", "清除数据"],
    },
    {
        id: "dock", group: "desktop", module: "dock", implemented: true, order: 10,
        icon: glyph("menubar.dock.rectangle"), label: "桌面与程序坞", i18nKey: "ss.pane.dock",
        keywords: ["程序坞", "dock", "放大", "位置", "废纸篓", "右键菜单", "指示灯"],
    },
    {
        // 苹果没有独立条目：默认浏览器就放在「桌面与程序坞」里，文件关联走访达。
        // 本机把它做成独立面板，因此紧跟「桌面与程序坞」，不另起一簇。
        id: "default-apps", group: "desktop", module: "default-apps", implemented: true, order: 11,
        icon: glyph("document.blue"), label: "默认应用", i18nKey: "ss.pane.defaultApps",
        keywords: ["默认应用", "打开方式", "文件类型", "扩展名", "协议", "http", "关联"],
    },
    {
        id: "display", group: "desktop", module: "display", implemented: true, order: 12,
        icon: glyph("sun.max.fill"), label: "显示器", i18nKey: "ss.pane.display",
        keywords: ["亮度", "护眼", "夜间", "对比度", "显示器"],
    },
    {
        id: "wallpaper", group: "desktop", module: "wallpaper", implemented: true, order: 13,
        icon: glyph("photo.circle"), label: "墙纸", i18nKey: "ss.pane.wallpaper",
        keywords: ["壁纸", "墙纸", "背景", "bing", "上传"],
    },
    {
        // 苹果的「锁屏」与「触控 ID 与密码」在「电池」之后、同一簇；本机把两者合成一个面板。
        id: "lock-screen", group: "desktop", module: "lock-screen", implemented: true, order: 14,
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
        id: "keyboard", group: "peripherals", module: "keyboard", implemented: true, order: 15,
        icon: glyph("keyboard.fill"), label: "键盘", i18nKey: "ss.pane.keyboard",
        keywords: ["键盘", "快捷键", "按键", "修饰键"],
    },
    {
        id: "mouse", group: "peripherals", module: "mouse", implemented: true, order: 16,
        icon: glyph("magicmouse.fill"), label: "鼠标", i18nKey: "ss.pane.mouse",
        keywords: ["鼠标", "光标", "阴影", "大小"],
    },
    {
        // 苹果没有对应项：第三方应用的设置入口。苹果没有可插入的系统位置，
        // 因此作为附录挂在最末一簇的尾部，紧跟「鼠标」之后，不另立「高级」分组。
        id: "plugins", group: "peripherals", module: "plugins", implemented: true, order: 17,
        icon: ICON_PLUGINS, label: "App", i18nKey: "ss.pane.plugins",
        keywords: ["App", "apps", "应用", "扩展", "插件", "第三方设置", "应用设置"],
    },
    {
        // 同上：苹果没有开发者面板，排在整条侧栏最后。
        id: "debug", group: "peripherals", module: "debug", implemented: true, order: 18,
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
 * 按分组顺序输出侧栏结构，空分组自动省略。
 * @returns {Array<{group:object, panes:Array<object>}>} 分组数组
 */
function sidebarGroups() {
    return PANE_GROUPS
        .map((group) => ({ group, panes: implementedPanes(group.id) }))
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

export { PANES, PANE_GROUPS, implementedPanes, sidebarGroups, findPane, matchPanes };

// 注册表一求值就把词条交给 i18n：外壳渲染侧栏早于任何面板加载，
// 晚一步注册就会有一帧「界面是英文、侧栏是中文」。
// registerMessages 缺位时（老内核）不报错，界面退回条目里的中文 label。
if (typeof i18n.registerMessagesAll === "function") i18n.registerMessagesAll(LABELS);
