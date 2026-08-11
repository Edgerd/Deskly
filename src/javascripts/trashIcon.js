/**
 * trashIcon.js — 废纸篓图标选择与切换
 *
 * 提供废纸篓图标变体定义、读取当前选择、设置选择并广播变更事件。
 * 图标资源位于 assets/icons/trash/，支持浅色/深色、装满/黑白/透明等变体。
 */

// 废纸篓图标变体映射：逻辑键 → 图标文件名（不含扩展名）
const TRASH_VARIANTS = {
    light: "trash_light",                       // 普通（浅色）
    dark: "trash_dark",                         // 暗色
    light_full: "trash_light_full",             // 浅色·装满
    dark_full: "trash_dark_full",               // 深色·装满
    light_nocolour: "trash_light_full_nocolour",   // 浅色·黑白
    dark_nocolour: "trash_dark_full_nocolour",     // 深色·黑白
    light_nocolour2: "trash_light_full_nocolour2", // 浅色·透明
    dark_nocolour2: "trash_dark_full_nocolour2"    // 深色·透明
};

// 本地存储键名
const STORAGE_KEY = "trash-icon";

// 默认变体
const DEFAULT_KEY = "light";

/**
 * 获取当前选择的废纸篓变体键
 * @returns {string} 变体逻辑键
 */
export function getTrashKey() {
    const key = localStorage.getItem(STORAGE_KEY);
    return TRASH_VARIANTS[key] ? key : DEFAULT_KEY;
}

export function getTrashIcon() {
    return `./assets/icons/trash/${TRASH_VARIANTS[getTrashKey()]}.png`;
}

export function setTrashIcon(key) {
    if (!TRASH_VARIANTS[key]) return;
    localStorage.setItem(STORAGE_KEY, key);
    window.dispatchEvent(new CustomEvent("trash-icon-change", { detail: key }));
}