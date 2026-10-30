/**
 * panes/password.js — 「系统设置 › 登录密码」面板
 *
 * 密码不是设置项：它绝不能出现在 `settings.snapshot()` 里，所以这里不调 settings.set，
 * 一律走 lock.js 的 setPassword/checkPassword/clearPassword/hasPassword。
 *
 * 也不用 window.__dialog.prompt —— 它的输入框是 `type="password"` 之外的普通文本框
 * （见 ui/alert.js 里 `inputEl.type = "text"`），会把口令明文显示在弹窗上。这里自建
 * 两个 `<input type="password">`，配一份只看长度与字符类别、不回显任何字符的强度提示。
 *
 * 已存在密码时：先验旧密码，再经 __dialog.confirm 确认覆盖，两步都过才落盘。
 */

import { lock } from "../../../src/javascripts/lock.js";
import {
    t, el, group, controlSwitch, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "password";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            password: {
                requireSwitch: "解锁需要密码",
                requireHint: "关闭后不会删除密码。",
                statusGroup: "当前状态",
                statusLabel: "密码",
                statusSet: "已设置",
                statusUnset: "未设置",
                statusMissing: "无法读取密码状态。",
                formGroup: "设置密码",
                currentLabel: "当前密码",
                newPasswordLabel: "新密码",
                newPasswordHint: "至少 6 位。",
                confirmPasswordLabel: "确认密码",
                strengthLabel: "强度",
                strength0: "太短",
                strength1: "较弱",
                strength2: "一般",
                strength3: "较强",
                strength4: "很强",
                saveBtn: "保存",
                clearBtn: "清除",
                saved: "密码已保存。",
                cleared: "密码已清除。",
                mismatch: "两次输入不一致。",
                tooShort: "至少 6 位。",
                needCurrent: "请填写当前密码。",
                wrongCurrent: "当前密码不正确。",
                notReady: "密码功能不可用。",
                overwriteTitle: "覆盖现有密码？",
                overwriteMessage: "旧密码将立即失效。",
                overwriteOk: "覆盖",
                overwriteCancel: "取消",
                clearTitle: "清除登录密码？",
                clearMessage: "清除后锁屏不再需要密码。",
            },
        },
    },
    en: {
        ss: {
            password: {
                requireSwitch: "Require Password",
                requireHint: "Turning this off does not delete the password.",
                statusGroup: "Status",
                statusLabel: "Password",
                statusSet: "Set",
                statusUnset: "Not Set",
                statusMissing: "Status unavailable",
                formGroup: "Set Password",
                currentLabel: "Current Password",
                newPasswordLabel: "New Password",
                newPasswordHint: "At least 6 characters.",
                confirmPasswordLabel: "Verify Password",
                strengthLabel: "Strength",
                strength0: "Too Short",
                strength1: "Weak",
                strength2: "Fair",
                strength3: "Good",
                strength4: "Strong",
                saveBtn: "Save",
                clearBtn: "Clear",
                saved: "Password saved.",
                cleared: "Password cleared.",
                mismatch: "The two entries do not match.",
                tooShort: "At least 6 characters.",
                needCurrent: "Enter the current password.",
                wrongCurrent: "Current password is incorrect.",
                notReady: "Passwords unavailable.",
                overwriteTitle: "Overwrite the existing password?",
                overwriteMessage: "The old password stops working immediately.",
                overwriteOk: "Overwrite",
                overwriteCancel: "Cancel",
                clearTitle: "Clear the login password?",
                clearMessage: "The lock screen will no longer ask for a password.",
            },
        },
    },
    "ja-JP": {
        ss: {
            password: {
                requireSwitch: "解除にパスワードが必要",
                requireHint: "オフにしてもパスワードは消去されません。",
                statusGroup: "現在の状態",
                statusLabel: "パスワード",
                statusSet: "設定済み",
                statusUnset: "未設定",
                statusMissing: "状態を読み取れません",
                formGroup: "パスワード設定",
                currentLabel: "現在のパスワード",
                newPasswordLabel: "新しいパスワード",
                newPasswordHint: "6 文字以上。",
                confirmPasswordLabel: "パスワード（確認）",
                strengthLabel: "強度",
                strength0: "短すぎ",
                strength1: "弱い",
                strength2: "普通",
                strength3: "強い",
                strength4: "とても強い",
                saveBtn: "保存",
                clearBtn: "消去",
                saved: "パスワードを保存しました。",
                cleared: "パスワードを消去しました。",
                mismatch: "入力が一致しません。",
                tooShort: "6 文字以上にしてください。",
                needCurrent: "現在のパスワードを入力してください。",
                wrongCurrent: "現在のパスワードが違います。",
                notReady: "パスワード機能を利用できません。",
                overwriteTitle: "既存のパスワードを上書きしますか？",
                overwriteMessage: "旧パスワードはすぐ使えなくなります。",
                overwriteOk: "上書き",
                overwriteCancel: "取り消す",
                clearTitle: "ログインパスワードを消去しますか？",
                clearMessage: "ロック画面がパスワードを尋ねなくなります。",
            },
        },
    },
    cat: {
        ss: {
            password: {
                requireSwitch: "解锁要口令喵",
                requireHint: "关咗都唔会删口令喵。",
                statusGroup: "现在的情况喵",
                statusLabel: "口令",
                statusSet: "收好了",
                statusUnset: "还没有",
                statusMissing: "问唔着口令嘅情况喵",
                formGroup: "给主人设个口令",
                currentLabel: "现在的口令",
                newPasswordLabel: "新口令",
                newPasswordHint: "至少 6 位喵。",
                confirmPasswordLabel: "再打一遍喵",
                strengthLabel: "结实程度",
                strength0: "太短啦",
                strength1: "软软的",
                strength2: "还行",
                strength3: "挺结实",
                strength4: "超级结实",
                saveBtn: "存起来",
                clearBtn: "清掉",
                saved: "口令收好啦。",
                cleared: "口令清掉了喵。",
                mismatch: "两次打嘅唔一样喵。",
                tooShort: "至少要 6 位呀。",
                needCurrent: "先把而家嘅口令填上喵。",
                wrongCurrent: "而家嘅口令对唔住呢。",
                notReady: "口令呢家嘢而家用唔到喵。",
                overwriteTitle: "要盖咗旧口令吗喵？",
                overwriteMessage: "旧口令即刻作废喵。",
                overwriteOk: "盖掉",
                overwriteCancel: "先算了",
                clearTitle: "真的要清咗登录口令吗？",
                clearMessage: "清咗之后锁屏就唔再问口令喵。",
            },
        },
    },
};

const CSS = `
.ss-password .ss-password__fields { display: flex; flex-direction: column; gap: 6px; }
.ss-password .ss-password__input { display: flex; align-items: center; gap: 10px; }
.ss-password .ss-password__input > span { flex: 0 0 6.5em; font-size: 12px; opacity: .7; }
.ss-password .ss-password__input input { flex: 1 1 auto; }
.ss-password .ss-password__hint { font-size: 11px; opacity: .6; margin-left: 7.5em; }
.ss-password .ss-password__strength { display: flex; align-items: center; gap: 8px; margin-left: 7.5em; }
.ss-password__bar { flex: 1 1 auto; height: 4px; border-radius: 999px; background: rgba(120,120,128,.24); overflow: hidden; }
.ss-password__bar i { display: block; height: 100%; width: 0; background: #34c759; transition: width .18s ease; }
.ss-password__result { font-size: 12px; opacity: .8; }
`;

/**
 * 构建登录密码面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const apiReady = typeof lock?.hasPassword === "function";
    const statusValue = statusRow({
        label: t("ss.password.statusLabel", "密码"),
        value: apiReady
            ? (lock.hasPassword() ? t("ss.password.statusSet", "已设置") : t("ss.password.statusUnset", "未设置"))
            : t("ss.password.statusMissing", "无法读取密码状态。"),
    });

    const resultText = el("span", { class: "ss-password__result", text: "—" });
    const bar = el("i");

    const current = passwordField(t("ss.password.currentLabel", "当前密码"));
    const fresh = passwordField(t("ss.password.newPasswordLabel", "新密码"), t("ss.password.newPasswordHint", "至少 6 位。"));
    const again = passwordField(t("ss.password.confirmPasswordLabel", "确认密码"));

    /** 把强度读数刷新成文字 + 进度条（只看长度与字符类别，绝不回显字符）。 */
    function repaintStrength() {
        const score = strengthOf(fresh.input.value);
        bar.style.width = `${score * 25}%`;
        bar.style.background = score <= 1 ? "#ff453a" : score === 2 ? "#ffcc00" : "#34c759";
        resultText.textContent = fresh.input.value
            ? `${t("ss.password.strengthLabel", "强度")} · ${strengthLabelFor(score)}`
            : "—";
    }
    fresh.input.addEventListener("input", repaintStrength);
    repaintStrength();

    const saveButton = el("button", { class: "ss-btn ss-btn--primary", attrs: { type: "button" }, text: t("ss.password.saveBtn", "保存") });
    saveButton.addEventListener("click", () => run(saveButton, save));

    const clearButton = el("button", { class: "ss-btn ss-btn--danger", attrs: { type: "button" }, text: t("ss.password.clearBtn", "清除") });
    clearButton.addEventListener("click", () => run(clearButton, clear));

    /** 已有密码时才需要旧密码这一行，避免首次设置时被多问一道。 */
    function repaintCurrentVisibility() {
        const has = apiReady && lock.hasPassword();
        current.row.hidden = !has;
        clearButton.disabled = !has;
    }
    repaintCurrentVisibility();

    const form = el("div", { class: "ss-password__fields" },
        current.row, fresh.row, again.row,
        el("div", { class: "ss-password__strength" }, bar, resultText),
        el("div", { class: "ss-row__control" }, saveButton, clearButton)
    );

    // 保存或清除之后要把「是否已设密码」与旧密码行的可见性一起纠正过来。
    const repaintAll = () => {
        if (!apiReady) return;
        statusValue.setValue(lock.hasPassword() ? t("ss.password.statusSet", "已设置") : t("ss.password.statusUnset", "未设置"));
        repaintCurrentVisibility();
        current.input.value = "";
        fresh.input.value = "";
        again.input.value = "";
        repaintStrength();
    };

    /** 把提示写到结果里（不抛异常，避免口令经由错误日志外泄）。 @param {string} text 提示 */
    function say(text) { resultText.textContent = text; }

    async function save() {
        if (!apiReady) return say(t("ss.password.notReady", "密码功能不可用。"));
        const next = fresh.input.value;
        if (next.length < 6) return say(t("ss.password.tooShort", "至少 6 位。"));
        if (next !== again.input.value) return say(t("ss.password.mismatch", "两次输入不一致。"));

        if (lock.hasPassword()) {
            if (!current.input.value) return say(t("ss.password.needCurrent", "请填写当前密码。"));
            if (typeof lock.checkPassword === "function" && !(await lock.checkPassword(current.input.value))) {
                return say(t("ss.password.wrongCurrent", "当前密码不正确。"));
            }
            const ok = await window.__dialog?.confirm?.(
                t("ss.password.overwriteTitle", "覆盖现有密码？"),
                t("ss.password.overwriteMessage", "旧密码将立即失效。"),
                { okText: t("ss.password.overwriteOk", "覆盖"), cancelText: t("ss.password.overwriteCancel", "取消") }
            );
            if (!ok) return say("—");
        }

        const stored = await lock.setPassword(next);
        say(stored ? t("ss.password.saved", "密码已保存。") : t("ss.password.notReady", "密码功能不可用。"));
        if (stored) repaintAll();
    }

    async function clear() {
        if (!apiReady) return say(t("ss.password.notReady", "密码功能不可用。"));
        const ok = await window.__dialog?.confirm?.(
            t("ss.password.clearTitle", "清除登录密码？"),
            t("ss.password.clearMessage", "清除后锁屏不再需要密码。"),
            { okText: t("ss.password.clearBtn", "清除"), cancelText: t("ss.password.overwriteCancel", "取消") }
        );
        if (!ok) return say("—");
        lock.clearPassword?.();
        say(t("ss.password.cleared", "密码已清除。"));
        repaintAll();
    }

    /** 按钮忙状态包装：await 期间禁用，避免重复提交。 @param {HTMLElement} button 按钮 @param {Function} task 动作 */
    async function run(button, task) {
        if (button.disabled) return;
        button.disabled = true;
        try { await task(); } catch { say(t("ss.password.notReady", "密码功能不可用。")); } finally { button.disabled = false; }
    }

    return el("div", { class: "ss-pane ss-password" },
        group([
            controlSwitch("lock.requirePassword", {
                label: t("ss.password.requireSwitch", "解锁需要密码"),
                hint: t("ss.password.requireHint", "关闭后不会删除密码。"),
            }),
        ]),

        group([statusValue], { title: t("ss.password.statusGroup", "当前状态") }),

        group([form], { title: t("ss.password.formGroup", "设置密码") })
    );
}

/**
 * 建一个密码输入行（label + `<input type="password">` + 行内提示）。
 * @param {string} labelText 已经过 t() 的标签
 * @param {string} [hintText] 已经过 t() 的说明文字
 * @returns {{row:HTMLElement, input:HTMLInputElement, hint:HTMLElement}} 部件
 */
function passwordField(labelText, hintText = "") {
    const input = el("input", {
        class: "ss-input",
        attrs: { type: "password", autocomplete: "new-password", "aria-label": labelText },
    });
    const hint = el("p", { class: "ss-password__hint", text: hintText });
    const row = el("div", {},
        el("div", { class: "ss-password__input" }, el("span", { text: labelText }), input),
        hint
    );
    return { row, input, hint };
}

/**
 * 口令强度评分：长度 + 字符类别，0..4。只看统计特征，不比较任何历史值。
 * @param {string} value 输入内容
 * @returns {number} 分值
 */
function strengthOf(value) {
    const text = String(value || "");
    if (text.length < 6) return 0;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((re) => re.test(text)).length;
    const bonus = text.length >= 12 ? 1 : 0;
    return Math.min(4, Math.max(1, classes - 1 + bonus + (text.length >= 8 ? 1 : 0)));
}

/**
 * 强度的可读名。
 * @param {number} score 0..4
 * @returns {string} 文案
 */
function strengthLabelFor(score) {
    const labels = [
        t("ss.password.strength0", "太短"),
        t("ss.password.strength1", "较弱"),
        t("ss.password.strength2", "一般"),
        t("ss.password.strength3", "较强"),
        t("ss.password.strength4", "很强"),
    ];
    return labels[Math.min(4, Math.max(0, score))];
}

/** 密码面板不持有任何全局资源；输入值只活在 DOM 里，离开面板即被丢弃。 */
export function destroy() { }
