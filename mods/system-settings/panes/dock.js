/**
 * panes/dock.js — 「桌面与程序坞」面板：程序坞 8 项布局设置、废纸篓图标、原生右键菜单与恢复默认顺序
 *
 * 这 8 项在定义里走 event 通道（只有 event 没有 apply）：设置中枢补发 dock-*-change 事件，
 * dock.js 零改动即可实时生效，本面板只调 settings.set（经 ui.js 的 bind()），不自己拼事件。
 *
 * 废纸篓图标：候选值与生效函数都在内核 trashIcon.js，这里只做「变体键 -> 文件名」，
 * 图片地址一律走 paths.js。
 */

import { assetPath } from "../../../src/javascripts/paths.js";
import { settings } from "../../../src/javascripts/settings.js";
import * as trashIcon from "../../../src/javascripts/trashIcon.js";
import { log } from "../../../src/javascripts/log.js";
import {
    el, t, group, actionRow, bind, row,
    controlSwitch, controlSlider, controlSegmented, usePaneStyle,
} from "../ui.js";

export const paneId = "dock";

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
                trashTone: "外观", toneLight: "浅色", toneDark: "深色",
                trashStyle: "样式", styleAuto: "自动", styleFull: "装满", styleMono: "黑白", styleClear: "透明",
                context: "显示原生右键菜单",
                resetTitle: "程序坞排列", resetButton: "恢复默认顺序", resetBusy: "正在恢复…",
                launchpad: "启动台",
                lpIcon: "图标大小",
                lpFont: "文字大小",
                stage: "台前调度",
                stageRecent: "显示最近使用的应用",
                stageMode: "显示应用程序窗口",
                stageModeAll: "一次全部", stageModeOne: "一次一个",
                stageDesktop: "在桌面上显示项目",
                stageWallpaper: "点按墙纸显示桌面",
                wpAlways: "始终", wpStageOnly: "仅台前调度中",
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
                trashTone: "Appearance", toneLight: "Light", toneDark: "Dark",
                trashStyle: "Style", styleAuto: "Auto", styleFull: "Full", styleMono: "Mono", styleClear: "Clear",
                context: "Show native context menu",
                resetTitle: "Dock arrangement", resetButton: "Restore order", resetBusy: "Restoring…",
                launchpad: "Launchpad",
                lpIcon: "Icon size",
                lpFont: "Label size",
                stage: "Stage Manager",
                stageRecent: "Show recent apps",
                stageMode: "Show windows",
                stageModeAll: "All at once", stageModeOne: "One at a time",
                stageDesktop: "Show items on desktop",
                stageWallpaper: "Click wallpaper to show desktop",
                wpAlways: "Always", wpStageOnly: "Only in Stage Manager",
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
                trashTone: "外観", toneLight: "ライト", toneDark: "ダーク",
                trashStyle: "スタイル", styleAuto: "自動", styleFull: "満杯", styleMono: "白黒", styleClear: "透明",
                context: "ネイティブの右クリックメニューを表示",
                resetTitle: "Dockの並び", resetButton: "並びを戻す", resetBusy: "戻しています…",
                launchpad: "Launchpad",
                lpIcon: "アイコンサイズ",
                lpFont: "文字サイズ",
                stage: "ステージマネージャ",
                stageRecent: "最近使用したAppを表示",
                stageMode: "ウインドウの表示",
                stageModeAll: "すべて一度に", stageModeOne: "一度に一つ",
                stageDesktop: "デスクトップに項目を表示",
                stageWallpaper: "壁紙をクリックしてデスクトップを表示",
                wpAlways: "常に", wpStageOnly: "ステージマネージャ使用時のみ",
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
                trashTone: "外觀喵", toneLight: "淺色", toneDark: "深色",
                trashStyle: "樣式喵", styleAuto: "自動", styleFull: "裝滿", styleMono: "黑白", styleClear: "透明",
                context: "用原生右鍵選單喵",
                resetTitle: "程序塢排列喵", resetButton: "排回原樣喵", resetBusy: "正在整理喵…",
                launchpad: "啟動台喵",
                lpIcon: "圖標多大喵",
                lpFont: "文字多大喵",
                stage: "台前調度喵",
                stageRecent: "最近用過的擱左邊喵",
                stageMode: "窗口怎麼擺喵",
                stageModeAll: "一次全上喵", stageModeOne: "一次一扇喵",
                stageDesktop: "桌面圖標也露臉喵",
                stageWallpaper: "點牆紙見桌面喵",
                wpAlways: "隨時都行喵", wpStageOnly: "只在調度中喵",
            },
        },
    },
};

/** 面板私有样式：废纸篓两维选择器（预览 + 外观/样式两组分段）。
 *  布局约束：两组分段 + 预览在窗口最窄宽度（620px）下也不许溢出 ——
 *  分段本身按内容收口且允许换行，预览图定宽不定死整行。 */
const PANE_CSS = `
.ss-pane-dock .ss-trash {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
}
.ss-pane-dock .ss-trash__preview {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}
.ss-pane-dock .ss-trash__img {
    width: 56px;
    height: 56px;
    object-fit: contain;
    padding: 6px;
    border-radius: 10px;
    background: var(--ss-row-bg);
    box-shadow: inset 0 0 0 1px var(--ss-row-divider);
}
.ss-pane-dock .ss-trash__current {
    font-size: 12.5px;
    color: var(--ss-text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ss-pane-dock .ss-trash__dims {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
}
.ss-pane-dock .ss-trash__dim {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.ss-pane-dock .ss-trash__dimlabel {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--ss-text-secondary);
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
 * 变体键 ↔ 两个决策维度（外观 tone × 样式 style）。
 * 旧界面把 8 个变体平铺成一排卡片，窗口稍窄就溢出；真正的决策只有两个维度，
 * 收敛成两组分段后任何宽度都放得下。`auto` 对应内核的「空/满自动切换」变体
 * （trashIcon.getTrashIconForFullness 只在常规档做自动切换，见 trashIcon.js）。
 */
const TRASH_DIMS = {
    light: { auto: "light", full: "light_full", mono: "light_nocolour", clear: "light_nocolour2" },
    dark: { auto: "dark", full: "dark_full", mono: "dark_nocolour", clear: "dark_nocolour2" },
};

/** 由变体键反解维度；不在表内（未知键）按默认浅色自动处理。 */
function trashDimsOf(key) {
    for (const [tone, styles] of Object.entries(TRASH_DIMS)) {
        for (const [style, variant] of Object.entries(styles)) {
            if (variant === key) return { tone, style };
        }
    }
    return { tone: "light", style: "auto" };
}

/**
 * 一组分段按钮（不绑设置键的纯 UI 件：两个维度合写同一个 trash.icon，
 * 因此不复用 controlSegmented 的一键一值绑定）。
 * @param {Array<{value:string, label:string}>} options 候选
 * @param {(value:string)=>void} onPick 点选回调
 * @returns {{node:HTMLElement, mark:(current:string)=>void}} 部件
 */
function dimSegmented(options, onPick) {
    const node = el("div", { class: "ss-segmented", attrs: { role: "radiogroup" } });
    const items = options.map((opt) => {
        const btn = el("button", {
            class: "ss-segmented__item",
            attrs: { type: "button", role: "radio", "aria-checked": "false" },
            dataset: { value: opt.value },
            text: opt.label,
        });
        btn.addEventListener("click", () => onPick(opt.value));
        node.appendChild(btn);
        return btn;
    });
    return {
        node,
        mark(current) {
            items.forEach((btn) => {
                const on = btn.dataset.value === current;
                btn.classList.toggle("ss-segmented__item--on", on);
                btn.setAttribute("aria-checked", on ? "true" : "false");
            });
        },
    };
}

/**
 * 废纸篓两维选择器：预览（当前变体大图 + 名称）+「外观」「样式」两组分段。
 * @returns {HTMLElement} 控件根
 */
function buildTrashPicker() {
    const img = el("img", { class: "ss-trash__img", attrs: { alt: "" } });
    const current = el("span", { class: "ss-trash__current" });

    /** 把维度合成变体键并写入设置中枢（apply 指向 trashIcon.setTrashIcon）。 */
    const apply = (tone, style) => {
        const key = (TRASH_DIMS[tone] || TRASH_DIMS.light)[style] || TRASH_DIMS.light.auto;
        settings.set("trash.icon", key, { source: "system-settings" });
    };

    const toneSeg = dimSegmented([
        { value: "light", label: t("ss.dock.toneLight", "浅色") },
        { value: "dark", label: t("ss.dock.toneDark", "深色") },
    ], (tone) => apply(tone, trashDimsOf(settings.get("trash.icon")).style));

    const styleSeg = dimSegmented([
        { value: "auto", label: t("ss.dock.styleAuto", "自动") },
        { value: "full", label: t("ss.dock.styleFull", "装满") },
        { value: "mono", label: t("ss.dock.styleMono", "黑白") },
        { value: "clear", label: t("ss.dock.styleClear", "透明") },
    ], (style) => apply(trashDimsOf(settings.get("trash.icon")).tone, style));

    /** 按当前 trash.icon 值刷新预览与两组分段的选中态。 */
    const repaint = () => {
        const key = String(settings.get("trash.icon") || "light");
        const dims = trashDimsOf(key);
        img.src = trashIconSrc(trashIcon, key);
        current.textContent = t(`ss.dock.trashName.${key}`, key); // i18n-dynamic-ok: 键域为 trash.icon 的有限候选值
        toneSeg.mark(dims.tone);
        styleSeg.mark(dims.style);
    };
    bind("trash.icon", repaint);
    repaint();

    return el("div", { class: "ss-trash" },
        el("div", { class: "ss-trash__preview" }, img, current),
        el("div", { class: "ss-trash__dims" },
            el("div", { class: "ss-trash__dim" },
                el("span", { class: "ss-trash__dimlabel", text: t("ss.dock.trashTone", "外观") }), toneSeg.node),
            el("div", { class: "ss-trash__dim" },
                el("span", { class: "ss-trash__dimlabel", text: t("ss.dock.trashStyle", "样式") }), styleSeg.node)));
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
            row({
                label: t("ss.dock.trash", "废纸篓图标"),
                control: buildTrashPicker(),
                stack: true,
            }),
            controlSwitch("general.nativeContextMenu", {
                label: t("ss.dock.context", "显示原生右键菜单"),
            }),
            resetRow,
        ], { title: t("ss.dock.desktop", "桌面") }),

        // FS-07：桌面与台前调度区（键定义在 wm/stage-manager.js，这里只渲染）
        group([
            controlSwitch("controlcenter.stage", {
                label: t("ss.dock.stage", "台前调度"),
            }),
            controlSwitch("desktop.stage.showRecent", {
                label: t("ss.dock.stageRecent", "显示最近使用的应用"),
            }),
            controlSegmented("desktop.stage.windowMode", {
                label: t("ss.dock.stageMode", "显示应用程序窗口"),
                options: [
                    { value: "all", label: t("ss.dock.stageModeAll", "一次全部") },
                    { value: "one", label: t("ss.dock.stageModeOne", "一次一个") },
                ],
            }),
            controlSwitch("desktop.stage.showDesktopItems", {
                label: t("ss.dock.stageDesktop", "在桌面上显示项目"),
            }),
            controlSegmented("desktop.stage.clickWallpaper", {
                label: t("ss.dock.stageWallpaper", "点按墙纸显示桌面"),
                options: [
                    { value: "always", label: t("ss.dock.wpAlways", "始终") },
                    { value: "stageOnly", label: t("ss.dock.wpStageOnly", "仅台前调度中") },
                ],
            }),
        ], { title: t("ss.dock.stage", "台前调度") }),

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
