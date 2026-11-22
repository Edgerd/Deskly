/**
 * panes/datetime.js — 「时间与地区」：语言、时间格式、显示秒、周起始日
 *
 * 从「通用」拆出的子面板：这些键在 settings-definitions 里原本就绑着真实生效逻辑
 * （切语言立即切换、三个时间键触发 datetime-format-change 重排菜单栏时钟），
 * 这里只是把控件集中到一页，不新增任何存储键。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { el, t, group, controlDropdown, controlSegmented, controlSwitch, usePaneStyle } from "../ui.js";

export const paneId = "datetime";

/** 面板语言包。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { datetime: "时间与地区" },
            datetime: {
                region: "地区与语言", language: "语言",
                timeTitle: "日期与时间", timeFormat: "时间格式", time24: "24 小时", time12: "12 小时",
                showSeconds: "显示秒",
                weekStart: "周起始日", sunday: "周日", monday: "周一",
                note: "时间与日期会同步到菜单栏时钟、日历与各处时间显示。",
            },
        },
    },
    en: {
        ss: {
            pane: { datetime: "Date & Time" },
            datetime: {
                region: "Region & Language", language: "Language",
                timeTitle: "Date & Time", timeFormat: "Time Format", time24: "24-hour", time12: "12-hour",
                showSeconds: "Show Seconds",
                weekStart: "First Day of Week", sunday: "Sunday", monday: "Monday",
                note: "Date and time settings apply to the menu bar clock, Calendar and timestamp displays.",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { datetime: "日付と時刻" },
            datetime: {
                region: "地域と言語", language: "言語",
                timeTitle: "日付と時刻", timeFormat: "時刻の形式", time24: "24時間", time12: "12時間",
                showSeconds: "秒を表示",
                weekStart: "週の始まり", sunday: "日曜日", monday: "月曜日",
                note: "日付と時刻の設定はメニューバーの時計、カレンダー、各所の時刻表示に反映されます。",
            },
        },
    },
    cat: {
        ss: {
            pane: { datetime: "日子同地方喵" },
            datetime: {
                region: "邊度同講乜嘢話喵", language: "主人要用的語言喵",
                timeTitle: "日期與時間喵", timeFormat: "時間怎麼讀喵", time24: "24 小時喵", time12: "12 小時喵",
                showSeconds: "把秒也露出來喵",
                weekStart: "一週從哪天開始喵", sunday: "星期日喵", monday: "星期一喵",
                note: "時間同日子會跟住去菜單欄時鐘、月曆同四圍嘅時間顯示喵。",
            },
        },
    },
};

/** 面板私有样式：只影响本面板；样式节点由 ui.usePaneStyle 按面板 id 复用。 */
const PANE_CSS = `
.ss-pane-datetime .ss-note { padding: 0 12px 8px; }
`;

/**
 * 构建「时间与地区」面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-datetime", dataset: { pane: paneId } });

    // 语言选项每次 build 都重新取：语言列表属于 i18n 运行时状态，不能算在模块求值时。
    const languages = (i18n.getSupportedLanguages() || []).map((lang) => ({
        value: lang.id || lang.code || lang,
        label: lang.label || lang.name || lang.id || lang.code || String(lang),
    }));

    root.append(
        group([
            controlDropdown("general.language", {
                label: t("ss.datetime.language", "语言"),
                options: languages,
            }),
        ], { title: t("ss.datetime.region", "地区与语言") }),

        group([
            controlSegmented("general.timeFormat", {
                label: t("ss.datetime.timeFormat", "时间格式"),
                options: [
                    { value: "24h", label: t("ss.datetime.time24", "24 小时") },
                    { value: "12h", label: t("ss.datetime.time12", "12 小时") },
                ],
            }),
            controlSwitch("general.showSeconds", {
                label: t("ss.datetime.showSeconds", "显示秒"),
            }),
            controlSegmented("general.weekStart", {
                label: t("ss.datetime.weekStart", "周起始日"),
                options: [
                    { value: 0, label: t("ss.datetime.sunday", "周日") },
                    { value: 1, label: t("ss.datetime.monday", "周一") },
                ],
            }),
        ], { title: t("ss.datetime.timeTitle", "日期与时间") }),
    );

    return root;
}
