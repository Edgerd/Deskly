/**
 * scrollWatch.js — 滚动活动监听：data-scrollbars="when-scrolling" 的 CSS 信号源
 *
 * CSS 没有「正在滚动」的伪类，只能在 document 的捕获阶段接 scroll（scroll 不冒泡，
 * 冒泡阶段接不到元素滚动），给滚动中的元素挂 .scrolling-active，停手 HOLD_MS 后摘掉。
 * 一帧内的多次 scroll 用 rAF 合并成一次写入；元素与定时器记在 WeakMap 里，元素销毁即
 * 回收。零 import：当前档位直接读 <html> 的 data-scrollbars，不与 appearance.js 互依赖。
 */
const ACTIVE_CLASS = "scrolling-active", HOLD_MS = 900;
const timers = new WeakMap(), pending = new Set();
let frame = 0, unbind = null;

function flush() {
    frame = 0;
    pending.forEach((el) => {
        el.classList.add(ACTIVE_CLASS);
        clearTimeout(timers.get(el));
        timers.set(el, setTimeout(() => el.classList.remove(ACTIVE_CLASS), HOLD_MS));
    });
    pending.clear();
}

function onScroll(event) {
    if (document.documentElement.dataset.scrollbars !== "when-scrolling") return;
    pending.add(event.target instanceof Element ? event.target : document.documentElement);
    if (!frame) frame = requestAnimationFrame(flush);
}

/** 启动监听（幂等）。@returns {Function} 解绑函数 */
export function initScrollWatch() {
    if (unbind) return unbind;
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    unbind = () => {
        document.removeEventListener("scroll", onScroll, { capture: true });
        if (frame) cancelAnimationFrame(frame);
        pending.clear();
        unbind = null;
    };
    return unbind;
}
