/**
 * trashIcon.js — 废纸篓图标变体的唯一读写入口
 *
 * 职责：定义 8 个逻辑变体（浅色 / 深色 × 常规 / 装满 / 黑白 / 透明）、读取当前选择、
 * 设置选择并广播 `trash-icon-change`（dock.js 据此换 `<img src>`）。
 * 图标资源位于 assets/icons/trash/，文件名即变体值，不做二次映射表。
 *
 * 与设置中枢的分工：`trash.icon` 的校验与落盘由 settings.js 完成，本模块的
 * `setTrashIcon` 是它的 apply —— 仍然自己落盘，是为了让「没注册定义的裸页」
 * 与系统设置插件里既有的直接调用（`setTrashIcon(key)`）都照常工作；两次写入的
 * 值必然相同，所以是幂等的。
 *
 * 界面渲染：`TRASH_KEYS` 给出候选顺序，`getTrashIconFor(key)` 给出纯函数式的路径换算，
 * 设置面板画 8 张缩略图时不必再抄一遍「键 -> 文件名」的规则。
 */

import { assetPath } from "./paths.js";

/**
 * 废纸篓图标变体映射：逻辑键 → 图标文件名（不含扩展名）。
 * 新增变体只改这张表，`TRASH_KEYS` 与路径换算自动跟随。
 * @type {Record<string, string>}
 */
export const TRASH_VARIANTS = {
    light: "trash_light",                       // 普通（浅色）
    dark: "trash_dark",                         // 暗色
    light_full: "trash_light_full",             // 浅色·装满
    dark_full: "trash_dark_full",               // 深色·装满
    light_nocolour: "trash_light_full_nocolour",   // 浅色·黑白
    dark_nocolour: "trash_dark_full_nocolour",     // 深色·黑白
    light_nocolour2: "trash_light_full_nocolour2", // 浅色·透明
    dark_nocolour2: "trash_dark_full_nocolour2"    // 深色·透明
};

/** 本地存储键名（同时是设置项 `trash.icon` 的推导槽名）。 */
const STORAGE_KEY = "trash-icon";

/** 默认变体：存储缺失或值非法时使用。 */
const DEFAULT_KEY = "light";

/**
 * 全部废纸篓变体键（8 个），顺序即 TRASH_VARIANTS 的声明顺序。
 * 设置中枢据此校验 `trash.icon` 的候选值、界面据此排卡片，
 * 新增变体只需改 TRASH_VARIANTS 一处，不在这里再抄一遍。
 * @type {Array<string>}
 */
export const TRASH_KEYS = Object.keys(TRASH_VARIANTS);

/**
 * 安全写入 localStorage：配额超限（站内已知情形：上传的大图 base64 把配额占满）
 * 时记一条 warn 并返回 false，不让异常冒泡回设置面板的点击处理器。
 * 这是几字节的开关值，真写不进时本次会话内照样生效，只是刷新后回退。
 * @param {string} value 待写入的变体键
 * @returns {boolean} 是否写入成功
 */
function saveKey(value) {
    try {
        localStorage.setItem(STORAGE_KEY, value);
        return true;
    } catch (err) {
        if (window.__log) window.__log.warn("kernel/trashIcon", `写入 ${STORAGE_KEY} 失败（配额或权限）：`, err);
        else console.warn(`[trashIcon] 写入 localStorage 失败（${STORAGE_KEY}）：`, err);
        return false;
    }
}

/**
 * 当前选择的废纸篓变体键；存储缺失或值不在变体表内时回退默认。
 * @returns {string} 变体逻辑键
 */
export function getTrashKey() {
    const key = localStorage.getItem(STORAGE_KEY);
    return TRASH_VARIANTS[key] ? key : DEFAULT_KEY;
}

/**
 * 按变体键取图标资源路径（纯函数，不读存储）。
 * 未知键回退默认变体，保证调用方永远拿得到一个真实存在的文件，
 * 设置面板据此渲染 8 张缩略图而不必复制「键 -> 文件名」的规则。
 * @param {string} key 变体逻辑键
 * @returns {string} 站点根相对的图标 URL
 */
export function getTrashIconFor(key) {
    return assetPath(`icons/trash/${TRASH_VARIANTS[key] || TRASH_VARIANTS[DEFAULT_KEY]}.png`);
}

/** 当前选中变体的图标路径。 */
export function getTrashIcon() {
    return getTrashIconFor(getTrashKey());
}

/**
 * 设置废纸篓变体并广播变更。
 * @param {string} key 变体逻辑键
 * @returns {boolean} 校验是否通过（非法键不写入、不广播，返回 false）
 */
export function setTrashIcon(key) {
    if (!TRASH_VARIANTS[key]) return false;
    saveKey(key);
    window.dispatchEvent(new CustomEvent("trash-icon-change", { detail: key }));
    return true;
}
