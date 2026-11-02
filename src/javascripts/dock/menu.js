/**
 * dock/menu.js — 程序坞右键菜单的内容定义
 *
 * 只负责「菜单里放什么」；事件绑定、状态读写与动作实现都在 dock.js。
 * 所有菜单最终都交给 ui/contextMenu.js 渲染，由它统一清理首尾 / 连续分隔符。
 */

import { i18n } from "../i18n.js";
import { createContextMenu } from "../ui/contextMenu.js";

const t = (key, fallback) => i18n.t(key, fallback);

/**
 * 「选项」二级菜单：最近使用、程序坞位置、放大、指示灯、自动隐藏与设置入口。
 * @param {object} ctx 菜单上下文（含 state 与 actions）
 * @returns {Array<object>} 菜单项
 */
export function buildOptionsMenuItems(ctx) {
    const { state, actions } = ctx;
    return [
        {
            label: state.showRecentApps
                ? t("dock.hideRecentApps", "隐藏“最近使用的应用程序”")
                : t("dock.showRecentApps", "显示“最近使用的应用程序”"),
            checked: state.showRecentApps,
            action: actions.toggleRecents,
        },
        { type: "separator" },
        { type: "header", label: t("dock.dockPosition", "程序坞位置") },
        {
            label: t("dock.positionBottom", "底部"),
            checked: state.dockPosition === "bottom",
            action: () => actions.setPosition("bottom"),
        },
        {
            label: t("dock.positionLeft", "左侧"),
            checked: state.dockPosition === "left",
            action: () => actions.setPosition("left"),
        },
        {
            label: t("dock.positionRight", "右侧"),
            checked: state.dockPosition === "right",
            action: () => actions.setPosition("right"),
        },
        { type: "separator" },
        {
            label: state.dockZoom
                ? t("dock.disableMagnification", "关闭放大")
                : t("dock.enableMagnification", "开启放大"),
            checked: state.dockZoom,
            action: actions.toggleZoom,
        },
        {
            label: state.showIndicators
                ? t("dock.hideIndicators", "隐藏应用指示灯")
                : t("dock.showIndicators", "显示应用指示灯"),
            checked: state.showIndicators,
            action: actions.toggleIndicators,
        },
        {
            label: state.autoHide
                ? t("dock.disableAutoHide", "关闭自动隐藏")
                : t("dock.enableAutoHide", "自动隐藏程序坞"),
            checked: state.autoHide,
            action: actions.toggleAutoHide,
        },
        { type: "separator" },
        {
            label: t("dock.openSettings", "打开系统设置"),
            action: actions.openSettings,
        },
    ];
}

/** 打开「选项」二级菜单（坐标沿用触发右键菜单的位置）。 */
export function openOptionsMenu(x, y, ctx) {
    createContextMenu(x, y, buildOptionsMenuItems(ctx));
}

/**
 * 应用图标右键菜单。
 * @param {string} app 应用身份名
 * @param {object} ctx 菜单上下文
 * @returns {Array<object>} 菜单项
 */
export function buildAppMenuItems(app, ctx) {
    const { state, actions } = ctx;
    const running = state.running === true;
    const isTrash = app === "废纸篓";
    const isDownloads = app === "下载";
    const items = [];

    items.push(running
        ? { label: t("dock.quit", "退出"), action: actions.quit }
        : { label: t("common.open", "打开"), action: actions.open });

    if (isTrash) {
        items.push({ label: t("dock.emptyTrash", "清倒废纸篓…"), action: actions.emptyTrash });
    }
    if (isDownloads) {
        items.push({ label: t("dock.openInFinder", "在访达中显示"), action: actions.openDownloads });
    }
    if (running && !isTrash) {
        items.push({ label: t("dock.forceQuit", "强制退出"), action: actions.forceQuit });
    }

    if (!state.protected && !isTrash) {
        items.push({ type: "separator" });
        items.push(state.favorite
            ? { label: t("dock.removeFromDock", "从程序坞中移除"), action: actions.remove }
            : { label: t("dock.keepInDock", "在程序坞中保留"), action: actions.keep });
    }

    items.push({ type: "separator" });
    items.push({
        label: t("dock.options", "选项"),
        hasSubmenu: true,
        action: (x, y) => openOptionsMenu(x, y, ctx),
    });
    return items;
}

/**
 * 程序坞空白处 / 分隔线右键菜单。
 * @param {object} ctx 菜单上下文
 * @returns {Array<object>} 菜单项
 */
export function buildDockMenuItems(ctx) {
    const { state, actions } = ctx;
    return [
        { label: t("dock.openSettings", "打开系统设置"), action: actions.openSettings },
        { type: "separator" },
        {
            label: state.autoHide ? t("dock.showDock", "显示程序坞") : t("dock.hideDock", "隐藏程序坞"),
            action: actions.toggleAutoHide,
        },
        {
            label: state.dockZoom
                ? t("dock.disableMagnification", "关闭放大")
                : t("dock.enableMagnification", "开启放大"),
            checked: state.dockZoom,
            action: actions.toggleZoom,
        },
        {
            label: state.showIndicators
                ? t("dock.hideIndicators", "隐藏应用指示灯")
                : t("dock.showIndicators", "显示应用指示灯"),
            checked: state.showIndicators,
            action: actions.toggleIndicators,
        },
        {
            label: state.showRecentApps
                ? t("dock.hideRecentApps", "隐藏“最近使用的应用程序”")
                : t("dock.showRecentApps", "显示“最近使用的应用程序”"),
            checked: state.showRecentApps,
            action: actions.toggleRecents,
        },
        { type: "separator" },
        { type: "header", label: t("dock.dockPosition", "程序坞位置") },
        {
            label: t("dock.positionBottom", "底部"),
            checked: state.dockPosition === "bottom",
            action: () => actions.setPosition("bottom"),
        },
        {
            label: t("dock.positionLeft", "左侧"),
            checked: state.dockPosition === "left",
            action: () => actions.setPosition("left"),
        },
        {
            label: t("dock.positionRight", "右侧"),
            checked: state.dockPosition === "right",
            action: () => actions.setPosition("right"),
        },
        { type: "separator" },
        { label: t("dock.restoreDefaults", "恢复程序坞默认顺序"), action: actions.resetLayout },
    ];
}
