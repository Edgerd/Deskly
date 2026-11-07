/**
 * wm/stage-manager.js — 台前调度（FS-05，按 02 报告第 5 节最小可用规格）
 *
 * 开启后：正在使用的窗口（组）放在屏幕中央，其余按「最近使用的 App」缩为左侧
 * 停靠缩略图；点缩略图切换舞台；同一应用的窗口合一组；再点一次当前组的缩略图
 * 时 windowMode="one" 循环组内下一窗口。
 *
 * 规格要点（02 报告 5.1–5.4 的落实）：
 * - 状态：enabled 的唯一权威 = 设置键 controlcenter.stage；组 = { windows, anchor, lastUsed }，
 *   按 data-app-id（无则窗口基名）聚合；order = lastUsed 降序。
 * - 非舞台组窗口挂 .wm-shelved（visibility:hidden + pointer-events:none），
 *   留在 stack 里不动层级，避免 commitStack 重排抖动。
 * - 缩略图复用 wm/genie-capture.js 快照管线：入停靠截一次，几何变化复用 refreshWindow。
 * - 动画：窗口本体只走 left/top/width/height/opacity（亚克力禁忌）；
 *   缩略图是独立 DOM，允许 transform/opacity；reduce-motion 全部降级为淡入淡出。
 * - 与全屏/分屏互斥：html.deskly-fullscreen 时 suspend()（保留分组、摘掉停靠条），
 *   退出后 resume()。台前调度开启期间不允许进入分屏浏览（spaces.enterSplit 查它）。
 * - 设置键（desktop.stage.*）：showRecent / windowMode / showDesktopItems / clickWallpaper，
 *   在系统设置「桌面与程序坞」面板出现；改动经 settings-changed 广播实时生效。
 */

import { Z } from "../zindex.js";
import { records, stack, getVisibleWindows, focusWindow, isMinimized } from "./stack.js";
import { frameOf } from "./frame.js";
import { inSplit, bindSplitGuard } from "./spaces.js";
import { settings } from "../settings.js";
import { i18n } from "../i18n.js";

/** 设置键在这里注册（系统设置「桌面与程序坞」面板按 key 渲染）。 */
const STAGE_KEYS = [
    {
        key: "desktop.stage.showRecent", type: "boolean", default: true,
        control: "switch", pane: "dock", group: "桌面与台前调度", order: 60,
        label: "显示最近使用的应用", event: "stage-show-recent-change", owner: "system",
    },
    {
        key: "desktop.stage.windowMode", type: "string", default: "all", values: ["all", "one"],
        valuesLabel: ["一次全部", "一次一个"],
        control: "segmented", pane: "dock", group: "桌面与台前调度", order: 61,
        label: "显示应用程序窗口", event: "stage-window-mode-change", owner: "system",
    },
    {
        key: "desktop.stage.showDesktopItems", type: "boolean", default: false,
        control: "switch", pane: "dock", group: "桌面与台前调度", order: 62,
        label: "在桌面上显示项目", event: "stage-desktop-items-change", owner: "system",
    },
    {
        key: "desktop.stage.clickWallpaper", type: "string", default: "stageOnly", values: ["always", "stageOnly"],
        valuesLabel: ["始终", "仅台前调度中"],
        control: "segmented", pane: "dock", group: "桌面与台前调度", order: 63,
        label: "点按墙纸显示桌面", event: "stage-click-wallpaper-change", owner: "system",
    },
];
settings.defineMany(STAGE_KEYS);

let enabled = false;
let suspended = false;
/** 组：appKey -> { key, windows: Set<HTMLElement>, anchor: HTMLElement|null, lastUsed: number } */
const sets = new Map();
/** 当前舞台上的组 key。 */
let stageKey = null;
let shelf = null;

/* ── 设置读取 ── */
const conf = () => ({
    showRecent: settings.get("desktop.stage.showRecent", true),
    windowMode: settings.get("desktop.stage.windowMode", "all") === "one" ? "one" : "all",
    showDesktopItems: settings.get("desktop.stage.showDesktopItems", false),
    clickWallpaper: settings.get("desktop.stage.clickWallpaper", "stageOnly"),
});

/** 拖窗并入组的手动归属（§5.1-4）：窗口 -> 目标组键。缺省按应用分组。 */
const forcedGroup = new WeakMap();

/** 分组键：强制归属优先；否则 data-app-id（多窗同应用合一组）；再退回窗口基名（去 #N 实例后缀）。 */
function appKeyOf(el) {
    const forced = forcedGroup.get(el);
    if (forced) return forced;
    return (el.dataset && el.dataset.appId) || String(el.id || "").replace(/#\d+$/, "") || "unknown";
}

/** 可进组的窗口：普通顶层窗、可见、非子窗/模态。 */
function groupable(el) {
    const rec = records.get(el);
    if (!rec || (rec.role && rec.role !== "normal")) return false;
    return true;
}

/** 当前舞台组（可能为 null）。 */
function stageSet() {
    return stageKey ? sets.get(stageKey) || null : null;
}

/* ── 开关 ── */

/**
 * 开关台前调度（控制中心卡片与系统设置开关都到这里）。
 * @param {boolean} on
 */
export function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    if (enabled) enable(); else disable();
}

export function isEnabled() {
    return enabled;
}

/** 诊断读数（探针与 debug 用）：当前分组与舞台归属快照。 */
export function stageState() {
    return {
        enabled,
        stageKey,
        sets: [...sets.values()].map((s) => ({
            key: s.key,
            size: s.windows.size,
            anchor: s.anchor && s.anchor.id,
            lastUsed: s.lastUsed,
        })),
    };
}

function enable() {
    buildSets();
    renderShelf();
    applyDesktopItems();
    listenEvents();
    // 关键顺序：先在所有窗口仍可见时把缩略图拍好，再收起非舞台组。
    // 反过来先隐藏的话，snapdom 对 visibility:hidden 的元素只会输出透明图，
    // 这正是「缩略图是占位图」的根因。拍完立刻 applyStage，用户看不到额外停顿。
    primeSnapshots().finally(() => {
        if (!enabled) return;
        applyStage();
        renderShelf();
    });
}

function disable() {
    // 全部摘下舞台：每个窗口摘 .wm-shelved，停靠条淡出移除
    stack.forEach((el) => el.classList.remove("wm-shelved"));
    sets.clear();
    stageKey = null;
    if (shelf) { shelf.remove(); shelf = null; }
    suspended = false;
    applyDesktopItems();
    unlistenEvents();
}

/** 桌面图标淡出归这里管（controlcenter.applyStageManager 只负责调 setEnabled）。 */
function applyDesktopItems() {
    const desktop = document.getElementById("desktop");
    if (!desktop) return;
    desktop.classList.toggle("stage-manager-on", enabled && !conf().showDesktopItems);
}

/* ── 分组与舞台 ── */

/** 开启瞬间：全部可见非最小化窗口按应用聚组；最近聚焦的组上舞台，其余进停靠。 */
function buildSets() {
    sets.clear();
    const visible = getVisibleWindows().filter(groupable);
    // stack 序即聚焦史：栈尾最近。按从底到顶进组，lastUsed 取递增序号。
    let tick = 0;
    stack.forEach((el) => {
        if (!el.isConnected || isMinimized(el) || !groupable(el)) return;
        if (el.classList.contains("closing")) return;
        const key = appKeyOf(el);
        let set = sets.get(key);
        if (!set) { set = { key, windows: new Set(), anchor: null, lastUsed: 0 }; sets.set(key, set); }
        set.windows.add(el);
        set.anchor = el;          // 栈内越靠上越后赋，最终 anchor = 组内最近聚焦窗
        tick += 1;
        set.lastUsed = tick;
    });
    // 舞台 = lastUsed 最大的组
    let best = null;
    sets.forEach((set) => { if (!best || set.lastUsed > best.lastUsed) best = set; });
    stageKey = best ? best.key : null;
}

/** 给每个组的活体代表补一张缩略图（此刻窗口可见；原生截图或 snapdom 都可行）。 */
function primeSnapshots() {
    const targets = [...sets.values()].map((set) => liveAnchor(set)).filter(Boolean);
    return Promise.all(targets.map((el) => import("./genie-capture.js")
        .then((m) => m.ensureThumbnail(el, frameOf(el)))
        .catch(() => null)));
}

/** 把「不在舞台上的组」摘到停靠区（挂 .wm-shelved），舞台上的组摘回来。 */
function applyStage() {
    if (!enabled) return;
    const stage = stageSet();
    sets.forEach((set) => {
        const onStage = stage && set.key === stage.key;
        set.windows.forEach((el) => {
            if (!el.isConnected) return;
            if (onStage) {
                if (conf().windowMode === "one") {
                    el.classList.toggle("wm-shelved", el !== set.anchor);
                } else {
                    el.classList.remove("wm-shelved");
                }
            } else {
                el.classList.add("wm-shelved");
            }
        });
    });
    updateShelfSelection();
    // 舞台上的组取焦点
    if (stage && stage.anchor && stage.anchor.isConnected && !suspended) {
        focusWindow(stage.anchor);
    }
}

/**
 * 点停靠缩略图切换舞台：该组上舞台（组内窗口摘 .wm-shelved，
 * windowMode=one 时只恢复 anchor；再点一次当前组缩略图时循环组内下一窗口）。
 * @param {string} key
 */
export function activateSet(key) {
    const set = sets.get(key);
    if (!set) return;
    if (key === stageKey) {
        // 再点当前组：one 模式循环组内下一窗口（官方页 7 语义）
        if (conf().windowMode === "one") {
            const wins = [...set.windows].filter((w) => w.isConnected);
            if (wins.length > 1) {
                const i = wins.indexOf(set.anchor);
                set.anchor = wins[(i + 1) % wins.length];
                applyStage();
                focusWindow(set.anchor);
            }
        }
        return;
    }
    stageKey = key;
    set.lastUsed = Date.now();
    applyStage();
}

/**
 * 点按墙纸 = 全部窗口进停靠（显示桌面），再点任一缩略图恢复。
 * 是否生效看 desktop.stage.clickWallpaper（始终 / 仅在台前调度中）。
 */
function wallpaperClick() {
    if (!enabled || suspended) return;
    const c = conf().clickWallpaper;
    if (c !== "always" && c !== "stageOnly") return;
    sets.forEach((set) => set.windows.forEach((el) => el.classList.add("wm-shelved")));
    stageKey = null;
    updateShelfSelection();
}

/* ── 停靠条 ── */

function ensureShelf() {
    if (shelf) return shelf;
    shelf = document.createElement("div");
    shelf.id = "deskly-stage-shelf";
    shelf.style.zIndex = String(Z.STAGE_SHELF);
    shelf.setAttribute("aria-label", i18n.t("stage.shelf", "最近使用的应用"));
    return shelf;
}

function renderShelf() {
    const el = ensureShelf();
    el.innerHTML = "";
    // Dock 左置时停靠条整体上移到 Dock 上方留白区
    const dock = document.getElementsByClassName("dockcontainer")[0];
    const dockLeft = dock && dock.classList.contains("pos-left") ? dock.offsetWidth : 0;
    el.style.left = `${dockLeft ? dockLeft + 8 : 0}px`;
    if (!conf().showRecent) el.classList.add("auto-hide");
    else el.classList.remove("auto-hide");

    // order = lastUsed 降序
    const ordered = [...sets.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    ordered.forEach((set) => {
        const thumb = document.createElement("button");
        thumb.type = "button";
        thumb.className = "sm-thumb";
        thumb.dataset.setKey = set.key;
        const shot = document.createElement("div");
        shot.className = "sm-shot";
        const caption = document.createElement("span");
        caption.className = "sm-caption";
        thumb.appendChild(shot);
        thumb.appendChild(caption);
        // 命中区 = 整个缩略图按钮（图 + 标题），与视觉边界一致
        thumb.addEventListener("click", () => activateSet(set.key));
        el.appendChild(thumb);
        fillThumb(set, shot, caption);
    });
    if (!el.isConnected) document.body.appendChild(el);
    updateShelfSelection();
}

/** 缩略图标题：窗口显示名去掉实例后缀（访达#2 -> 访达）。 */
function captionOf(el) {
    const rec = records.get(el);
    const raw = (rec && rec.name) || el.id || "";
    return raw.replace(/#\d+$/, "") || appKeyOf(el);
}

/**
 * 填充一张缩略图：按窗口实际宽高比等比缩放（不裁边），标题用窗口显示名。
 * 取图走 ensureThumbnail：缓存 -> 原生截图 -> snapdom，因此无原生权限时也有真实画面。
 */
function fillThumb(set, shot, caption) {
    const anchor = liveAnchor(set);
    const name = anchor ? captionOf(anchor) : set.key;
    caption.textContent = name;
    caption.title = name;
    if (!anchor) return;
    const f = frameOf(anchor);
    if (f.w > 0 && f.h > 0) {
        // 极端长条窗口也保留可辨识的形状，但夹在可读范围内（0.55–2.6）
        const ratio = Math.min(2.6, Math.max(0.55, f.w / f.h));
        shot.style.aspectRatio = String(Math.round(ratio * 1000) / 1000);
    }
    import("./genie-capture.js").then((m) => m.ensureThumbnail(anchor, f)).then((snap) => {
        if (!shot.isConnected) return;
        if (snap) {
            shot.innerHTML = "";
            shot.appendChild(snap);
        }
        // 拿不到（窗口此刻不可见且无任何缓存）：保留中性底，下次几何/焦点事件再补。
    }).catch(() => {});
}

/** 组的“活体代表”：anchor 若被关掉或最小化了，换一扇存活的成员窗。 */
function liveAnchor(set) {
    if (set.anchor && set.anchor.isConnected && !isMinimized(set.anchor)) return set.anchor;
    const next = [...set.windows].find((w) => w.isConnected && !isMinimized(w));
    if (next) set.anchor = next;
    return next || (set.anchor && set.anchor.isConnected ? set.anchor : null);
}

/* ── 快照更新策略（停靠缩略图不能永久冻结） ──
 * 触发时机：窗口尺寸/位置/状态收尾事件（resize/move/zoom/tile/fullscreen，均为
 * pointerup 或状态切换时的一次性事件，不是逐帧流）+ 焦点切换 + 入停靠那一刻。
 * 频率：同一组 400ms 节流（连拖窗口只取最后一拍）；快照管线自身再吃缓存，
 * 原生截图可用时实际开销是一次 capture，不可用时命中缓存直接换图。
 * 失效：genie-capture.geometryChanged 已在拖动/缩放收尾作废旧图，这里只负责补拍。 */
const thumbTimers = new Map();
function refreshThumbSoon(appKey) {
    if (!enabled || suspended || !shelf) return;
    if (!sets.has(appKey)) return;
    if (thumbTimers.has(appKey)) return;
    thumbTimers.set(appKey, setTimeout(() => {
        thumbTimers.delete(appKey);
        const thumb = shelf && shelf.querySelector(`.sm-thumb[data-set-key="${appKey}"]`);
        const set = sets.get(appKey);
        if (!thumb || !set) return;
        const shot = thumb.querySelector(".sm-shot");
        const caption = thumb.querySelector(".sm-caption");
        if (shot && caption) fillThumb(set, shot, caption);
    }, 400));
}

function onWindowGeometry(e) {
    const el = e.detail && e.detail.id ? (e.detail.state && e.detail.state.el) : null;
    if (!el) return;
    refreshThumbSoon(appKeyOf(el));
}

function updateShelfSelection() {
    if (!shelf) return;
    shelf.querySelectorAll(".sm-thumb").forEach((t) => {
        t.classList.toggle("on-stage", t.dataset.setKey === stageKey);
    });
}

/* ── 事件：开窗进组、关窗删组、焦点记 lastUsed、全屏挂起 ── */

function onOpen(e) {
    const el = e.detail && e.detail.state && e.detail.state.el;
    if (!enabled || !el || !groupable(el)) return;
    const key = appKeyOf(el);
    // 新打开窗口加入当前舞台组（macOS 默认行为：同应用并入，新应用单独成组上舞台）
    let set = sets.get(key);
    if (!set) { set = { key, windows: new Set(), anchor: null, lastUsed: Date.now() }; sets.set(key, set); }
    set.windows.add(el);
    set.anchor = el;
    set.lastUsed = Date.now();
    stageKey = key;
    applyStage();
    renderShelf();
}

function onClose(e) {
    if (!enabled) return;
    const el = e.detail && e.detail.state && e.detail.state.el;
    if (!el) return;
    const key = appKeyOf(el);
    const set = sets.get(key);
    if (set) {
        set.windows.delete(el);
        if (!set.windows.size) sets.delete(key);
        else if (set.anchor === el) set.anchor = [...set.windows][0];
    }
    // 舞台上的组空了：自动把最近一组升上舞台
    if (stageKey && !sets.has(stageKey)) {
        let best = null;
        sets.forEach((s) => { if (!best || s.lastUsed > best.lastUsed) best = s; });
        stageKey = best ? best.key : null;
    }
    applyStage();
    renderShelf();
}

function onFocus(e) {
    if (!enabled || suspended) return;
    const el = e.detail && e.detail.id
        ? (e.detail.state && e.detail.state.el) : null;
    if (!el) return;
    const key = appKeyOf(el);
    const set = sets.get(key);
    if (!set) return;
    set.anchor = el;
    set.lastUsed = Date.now();
    refreshThumbSoon(key);
    // 点了停靠区里「漏出来」的窗口（不该发生，但点击穿透时兜底）：把它所在组升上舞台
    if (key !== stageKey && !el.classList.contains("wm-shelved")) {
        stageKey = key;
        applyStage();
    }
    renderShelfOrder();
}

function renderShelfOrder() {
    // lastUsed 变了只重排，不整棵重建（缩略图 DOM 保留，截图不白重截）
    if (!shelf) return;
    const ordered = [...sets.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    ordered.forEach((set) => {
        const thumb = shelf.querySelector(`.sm-thumb[data-set-key="${set.key}"]`);
        if (thumb) shelf.appendChild(thumb);
    });
    updateShelfSelection();
}

/** 全屏/分屏互斥：html.deskly-fullscreen 变化时 suspend/resume。 */
const classObserver = new MutationObserver(() => {
    if (!enabled) return;
    const fs = document.documentElement.classList.contains("deskly-fullscreen");
    if (fs === suspended) return;
    suspended = fs;
    if (suspended) {
        // 离台：保留 sets，摘掉停靠呈现与非舞台隐藏（全屏空间里窗口都该可用）
        stack.forEach((el) => el.classList.remove("wm-shelved"));
        if (shelf) shelf.classList.add("suspended");
    } else {
        if (shelf) shelf.classList.remove("suspended");
        applyStage();
    }
});

let listening = false;
/** 拖窗并入组（§5.1-4）：把窗口改挂到目标组；key 为空 = 恢复按应用分组（拖到空白处）。 */
function mergeWindowInto(el, key) {
    if (!el) return;
    const from = appKeyOf(el);
    if (key && from !== key) forcedGroup.set(el, key);
    else if (!key) forcedGroup.delete(el);
    else return;
    const prev = stageKey;
    buildSets();
    if (key && sets.has(key)) activateSet(key);
    else if (prev && sets.has(prev)) activateSet(prev);
    else { applyStage(); renderShelf(); }
}

/** 指针落点（捕获阶段记录）：window:move 在 pointerup 之后才派发，靠它判断是不是拖进停靠区。 */
let lastDragUp = null;

function onMoveEnd(e) {
    onWindowGeometry(e);
    if (!enabled || !lastDragUp || Date.now() - lastDragUp.t > 600) return;
    const drop = lastDragUp;
    lastDragUp = null;
    const el = e.detail && e.detail.id ? document.getElementById(e.detail.id) : null;
    if (!el || typeof document.elementFromPoint !== "function") return;
    let hit = null;
    try { hit = document.elementFromPoint(drop.x, drop.y); } catch { return; }
    if (!hit || typeof hit.closest !== "function") return;
    const thumb = hit.closest(".sm-thumb");
    if (thumb && thumb.dataset && thumb.dataset.setKey) mergeWindowInto(el, thumb.dataset.setKey);
    else if (hit.closest("#deskly-stage-shelf")) mergeWindowInto(el, "");
}

function onDocPointerUp(e) {
    lastDragUp = { x: e.clientX, y: e.clientY, t: Date.now() };
}

function listenEvents() {
    if (listening) return;
    listening = true;
    document.addEventListener("window:open", onOpen);
    document.addEventListener("window:close", onClose);
    document.addEventListener("window:focus", onFocus);
    // 缩略图活性：几何与状态收尾时按组节流补拍；最小化时换组内活体代表
    ["window:resize", "window:zoom", "window:tile"].forEach((t) =>
        document.addEventListener(t, onWindowGeometry));
    // move 收尾额外做「拖到停靠区并入组」判定
    document.addEventListener("window:move", onMoveEnd);
    document.addEventListener("pointerup", onDocPointerUp, true);
    document.addEventListener("window:minimize", onMinimizeRestore);
    document.addEventListener("window:restore", onMinimizeRestore);
    document.addEventListener("stage-show-recent-change", renderShelf);
    document.addEventListener("stage-window-mode-change", applyStage);
    document.addEventListener("stage-desktop-items-change", applyDesktopItems);
    classObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // 点按墙纸显示桌面
    document.addEventListener("click", (e) => {
        if (!enabled) return;
        const desktop = document.getElementById("desktop");
        if (desktop && e.target === desktop) wallpaperClick();
    }, true);
}

/** 最小化/还原：重选组内活体代表并补拍（最小化窗口不顶在缩略图门面位置）。 */
function onMinimizeRestore(e) {
    if (!enabled) return;
    const el = e.detail && e.detail.id ? (e.detail.state && e.detail.state.el) : null;
    if (!el) return;
    const key = appKeyOf(el);
    const set = sets.get(key);
    if (!set) return;
    liveAnchor(set);
    refreshThumbSoon(key);
}

function unlistenEvents() {
    if (!listening) return;
    listening = false;
    document.removeEventListener("window:open", onOpen);
    document.removeEventListener("window:close", onClose);
    document.removeEventListener("window:focus", onFocus);
    ["window:resize", "window:zoom", "window:tile"].forEach((t) =>
        document.removeEventListener(t, onWindowGeometry));
    document.removeEventListener("window:move", onMoveEnd);
    document.removeEventListener("pointerup", onDocPointerUp, true);
    document.removeEventListener("window:minimize", onMinimizeRestore);
    document.removeEventListener("window:restore", onMinimizeRestore);
    document.removeEventListener("stage-show-recent-change", renderShelf);
    document.removeEventListener("stage-window-mode-change", applyStage);
    document.removeEventListener("stage-desktop-items-change", applyDesktopItems);
    classObserver.disconnect();
}

// 分屏浏览与台前调度互斥由 spaces.js 侧查本闸完成（那里是入口）。
bindSplitGuard(() => enabled);

// 系统动作：聚焦搜索可检索的开关。状态源唯一 —— 设置键 controlcenter.stage，
// 控制中心卡片、设置面板开关、这条动作写的是同一个键（双向一致由 controlcenter 的回写链保证）。
import { registerSystemAction } from "../system-actions.js";
registerSystemAction({
    id: "toggleStageManager",
    label: "切换台前调度",
    sub: "控制中心",
    group: "window",
    aliases: ["stage manager", "台前调度", "调度", "stage", "toggle stage"],
    available: () => true,
    run: () => settings.set("controlcenter.stage", !settings.get("controlcenter.stage", false)),
});
