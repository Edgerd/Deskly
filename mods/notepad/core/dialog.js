/**
 * dialog.js — 记事本弹窗适配层
 * 统一走系统 window.__dialog（core/ui/alert.js），替换浏览器原生 alert/confirm/prompt。
 * 业务文案由调用方经 i18n.t(key, fallback) 解析后传入；按钮沿用核心 common.* 语言键。
 *
 * __dialog 没有输入型弹窗，故用 messageBox 的 html 消息承载输入框，
 * 并在弹窗存活期间以 document 捕获监听读取用户输入。
 */

import { i18n } from '../../../src/javascripts/i18n.js';
import { escapeHtml } from './serializer.js';

const PROMPT_ATTR = 'data-np-prompt';

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
 * @param {string} label 提示正文（纯文本，内部转义）
 * @param {string} value 初始值
 * @returns {Promise<string|null>} 确定返回输入值，取消返回 null
 */
export function promptBox(title, label, value = '') {
    const d = dialog();
    if (!d || typeof d.messageBox !== 'function') return Promise.resolve(null);

    let captured = null;
    const onInput = (e) => {
        const el = e.target;
        if (el && el.getAttribute && el.getAttribute(PROMPT_ATTR) !== null) captured = el.value;
    };
    // 回车等价于点「确定」：按钮组里 primary 恒为最后一个
    const onKeydown = (e) => {
        if (e.key !== 'Enter') return;
        const el = e.target;
        if (!el || el.getAttribute(PROMPT_ATTR) === null) return;
        e.preventDefault();
        const btns = document.querySelectorAll('swift-messagebox.system-dialog .alert-btn');
        if (btns.length) btns[btns.length - 1].click();
    };

    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);

    /* message 走 html=true（原样 innerHTML），动态片段必须转义；
       value 是属性值，引号不转义就会被 `" autofocus onfocus="...` 之类的输入撕开属性。
       title/message 由核心 showMessageBox 按纯文本自行转义，这里不能再包一层。 */
    const messageHtml = `<span class="np-prompt-label">${escapeHtml(label)}</span>`
        + `<input class="np-prompt-input" ${PROMPT_ATTR}="1" type="text" value="${escapeHtml(value)}">`;

    return d.messageBox({
        title: String(title == null ? '' : title),
        html: true,
        message: messageHtml,
        buttons: [
            { label: i18n.t('common.cancel', '取消'), value: false, style: 'secondary' },
            { label: i18n.t('common.confirm', '确定'), value: true, style: 'primary' },
        ],
    }).then((confirmed) => {
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('keydown', onKeydown, true);
        if (!confirmed) return null;
        return captured === null ? String(value || '') : captured;
    });
}
