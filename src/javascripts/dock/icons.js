/**
 * dock/icons.js — 程序坞图标解析、首屏静态映射与跨会话图标提示
 *
 * 目标：Dock 在插件清单就绪之前就能拿到真实图标路径，不再先画通用占位图再换图。
 * 做法分三层：
 * 1. 内置应用的图标路径是构建期就确定的，这里用一张静态表同步给出（与 manifest 同源）；
 * 2. 已安装 ZIP 插件在清单就绪前先用上次成功加载的图标路径（localStorage 提示）；
 * 3. 两者都没有时才返回 GENERIC_APP_ICON，由 dock.js 决定显示加载骨架还是最终兜底。
 *
 * 本模块不碰 DOM，只做路径与缓存；图标元素的创建、加载态与错误降级仍在 dock.js。
 */

import { GENERIC_APP_ICON, assetIcon, modFile } from "../paths.js";
import { getTrashIcon } from "../trashIcon.js";
import {
    getIcon as getPluginIcon,
    getIconForName,
    resolveName,
    isReady,
} from "../plugin-manager.js";

// 应用名 → 插件 id 映射（图标统一走 plugin-manager 的 getIconForName / getIcon）
export const appToPlugin = {
    "访达": "finder",
    "启动台": "launchpad",
    "系统设置": "system-settings",
    "App Store": "app-store",
    "计算器": "calculator",
    "关于本机": "about",
    "照片": "photos",
    "记事本": "notepad",
    "Safari浏览器": "safari",
    "VS Code": "vs_code",
    "Siri": "siri",
};

// macOS 图标文件名映射：中文逻辑名 → assets/icons 下的文件名（PNG）；文件夹类位于 folder/
export const iconMap = {
    "访达": "Finder",
    "启动台": "Launchpad",
    "Safari浏览器": "Safari",
    "系统设置": "Reglages systeme",
    "下载": "folder/Download",
    "App Store": "App Store",
    "邮件": "Mail",
    "通讯录": "Contacts",
    "日历": "Calendrier",
    "提醒事项": "Rappels",
    "记事本": "TextEdit",
    "FaceTime通话": "FaceTime",
    "信息": "Messages",
    "地图": "Plans",
    "查找": "Localiser",
    "Photo Booth": "Photo Booth",
    "照片": "Photos",
    "音乐": "Musique",
    "博客": "Podcasts",
    "视频": "TV",
    "语音备忘录": "Dictaphone",
    "天气": "Meteo",
    "股市": "Bourse",
    "图书": "Livres",
    "时钟": "Horloge",
    "计算器": "Calculatrice",
    "无边记": "Freeform",
    "家庭": "Maison",
    "Siri": "Siri",
    "iPhone镜像": "Recopie de l'iPhone",
    "密码": "Mots de passe",
    "其他": "folder/System"
};

/**
 * 内置应用图标的静态路径表。
 *
 * 为什么必须存在：index.html 解析完成后 dock.js 立刻求值并渲染图标，而插件清单是
 * 异步 fetch 的。此前这段时间里 getIcon() 只能拿到 GENERIC_APP_ICON，用户会看到
 * 一排通用占位图再逐个换回真图标。这张表让首帧直接命中真实 PNG（与各 manifest.icon
 * 完全同路径），清单就绪后 refreshIconsFromRegistry 会比较绝对 URL，相同则不重设。
 *
 * 只登记内置插件；ZIP 插件走 iconHints 缓存，绝不猜测路径（猜错就是一次 404 闪烁）。
 */
export const STATIC_APP_ICONS = Object.freeze({
    "访达": modFile("finder", "Finder.png"),
    "启动台": modFile("launchpad", "Launchpad.png"),
    "Safari浏览器": modFile("safari", "Safari.png"),
    "系统设置": modFile("system-settings", "Reglages systeme.png"),
    "App Store": modFile("app-store", "App Store.png"),
    "计算器": modFile("calculator", "Calculatrice.png"),
    "关于本机": modFile("about", "Informations systeme.png"),
    "照片": modFile("photos", "Photos.png"),
    "记事本": modFile("notepad", "TextEdit.png"),
    "Siri": modFile("siri", "Siri.png"),
    "VS Code": modFile("vs_code", "icon.png"),
    "Mac 使用手册": modFile("manual", "Manual.png"),
    "办公": modFile("office", "Office.png"),
    "文稿": modFile("office", "Pages.png"),
    "表格": modFile("office", "Numbers.png"),
    "演示": modFile("office", "Keynote.png"),
    "下载": assetIcon("folder/Download"),
});

/** ZIP 插件图标提示的存储键：app 名 → 上次成功加载的图标 URL。 */
const ICON_HINTS_KEY = "webstartos_dock_icons";

/** 只接受站内资源路径，避免 localStorage 被写成 javascript:/data: 之类。 */
const SAFE_ICON_URL = /^\.\/(?:mods|assets)\/[^?#\\]*$/;

/** 锚定、禁查询串/片段/反斜杠，并显式拒绝任何 `..` —— `./mods/../../x` 会被浏览器规范化成站外相对路径。 */
function isSafeIconUrl(src) {
    return typeof src === "string" && SAFE_ICON_URL.test(src) && !src.includes("..");
}

let hints = readHints();
let hintsTimer = 0;

/** 解析缓存：清单 / 品牌包 / 语言变化时整体失效，避免每次都遍历注册表。 */
const resolved = new Map();

function readHints() {
    try {
        const raw = JSON.parse(localStorage.getItem(ICON_HINTS_KEY) || "{}");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const out = {};
        Object.keys(raw).forEach((app) => {
            const src = raw[app];
            if (isSafeIconUrl(src)) out[app] = src;
        });
        return out;
    } catch (err) {
        return {};
    }
}

function saveHintsSoon() {
    if (hintsTimer) return;
    hintsTimer = setTimeout(() => {
        hintsTimer = 0;
        try {
            localStorage.setItem(ICON_HINTS_KEY, JSON.stringify(hints));
        } catch (err) {
            if (window.__log) window.__log.warn("kernel/dock", "写入程序坞图标缓存失败（配额或权限）：", err);
        }
    }, 400);
}

/** 静态兜底路径：内置表优先，其次 macOS 资源库，只有真实存在的文件才会被返回。 */
export function staticIconFor(app) {
    if (STATIC_APP_ICONS[app]) return STATIC_APP_ICONS[app];
    return iconMap[app] ? assetIcon(iconMap[app]) : null;
}

function cachedIconFor(app) {
    const src = hints[app];
    return isSafeIconUrl(src) ? src : null;
}

/**
 * 解析应用图标路径（同步，永不抛错）。
 * 顺序：注册表（清单）→ 插件级图标 → 内置静态表 → macOS 资源库 → 上次成功缓存 → 占位图。
 * @param {string} app 应用身份名（img.alt / 窗口 id）
 * @returns {string} 图标 URL
 */
export function getIcon(app) {
    if (app === "废纸篓") return getTrashIcon();
    if (resolved.has(app)) return resolved.get(app);

    let src = null;
    // 先按「应用名」整体解析：多应用插件的子应用名（文稿 / 表格 / 演示）会命中
    // app 级 icon，拿不到再退回插件级映射，避免三颗图标都显示成套件的图。
    src = getIconForName(app);
    if (!src) {
        const pluginId = appToPlugin[app] || resolveName(app)?.id;
        if (pluginId) {
            const fromPlugin = getPluginIcon(pluginId);
            // 清单未就绪时 getPluginIcon 会给 GENERIC，不能把它当成答案缓存下来。
            if (fromPlugin && fromPlugin !== GENERIC_APP_ICON) src = fromPlugin;
        }
    }
    if (!src) src = staticIconFor(app);
    if (!src) src = cachedIconFor(app);
    if (!src) src = GENERIC_APP_ICON;

    resolved.set(app, src);
    return src;
}

/**
 * 当前路径是否只是「清单还没就绪」的临时占位。
 * Dock 据此显示加载骨架而不是通用占位图；清单就绪后同一路径会重新解析。
 * @param {string} app 应用身份名
 * @param {string} [src] 已解析路径
 * @returns {boolean}
 */
export function isIconPending(app, src = getIcon(app)) {
    if (src !== GENERIC_APP_ICON) return false;
    if (app === "废纸篓") return false;
    if (staticIconFor(app) || cachedIconFor(app)) return false;
    return !isReady();
}

/**
 * 记住一个应用成功加载的图标路径，供下次冷启动在清单就绪前直接使用。
 * @param {string} app 应用身份名
 * @param {string} src 图标 URL（相对站点根）
 * @returns {void}
 */
export function rememberIcon(app, src) {
    if (!app || app === "废纸篓" || !isSafeIconUrl(src) || src === GENERIC_APP_ICON) return;
    if (hints[app] === src) return;
    hints[app] = src;
    saveHintsSoon();
}

/** 忘记某个应用的图标提示（加载失败 / 插件已卸载）。 */
export function forgetIcon(app) {
    if (!hints[app]) return;
    delete hints[app];
    saveHintsSoon();
}

/**
 * 剪枝图标提示：只保留当前仍在程序坞上的应用，避免 localStorage 随安装卸载历史膨胀。
 * @param {Iterable<string>} keepApps 仍需保留的应用名
 */
export function pruneIconHints(keepApps) {
    const keep = new Set(keepApps);
    let changed = false;
    Object.keys(hints).forEach((app) => {
        if (keep.has(app)) return;
        delete hints[app];
        changed = true;
    });
    if (changed) saveHintsSoon();
}

/**
 * 注册表 / 品牌包变化后让解析缓存失效。
 * 图标提示仍保留，下一次 getIcon 会优先采用新的清单路径。
 */
export function invalidateIconCache() {
    resolved.clear();
}
