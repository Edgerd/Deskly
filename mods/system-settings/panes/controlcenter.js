/**
 * panes/controlcenter.js — 「系统设置 › 控制中心」面板
 *
 * 面板不硬编码字段清单：`settings.list({prefix:"controlcenter."})` 返回什么就渲染什么，
 * 定义来自 CONTROL_CENTER_FIELDS。写入经设置中枢广播 `settings-changed`，controlcenter.js
 * 并回内存镜像重绘面板，每次拨动立刻反映到控制中心。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { toggle as toggleControlCenter } from "../../../src/javascripts/controlcenter.js";
import { resetLayout } from "../../../src/javascripts/menubar-status.js";
import {
    t, el, note, group, autoRow, actionRow, statusRow, usePaneStyle, track, paneLink,
} from "../ui.js";
import { childPanes } from "../registry.js";

export const paneId = "controlcenter";

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
                menubarHint: "在菜单栏横向拖动状态项可调整顺序；按住 Command（Ctrl）把它拖出菜单栏即可移除，移除后点通知可撤销。",
                menubarReset: "恢复默认状态项",
                menubarResetHint: "重新显示全部状态项并复位顺序",
                menubarResetBtn: "恢复默认",
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
                menubarHint: "Drag status items horizontally in the menu bar to reorder. Hold Command (Ctrl) and drag one out of the menu bar to remove it; click the notification to undo.",
                menubarReset: "Restore default status items",
                menubarResetHint: "Show all status items again and reset their order",
                menubarResetBtn: "Restore Defaults",
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
                menubarHint: "メニューバーのステータス項目を左右にドラッグすると並び順を変更できます。Command（Ctrl）を押しながらバーの外へドラッグすると削除でき、通知をクリックすると元に戻せます。",
                menubarReset: "ステータス項目を初期状態に戻す",
                menubarResetHint: "すべてのステータス項目を再表示し、並び順をリセットします",
                menubarResetBtn: "初期設定に戻す",
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
                menubarHint: "在菜单栏左右拖状态项就能换位置喵；按住 Command（Ctrl）把它拖出菜单栏就是移除喵，点通知可以撤销喵。",
                menubarReset: "把状态项恢复成默认喵",
                menubarResetHint: "重新显示全部状态项并把顺序摆回原样喵",
                menubarResetBtn: "恢复默认喵",
            },
        },
    },
};

/** 可能承担「菜单栏图标」语义的键名（controlcenter.js 何时补哪个都不必回来改面板）。 */
const MENUBAR_KEY_CANDIDATES = ["controlcenter.menubarIcon", "controlcenter.showInMenuBar", "controlcenter.menuBarIcon"];

/** menubar.show* 的标签走全局语言包（定义里的 label 是模块求值期的中文兜底）。 */
const MENUBAR_LABEL_KEYS = {
    "menubar.showBattery": ["menubar.showBattery", "电池"],
    "controlcenter.stageInMenuBar": ["menubar.showStage", "台前调度"],
};

const CSS = `
.ss-controlcenter .ss-controlcenter__live { font-variant-numeric: tabular-nums; opacity: .8; }
`;

/**
 * 造一个控制中心系列页面的根节点（共用同一套私有样式作用域）。
 * @param {string} id 当前子页 id
 * @returns {HTMLElement} 根节点
 */
function pageRoot(id) {
    usePaneStyle(paneId, CSS);
    return el("div", { class: "ss-pane ss-controlcenter", dataset: { pane: id } });
}

/**
 * 收集本面板的定义与取行工具。
 * @returns {object} 定义列表与 rowFor 等
 */
function collectDefs() {
    const allDefs = settings.list({ prefix: "controlcenter." }).filter((def) => def && !def.hidden);
    // 菜单栏状态项（menubar.show*）由 menubar-status.js 自持定义、归到本面板：
    // 它们不是 controlcenter.* 键，单独取出来在「菜单栏状态项」分组里渲染。
    // controlcenter.stageInMenuBar（FS-07）虽是 controlcenter.* 键，但语义是
    // 「台前调度状态项是否常驻菜单栏」，归入同一分组。
    const menubarDefs = settings.list({ pane: paneId })
        .filter((def) => def && !def.hidden
            && (!String(def.key).startsWith("controlcenter.") || def.key === "controlcenter.stageInMenuBar"));
    // 浏览器无法控制的字段（Wi-Fi 开关、蓝牙、隔空投送、飞行模式、屏幕镜像）不再渲染成开关：
    // 它们只会翻转一个没人消费的布尔，属于「看起来能用其实不能用」（F-20）。
    const defs = allDefs.filter((def) => !def.unavailable);
    const unavailableDefs = allDefs.filter((def) => def.unavailable);
    const defByKey = new Map(defs.map((def) => [def.key, def]));
    const menubarByKey = new Map(menubarDefs.map((def) => [def.key, def]));

    /** 按指定键取行；定义不存在时返回 null，不占位。 */
    const rowFor = (key, labelOverride) => {
        const def = defByKey.get(key);
        if (!def) return null;
        return autoRow(labelOverride ? { ...def, label: labelOverride } : def);
    };

    /** 菜单栏状态项按固定顺序取行，标签优先走全局语言包。 */
    const menubarRowFor = (key) => {
        const def = menubarByKey.get(key);
        if (!def) return null;
        const pair = MENUBAR_LABEL_KEYS[key];
        return autoRow(pair ? { ...def, label: t(pair[0], pair[1]) } : def);
    };

    return { allDefs, defs, unavailableDefs, rowFor, menubarRowFor };
}

/**
 * 「控制中心」子页：菜单栏图标 + 台前调度等开关。
 * @returns {HTMLElement} 面板根元素
 */
export function buildSwitches() {
    const root = pageRoot("controlcenter-switches");
    const { rowFor } = collectDefs();
    const controlRows = [buildMenubarRow(), rowFor("controlcenter.stage")].filter(Boolean);
    if (controlRows.length) root.append(group(controlRows, { title: t("ss.controlcenter.switches", "控制中心") }));
    else root.append(note("ss.controlcenter.empty", "控制中心目前没有可用的设置项。"));
    return root;
}

/**
 * 「菜单栏状态项」子页：逐项开关、拖动说明与复位。
 * @returns {HTMLElement} 面板根元素
 */
export function buildMenubar() {
    const root = pageRoot("controlcenter-menubar");
    const { menubarRowFor } = collectDefs();
    const menubarRows = ["menubar.showBattery", "controlcenter.stageInMenuBar"]
        .map(menubarRowFor).filter(Boolean);
    if (!menubarRows.length) return root;
    // F-02：逐项开关 + 拖拽说明 + 恢复默认。拖动与 Command 拖出只存在于菜单栏本体，
    // 面板里放一行说明与一键复位，行为与说明永远来自同一份实现（menubar-status.js）。
    root.append(group([
        ...menubarRows,
        note("ss.controlcenter.menubarHint", "在菜单栏横向拖动状态项可调整顺序；按住 Command（Ctrl）把它拖出菜单栏即可移除，移除后点通知可撤销。"),
        actionRow({
            label: t("ss.controlcenter.menubarReset", "恢复默认状态项"),
            hint: t("ss.controlcenter.menubarResetHint", "重新显示全部状态项并复位顺序"),
            buttonText: t("ss.controlcenter.menubarResetBtn", "恢复默认"),
            onAction: () => { resetLayout(); },
        }),
    ], { title: t("ss.controlcenter.menubarGroup", "菜单栏状态项") }));
    return root;
}

/**
 * 「实时状态」子页：当前摘要、打开按钮，以及浏览器控制不了的项。
 * @returns {HTMLElement} 面板根元素
 */
export function buildLive() {
    const root = pageRoot("controlcenter-live");
    const { allDefs, defs, unavailableDefs } = collectDefs();

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

    root.append(group([
        liveRow,
        actionRow({
            label: t("ss.controlcenter.open", "打开控制中心"),
            buttonText: t("ss.controlcenter.openBtn", "打开"),
            onAction: () => { if (typeof toggleControlCenter === "function") toggleControlCenter(); },
        }),
    ], { title: t("ss.controlcenter.liveGroup", "实时状态") }));

    if (unavailableDefs.length) {
        const order = ["wifi", "bluetooth", "airdrop", "airplane", "mirroring"];
        const sorted = [...unavailableDefs].sort((a, b) => {
            const ai = order.indexOf(String(a.key).replace(/^controlcenter\./, ""));
            const bi = order.indexOf(String(b.key).replace(/^controlcenter\./, ""));
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        root.append(group([
            note("ss.controlcenter.unavailableNote", "以下项目由系统控制，浏览器扩展无法切换"),
            ...sorted.map((def) => statusRow({ label: def.label, value: t("ss.controlcenter.unavailableValue", "不可用") })),
        ], { title: t("ss.controlcenter.unavailableTitle", "不可用") }));
    }

    if (!allDefs.length) root.append(note("ss.controlcenter.empty", "控制中心目前没有可用的设置项。"));
    return root;
}

/**
 * 构建「控制中心」父页：只摆二级入口。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    const root = pageRoot(paneId);
    const links = childPanes(paneId).map((child) => paneLink({
        label: t(child.i18nKey, child.label),
        icon: child.icon,
        onOpen: () => { if (ctx && typeof ctx.selectPane === "function") ctx.selectPane(child.id); },
    }));
    if (links.length) root.append(group(links));
    return root;
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
