/**
 * ui/notification-center.js —— 通知中心面板（F-17）
 *
 * 原版依据：docs/iMac-2024-macOS15-知识库/pages/21-Mac_上的“通知中心”.md
 * 与 images/S0056_DesktopNotificationCenter.png：
 * - macOS 点菜单栏右上角日期/时间，屏幕右缘滑入全高通知中心：日期抬头、
 *   小组件区、按「今天/更早」分组的通知栈（可展开、可逐条/一键清除）。
 * - 边缘手势：触控板自右缘向左轻扫打开（此处等价为屏幕右缘按住 pointer 左拖）。
 *
 * 结构：
 *   nc-panel
 *     nc-datehead    日期抬头（几月几日 星期几）
 *     nc-widgets     小组件区（widgets/host.js 的 center 容器挂入点）
 *     nc-listhead    「通知」+ 全部清除
 *     nc-list        分组通知栈
 *     nc-footer      编辑小组件入口（widgets/center.js）
 *
 * 数据源：notifications/store.js（与横幅共用同一份持久化 store）。
 * 层级：Z.PANEL（9630），与控制中心同层互斥（开一个收另一个，见 datetime_popover.js 注释）。
 * 动效：缓动 cubic-bezier(0.16,1,0.3,1)；reduceMotion（html[data-reduce-motion="on"]）
 *       下降级为透明度过渡（见 notification-center.css，G5）。
 */

import { i18n } from "../i18n.js";
import { Z } from "../zindex.js";
import { GENERIC_APP_ICON } from "../paths.js";
import { store } from "../notifications/store.js";
import { canPin, NOTIF_MIME } from "../notifications/pins.js";
import { hide as hideControlCenter } from "../controlcenter.js";
import { host as widgetHost } from "../widgets/host.js";

const OPEN_EVENT = "notification-center-change";

let panelEl = null;
let listEl = null;
let widgetsAreaEl = null;
let widgetsGuideEl = null;
let clearAllBtn = null;
let isOpen = false;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

/* ── 时间文案：刚刚 / N 分钟前 / HH:MM / 月日 ── */

function timeText(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return i18n.t("notifycenter.justNow", "刚刚");
    if (diff < 3600000) return i18n.t("notifycenter.minutesAgo", "{n} 分钟前").replace("{n}", String(Math.floor(diff / 60000)));
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    if (sameDay) return d.toLocaleTimeString(document.documentElement.lang || "zh-CN", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(document.documentElement.lang || "zh-CN", { month: "numeric", day: "numeric" });
}

/* ── 通知栈 ── */

function buildItem(rec) {
    const item = el("div", `nc-item${rec.muted ? " is-muted" : ""}`);
    item.dataset.id = rec.id;

    if (rec.icon) {
        const img = document.createElement("img");
        img.className = "nc-item__icon";
        img.src = rec.icon;
        img.alt = "";
        img.addEventListener("error", () => {
            img.src = GENERIC_APP_ICON;
        }, { once: true });
        item.appendChild(img);
    } else {
        item.appendChild(el("span", "nc-item__icon nc-item__icon--blank"));
    }

    const body = el("div", "nc-item__body");
    body.appendChild(el("p", "nc-item__app", rec.appName || rec.appId || i18n.t("notifycenter.unknownApp", "系统")));
    body.appendChild(el("p", "nc-item__title", rec.title));
    const text = el("p", "nc-item__text", rec.text);
    body.appendChild(text);
    if (rec.muted) body.appendChild(el("span", "nc-item__flag", i18n.t("notifycenter.muted", "已被专注模式静音")));
    item.appendChild(body);

    item.appendChild(el("span", "nc-item__time", timeText(rec.ts)));

    const rm = el("button", "nc-item__clear", i18n.t("notifycenter.clear", "清除"));
    rm.type = "button";
    rm.addEventListener("click", (e) => {
        e.stopPropagation();
        store.remove(rec.id);
    });
    item.appendChild(rm);

    // 点击展开完整正文（macOS：轻点展开长通知）
    item.addEventListener("click", () => item.classList.toggle("is-expanded"));

    bindDragToDock(item, rec);
    return item;
}

/**
 * 拖拽入口：可固定的通知可拖到程序坞成为入口，不可固定的类型只显示禁用态、不响应拖拽。
 * @param {HTMLElement} item 通知条目
 * @param {object} rec 通知记录
 */
function bindDragToDock(item, rec) {
    if (!canPin(rec)) {
        item.draggable = false;
        item.classList.add("is-undroppable");
        item.title = i18n.t("notifycenter.undroppable", "此类通知不支持拖到程序坞");
        return;
    }
    item.draggable = true;
    item.classList.add("is-draggable");

    item.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        // 载荷只带渲染程序坞入口必需的快照字段，不传整份记录。
        const payload = {
            id: rec.id,
            title: rec.title,
            text: rec.text,
            appId: rec.appId,
            appName: rec.appName,
            icon: rec.icon,
            ts: rec.ts,
            type: rec.type,
        };
        e.dataTransfer.setData(NOTIF_MIME, JSON.stringify(payload));
        e.dataTransfer.setData("text/plain", rec.title || "");
        e.dataTransfer.effectAllowed = "copy";
        item.classList.add("is-dragging");
        // 预览：图标 + 标题的小卡片。setDragImage 需要元素已在文档里，
        // 用 fixed 移出视口再在下一拍移除，不会闪到界面上。
        const ghost = buildDragGhost(rec);
        document.body.appendChild(ghost);
        try {
            e.dataTransfer.setDragImage(ghost, 18, 18);
        } catch (err) {
            /* 个别环境不支持自定义拖拽图：退回浏览器默认预览 */
        }
        setTimeout(() => ghost.remove(), 0);
    });

    item.addEventListener("dragend", () => item.classList.remove("is-dragging"));
}

/** 拖拽预览：与通知条目同一视觉语言（小图标 + 单行标题）。 */
function buildDragGhost(rec) {
    const ghost = el("div", "nc-drag-ghost");
    const img = document.createElement("img");
    img.className = "nc-drag-ghost__icon";
    img.alt = "";
    img.src = rec.icon || GENERIC_APP_ICON;
    img.addEventListener("error", () => { img.src = GENERIC_APP_ICON; }, { once: true });
    ghost.appendChild(img);
    ghost.appendChild(el("span", "nc-drag-ghost__title", rec.title || ""));
    return ghost;
}

function renderList() {
    if (!listEl) return;
    const records = store.list();
    listEl.textContent = "";
    const today = new Date();
    const isToday = (ts) => {
        const d = new Date(ts);
        return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    };
    const todays = records.filter((r) => isToday(r.ts));
    const earlier = records.filter((r) => !isToday(r.ts));
    const appendGroup = (labelKey, labelFallback, list) => {
        if (!list.length) return;
        listEl.appendChild(el("p", "nc-group", i18n.t(labelKey, labelFallback)));
        list.forEach((rec) => listEl.appendChild(buildItem(rec)));
    };
    appendGroup("notifycenter.today", "今天", todays);
    appendGroup("notifycenter.earlier", "更早", earlier);

    if (!records.length) {
        listEl.appendChild(el("p", "nc-empty", i18n.t("notifycenter.empty", "无通知")));
    }
    if (clearAllBtn) clearAllBtn.disabled = !records.length;
}

/* ── 面板 DOM ── */

function ensurePanel() {
    if (panelEl) return;

    panelEl = el("div", "nc-panel");
    panelEl.id = "notification-center";
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", i18n.t("notifycenter.title", "通知中心"));
    panelEl.style.zIndex = String(Z.PANEL);

    const scroll = el("div", "nc-scroll");

    // 日期抬头
    const head = el("div", "nc-datehead");
    const now = new Date();
    const lang = document.documentElement.lang || "zh-CN";
    head.appendChild(el("strong", "nc-datehead__date",
        now.toLocaleDateString(lang, { month: "long", day: "numeric" })));
    head.appendChild(el("span", "nc-datehead__week",
        now.toLocaleDateString(lang, { weekday: "long" })));
    scroll.appendChild(head);

    // 小组件区（F-18 center 容器挂入点）+ 空态引导
    widgetsAreaEl = el("div", "nc-widgets");
    scroll.appendChild(widgetsAreaEl);
    widgetsGuideEl = el("button", "nc-widgets-guide", i18n.t("widgets.emptyGuide", "添加小组件以在通知中心查看信息"));
    widgetsGuideEl.type = "button";
    widgetsGuideEl.addEventListener("click", () => {
        import("../widgets/center.js").then((m) => m.open()).catch((err) => console.warn("[notification-center] 小组件中心加载失败:", err));
    });
    scroll.appendChild(widgetsGuideEl);

    // 列表头
    const listHead = el("div", "nc-listhead");
    listHead.appendChild(el("span", "nc-listhead__label", i18n.t("notifycenter.listTitle", "通知")));
    clearAllBtn = el("button", "nc-clear-all", i18n.t("notifycenter.clearAll", "全部清除"));
    clearAllBtn.type = "button";
    clearAllBtn.addEventListener("click", () => store.clearAll());
    listHead.appendChild(clearAllBtn);
    scroll.appendChild(listHead);

    listEl = el("div", "nc-list");
    scroll.appendChild(listEl);

    // 底部：编辑小组件
    const foot = el("div", "nc-footer");
    const editBtn = el("button", "nc-footer__btn", i18n.t("notifycenter.editWidgets", "编辑小组件…"));
    editBtn.type = "button";
    editBtn.addEventListener("click", () => {
        import("../widgets/center.js").then((m) => m.open()).catch((err) => console.warn("[notification-center] 小组件中心加载失败:", err));
    });
    foot.appendChild(editBtn);
    scroll.appendChild(foot);

    panelEl.appendChild(scroll);
    document.body.appendChild(panelEl);

    // 挂入小组件 center 容器（F-18）
    widgetHost.mountCenter(widgetsAreaEl);
    syncWidgetGuide();

    globalThis.__surface?.apply?.(panelEl, { role: 3 });

    // 数据变化即时反映到列表
    store.subscribe(() => { if (isOpen) renderList(); });
    document.addEventListener("languagechange", () => {
        if (!panelEl) return;
        // 文案整体重建（标题/分组/按钮），重建期间面板保持关闭态即可
        const wasOpen = isOpen;
        close();
        panelEl.remove();
        panelEl = null;
        if (wasOpen) open();
    });
}

function syncWidgetGuide() {
    if (!widgetsGuideEl || !widgetsAreaEl) return;
    const count = widgetHost.centerCount();
    widgetsGuideEl.style.display = count ? "none" : "block";
    widgetsAreaEl.style.display = count ? "block" : "none";
}

/* ── 开合 ── */

export function open() {
    ensurePanel();
    if (isOpen) return;
    hideControlCenter(); // 同层互斥：收起控制中心
    isOpen = true;
    renderList();
    syncWidgetGuide();
    panelEl.classList.add("open");
    attachGlobalClose();
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { open: true } }));
}

export function close() {
    if (!isOpen || !panelEl) return;
    isOpen = false;
    panelEl.classList.remove("open");
    detachGlobalClose();
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { open: false } }));
}

export function toggle() {
    if (isOpen) close();
    else open();
}

/* ── 定位到某条通知（程序坞固定入口点击时调用） ── */

let revealTimer = 0;

/** 减少动态效果：不做平滑滚动，直接落位 */
function prefersReducedMotion() {
    if (document.documentElement.dataset.reduceMotion === "on") return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function escapeAttr(value) {
    return String(value).replace(/["\\]/g, "\\$&");
}

/**
 * 打开通知中心并定位到指定通知：滚动到可见、展开正文、短暂高亮。
 * @param {string} id 通知 id
 * @returns {boolean} 通知是否仍在历史里（false 表示已被清除或已过期）
 */
export function revealNotification(id) {
    if (typeof id !== "string" || !id) return false;
    ensurePanel();
    if (!isOpen) open();
    if (!store.list().some((rec) => rec.id === id)) return false;
    const node = listEl?.querySelector(`.nc-item[data-id="${escapeAttr(id)}"]`);
    if (!node) return false;
    node.classList.add("is-expanded");
    node.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    // 重播高亮：先摘类、强制一次样式计算，再加回类
    node.classList.remove("is-located");
    void node.offsetWidth;
    node.classList.add("is-located");
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => node.classList.remove("is-located"), 1600);
    return true;
}

export { isOpen as isOpenVisible };

/* ── 全局关闭：Esc、点外面 ── */

let onDocClick = null;
let onEsc = null;

function attachGlobalClose() {
    onDocClick = (e) => {
        if (e.target.closest && e.target.closest("[data-datetime-anchor]")) return; // 锚点点击交给 toggle
        if (panelEl && panelEl.contains(e.target)) return;
        // 小组件中心浮层之上点击不算外点（它是本面板的二级界面）
        const wc = document.querySelector(".wc-overlay");
        if (wc && wc.style.display !== "none" && wc.contains(e.target)) return;
        close();
    };
    document.addEventListener("click", onDocClick, true);
    onEsc = (e) => {
        if (e.key === "Escape") {
            // Esc 先给小组件中心（若开着），其次才是本面板
            const wc = document.querySelector(".wc-overlay");
            if (wc && wc.style.display !== "none") return;
            close();
        }
    };
    document.addEventListener("keydown", onEsc);
}

function detachGlobalClose() {
    if (onDocClick) { document.removeEventListener("click", onDocClick, true); onDocClick = null; }
    if (onEsc) { document.removeEventListener("keydown", onEsc); onEsc = null; }
}

/* ── 右缘手势（触控板轻扫的 pointer 等价：右缘 24px 内按住左拖 > 60px 即开） ── */

let gestureActive = false;
let gestureStartX = 0;

document.addEventListener("pointerdown", (e) => {
    if (isOpen) return;
    if (e.clientX < window.innerWidth - 24) return;
    if (e.target.closest && e.target.closest(".nc-panel, .controlcenter, .os-notification")) return;
    gestureActive = true;
    gestureStartX = e.clientX;
}, true);

document.addEventListener("pointermove", (e) => {
    if (!gestureActive) return;
    if (gestureStartX - e.clientX > 60) {
        gestureActive = false;
        open();
    }
}, true);

document.addEventListener("pointerup", () => { gestureActive = false; }, true);
document.addEventListener("pointercancel", () => { gestureActive = false; }, true);
