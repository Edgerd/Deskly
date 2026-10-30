/**
 * 系统弹窗模块
 * 基于 WebSwift 自定义元素 swift-messagebox 实现 macOS 风格弹窗。
 *
 * 接口：
 *   1. createAlert(icon, title, text, btn, command)
 *      —— 兼容旧调用的单按钮错误弹窗
 *   2. showMessageBox(opts) -> Promise
 *      —— 通用弹窗：多按钮 / Promise 化 / 纯文本自动转义
 *   3. window.__dialog —— 全局系统弹窗接口（alert / error / confirm / messageBox），
 *      供核心层与 mods 插件替代浏览器原生 alert/confirm
 *
 * 层级统一取自 zindex.js 的层级表（模态 9610：高于 Dock 9500 与启动台 9600）。
 */
import { Z } from "../zindex.js";

// ---- 工具 ----

// 纯文本 → HTML 转义，防 XSS
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
}

// 纯文本 → HTML：转义 + 换行转 <br>（替代原生 alert 的多行拼接）
function textToHtml(text) {
    return escapeHtml(text).replace(/\n/g, "<br>");
}

/** 把弹窗在可用区内水平垂直居中（swift-messagebox 的 left 是按自身默认宽度写死的） */
function centerBox(box) {
    box.style.left = `${Math.max(0, (document.body.clientWidth - box.clientWidth) / 2)}px`;
    box.style.top = `${Math.max(0, (document.body.clientHeight - box.clientHeight) / 2)}px`;
}

// ---- 兼容旧调用：单按钮错误弹窗 ----

/**
 * 创建错误弹窗
 * @param {string} icon 图标路径
 * @param {string} title 标题
 * @param {string} text 正文内容（支持 HTML）
 * @param {string} btn 按钮文字
 * @param {"close"|"closepage"} [command="close"] 点击按钮后的行为
 */
export function createAlert(icon, title, text, btn, command = "close") {
    // 元素必须是本次调用的局部变量：旧实现把它放在模块级 newAlert 上，
    // 于是两个弹窗并存时，前一个的按钮关掉的是后一个弹窗，前一个永远关不掉。
    const alertBox = document.createElement("swift-messagebox");
    alertBox.iconpath = icon;
    alertBox.style.zIndex = String(Z.MODAL);
    alertBox.setAttribute("role", "alertdialog");

    const slotP = (name, html) => {
        const p = document.createElement("p");
        p.setAttribute("slot", name);
        p.innerHTML = html;
        alertBox.appendChild(p);
    };
    slotP("title", title);
    slotP("text", text);

    const alertButton = document.createElement("button");
    alertButton.className = "alert-btn";
    alertButton.setAttribute("slot", "button");
    alertButton.textContent = btn;

    if (command === "closepage") {
        // 扩展新标签页里 window.close() 与 about:blank 都被限制，关闭不了页面；
        // 重载至少保证「关掉这个提示」在语义上可达。
        alertButton.onclick = () => window.location.reload();
    } else {
        // 直接移除而不是 display:none：隐藏的元素会永久留在 body 里累积，
        // 还会反复触发 dock.js 挂在 body 上的 MutationObserver。
        alertButton.onclick = () => alertBox.remove();
    }

    alertBox.appendChild(alertButton);
    document.body.appendChild(alertBox);
    requestAnimationFrame(() => {
        centerBox(alertBox);
        alertButton.focus();
    });
}

// ---- 通用弹窗（新接口） ----

// 当前打开的系统弹窗的收尾函数：新弹窗顶替旧弹窗时，
// 必须先把旧 Promise settle 掉，否则等待它的调用方会永远挂起。
let pendingSettle = null;

/**
 * 通用消息框
 * @param {Object} opts
 * @param {string} [opts.icon] 图标路径
 * @param {string} opts.title 标题（纯文本）
 * @param {string} opts.message 正文（纯文本，自动转义与换行；html=true 时按 HTML 渲染）
 * @param {boolean} [opts.html=false] message 是否按 HTML 渲染
 * @param {Array<{label:string, value:any, style?:("primary"|"secondary"|"destructive")}>}
 *        [opts.buttons] 按钮列表，默认单按钮 [{label:"好", value:"ok"}]
 * @param {any} [opts.dismissValue=null] Esc / 背景点击 / 被顶替时的 resolve 值
 * @returns {Promise<any>} 点击按钮后 resolve 该按钮的 value
 */
export function showMessageBox({
    icon,
    title,
    message,
    html = false,
    buttons = [{ label: "好", value: "ok", style: "primary" }],
    dismissValue = null,
    input = null,
} = {}) {
    return new Promise((resolve) => {
        if (pendingSettle) pendingSettle(dismissValue);

        const box = document.createElement("swift-messagebox");
        box.className = "system-dialog";
        box.style.zIndex = String(Z.MODAL);
        box.setAttribute("role", "alertdialog");
        box.setAttribute("aria-modal", "true");
        if (icon) box.iconpath = icon;

        const slotP = (name, content, asHtml) => {
            const p = document.createElement("p");
            p.setAttribute("slot", name);
            p.innerHTML = asHtml ? content : textToHtml(content);
            box.appendChild(p);
        };
        // title 按纯文本处理：旧实现传 isHtml=true，与自己的 JSDoc（「标题（纯文本）」）矛盾
        slotP("title", title, false);
        // input 非空时，文本槽内额外渲染一个输入框（用于 __dialog.prompt），
        // 主按钮点击时以输入框当前值 resolve，而非按钮静态 value。
        let inputEl = null;
        if (input) {
            const textWrap = document.createElement("div");
            textWrap.setAttribute("slot", "text");
            if (message) {
                const mp = document.createElement("p");
                mp.innerHTML = html ? message : textToHtml(message);
                textWrap.appendChild(mp);
            }
            inputEl = document.createElement("input");
            inputEl.type = "text";
            inputEl.className = "alert-input";
            inputEl.value = input.value || "";
            if (input.placeholder) inputEl.setAttribute("placeholder", input.placeholder);
            inputEl.setAttribute("aria-label", input.placeholder || title);
            textWrap.appendChild(inputEl);
            box.appendChild(textWrap);
        } else {
            slotP("text", message, html);
        }

        const settle = (value) => {
            if (box._dismiss) {
                window.removeEventListener("keydown", box._dismiss, true);
                box._dismiss = null;
            }
            if (pendingSettle === settle) pendingSettle = null;
            box.remove();
            resolve(value);
        };

        const makeButton = (b) => {
            const btn = document.createElement("button");
            // 风格类始终附加：Enter 的默认按钮查找靠 `.alert-btn.primary` 命中；
            // 旧写法对 primary 不加类，导致该选择器永远落空，confirm 里 Enter
            // 会落到第一个按钮（「取消」）而不是主按钮「确定」。
            btn.className = b.style ? `alert-btn ${b.style}` : "alert-btn";
            btn.textContent = b.label;
            btn.addEventListener("click", () => settle(b.fromInput && inputEl ? inputEl.value : b.value));
            return btn;
        };

        let firstButton;
        if (buttons.length === 1) {
            firstButton = makeButton(buttons[0]);
            firstButton.setAttribute("slot", "button");
            box.appendChild(firstButton);
        } else {
            const wrap = document.createElement("div");
            wrap.className = "msgbox-btns";
            wrap.setAttribute("slot", "button");
            buttons.forEach((b) => wrap.appendChild(makeButton(b)));
            box.appendChild(wrap);
            firstButton = wrap.querySelector("button");
        }

        // 键盘可达性：Esc 取消、Enter 走默认（第一个）按钮，并把焦点交给按钮，
        // 否则弹窗只能靠鼠标点按钮关闭，调用方还会一直等待。
        const onKey = (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                settle(dismissValue);
            } else if (e.key === "Enter") {
                e.stopPropagation();
                e.preventDefault();
                const primary = box.querySelector(".alert-btn.primary") || firstButton;
                if (primary) primary.click();
            }
        };
        box._dismiss = onKey;
        window.addEventListener("keydown", onKey, true);

        pendingSettle = settle;
        document.body.appendChild(box);
        requestAnimationFrame(() => {
            centerBox(box);
            if (inputEl) { inputEl.focus(); inputEl.select(); }
            else if (firstButton) firstButton.focus();
        });
    });
}

// ---- 全局系统弹窗接口 ----
// 所有模块 / 插件经 window.__dialog 调用，替代浏览器原生 alert/confirm。
// 挂载时机：本模块由 index.html 以 module script 加载（早于任何插件注入）。
window.__dialog = {
    /** 信息/提示弹窗（单按钮，蓝色） */
    alert(title, message, opts = {}) {
        return showMessageBox({
            icon: opts.icon,
            title,
            message,
            html: opts.html,
            buttons: [{ label: opts.okText || "好", value: "ok", style: "primary" }],
        });
    },
    /** 错误弹窗（单按钮，红色） */
    error(title, message, opts = {}) {
        return showMessageBox({
            icon: opts.icon,
            title,
            message,
            html: opts.html,
            buttons: [{ label: opts.okText || "好", value: "ok", style: "destructive" }],
        });
    },
    /** 确认弹窗（取消/确定）→ Promise<boolean> */
    confirm(title, message, opts = {}) {
        return showMessageBox({
            icon: opts.icon,
            title,
            message,
            html: opts.html,
            dismissValue: false,
            buttons: [
                { label: opts.cancelText || "取消", value: false, style: "secondary" },
                { label: opts.okText || "确定", value: true, style: "primary" },
            ],
        });
    },
    /** 通用消息框（完全自定义按钮） */
    messageBox: showMessageBox,
    /**
     * 输入弹窗（取消/确定 + 文本框）→ Promise<string|null>。
     * 统一替代浏览器原生 window.prompt（原生弹窗样式与系统弹窗不一致，
     * 且扩展环境下体验割裂）。取消 / Esc 返回 null，确定返回输入值。
     */
    prompt(title, message = "", opts = {}) {
        return showMessageBox({
            icon: opts.icon,
            title,
            message,
            dismissValue: null,
            input: { value: opts.value || "", placeholder: opts.placeholder },
            buttons: [
                { label: opts.cancelText || "取消", value: null, style: "secondary" },
                { label: opts.okText || "确定", value: "", style: "primary", fromInput: true },
            ],
        });
    },
};
