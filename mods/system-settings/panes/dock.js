/**
 * panes/dock.js — 「桌面与程序坞」面板：程序坞 8 项布局设置、废纸篓图标、原生右键菜单与恢复默认顺序
 *
 * 这 8 项在设置定义里走的是 event 通道（定义只有 event 没有 apply）：设置中枢按旧格式
 * 在 window 上补发 dock-size-change 一类事件，dock.js 侧零改动即可实时生效。
 * 因此本面板只需要老实调用 settings.set —— 由 ui.js 的 bind() 完成 —— 不再自己拼事件。
 *
 * 废纸篓图标：候选值与生效函数都在内核（trashIcon.js 的 TRASH_VARIANTS / setTrashIcon），
 * 这里只把「变体键 -> 文件名」这一步做出来（见 trashIconFile 的说明），图片地址一律走 paths.js。
 */

import { assetPath } from "../../../src/javascripts/paths.js";
import { settings } from "../../../src/javascripts/settings.js";
import * as trashIcon from "../../../src/javascripts/trashIcon.js";
import { log } from "../../../src/javascripts/log.js";
import {
    el, t, group, actionRow,
    controlSwitch, controlSlider, controlSegmented, controlCards, usePaneStyle,
} from "../ui.js";

export const paneId = "dock";

/** 面板语言包。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { dock: "桌面与程序坞" },
            dock: {
                dock: "程序坞", desktop: "桌面",
                autohide: "自动显示和隐藏程序坞",
                zoom: "程序坞放大",
                size: "图标大小", amount: "放大倍数", position: "位置",
                left: "左侧", bottom: "底部", right: "右侧",
                minimize: "最小化窗口使用", genie: "神奇效果", scale: "缩放淡出",
                indicators: "显示应用指示灯",
                recent: "显示最近使用的应用",
                trash: "废纸篓图标",
                trashName: {
                    light: "浅色", dark: "深色", light_full: "浅色·装满", dark_full: "深色·装满",
                    light_nocolour: "浅色·黑白", dark_nocolour: "深色·黑白",
                    light_nocolour2: "浅色·透明", dark_nocolour2: "深色·透明",
                },
                context: "显示原生右键菜单",
                resetTitle: "程序坞排列", resetButton: "恢复默认顺序", resetBusy: "正在恢复…",
                launchpad: "启动台",
                lpIcon: "图标大小",
                lpFont: "文字大小",
            },
        },
    },
    en: {
        ss: {
            pane: { dock: "Desktop & Dock" },
            dock: {
                dock: "Dock", desktop: "Desktop",
                autohide: "Automatically hide and show the Dock",
                zoom: "Magnification",
                size: "Icon size", amount: "Magnification level", position: "Position",
                left: "Left", bottom: "Bottom", right: "Right",
                minimize: "Minimize windows using", genie: "Genie Effect", scale: "Scale fade",
                indicators: "Show indicators for open applications",
                recent: "Show recent applications in Dock",
                trash: "Trash icon",
                trashName: {
                    light: "Light", dark: "Dark", light_full: "Light · full", dark_full: "Dark · full",
                    light_nocolour: "Light · mono", dark_nocolour: "Dark · mono",
                    light_nocolour2: "Light · clear", dark_nocolour2: "Dark · clear",
                },
                context: "Show native context menu",
                resetTitle: "Dock arrangement", resetButton: "Restore order", resetBusy: "Restoring…",
                launchpad: "Launchpad",
                lpIcon: "Icon size",
                lpFont: "Label size",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { dock: "デスクトップとDock" },
            dock: {
                dock: "Dock", desktop: "デスクトップ",
                autohide: "Dockを自動的に隠す",
                zoom: "Dockを拡大",
                size: "アイコンサイズ", amount: "拡大率", position: "位置",
                left: "左", bottom: "下", right: "右",
                minimize: "しまうときの効果", genie: "ジニーエフェクト", scale: "スケールフェード",
                indicators: "開いているアプリに表示をつける",
                recent: "最近使用したアプリを表示",
                trash: "ゴミ箱のアイコン",
                trashName: {
                    light: "ライト", dark: "ダーク", light_full: "ライト・満杯", dark_full: "ダーク・満杯",
                    light_nocolour: "ライト・白黒", dark_nocolour: "ダーク・白黒",
                    light_nocolour2: "ライト・透明", dark_nocolour2: "ダーク・透明",
                },
                context: "ネイティブの右クリックメニューを表示",
                resetTitle: "Dockの並び", resetButton: "並びを戻す", resetBusy: "戻しています…",
                launchpad: "Launchpad",
                lpIcon: "アイコンサイズ",
                lpFont: "文字サイズ",
            },
        },
    },
    cat: {
        ss: {
            pane: { dock: "桌面與程序塢喵" },
            dock: {
                dock: "程序塢喵", desktop: "桌面喵",
                autohide: "自動收起來喵",
                zoom: "湊近就變大喵",
                size: "圖標多大喵", amount: "放大幾倍喵", position: "待在哪一邊喵",
                left: "左邊喵", bottom: "底下喵", right: "右邊喵",
                minimize: "縮小用邊種喵", genie: "神奇效果喵", scale: "縮放淡出喵",
                indicators: "開著的應用给個小點點喵",
                recent: "最近用過的也擱在程序塢喵",
                trash: "紙簍的模樣喵",
                trashName: {
                    light: "淺色喵", dark: "深色喵", light_full: "淺色·裝滿喵", dark_full: "深色·裝滿喵",
                    light_nocolour: "淺色·黑白喵", dark_nocolour: "深色·黑白喵",
                    light_nocolour2: "淺色·透明喵", dark_nocolour2: "深色·透明喵",
                },
                context: "用原生右鍵選單喵",
                resetTitle: "程序塢排列喵", resetButton: "排回原樣喵", resetBusy: "正在整理喵…",
                launchpad: "啟動台喵",
                lpIcon: "圖標多大喵",
                lpFont: "文字多大喵",
            },
        },
    },
};

/** 面板私有样式：废纸篓卡片给一层同色底，浅色/深色变体都看得见。 */
const PANE_CSS = `
.ss-pane-dock .ss-cards__img {
    width: 62px;
    height: 62px;
    object-fit: contain;
    padding: 8px;
    background: var(--ss-row-bg);
}
`;

/**
 * 变体键 -> 图标文件名。
 * 内核里这张表在 trashIcon.js 的 TRASH_VARIANTS（未导出）。规则写成两步：
 * 「装满」是文件名里的形态段（_full），黑白 / 透明两种变体沿用的都是有满态的那个文件名。
 * trashIcon.js 哪天导出 getTrashIconFor(key)，本面板就优先用内核那一份（见 trashIconSrc）。
 * @param {string} key 变体键
 * @returns {string} 不含目录与扩展名的文件名
 */
function trashVariantFile(key) {
    const withFull = key.replace(/^(light|dark)_/, "$1_full_").replace(/_full_full/, "_full");
    return /^trash_/.test(withFull) ? withFull : `trash_${withFull}`;
}

/**
 * 取某个废纸篓变体的图片地址（一律经 paths.js 生成）。
 * @param {object} trashModule trashIcon 模块命名空间（可能带 getTrashIconFor）
 * @param {string} key 变体键
 * @returns {string} 资源 URL
 */
function trashIconSrc(trashModule, key) {
    if (trashModule && typeof trashModule.getTrashIconFor === "function") {
        const fromKernel = trashModule.getTrashIconFor(key);
        if (fromKernel) return fromKernel;
    }
    return assetPath(`icons/trash/${trashVariantFile(key)}.png`);
}

/**
 * 构建「桌面与程序坞」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-dock", dataset: { pane: paneId } });

    const positionLabels = {
        left: t("ss.dock.left", "左侧"),
        bottom: t("ss.dock.bottom", "底部"),
        right: t("ss.dock.right", "右侧"),
    };
    const positionDefinition = settings.info("dock.position") || {};
    const positionOptions = (positionDefinition.values || ["left", "bottom", "right"])
        .map((value) => ({ value, label: positionLabels[value] || value }));

    const minimizeLabels = {
        genie: t("ss.dock.genie", "神奇效果"),
        scale: t("ss.dock.scale", "缩放淡出"),
    };
    const minimizeDefinition = settings.info("dock.minimize.effect") || {};
    const minimizeOptions = (minimizeDefinition.values || ["genie", "scale"])
        .map((value) => ({ value, label: minimizeLabels[value] || value }));

    const trashOptions = (trashIcon.TRASH_KEYS || []).map((key) => {
        const nameKey = `ss.dock.trashName.${key}`;
        return {
            value: key,
            label: t(nameKey, key),
            image: trashIconSrc(trashIcon, key),
        };
    });

    const resetRow = actionRow({
        label: t("ss.dock.resetTitle", "程序坞排列"),
        buttonText: t("ss.dock.resetButton", "恢复默认顺序"),
        busyText: t("ss.dock.resetBusy", "正在恢复…"),
        onAction: () => {
            const dockApi = globalThis.__dock;
            if (dockApi && typeof dockApi.resetDockLayout === "function") {
                const order = dockApi.resetDockLayout();
                log.info("plugin/system-settings", `程序坞已恢复默认顺序（${(order || []).length} 项收藏）`);
                return;
            }
            // dock.js 尚未加载或没提供这个接口时的兜底：settings.reset 会按定义里的
            // event 补发 dock-order-change / dock-recents-change，dock.js 上线后仍收得到。
            settings.reset("dock.order", { source: "system-settings" });
            settings.reset("dock.recents", { source: "system-settings" });
            log.warn("plugin/system-settings", "window.__dock.resetDockLayout 不可用，已按设置中枢恢复 dock.order");
        },
    });

    root.append(
        group([
            controlSwitch("dock.autohide", {
                label: t("ss.dock.autohide", "自动显示和隐藏程序坞"),
            }),
            controlSwitch("dock.zoom", {
                label: t("ss.dock.zoom", "程序坞放大"),
            }),
            controlSlider("dock.size", {
                label: t("ss.dock.size", "图标大小"),
                units: "px",
            }),
            controlSegmented("dock.position", {
                label: t("ss.dock.position", "位置"),
                options: positionOptions,
            }),
            controlSegmented("dock.minimize.effect", {
                label: t("ss.dock.minimize", "最小化窗口使用"),
                options: minimizeOptions,
            }),
            controlSlider("dock.zoom.amount", {
                label: t("ss.dock.amount", "放大倍数"),
                units: "倍",
            }),
            controlSwitch("dock.show.indicators", {
                label: t("ss.dock.indicators", "显示应用指示灯"),
            }),
            controlSwitch("dock.show.recent", {
                label: t("ss.dock.recent", "显示最近使用的应用"),
            }),
        ], { title: t("ss.dock.dock", "程序坞") }),

        group([
            controlCards("trash.icon", {
                label: t("ss.dock.trash", "废纸篓图标"),
                options: trashOptions,
            }),
            controlSwitch("general.nativeContextMenu", {
                label: t("ss.dock.context", "显示原生右键菜单"),
            }),
            resetRow,
        ], { title: t("ss.dock.desktop", "桌面") }),

        group([
            // 两项都走 event 通道（启动台是插件，没有常驻 owner）：这里只经 settings.set
            // 落盘并补发 launchpad-*-change，启动台在打开时读存储、已打开时收事件实时改尺寸。
            controlSlider("launchpad.icon.size", {
                label: t("ss.dock.lpIcon", "图标大小"),
                units: "px",
            }),
            controlSlider("launchpad.font.size", {
                label: t("ss.dock.lpFont", "文字大小"),
                units: "px",
            }),
        ], { title: t("ss.dock.launchpad", "启动台") }),
    );

    return root;
}
