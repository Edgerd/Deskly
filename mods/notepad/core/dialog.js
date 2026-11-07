/**
 * dialog.js — 记事本弹窗适配层
 * 统一走系统 window.__dialog（唯一实现为 src/javascripts/ui/dialog.js）。
 * 业务文案由调用方经 i18n.t(key, fallback) 解析后传入；按钮沿用核心 common.* 语言键。
 *
 * 输入型弹窗直接用系统 prompt（支持初始值、占位提示与口令框），
 * 不再用 html 消息自造输入框。
 */

import { i18n } from '../../../src/javascripts/i18n.js';

/** 系统弹窗不可用（核心未加载）时静默降级，避免记事本整体报错 */
function dialog() {
    return window.__dialog || null;
}

export function alertBox(title, message, opts) {
    const d = dialog();
    if (!d) return Promise.resolve(null);
    return d.alert(title, message, opts);
}

export function errorBox(title, message) {
    const d = dialog();
    if (!d) return Promise.resolve(null);
    return d.error(title, String(message == null ? '' : message));
}

export function confirmBox(title, message, opts) {
    const d = dialog();
    if (!d) return Promise.resolve(null);
    return d.confirm(title, message, opts);
}

/**
 * 输入型弹窗（替代原生 prompt）。
 * @param {string} title 标题（已解析文案）
 * @param {string} label 提示正文（纯文本）
 * @param {string} value 初始值
 * @returns {Promise<string|null>} 确定返回输入值，取消返回 null
 */
export function promptBox(title, label, value = '') {
    const d = dialog();
    if (!d || typeof d.prompt !== 'function') return Promise.resolve(null);
    return d.prompt(title, label, {
        value,
        okText: i18n.t('common.confirm', '确定'),
        cancelText: i18n.t('common.cancel', '取消'),
    });
}
