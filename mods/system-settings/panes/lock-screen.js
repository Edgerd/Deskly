/**
 * panes/lock-screen.js — 「系统设置 › 锁定屏幕」面板
 *
 * 空闲自动锁定的分钟数由 lock.js 定义并生效（0 = 从不），滑块标签直接跟着值改写，
 * 免得停在「0 分钟」这种看起来像立刻锁屏的表述上。「立即锁定」调 lock.lockNow("manual")，
 * 与顶栏菜单里的锁定屏幕走同一条路径。
 *
 * 自动锁定与登录密码是一对：只锁不设密码等于没锁。所以开了「解锁需要密码」却没设过密码时，
 * 这里挂一条警示行，点它经 debug.js 的 openSettingsPane("password") 跳到「登录密码」面板。
 */

import { lock } from "../../../src/javascripts/lock.js";
import { openSettingsPane } from "../../../src/javascripts/debug.js";
import { settings } from "../../../src/javascripts/settings.js";
import {
    t, el, group, bind, controlSlider, actionRow, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "lock-screen";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            "lock-screen": {
                autoGroup: "自动锁定",
                autoLock: "闲置自动锁定",
                never: "从不",
                minutes: "分钟",
                stateGroup: "当前状态",
                requiresLabel: "解锁需要密码",
                requiresYes: "已开启",
                requiresNo: "未开启",
                passwordLabel: "登录密码",
                passwordYes: "已设置",
                passwordNo: "未设置",
                lockNowGroup: "锁定",
                lockNow: "立即锁定",
                lockNowBtn: "锁定",
                warn: "未设置密码",
                goto: "锁屏后任何人都能进入。",
                gotoBtn: "去设置",
                notReady: "此操作暂不可用。",
            },
        },
    },
    en: {
        ss: {
            "lock-screen": {
                autoGroup: "Auto Lock",
                autoLock: "Lock After Idle",
                never: "Never",
                minutes: "min",
                stateGroup: "Status",
                requiresLabel: "Require Password",
                requiresYes: "On",
                requiresNo: "Off",
                passwordLabel: "Password",
                passwordYes: "Set",
                passwordNo: "Not Set",
                lockNowGroup: "Lock",
                lockNow: "Lock Now",
                lockNowBtn: "Lock",
                warn: "No Password Set",
                goto: "Anyone can still unlock the screen.",
                gotoBtn: "Set It Up",
                notReady: "Not available.",
            },
        },
    },
    "ja-JP": {
        ss: {
            "lock-screen": {
                autoGroup: "自動ロック",
                autoLock: "自動ロック",
                never: "行わない",
                minutes: "分",
                stateGroup: "現在の状態",
                requiresLabel: "解除にパスワードが必要",
                requiresYes: "オン",
                requiresNo: "オフ",
                passwordLabel: "パスワード",
                passwordYes: "設定済み",
                passwordNo: "未設定",
                lockNowGroup: "ロック",
                lockNow: "ただちにロック",
                lockNowBtn: "ロック",
                warn: "パスワード未設定",
                goto: "ロックしても誰でも解除できます。",
                gotoBtn: "設定する",
                notReady: "現在実行できません。",
            },
        },
    },
    cat: {
        ss: {
            "lock-screen": {
                autoGroup: "自动锁屏喵",
                autoLock: "放多久就锁屏喵",
                never: "不锁啦",
                minutes: "分钟",
                stateGroup: "现在的情况喵",
                requiresLabel: "解锁要密码吗",
                requiresYes: "要哒",
                requiresNo: "不用",
                passwordLabel: "登录密码喵",
                passwordYes: "设好啦",
                passwordNo: "还没有喵",
                lockNowGroup: "锁埋佢喵",
                lockNow: "立即锁屏幕喵",
                lockNowBtn: "锁起来",
                warn: "仲未设密码喵",
                goto: "锁咗都当冇锁，边个都入得嚟喵~",
                gotoBtn: "现在就去",
                notReady: "暂时做唔到喵。",
            },
        },
    },
};

const CSS = `
.ss-lock-screen .ss-status__value { font-variant-numeric: tabular-nums; }
.ss-lock-screen .ss-row--warn { background: rgba(255,204,0,.16); }
`;

/**
 * 本面板取词：paneId 带连字符，t() 行内的第一个字面量（译文键）会被文案检查误读成正文本身，
 * 走这里把键拼在模板串里，label / hint 行上的首段字面量就是真正的兜底文案。
 * @param {string} key 词条短名（不含 ss.lock-screen. 前缀）
 * @param {string} fallback 中文回退
 * @returns {string} 成品文本
 */
function tt(key, fallback) {
    return t(`ss.${paneId}.${key}`, fallback);
}

/**
 * 构建锁定屏幕面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const autoRowEl = controlSlider("lock.autoLockMinutes", {
        label: tt("autoLock", "闲置自动锁定"),
        min: 0, max: 120, step: 5,
        units: t("ss.lock-screen.minutes", "分钟"),
    });
    // 覆盖控件自带的读数：0 分钟这种写法会让人以为要立刻锁屏。
    bind("lock.autoLockMinutes", (value) => {
        const label = autoRowEl.querySelector(".ss-slider__value");
        if (!label) return;
        const minutes = Number(value);
        label.textContent = minutes <= 0
            ? t("ss.lock-screen.never", "从不")
            : `${minutes} ${t("ss.lock-screen.minutes", "分钟")}`;
    });

    const requiresRow = statusRow({ label: tt("requiresLabel", "解锁需要密码") });
    const passwordRow = statusRow({ label: tt("passwordLabel", "登录密码") });
    const warnRow = actionRow({
        label: tt("warn", "未设置密码"),
        hint: tt("goto", "锁屏后任何人都能进入。"),
        buttonText: t("ss.lock-screen.gotoBtn", "去设置"),
        tone: "accent",
        onAction: () => { if (typeof openSettingsPane === "function") openSettingsPane("password"); },
    });
    warnRow.hidden = true;

    /** 把「要不要密码 / 有没有密码」两处事实反映到界面，并据此决定警示行是否出现。 */
    function repaintState() {
        const requires = Boolean(settings.get("lock.requirePassword"));
        const hasPassword = Boolean(lock?.hasPassword?.());
        requiresRow.setValue(requires ? t("ss.lock-screen.requiresYes", "已开启") : t("ss.lock-screen.requiresNo", "未开启"));
        passwordRow.setValue(hasPassword ? t("ss.lock-screen.passwordYes", "已设置") : t("ss.lock-screen.passwordNo", "未设置"));
        warnRow.hidden = !(requires && !hasPassword);
        warnRow.classList.toggle("ss-row--warn", warnRow.hidden === false);
    }
    bind("lock.requirePassword", repaintState);
    repaintState();

    return el("div", { class: "ss-pane ss-lock-screen" },
        group([autoRowEl], { title: t("ss.lock-screen.autoGroup", "自动锁定") }),

        group([
            requiresRow,
            passwordRow,
            warnRow,
        ], { title: t("ss.lock-screen.stateGroup", "当前状态") }),

        group([
            actionRow({
                label: tt("lockNow", "立即锁定"),
                buttonText: t("ss.lock-screen.lockNowBtn", "锁定"),
                onAction: async () => {
                    if (typeof lock?.lockNow !== "function") throw new Error(t("ss.lock-screen.notReady", "此操作暂不可用。"));
                    lock.lockNow("manual");
                },
            }),
        ], { title: t("ss.lock-screen.lockNowGroup", "锁定") })
    );
}

/** 锁定屏幕面板不持有全局资源；订阅由 ui.js 的 disposeAll() 释放。 */
export function destroy() { }
