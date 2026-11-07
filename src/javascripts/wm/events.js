/**
 * wm/events.js — `window:*` 窗口事件总线（NW-8 / WAPI-03）
 *
 * 窗口层此前零事件：插件想知道「窗口被关了 / 被最小化了 / 进全屏了」只能轮询
 * stateOf。这里补上 12 个主题的统一派发契约：
 *   window:open / close / focus / blur / resize / move / minimize / restore
 *   window:fullscreen / zoom / tile / level-change
 *
 * 约定（与 03 报告 NW-8 一致）：
 * - 统一走 document 上的具名 CustomEvent（bubbles:true），与 Deskly.bus 同形状，
 *   插件用 Deskly.windows.on 订阅（os-api 按 scope 过滤），内核可直接 addEventListener。
 * - detail 形状固定：{ id, appId, pluginId, frame: {x,y,w,h}, state: stateOf 快照 }。
 *   state 的具体字段由 facade 的 detailProvider 提供（避免本模块反向依赖状态层）。
 * - 频度：拖动/缩放**过程中不逐帧发**，pointerup 收尾时发一次（move / resize）。
 * - 事件是附加通道：丢了不影响窗口本体操作，派发处绝不允许因事件抛错而中断流程。
 */

/** 全部主题名（订阅侧按它校验拼写）。 */
export const WINDOW_EVENTS = Object.freeze([
    "window:open",
    "window:close",
    "window:focus",
    "window:blur",
    "window:resize",
    "window:move",
    "window:minimize",
    "window:restore",
    "window:fullscreen",
    "window:zoom",
    "window:tile",
    "window:level-change",
]);

/** detail 由 facade 注入（它才拿得到 stateOf 与 frameOf），本模块保持零依赖。 */
let detailProvider = null;

/**
 * 注册 detail 构造器。facade 在模块求值时调用一次。
 * @param {(el: HTMLElement) => object} fn
 */
export function setWindowDetailProvider(fn) {
    detailProvider = fn;
}

/**
 * 派发一条窗口事件。任何一步出错都只记日志，绝不打断调用方的窗口操作。
 * @param {string} topic 不带 `window:` 前缀的主题名
 * @param {HTMLElement} el 窗口根元素
 */
export function emitWindowEvent(topic, el) {
    if (!el || !topic) return;
    try {
        const detail = detailProvider ? detailProvider(el) : { id: el.id || null };
        document.dispatchEvent(new CustomEvent(`window:${topic}`, { detail, bubbles: true }));
    } catch (err) {
        console.warn(`[wm] 事件 window:${topic} 派发失败:`, err);
    }
}
