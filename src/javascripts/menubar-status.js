/**
 * menubar-status.js — 菜单栏右侧状态项（F-01 声明式 + F-02 逐项配置）
 *
 * 状态项为**声明式数组**（STATUS_ITEMS）：电池 / 台前调度。
 * Wi-Fi、蓝牙、音量三个状态项及其二级面板已移除，相关能力统一收进控制中心面板。
 *
 * 数据全部真源、无装饰图：
 *  - 电池    navigator.getBattery 直读；机器没有电池（桌面机）时该项整体不显示，
 *             不画假电池；充电中显示闪电，≤20% 琥珀色、≤10% 红色。
 *  - 台前调度 controlcenter.stage / controlcenter.stageInMenuBar。
 *
 * F-02 逐项配置：
 *  - 每项一个「在菜单栏显示」开关（menubar.showBattery / controlcenter.stageInMenuBar）。
 *  - 状态项可用指针**横向拖动排序**（menubar.order 持久化）。
 *  - 按住 Command（或 Ctrl）**把状态项拖出菜单栏**即移除，弹撤销通知。
 *  - 系统设置 › 控制中心 ›「菜单栏状态项」提供「恢复默认」。
 */
import { i18n } from "./i18n.js";
import { settings } from "./settings.js";

// —— 状态项 SVG（与 controlcenter 同一套 24×24 记法，颜色走 currentColor） ——
const ICONS = {
    battery: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="7.5" width="17" height="9" rx="2.5"/><path d="M21.5 10.5v3.5" stroke-linecap="round"/><rect class="ms-battery-fill" x="3.8" y="9.3" width="13.4" height="5.4" rx="1" fill="currentColor" stroke="none"/><path class="ms-battery-bolt" d="M10.6 8.6 8.4 12.2h1.9l-1 3.2 2.9-3.9h-1.9l1.3-2.9z" fill="currentColor" stroke="none" opacity="0"/></svg>',
    stage: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="4" width="12" height="16" rx="2"/><rect x="17" y="4" width="5" height="5" rx="1.2"/><rect x="17" y="11.5" width="5" height="3.5" rx="1.2"/><rect x="17" y="17" width="5" height="3" rx="1.2"/></svg>',
};

/** 拖动排序：单步换位所需的最小水平位移（px）。 */
const DRAG_STEP = 20;
/** Command 拖出移除：判定为「拖出」的最小水平位移（px）。 */
const REMOVE_STEP = 56;
/** 撤销通知停留时长（毫秒）。 */
const UNDO_MS = 6500;

/** 状态项顺序的默认值（视觉从左到右），menubar.order 持久化用。 */
const DEFAULT_ORDER = "battery,stage";

/** 拖出移除后可撤销的键名记录（撤销通知 onAction 用）。 */
let lastRemoved = null;

/**
 * 声明式状态项表：菜单栏右侧的全部状态项都在这里，渲染/配置/数据一条记录说清。
 * detail 是控制中心二级段落 kind（openDetail 的入参约定）；null 表示该段没有二级面板。
 * @type {Array<{id:string, icon:string, tipKey:string, tipFallback:string, detail:string|null, dataFn:(rec:object)=>void}>}
 */
const STATUS_ITEMS = [
    {
        id: "battery", icon: ICONS.battery,
        tipKey: "menubar.battery", tipFallback: "电池",
        detail: null,
        dataFn: refreshBattery,
    },
    {
        id: "stage", icon: ICONS.stage,
        tipKey: "menubar.stage", tipFallback: "台前调度",
        detail: null,
        dataFn: refreshStage,
    },
];

const items = {};
let right = null;
let visualOrder = [];

/** 该项「在菜单栏显示」的设置键（stage 走 controlcenter.stageInMenuBar）。 */
function showKeyOf(id) {
    return id === "stage" ? "controlcenter.stageInMenuBar" : "menubar.show" + id[0].toUpperCase() + id.slice(1);
}

/** 该项当前是否应在菜单栏显示（关掉 ≠ 删除：元素留在 DOM 便于再打开）。 */
function isVisible(id) {
    return settings.get(showKeyOf(id), true) !== false;
}

/**
 * 打开控制中心并尽量展开对应二级段落。
 * openDetail 由 F-20/F-19 批次的控制中心导出；就绪前退化为广播事件 + 打开面板主体，
 * 对应卡片在首屏可见 —— 两条路径都是真实可达的交互，不装死。
 * @param {string|null} kind 二级段落 kind（wifi / bluetooth / sound）
 */
function openControlCenter(kind) {
    import("./controlcenter.js").then((cc) => {
        cc.show();
        if (kind && typeof cc.openDetail === "function") {
            try { cc.openDetail(kind); } catch { /* 面板已打开，段落降级为首屏卡片 */ }
        } else if (kind) {
            window.dispatchEvent(new CustomEvent("controlcenter:open-detail", { detail: { kind } }));
        }
    }).catch(() => {});
}

/**
 * 电池数据源：BatteryManager 直读（与控制中心 initBattery 同一判定）。
 * 无电池 API 或桌面机假状态（100% 充电中且充满时间缺失）→ 整项隐藏，不画假电池。
 */
function refreshBattery(rec) {
    if (typeof navigator?.getBattery !== "function") {
        rec.el.classList.add("no-data");
        return;
    }
    if (!rec.batteryPromise) rec.batteryPromise = navigator.getBattery();
    rec.batteryPromise.then((bat) => {
        let pctEl = rec.el.querySelector(".ms-battery-pct");
        if (!pctEl) {
            pctEl = document.createElement("span");
            pctEl.className = "ms-battery-pct";
            pctEl.textContent = "";
            rec.el.appendChild(pctEl);
        }
        const paint = () => {
            const pct = Math.round(bat.level * 100);
            // 桌面机没有电池，Chrome 仍会返回「100% 充电中、充满时间缺失」的假状态
            // （与控制中心 initBattery 同一判定）：这种情况整项隐藏。
            const ct = bat.chargingTime;
            const dt = bat.dischargingTime;
            const chargingTimeMissing = ct === 0 || ct === Infinity || ct < 0 || ct == null;
            const dischargingTimeMissing = dt === null || dt === Infinity || dt < 0;
            const fullyCharged = Math.abs(bat.level - 1) < 0.001;
            const hasBattery = !(fullyCharged && bat.charging && chargingTimeMissing && dischargingTimeMissing);
            rec.el.classList.toggle("no-data", !hasBattery);
            rec.el.classList.toggle("charging", bat.charging);
            rec.el.classList.toggle("low", !bat.charging && pct <= 20);
            rec.el.classList.toggle("critical", !bat.charging && pct <= 10);
            const fill = rec.el.querySelector(".ms-battery-fill");
            if (fill) fill.style.width = (13.4 * bat.level).toFixed(1) + "px";
            const bolt = rec.el.querySelector(".ms-battery-bolt");
            if (bolt) bolt.style.opacity = bat.charging ? "1" : "0";
            pctEl.textContent = pct + "%";
            rec.el.title = i18n.t("menubar.batteryTip", "电池 {pct}%{state}")
                .replace("{pct}", String(pct))
                .replace("{state}", bat.charging ? i18n.t("menubar.batteryCharging", "（充电中）") : "");
        };
        paint();
        // 监听只挂一次（rec 维度），重复 apply 只重画不叠监听。
        if (!rec.batteryWatched) {
            rec.batteryWatched = true;
            bat.addEventListener("levelchange", paint);
            bat.addEventListener("chargingchange", paint);
            bat.addEventListener("chargingtimechange", paint);
            bat.addEventListener("dischargingtimechange", paint);
        }
    }).catch(() => rec.el.classList.add("no-data"));
}

/** 台前调度数据源：状态 controlcenter.stage，常驻开关 controlcenter.stageInMenuBar（FS-07）。 */
function refreshStage(rec) {
    const on = settings.get("controlcenter.stage", false) === true;
    const inBar = settings.get("controlcenter.stageInMenuBar", true) !== false;
    rec.el.classList.toggle("is-hidden", !(on && inBar));
    rec.el.title = i18n.t("menubar.stage", "台前调度");
}

// —— F-02：指针拖动排序 + Command 拖出移除 ——

/** 读取持久化的视觉顺序（缺失/越界回退默认声明序）。 */
function readOrder() {
    const raw = String(settings.get("menubar.order", DEFAULT_ORDER) || DEFAULT_ORDER);
    const ids = raw.split(",").map((s) => s.trim()).filter((id) => items[id]);
    for (const def of STATUS_ITEMS) {
        if (!ids.includes(def.id)) ids.push(def.id);
    }
    return ids;
}

/** 按视觉顺序重排 DOM（.right row-reverse：反序追加 = 视觉从左到右）。 */
function renderOrder() {
    if (!right) return;
    for (let i = visualOrder.length - 1; i >= 0; i--) {
        const rec = items[visualOrder[i]];
        if (rec) right.appendChild(rec.el);
    }
}

/** 把当前 DOM 顺序写回 menubar.order（去抖由调用方决定，这里同步写）。 */
function persistOrder() {
    settings.set("menubar.order", visualOrder.join(","));
}

/**
 * 给状态项挂拖动手势：横拖换位排序；按住 Command/Ctrl 拖出（水平位移超阈值）即移除。
 * 小位移不拦截 click（点一下仍是打开控制中心）。改用 pointer 事件而非 HTML5 DnD：
 * 菜单栏是 user-select:none 的 24px 高条，原生 DnD 幽灵图与点击判定都很难看。
 * @param {HTMLElement} el 状态项元素
 * @param {{id:string}} def 声明式条目（id）
 */
function attachDragGesture(el, def) {
    let drag = null;

    el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.altKey) return;
        drag = {
            startX: e.clientX,
            moved: false,
            removed: false,
            meta: e.metaKey || e.ctrlKey,
        };
        try { el.setPointerCapture(e.pointerId); } catch { /* 捕获取不到不影响后续手势 */ }
    });

    el.addEventListener("pointermove", (e) => {
        if (!drag || drag.removed) return;
        const dx = e.clientX - drag.startX;
        // Command 拖出：位移超过阈值即移除 + 撤销通知，一次拖动只触发一次
        if ((e.metaKey || e.ctrlKey || drag.meta) && Math.abs(dx) >= REMOVE_STEP) {
            drag.removed = true;
            removeItem(def.id);
            return;
        }
        if (e.metaKey || e.ctrlKey || drag.meta) return; // 按住修饰键时只表达「移除」意图
        if (Math.abs(dx) < DRAG_STEP) return;
        drag.moved = true;
        const idx = visualOrder.indexOf(def.id);
        const nextIdx = idx + (dx > 0 ? 1 : -1);
        if (nextIdx < 0 || nextIdx >= visualOrder.length) return; // 已到端头
        // row-reverse 下 dx>0 是视觉向右 = 顺移一位
        const swapped = visualOrder[nextIdx];
        visualOrder[nextIdx] = def.id;
        visualOrder[idx] = swapped;
        renderOrder();
        drag.startX = e.clientX;
    });

    const finish = (e) => {
        if (!drag) return;
        const { moved, removed } = drag;
        drag = null;
        try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
        if (removed || moved) el.dataset.dragMoved = "1"; // 抑制紧随其后的合成 click
        if (moved && !removed) persistOrder();
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
}

/**
 * 从菜单栏移除一个状态项（Command 拖出）：写对应 show 键 + 弹撤销通知。
 * @param {string} id 状态项 id
 */
function removeItem(id) {
    const def = STATUS_ITEMS.find((d) => d.id === id);
    if (!def) return;
    const key = showKeyOf(id);
    const label = i18n.t(def.tipKey, def.tipFallback);
    settings.set(key, false);
    lastRemoved = { key, id };
    import("./ui/notification.js").then(({ showNotification }) => {
        showNotification({
            title: i18n.t("menubar.removedTitle", "已从菜单栏移除"),
            text: i18n.t("menubar.removedUndo", "「{name}」已移除，点按撤销")
                .replace("{name}", label),
            onAction: () => {
                if (lastRemoved && lastRemoved.key === key) {
                    settings.set(key, true);
                    lastRemoved = null;
                }
            },
            duration: UNDO_MS,
        });
    }).catch(() => {});
}

/** 恢复状态项默认布局（设置面板「恢复默认」按钮调用）。 */
export function resetLayout() {
    lastRemoved = null;
    for (const def of STATUS_ITEMS) {
        if (def.id !== "stage") settings.set("menubar.show" + def.id[0].toUpperCase() + def.id.slice(1), true);
    }
    settings.set("controlcenter.stageInMenuBar", true);
    settings.set("menubar.order", DEFAULT_ORDER);
    visualOrder = readOrder();
    renderOrder();
    for (const def of STATUS_ITEMS) {
        const rec = items[def.id];
        if (rec) rec.apply();
    }
}

/**
 * 造一个状态项并挂到菜单栏右侧。
 * @param {{id:string, icon:string, tipKey:string, tipFallback:string, detail:string|null, dataFn:(rec:object)=>void}} def 声明式条目
 * @returns {object} 状态项记录
 */
function makeItem(def) {
    const el = document.createElement("p");
    el.className = "menubar-status menubar-status--" + def.id;
    el.innerHTML = def.icon;
    el.title = i18n.t(def.tipKey, def.tipFallback);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (el.dataset.dragMoved === "1") { el.dataset.dragMoved = ""; return; }
        openControlCenter(def.detail);
    });
    attachDragGesture(el, def);
    right.appendChild(el);
    const rec = {
        el,
        apply() {
            const visible = isVisible(def.id);
            el.classList.toggle("is-hidden", !visible);
            el.title = i18n.t(def.tipKey, def.tipFallback);
            def.dataFn(rec);
        },
    };
    items[def.id] = rec;
    return rec;
}

export function init() {
    right = document.querySelector(".finderbar .right");
    if (!right) return;

    // 声明式渲染：一条数组遍历出全部状态项（F-01）
    for (const def of STATUS_ITEMS) makeItem(def);
    visualOrder = readOrder();
    renderOrder();
    // .right 是 row-reverse：DOM 越靠后视觉越靠左。追加到末尾 = 落在时钟左侧，
    // 与 macOS 的「状态项 → 状态图标 → 日期/时间」顺序一致。
    // 台前调度状态项仅在开启台前调度且允许常驻时可见（FS-07）。

    // 逐项「在菜单栏显示」开关 + 顺序（自持定义：owner 权威，同 controlcenter.showInMenuBar 模式）
    settings.defineMany([
        { key: "menubar.showBattery", type: "boolean", default: true, label: i18n.t("menubar.showBattery", "电池"), owner: "system", pane: "controlcenter", group: "菜单栏状态项", order: 31, control: "switch", apply: () => items.battery?.apply() },
        // FS-07：台前调度是否在菜单栏常驻（与台前调度开关本身同 pane，状态源仍是 controlcenter.stage）
        { key: "controlcenter.stageInMenuBar", type: "boolean", default: true, label: i18n.t("menubar.showStage", "在菜单栏显示台前调度"), owner: "system", pane: "controlcenter", group: "台前调度", order: 70, control: "switch", apply: () => items.stage?.apply() },
        // F-02：状态项顺序（视觉从左到右的 id 序列；设置界面不直接编辑，拖动排序写入）
        { key: "menubar.order", type: "string", default: DEFAULT_ORDER, hidden: true, owner: "system", label: "菜单栏状态项顺序", apply: () => { visualOrder = readOrder(); renderOrder(); } },
    ]);

    // 数据刷新：台前调度状态经设置中枢写，订阅同一广播
    window.addEventListener("settings-changed", (e) => {
        const key = e && e.detail && e.detail.key;
        // 台前调度开关 / 菜单栏常驻设置任一变化都要重算状态项
        if (key === "controlcenter.stage" || key === "controlcenter.stageInMenuBar") items.stage?.apply();
    });

    // 声音模块是可选内核（bootstrap 在 plugins-ready 后才初始化）：插件就绪后再刷一遍菜单栏状态。
    window.addEventListener("plugins-ready", () => {
        items.stage?.apply();
    });

    for (const def of STATUS_ITEMS) items[def.id]?.apply();

    // 切语言时重刷标题（详细标题由各 apply 里的数据刷新写回）
    document.addEventListener("languagechange", () => {
        for (const def of STATUS_ITEMS) items[def.id]?.apply();
    });
}

init();
