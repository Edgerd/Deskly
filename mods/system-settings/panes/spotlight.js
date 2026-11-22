/**
 * panes/spotlight.js — 「系统设置 › 聚焦」面板
 *
 * 面板只负责把 spotlight.* 六个设置项呈现成可操作控件，真正的搜索行为归 spotlight.js：
 * 写入一律经 ui.js 的 bind() 走设置中枢，因此这里改一项，聚焦下一次打开就是新范围。
 *
 * 历史清理不碰 localStorage（面板层禁止直接读写存储）：优先调用 spotlight.js 导出的
 * clearHistory()，该导出缺失时退化为「把保留开关关掉再打开」，并在状态行里如实写明
 * 历史没被清掉，不假装成功。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { openSpotlight } from "../../../src/javascripts/spotlight.js";
import * as spotlightApi from "../../../src/javascripts/spotlight.js";
import {
    t, el, group, controlSwitch, controlDropdown, controlSlider, actionRow, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "spotlight";

/** 四语言文案（由 app.js 或本面板注册进 i18n；键名与本文件里的 t() 调用一一对应）。 */
export const messages = {
    "zh-CN": {
        ss: {
            "spotlight": {
                scope: "搜索范围",
                apps: "应用程序",
                settingsLabel: "系统设置项",
                files: "本地文件",
                commands: "系统命令",
                manual: "使用手册",
                resultGroup: "结果与历史",
                hotkey: "快捷键",
                hotkeyDoubleCtrlLeft: "双击 Control（左）",
                hotkeyDoubleCtrlRight: "双击 Control（右）",
                hotkeyDoubleAltLeft: "双击 Option（左）",
                hotkeyDoubleAltRight: "双击 Option（右）",
                hotkeyDoubleShiftLeft: "双击 Shift（左）",
                hotkeyDoubleShiftRight: "双击 Shift（右）",
                hotkeyOff: "不设",
                max: "最多显示结果",
                keepHistory: "保留搜索历史",
                unit: "条",
                tryGroup: "立即试一次",
                open: "打开聚焦",
                openBtn: "打开",
                clear: "清除搜索历史",
                clearHint: "清除后无法恢复。",
                clearBtn: "清除",
                clearState: "清除结果",
                clearDone: "已清空历史。",
                clearToggled: "未能清除历史。",
                clearFailed: "清除失败。",
            },
        },
    },
    "en": {
        ss: {
            "spotlight": {
                scope: "Search Scope",
                apps: "Applications",
                settingsLabel: "System Settings",
                files: "Local Files",
                commands: "System Commands",
                manual: "User Guide",
                resultGroup: "Results & History",
                hotkey: "Keyboard Shortcut",
                hotkeyDoubleCtrlLeft: "Double-tap Control (Left)",
                hotkeyDoubleCtrlRight: "Double-tap Control (Right)",
                hotkeyDoubleAltLeft: "Double-tap Option (Left)",
                hotkeyDoubleAltRight: "Double-tap Option (Right)",
                hotkeyDoubleShiftLeft: "Double-tap Shift (Left)",
                hotkeyDoubleShiftRight: "Double-tap Shift (Right)",
                hotkeyOff: "Off",
                max: "Maximum Results",
                keepHistory: "Keep Search History",
                unit: "results",
                tryGroup: "Try It Now",
                open: "Open Spotlight",
                openBtn: "Open",
                clear: "Clear Search History",
                clearHint: "Cannot be undone.",
                clearBtn: "Clear",
                clearState: "Clear Result",
                clearDone: "History cleared.",
                clearToggled: "Could not clear history.",
                clearFailed: "Could not clear.",
            },
        },
    },
    "ja-JP": {
        ss: {
            "spotlight": {
                scope: "検索範囲",
                apps: "アプリケーション",
                settingsLabel: "システム設定",
                files: "ローカルファイル",
                commands: "システムコマンド",
                manual: "ユーザガイド",
                resultGroup: "結果と履歴",
                hotkey: "ショートカットキー",
                hotkeyDoubleCtrlLeft: "Control（左）をダブルタップ",
                hotkeyDoubleCtrlRight: "Control（右）をダブルタップ",
                hotkeyDoubleAltLeft: "Option（左）をダブルタップ",
                hotkeyDoubleAltRight: "Option（右）をダブルタップ",
                hotkeyDoubleShiftLeft: "Shift（左）をダブルタップ",
                hotkeyDoubleShiftRight: "Shift（右）をダブルタップ",
                hotkeyOff: "なし",
                max: "結果の最大表示数",
                keepHistory: "検索履歴を保存",
                unit: "件",
                tryGroup: "今すぐ試す",
                open: "Spotlight を開く",
                openBtn: "開く",
                clear: "検索履歴を消去",
                clearHint: "消去すると元に戻せません。",
                clearBtn: "消去",
                clearState: "消去の結果",
                clearDone: "履歴を消去しました。",
                clearToggled: "履歴を消去できませんでした。",
                clearFailed: "消去に失敗しました。",
            },
        },
    },
    "cat": {
        ss: {
            "spotlight": {
                scope: "要搜哪里喵",
                apps: "应用程序喵",
                settingsLabel: "系统设置项喵",
                files: "本地文件喵",
                commands: "系统命令喵",
                manual: "说明书喵",
                resultGroup: "结果和历史喵",
                hotkey: "召唤按键喵",
                hotkeyDoubleCtrlLeft: "连按两下 Control（左）喵",
                hotkeyDoubleCtrlRight: "连按两下 Control（右）喵",
                hotkeyDoubleAltLeft: "连按两下 Option（左）喵",
                hotkeyDoubleAltRight: "连按两下 Option（右）喵",
                hotkeyDoubleShiftLeft: "连按两下 Shift（左）喵",
                hotkeyDoubleShiftRight: "连按两下 Shift（右）喵",
                hotkeyOff: "不按也行喵",
                max: "最多给主人看几条喵",
                keepHistory: "记住搜过的词喵",
                unit: "条喵",
                tryGroup: "现在就试一下喵",
                open: "立即打开聚焦",
                openBtn: "打开喵",
                clear: "把搜索历史清掉",
                clearHint: "丢咗就翻唔返㗎喵。",
                clearBtn: "清空喵",
                clearState: "清空结果喵",
                clearDone: "历史都倒干净啦喵~",
                clearToggled: "历史清唔甩喵。",
                clearFailed: "清唔甩喵。",
            },
        },
    },
};

/** 候选快捷键：与 spotlight.js 里 spotlight.hotkey 的 values 一致（写别的取值会被中枢按候选值拒绝）。 */
const HOTKEY_FALLBACK = [
    "double-ctrl-left", "double-ctrl-right",
    "double-alt-left", "double-alt-right",
    "double-shift-left", "double-shift-right",
    "off",
];

const CSS = `
.ss-spotlight .ss-spotlight__status { font-variant-numeric: tabular-nums; }
`;

/**
 * 构建聚焦面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const historyState = statusRow({
        label: t("ss.spotlight.clearState", "清除结果"),
        value: "—",
    });
    historyState.classList.add("ss-spotlight__status");

    const hotkeyDef = settings.info("spotlight.hotkey");
    const hotkeyValues = Array.isArray(hotkeyDef?.values) && hotkeyDef.values.length ? hotkeyDef.values : HOTKEY_FALLBACK;
    const hotkeyLabels = Array.isArray(hotkeyDef?.valuesLabel) ? hotkeyDef.valuesLabel : [];
    const hotkeySpec = {
        label: t("ss.spotlight.hotkey", "快捷键"),
        options: hotkeyValues.map((value, index) => ({ value, label: hotkeyLabelFor(value, hotkeyLabels[index]) })),
    };

    /** 定义不存在的来源直接跳过，避免留下一个改了没反应的开关。 */
    const scopeRow = (key, label) => (settings.has(key) ? controlSwitch(key, { label }) : null);

    return el("div", { class: "ss-pane ss-spotlight" },
        group([
            controlDropdown("spotlight.hotkey", hotkeySpec),
            controlSlider("spotlight.maxResults", {
                label: t("ss.spotlight.max", "最多显示结果"),
                min: 5, max: 30, step: 1,
                units: t("ss.spotlight.unit", "条"),
            }),
            controlSwitch("spotlight.keepHistory", { label: t("ss.spotlight.keepHistory", "保留搜索历史") }),
        ], { title: t("ss.spotlight.resultGroup", "结果与历史") }),

        group([
            scopeRow("spotlight.apps", t("ss.spotlight.apps", "应用程序")),
            scopeRow("spotlight.settings", t("ss.spotlight.settingsLabel", "系统设置项")),
            scopeRow("spotlight.files", t("ss.spotlight.files", "本地文件")),
            scopeRow("spotlight.commands", t("ss.spotlight.commands", "系统命令")),
            scopeRow("spotlight.manual", t("ss.spotlight.manual", "使用手册")),
            scopeRow("spotlight.bookmarks", t("ss.spotlight.bookmarks", "浏览器书签")),
            scopeRow("spotlight.datetime", t("ss.spotlight.datetime", "日期换算")),
            scopeRow("spotlight.convert", t("ss.spotlight.convert", "计算与换算")),
            scopeRow("spotlight.websearch", t("ss.spotlight.websearch", "网页搜索回退")),
        ].filter(Boolean), { title: t("ss.spotlight.scope", "搜索范围") }),

        group([
            actionRow({
                label: t("ss.spotlight.open", "打开聚焦"),
                buttonText: t("ss.spotlight.openBtn", "打开"),
                onAction: () => openSpotlight(""),
            }),
            actionRow({
                label: t("ss.spotlight.clear", "清除搜索历史"),
                hint: t("ss.spotlight.clearHint", "清除后无法恢复。"),
                buttonText: t("ss.spotlight.clearBtn", "清除"),
                onAction: async () => { clearHistory(historyState); },
            }),
            historyState,
        ], { title: t("ss.spotlight.tryGroup", "立即试一次") })
    );
}

/**
 * 清除搜索历史：优先调用 spotlight.js 的 clearHistory()，缺失时拨动保留开关兜底。
 * @param {HTMLElement} stateRowWithSetter 带 setValue 的状态行
 * @returns {void}
 */
function clearHistory(stateRowWithSetter) {
    if (typeof spotlightApi.clearHistory === "function") {
        try {
            spotlightApi.clearHistory();
            stateRowWithSetter.setValue(t("ss.spotlight.clearDone", "已清空历史。"));
            return;
        } catch {
            stateRowWithSetter.setValue(t("ss.spotlight.clearFailed", "清除失败。"));
            return;
        }
    }
    settings.set("spotlight.keepHistory", false, { source: "system-settings" });
    settings.set("spotlight.keepHistory", true, { source: "system-settings" });
    stateRowWithSetter.setValue(t("ss.spotlight.clearToggled", "未能清除历史。"));
}

/**
 * 快捷键取值的可读标签：已知取值走语言包，spotlight.js 新增的取值退回定义里的标签。
 * @param {string} value 设置取值
 * @param {string} [fallback] 定义给出的标签
 * @returns {string} 显示名
 */
function hotkeyLabelFor(value, fallback) {
    const labels = {
        "double-ctrl-left": t("ss.spotlight.hotkeyDoubleCtrlLeft", "双击 Control（左）"),
        "double-ctrl-right": t("ss.spotlight.hotkeyDoubleCtrlRight", "双击 Control（右）"),
        "double-alt-left": t("ss.spotlight.hotkeyDoubleAltLeft", "双击 Option（左）"),
        "double-alt-right": t("ss.spotlight.hotkeyDoubleAltRight", "双击 Option（右）"),
        "double-shift-left": t("ss.spotlight.hotkeyDoubleShiftLeft", "双击 Shift（左）"),
        "double-shift-right": t("ss.spotlight.hotkeyDoubleShiftRight", "双击 Shift（右）"),
        off: t("ss.spotlight.hotkeyOff", "不设"),
    };
    return labels[value] || fallback || String(value);
}

/** 面板没有自持的全局监听（订阅都由 ui.js 统一释放），保留空实现供壳调用。 */
export function destroy() { }
