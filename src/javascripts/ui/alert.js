/**
 * 系统弹窗模块 —— 兼容层
 *
 * 实现已经收敛到 ui/dialog.js（唯一一份弹窗实现）。本文件只保留旧导出与
 * window.__dialog 门面，避免现有调用点（内核与 mods）二次改签名；
 * 新代码请直接 import { dialog } from "./ui/dialog.js" 或走 Deskly.ui.dialog。
 *
 * 兼容接口：
 *   1. createAlert(icon, title, text, btn, command)
 *   2. showMessageBox(opts) -> Promise
 *   3. window.__dialog —— alert / error / confirm / messageBox / prompt
 *
 * 权限授权框不在门面上：它只能由 api-grants 经 dialog.permission 弹出，
 * 插件无法通过 window.__dialog 伪造「始终允许」。
 */

import { dialog } from "./dialog.js";

/** 单按钮错误弹窗（旧调用）。text 历来按 HTML 渲染。 */
export function createAlert(icon, title, text, btn, command = "close") {
    const closed = dialog.alert({
        icon,
        title,
        message: text,
        html: true,
        okText: btn,
    });
    if (command === "closepage") {
        // 扩展新标签页里 window.close() 与 about:blank 都被限制，
        // 重载至少保证「关掉这个提示」在语义上可达。
        return closed.then(() => window.location.reload());
    }
    return closed;
}

/**
 * 通用消息框（旧调用）。
 * @param {object} opts 与 dialog.choose 相同
 * @returns {Promise<any>} 所点按钮的 value；取消返回 dismissValue
 */
export function showMessageBox(opts = {}) {
    const {
        buttons = [{ label: "好", value: "ok", style: "primary" }],
        ...rest
    } = opts;
    return dialog.choose({ ...rest, buttons });
}

// ---- 全局系统弹窗门面 ----
// 所有模块 / 插件经 window.__dialog 调用，替代浏览器原生 alert/confirm。
// 挂载时机：本模块由 index.html 以 module script 加载（早于任何插件注入）。
window.__dialog = {
    /** 信息/提示弹窗（单按钮，蓝色） */
    alert(title, message, opts = {}) {
        return dialog.alert({
            icon: opts.icon,
            title,
            message,
            html: opts.html,
            okText: opts.okText,
        });
    },
    /** 错误弹窗（单按钮，红色） */
    error(title, message, opts = {}) {
        return dialog.error({
            icon: opts.icon,
            title,
            message,
            html: opts.html,
            okText: opts.okText,
        });
    },
    /** 确认弹窗（取消/确定）→ Promise<boolean>；dismissValue 恒为 false */
    confirm(title, message, opts = {}) {
        return dialog.confirm({
            icon: opts.icon,
            title,
            message,
            html: opts.html,
            confirmText: opts.okText,
            cancelText: opts.cancelText,
            danger: opts.danger === true,
        });
    },
    /** 通用消息框（完全自定义按钮） */
    messageBox: showMessageBox,
    /** 输入弹窗（取消/确定 + 文本框）→ Promise<string|null> */
    prompt(title, message = "", opts = {}) {
        return dialog.prompt({
            icon: opts.icon,
            title,
            message,
            value: opts.value,
            placeholder: opts.placeholder,
            password: opts.password === true,
            confirmText: opts.okText,
            cancelText: opts.cancelText,
        });
    },
};
