/**
 * dialog-model.js — 弹窗决策的纯函数层
 *
 * 与 dialog.js 分开是为了能在 Node 里直接 import：取消约定、危险操作的默认焦点、
 * Enter / Esc / Tab 的落点、权限三选项的取值、插件越权判定，全部不依赖 DOM。
 * dialog.js 只负责把这里算出的索引套到真实元素上；两边共用一份规则，不会各写一套。
 */

/** 取消值：输入对话取消时 resolve 这个值（不是 undefined，调用方不必猜）。 */
export const DISMISS = null;

/** 权限请求的三个返回值。关闭 / Esc / 点遮罩一律落 DENY。 */
export const PERMISSION = Object.freeze({
    DENY: "deny",
    ONCE: "once",
    ALWAYS: "always",
});

/**
 * 找出「安全选项」的下标：取消 / 拒绝优先，其次次按钮。
 * 找不到时返回 0（第一个按钮），保证永远有一个落点。
 * @param {Array<{value?:any, style?:string}>} buttons 按钮表
 * @returns {number} 下标
 */
export function safeIndex(buttons) {
    if (!Array.isArray(buttons) || buttons.length === 0) return 0;
    for (let i = 0; i < buttons.length; i += 1) {
        const b = buttons[i];
        if (!b) continue;
        if (b.value === false || b.value === "cancel" || b.value === "deny") return i;
    }
    for (let i = 0; i < buttons.length; i += 1) {
        if (buttons[i] && buttons[i].style === "secondary") return i;
    }
    return 0;
}

/**
 * 初始焦点：危险操作必须落在安全选项上，其余落主按钮。
 * @param {Array<object>} buttons 按钮表
 * @param {{danger?:boolean}} [opts] 选项
 * @returns {number} 下标
 */
export function defaultFocusIndex(buttons, { danger = false } = {}) {
    if (!Array.isArray(buttons) || buttons.length === 0) return -1;
    if (danger) return safeIndex(buttons);
    const primary = buttons.findIndex((b) => b && b.style === "primary");
    return primary >= 0 ? primary : 0;
}

/**
 * Tab / Shift+Tab 的循环目标。
 * @param {number} current 当前焦点下标
 * @param {number} length 可聚焦项数量
 * @param {boolean} shift 是否反向
 * @returns {number} 下一个下标（空表返回 -1）
 */
export function nextFocusIndex(current, length, shift = false) {
    if (!length || length < 1) return -1;
    if (current < 0 || current >= length) return shift ? length - 1 : 0;
    return shift ? (current - 1 + length) % length : (current + 1) % length;
}

/**
 * 键盘动作：Esc 取消，Enter 点当前焦点按钮（焦点不在弹窗内时落默认按钮）。
 * 危险操作把焦点放在安全项上，因此 Enter 也只会走安全项。
 * @param {string} key 按键名
 * @param {{buttons:Array<object>, focusIndex?:number, danger?:boolean}} ctx 上下文
 * @returns {{type:"dismiss"}|{type:"choose", index:number}|null} 动作
 */
export function keyAction(key, { buttons = [], focusIndex = -1, danger = false } = {}) {
    if (key === "Escape") return { type: "dismiss" };
    if (key === "Enter") {
        const valid = focusIndex >= 0 && focusIndex < buttons.length;
        const index = valid ? focusIndex : defaultFocusIndex(buttons, { danger });
        return index >= 0 ? { type: "choose", index } : null;
    }
    return null;
}

/**
 * 遮罩点击是否应当取消：只有点在遮罩本身（不是弹窗内容）才算。
 * @param {EventTarget|null} target 事件目标
 * @param {EventTarget|null} overlay 遮罩节点
 * @returns {boolean} 是否按取消处理
 */
export function dismissOnOverlay(target, overlay) {
    return Boolean(target && overlay && target === overlay);
}

/**
 * 权限草稿的三个按钮取值归一：未知值一律按拒绝处理。
 * @param {any} value 按钮返回值
 * @returns {"deny"|"once"|"always"} 归一结果
 */
export function permissionValue(value) {
    if (value === PERMISSION.ONCE) return PERMISSION.ONCE;
    if (value === PERMISSION.ALWAYS) return PERMISSION.ALWAYS;
    return PERMISSION.DENY;
}

/**
 * 权限弹窗只允许内核弹：栈上出现任何插件帧（非 null）即视为越权。
 * 插件自己传 appId 也不放行——「始终允许」必须由系统代插件询问。
 * @param {string|null} caller 调用栈识别出的插件 id
 * @returns {boolean} 是否可信
 */
export function isPermissionCallerTrusted(caller) {
    return caller === null || caller === undefined;
}

/**
 * 输入对话的返回值归一：取消 / 关闭 → null，确定 → 字符串。
 * @param {any} value 按钮回传值
 * @returns {string|null} 归一结果
 */
export function promptValue(value) {
    return typeof value === "string" ? value : DISMISS;
}
