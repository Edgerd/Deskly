/**
 * dock/drag.js — 程序坞的指针拖拽：收藏区排序、拖出隐藏与影子反馈
 *
 * 为什么不用 HTML5 Drag & Drop：原生拖拽的指针形状由浏览器按 dropEffect 决定，
 * 无法稳定显示 macOS 的普通箭头；拖拽图像也不能自由跟随。这里改用 Pointer Events：
 * 影子元素自己跟手，光标全程是系统默认箭头，指针移出窗口也不会丢事件。
 *
 * 行为边界：
 * - 收藏区图标可在收藏区内重排，顺序由 onReorder 持久化；
 * - 拖出程序坞：未运行且非受保护的图标会从程序坞隐藏（onHide），播放噗散动画；
 * - 运行中的应用 / 受保护应用（访达、启动台）拖出后自动归位；
 * - 废纸篓不参与拖拽，但仍保留点击打开。
 */

import { Z } from "../zindex.js";

const DRAG_THRESHOLD = 5;
const OUTSIDE_MARGIN = 44;

/** 减少动态效果时不做粒子动画。 */
function prefersReducedMotion() {
    if (document.documentElement.dataset.reduceMotion === "on") return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * 在指定位置播放噗散粒子（macOS「从程序坞移除」的反馈）。
 * @param {number} x 视口横坐标
 * @param {number} y 视口纵坐标
 */
export function playPoof(x, y) {
    if (prefersReducedMotion()) return;
    const host = document.createElement("div");
    host.className = "dock-poof";
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    host.style.zIndex = String(Z.DOCK_DRAG);
    const count = 9;
    for (let i = 0; i < count; i += 1) {
        const dot = document.createElement("i");
        const angle = (i / count) * Math.PI * 2;
        const distance = 16 + Math.random() * 22;
        dot.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
        dot.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
        dot.style.setProperty("--size", `${5 + Math.random() * 5}px`);
        dot.style.setProperty("--delay", `${Math.random() * 40}ms`);
        host.appendChild(dot);
    }
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 620);
}

/**
 * 创建一个程序坞拖拽控制器。
 * @param {object} options 配置
 * @param {HTMLElement} options.dock 程序坞根元素
 * @param {HTMLElement} options.favoritesEl 收藏区容器
 * @param {function(): string} [options.getPosition] 返回 bottom / left / right
 * @param {function(string): boolean} [options.canDrag] 该应用是否允许拖拽
 * @param {function(string): boolean} [options.canHide] 该应用是否允许拖出隐藏
 * @param {function(string): boolean} [options.isRunning] 是否正在运行
 * @param {function(string): boolean} [options.isProtected] 是否受保护
 * @param {function(Array<string>): void} [options.onReorder] 收藏顺序变化
 * @param {function(string): void} [options.onPin] 非收藏图标拖进程序坞（固定到收藏区）
 * @param {function(string, number, number): boolean} [options.onHide] 拖出隐藏（返回 false 表示未移除）
 * @param {function(string, number, number): void} [options.onHideRejected] 拖出但被拒绝（运行中 / 受保护）
 * @param {function(HTMLElement): void} [options.onActivate] 点击激活
 * @param {function(boolean): void} [options.onDragStateChange] 拖拽开始 / 结束
 * @returns {{destroy: Function}}
 */
export function createDockDrag(options) {
    const dock = options.dock;
    const favoritesEl = options.favoritesEl;
    const getPosition = options.getPosition || (() => "bottom");
    const canDrag = options.canDrag || (() => true);
    const canHide = options.canHide || (() => false);
    const onReorder = options.onReorder || (() => { });
    const onPin = options.onPin || (() => { });
    const onHide = options.onHide || (() => false);
    const onHideRejected = options.onHideRejected || (() => { });
    const onActivate = options.onActivate || (() => { });
    const onDragStateChange = options.onDragStateChange || (() => { });

    let pending = null;
    let rafId = null;

    const appOf = (container) => container?.dataset?.app || "";

    function onPointerDown(e) {
        if (e.button !== 0) return;
        // 上一次手势可能因切标签页 / 指针捕获丢失而没有收到 pointerup：
        // 先收尾（会恢复被拖拽项的原始顺序），再开始新的手势。
        if (pending) cancelDrag();
        const container = e.target.closest?.(".container[data-app]");
        if (!container || !dock.contains(container)) return;
        const app = appOf(container);
        pending = {
            container,
            app,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            captured: false,
        };
        window.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("pointercancel", onPointerCancel, true);
        // 指针捕获可能被浏览器/系统抢走，窗口也可能失焦（Alt-Tab、切标签）。
        // 少一条收尾路径，dock 的 isDragging 就会一直为 true，之后所有重绘都被挂起。
        window.addEventListener("blur", onPointerCancel, true);
        document.addEventListener("visibilitychange", onVisibilityChange, true);
        document.addEventListener("keydown", onKeyDown, true);
    }

    function startDrag(e) {
        const state = pending;
        if (!state) return;
        const container = state.container;
        if (!canDrag(state.app) || !container.isConnected) return;

        const rect = container.getBoundingClientRect();
        state.dragging = true;
        state.startRect = rect;
        state.dockRect = dock.getBoundingClientRect();
        state.sourceParent = container.parentElement;
        state.snapshot = Array.from(favoritesEl.children).map((c) => appOf(c)).filter(Boolean);
        state.lastX = e.clientX;
        state.lastY = e.clientY;

        // 影子：克隆图标本体，去掉运行指示灯，保留角标。位置用 left/top 固定，
        // 跟手位移用 transform（影子挂在 body 上，不会干扰 Dock 的 backdrop-filter）。
        const ghost = container.cloneNode(true);
        ghost.removeAttribute("id");
        ghost.classList.add("dock-drag-ghost");
        ghost.classList.remove("dock-dragging");
        ghost.querySelectorAll(".light").forEach((node) => node.remove());
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        const ghostImg = ghost.querySelector("img");
        if (ghostImg) {
            ghostImg.style.width = "100%";
            ghostImg.style.height = "100%";
            ghostImg.style.opacity = "1";
            ghostImg.classList.add("is-loaded");
        }
        document.body.appendChild(ghost);
        state.ghost = ghost;

        container.classList.add("dock-dragging");
        document.body.classList.add("dock-dragging");
        try {
            container.setPointerCapture(e.pointerId);
            state.captured = true;
            container.addEventListener("lostpointercapture", onLostCapture);
        } catch (err) {
            // 某些环境（元素已脱离文档）不支持捕获，窗口级监听仍能收到事件。
        }
        onDragStateChange(true);
    }

    function scheduleFrame() {
        if (rafId) return;
        rafId = requestAnimationFrame(updateFrame);
    }

    function updateFrame() {
        rafId = null;
        const state = pending;
        if (!state || !state.dragging) return;
        const { container, ghost } = state;
        if (!container.isConnected || !ghost) {
            cancelDrag();
            return;
        }
        const x = state.lastX;
        const y = state.lastY;
        ghost.style.transform = `translate3d(${x - state.startX}px, ${y - state.startY}px, 0)`;
        const inside = isInsideDock(state, x, y);
        ghost.classList.toggle("is-outside", !inside);

        // 只有收藏区的图标在程序坞内拖动时参与排序；运行区 / 最近使用的临时图标
        // 拖进收藏区不会改变收藏顺序（固定请走右键菜单）。
        if (inside && container.parentElement === favoritesEl) {
            reorderToPointer(state, x, y);
        }
    }

    function reorderToPointer(state, x, y) {
        const axis = getPosition() === "left" || getPosition() === "right" ? "y" : "x";
        const pointer = axis === "y" ? y : x;
        const siblings = Array.from(favoritesEl.children).filter((c) => c !== state.container);
        let index = siblings.length;
        for (let i = 0; i < siblings.length; i += 1) {
            const rect = siblings[i].getBoundingClientRect();
            const mid = axis === "y" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
            if (pointer < mid) {
                index = i;
                break;
            }
        }
        const ref = siblings[index] || null;
        if (state.container.nextElementSibling !== ref) {
            favoritesEl.insertBefore(state.container, ref);
        }
    }

    function isInsideDock(state, x, y) {
        const r = state.dockRect;
        const pos = getPosition();
        if (pos === "left") {
            return x >= r.left - 16 && x <= r.right + OUTSIDE_MARGIN &&
                y >= r.top - 20 && y <= r.bottom + 20;
        }
        if (pos === "right") {
            return x >= r.left - OUTSIDE_MARGIN && x <= r.right + 16 &&
                y >= r.top - 20 && y <= r.bottom + 20;
        }
        return x >= r.left - 20 && x <= r.right + 20 &&
            y >= r.top - OUTSIDE_MARGIN && y <= r.bottom + 16;
    }

    function onPointerMove(e) {
        const state = pending;
        if (!state) return;
        if (!state.dragging) {
            const distance = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
            if (distance < DRAG_THRESHOLD) return;
            startDrag(e);
            if (!state.dragging) return;
        }
        e.preventDefault();
        state.lastX = e.clientX;
        state.lastY = e.clientY;
        scheduleFrame();
    }

    function onPointerUp(e) {
        const state = pending;
        if (!state) return;
        if (!state.dragging) {
            // 未超过阈值 = 点击。只有按下与松开都落在同一图标上才激活，
            // 避免「按下后拖到别处松开」误开应用。
            const rect = state.container.getBoundingClientRect();
            const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;
            const target = state.container;
            cleanup(false);
            if (inside && target.isConnected) onActivate(target);
            return;
        }
        finishDrag(e);
    }

    function finishDrag(e) {
        const state = pending;
        if (!state) return;
        const inside = isInsideDock(state, e.clientX, e.clientY);
        const app = state.app;
        const container = state.container;
        const wasFavorite = state.sourceParent === favoritesEl;

        // 必须在 cleanup 之前读取最终顺序：cleanup 会把 isDragging 置回 false，
        // dock 侧若在这期间补一次延后渲染，就会按旧数据把 DOM 顺序还原，
        // 之后再读 DOM 得到的永远是「没有变化」。
        const reorderedKeys = inside && wasFavorite && container.isConnected
            ? Array.from(favoritesEl.children).map((c) => appOf(c)).filter(Boolean)
            : null;

        if (!inside && !canHide(app)) restoreSnapshot(state);
        // 先更新数据，再让 cleanup 触发的重绘按新顺序落地。
        if (reorderedKeys) onReorder(reorderedKeys);
        else if (inside && !wasFavorite) onPin(app);
        cleanup(true);
        if (!inside) {
            if (canHide(app)) {
                playPoof(e.clientX, e.clientY);
                onHide(app, e.clientX, e.clientY);
            } else {
                onHideRejected(app, e.clientX, e.clientY);
            }
            return;
        }
    }

    function restoreSnapshot(state) {
        if (state.sourceParent !== favoritesEl || !Array.isArray(state.snapshot)) return;
        const byApp = new Map(Array.from(favoritesEl.children).map((c) => [appOf(c), c]));
        state.snapshot.forEach((app) => {
            const node = byApp.get(app);
            if (node) favoritesEl.appendChild(node);
        });
    }

    function cancelDrag() {
        const state = pending;
        if (!state) return;
        const wasDragging = state.dragging;
        if (wasDragging) restoreSnapshot(state);
        cleanup(wasDragging);
    }

    function onPointerCancel() {
        cancelDrag();
    }

    /** 指针捕获被系统/浏览器夺走时按取消收尾。 */
    function onLostCapture() {
        const state = pending;
        // releasePointerCapture 也会触发本事件；captured 已置 false 时说明是我们自己释放的。
        if (!state || !state.dragging || !state.captured) return;
        state.captured = false;
        cancelDrag();
    }

    function onVisibilityChange() {
        if (document.visibilityState === "hidden" && pending) cancelDrag();
    }

    function onKeyDown(e) {
        if (e.key === "Escape" && pending) {
            e.preventDefault();
            cancelDrag();
        }
    }

    /**
     * 收尾：移除监听、释放指针捕获、摘掉影子与拖拽类。
     * @param {boolean} wasDragging 是否进入过真正的拖拽
     */
    function cleanup(wasDragging) {
        const state = pending;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerUp, true);
        window.removeEventListener("pointercancel", onPointerCancel, true);
        window.removeEventListener("blur", onPointerCancel, true);
        document.removeEventListener("visibilitychange", onVisibilityChange, true);
        document.removeEventListener("keydown", onKeyDown, true);
        if (state) {
            if (state.captured) {
                state.captured = false;
                try { state.container.releasePointerCapture(state.pointerId); } catch (err) { /* 已释放 */ }
            }
            state.container.removeEventListener("lostpointercapture", onLostCapture);
            state.container.classList.remove("dock-dragging");
            if (state.ghost) state.ghost.remove();
        }
        document.body.classList.remove("dock-dragging");
        pending = null;
        if (wasDragging) {
            onDragStateChange(false);
            // 拖拽会抢走焦点，收尾后还给图标，键盘用户不至于掉回 body。
            const target = state && state.container;
            if (target && target.isConnected) {
                try { target.focus({ preventScroll: true }); } catch (err) { /* 不可聚焦 */ }
            }
        }
    }

    dock.addEventListener("pointerdown", onPointerDown);

    return {
        destroy() {
            cancelDrag();
            dock.removeEventListener("pointerdown", onPointerDown);
        },
    };
}
