/**
 * widgets/host.js —— 小组件容器与布局（F-18）
 *
 * 原版依据：docs/iMac-2024-macOS15-知识库/images/S0056_DesktopNotificationCenter.png
 * macOS 小组件可落在通知中心与桌面两处；本模块负责「放哪里」：
 * - center：通知中心面板里的小组件区（面板创建时经 mountCenter 挂入）；
 * - desktop：桌面小组件层（独立悬浮层，body 直挂 —— desktop.js 渲染时会整体清空
 *   自身 DOM，小组件不能寄宿其中；以 pointer-events:none 底层 + 实例 auto 命中，
 *   不干扰桌面图标与点桌收窗）。
 *
 * 布局持久化（G7）：widgets.layout = { items: [{id,type,size,container,x,y}] }，
 * 由本模块 owner 登记；重排/增删/拖拽即写回。
 *
 * 忠实度说明：桌面小组件层与 desktop.js 图标栅格是两套坐标（图标吸附体系归
 * desktop.js/desktopItems.js，本批次不得改动），拖拽自由定位、不与图标互相避让。
 */

import { settings } from "../settings.js";
import { i18n } from "../i18n.js";
import { WIDGET_SIZES, REGISTRY_EVENT, registerType, unregisterType, getType, hasType } from "./registry.js";

const DEFAULT_LAYOUT = {
    items: [
        { id: "wg-cal", type: "calendar", size: "medium", container: "center", x: 0, y: 0 },
        { id: "wg-clock", type: "clock", size: "small", container: "center", x: 0, y: 0 },
    ],
};

settings.defineMany([
    {
        key: "widgets.layout", type: "json", default: DEFAULT_LAYOUT,
        hidden: true, label: "小组件布局", owner: "system",
    },
]);

const CONTAINERS = ["center", "desktop"];

/** 实例表：item.id → { item, el, cleanup } */
const instances = new Map();

let centerHostEl = null;
let desktopLayerEl = null;
let editMode = false;
let rendered = false;

function readLayout() {
    const raw = settings.get("widgets.layout", DEFAULT_LAYOUT);
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return items.filter((it) => it && typeof it === "object" && hasType(it.type) && CONTAINERS.includes(it.container));
}

function saveLayout(items) {
    settings.set("widgets.layout", { items }, { source: "widgets-host" });
}

function clampPos(v, max, dim) {
    return Math.max(0, Math.min(max - dim, Math.round(v)));
}

/* ── 实例渲染 ── */

function destroyInstance(id) {
    const inst = instances.get(id);
    if (!inst) return;
    try { inst.cleanup?.(); } catch (err) { console.warn("[widgets] 实例清理失败:", err); }
    inst.el.remove();
    instances.delete(id);
}

function frameEl(item) {
    const el = document.createElement("div");
    el.className = `widget-frame widget-frame--${item.size}`;
    el.dataset.widgetId = item.id;
    el.dataset.widgetType = item.type;
    const content = document.createElement("div");
    content.className = "widget-frame__content";
    el.appendChild(content);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "widget-frame__remove";
    removeBtn.setAttribute("aria-label", i18n.t("widgets.remove", "移除"));
    removeBtn.textContent = "×";
    el.appendChild(removeBtn);
    return el;
}

function renderInstance(item) {
    if (instances.has(item.id)) return;
    const def = getType(item.type);
    if (!def) return;
    const el = frameEl(item);
    const content = el.querySelector(".widget-frame__content");
    let cleanup = null;
    try {
        cleanup = def.render(content, item.size) || null;
    } catch (err) {
        console.warn("[widgets] 小组件渲染失败:", item.type, err);
        const bad = document.createElement("p");
        bad.className = "wg-broken";
        bad.textContent = "小组件加载失败";
        content.appendChild(bad);
    }
    const inst = { item, el, cleanup };
    instances.set(item.id, inst);
    el.querySelector(".widget-frame__remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeWidget(item.id);
    });
    if (item.container === "desktop") {
        applyDesktopPos(el, item);
        bindDesktopDrag(el, item);
        el.style.pointerEvents = "auto";
        desktopLayerEl.appendChild(el);
    } else {
        bindCenterDrag(el, item);
        el.style.pointerEvents = "auto";
        centerHostEl.appendChild(el);
    }
    syncEditMode(inst);
}

function applyDesktopPos(el, item) {
    el.style.position = "absolute";
    const w = item.size === "small" ? 148 : 336;
    const h = item.size === "small" ? 148 : (item.size === "large" ? 300 : 160);
    el.style.left = `${clampPos(item.x ?? 24, window.innerWidth, w)}px`;
    el.style.top = `${clampPos(item.y ?? 80, window.innerHeight, h)}px`;
}

function syncEditMode(inst) {
    inst.el.classList.toggle("wg-editing", editMode);
}

/* ── 拖拽：桌面自由定位；通知中心为纵向重排 ── */

function bindDesktopDrag(el, item) {
    el.addEventListener("pointerdown", (e) => {
        if (!editMode || e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const originX = item.x ?? 24;
        const originY = item.y ?? 80;
        const onMove = (ev) => {
            item.x = clampPos(originX + (ev.clientX - startX), window.innerWidth, el.offsetWidth);
            item.y = clampPos(originY + (ev.clientY - startY), window.innerHeight, el.offsetHeight);
            el.style.left = `${item.x}px`;
            el.style.top = `${item.y}px`;
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            saveLayout(readLayoutRawWith(item));
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    });
}

function readLayoutRawWith(item) {
    return readLayout().map((it) => (it.id === item.id ? item : it));
}

function bindCenterDrag(el, item) {
    el.addEventListener("pointerdown", (e) => {
        if (!editMode || e.button !== 0) return;
        e.preventDefault();
        const onMove = (ev) => {
            const siblings = [...centerHostEl.querySelectorAll(".widget-frame")].filter((n) => n !== el);
            const after = siblings.find((n) => ev.clientY < n.getBoundingClientRect().top + n.offsetHeight / 2);
            if (after) centerHostEl.insertBefore(el, after);
            else centerHostEl.appendChild(el);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            const order = [...centerHostEl.querySelectorAll(".widget-frame")].map((n) => n.dataset.widgetId);
            const rest = readLayout().filter((it) => it.container === "center" && it.id !== item.id);
            const desktopItems = readLayout().filter((it) => it.container === "desktop");
            const moved = readLayout().find((it) => it.id === item.id);
            const centerOrdered = order.map((id) => rest.find((it) => it.id === id) || moved).filter(Boolean);
            saveLayout([...centerOrdered, ...desktopItems]);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    });
}

/* ── 全量重渲（按布局数组顺序对齐实例） ── */

function renderAll() {
    if (!rendered) return;
    const items = readLayout();
    const alive = new Set(items.map((it) => it.id));
    for (const id of [...instances.keys()]) {
        if (!alive.has(id)) destroyInstance(id);
    }
    for (const it of items) renderInstance(it);
    // 通知中心容器按布局顺序重排
    if (centerHostEl) {
        items.filter((it) => it.container === "center").forEach((it) => {
            const inst = instances.get(it.id);
            if (inst) centerHostEl.appendChild(inst.el);
        });
    }
}

function ensureDesktopLayer() {
    if (desktopLayerEl) return desktopLayerEl;
    desktopLayerEl = document.createElement("div");
    desktopLayerEl.id = "deskly-widgets-desktop";
    desktopLayerEl.className = "widgets-desktop-layer";
    // 层级：低于窗口（Z.WINDOW_MIN=2050），高于桌面图标；自身不拦截点击
    desktopLayerEl.style.cssText = `position:fixed;inset:0;z-index:940;pointer-events:none;`;
    document.body.appendChild(desktopLayerEl);
    return desktopLayerEl;
}

function ensureCenterHost() {
    if (!centerHostEl) {
        centerHostEl = document.createElement("div");
        centerHostEl.className = "wg-stack";
    }
    return centerHostEl;
}

/* ── 对外 API ── */

export const host = {
    /** 通知中心面板挂入小组件区（返回容器元素） */
    mountCenter(hostEl) {
        centerHostEl = hostEl.classList.contains("wg-stack") ? hostEl : ensureCenterHost();
        if (!hostEl.classList.contains("wg-stack")) hostEl.appendChild(centerHostEl);
        rendered = true;
        renderAll();
        return centerHostEl;
    },

    /** 通知中心容器当前的小组件数（决定空态引导是否显示） */
    centerCount() {
        return readLayout().filter((it) => it.container === "center").length;
    },

    /** 指定容器的布局清单（小组件中心用） */
    layoutItems(containerId) {
        return readLayout().filter((it) => it.container === containerId);
    },

    /**
     * 添加实例
     * @param {{type:string, size?:string, container?:string, x?:number, y?:number}} opts
     * @returns {string|null} 实例 id
     */
    addWidget(opts = {}) {
        const def = getType(opts.type);
        if (!def) return null;
        const size = def.sizes.includes(opts.size) ? opts.size : def.sizes[0];
        const container = CONTAINERS.includes(opts.container) ? opts.container : "center";
        const item = {
            id: `wg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            type: opts.type,
            size,
            container,
            x: Number.isFinite(opts.x) ? clampPos(opts.x, window.innerWidth, 336) : 24,
            y: Number.isFinite(opts.y) ? clampPos(opts.y, window.innerHeight, 160) : 80,
        };
        saveLayout([...readLayout(), item]);
        renderAll();
        return item.id;
    },

    removeWidget(id) {
        saveLayout(readLayout().filter((it) => it.id !== id));
        destroyInstance(id);
    },

    /** 改尺寸（重建实例以适配内容） */
    resizeWidget(id, size) {
        const items = readLayout();
        const it = items.find((n) => n.id === id);
        const def = getType(it?.type);
        if (!it || !def || !def.sizes.includes(size)) return false;
        it.size = size;
        saveLayout(items);
        destroyInstance(id);
        renderAll();
        return true;
    },

    /** 编辑模式：桌面小组件抖动 + 删除角标 + 可拖拽 */
    setEditMode(on) {
        editMode = Boolean(on);
        for (const inst of instances.values()) syncEditMode(inst);
        desktopLayerEl?.classList.toggle("wg-editing", editMode);
        return editMode;
    },

    isEditMode() {
        return editMode;
    },

    /* ── 插件小组件（os-api widgets 门面落点） ── */

    /**
     * 注册插件小组件类型：`<插件id>:<type>`，宿主按 entry 渲染插件 iframe。
     * @param {string} caller 插件 id（guard 归属）
     * @param {{type:string, size?:string, entry:string}} def
     * @returns {{typeId:string}|null}
     */
    registerPluginWidget(caller, def = {}) {
        const who = String(caller || "");
        if (!who) return null;
        const type = String(def.type || "").trim();
        if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(type)) return null;
        const entry = String(def.entry || "").trim();
        // entry 必须落在插件自身目录内：相对路径、无 ..、非绝对
        if (!/^(?!\/)(?!\.\.)([\w.-]+\/)*[\w.-]+\.(html?)$/i.test(entry)) {
            globalThis.__log?.warn("kernel/widgets", `非法小组件 entry：${entry}`);
            return null;
        }
        const size = WIDGET_SIZES.includes(def.size) ? def.size : "medium";
        const typeId = `${who}:${type}`;
        // 重复 create 视为更新：先摘旧类型与实例
        if (hasType(typeId)) this.removePluginWidget(who, typeId);
        const registered = registerType({
            id: typeId,
            sizes: [size],
            owner: who,
            entry,
            render(content) {
                const frame = document.createElement("iframe");
                frame.className = "wg-plugin-frame";
                frame.src = `./mods/${who}/${entry}`;
                frame.title = type;
                content.appendChild(frame);
            },
        });
        if (!registered) return null;
        return { typeId };
    },

    /** 更新插件小组件（仅 owner 可改）：换尺寸/内容页，实例即时重渲 */
    updatePluginWidget(caller, typeId, patch = {}) {
        const who = String(caller || "");
        const t = getType(String(typeId || ""));
        if (!t || t.owner !== who) return null;
        const next = {
            type: typeId.split(":")[1] || "widget",
            size: WIDGET_SIZES.includes(patch.size) ? patch.size : t.sizes[0],
            entry: typeof patch.entry === "string" && patch.entry ? patch.entry : t.entry,
        };
        this.removePluginWidget(who, typeId);
        return this.registerPluginWidget(who, next);
    },

    /** 注销插件小组件：类型与已挂实例一并移除 */
    removePluginWidget(caller, typeId) {
        const who = String(caller || "");
        const t = getType(String(typeId || ""));
        if (!t || t.owner !== who) return false;
        for (const it of readLayout().filter((n) => n.type === typeId)) {
            destroyInstance(it.id);
        }
        saveLayout(readLayout().filter((n) => n.type !== typeId));
        unregisterType(typeId);
        return true;
    },
};

/* ── 引导 ── */

ensureDesktopLayer();
document.addEventListener(REGISTRY_EVENT, renderAll);
document.addEventListener("settings-changed", (e) => {
    if (e?.detail?.key === "widgets.layout") renderAll();
});
window.addEventListener("resize", () => {
    if (!desktopLayerEl) return;
    for (const inst of instances.values()) {
        if (inst.item.container === "desktop") applyDesktopPos(inst.el, inst.item);
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editMode) {
        host.setEditMode(false);
        document.dispatchEvent(new CustomEvent("widgets-editmode-change", { detail: { on: false } }));
    }
});
