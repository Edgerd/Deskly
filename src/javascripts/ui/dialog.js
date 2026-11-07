/**
 * dialog.js — 全项目唯一的系统弹窗实现
 *
 * 内核与插件都经这里出弹窗：
 *   - 确认对话        dialog.confirm({...})            -> Promise<boolean>
 *   - 三选对话        dialog.choose({buttons, ...})     -> Promise<当前按钮 value>
 *   - 输入对话        dialog.prompt({...})              -> Promise<string|null>
 *   - 权限请求        dialog.permission({...})          -> Promise<"deny"|"once"|"always">
 *   - 进度与错误      dialog.progress({...}) / dialog.error({...})
 *
 * 约定：
 *   - 取消永远有明确返回值：确认对话 false、输入对话 null、权限请求 "deny"；
 *   - Esc、点遮罩、被新弹窗顶替，都走同一个取消值，不返回 undefined；
 *   - 危险操作（删除 / 覆盖）初始焦点落在安全选项上，Enter 因此也只走安全项；
 *   - 权限弹窗只允许内核弹出：调用栈上出现插件帧即按拒绝返回，插件不能自己造一枚
 *     「始终允许」的系统授权；
 *   - 动画只动 opacity / transform，遵守 data-reduce-motion；界面不使用 emoji。
 *
 * 视觉外壳沿用 swift-messagebox（毛玻璃与 Pop 关键帧由宿主提供），
 * 遮罩与进度条样式在本文件注入，不改动共享样式表。
 */

import { Z } from "../zindex.js";
import { i18n } from "../i18n.js";
import { callerFromStack } from "../caller-context.js";
import { GENERIC_APP_ICON } from "../paths.js";
import {
    DISMISS,
    PERMISSION,
    defaultFocusIndex,
    keyAction,
    nextFocusIndex,
    dismissOnOverlay,
    permissionValue,
    isPermissionCallerTrusted,
    promptValue,
} from "./dialog-model.js";

const STYLE_ID = "os-dialog-style";

/** 弹窗栈：只有最上层处理键盘，避免多个弹窗同时抢 Esc。 */
const stack = [];

/** 文本 slot 的转义（弹窗正文默认按纯文本渲染）。 */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
}

/** 纯文本 → HTML：转义后换行转 <br>。 */
function textToHtml(text) {
    return escapeHtml(text).replace(/\n/g, "<br>");
}

/** 模板占位替换：{app} / {capability} 这类键。 */
function format(template, vars = {}) {
    return String(template).replace(/\{(\w+)\}/g, (all, key) => (
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all
    ));
}

/** 当前语言取词，缺键回退中文。 */
function t(key, fallback) {
    return i18n.t(key, fallback);
}

/** 可选日志：log.js 尚未就绪时退回 console。 */
function log(level, message, data) {
    const logger = globalThis.__log;
    if (logger && typeof logger[level] === "function") logger[level]("kernel/dialog", message, data);
    else if (level === "warn" || level === "error") console[level](`[dialog] ${message}`, data || "");
}

/** 是否处于「减少动态效果」。 */
function reduceMotion() {
    return document.documentElement.getAttribute("data-reduce-motion") === "on";
}

/** 一次性注入遮罩与收尾样式（不改共享样式表，离线也能用）。 */
function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.os-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: ${Z.MODAL};
    background: rgba(0, 0, 0, 0.26);
    opacity: 0;
    transition: opacity .18s cubic-bezier(.32, .72, 0, 1);
}
.os-dialog-backdrop.is-open { opacity: 1; }
html[data-theme="dark"] .os-dialog-backdrop { background: rgba(0, 0, 0, 0.48); }
swift-messagebox.os-dialog {
    position: absolute;
    z-index: ${Z.MODAL + 1};
    transition: opacity .16s cubic-bezier(.32, .72, 0, 1);
}
swift-messagebox.os-dialog.is-closing { opacity: 0; }
.os-dialog-progress-track {
    width: 100%;
    height: 4px;
    margin-top: 12px;
    border-radius: 999px;
    background: rgba(120, 120, 128, 0.24);
    overflow: hidden;
}
.os-dialog-progress-bar {
    display: block;
    width: 20%;
    height: 100%;
    background: var(--accent, #007aff);
    border-radius: 999px;
    transform: translateX(-100%);
    animation: os-dialog-indeterminate 1.1s cubic-bezier(.32, .72, 0, 1) infinite;
}
@keyframes os-dialog-indeterminate {
    0% { transform: translateX(-110%); }
    100% { transform: translateX(560%); }
}
html[data-reduce-motion="on"] .os-dialog-backdrop,
html[data-reduce-motion="on"] swift-messagebox.os-dialog { transition: none; }
html[data-reduce-motion="on"] .os-dialog-progress-bar { animation: none; transform: none; width: 100%; }
`;
    document.head.appendChild(style);
}

/** 在可视区内居中（宿主是 absolute 定位，left/top 需要自己算）。 */
function centerBox(box) {
    box.style.left = `${Math.max(0, (document.body.clientWidth - box.clientWidth) / 2)}px`;
    box.style.top = `${Math.max(0, (document.body.clientHeight - box.clientHeight) / 2)}px`;
}

/**
 * 接管 swift-messagebox 的图标槽。
 *
 * 那张 <img> 在宿主的 shadow DOM 里，文档样式表够不到（alert.css 的同名规则实际从未命中）；
 * 而 webswift 的 setup 会在下一 tick 把 `img.src` 写成 `this.iconpath` —— 未赋值时是
 * 字符串 "undefined"，于是每个无图标弹窗都会留一张裂图（用户截图实锤）。
 * 这里在它的定时器之后执行：无图标就整张隐藏，有图标但加载失败就换通用占位。
 * @param {HTMLElement} box swift-messagebox 实例
 * @param {string} iconSrc 调用方声明的图标路径（已 trim，可能为空）
 * @returns {void}
 */
function bindDialogIcon(box, iconSrc) {
    setTimeout(() => {
        const img = box.shadowRoot?.querySelector("img[icon]");
        if (!img) return;
        if (!iconSrc) {
            img.style.display = "none";
            return;
        }
        let failed = false;
        img.addEventListener("error", () => {
            if (failed) return;
            failed = true;
            img.src = GENERIC_APP_ICON;
        });
    }, 0);
}

/**
 * 打开一个系统弹窗。
 *
 * @param {object} opts
 * @param {string} opts.title 标题（纯文本）
 * @param {string} [opts.message] 正文（默认纯文本；html=true 时按 HTML）
 * @param {boolean} [opts.html] 正文是否为 HTML
 * @param {string} [opts.icon] 图标路径（为空则宿主隐藏图标）
 * @param {Array<{label:string, value:any, style?:string, fromInput?:boolean}>} opts.buttons 按钮表
 * @param {any} [opts.dismissValue] 取消值（Esc / 遮罩 / 被顶替）
 * @param {object|null} [opts.input] 输入框配置 {value, placeholder, password, select}
 * @param {boolean} [opts.danger] 危险操作：初始焦点落在安全选项
 * @param {boolean} [opts.dismissible] 是否允许 Esc / 点遮罩关闭（进度弹窗置 false）
 * @param {string} [opts.role] ARIA 角色
 * @param {Function} [opts.onReady] 元素建好后回调（进度弹窗用来持有节点）
 * @returns {Promise<any>} 按钮 value 或 dismissValue
 */
function open(opts = {}) {
    const {
        title = "",
        message = "",
        html = false,
        icon = "",
        buttons = [],
        dismissValue = DISMISS,
        input = null,
        danger = false,
        dismissible = true,
        role = "alertdialog",
        onReady = null,
    } = opts;

    return new Promise((resolve) => {
        ensureStyle();
        const previousFocus = document.activeElement;
        const backdrop = document.createElement("div");
        backdrop.className = "os-dialog-backdrop";

        const box = document.createElement("swift-messagebox");
        box.className = "system-dialog os-dialog";
        box.setAttribute("role", role);
        box.setAttribute("aria-modal", "true");
        box.setAttribute("aria-labelledby", `os-dialog-title-${stack.length}`);
        const iconSrc = typeof icon === "string" ? icon.trim() : "";
        if (iconSrc) box.iconpath = iconSrc;
        bindDialogIcon(box, iconSrc);

        const titleP = document.createElement("p");
        titleP.setAttribute("slot", "title");
        titleP.id = `os-dialog-title-${stack.length}`;
        titleP.innerHTML = textToHtml(title);
        box.appendChild(titleP);

        let inputEl = null;
        if (input) {
            const wrap = document.createElement("div");
            wrap.setAttribute("slot", "text");
            if (message) {
                const mp = document.createElement("p");
                mp.innerHTML = html ? message : textToHtml(message);
                wrap.appendChild(mp);
            }
            inputEl = document.createElement("input");
            inputEl.type = input.password ? "password" : "text";
            inputEl.className = "alert-input";
            inputEl.value = input.value == null ? "" : String(input.value);
            if (input.placeholder) inputEl.setAttribute("placeholder", input.placeholder);
            inputEl.setAttribute("aria-label", input.placeholder || title);
            inputEl.setAttribute("autocomplete", input.password ? "new-password" : "off");
            wrap.appendChild(inputEl);
            box.appendChild(wrap);
        } else if (message) {
            const textP = document.createElement("p");
            textP.setAttribute("slot", "text");
            textP.innerHTML = html ? message : textToHtml(message);
            box.appendChild(textP);
        }

        const buttonEls = [];
        const makeButton = (b) => {
            const el = document.createElement("button");
            el.type = "button";
            el.className = b.style ? `alert-btn ${b.style}` : "alert-btn";
            el.textContent = b.label;
            el.addEventListener("click", () => settle(b.fromInput && inputEl ? inputEl.value : b.value));
            return el;
        };

        if (buttons.length === 1) {
            const only = makeButton(buttons[0]);
            only.setAttribute("slot", "button");
            box.appendChild(only);
            buttonEls.push(only);
        } else if (buttons.length > 1) {
            const wrap = document.createElement("div");
            wrap.className = "msgbox-btns";
            wrap.setAttribute("slot", "button");
            buttons.forEach((b) => {
                const el = makeButton(b);
                wrap.appendChild(el);
                buttonEls.push(el);
            });
            box.appendChild(wrap);
        }

        let closed = false;
        const cleanup = () => {
            window.removeEventListener("keydown", onKey, true);
            backdrop.remove();
            box.remove();
            const index = stack.indexOf(entry);
            if (index >= 0) stack.splice(index, 1);
            if (previousFocus && previousFocus.focus && previousFocus.isConnected) {
                try { previousFocus.focus(); } catch { /* 元素已不可聚焦，忽略 */ }
            }
        };

        const settle = (value) => {
            if (closed) return;
            closed = true;
            if (!reduceMotion()) {
                backdrop.classList.remove("is-open");
                box.classList.add("is-closing");
                setTimeout(cleanup, 160);
            } else {
                cleanup();
            }
            resolve(value);
        };

        /** 焦点是否落在本弹窗内（含输入框）。 */
        const focusInside = () => buttonEls.includes(document.activeElement)
            || (inputEl !== null && document.activeElement === inputEl);

        /** 当前焦点对应的按钮下标，-1 = 不在按钮上。 */
        const focusedIndex = () => {
            const idx = buttonEls.indexOf(document.activeElement);
            return idx >= 0 ? idx : -1;
        };

        const onKey = (e) => {
            if (stack[stack.length - 1] !== entry) return;
            if (!dismissible && e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            if (e.key === "Tab") {
                if (!dismissible && buttonEls.length === 0) {
                    e.preventDefault();
                    return;
                }
                const all = inputEl ? [...buttonEls, inputEl] : buttonEls;
                if (!all.length) return;
                const current = all.indexOf(document.activeElement);
                e.stopPropagation();
                e.preventDefault();
                const next = nextFocusIndex(current, all.length, e.shiftKey);
                try { all[next].focus(); } catch { /* 忽略不可聚焦项 */ }
                return;
            }
            if (!dismissible) return;
            const focusIndex = inputEl && document.activeElement === inputEl
                ? defaultFocusIndex(buttons, { danger })
                : focusedIndex();
            const action = keyAction(e.key, { buttons, focusIndex, danger });
            if (!action) return;
            e.stopPropagation();
            e.preventDefault();
            if (action.type === "dismiss") {
                settle(dismissValue);
                return;
            }
            const target = buttonEls[action.index];
            if (target) target.click();
        };
        window.addEventListener("keydown", onKey, true);

        const onBackdrop = (e) => {
            if (!dismissible) return;
            if (dismissOnOverlay(e.target, backdrop)) settle(dismissValue);
        };
        backdrop.addEventListener("mousedown", onBackdrop);

        const entry = {
            box,
            settle,
            isOpen: () => !closed,
        };
        stack.push(entry);

        backdrop.appendChild(box);
        document.body.appendChild(backdrop);
        requestAnimationFrame(() => {
            backdrop.classList.add("is-open");
            centerBox(box);
            const start = defaultFocusIndex(buttons, { danger });
            if (inputEl) {
                inputEl.focus();
                if (input.select !== false) {
                    try { inputEl.select(); } catch { /* 忽略 */ }
                }
            } else if (start >= 0 && buttonEls[start]) {
                buttonEls[start].focus();
            } else if (buttonEls[0]) {
                buttonEls[0].focus();
            }
        });

        if (typeof onReady === "function") onReady({ box, settle, backdrop });
    });
}

/* ── 对外的四类弹窗 ── */

/**
 * 信息提示：单按钮，错误动作用 error 而不是把提示涂红。
 * @param {{title:string, message?:string, okText?:string, icon?:string, html?:boolean}} opts
 * @returns {Promise<"ok">} 关闭后固定返回 "ok"
 */
export function alert({ title, message = "", okText, icon = "", html = false } = {}) {
    return open({
        icon,
        title,
        message,
        html,
        buttons: [{ label: okText || t("common.ok", "好"), value: "ok", style: "primary" }],
        dismissValue: "ok",
    });
}

/**
 * 错误提示：单按钮，红色表示这是失败而不是普通通知。
 * @param {{title:string, message?:string, okText?:string, icon?:string, html?:boolean}} opts
 * @returns {Promise<"ok">} 关闭后固定返回 "ok"
 */
export function error({ title, message = "", okText, icon = "", html = false } = {}) {
    return open({
        icon,
        title,
        message,
        html,
        buttons: [{ label: okText || t("common.ok", "好"), value: "ok", style: "destructive" }],
        dismissValue: "ok",
    }).then(() => "ok");
}

/**
 * 确认对话：取消 / 确认两项。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.message] 说明
 * @param {string} [opts.confirmText] 确认按钮文案
 * @param {string} [opts.cancelText] 取消按钮文案
 * @param {boolean} [opts.danger] 危险操作（删除 / 覆盖）：焦点初始落在「取消」
 * @param {string} [opts.icon] 图标
 * @param {boolean} [opts.html] 说明是否为 HTML
 * @returns {Promise<boolean>} 确认 true；取消 / Esc / 遮罩 false
 */
export function confirm({
    title,
    message = "",
    confirmText,
    cancelText,
    danger = false,
    icon = "",
    html = false,
} = {}) {
    const value = open({
        icon,
        title,
        message,
        html,
        danger,
        dismissValue: false,
        buttons: [
            { label: cancelText || t("common.cancel", "取消"), value: false, style: "secondary" },
            { label: confirmText || t("common.confirm", "确定"), value: true, style: danger ? "destructive" : "primary" },
        ],
    });
    return value.then((picked) => picked === true);
}

/**
 * 输入对话：取消 / 确定 + 文本框。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.message] 说明
 * @param {string} [opts.value] 初始值
 * @param {string} [opts.placeholder] 占位提示
 * @param {boolean} [opts.password] 口令框（不明文回显）
 * @param {string} [opts.confirmText] 确认按钮文案
 * @param {string} [opts.cancelText] 取消按钮文案
 * @returns {Promise<string|null>} 确定返回字符串；取消 / Esc / 遮罩返回 null
 */
export function prompt({
    title,
    message = "",
    value = "",
    placeholder = "",
    password = false,
    confirmText,
    okText,
    cancelText,
} = {}) {
    return open({
        title,
        message,
        dismissValue: DISMISS,
        input: { value, placeholder, password },
        buttons: [
            { label: cancelText || t("common.cancel", "取消"), value: DISMISS, style: "secondary" },
            { label: confirmText || okText || t("common.confirm", "确定"), value: "", style: "primary", fromInput: true },
        ],
    }).then(promptValue);
}

/**
 * 通用多选对话（旧 messageBox 的唯一实现）。
 * @param {object} opts 与 open() 相同
 * @returns {Promise<any>} 所点按钮的 value；取消返回 dismissValue
 */
export function choose(opts = {}) {
    return open(opts);
}

/**
 * 权限请求：拒绝 / 仅此一次 / 始终允许。
 *
 * 只能由内核调用（api-grants 的 ensurePermission）。插件直接 import 本函数时，
 * 调用栈里带着 mods/ 帧，一律按「拒绝」返回 —— 系统授权框不能由被授权方自己弹。
 *
 * @param {object} opts
 * @param {string} opts.appId 申请方插件 id（用于日志与审计）
 * @param {string} opts.appName 申请方显示名
 * @param {string} opts.permission 权限代号（内部 key，不翻译）
 * @param {string} [opts.label] 权限显示名
 * @param {string} [opts.description] 这个应用要拿什么、拿去干什么
 * @param {string} [opts.consequence] 不给会怎样
 * @param {string} [opts.icon] 申请方应用图标（由调用方解析，空则沿用宿主默认）
 * @returns {Promise<"deny"|"once"|"always">} 关闭 / Esc / 越权一律 "deny"
 */
export function permission({
    appId = "",
    appName = "",
    permission: perm = "",
    label = "",
    description = "",
    consequence = "",
    icon = "",
} = {}) {
    const caller = callerFromStack();
    if (!isPermissionCallerTrusted(caller)) {
        log("warn", `拒绝插件自行弹出权限授权框：${caller} -> ${perm}`);
        return Promise.resolve(PERMISSION.DENY);
    }
    if (!appId || !perm) {
        log("warn", "权限请求缺少 appId 或权限代号，按拒绝处理");
        return Promise.resolve(PERMISSION.DENY);
    }

    const title = format(
        t("dialog.permission.title", "{app} 想要使用「{capability}」"),
        { app: appName || appId, capability: label || perm },
    );
    const body = [
        description || t("dialog.permission.description", "这项能力会影响应用数据或其他应用的内容。"),
        consequence || t("dialog.permission.footer", "不允许时，这项功能无法使用，其他功能不受影响。"),
    ].filter(Boolean).join("\n");

    return open({
        title,
        message: body,
        icon,
        dismissValue: PERMISSION.DENY,
        buttons: [
            { label: t("dialog.permission.deny", "拒绝"), value: PERMISSION.DENY, style: "secondary" },
            { label: t("dialog.permission.once", "仅此一次"), value: PERMISSION.ONCE, style: "primary" },
            { label: t("dialog.permission.always", "始终允许"), value: PERMISSION.ALWAYS, style: "secondary" },
        ],
    }).then(permissionValue);
}

/**
 * 进度提示：不阻塞键盘以外的操作，只能由调用方 close()。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.message] 当前步骤说明
 * @returns {{update:(next:{message?:string})=>void, close:()=>void, fail:(text:string)=>void}} 控制器
 */
export function progress({ title, message = "" } = {}) {
    let messageP = null;
    let settle = null;

    open({
        title,
        message,
        dismissible: false,
        role: "dialog",
        buttons: [],
        onReady: ({ box, settle: closeDialog }) => {
            settle = closeDialog;
            const text = box.querySelector('p[slot="text"]');
            if (text) messageP = text;
            const track = document.createElement("div");
            track.className = "os-dialog-progress-track";
            track.setAttribute("slot", "text");
            const bar = document.createElement("i");
            bar.className = "os-dialog-progress-bar";
            track.appendChild(bar);
            box.appendChild(track);
        },
    });

    return {
        update(next = {}) {
            if (typeof next.message === "string" && messageP) {
                messageP.innerHTML = textToHtml(next.message);
            }
        },
        close() {
            if (settle) settle("done");
        },
        fail(text) {
            if (messageP && text) messageP.innerHTML = textToHtml(text);
        },
    };
}

/** 统一入口：内核与插件共用的同一份实现。 */
export const dialog = Object.freeze({
    alert,
    error,
    confirm,
    prompt,
    choose,
    permission,
    progress,
    PERMISSION,
    DISMISS,
});
