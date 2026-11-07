/**
 * contextMenuSettings.js — 浏览器原生右键菜单禁用开关
 *
 * 默认禁用浏览器原生右键菜单，改用自定义菜单；可在「系统设置」中开启。
 * 存储槽 `native-context-menu`（"on" 表示启用原生菜单），既是本模块的读处，
 * 也是设置项 `general.nativeContextMenu` 的显式槽名（见 settings-definitions.js）。
 * 与 cursor.js / appearance.js 同理：`setNativeContextMenuEnabled` 是中枢的 apply，
 * 中枢已经落过一次同样的值，这里再写一次是为了让没走中枢的老调用方
 * （系统设置插件里的直接调用）也照常持久化，两次写入同值、幂等。
 */

const KEY = "native-context-menu";

/**
 * 安全写入 localStorage：写失败（配额超限 / 存储被禁用）时记 warn 并返回 false，
 * 避免 QuotaExceededError 冒泡到设置面板的点击处理器。
 * 日志优先写运行记录（可按 kernel/contextMenuSettings 检索），log.js 尚未加载时退回
 * console —— 站内 console.* 已被 log.js 接管，两条路最终都进同一份运行记录。
 * @param {string} key 存储键
 * @param {string} value 存储值
 * @returns {boolean} 是否写入成功
 */
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        if (window.__log) window.__log.warn("kernel/contextMenuSettings", `写入 localStorage 失败（${key}）：`, err);
        else console.warn(`[contextMenuSettings] 写入 localStorage 失败（${key}）：`, err);
        return false;
    }
}

/**
 * 是否启用浏览器原生右键菜单（默认关闭，即默认拦截右键）。
 * @returns {boolean} 是否启用
 */
export function isNativeContextMenuEnabled() {
    // 存储访问本身抛 SecurityError 的环境（禁用 Cookie/存储的嵌入上下文）里按默认关闭处理（BUG-42）
    try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}

/**
 * 设置是否启用浏览器原生右键菜单。
 * @param {boolean} enabled 是否启用
 * @returns {boolean} 是否持久化成功（失败时当前会话内设置仍已生效，刷新后回退）
 */
export function setNativeContextMenuEnabled(enabled) {
    return safeSetItem(KEY, enabled ? "on" : "off");
}

// 全局禁用浏览器原生右键菜单（默认禁用，可在设置中开启）
document.addEventListener("contextmenu", (e) => {
    if (!isNativeContextMenuEnabled()) e.preventDefault();
});