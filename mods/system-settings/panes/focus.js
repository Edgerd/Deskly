/**
 * panes/focus.js — 「系统设置 › 专注模式」面板
 *
 * 开关与模式名就是控制中心里那张大卡（controlcenter.focus / controlcenter.focusMode），
 * 写键经设置中枢广播 `settings-changed`，controlcenter.js 并回内存镜像重绘卡片。
 *
 * 「已拦截 N 条」读 ui/notification.js 的 pendingCount()，清零走 resetPendingCount()；
 * 刷新有三路：设置变更订阅、面板轻量轮询、手动测试后的立刻回读。
 *
 * 飞行模式与 Wi-Fi 无联动互斥（controlcenter.js 的 handleCardAction 只逐项取反），如实写明，不编造行为。
 */

import { settings } from "../../../src/javascripts/settings.js";
import * as notificationApi from "../../../src/javascripts/ui/notification.js";
import { glyph } from "../../../src/javascripts/paths.js";
import {
    t, el, group, controlSwitch, controlDropdown, actionRow, statusRow, usePaneStyle, track,
} from "../ui.js";

export const paneId = "focus";

export const messages = {
    "zh-CN": {
        ss: {
            focus: {
                modeGroup: "专注模式",
                enabled: "勿扰模式",
                mode: "模式",
                modeWork: "工作",
                modePersonal: "个人",
                modeSleep: "睡眠",
                modeDoNotDisturb: "勿扰",
                counterGroup: "拦截统计",
                pending: "已拦截通知",
                pendingUnavailable: "读不到",
                unit: "条",
                reset: "拦截计数",
                resetBtn: "清零",
                testGroup: "测试",
                test: "测试通知",
                testBtn: "发送",
                testTitle: "专注模式测试",
                testText: "开着免打扰时你看不到这条。",
            },
        },
    },
    "en": {
        ss: {
            focus: {
                modeGroup: "Focus",
                enabled: "Do Not Disturb",
                mode: "Mode",
                modeWork: "Work",
                modePersonal: "Personal",
                modeSleep: "Sleep",
                modeDoNotDisturb: "Do Not Disturb",
                counterGroup: "Suppressed",
                pending: "Notifications held back",
                pendingUnavailable: "n/a",
                unit: "held",
                reset: "Held count",
                resetBtn: "Reset",
                testGroup: "Test",
                test: "Test notification",
                testBtn: "Send",
                testTitle: "Focus test",
                testText: "You should not see this while Focus is on.",
            },
        },
    },
    "ja-JP": {
        ss: {
            focus: {
                modeGroup: "集中モード",
                enabled: "通知オフ",
                mode: "モード",
                modeWork: "仕事",
                modePersonal: "パーソナル",
                modeSleep: "睡眠",
                modeDoNotDisturb: "通知オフ",
                counterGroup: "抑止した件数",
                pending: "止めた通知",
                pendingUnavailable: "取得不可",
                unit: "件",
                reset: "止めた件数",
                resetBtn: "リセット",
                testGroup: "テスト",
                test: "テスト通知",
                testBtn: "送信",
                testTitle: "集中モードのテスト",
                testText: "集中モード中は表示されません。",
            },
        },
    },
    cat: {
        ss: {
            focus: {
                modeGroup: "专注模式喵",
                enabled: "勿扰喵",
                mode: "选哪个模式",
                modeWork: "上班喵",
                modePersonal: "陪主人",
                modeSleep: "睡觉觉",
                modeDoNotDisturb: "别吵喵",
                counterGroup: "拦下来多少喵",
                pending: "已拦截通知",
                pendingUnavailable: "数不出来喵",
                unit: "条喵",
                reset: "拦下来的数喵",
                resetBtn: "清零喵",
                testGroup: "测试喵",
                test: "测试通知喵",
                testBtn: "发出去喵",
                testTitle: "专注模式测试喵",
                testText: "开着勿扰时主人看不到这条。",
            },
        },
    },
};

/** 模式候选值：与 CONTROL_CENTER_FIELDS 里 focusMode 的 values 对齐（定义缺失时的兜底）。 */
const MODE_FALLBACK_VALUES = ["work", "personal", "sleep", "doNotDisturb"];

const CSS = `
.ss-focus .ss-status__value { font-variant-numeric: tabular-nums; }
`;

/**
 * 构建专注模式面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const counterAvailable = typeof notificationApi.pendingCount === "function";
    const counterRow = statusRow({
        label: t("ss.focus.pending", "已拦截通知"),
        value: counterAvailable ? `0 ${t("ss.focus.unit", "条")}` : t("ss.focus.pendingUnavailable", "读不到"),
    });

    /** 回读拦截计数并写进状态行。 */
    function refreshCounter() {
        if (!counterAvailable) return;
        const count = Number(notificationApi.pendingCount() || 0);
        counterRow.setValue(`${count} ${t("ss.focus.unit", "条")}`);
    }

    // 三路刷新：设置变更（可能是别的界面改了专注开关）、通知到达后的轮询、手动测试后的回读。
    track(settings.subscribe(() => refreshCounter()));
    const pollId = setInterval(refreshCounter, 2000);
    track(() => clearInterval(pollId));

    const modeDef = settings.info("controlcenter.focusMode");
    const defValues = Array.isArray(modeDef?.values) && modeDef.values.length ? modeDef.values : MODE_FALLBACK_VALUES;
    const defLabels = Array.isArray(modeDef?.valuesLabel) ? modeDef.valuesLabel : [];
    const modeSpec = {
        label: t("ss.focus.mode", "模式"),
        options: defValues.map((value, index) => ({ value, label: modeLabelFor(value, defLabels[index]) })),
    };

    return el("div", { class: "ss-pane ss-focus" },
        group([
            controlSwitch("controlcenter.focus", { label: t("ss.focus.enabled", "勿扰模式") }),
            controlDropdown("controlcenter.focusMode", modeSpec),
        ], { title: t("ss.focus.modeGroup", "专注模式") }),

        group([
            counterRow,
            actionRow({
                label: t("ss.focus.reset", "拦截计数"),
                buttonText: t("ss.focus.resetBtn", "清零"),
                onAction: async () => {
                    if (typeof notificationApi.resetPendingCount === "function") notificationApi.resetPendingCount();
                    refreshCounter();
                },
            }),
        ], { title: t("ss.focus.counterGroup", "拦截统计") }),

        group([
            actionRow({
                label: t("ss.focus.test", "测试通知"),
                buttonText: t("ss.focus.testBtn", "发送"),
                onAction: async () => {
                    window.__notify?.show?.({
                        title: t("ss.focus.testTitle", "专注模式测试"),
                        text: t("ss.focus.testText", "开着免打扰时你应该看不到这条。"),
                        icon: glyph("moon.fill"),
                    });
                    refreshCounter();
                },
            }),
        ], { title: t("ss.focus.testGroup", "测试") })
    );
}

/**
 * 模式名的译文：已知模式走语言包，controlcenter.js 以后新增的模式退回定义里的标签。
 * @param {string} value 模式取值
 * @param {string} [fallback] 设置定义给出的标签
 * @returns {string} 显示名
 */
function modeLabelFor(value, fallback) {
    const labels = {
        work: t("ss.focus.modeWork", "工作"),
        personal: t("ss.focus.modePersonal", "个人"),
        sleep: t("ss.focus.modeSleep", "睡眠"),
        doNotDisturb: t("ss.focus.modeDoNotDisturb", "勿扰"),
    };
    return labels[value] || fallback || String(value);
}

/** 轮询与订阅都登记在 ui.js 的释放列表里，切面板时自动停掉。 */
export function destroy() { }
