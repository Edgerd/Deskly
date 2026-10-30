/**
 * script.js — 启动台插件逻辑（重写版）
 *
 * 功能：
 * - 实时模糊背景：根元素 backdrop-filter 直接取样桌面，不再复制壁纸
 * - 搜索：实时过滤应用与文件夹（含文件夹内应用），Enter 打开首个结果
 * - 排序：指针拖拽 + 让位（落点之后的整排腾出一格，空位跟着指针走），位置持久化
 * - 文件夹：应用拖到应用上合并、拖到文件夹上加入、文件夹内拖出还原；3×3 预览
 *   文件夹是 state.items 里的原对象，渲染只过滤禁用成员，禁止返回副本（否则改名/拖拽不落盘）
 * - 重命名：文件夹展开后点标题输入框 / 右键菜单（应用改显示名，文件夹改文件夹名）
 *   编辑模式下双击标签也可进入行内重命名
 * - 打开动画：图标从原位放大飞向屏幕中心，与启动台淡出并行
 * - 光标：引用内核 --deskly-cursor*（style.css），随操作在箭头/手指间切换
 *
 * 兼容约束（勿改）：
 * - 根元素必须是 .launchpad（plugin-manager 的 fullscreen 入口按类名识别）
 * - window.__launchpad / window.specialCloses / appStatus / Dock 指示灯同步
 * - plugin-unload 时自清 window 级监听
 */

import { listApps, openApp, load as loadPlugin, unload, getIconForName, isPluginEnabled, GENERIC_APP_ICON } from '../../src/javascripts/plugin-manager.js';
import { displayNameFor } from '../../src/javascripts/app-registry.js';
import { updateMenu } from '../../src/javascripts/finderbar.js';
import { addToDock } from '../../src/javascripts/dock.js';

// 取最后一个 .launchpad（最新注入的实例），避免 reopen 时 DOM 中仍残留旧实例导致引用错位
const _allLaunchpads = document.querySelectorAll(".launchpad");
const launchpad = _allLaunchpads[_allLaunchpads.length - 1];
const gridScroll = launchpad.querySelector(".grid-scroll");
const grid = launchpad.querySelector(".grid");
const emptyTip = launchpad.querySelector(".empty-tip");
const searchInput = launchpad.querySelector(".search-input");
const folderLayer = launchpad.querySelector(".folder-layer");
const folderPanel = launchpad.querySelector(".folder-panel");
const folderTitleInput = launchpad.querySelector(".folder-title");
const folderGrid = launchpad.querySelector(".folder-grid");
const ctxMenu = launchpad.querySelector(".ctx-menu");
const pageDots = launchpad.querySelector(".page-dots");

// 布局持久化：v2 结构 { items: [app 条目 | 文件夹条目], labels: {应用名: 显示名} }
// 应用条目形如 {type:'app', name}；文件夹条目形如 {type:'folder', name, apps:[应用名]}
// 旧版只存应用名数组（webstartos_launchpad_order），读到时迁移
const LAYOUT_KEY = "webstartos_launchpad_layout_v2";
const LEGACY_ORDER_KEY = "webstartos_launchpad_order";
// 关闭动画时长（ms）：与 style.css 的 launchpad-out / launchpad-fade-out 保持一致
const CLOSE_MS = 300;
// 指针位移超过该值才判定为拖拽（否则是点击）
const DRAG_THRESHOLD = 6;
// 让位场：以指针为中心的"海水让开"。横向半径大、纵向半径小 → 指针处开出一条竖缝，
// 上下两行只轻让，整屏不会跟着翻。强度用余弦衰减（贴身处最强、到半径边缘平滑归零）。
// 被指针压住那一格免疫（只留 10%）：它稳住不动，你才瞄得准；邻居让开，才读得出"让地方"。
const PART_RX_K = 2.4;   // 横向影响半径 = 格宽 × 2.4
const PART_RY_K = 1.6;   // 纵向影响半径 = 格宽 × 1.6
const PART_MAX_K = 0.6;  // 贴身处位移 = 格宽 × 0.6
const PART_KEEP = 0.1;   // 指针下那格的免疫系数
const PART_RIPPLE_MS = 45;   // 由近及远的错峰延迟上限，制造涟漪感
// 文件夹浮层关闭动画时长（ms）：与 style.css 的 folder-pop-out 一致
const FOLDER_CLOSE_MS = 200;
// 图标/文字尺寸设置（存储槽与 settings-definitions.js 的 launchpad.* 对齐）
const SIZE_CONF = [
    { slot: "launchpad-icon-size", cssVar: "--lp-icon", def: 84, min: 56, max: 128 },
    { slot: "launchpad-font-size", cssVar: "--lp-font", def: 13, min: 10, max: 20 },
];

// 跨多次打开共享的关闭锁状态：每次打开都会注入新的 script 模块实例，
// 模块级变量无法跨实例共享，故提升到 window 上
const LP_STATE = (window.__lpState = window.__lpState || { isClosing: false });

// 状态：items 为有序布局，apps 为注册表应用映射（name -> {name, appId, icon, centered}），
// labels 为应用自定义显示名（独立于 items：应用移进文件夹后条目只剩名字，label 不能挂在条目上）
const state = { items: [], apps: new Map(), labels: {} };
let openFolderItem = null;   // 当前展开的文件夹（指向 state.items 里的引用）
let keyword = "";
let isDragging = false;
let suppressNextClick = false;
let press = null;            // 进行中的按压/拖拽会话
let editMode = false;        // 编辑模式（长按进入）：图标摇晃，点击不打开应用
let zoomLayer = null;        // 开屏动画图标克隆层
// 让位场状态：dodgeCells 为拖拽开始时快照的其余格子基准矩形（兼作命中测试与落点计算）
let dodgeCells = [];
let dodgeCellW = 128;
// 横向分页状态：页数、当前页、按图标/视口算出的行列容量
let pageCount = 1;
let currentPage = 0;
let gridMetrics = { cols: 7, rows: 4, capacity: 28 };
let pageScrollRaf = 0;
let lastWheelAt = 0;
let lastAutoTurn = 0;
let dodgeScope = null;
let dodgeFrame = 0;
let folderCloseTimer = null; // 文件夹关闭动画计时器

/* ─────────────── 布局持久化 ─────────────── */

function loadLayout() {
    try {
        const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY));
        if (raw && Array.isArray(raw.items)) return raw;
    } catch (e) { /* 损坏则回退 */ }
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY));
        if (Array.isArray(legacy) && legacy.length) {
            return { items: legacy.map((n) => ({ type: "app", name: String(n) })), labels: {} };
        }
    } catch (e) { /* 损坏则回退 */ }
    return null;
}

function saveLayout() {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ items: state.items, labels: state.labels }));
    } catch (e) { /* 忽略存储失败 */ }
}

/* ─────────────── 应用清单 ─────────────── */

// 组装注册表应用：按 appId 展开插件（entry=window），多应用插件每个子应用各占一格
function readRegistryApps() {
    return listApps()
        .filter((rec) => {
            const type = (rec.app && rec.app.type) || rec.manifest.type;
            const entry = (rec.app && rec.app.entry) || rec.manifest.entry;
            return type === "app" && entry === "window";
        })
        .map((rec) => ({
            name: rec.windowName,
            icon: getIconForName(rec.appId),
            appId: rec.appId,
            // 禁用的应用仍留在注册表映射里（布局按名字对账，剔掉会丢文件夹归属），
            // 只是不渲染；重新启用后回到原来的位置。
            disabled: !isPluginEnabled(rec.id),
            centered: !!((rec.app && rec.app.window && rec.app.window.centered)
                || (rec.manifest.window && rec.manifest.window.centered)),
        }));
}

// 用注册表对账持久化布局：消失的应用剔除、只剩一个成员的文件夹解散、新应用追加到末尾
function buildState() {
    const apps = readRegistryApps();
    state.apps = new Map(apps.map((a) => [a.name, a]));
    const stored = loadLayout();
    if (stored) state.labels = stored.labels || {};
    const items = stored ? stored.items : apps.map((a) => ({ type: "app", name: a.name }));
    const cleaned = [];
    const seen = new Set();
    const markApp = (n) => seen.add(`app:${n}`);

    for (const it of items) {
        if (it.type === "app") {
            if (state.apps.has(it.name) && !seen.has(`app:${it.name}`)) {
                cleaned.push(it);
                markApp(it.name);
            }
        } else if (it.type === "folder" && Array.isArray(it.apps)) {
            it.apps = it.apps.filter((n) => state.apps.has(n));
            if (it.apps.length === 1) {
                if (!seen.has(`app:${it.apps[0]}`)) {
                    cleaned.push({ type: "app", name: it.apps[0] });
                    markApp(it.apps[0]);
                }
            } else if (it.apps.length >= 2 && !seen.has(`folder:${it.name}`)) {
                cleaned.push(it);
                seen.add(`folder:${it.name}`);
                it.apps.forEach(markApp);
            }
        }
    }
    // 注册表里有、布局里没有的（新安装）追加到末尾
    for (const a of apps) {
        if (!seen.has(`app:${a.name}`)) {
            cleaned.push({ type: "app", name: a.name });
            markApp(a.name);
        }
    }
    state.items = cleaned;
    saveLayout();
}

/* ─────────────── 渲染 ─────────────── */

function makeIconImg(app) {
    const img = document.createElement("img");
    img.src = (app && app.icon) || GENERIC_APP_ICON;
    img.alt = (app && app.name) || "";
    img.draggable = false;
    img.addEventListener("error", () => { img.src = GENERIC_APP_ICON; });
    return img;
}

function makeCell(item, scope) {
    const cell = document.createElement("div");
    cell.className = "container";
    cell.dataset.kind = item.type;
    cell.dataset.name = item.type === "app" ? item.name : `folder:${item.name}`;

    if (item.type === "app") {
        cell.appendChild(makeIconImg(state.apps.get(item.name)));
    } else {
        const tile = document.createElement("div");
        tile.className = "folder-tile";
        // 九枚迷你图标只是「文件夹长什么样」的装饰；可读信息由下方文件夹名承担。
        tile.setAttribute("aria-hidden", "true");
        // 3×3 预览：最多九枚；禁用成员不参与预览（与展开后的文件夹一致）
        visibleAppsOf(item).slice(0, 9).forEach((n) => tile.appendChild(makeIconImg(state.apps.get(n))));
        cell.appendChild(tile);
    }
    const p = document.createElement("p");
    p.textContent = item.type === "app" ? cellLabel(item.name) : item.name;
    cell.appendChild(p);

    cell.addEventListener("pointerdown", (e) => beginPress(e, item, scope, cell));
    p.addEventListener("dblclick", () => startRename(item));
    cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCtxMenu(e.clientX, e.clientY, item);
    });
    return cell;
}

/**
 * 根网格渲染：按当前容量把可见条目切成若干横页。
 * 每页一个 .grid-page（正好一屏宽）+ .page-grid（真正的图标网格）。
 * @param {{resetToFirst?: boolean}} [opts] resetToFirst=true 用于搜索，回到第一页
 */
function renderRoot(opts = {}) {
    const list = visibleItems(searchResults());
    const capacity = Math.max(1, gridMetrics.capacity);
    pageCount = Math.max(1, Math.ceil(list.length / capacity));
    if (opts.resetToFirst) currentPage = 0;
    currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));

    grid.innerHTML = "";
    for (let p = 0; p < pageCount; p += 1) {
        const page = document.createElement("div");
        page.className = "grid-page";
        page.dataset.page = String(p);
        const pageGrid = document.createElement("div");
        pageGrid.className = "page-grid";
        list.slice(p * capacity, (p + 1) * capacity)
            .forEach((it) => pageGrid.appendChild(makeCell(it, "root")));
        page.appendChild(pageGrid);
        grid.appendChild(page);
    }

    alignPageScroll(currentPage);
    updatePageDots();
    emptyTip.hidden = list.length > 0;
    if (editMode) applyJiggle(grid);
}

/** 一页的宽度（= 可视区宽）。扩展页刚注入时可能读到 0，退回视口宽。 */
function pageWidth() {
    return gridScroll.clientWidth || window.innerWidth || 1;
}

/** 把横向滚动对齐到指定页；重建页后必须做，否则 scrollLeft 会停在旧页宽上。 */
function alignPageScroll(page) {
    const left = page * pageWidth();
    if (Math.abs(gridScroll.scrollLeft - left) > 1) gridScroll.scrollLeft = left;
}

/** 当前页的 .page-grid（拖拽快照与落点判定都在这一页内进行）。 */
function currentPageGrid() {
    const page = grid.querySelector(`.grid-page[data-page="${currentPage}"]`);
    return page ? page.querySelector(".page-grid") : null;
}

/** 页码点：按页数增删，只保留 active 状态；单页时整组隐藏。 */
function updatePageDots() {
    if (!pageDots) return;
    updatePageDotsPosition();
    pageDots.hidden = pageCount <= 1;
    if (pageCount <= 1) {
        pageDots.textContent = "";
        return;
    }
    while (pageDots.childElementCount < pageCount) {
        const dot = document.createElement("span");
        dot.className = "page-dot";
        dot.dataset.page = String(pageDots.childElementCount);
        pageDots.appendChild(dot);
    }
    while (pageDots.childElementCount > pageCount) pageDots.lastElementChild.remove();
    Array.from(pageDots.children).forEach((dot, i) => dot.classList.toggle("active", i === currentPage));
}

/**
 * 页码点贴到程序坞上方：程序坞尺寸/位置可设置，固定 bottom 在大 Dock 下会重叠。
 * 只在底部 Dock 可见时按 Dock 顶边算；侧边 Dock 或读不到尺寸时退回默认 88px。
 */
function updatePageDotsPosition() {
    if (!pageDots) return;
    const dock = document.getElementById("dock");
    const r = dock && dock.isConnected ? dock.getBoundingClientRect() : null;
    let bottom = 88;
    if (r && r.height > 0 && r.top > window.innerHeight * 0.5 && r.bottom > window.innerHeight * 0.8) {
        bottom = Math.max(24, window.innerHeight - r.top + 12);
    }
    pageDots.style.bottom = `${Math.round(bottom)}px`;
}

/**
 * 跳到指定页：页码点立即反映目标页，滚动按系统「减少动态效果」决定是否平滑。
 * 拖拽中的自动翻页必须走 behavior:"auto"，否则指针下的矩形会在滚动途中失真。
 * @param {number} page 目标页（会被夹到合法范围）
 * @param {{behavior?: "auto"|"smooth"}} [opts]
 */
function goToPage(page, opts = {}) {
    if (pageCount <= 1) {
        currentPage = 0;
        updatePageDots();
        return;
    }
    const target = Math.max(0, Math.min(pageCount - 1, page));
    const reduce = document.documentElement.dataset.reduceMotion === "on";
    const behavior = opts.behavior || "smooth";
    currentPage = target;
    updatePageDots();
    const left = target * pageWidth();
    if (behavior === "smooth" && !reduce && typeof gridScroll.scrollTo === "function") {
        gridScroll.scrollTo({ left, behavior: "smooth" });
    } else {
        gridScroll.scrollLeft = left;
    }
}

/** 滚动位置 -> 当前页；滚动事件合帧后再更新，避免程序化平滑滚动时反复改状态。 */
function syncPageFromScroll() {
    if (pageScrollRaf) return;
    pageScrollRaf = requestAnimationFrame(() => {
        pageScrollRaf = 0;
        const next = Math.max(0, Math.min(pageCount - 1, Math.round(gridScroll.scrollLeft / pageWidth())));
        if (next !== currentPage) {
            currentPage = next;
            updatePageDots();
        }
        // 拖拽过程中页面若被翻动，让位快照要跟着切到新页，否则落点仍按旧页算。
        if (press && press.moved && press.scope === "root") syncDragPage();
    });
}

/**
 * 拖拽到屏幕左右边缘时自动翻页（macOS 启动台拖 App 跨页的核心手势）。
 * 500ms 冷却避免指针贴着边缘一路狂翻；翻页走 behavior:"auto"，
 * 这样 snapshotDodge 拿到的矩形就是新页的最终位置。
 */
function maybeAutoTurnPage(x) {
    if (!press || press.scope !== "root" || !press.moved || pageCount <= 1) return;
    const now = performance.now();
    if (now - lastAutoTurn < 500) return;
    const edge = 36;
    let dir = 0;
    if (x < edge) dir = -1;
    else if (x > window.innerWidth - edge) dir = 1;
    if (!dir) return;
    const target = currentPage + dir;
    if (target < 0 || target >= pageCount) return;
    lastAutoTurn = now;
    goToPage(target, { behavior: "auto" });
    syncDragPage();
}

/** 拖拽中的页面切换：重新快照当前页的格子，并清掉上一页的让位位移。 */
function syncDragPage() {
    if (!press || !press.moved || press.scope !== "root") return;
    const pg = currentPageGrid();
    if (!pg || pg === press.scopeGrid) return;
    clearDodge();
    press.scopeGrid = pg;
    snapshotDodge(pg, press.cell);
    scheduleDodge(dodgePointer.x, dodgePointer.y);
}

// 应用是否仍启用（禁用的不渲染、不参与文件夹预览）
function appEnabled(name) {
    const app = state.apps.get(name);
    return !(app && app.disabled);
}

// 文件夹的可见成员。返回新数组，供渲染与拖拽排序使用；
// 注意：它只用于展示，成员归属的权威始终是 state.items 里的原文件夹对象。
function visibleAppsOf(item) {
    return (item.apps || []).filter(appEnabled);
}

// 禁用的应用不进启动台：点了没有窗口，比看不见更让人怀疑系统坏了。
// 文件夹只统计可见成员，全禁用时整个文件夹隐藏，只剩一个时平铺成应用格。
function visibleItems(items) {
    const out = [];
    for (const it of items) {
        if (it.type === "app") {
            if (appEnabled(it.name)) out.push(it);
            continue;
        }
        const live = visibleAppsOf(it);
        // 文件夹必须是 state.items 里的原对象，不能返回副本：
        // 返回副本后，改名 / 拖入拖出 / 解散都只改到副本，saveLayout() 序列化的
        // 仍是旧对象，表现为「文件夹改不了名字」以及成员变更刷新后丢失。
        if (live.length === 1) out.push({ type: "app", name: live[0] });
        else if (live.length > 1) out.push(it);
    }
    return out;
}

// 搜索态结果：应用匹配显示名，文件夹匹配名字或内部任一应用（后者展开成应用平铺）
function searchResults() {
    if (!keyword) return state.items;
    const out = [];
    const seen = new Set();
    const pushApp = (name) => {
        if (!seen.has(name)) { seen.add(name); out.push({ type: "app", name }); }
    };
    for (const it of state.items) {
        if (it.type === "app") {
            if (cellLabel(it.name).toLowerCase().includes(keyword)) pushApp(it.name);
        } else {
            if (it.name.toLowerCase().includes(keyword)) { out.push(it); continue; }
            it.apps.forEach((n) => {
                const app = state.apps.get(n);
                if (app && app.name.toLowerCase().includes(keyword)) pushApp(n);
            });
        }
    }
    return out;
}

/* ─────────────── 编辑模式（长按摇晃） ─────────────── */

// 给网格内所有图标加 .jiggle，并内联随机 duration/delay（负延迟让各图标处于不同相位）
function applyJiggle(root) {
    root.querySelectorAll(".container").forEach((cell) => {
        cell.classList.add("jiggle");
        cell.querySelectorAll("img").forEach((img) => {
            img.style.animationDuration = `${(0.24 + Math.random() * 0.16).toFixed(3)}s`;
            img.style.animationDelay = `${(-Math.random() * 0.4).toFixed(3)}s`;
        });
    });
}

function enterEditMode() {
    if (editMode || !launchpad.isConnected) return;
    editMode = true;
    applyJiggle(grid);
    if (openFolderItem) applyJiggle(folderGrid);
}

function exitEditMode() {
    if (!editMode) return;
    editMode = false;
    [grid, folderGrid].forEach((root) => {
        root.querySelectorAll(".container").forEach((cell) => {
            cell.classList.remove("jiggle");
            cell.querySelectorAll("img").forEach((img) => {
                img.style.animationDuration = "";
                img.style.animationDelay = "";
            });
        });
    });
}

/* ─────────────── 拖拽（指针事件，非 HTML5 DnD） ─────────────── */

function cellLabel(appName) {
    // 用户自定义标题优先；否则显示当前语言名。item.name（身份、布局持久化的键）始终是中文原名不变
    return state.labels[appName] || displayNameFor(appName);
}

function makeGhost(item, sampleCell) {
    const ghost = sampleCell.cloneNode(true);
    ghost.classList.remove("container", "dragging", "merge-hint");
    ghost.classList.add("drag-ghost");
    ghost.querySelector("p")?.remove();
    const p = document.createElement("p");
    p.textContent = item.type === "app" ? cellLabel(item.name) : item.name;
    ghost.appendChild(p);
    return ghost;
}

function beginPress(e, item, scope, cell) {
    if (press) return;                   // 上一次按压会话未结束（防指针重复按下叠加监听）
    if (e.button !== 0) return;
    if (e.target.closest("input")) return;
    // 搜索态允许按压（pointerup 触发点击打开），但禁止拖拽
    press = {
        item, scope, cell, x0: e.clientX, y0: e.clientY,
        moved: false, ghost: null, noDrag: !!keyword, longPressTimer: null,
        // 根网格按页划分：让位/命中只在本页做，跨页由自动翻页重拍快照。
        scopeGrid: scope === "folder" ? folderGrid : (cell.closest(".page-grid") || grid),
    };
    // 长按 600ms 且未拖动 → 进入编辑模式（摇晃）；已在编辑模式或搜索态时不重复触发
    if (!editMode && !keyword) {
        press.longPressTimer = setTimeout(() => {
            press.longPressTimer = null;
            if (press && !press.moved) enterEditMode();
        }, 600);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
}

function onPointerMove(e) {
    if (!press || press.noDrag) return;
    const dx = e.clientX - press.x0;
    const dy = e.clientY - press.y0;
    if (!press.moved) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
        press.moved = true;
        if (press.longPressTimer) { clearTimeout(press.longPressTimer); press.longPressTimer = null; }
        isDragging = true;
        press.ghost = makeGhost(press.item, press.cell);
        launchpad.appendChild(press.ghost);
        press.cell.classList.add("dragging");
        launchpad.classList.add("drag-cursor");
        // 躲闪与命中都基于此刻的基准矩形：位移是纯视觉效果，不参与落点计算
        snapshotDodge(press.scopeGrid, press.cell);
    }
    press.ghost.style.left = `${e.clientX}px`;
    press.ghost.style.top = `${e.clientY}px`;
    scheduleDodge(e.clientX, e.clientY);
    maybeAutoTurnPage(e.clientX);
}

function onPointerUp(e) {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!press) return;
    const d = press;
    press = null;
    if (d.longPressTimer) { clearTimeout(d.longPressTimer); d.longPressTimer = null; }
    clearMergeHint(d.scopeGrid);
    if (!d.moved) {
        // 编辑模式下点击图标不打开应用（点击空白退出编辑模式）
        if (!editMode) activate(d.item, d.cell.querySelector("img"));
        return;
    }
    isDragging = false;
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 150);
    d.ghost.remove();
    d.cell.classList.remove("dragging");
    launchpad.classList.remove("drag-cursor");
    endDrag(d, e.clientX, e.clientY);
}

/* ─────────────── 让位场（海水让开） ─────────────── */

// 拖拽开始时快照其余格子的基准矩形。位移是纯视觉效果，落点判定一律用基准矩形，
// 所以"光标下看到的格子"与"命中的格子"始终是同一批 —— 上一版整排平移时两者会错位，很难瞄
function snapshotDodge(scopeGrid, excludeEl) {
    dodgeScope = scopeGrid;
    dodgeCells = Array.from(scopeGrid.querySelectorAll(".container"))
        .filter((c) => c !== excludeEl)
        .map((c) => {
            const r = c.getBoundingClientRect();
            return {
                el: c, kind: c.dataset.kind, rect: r,
                cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                ox: 0, oy: 0, dd: -1,
            };
        });
    dodgeCellW = dodgeCells.length ? dodgeCells[0].rect.width : 128;
    scopeGrid.classList.add("dodging");
}

// 指针事件可以很密，让位每帧只算一次（rAF 句柄与最新指针位置分开存）
let dodgePointer = { x: 0, y: 0 };
function scheduleDodge(x, y) {
    dodgePointer = { x, y };
    if (dodgeFrame) return;
    dodgeFrame = requestAnimationFrame(() => {
        dodgeFrame = 0;
        applyDodge(dodgePointer.x, dodgePointer.y);
    });
}

function applyDodge(x, y) {
    if (!dodgeCells.length) return;
    const rx = dodgeCellW * PART_RX_K;
    const ry = dodgeCellW * PART_RY_K;
    const P = dodgeCellW * PART_MAX_K;
    const over = hitSnap(x, y);
    const consuming = !!press && press.scope === "root" && press.item.type === "app"
        && !!over && (over.kind === "app" || over.kind === "folder");
    for (const c of dodgeCells) {
        const dx = c.cx - x;
        const dy = c.cy - y;
        // 椭圆等值距离：横向算得"近"、纵向算得"远" → 让位呈竖缝状
        const e = Math.hypot(dx / rx, dy / ry);
        let ox = 0;
        let oy = 0;
        let dd = 0;
        if (e < 1) {
            // 余弦衰减：贴身最强、边缘平滑归零，不会看到"跳一格"
            let push = P * 0.5 * (1 + Math.cos(Math.PI * e));
            if (over === c) push *= PART_KEEP;   // 指针下那格稳住，才瞄得准
            const n = Math.hypot(dx, dy) || 1;   // 方向用真实方向，位移才不会歪
            ox = (dx / n) * push;
            oy = (dy / n) * push;
            // 由近及远的错峰：涟漪感来自邻居慢半拍，而不是所有格子齐步走
            dd = Math.min(PART_RIPPLE_MS, e * PART_RIPPLE_MS * 1.7);
        }
        // 亚像素抖动不值得写样式，省掉大量 style invalidation
        if (Math.abs(ox - c.ox) > 0.35 || Math.abs(oy - c.oy) > 0.35) {
            c.ox = ox;
            c.oy = oy;
            c.el.style.setProperty("--dx", `${ox.toFixed(1)}px`);
            c.el.style.setProperty("--dy", `${oy.toFixed(1)}px`);
        }
        if (Math.abs(dd - c.dd) > 6) {
            c.dd = dd;
            c.el.style.setProperty("--dd", `${dd.toFixed(0)}ms`);
        }
    }
    updateMergeHint(over, consuming);
}

function clearDodge() {
    if (dodgeFrame) { cancelAnimationFrame(dodgeFrame); dodgeFrame = 0; }
    dodgeCells.forEach((c) => {
        if (c.ox || c.oy || c.dd) {
            c.el.style.setProperty("--dx", "0px");
            c.el.style.setProperty("--dy", "0px");
            c.el.style.setProperty("--dd", "0ms");
            c.ox = 0;
            c.oy = 0;
            c.dd = 0;
        }
    });
    const scope = dodgeScope;
    dodgeScope = null;
    dodgeCells = [];
    // 回位动画由 FLIP 的 .flip 类承担，这里立刻摘掉 will-change，不留常驻合成层
    if (scope) scope.classList.remove("dodging");
}

// 命中测试用基准矩形（被拖那格已在快照时排除）
function hitSnap(x, y) {
    for (const c of dodgeCells) {
        const r = c.rect;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c;
    }
    return null;
}

// 落点序号：其余格子中位于指针之前的个数（行主序），即 moveItem 需要的插入位
function insertionIndexSnap(x, y) {
    let idx = 0;
    for (const c of dodgeCells) {
        const r = c.rect;
        const sameRow = Math.abs(c.cy - y) < r.height / 2;
        if (sameRow ? c.cx < x : c.cy < y) idx++;
    }
    return idx;
}

function updateMergeHint(over, consuming) {
    clearMergeHint(press ? press.scopeGrid : grid);
    if (consuming && over) over.el.classList.add("merge-hint");
}

function clearMergeHint(scope) {
    if (scope) scope.querySelectorAll(".merge-hint").forEach((c) => c.classList.remove("merge-hint"));
}

// 重建网格时用 FLIP：先记下每格当前视觉位置（含躲闪位移），重建后再反相播回，
// 图标便从躲开的位置滑入新秩序，而不是瞬跳
const FLIP_MS = 240;

function captureVisual() {
    const map = new Map();
    launchpad.querySelectorAll(".container").forEach((c) => {
        const r = c.getBoundingClientRect();
        map.set(`${c.dataset.kind}|${c.dataset.name}`, { left: r.left, top: r.top });
    });
    return map;
}

function renderWithFlip(before, run) {
    run();
    if (!before) return;
    const plan = [];
    // 先只读：拿到重建后的位置（读写交替会逐格触发强制重排）
    launchpad.querySelectorAll(".container").forEach((c) => {
        const old = before.get(`${c.dataset.kind}|${c.dataset.name}`);
        if (!old) return;
        const r = c.getBoundingClientRect();
        const dx = old.left - r.left;
        const dy = old.top - r.top;
        if (dx || dy) plan.push({ c, dx, dy });
    });
    if (!plan.length) return;
    // 再只写：反相到旧位置，一次样式提交作为过渡起点，然后归零播放
    plan.forEach(({ c, dx, dy }) => {
        c.classList.add("flip");
        c.style.setProperty("--dx", `${dx}px`);
        c.style.setProperty("--dy", `${dy}px`);
    });
    void launchpad.offsetWidth;
    plan.forEach(({ c }) => {
        c.style.setProperty("--dx", "0px");
        c.style.setProperty("--dy", "0px");
    });
    setTimeout(() => plan.forEach(({ c }) => c.classList.remove("flip")), FLIP_MS + 80);
}

function endDrag(d, x, y) {
    // 先记录视觉位置（此刻图标正躲闪中），后面的重建据此做 FLIP
    const before = captureVisual();
    if (d.scope === "folder" && !openFolderItem) {
        // 拖拽中文件夹被关闭（如 Esc）：丢弃本次拖拽，只收尾视觉
        clearDodge();
        renderWithFlip(before, renderRoot);
        return;
    }
    if (d.scope === "folder" && !inRect(folderPanel.getBoundingClientRect(), x, y)) {
        // 拖出文件夹面板：应用移回根网格。根网格此刻没有躲闪位移，用实时矩形算插入位
        clearDodge();
        const folder = openFolderItem;
        folder.apps = folder.apps.filter((n) => n !== d.item.name);
        const rootIndex = insertionIndex(Array.from(grid.querySelectorAll(".container")), x, y);
        const at = state.items.indexOf(folder);
        state.items.splice(at === -1 ? rootIndex : at + 1, 0, { type: "app", name: d.item.name });
        dissolveIfSparse(folder);
        saveLayout();
        if (!state.items.includes(folder)) {
            closeFolder(); // 只剩一个成员被拖走 → 文件夹就地解散
            renderWithFlip(before, renderRoot);
        } else {
            renderWithFlip(before, () => { renderFolderGrid(); renderRoot(); });
        }
        return;
    }
    if (d.scope === "folder") {
        // 文件夹内：仅支持重排（macOS 不允许文件夹嵌套）
        const idx = insertionIndexSnap(x, y);
        const visible = visibleAppsOf(openFolderItem);
        const from = visible.indexOf(d.item.name);
        clearDodge();
        if (from !== -1) {
            visible.splice(from, 1);
            visible.splice(Math.min(idx, visible.length), 0, d.item.name);
            // 可见成员的顺序写回权威数组；被禁用的成员留在原来的槽位，
            // 用户重新启用后仍回到原位置，不会因为一次拖拽被挤到末尾。
            let vi = 0;
            openFolderItem.apps = openFolderItem.apps.map((n) => (appEnabled(n) ? visible[vi++] : n));
            saveLayout();
        }
        renderWithFlip(before, renderFolderGrid);
        return;
    }

    // 根网格：命中判定用拖拽开始时的基准矩形快照（图标正在躲闪，实时矩形会漂）
    const snap = hitSnap(x, y);
    const tItem = snap ? itemOfCell(snap.el) : null;
    clearDodge();
    if (tItem && tItem !== d.item) {
        if (tItem.type === "folder" && d.item.type === "app") {
            if (!tItem.apps.includes(d.item.name)) {
                removeItem(d.item);
                tItem.apps.push(d.item.name);
                saveLayout();
                renderWithFlip(before, renderRoot);
            } else {
                renderWithFlip(before, renderRoot);
            }
            return;
        }
        if (tItem.type === "app" && d.item.type === "app" && tItem.name !== d.item.name) {
            // 应用拖到应用上 → 合并成文件夹：两个条目都从布局移除，
            // 文件夹顶替目标应用原来的格子（目标在前、被拖在后），否则目标残留 + 重复出现
            removeItem(d.item);
            const at = state.items.indexOf(tItem); // 先移除 d.item 再取位，避免索引偏移
            removeItem(tItem);
            const folder = {
                type: "folder",
                name: uniqueFolderName("新建文件夹"),
                apps: [tItem.name, d.item.name],
            };
            state.items.splice(at === -1 ? state.items.length : at, 0, folder);
            saveLayout();
            renderWithFlip(before, renderRoot);
            const newCell = grid.querySelector(`.container[data-name="folder:${CSS.escape(folder.name)}"]`);
            if (newCell) newCell.classList.add("pop-in");
            return;
        }
    }
    // 空白处落下 → 本页内插入位换算成全局插入位（跨页拖拽时页起点不同）
    const idx = insertionIndexSnap(x, y);
    moveItem(d.item, globalInsertionIndex(d.scopeGrid, idx));
    saveLayout();
    renderWithFlip(before, renderRoot);
}

function inRect(r, x, y) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * 把「目标页内的局部插入位」换算成 state.items 的全局插入位。
 * 计数时跳过正在拖拽那格，所以得到的就是「移除原条目之后」的目标下标，
 * 可直接交给 moveItem（它先 remove 再 splice）。
 */
function globalInsertionIndex(targetGrid, localIdx) {
    let before = 0;
    for (const pg of grid.querySelectorAll(".page-grid")) {
        if (pg === targetGrid) break;
        before += pg.querySelectorAll(".container:not(.dragging)").length;
    }
    return before + localIdx;
}

// 行主序插入位：指针所在行之上的整行计入，同行中位于指针左侧的计入
function insertionIndex(cells, x, y) {
    let idx = 0;
    for (const c of cells) {
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const sameRow = Math.abs(cy - y) < r.height / 2;
        if (sameRow ? cx < x : cy < y) idx++;
    }
    return idx;
}

function itemOfCell(cell) {
    const kind = cell.dataset.kind;
    const raw = cell.dataset.name;
    if (kind === "app") return state.items.find((it) => it.type === "app" && it.name === raw) || null;
    const name = raw.startsWith("folder:") ? raw.slice(7) : raw;
    return state.items.find((it) => it.type === "folder" && it.name === name) || null;
}

function removeItem(item) {
    const i = state.items.indexOf(item);
    if (i !== -1) state.items.splice(i, 1);
}

function moveItem(item, idx) {
    removeItem(item);
    state.items.splice(idx, 0, item);
}

function uniqueFolderName(base) {
    if (!state.items.some((it) => it.type === "folder" && it.name === base)) return base;
    for (let i = 2; ; i++) {
        const name = `${base} ${i}`;
        if (!state.items.some((it) => it.type === "folder" && it.name === name)) return name;
    }
}

/* ─────────────── 文件夹 ─────────────── */

function openFolder(item) {
    if (folderCloseTimer) { clearTimeout(folderCloseTimer); folderCloseTimer = null; }
    folderLayer.classList.remove("closing");
    // 防御：历史上 visibleItems 曾返回副本；这里统一收敛到 state.items 里的原对象。
    openFolderItem = item.source || item;
    // 搜索条会随根网格一起淡出，先把焦点交还给文件夹标题，避免在看不见的输入框里继续输入。
    searchInput.blur();
    folderTitleInput.value = openFolderItem.name;
    renderFolderGrid();
    folderLayer.classList.add("open");
    // 底衬加糊加暗：浮层的磨砂才读得出层次
    launchpad.classList.add("folder-open");
}

function closeFolder() {
    if (!folderLayer.classList.contains("open") || folderCloseTimer) return;
    folderLayer.classList.add("closing");
    launchpad.classList.remove("folder-open");
    openFolderItem = null;
    // 关闭动画跑完再隐藏并清空内容（立即 display:none 会看不到动画）
    folderCloseTimer = setTimeout(() => {
        folderCloseTimer = null;
        folderLayer.classList.remove("open", "closing");
        renderFolderGrid();
    }, FOLDER_CLOSE_MS);
}

function renderFolderGrid() {
    folderGrid.innerHTML = "";
    if (!openFolderItem) return;
    // 只用可见成员渲染；成员归属仍以 openFolderItem.apps 为准。
    visibleAppsOf(openFolderItem).forEach((n) => {
        folderGrid.appendChild(makeCell({ type: "app", name: n }, "folder"));
    });
    if (editMode) applyJiggle(folderGrid);
}

function dissolveIfSparse(folder) {
    if (folder.apps.length >= 2) return;
    const idx = state.items.indexOf(folder);
    if (idx === -1) return;
    state.items.splice(idx, 1);
    folder.apps.forEach((n, i) => state.items.splice(idx + i, 0, { type: "app", name: n }));
}

function dissolveFolder(folder) {
    dissolveIfSparse(folder);
    if (state.items.includes(folder)) {
        // >=2 成员：原位展开为独立应用
        const idx = state.items.indexOf(folder);
        state.items.splice(idx, 1, ...folder.apps.map((n) => ({ type: "app", name: n })));
    }
    if (openFolderItem === folder) closeFolder();
    saveLayout();
    renderRoot();
}

folderTitleInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") folderTitleInput.blur();
    if (e.key === "Escape") {
        folderTitleInput.value = openFolderItem ? openFolderItem.name : "";
        folderTitleInput.blur();
    }
});
folderTitleInput.addEventListener("focus", () => folderTitleInput.select());
folderTitleInput.addEventListener("blur", () => {
    if (!openFolderItem) return;
    const v = folderTitleInput.value.trim();
    if (v && v !== openFolderItem.name) {
        openFolderItem.name = uniqueFolderName(v);
        saveLayout();
        renderRoot();
    }
    folderTitleInput.value = openFolderItem.name;
});

/* ─────────────── 重命名 ─────────────── */

function findCell(item) {
    const name = item.type === "app" ? item.name : `folder:${item.name}`;
    return grid.querySelector(`.container[data-kind="${item.type}"][data-name="${CSS.escape(name)}"]`)
        || (openFolderItem ? folderGrid.querySelector(`.container[data-kind="${item.type}"][data-name="${CSS.escape(name)}"]`) : null);
}

function startRename(item) {
    if (keyword) return;
    item = item.source || item;
    const cell = findCell(item);
    if (!cell || cell.querySelector(".rename-input")) return;
    const p = cell.querySelector("p");
    if (!p) return;
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = p.textContent;
    p.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (v) {
            if (item.type === "folder") {
                // 文件夹走同一套去重规则，避免改出两个同名文件夹；
                // item 必须是 state.items 里的原对象，saveLayout() 才写得到新名字。
                const next = uniqueFolderName(v);
                if (next !== item.name) {
                    item.name = next;
                    if (openFolderItem === item) folderTitleInput.value = next;
                }
            } else {
                state.labels[item.name] = v;
            }
            saveLayout();
        }
        renderRoot();
        if (openFolderItem) renderFolderGrid();
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
        else if (e.key === "Escape") { done = true; renderRoot(); if (openFolderItem) renderFolderGrid(); }
    });
    input.addEventListener("blur", commit);
}

/* ─────────────── 右键菜单 ─────────────── */

function openCtxMenu(x, y, item) {
    ctxMenu.innerHTML = "";
    const mk = (text, fn) => {
        const b = document.createElement("div");
        b.className = "ctx-item";
        b.textContent = text;
        b.addEventListener("click", () => { closeCtxMenu(); fn(); });
        return b;
    };
    ctxMenu.appendChild(mk("重命名", () => startRename(item)));
    if (item.type === "folder") ctxMenu.appendChild(mk("解散文件夹", () => dissolveFolder(item)));
    ctxMenu.hidden = false;
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    ctxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
}

function closeCtxMenu() {
    ctxMenu.hidden = true;
    ctxMenu.style.left = "";
    ctxMenu.style.top = "";
}

/* ─────────────── 应用启动 ─────────────── */

// macOS 风格开屏动画：图标克隆从原格放大飞向屏幕中心并淡出，启动台同时淡出关闭
function zoomLaunch(imgEl) {
    const rect = imgEl.getBoundingClientRect();
    const clone = imgEl.cloneNode();
    clone.style.cssText = [
        "position: fixed",
        `left: ${rect.left}px`,
        `top: ${rect.top}px`,
        `width: ${rect.width}px`,
        `height: ${rect.height}px`,
        "z-index: 9700",
        "pointer-events: none",
        "margin: 0",
        "transition: transform .4s cubic-bezier(.5,0,.75,.6), opacity .4s ease-in",
    ].join(";");
    if (zoomLayer) zoomLayer.remove();
    zoomLayer = clone;
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
        const dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
        const dy = window.innerHeight / 2 - (rect.top + rect.height / 2);
        clone.style.transform = `translate(${dx}px, ${dy}px) scale(7)`;
        clone.style.opacity = "0";
    });
    setTimeout(() => { clone.remove(); if (zoomLayer === clone) zoomLayer = null; }, 460);
}

// 获取程序坞中对应名称的应用图标，不存在则先加入程序坞再查找
function getDockImg(name) {
    let img = document.querySelector(`#dock img[alt="${name}"]`);
    if (!img) {
        addToDock(name);
        img = document.querySelector(`#dock img[alt="${name}"]`);
    }
    return img;
}

function launchApp(name, imgEl) {
    const app = state.apps.get(name);
    if (imgEl) zoomLaunch(imgEl);
    if (!app) return;
    if (window.appStatus[name]) {
        openApp(app.appId);
    } else {
        const dockImg = getDockImg(name);
        const light = dockImg ? dockImg.parentElement.querySelector(".light") : null;
        openApp(app.appId, { light, centered: app.centered });
        window.appStatus[name] = true;
        updateMenu(name);
    }
    closeLaunchpad();
}

function activate(item, imgEl) {
    if (item.type === "app") launchApp(item.name, imgEl);
    else openFolder(item);
}

/* ─────────────── 搜索 ─────────────── */

searchInput.addEventListener("input", () => {
    keyword = searchInput.value.trim().toLowerCase();
    exitEditMode(); // 开始搜索即退出编辑模式，避免结果网格与摇晃态混杂
    closeCtxMenu();
    // 搜索结果是新的一组条目，继续停在旧页码没有意义：回到第一页。
    renderRoot({ resetToFirst: true });
});

searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return; // 交给 window 级 Esc 处理（清空搜索/退出文件夹/关闭）
    e.stopPropagation();
    if (e.key !== "Enter") return;
    const first = grid.querySelector(".container");
    if (!first) return;
    const item = itemOfCell(first);
    if (item) activate(item, first.querySelector("img"));
});

/* ─────────────── 关闭 / 重开 ─────────────── */

function setDockLight(on) {
    const light = document.querySelector('#dock .container[data-app="启动台"] .light');
    if (light) light.classList.toggle("on", on);
}

function closeLaunchpad() {
    if (LP_STATE.isClosing) return;
    if (!launchpad || !launchpad.isConnected) {
        window.appStatus["启动台"] = false;
        document.documentElement.classList.remove("deskly-launchpad-open");
        setDockLight(false);
        LP_STATE.isClosing = false;
        return;
    }
    LP_STATE.isClosing = true;
    // 根类留到 unload 再摘：程序坞在关闭动画期间仍应压在启动台之上，
    // 菜单栏也等启动台真正消失后再回来。
    window.appStatus["启动台"] = false;
    setDockLight(false);
    exitEditMode();
    closeCtxMenu();
    closeFolder();
    searchInput.value = "";
    keyword = "";

    // 独立 keyframes 保证关闭动画可重启（见 style.css 注释）
    launchpad.style.animation = `launchpad-fade-out ${CLOSE_MS}ms ease-in forwards`;
    grid.style.animation = `launchpad-out ${CLOSE_MS}ms ease-in-out forwards`;

    launchpad._closeTimer = setTimeout(() => {
        launchpad._closeTimer = null;
        // 统一交给核心卸载：unload() 广播 plugin-unload 并移除根节点/样式/脚本
        unload("launchpad");
        LP_STATE.isClosing = false;
        if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
            window.__dock.syncRunningApps();
        }
    }, CLOSE_MS + 60);
}

function reopenLaunchpad() {
    const lp = document.querySelector(".launchpad");
    if (!lp || !lp.isConnected) return false;
    if (lp._closeTimer) { clearTimeout(lp._closeTimer); lp._closeTimer = null; }
    LP_STATE.isClosing = false;
    document.documentElement.classList.add("deskly-launchpad-open");
    window.appStatus["启动台"] = true;
    setDockLight(true);
    // 重显时按最新注册表对账一次（期间可能有应用装/卸），尺寸/视口也可能变过
    applySizes();
    buildState();
    renderRoot();
    launchpad.style.animation = "";
    grid.style.animation = "";
    launchpad.style.display = "";
    return true;
}

/* ─────────────── 翻页交互 ─────────────── */

/**
 * 鼠标滚轮翻页：原版启动台用滚轮/轻扫切页。
 * 触控板的横向手势交给浏览器原生 scroll-snap（deltaX 更大时不干预）；
 * 纵向滚轮按「一次手势一页」节流，避免高分辨率滚轮一次滚三页。
 */
function onGridWheel(e) {
    if (pageCount <= 1 || (press && press.moved)) return;
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt < 320) return;
    lastWheelAt = now;
    goToPage(currentPage + (e.deltaY > 0 ? 1 : -1));
}

/** 页码点点击：stopPropagation，否则会被「点空白关闭启动台」的总监听吃掉。 */
function onPageDotClick(e) {
    const dot = e.target.closest(".page-dot");
    if (!dot) return;
    e.stopPropagation();
    goToPage(Number(dot.dataset.page));
}

/* ─────────────── 全局交互 ─────────────── */

// 点击空白：文件夹开着先关文件夹，否则关闭启动台
launchpad.addEventListener("click", (e) => {
    closeCtxMenu();
    if (suppressNextClick) return;
    if (e.target.closest(".container") || e.target.closest(".searchbar")
        || e.target.closest(".ctx-menu") || e.target.closest(".folder-panel")) return;
    if (editMode) { exitEditMode(); return; }
    if (folderLayer.classList.contains("open")) closeFolder();
    else closeLaunchpad();
});

const onWindowKeydown = (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    // 左右方向键翻页（页码点只给鼠标用，键盘用户走这条路径）。
    if (!typing && ctxMenu.hidden && !folderLayer.classList.contains("open")
        && (e.key === "ArrowLeft" || e.key === "ArrowRight") && pageCount > 1) {
        e.preventDefault();
        goToPage(currentPage + (e.key === "ArrowRight" ? 1 : -1));
        return;
    }
    if (e.key !== "Escape") return;
    if (!ctxMenu.hidden) { closeCtxMenu(); return; }
    if (editMode) { exitEditMode(); return; }
    if (folderLayer.classList.contains("open")) { closeFolder(); return; }
    if (keyword) {
        searchInput.value = "";
        keyword = "";
        renderRoot();
        return;
    }
    closeLaunchpad();
};

/* ─────────────── 尺寸设置（图标 / 文字） ─────────────── */

// 尺寸由设置项决定，落到根元素的 CSS 变量上；格子、文件夹预览、拖拽幽灵
// 都由 --lp-icon 推导（见 style.css），所以只需要写这两个变量。
function readSize(conf) {
    let v;
    try {
        v = parseInt(localStorage.getItem(conf.slot), 10);
    } catch (e) {
        return conf.def;
    }
    if (!Number.isFinite(v)) return conf.def;
    return Math.min(conf.max, Math.max(conf.min, v));
}

function applySizes() {
    SIZE_CONF.forEach((conf) => {
        launchpad.style.setProperty(conf.cssVar, `${readSize(conf)}px`);
    });
    gridMetrics = computeGridMetrics();
    launchpad.style.setProperty("--lp-cols", String(gridMetrics.cols));
    launchpad.style.setProperty("--lp-rows", String(gridMetrics.rows));
}

/**
 * 计算一页能放多少格：列数按视口宽度和图标尺寸反推（最多 7 列），
 * 行数按「顶栏搜索区以下的可视高度」反推。CSS 的 gap/padding 与这里的公式必须一致，
 * 否则切页容量与真实渲染会错位，最后一行可能被裁掉或页底留大片空白。
 */
function computeGridMetrics() {
    // 扩展页刚注入的极短窗口里 innerWidth/innerHeight 可能读到 0；保留上一轮或默认值，
    // 等 resize 事件再校正，避免把整屏排成 2 列。
    if (window.innerWidth < 100 || window.innerHeight < 100) return gridMetrics;
    const icon = readSize(SIZE_CONF[0]);
    const font = readSize(SIZE_CONF[1]);
    const gapX = Math.max(12, Math.min(48, window.innerWidth * 0.03));
    const gapY = Math.max(18, Math.min(30, window.innerHeight * 0.026));
    const usableX = window.innerWidth * 0.92;
    const cellW = icon + 44;
    const cols = Math.max(2, Math.min(7, Math.floor((usableX + gapX) / (cellW + gapX))));
    const cellH = icon + 8 + Math.ceil(font * 1.3) + 8;
    const usableY = window.innerHeight * (1 - 0.17 - 0.08);
    const rows = Math.max(2, Math.floor((usableY + gapY) / (cellH + gapY)));
    return { cols, rows, capacity: cols * rows };
}

/** 尺寸/视口变化：先重算容量，再重建分页；不重渲染的话旧页容量会和新 CSS 不一致。 */
const onSizeChange = () => {
    applySizes();
    renderRoot();
    updatePageDotsPosition();
};

/* ─────────────── 初始化 ─────────────── */

function init() {
    // 清理上一实例残留 DOM / 关闭计时器 / 旧脚本（与 plugin-manager 的重注入对齐）
    document.querySelectorAll(".launchpad").forEach((el) => {
        if (el === launchpad) return;
        if (el._closeTimer) { clearTimeout(el._closeTimer); el._closeTimer = null; }
        el.remove();
    });
    const lpScripts = document.querySelectorAll("script[plugin=launchpad]");
    lpScripts.forEach((s, i) => { if (i < lpScripts.length - 1) s.remove(); });

    // 原版启动台会隐藏菜单栏、保留程序坞；用根类把这两件事交给样式表，
    // 不直接改 finderbar/dock 的层级定义（它们仍由 zindex.js 统一管理）。
    document.documentElement.classList.add("deskly-launchpad-open");
    window.specialCloses["启动台"] = closeLaunchpad;
    window.appStatus["启动台"] = true;
    LP_STATE.isClosing = false;
    setDockLight(true);

    window.addEventListener("keydown", onWindowKeydown);
    gridScroll.addEventListener("scroll", syncPageFromScroll, { passive: true });
    gridScroll.addEventListener("wheel", onGridWheel, { passive: false });
    if (pageDots) pageDots.addEventListener("click", onPageDotClick);
    ["dock-size-change", "dock-position-change", "dock-autohide-change"].forEach((event) => {
        window.addEventListener(event, updatePageDotsPosition);
    });
    currentPage = 0;
    updatePageDotsPosition();

    // 语言切换：启动台每次打开都会重建，但打开期间换语言也要即时把磁贴显示名换过来（身份/布局键不变）
    const onLanguageChange = () => renderRoot();
    document.addEventListener("languagechange", onLanguageChange);

    // 资源释放：启动台卸载时移除自身注册的 window 级监听，并丢弃未结束的会话
    const onLaunchpadUnload = (e) => {
        if (e.detail.id !== "launchpad") return;
        document.documentElement.classList.remove("deskly-launchpad-open");
        window.removeEventListener("plugin-unload", onLaunchpadUnload);
        document.removeEventListener("languagechange", onLanguageChange);
        window.removeEventListener("keydown", onWindowKeydown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("launchpad-icon-size-change", onSizeChange);
        window.removeEventListener("launchpad-font-size-change", onSizeChange);
        window.removeEventListener("resize", onSizeChange);
        gridScroll.removeEventListener("scroll", syncPageFromScroll);
        gridScroll.removeEventListener("wheel", onGridWheel);
        if (pageDots) pageDots.removeEventListener("click", onPageDotClick);
        ["dock-size-change", "dock-position-change", "dock-autohide-change"].forEach((event) => {
            window.removeEventListener(event, updatePageDotsPosition);
        });
        if (pageScrollRaf) { cancelAnimationFrame(pageScrollRaf); pageScrollRaf = 0; }
        if (press) {
            if (press.longPressTimer) clearTimeout(press.longPressTimer);
            press = null;
        }
        if (dodgeFrame) { cancelAnimationFrame(dodgeFrame); dodgeFrame = 0; }
        if (folderCloseTimer) { clearTimeout(folderCloseTimer); folderCloseTimer = null; }
        dodgeCells = [];
        dodgeScope = null;
        isDragging = false;
    };
    window.addEventListener("plugin-unload", onLaunchpadUnload);

    SIZE_CONF.forEach((conf) => {
        window.addEventListener(`${conf.slot}-change`, onSizeChange);
    });
    window.addEventListener("resize", onSizeChange);

    applySizes();

    // 字体加载完成后再量一次：行高变化会改变一页能放几行，晚一步就可能裁掉最后一行。
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            if (!launchpad.isConnected) return;
            applySizes();
            renderRoot();
        }).catch(() => { /* 字体就绪 Promise 只用于重排，失败保持当前布局 */ });
    }

    // F4 开关启动台：启动台关闭后本模块实例会被卸载，该监听必须常驻 window，
    // 且只绑一次（window.__lpF4Bound 防止每次打开重复叠加）。
    // 用捕获阶段：搜索框/重命名框的 keydown 都 stopPropagation，冒泡阶段会被拦截。
    if (!window.__lpF4Bound) {
        window.__lpF4Bound = true;
        window.addEventListener("keydown", (e) => {
            if (e.key !== "F4") return;
            e.preventDefault();
            if (window.__launchpad.isOpen()) {
                window.__launchpad.close();
            } else {
                const light = document.querySelector('#dock .container[data-app="启动台"] .light');
                window.__launchpad.open(light);
            }
        }, true);
    }

    buildState();
    renderRoot();
    searchInput.focus({ preventScroll: true });
}

// 暴露统一控制入口给程序坞等调用方
window.__launchpad = {
    open: (light) => { loadPlugin("launchpad", { light: light || null, centered: false }); },
    close: closeLaunchpad,
    reopen: reopenLaunchpad,
    isOpen: () => {
        const lp = document.querySelector(".launchpad");
        return !!(lp && lp.isConnected);
    },
};

init();
