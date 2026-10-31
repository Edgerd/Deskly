/**
 * panes/controlcenter.js — 「系统设置 › 控制中心」面板
 *
 * 面板不硬编码字段清单：`settings.list({prefix:"controlcenter."})` 返回什么就渲染什么，
 * controlcenter.js 以后加开关、改标签都不用回来改这里。定义本身来自
 * CONTROL_CENTER_FIELDS（由 settings-definitions.js 落成 switch / slider 控件）。
 *
 * 生效链路是真实的：写入经设置中枢广播 `settings-changed`，controlcenter.js 监听后
 * 把值并回它的内存镜像并重绘面板，所以这里的每次拨动都会立刻反映到控制中心。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { toggle as toggleControlCenter } from "../../../src/javascripts/controlcenter.js";
import {
    t, el, note, group, autoRow, actionRow, statusRow, usePaneStyle, track,
} from "../ui.js";

export const paneId = "controlcenter";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            controlcenter: {
                switches: "开关",
                sliders: "滑块",
                others: "其它",
                menubar: "在菜单栏显示控制中心图标",
                menubarGroup: "菜单栏状态项",
                liveGroup: "实时状态",
                live: "当前状态",
                open: "打开控制中心",
                openBtn: "打开",
                empty: "控制中心目前没有可用的设置项。",
                unavailableTitle: "不可用",
                unavailableNote: "以下项目由系统控制，浏览器扩展无法切换：",
                unavailableValue: "不可用",
                onState: "开",
                offState: "关",
            },
        },
    },
    "en": {
        ss: {
            controlcenter: {
                switches: "Switches",
                sliders: "Sliders",
                others: "Other",
                menubar: "Show Control Center in the menu bar",
                menubarGroup: "Menu bar status items",
                liveGroup: "Live state",
                live: "Current state",
                open: "Open Control Center",
                openBtn: "Open",
                empty: "No Control Center settings are available yet.",
                unavailableTitle: "Unavailable",
                unavailableNote: "These are controlled by the system and cannot be switched from a browser extension:",
                unavailableValue: "Unavailable",
                onState: "on",
                offState: "off",
            },
        },
    },
    "ja-JP": {
        ss: {
            controlcenter: {
                switches: "スイッチ",
                sliders: "スライダー",
                others: "その他",
                menubar: "メニューバーにコントロールセンターを表示",
                menubarGroup: "メニューバーのステータス項目",
                liveGroup: "ライブ状態",
                live: "現在の値",
                open: "コントロールセンターを開く",
                openBtn: "開く",
                empty: "表示できる設定項目がありません。",
                unavailableTitle: "利用できません",
                unavailableNote: "以下はシステムが制御するため、ブラウザ拡張からは切り替えられません：",
                unavailableValue: "利用不可",
                onState: "入",
                offState: "切",
            },
        },
    },
    cat: {
        ss: {
            controlcenter: {
                switches: "开关喵",
                sliders: "滑块喵",
                others: "别的喵",
                menubar: "在菜单栏露出控制中心的图标喵",
                menubarGroup: "菜单栏的小状态喵",
                liveGroup: "现在是什么样喵",
                live: "当前数值喵",
                open: "打开控制中心看看喵",
                openBtn: "打开喵",
                empty: "现在控制中心还没有能给主人摆出来的开关喵。",
                unavailableTitle: "用不了喵",
                unavailableNote: "下面这些归系统管，浏览器管不着喵：",
                unavailableValue: "用不了喵",
                onState: "开着喵",
                offState: "关啦喵",
            },
        },
    },
};

/** 可能承担「菜单栏图标」语义的键名（controlcenter.js 何时补哪个都不必回来改面板）。 */
const MENUBAR_KEY_CANDIDATES = ["controlcenter.menubarIcon", "controlcenter.showInMenuBar", "controlcenter.menuBarIcon"];

/** menubar.show* 的标签走全局语言包（定义里的 label 是模块求值期的中文兜底）。 */
const MENUBAR_LABEL_KEYS = {
    "menubar.showBattery": ["menubar.showBattery", "电池"],
    "menubar.showVolume": ["menubar.showVolume", "音量"],
    "menubar.showBluetooth": ["menubar.showBluetooth", "蓝牙"],
};

const CSS = `
.ss-controlcenter .ss-controlcenter__live { font-variant-numeric: tabular-nums; opacity: .8; }
`;

/**
 * 构建控制中心面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const allDefs = settings.list({ prefix: "controlcenter." }).filter((def) => def && !def.hidden);
    // 菜单栏状态项（menubar.show*）由 menubar-status.js 自持定义、归到本面板：
    // 它们不是 controlcenter.* 键，单独取出来在「菜单栏状态项」分组里渲染。
    const menubarDefs = settings.list({ pane: paneId })
        .filter((def) => def && !def.hidden && !String(def.key).startsWith("controlcenter."));
    // 浏览器无法控制的字段（Wi-Fi 开关、蓝牙、隔空投送、飞行模式、屏幕镜像）不再渲染成开关：
    // 它们只会翻转一个没人消费的布尔，属于「看起来能用其实不能用」（F-20）。
    const defs = allDefs.filter((def) => !def.unavailable);
    const unavailableDefs = allDefs.filter((def) => def.unavailable);
    const switches = [];
    const sliders = [];
    const others = [];
    defs.forEach((def) => {
        const row = autoRow(def);
        if (!row) return;
        if (def.control === "slider") sliders.push(row);
        else if (def.control === "switch") switches.push(row);
        else others.push(row);
    });

    const liveRow = statusRow({
        label: t("ss.controlcenter.live", "当前状态"),
        value: "—",
    });
    liveRow.classList.add("ss-controlcenter__live");
    const paintLive = () => liveRow.setValue(summarize(defs));
    paintLive();
    track(settings.subscribe((detail) => {
        if (detail && detail.key && detail.key.startsWith("controlcenter.")) paintLive();
    }));

    const menubarRow = buildMenubarRow();

    const sections = [];
    if (switches.length) sections.push(group(switches, { title: t("ss.controlcenter.switches", "开关") }));
    if (sliders.length) sections.push(group(sliders, { title: t("ss.controlcenter.sliders", "滑块") }));
    if (others.length) sections.push(group(others, { title: t("ss.controlcenter.others", "其它") }));
    if (menubarRow) sections.push(group([menubarRow]));
    if (menubarDefs.length) {
        const rowsForMenubar = menubarDefs.map((def) => {
            const pair = MENUBAR_LABEL_KEYS[def.key];
            return autoRow(pair ? { ...def, label: t(pair[0], pair[1]) } : def);
        });
        sections.push(group(
            rowsForMenubar.filter(Boolean),
            { title: t("ss.controlcenter.menubarGroup", "菜单栏状态项") },
        ));
    }

    sections.push(group([
        liveRow,
        actionRow({
            label: t("ss.controlcenter.open", "打开控制中心"),
            buttonText: t("ss.controlcenter.openBtn", "打开"),
            onAction: () => { if (typeof toggleControlCenter === "function") toggleControlCenter(); },
        }),
    ], { title: t("ss.controlcenter.liveGroup", "实时状态") }));

    if (unavailableDefs.length) {
        sections.push(group([
            note("ss.controlcenter.unavailableNote", "以下项目由系统控制，浏览器扩展无法切换："),
            ...unavailableDefs.map((def) => statusRow({ label: def.label, value: t("ss.controlcenter.unavailableValue", "不可用") })),
        ], { title: t("ss.controlcenter.unavailableTitle", "不可用") }));
    }

    if (!allDefs.length) sections.push(note("ss.controlcenter.empty", "控制中心目前没有可用的设置项。"));

    return el("div", { class: "ss-pane ss-controlcenter" }, ...sections);
}

/**
 * 菜单栏图标开关：只在定义真的存在时才生成行，不存在时返回 null 不占位。
 * @returns {HTMLElement|null} 行元素
 */
function buildMenubarRow() {
    const key = MENUBAR_KEY_CANDIDATES.find((candidate) => settings.has(candidate));
    if (!key) return null;
    return autoRow(settings.info(key), { label: t("ss.controlcenter.menubar", "在菜单栏显示控制中心图标") });
}

/**
 * 把当前控制中心各字段压成一行可读摘要（布尔显示开关态，数字显示百分比或原值）。
 * @param {Array<object>} defs 设置定义副本列表
 * @returns {string} 摘要文本
 */
function summarize(defs) {
    const parts = defs.map((def) => {
        const value = settings.get(def.key);
        const name = String(def.key).replace(/^controlcenter\./, "");
        if (typeof value === "boolean") return `${name} ${value ? t("ss.controlcenter.onState", "开") : t("ss.controlcenter.offState", "关")}`;
        if (typeof value === "number") return `${name} ${value <= 1 ? `${Math.round(value * 100)}%` : value}`;
        return `${name} ${value}`;
    });
    return parts.join(" · ") || "—";
}

/** 面板没有自持有的全局资源；控件订阅统一由 ui.js 的 disposeAll() 释放。 */
export function destroy() { }
