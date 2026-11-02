/**
 * trafficLights.js — 红绿灯（窗口控制按钮）组件：几何与状态的唯一实现
 *
 * 为什么要有这个组件：S1 之前核心只给圆点尺寸不给容器定位（唯一的容器规则
 * `.window > .left .topbar .wintools` 无任何 DOM 命中，是死规则），11 个界面
 * 各自手写 `.wintools` 标记 + 各自声明 display/gap/偏移，左内缩漂出 7 种、
 * 上偏移 3 种，禁用位 `.gray` 更因缺 box-sizing 而比三色点大 1px。
 * S1 把数值收敛成 --traffic-* 令牌；S2 进一步把「标记」收进组件：
 * 应用只写一个 <deskly-traffic-lights> 标签，圆点结构、符号、状态机
 * 全部封在 Shadow DOM 里 —— 应用样式表在结构上就再也碰不到它们，
 * 漂移不再可能（而不是靠"大家都记得写对"）。
 *
 * 用法（应用 index.html，推荐把灯放进标题栏）：
 *   <header class="app-titlebar" data-titlebar>
 *     <deskly-traffic-lights class="wintools" placement="titlebar"></...>
 *   </header>
 *   <deskly-traffic-lights class="wintools" overlay></...>                      无标题栏界面，悬浮定位
 *   <deskly-traffic-lights class="wintools" variant="dialog"></...>             对话框：最小化/缩放禁用
 *   <deskly-traffic-lights class="wintools" no-zoom></...>                      单独禁用某一颗
 *
 * 位置由组件自己保证：placement="titlebar"（缺省）时读取父级 padding-left，
 * 把 margin-left 补到 --traffic-inset，应用不再需要写「减去自身 padding」的补偿；
 * 这正是手册窗口此前漂在标题栏上方、左内缩为 0 的根因。
 *
 * 动作以 ACTION_EVENT 冒泡给宿主所在窗口，由 window.js 统一接管；
 * 组件自身不碰窗口状态，避免与 window.js 形成第二套实现。
 *
 * 约束：
 * - MV3 CSP 禁止内联脚本/内联事件，全部交互在 JS 里绑定；
 * - 导入本模块的说明符一律不带 ?v=（带查询串会被当作第二个模块重复求值）；
 * - 组件内部不使用 transform 动画（祖先标题栏常带 backdrop-filter，
 *   亚克力禁忌见 dock.css / system-settings/style.css 的固化注释）。
 */

export const TAG = "deskly-traffic-lights";
export const ACTION_EVENT = "deskly:window-action";

// 三颗按钮的固定语义顺序：关闭 / 最小化 / 缩放
const BUTTONS = Object.freeze([
    Object.freeze({ action: "close", cls: "close", label: "关闭", glyph: "close" }),
    Object.freeze({ action: "minimize", cls: "minimize", label: "最小化", glyph: "minimize" }),
    Object.freeze({ action: "zoom", cls: "zoom", label: "缩放", glyph: "zoom" }),
]);

/* 符号用 inline SVG + viewBox，尺寸随 --traffic-size 线性缩放。
   旧实现是 ::before/::after 边框拼三角，绿三角写死 top/right:2.5px
   （那是"12px 减掉 0.5px×2 边框后再居中"手算出来的），改直径就错位。
   下面全是开发者写死的常量，且只按 BUTTONS 里固定的 glyph 键查表取用，
   不接收任何外部/用户数据，故直接注入 shadow 是安全的。 */
const GLYPHS = Object.freeze({
    close: '<path d="M4.15 4.15 7.85 7.85M7.85 4.15 4.15 7.85" stroke="var(--traffic-glyph-close)" stroke-width="1.2" stroke-linecap="round"/>',
    minimize: '<path d="M3.9 6h4.2" stroke="var(--traffic-glyph-min)" stroke-width="1.2" stroke-linecap="round"/>',
    zoom: '<path d="M4.6 7.4V4.6h2.8zM7.4 4.6v2.8H4.6z" fill="var(--traffic-glyph-zoom)"/>',
});

const SHADOW_CSS = `
:host {
  display: inline-flex;
  align-items: center;
  gap: var(--traffic-gap, 8px);
  flex: 0 0 auto;
}
.dot {
  width: var(--traffic-size, 12px);
  height: var(--traffic-size, 12px);
  border-radius: 50%;
  box-sizing: border-box;
  border: solid 0.5px var(--traffic-ring, rgba(0,0,0,.2));
  position: relative;
  /* shadow DOM 里的元素吃不到外层那条 cursor 规则（选择器穿不过 shadow 边界），
     但自定义属性会继承进来，所以这里引用同一个令牌，而不是写死关键字——
     写死 default 会让三颗灯变回宿主机原生箭头。macOS 的红绿灯本来也是箭头，不是手型。 */
  cursor: var(--deskly-cursor, default);
  flex: 0 0 auto;
  padding: 0;
  margin: 0;
  background: var(--traffic-disabled, rgba(0,0,0,.1));
  transition: filter .15s ease, background-color .15s ease;
  -webkit-user-select: none;
          user-select: none;
}
.dot.close { background: var(--traffic-close, #ff5f57); }
.dot.minimize { background: var(--traffic-minimize, #febc2e); }
.dot.zoom { background: var(--traffic-zoom, #28c840); }
.dot svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity .15s ease;
  pointer-events: none;
}
/* macOS：悬停按钮组时三颗符号同时显形，而不是只显 hovered 那一颗 */
:host(:not(.inactive):not([disabled])):hover .dot:not(.is-off) svg { opacity: 1; }
:host(:not(.inactive)) .dot:not(.is-off):hover { filter: brightness(1.08); }
:host(:not(.inactive)) .dot:not(.is-off):active { filter: brightness(0.9); }
/* 非活跃窗口：三颗统一灰、不出符号、不提亮（macOS 行为） */
:host(.inactive) .dot { background: var(--traffic-inactive, #d4d4d4); }
:host(.inactive) .dot svg { opacity: 0 !important; }
/* 能力禁用：恒定灰 + 不吃指针 */
.dot.is-off { pointer-events: none; }
:host(:not(.inactive)) .dot.is-off { background: var(--traffic-disabled, rgba(0,0,0,.1)); }
.dot:focus-visible { outline: 2px solid var(--accent, #0a82ff); outline-offset: 2px; }
`;

/**
 * 生成一个游离的红绿灯宿主（供 mount 复用，也便于测试直接量几何）。
 * @param {{variant?: 'window'|'dialog', noMinimize?: boolean, noZoom?: boolean,
 *          overlay?: boolean, placement?: 'titlebar'|'overlay'}} [opts]
 * @returns {HTMLElement}
 */
export function createTrafficLights(opts = {}) {
    const host = document.createElement(TAG);
    host.className = "wintools";
    const placement = opts.placement || (opts.overlay ? "overlay" : "titlebar");
    host.setAttribute("placement", placement);
    if (placement === "overlay") host.setAttribute("overlay", "");
    if (opts.variant) host.setAttribute("variant", opts.variant);
    if (opts.noMinimize || opts.variant === "dialog") host.setAttribute("no-minimize", "");
    if (opts.noZoom || opts.variant === "dialog") host.setAttribute("no-zoom", "");
    return host;
}

/**
 * 取挂载锚点：显式元素 > 选择器 > 窗口内第一个 [data-titlebar]。
 * @param {HTMLElement} win 窗口根元素
 * @param {HTMLElement|string} [anchor]
 * @returns {HTMLElement|null}
 */
function resolveAnchor(win, anchor) {
    if (anchor && anchor.nodeType === 1) return anchor;
    if (typeof anchor === "string") {
        try { return win.querySelector(anchor); } catch { return null; }
    }
    return win.querySelector("[data-titlebar]");
}

/**
 * 把红绿灯挂到指定标题栏（推荐入口，幂等）。
 *
 * 与 mountTrafficLights 的区别只在「挂哪儿」：本函数会把灯插成标题栏的第一个
 * 子节点，让标题栏的 flex 布局负责垂直居中；找不到标题栏（或显式要求 overlay）
 * 才退回窗口根并悬浮定位。已有的 overlay 灯不会被误搬进标题栏。
 * @param {HTMLElement} win 窗口根元素
 * @param {{anchor?: HTMLElement|string, placement?: 'titlebar'|'overlay',
 *          variant?: string, noMinimize?: boolean, noZoom?: boolean, overlay?: boolean}} [opts]
 * @returns {HTMLElement|null} 宿主；窗口不是 .window 时返回 null
 */
export function attachTrafficLights(win, opts = {}) {
    if (!win || !win.classList || !win.classList.contains("window")) return null;
    const anchor = resolveAnchor(win, opts.anchor);
    let host = getTrafficLights(win);
    const current = host && (host.getAttribute("placement") || (host.hasAttribute("overlay") ? "overlay" : ""));
    let placement = opts.placement
        || (current === "overlay" ? "overlay" : "")
        || (opts.overlay ? "overlay" : "titlebar");
    // 声明了 titlebar 但窗口没有标题栏：悬浮定位至少不会把灯排成独立一行。
    if (placement === "titlebar" && !anchor) placement = "overlay";
    if (!host) host = createTrafficLights({ ...opts, placement });

    host.setAttribute("placement", placement);
    if (placement === "overlay") host.setAttribute("overlay", "");
    else host.removeAttribute("overlay");
    if (opts.variant) host.setAttribute("variant", opts.variant);
    if (opts.noMinimize || opts.variant === "dialog") host.setAttribute("no-minimize", "");
    if (opts.noZoom || opts.variant === "dialog") host.setAttribute("no-zoom", "");

    const parent = placement === "overlay" || !anchor ? win : anchor;
    if (host.parentElement !== parent || parent.firstElementChild !== host) {
        parent.insertBefore(host, parent.firstChild);
    }
    return host;
}

/**
 * 兼容入口：window-manager 在第三方窗口缺灯时调用。
 * @param {HTMLElement} win 窗口根元素
 * @param {object} [opts] 同 attachTrafficLights
 * @returns {HTMLElement|null}
 */
export function mountTrafficLights(win, opts = {}) {
    return attachTrafficLights(win, opts);
}

/**
 * 取窗口自己的红绿灯宿主（:scope 限定，避免命中嵌套窗口或菜单栏）。
 * @param {HTMLElement} win
 * @returns {HTMLElement|null}
 */
export function getTrafficLights(win) {
    if (!win || !win.querySelector) return null;
    return win.querySelector(":scope > " + TAG) || win.querySelector(TAG);
}

/**
 * 按能力开关熄灭个别按钮。刻意"只能收紧、不能放宽"：
 * 用属性（no-minimize / no-zoom / no-close）表达外部能力，让组件内部的
 * _disabledFor 成为唯一判定处，这样 manifest 声明与标记上的 variant="dialog"
 * 自然求交，而不会出现"清单说可最小化"把对话框的禁用位又点亮的分叉。
 * @param {HTMLElement} win
 * @param {{close?: boolean, minimize?: boolean, zoom?: boolean}} caps
 */
export function setTrafficLightsEnabled(win, caps = {}) {
    const host = getTrafficLights(win);
    if (!host) return;
    if (caps.close === false) host.setAttribute("no-close", "");
    if (caps.minimize === false) host.setAttribute("no-minimize", "");
    if (caps.zoom === false) host.setAttribute("no-zoom", "");
}

/**
 * 切换活跃/非活跃外观（焦点灰化）。只做类名切换，不触发布局。
 * @param {HTMLElement} win
 * @param {boolean} active
 */
export function setTrafficLightsActive(win, active) {
    const host = getTrafficLights(win);
    if (host && host.setActive) host.setActive(!!active);
}

/** 幂等注册自定义元素。标签名刻意避开 swift-window（webswift.js 已占用）。 */
export function defineTrafficLights() {
    if (typeof customElements === "undefined" || customElements.get(TAG)) return;

    class DesklyTrafficLights extends HTMLElement {
        constructor() {
            super();
            this._root = this.attachShadow({ mode: "open" });
            const style = document.createElement("style");
            style.textContent = SHADOW_CSS;
            this._root.appendChild(style);
            this._dots = {};
            for (const b of BUTTONS) {
                const dot = document.createElement("button");
                dot.type = "button";
                dot.className = "dot " + b.cls;
                dot.dataset.action = b.action;
                dot.setAttribute("role", "button");
                dot.setAttribute("aria-label", b.label);
                dot.tabIndex = 0;
                dot.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true">' + GLYPHS[b.glyph] + "</svg>";
                const fire = (e) => this._fire(b.action, e);
                dot.addEventListener("click", fire);
                // 绿键右键 = 「排列窗口」菜单。菜单本体由 window.js 负责（它才知道桌面
                // 可用区与层级），组件只上报坐标。必须在这里监听：shadow 外的宿主拿到的
                // e.target 已被重定向为宿主，分辨不出是哪一颗。
                if (b.action === "zoom") {
                    dot.addEventListener("contextmenu", (e) => {
                        if (this._disabledFor("zoom")) return;
                        e.preventDefault();
                        e.stopPropagation();
                        this.dispatchEvent(new CustomEvent(ACTION_EVENT, {
                            bubbles: true,
                            composed: true,
                            detail: { action: "arrange", clientX: e.clientX, clientY: e.clientY },
                        }));
                    });
                }
                // 键盘激活：Enter 与 Space（Space 需阻止页面滚动默认行为）
                dot.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                        e.preventDefault();
                        this._fire(b.action, e);
                    }
                });
                this._root.appendChild(dot);
                this._dots[b.action] = dot;
            }
        }

        connectedCallback() {
            this._syncFromAttrs();
            this._syncPlacement();
        }

        static get observedAttributes() {
            return ["no-minimize", "no-zoom", "no-close", "variant", "disabled", "overlay", "placement"];
        }

        attributeChangedCallback() {
            this._syncFromAttrs();
            this._syncPlacement();
        }

        /**
         * 标题栏形态的左内缩：组件自己把「到窗口左缘的距离」补到 --traffic-inset。
         * 父级已经有 padding-left 时只补差值，所以标题栏改内边距不会把灯推歪，
         * 应用也不必再写 calc(var(--traffic-inset) - 12px) 这类第二份算术。
         * overlay 形态由 trafficlights.css 绝对定位，不写 margin。
         */
        _syncPlacement() {
            const overlay = this.hasAttribute("overlay") || this.getAttribute("placement") === "overlay";
            if (overlay) {
                this.style.removeProperty("margin-left");
                return;
            }
            const parent = this.parentElement;
            if (!parent) return;
            const inset = parseFloat(getComputedStyle(this).getPropertyValue("--traffic-inset")) || 20;
            const padding = parseFloat(getComputedStyle(parent).paddingLeft) || 0;
            this.style.marginLeft = `${Math.max(0, Math.round((inset - padding) * 100) / 100)}px`;
        }

        _disabledFor(action) {
            if (this.hasAttribute("disabled")) return true;
            if (action === "minimize") return this.hasAttribute("no-minimize") || this.getAttribute("variant") === "dialog";
            if (action === "zoom") return this.hasAttribute("no-zoom") || this.getAttribute("variant") === "dialog";
            if (action === "close") return this.hasAttribute("no-close");
            return false;
        }

        _syncFromAttrs() {
            this._syncCaps({
                close: !this._disabledFor("close"),
                minimize: !this._disabledFor("minimize"),
                zoom: !this._disabledFor("zoom"),
            });
        }

        /** @param {{close?:boolean,minimize?:boolean,zoom?:boolean}} caps */
        _syncCaps(caps) {
            for (const b of BUTTONS) {
                const dot = this._dots[b.action];
                if (!dot) continue;
                const off = caps[b.action] === false;
                dot.classList.toggle("is-off", off);
                dot.setAttribute("aria-disabled", off ? "true" : "false");
                dot.tabIndex = off ? -1 : 0;
            }
            this.toggleAttribute("disabled", BUTTONS.every((b) => caps[b.action] === false));
        }

        /** 焦点灰化：由 window.js 在窗口置顶/失焦时调用 */
        setActive(active) { this.classList.toggle("inactive", !active); }

        _fire(action, e) {
            if (this._disabledFor(action)) return;
            // 不自己改窗口状态，只上报动作；composed 让宿主外的 window.js 能收到
            this.dispatchEvent(new CustomEvent(ACTION_EVENT, {
                bubbles: true,
                composed: true,
                detail: { action, altKey: !!e.altKey, shiftKey: !!e.shiftKey, metaKey: !!e.metaKey },
            }));
        }
    }

    customElements.define(TAG, DesklyTrafficLights);
}

// 模块求值即注册：plugin-manager / window.js / bootstrap 都在注入应用 HTML 之前
// 就把本模块拉进依赖图，因此解析到 <deskly-traffic-lights> 时元素已定义，
// 首帧即带 shadow root，不会出现"先亮三个未样式圆点"的闪烁。
defineTrafficLights();
