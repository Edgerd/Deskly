/**
 * panes/notifications.js — 「系统设置 › 通知」面板
 *
 * 三件事都有真实落点：
 * 1. notify.* 的写入会广播 `notify-config-change`（见 settings-definitions.js 的 apply），
 *    ui/notification.js 据此决定横幅是否出现、是否发声、停留多久。
 * 2. 系统级通知授权走 permissions.js（浏览器 Notification 权限），状态与请求结果都回读，
 *    不支持或被拒绝都如实显示，不做假成功。
 * 3. 「发送测试通知」真的调用 window.__notify.show，能立刻看到上面几项开关的效果。
 *
 * 时长滑块只在「允许通知」打开时出现：关了横幅，停留时长没有意义。
 */

import { permissions } from "../../../src/javascripts/permissions.js";
import { glyph } from "../../../src/javascripts/paths.js";
import {
    t, el, group, bind, controlSwitch, controlSlider, actionRow, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "notifications";

/** 浏览器 Notification 权限状态到可读文案的映射键。 */
const STATE_KEYS = {
    granted: { key: "ss.notifications.stateGranted", fallback: "已允许" },
    denied: { key: "ss.notifications.stateDenied", fallback: "已拒绝" },
    prompt: { key: "ss.notifications.statePrompt", fallback: "尚未询问" },
    default: { key: "ss.notifications.statePrompt", fallback: "尚未询问" },
    unsupported: { key: "ss.notifications.stateUnsupported", fallback: "当前环境不支持" },
    unknown: { key: "ss.notifications.stateUnknown", fallback: "未知" },
};

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            notifications: {
                bannerGroup: "横幅",
                enabled: "允许通知",
                sound: "通知提示音",
                duration: "停留时长",
                unitSeconds: "毫秒",
                permissionGroup: "系统通知权限",
                permission: "浏览器通知授权",
                request: "请求权限",
                requestHint: "拒绝后需在浏览器设置中改回。",
                testGroup: "测试",
                test: "发送测试通知",
                testBtn: "发送",
                testTitle: "Deskly 系统设置",
                testText: "这是一条来自「通知」面板的测试横幅。",
                dismiss: "收起全部",
                dismissBtn: "收起",
                stateGranted: "已允许",
                stateDenied: "已拒绝",
                statePrompt: "尚未询问",
                stateUnsupported: "当前环境不支持",
                stateUnknown: "未知",
                requestFailed: "请求失败：",
            },
        },
    },
    "en": {
        ss: {
            notifications: {
                bannerGroup: "Banners",
                enabled: "Allow notifications",
                sound: "Notification sound",
                duration: "Duration",
                unitSeconds: "ms",
                permissionGroup: "System notification access",
                permission: "Browser notification permission",
                request: "Request permission",
                requestHint: "After a denial, change it in browser settings.",
                testGroup: "Test",
                test: "Send a test notification",
                testBtn: "Send",
                testTitle: "Deskly System Settings",
                testText: "This is a test banner from the Notifications pane.",
                dismiss: "Dismiss all",
                dismissBtn: "Dismiss",
                stateGranted: "Allowed",
                stateDenied: "Denied",
                statePrompt: "Not asked yet",
                stateUnsupported: "Not supported here",
                stateUnknown: "Unknown",
                requestFailed: "Request failed: ",
            },
        },
    },
    "ja-JP": {
        ss: {
            notifications: {
                bannerGroup: "バナー",
                enabled: "通知を許可",
                sound: "通知音",
                duration: "表示時間",
                unitSeconds: "ms",
                permissionGroup: "システム通知権限",
                permission: "ブラウザの通知許可",
                request: "許可を求める",
                requestHint: "拒否後はブラウザの設定で変更できます。",
                testGroup: "テスト",
                test: "テスト通知を送る",
                testBtn: "送信",
                testTitle: "Deskly システム設定",
                testText: "「通知」パネルからのテストバナーです。",
                dismiss: "すべて消す",
                dismissBtn: "消す",
                stateGranted: "許可済み",
                stateDenied: "拒否",
                statePrompt: "未確認",
                stateUnsupported: "この環境では未対応",
                stateUnknown: "不明",
                requestFailed: "要求に失敗：",
            },
        },
    },
    cat: {
        ss: {
            notifications: {
                bannerGroup: "小横幅喵",
                enabled: "允许弹出通知横幅",
                sound: "通知提示音",
                duration: "停留时长",
                unitSeconds: "毫秒喵",
                permissionGroup: "系统通知权限喵",
                permission: "浏览器的通知许可",
                request: "去要个许可",
                requestHint: "被主人拒了就只能去浏览器设置里改啦喵。",
                testGroup: "来试一下喵",
                test: "发送测试通知",
                testBtn: "发出去喵",
                testTitle: "Deskly 系统设置喵",
                testText: "这是从「通知」面板寄来的测试横幅喵。",
                dismiss: "全部收起来",
                dismissBtn: "收起喵",
                stateGranted: "已经答应啦",
                stateDenied: "被拒绝了呢",
                statePrompt: "还没问过喵",
                stateUnsupported: "这个环境不支持喵",
                stateUnknown: "不太清楚喵",
                requestFailed: "要许可失败了：",
            },
        },
    },
};

const CSS = `
.ss-notifications .ss-status__value { font-variant-numeric: tabular-nums; }
.ss-notifications__value--granted { color: #2cd058; }
.ss-notifications__value--denied { color: #ff453a; }
.ss-notifications__value--neutral { opacity: .7; }
`;

/**
 * 构建通知面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const durationRow = controlSlider("notify.duration", {
        label: t("ss.notifications.duration", "停留时长"),
        min: 2000, max: 15000, step: 500,
        units: t("ss.notifications.unitSeconds", "毫秒"),
    });
    // 关了横幅就没有「停留多久」可言，整行撤下，避免留一个改了没效果的滑块。
    bind("notify.enabled", (value) => { durationRow.hidden = !value; });

    const permissionRow = statusRow({
        label: t("ss.notifications.permission", "浏览器通知授权"),
        value: "—",
    });
    const valueNode = permissionRow.querySelector(".ss-status__value");

    const requestRow = actionRow({
        label: t("ss.notifications.request", "请求权限"),
        hint: t("ss.notifications.requestHint", "拒绝后需在浏览器设置中改回。"),
        buttonText: t("ss.notifications.request", "请求权限"),
        onAction: async () => {
            const outcome = await permissions?.request?.("notifications");
            const info = normalizeQuery(outcome);
            if (outcome && outcome.ok === false && (outcome.error || info.state === "unsupported")) {
                permissionRow.setValue(`${t("ss.notifications.requestFailed", "请求失败：")}${String(outcome.error || outcome.detail || info.state).slice(0, 60)}`);
            }
            await repaintPermission();
        },
    });
    const requestButton = requestRow.querySelector(".ss-btn");

    /** 重新读权限并刷新状态行与按钮可用性（permissions.js 全异步，query() 返回 Promise）。 */
    async function repaintPermission() {
        const raw = typeof permissions?.query === "function" ? await permissions.query("notifications") : null;
        const info = normalizeQuery(raw);
        if (valueNode) {
            valueNode.textContent = stateLabel(info.state);
            valueNode.className = `ss-status__value ss-notifications__value--${info.state === "granted" ? "granted" : info.state === "denied" ? "denied" : "neutral"}`;
        }
        if (requestButton) requestButton.disabled = !info.supported || info.state === "granted";
    }
    repaintPermission();

    return el("div", { class: "ss-pane ss-notifications" },
        group([
            controlSwitch("notify.enabled", { label: t("ss.notifications.enabled", "允许通知") }),
            durationRow,
            controlSwitch("notify.sound", { label: t("ss.notifications.sound", "通知提示音") }),
        ], { title: t("ss.notifications.bannerGroup", "横幅") }),

        group([
            permissionRow,
            requestRow,
        ], { title: t("ss.notifications.permissionGroup", "系统通知权限") }),

        group([
            actionRow({
                label: t("ss.notifications.test", "发送测试通知"),
                buttonText: t("ss.notifications.testBtn", "发送"),
                onAction: () => window.__notify?.show?.({
                    title: t("ss.notifications.testTitle", "Deskly 系统设置"),
                    text: t("ss.notifications.testText", "这是一条来自「通知」面板的测试横幅。"),
                    icon: glyph("bell.badge.fill"),
                }),
            }),
            actionRow({
                label: t("ss.notifications.dismiss", "收起全部"),
                buttonText: t("ss.notifications.dismissBtn", "收起"),
                onAction: () => window.__notify?.dismissAll?.(),
            }),
        ], { title: t("ss.notifications.testGroup", "测试") })
    );
}

/**
 * 把 permissions.query() 的返回归一成 {state, supported}，兼容布尔 / 字符串 / 对象三种写法。
 * @param {*} raw 原始返回值
 * @returns {{state:string, supported:boolean}} 归一结果
 */
function normalizeQuery(raw) {
    if (raw === true) return { state: "granted", supported: true };
    if (raw === false) return { state: "unsupported", supported: false };
    if (typeof raw === "string") return { state: raw, supported: true };
    if (!raw || typeof raw !== "object") return { state: "unknown", supported: false };
    const supported = raw.supported !== false && raw.unsupported !== true;
    let state = raw.state || raw.status;
    if (!state && typeof raw.granted === "boolean") state = raw.granted ? "granted" : "prompt";
    return { state: String(state || "unknown"), supported };
}

/**
 * 权限状态的可读文案（未知状态原样显示，便于排查 permissions.js 的返回）。
 * @param {string} state 归一后的状态
 * @returns {string} 文案
 */
function stateLabel(state) {
    const entry = STATE_KEYS[state];
    if (!entry) return state;
    return t(entry.key, entry.fallback);
}

/** 面板不持有全局资源；订阅由 ui.js 的 disposeAll() 释放。 */
export function destroy() { }
