/**
 * panes/accessibility.js — 「辅助功能」面板
 *
 * 视觉组把系统里已有的真实辅助选项收拢到一起：界面缩放（accessibility.zoom，
 * settings-definitions 就地写 <html> 的 style.zoom）、增强对比度（抬高共享文字
 * 令牌 + 窗口描边，规则在 main.css）、减少动态效果（复用外观面板同一键
 * appearance.reduceMotion，两处改的是同一份数据）、指针大小与晃动放大
 * （鼠标面板的既有 cursor.* / mouse.* 键）。
 * 听觉、肢体活动能力、切换控制、字幕在浏览器里没有可落地的能力边界内的实现，
 * 按附录 B 的口径如实标注「当前无可用功能」，不放假控件。
 */

import {
    el, t, note, group, controlSwitch, controlSlider,
} from "../ui.js";

export const paneId = "accessibility";

/** 面板语言包。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { accessibility: "辅助功能" },
            accessibility: {
                vision: "视觉", zoom: "缩放", contrast: "增强对比度",
                reduceMotion: "减少动态效果", pointerSize: "指针大小",
                shakeTitle: "晃动指针以查找", shakeScale: "放大倍数", shakeDistance: "触发距离",
                keyboard: "键盘",
                shortcutHints: "显示快捷键提示",
                keyboardNote: "可用快捷键在「键盘」面板与使用手册中查看。",
                zoomHint: "调整整个界面的显示比例。",
            },
        },
    },
    "en": {
        ss: {
            pane: { accessibility: "Accessibility" },
            accessibility: {
                vision: "Vision", zoom: "Zoom", contrast: "Increase contrast",
                reduceMotion: "Reduce motion", pointerSize: "Pointer size",
                shakeTitle: "Shake to locate pointer", shakeScale: "Magnification", shakeDistance: "Trigger distance",
                keyboard: "Keyboard",
                shortcutHints: "Show shortcut hints",
                keyboardNote: "Available shortcuts are listed in the Keyboard pane and the manual.",
                zoomHint: "Adjust the display scale of the whole interface.",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { accessibility: "アクセシビリティ" },
            accessibility: {
                vision: "視覚", zoom: "ズーム", contrast: "コントラストを上げる",
                reduceMotion: "視覚効果を減らす", pointerSize: "ポインタのサイズ",
                shakeTitle: "振ってポインタを探す", shakeScale: "拡大倍率", shakeDistance: "反応距離",
                keyboard: "キーボード",
                shortcutHints: "ショートカットのヒントを表示",
                keyboardNote: "使えるショートカットは「キーボード」パネルと使用手帳で確認できます。",
                zoomHint: "インターフェイス全体の表示倍率を調整します。",
            },
        },
    },
    "cat": {
        ss: {
            pane: { accessibility: "辅助功能喵" },
            accessibility: {
                vision: "看东西喵", zoom: "缩放喵", contrast: "加深颜色喵",
                reduceMotion: "少动来动去喵", pointerSize: "指针大小喵",
                shakeTitle: "晃一晃找指针喵", shakeScale: "放大倍数喵", shakeDistance: "触发距离喵",
                keyboard: "键盘喵",
                shortcutHints: "显示快捷键提示喵",
                keyboardNote: "能用的快捷键去「键盘喵」和使用手册里找喵。",
                zoomHint: "调整整个界面的显示比例喵。",
            },
        },
    },
};

/**
 * 构建「辅助功能」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    const root = el("div", { class: "ss-pane ss-pane-accessibility", dataset: { pane: paneId } });

    root.append(
        group([
            controlSlider("accessibility.zoom", {
                label: t("ss.accessibility.zoom", "缩放"),
                hint: t("ss.accessibility.zoomHint", "调整整个界面的显示比例。"),
            }),
            controlSwitch("accessibility.contrast", {
                label: t("ss.accessibility.contrast", "增强对比度"),
            }),
            controlSwitch("appearance.reduceMotion", {
                label: t("ss.accessibility.reduceMotion", "减少动态效果"),
            }),
            controlSlider("cursor.size", {
                label: t("ss.accessibility.pointerSize", "指针大小"),
            }),
            controlSwitch("mouse.shakeToFind", {
                label: t("ss.accessibility.shakeTitle", "晃动指针以查找"),
            }),
            controlSlider("mouse.shakeScale", {
                label: t("ss.accessibility.shakeScale", "放大倍数"),
            }),
            controlSlider("mouse.shakeDistance", {
                label: t("ss.accessibility.shakeDistance", "触发距离"),
            }),
        ], { title: t("ss.accessibility.vision", "视觉") }),

        group([
            controlSwitch("keyboard.menuShortcuts", {
                label: t("ss.accessibility.shortcutHints", "显示快捷键提示"),
            }),
            note("ss.accessibility.keyboardNote", "可用快捷键在「键盘」面板与使用手册中查看。"),
        ], { title: t("ss.accessibility.keyboard", "键盘") }),
    );

    return root;
}
