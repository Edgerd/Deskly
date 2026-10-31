/**
 * panes/keyboard.js — 「系统设置 › 键盘」面板
 *
 * 上半部分是真实开关：keyboard.menuShortcuts 会广播 `keyboard-shortcut-hints-change`，
 * 顶栏菜单右侧那列 ⌘N 提示直接跟着显示或隐藏。
 *
 * 下半部分是快捷键总表：数据由 finderbar.js 的 getShortcutMap() 提供（菜单树里带
 * shortcut 的项），本面板只做过滤与复制，不另立一份表 —— 两处各抄一遍必然漂移。
 * 该导出缺失时如实显示空态，不编造条目。
 */

import * as finderbarApi from "../../../src/javascripts/finderbar.js";
import { tierText } from "../../../src/javascripts/keyboard.js";
import {
    t, el, note, group, controlSwitch, actionRow, statusRow, table, usePaneStyle,
} from "../ui.js";

export const paneId = "keyboard";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            keyboard: {
                hintsGroup: "菜单",
                menuShortcuts: "菜单快捷键提示",
                tableGroup: "键盘快捷键",
                search: "搜索",
                searchPlaceholder: "搜索应用、菜单或快捷键",
                count: "命中条数",
                empty: "没有匹配的快捷键。",
                missing: "暂时取不到快捷键表。",
                appColumn: "应用",
                generalApp: "通用",
                menuColumn: "菜单",
                labelColumn: "操作",
                shortcutColumn: "快捷键",
                statusColumn: "状态",
                copyGroup: "快捷键清单",
                copy: "复制快捷键清单",
                copyBtn: "复制",
                copyDone: "已复制到剪贴板。",
                copyFallback: "剪贴板被拒绝，已改为选中文本，按 Ctrl/⌘+C 复制。",
                copyFailed: "复制失败：",
            },
        },
    },
    "en": {
        ss: {
            keyboard: {
                hintsGroup: "Menus",
                menuShortcuts: "Show menu shortcuts",
                tableGroup: "Keyboard shortcuts",
                search: "Search",
                searchPlaceholder: "Search apps, menus or shortcuts",
                count: "Matches",
                empty: "No matching shortcuts.",
                missing: "The shortcut list is unavailable.",
                appColumn: "App",
                generalApp: "General",
                menuColumn: "Menu",
                labelColumn: "Action",
                shortcutColumn: "Shortcut",
                statusColumn: "Status",
                copyGroup: "Shortcut list",
                copy: "Copy shortcut list",
                copyBtn: "Copy",
                copyDone: "Copied to clipboard.",
                copyFallback: "Clipboard was denied; the text is selected — press Ctrl/⌘+C.",
                copyFailed: "Copy failed: ",
            },
        },
    },
    "ja-JP": {
        ss: {
            keyboard: {
                hintsGroup: "メニュー",
                menuShortcuts: "メニューにショートカットを表示",
                tableGroup: "キーボードショートカット",
                search: "検索",
                searchPlaceholder: "アプリ・メニュー・キーを検索",
                count: "該当数",
                empty: "一致するショートカットはありません。",
                missing: "ショートカット一覧を取得できません。",
                appColumn: "アプリ",
                generalApp: "共通",
                menuColumn: "メニュー",
                labelColumn: "操作",
                shortcutColumn: "ショートカット",
                statusColumn: "状態",
                copyGroup: "ショートカット一覧",
                copy: "ショートカット一覧をコピー",
                copyBtn: "コピー",
                copyDone: "クリップボードにコピーしました。",
                copyFallback: "クリップボードが拒否されました。テキストを選択済みなので Ctrl/⌘+C を。",
                copyFailed: "コピー失敗：",
            },
        },
    },
    cat: {
        ss: {
            keyboard: {
                hintsGroup: "菜单喵",
                menuShortcuts: "在菜单里显示快捷键提示",
                tableGroup: "快捷键总表喵",
                search: "找一找",
                searchPlaceholder: "按应用、菜单或按键筛一下喵",
                count: "找到几条",
                empty: "一件都没对上喵。",
                missing: "现在拿不到快捷键表喵。",
                appColumn: "哪个应用",
                generalApp: "哪里都能用",
                menuColumn: "哪个菜单",
                labelColumn: "做什么",
                shortcutColumn: "按什么键",
                statusColumn: "能不能按喵",
                copyGroup: "把清单带走喵",
                copy: "复制快捷键清单",
                copyBtn: "复制喵",
                copyDone: "已经放进剪贴板啦喵。",
                copyFallback: "剪贴板不让写喵，文本帮主人选中了，按 Ctrl/⌘+C 就好。",
                copyFailed: "复制没成功：",
            },
        },
    },
};

const CSS = `
.ss-keyboard .ss-keyboard__filter { display: flex; align-items: center; gap: 10px; margin: 4px 0 10px; }
.ss-keyboard .ss-keyboard__filter .ss-input { flex: 1 1 auto; }
.ss-keyboard .ss-keyboard__count { font-size: 12px; opacity: .65; white-space: nowrap; }
.ss-keyboard .ss-table { width: 100%; }
.ss-keyboard .ss-keyboard__tier { font-size: 12px; opacity: .7; }
`;

/**
 * 构建键盘面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const rows = readShortcutMap();
    const countText = el("span", { class: "ss-keyboard__count" });

    const shortcutTable = table({
        columns: [
            {
                key: "app",
                label: t("ss.keyboard.appColumn", "应用"),
                width: "18%",
                render: (entry) => el("span", { text: String(entry.app || t("ss.keyboard.generalApp", "通用")) }),
            },
            { key: "menu", label: t("ss.keyboard.menuColumn", "菜单"), width: "16%" },
            { key: "label", label: t("ss.keyboard.labelColumn", "操作") },
            { key: "shortcut", label: t("ss.keyboard.shortcutColumn", "快捷键"), width: "16%" },
            {
                key: "status",
                label: t("ss.keyboard.statusColumn", "状态"),
                width: "14%",
                // 状态来自 keyboard.js 的键位表：已绑定 / 等价键 / 浏览器保留 / 尚未实现 / 菜单可用
                render: (entry) => el("span", { class: "ss-keyboard__tier", text: tierText(entry.status, t) }),
            },
        ],
        rows,
        empty: t("ss.keyboard.empty", "没有匹配的快捷键。"),
    });

    /** 按输入框内容过滤表格并更新命中数。 @param {string} query 过滤词 */
    const applyFilter = (query) => {
        const hits = filterRows(rows, query, t);
        shortcutTable.setRows(hits);
        countText.textContent = `${t("ss.keyboard.count", "命中条数")} ${hits.length}/${rows.length}`;
    };

    const filterInput = el("input", {
        class: "ss-input ss-keyboard__filter-input",
        attrs: { type: "search", placeholder: t("ss.keyboard.searchPlaceholder", "搜索应用、菜单或快捷键"), "aria-label": t("ss.keyboard.search", "搜索") },
    });
    filterInput.addEventListener("input", () => applyFilter(filterInput.value));
    applyFilter("");

    const copyState = statusRow({ label: t("ss.keyboard.copy", "复制快捷键清单"), value: "—" });

    return el("div", { class: "ss-pane ss-keyboard" },
        group([
            controlSwitch("keyboard.menuShortcuts", {
                label: t("ss.keyboard.menuShortcuts", "菜单快捷键提示"),
            }),
        ], { title: t("ss.keyboard.hintsGroup", "菜单") }),

        group([
            el("div", { class: "ss-keyboard__filter" }, filterInput, countText),
            rows.length ? shortcutTable : note("ss.keyboard.missing", "暂时取不到快捷键表。"),
        ], { title: t("ss.keyboard.tableGroup", "键盘快捷键") }),

        group([
            actionRow({
                label: t("ss.keyboard.copy", "复制快捷键清单"),
                buttonText: t("ss.keyboard.copyBtn", "复制"),
                onAction: async () => copyState.setValue(await copyList(rows)),
            }),
            copyState,
        ], { title: t("ss.keyboard.copyGroup", "快捷键清单") })
    );
}

/**
 * 读取快捷键总表：finderbar.js 没有该导出时返回空数组，由界面显示空态。
 * @returns {Array<{app:string, menu:string, label:string, shortcut:string}>} 条目
 */
function readShortcutMap() {
    if (typeof finderbarApi.getShortcutMap !== "function") return [];
    try {
        const list = finderbarApi.getShortcutMap() || [];
        return list.filter((entry) => entry && entry.shortcut);
    } catch {
        return [];
    }
}

/**
 * 五列模糊过滤（大小写不敏感，任意字段命中即保留；状态列按当前语言参与匹配）。
 * @param {Array<object>} rows 全部条目
 * @param {string} query 过滤词
 * @param {Function} translate 文案函数
 * @returns {Array<object>} 命中条目
 */
function filterRows(rows, query, translate) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((entry) => [entry.app, entry.menu, entry.label, entry.shortcut, tierText(entry.status, translate)]
        .some((field) => String(field || "").toLowerCase().includes(needle)));
}

/**
 * 把清单写成 TSV 复制到剪贴板；剪贴板 API 不可用时退回隐藏 textarea + execCommand。
 * @param {Array<object>} rows 全部条目
 * @returns {Promise<string>} 给用户看的结果说明
 */
async function copyList(rows) {
    const header = [
        t("ss.keyboard.appColumn", "应用"),
        t("ss.keyboard.menuColumn", "菜单"),
        t("ss.keyboard.labelColumn", "操作"),
        t("ss.keyboard.shortcutColumn", "快捷键"),
    ].join("\t");
    const general = t("ss.keyboard.generalApp", "通用");
    const text = [header, ...rows.map((entry) => [entry.app || general, entry.menu, entry.label, entry.shortcut].join("\t"))].join("\n");
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return t("ss.keyboard.copyDone", "已复制到剪贴板。");
        }
    } catch {
        /* 落到下面的选中文本方案 */
    }
    try {
        const area = el("textarea", { attrs: { readonly: "" } });
        area.value = text;
        area.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.append(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok
            ? t("ss.keyboard.copyDone", "已复制到剪贴板。")
            : t("ss.keyboard.copyFallback", "剪贴板被拒绝，已改为选中文本，按 Ctrl/⌘+C 复制。");
    } catch (err) {
        return `${t("ss.keyboard.copyFailed", "复制失败：")}${String(err && err.message ? err.message : err).slice(0, 60)}`;
    }
}

/** 键盘面板没有全局资源；控件订阅由 ui.js 的 disposeAll() 释放。 */
export function destroy() { }
