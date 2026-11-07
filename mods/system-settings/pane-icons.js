/**
 * pane-icons.js — 侧栏面板图标（彩色圆角方块 + 白色字形）
 *
 * 26 枚独立 SVG 放在 ./icons/<paneId>.svg，几何统一：24 网格、22×22 方块、rx 5、
 * 字形光学框 13、纯白 #fff（仅 Siri 用渐变）。图标刻意不复用 assets/images 的单色字形 ——
 * 那些是给工具栏/菜单「压黑反白」用的线稿，铺进彩色方块会失去辨识度。
 *
 * style.css 的 .ss-item__icon 对彩色图标是禁忌：它统一 `brightness(0)` 压黑、
 * 选中态/深色主题再 `invert(1)` 整体反白，彩色方块会被抹成黑块/白块。
 * 本模块因此只对带 data-tile 的图标注入豁免样式（#ss-pane-icon-tile），
 * 不改共享样式表 —— 插件目录里 style.css 只有一份，别的会话也在改它。
 */

import { el } from "./ui.js";

/** 注入样式块的 id：重复调用只注入一次，插件重开窗口也不会叠第二份。 */
const STYLE_ID = "ss-pane-icon-tile";

/** 图标目录：相对本模块解析，插件目录整体搬动时不失效。 */
const ICON_DIR = new URL("./icons/", import.meta.url);

/**
 * 拥有独立方块图标的面板 id。
 * registry 里未实现的 5 项（account / search / screenTime / users / icloud）也登记，
 * 将来把 implemented 改 true 时不会出现「有色条目、无图标」的半截状态。
 */
const PANE_ICON_IDS = new Set([
    "account", "general", "whats-new", "storage", "spotlight", "default-apps",
    "search", "controlcenter", "wallpaper", "appearance", "display", "dock",
    "siri", "notifications", "sound", "focus", "screenTime", "lock-screen",
    "password", "privacy", "users", "icloud", "keyboard", "mouse", "plugins", "debug",
]);

/**
 * 面板 id → 方块图标 URL。
 * @param {string} id registry 面板 id（如 "lock-screen"）
 * @returns {string|null} SVG 绝对地址；没有专属图标时返回 null，调用方回退 entry.icon
 */
export function paneIconSrc(id) {
    const key = String(id || "");
    return PANE_ICON_IDS.has(key) ? new URL(`${key}.svg`, ICON_DIR).href : null;
}

/**
 * 注入彩色图标豁免样式。四条选择器覆盖「普通 / 选中 / 深色 / 深色选中」，
 * 值一律 !important：style.css 的深色规则特异度带 html 元素，靠加一段选择器压不稳，
 * 而这里只需要压过 filter / opacity 两个视觉属性，不接管尺寸。
 * @returns {void}
 */
export function ensurePaneIconStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = el("style", { id: STYLE_ID, text: `
.settings .ss-item__icon[data-tile],
.settings .ss-item--on .ss-item__icon[data-tile],
html[data-theme="dark"] .settings .ss-item__icon[data-tile],
html[data-theme="dark"] .settings .ss-item--on .ss-item__icon[data-tile] {
    -webkit-filter: none !important;
    filter: none !important;
    opacity: 1 !important;
}` });
    document.head.appendChild(style);
}

ensurePaneIconStyle();
