/**
 * wm/interactions.js — 拖动与八向缩放（从 window-manager.js 抽出，含 NW-2 / NW-3 / NW-6）
 *
 * 职责：bindInteractions / startDrag / startResize / 缩放边带 / 交互遮罩 / 平铺吸附预览。
 * 与 macOS 的对齐点（继承原实现，改动前先读 window-manager.js 头注）：
 * - 拖动只认标题栏（[data-titlebar]，没有标题栏元素的窗口退回顶部灯区带）；
 * - 缩放命中八向边/角，对侧边为锚点；⌥ 锁宽高比（声明了 aspectRatio 则常驻锁定）；
 * - 拖动推到屏幕边缘即平铺（左/右半、四角 ¼、顶部=缩放），带预览框；
 * - 缩放态/平铺态下开始拖动或缩放即脱离该状态，回到用户框架。
 *
 * 新增声明式约束（三通道同名：data-window / manifest.window / configure）：
 * - NW-2：dragAxis "both"|"x"|"y"；dragBounds "visible"|{x,y,w,h}；
 *   fixed:true = 不可拖 + 不参与吸附 + 视口 resize 不回拉 + configure 不居中；
 * - NW-3：resizeAxis "both"|"x"|"y"|"none"（none ≡ resizable:false，取更严者）、
 *   aspectRatio "16:9" | 数值（常驻锁比例；与 min/max 冲突时 min/max 为硬边界并 warn）；
 * - NW-6：snap "tile"|"edges"|"none"（edges = 钳到可视区边、不出平铺预览；fixed 隐含 none）。
 *
 * setZoom / tile 由 facade 注入（bindWindowOps）：facade 依赖本模块绑定交互，
 * 反向静态 import 会把模块求值环变成拆弹。
 */

import { syncState, focusWindow } from "./stack.js";
import {
    visibleFrame, frameOf, applyFrame, limitsOf, clampFrame, clampDrag, edgeAt, resizeFrame,
    snapZoneAt, WM_ANIM_MS, RESIZE_EDGES,
} from "./frame.js";
import { getTrafficLights } from "../ui/trafficLights.js";
import { emitWindowEvent } from "./events.js";
import { followMove } from "./relations.js";

/** facade 注入的窗口操作（setZoom / tile），求值期绑定。 */
let ops = { setZoom: null, tile: null };
export function bindWindowOps(injected) {
    ops = { ...ops, ...injected };
}

/** 无标题栏元素时，窗口顶部可拖动的带高（= --traffic-titlebar 的 JS 侧对齐值）。 */
const TITLE_BAND = 38;
/** 没有标题栏元素、但灯区被顶得更低时，拖动带的上限。 */
const TITLE_BAND_MAX = 56;

/** 交互类型 */
const DRAG = "drag";
const RESIZE = "resize";

/**
 * 缩放期间的边界余量（原来散在 startResize 里是四个裸数字）。
 * 语义各不相同，分开命名而不是合成一个：
 * - RESIZE_KEEP_GRABBABLE：左右两侧拉到底时，窗口仍要留在屏内这么多 px，否则点不到它；
 * - RESIZE_KEEP_TITLE：顶边下界用的高度 —— 标题栏至少留这么多 px 在屏内才还抓得住；
 * - RESIZE_MAX_OVERFLOW：允许比视口更宽的富余量（macOS 容许窗口拉出屏幕两侧）。
 */
const RESIZE_KEEP_GRABBABLE = 40;
const RESIZE_KEEP_TITLE = 24;
const RESIZE_MAX_OVERFLOW = 80;

/** 命中即不视为标题栏空白的控件清单（沿用旧内核里踩过的坑：shadow 宿主、系统设置外壳类）。 */
const INTERACTIVE = ".wintools, .resizer, input, textarea, select, button, swift-input, swift-switch, a, label, .finder-no-drag, [contenteditable=\"true\"], .ss-switch, .ss-segmented, .ss-dropdown, .ss-menu, .ss-cards, .ss-swatches, .ss-radio, .ss-btn, .ss-input, .ss-slider, .ss-search, .ss-table";

/** 缩放键位 -> CSS 光标名（样式表负责落到 .window 与其子树）。 */
const EDGE_CURSOR = {
    n: "ns", s: "ns", e: "ew", w: "ew",
    nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw",
};

/** 该窗口声明的拖动配置（缺省即现状）。 */
function dragConf(el) {
    const conf = el._wmConfig || {};
    return {
        axis: conf.dragAxis === "x" || conf.dragAxis === "y" ? conf.dragAxis : "both",
        bounds: conf.dragBounds && typeof conf.dragBounds === "object" ? conf.dragBounds : null,
        fixed: el._wmFixed === true,
        snap: el._wmSnap || "tile",
    };
}

/** 该窗口声明的缩放配置。 */
function resizeConf(el) {
    const conf = el._wmConfig || {};
    const axis = ["x", "y", "none"].includes(conf.resizeAxis) ? conf.resizeAxis : "both";
    return { axis, aspect: Number.isFinite(el._wmAspect) ? el._wmAspect : 0 };
}

/**
 * NW-2 拖动约束纯计算：按轴锁定 + 硬区域钳制。
 * 从 move 热循环里提出来，是为了让探针可以直接覆盖（dev/wm-check.mjs）。
 * @param {HTMLElement} el
 * @param {number} x 期望左上角（已过 clampDrag）
 * @param {number} y
 * @param {{w:number,h:number}} size
 * @param {{x:number,y:number}} anchor 轴锁定的参照（拖动起手时的位置）
 * @returns {{x:number,y:number}}
 */
export function applyDragConstraints(el, x, y, size, anchor) {
    const { axis, bounds } = dragConf(el);
    let nx = x;
    let ny = y;
    if (axis === "x") ny = anchor.y;
    else if (axis === "y") nx = anchor.x;
    if (bounds) {
        // 硬区域：整扇窗口拖不出该矩形；区域比窗口还小时贴着区域左上
        nx = Math.max(bounds.x, Math.min(nx, bounds.x + Math.max(0, bounds.w - size.w)));
        ny = Math.max(bounds.y, Math.min(ny, bounds.y + Math.max(0, bounds.h - size.h)));
    }
    return { x: nx, y: ny };
}

/**
 * 指针是不是压在「真正在用的滚动条」上。
 * 右/下边的缩放带和滚动条是同一批像素（macOS 的边框在内容之外，这里没法照抄）：
 * 判据必须是「指针落在该元素的滚动条槽里」，而不是「这里有滚动容器」。
 */
function overScrollbar(target, el, axis, cx, cy) {
    const GUTTER = 16;   //  macOS 悬浮滚动条 +  classic 滚动条的宽度上限
    let n = target;
    while (n && n !== el) {
        const cs = window.getComputedStyle(n);
        const o = axis === "y" ? cs.overflowY : cs.overflowX;
        if (o === "auto" || o === "scroll") {
            const overflow = axis === "y"
                ? n.scrollHeight > n.clientHeight + 1
                : n.scrollWidth > n.clientWidth + 1;
            if (overflow) {
                const r = n.getBoundingClientRect();
                // 垂直滚动条占元素右缘，水平滚动条占下缘
                if (axis === "y" ? cx >= r.right - GUTTER : cy >= r.bottom - GUTTER) return true;
            }
        }
        n = n.parentElement;
    }
    return false;
}

/**
 * 缩放带要让位的控件（比拖动排除表窄得多，这是有意的）。
 * 缩放命中区只有边框那 6px，而 macOS 的边框在内容之外、这里没法照抄，
 * 只能做取舍：按下落在窗口最外圈 6px 时，边框赢过内容。
 */
const RESIZE_EXCLUDES = ".wintools, input, textarea, select, swift-input, swift-switch, [contenteditable=\"true\"], .ss-switch, .ss-slider, .ss-search, .ss-input, .resizer";

/** 缩放带能不能接管这次按下。 */
function resizeBlocked(target, el, edge, cx, cy) {
    // 插件自带的老式右下角手柄：它自己就是缩放控件，不能让自己的排除表把它挡掉
    if (target.closest && target.closest(".resizer")) return false;
    if (target.closest && target.closest(RESIZE_EXCLUDES)) return true;
    if (/[ns]/.test(edge) && overScrollbar(target, el, "y", cx, cy)) return true;
    if (/[ew]/.test(edge) && overScrollbar(target, el, "x", cx, cy)) return true;
    return false;
}

/**
 * 该点是否落在「真的在滚」的纵向滚动容器里。
 * 顶部带兜底要把这个手势还给内容，否则列表/正文就拖不动了。
 */
function insideScroller(target, el) {
    let n = target;
    while (n && n !== el) {
        const cs = window.getComputedStyle(n);
        if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
            if (n.scrollHeight > n.clientHeight + 1) return true;
        }
        n = n.parentElement;
    }
    return false;
}

/**
 * 拖动区判定：标题栏优先；标题栏没认领、或窗口根本没有标题栏时，
 * 退回「顶部灯区带」；声明 draggable:false 或 fixed:true 的窗口完全不可拖（NW-2）。
 * @param {object} rec 窗口记录
 * @param {PointerEvent} e
 * @returns {boolean}
 */
export function inDragZone(rec, e) {
    const el = rec.el;
    if (el.dataset.wmDraggable === "false") return false;
    if (el._wmFixed) return false;
    if (e.target.closest && e.target.closest(INTERACTIVE)) return false;
    // 一个窗口可以有多条标题栏（App Store 的 .as-titlebar + .as-toolbar 都算），
    // 只认 querySelector 的第一个会让第二条拖不动。
    const bars = el.querySelectorAll("[data-titlebar]");
    for (const bar of bars) {
        if (bar.contains(e.target)) return true;
    }
    // 走到这里有两种情况：窗口没有标题栏元素，或标题栏被应用自己的样式做成了
    // 不可交互的装饰条（pointer-events:none）。macOS 的观感里窗口顶部那一条本来就是
    // 标题栏，所以按顶部带兜底；真正在滚的容器把 gesture 还给内容。
    const f = frameOf(el);
    if (e.clientY - f.y > bandOf(el)) return false;
    return !insideScroller(e.target, el);
}

/** 顶部可拖带高：无标题栏元素的窗口用，跟着红绿灯的实际位置走。 */
function bandOf(el) {
    const lights = getTrafficLights(el);
    if (!lights) return TITLE_BAND;
    const f = frameOf(el);
    const r = lights.getBoundingClientRect();
    if (!r.height) return TITLE_BAND;
    // frame 用的是 y（不是 top）：写成 f.top 会得到 NaN，整个顶部带判定静默失效
    return Math.max(TITLE_BAND, Math.min(TITLE_BAND_MAX, r.bottom - f.y + 8));
}

/** 平铺预览层（游离元素，拖动期间才挂在 body 上）。 */
let preview = null;
function showPreview(frame, z) {
    if (!preview) {
        preview = document.createElement("div");
        preview.id = "deskly-tile-preview";
        preview.setAttribute("aria-hidden", "true");
    }
    if (!preview.isConnected) document.body.appendChild(preview);
    preview.style.zIndex = String(Math.max(2049, z - 1));
    preview.style.left = `${Math.round(frame.x)}px`;
    preview.style.top = `${Math.round(frame.y)}px`;
    preview.style.width = `${Math.round(frame.w)}px`;
    preview.style.height = `${Math.round(frame.h)}px`;
}
function hidePreview() {
    if (preview && preview.isConnected) preview.remove();
}

/**
 * 缩放边带：窗口根上的透明 div（四边 + 四角，按 resizeAxis 过滤）。
 *
 * 为什么不用「捕获阶段按坐标算命中区」那一套：Safari 的网页内容是 <iframe>，
 * 指针落在 iframe 上时，事件进的是 iframe 自己的文档，宿主页面连 pointerdown
 * 都收不到。边带是宿主页面的元素，压在 iframe 之上，按下必定命中。
 * NW-3：resizeAxis:"x" 时只留 e/w，"y" 只留 n/s（角带隐含双向，只在 both 时出现）。
 * @param {HTMLElement} el 窗口根
 */
export function ensureEdgeBands(el) {
    const { axis } = resizeConf(el);
    const wanted = RESIZE_EDGES.filter((key) => {
        if (axis === "both") return true;
        if (axis === "x") return key === "e" || key === "w";
        if (axis === "y") return key === "n" || key === "s";
        return false; // none：不挂任何边带
    });
    // 轴配置变化时重建（旧边带的键集合可能已不对）
    const existing = Array.from(el.querySelectorAll(":scope > .wm-edge"));
    const same = existing.length === wanted.length
        && existing.every((b) => wanted.includes(b.dataset.wmEdge));
    if (same) return;
    existing.forEach((b) => b.remove());
    wanted.forEach((key) => {
        const band = document.createElement("div");
        band.className = `wm-edge wm-edge-${key}`;
        band.dataset.wmEdge = key;
        band.setAttribute("aria-hidden", "true");
        el.appendChild(band);
    });
}

/**
 * 边带此刻该不该让位。用 elementFromPoint 取「边带底下是什么」：
 * 临时给窗口挂 .wm-peeking（样式表把所有边带 pointer-events 关掉）再取，取完摘掉。
 */
function bandShouldYield(el, edge, cx, cy) {
    el.classList.add("wm-peeking");
    const under = document.elementFromPoint ? document.elementFromPoint(cx, cy) : null;
    el.classList.remove("wm-peeking");
    if (!under || under === el || !el.contains(under)) return false;
    return resizeBlocked(under, el, edge, cx, cy);
}

/**
 * hover 时的让位刷新。
 * 只在「进了哪条边带」变化时做一次 elementFromPoint 判定，不逐像素算：
 * 边带只有 5px 宽，进出各一次足够，逐帧探测会每帧多一次强制布局。
 */
function syncBandYield(rec, cx, cy) {
    const el = rec.el;
    const edge = edgeAt(frameOf(el), cx, cy);
    if (edge === rec.hoverEdge) return;
    rec.hoverEdge = edge;
    el.querySelectorAll(":scope > .wm-edge").forEach((band) => {
        const key = band.dataset.wmEdge;
        band.classList.toggle("blocked", !!edge && edge === key && bandShouldYield(el, key, cx, cy));
    });
}

/**
 * 交互遮罩：拖动 / 缩放期间铺一层透明 div 盖住整页。
 * 没有它，指针一进内容里的 <iframe>，事件就被那个文档吃掉，窗口拖到一半「断线」。
 */
let shield = null;
function installShield(cursorName) {
    if (!shield) {
        shield = document.createElement("div");
        shield.id = "deskly-interaction-shield";
        shield.setAttribute("aria-hidden", "true");
    }
    shield.style.cursor = cursorName ? `${cursorName}-resize` : "";
    if (!shield.isConnected) document.body.appendChild(shield);
    return shield;
}
function removeShield() {
    if (shield && shield.isConnected) shield.remove();
}

/** 交互期间挂在 <html> 上的类：拖拽锁文字选中；缩放期间光标走遮罩的 inline cursor。 */
function beginInteraction(kind, cursorName) {
    const root = document.documentElement;
    root.classList.remove("deskly-dragging", "deskly-resizing");
    root.classList.add(kind === DRAG ? "deskly-dragging" : "deskly-resizing");
    installShield(cursorName);
}

function endInteraction(rec) {
    const root = document.documentElement;
    rec.mode = null;
    rec.grab = null;
    rec.snap = null;
    rec.hoverEdge = null;
    hidePreview();
    removeShield();
    root.classList.remove("deskly-dragging", "deskly-resizing");
}

/**
 * 拖动/缩放结束后刷新快照。拖动只改位置，旧快照仍可复用；这里主要处理
 * 尺寸变化与吸附动画：原生截图可用时立即换新，不可用时重新排一次空闲预热。
 */
function refreshGenieAfterGeometry(el, delay = 0, sizeChanged = false) {
    const run = () => {
        if (!el.isConnected) return;
        import("./genie-capture.js")
            .then((m) => (sizeChanged ? m.geometryChanged(el) : m.refreshWindow(el)))
            .catch(() => {});
    };
    if (delay > 0) setTimeout(run, delay);
    else requestAnimationFrame(run);
}

/**
 * 统一的按下入口：边带 → 缩放，标题栏 → 拖动，其余只置顶取焦点。
 * 缩放不再靠坐标猜（那正是 iframe 场景下失效的根因）：命中窗口自己的边带元素即算。
 * 放在捕获阶段，是为了让边框压过内容自己绑的按下处理。
 * @param {object} rec
 */
export function bindInteractions(rec) {
    const el = rec.el;

    el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !el.isConnected) return;
        if (el._minimized || el.classList.contains("minimized") || el.style.display === "none") return;
        // 入场动画期间用户先按下了窗口：立即落到最终位置，避免位移和拖动抢同一个 top。
        if (el._wmOpenAnim || el._wmOpenPending) {
            if (typeof el._wmCancelOpen === "function") el._wmCancelOpen();
        }
        const band = e.target.closest ? e.target.closest(".wm-edge") : null;
        if (band && band.parentElement === el) {
            startResize(rec, band.dataset.wmEdge, e);
            return;
        }
        // 老插件自带的右下角 .resizer：继续当东南手柄用
        if (e.target.closest && e.target.closest(".resizer")) {
            startResize(rec, "se", e);
            return;
        }
        if (inDragZone(rec, e)) {
            // 双击标题栏 = 缩放（macOS 默认行为）。
            // 这里自己数两次按下，而不是绑 dblclick：拖动起手会 preventDefault()，
            // 兼容鼠标事件被整段抑制，dblclick 根本不会再派发。
            const now = performance.now();
            const last = rec.lastTitleTap;
            const isDouble = !!last && now - last.t < 400
                && Math.abs(e.clientX - last.x) < 8 && Math.abs(e.clientY - last.y) < 8;
            rec.lastTitleTap = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
            if (isDouble) {
                focusWindow(el);
                if (!el.classList.contains("no-resize") && ops.setZoom) ops.setZoom(el);
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            startDrag(rec, e);
            return;
        }
        // 点到内容也算「用了这个窗口」：置顶 + 活跃（红绿灯随之上色）
        focusWindow(el);
    }, true);

    // hover：只在「进了哪条边带」变化时做一次让位判定（见 syncBandYield），不逐像素算
    el.addEventListener("pointermove", (e) => {
        if (rec.mode) return;
        syncBandYield(rec, e.clientX, e.clientY);
    });
    el.addEventListener("pointerleave", () => {
        if (rec.mode) return;
        rec.hoverEdge = null;
        el.querySelectorAll(":scope > .wm-edge.blocked").forEach((b) => b.classList.remove("blocked"));
    });
}

/**
 * 拖动窗口。
 * 从缩放态 / 平铺态起手时先脱开（macOS：拖一个已缩放的窗口，它会缩回用户框架并跟住指针），
 * 脱开后指针仍落在标题栏内同一相对位置，不会出现「一按就跳走」。
 * NW-2：dragAxis / dragBounds 在 clampDrag 之后再夹；snap "none"|"edges" 控制吸附预览。
 * NW-1：拖动过程中子窗按同一位移跟随（followMove）。
 */
function startDrag(rec, e) {
    const el = rec.el;
    if (rec.fullscreen) return;      // macOS：全屏窗口没有可拖的标题栏
    if (rec.split) return;           // 分屏中窗口位置由分隔条决定，标题栏不可拖
    focusWindow(el);

    const before = frameOf(el);
    const anchor = { x: before.x, y: before.y };
    const conf = dragConf(el);
    rec.grab = { dx: e.clientX - before.x, dy: e.clientY - before.y };
    rec.mode = DRAG;
    rec.moved = false;
    rec.start = { x: e.clientX, y: e.clientY };
    // 缩放态 / 平铺态先记着，等「真的开始移动」那一刻才脱开 ——
    // 在按下就还原的话，双击标题栏的第一击会把窗口缩回去，第二击又放大回去，
    // 用户看到的是「双击没反应」（macOS 只在拖动时脱开，单击不动它）。
    rec.pending = (rec.zoomed || rec.tiled) ? { normal: rec.normal || before } : null;
    beginInteraction(DRAG, "");
    e.preventDefault();
    e.stopPropagation();

    // FS-14：把窗口拖到屏幕最上缘并停留 400ms = 打开窗口总览。
    // 计时器只在「指针确实停在上缘」时存在，移开即撤销；松手由 finish 清掉，
    // 所以不会出现拖动结束后自己弹总览。
    let topDwell = null;
    const armTopDwell = (ev) => {
        if (ev.clientY <= 2) {
            if (!topDwell) {
                topDwell = setTimeout(() => {
                    topDwell = null;
                    import("./overview.js")
                        .then((m) => { if (!m.isOverviewOpen()) m.open(); })
                        .catch(() => {});
                }, 400);
            }
        } else if (topDwell) {
            clearTimeout(topDwell);
            topDwell = null;
        }
    };

    const move = (ev) => {
        if (rec.mode !== DRAG || !el.isConnected) return finish();
        if (!rec.moved && Math.abs(ev.clientX - rec.start.x) < 3 && Math.abs(ev.clientY - rec.start.y) < 3) return;
        rec.moved = true;
        armTopDwell(ev);
        if (rec.pending) {
            const normal = rec.pending.normal;
            rec.zoomed = false;
            rec.tiled = null;
            syncState(el, rec);
            // 脱开后让指针落在标题栏内同一相对位置，窗口不会「跳」到别处
            const rel = before.w > 0 ? (ev.clientX - before.x) / before.w : 0.5;
            rec.grab = {
                dx: Math.min(Math.max(normal.w * 0.12, normal.w * rel), normal.w - 20),
                dy: Math.min(ev.clientY - before.y, 20),
            };
            const pos = clampDrag(ev.clientX - rec.grab.dx, ev.clientY - rec.grab.dy, { w: normal.w, h: normal.h });
            applyFrame(el, clampFrame({ x: pos.x, y: pos.y, w: normal.w, h: normal.h }, limitsOf(el)));
            rec.pending = null;
        }
        const f = frameOf(el);
        const raw = clampDrag(ev.clientX - rec.grab.dx, ev.clientY - rec.grab.dy, { w: f.w, h: f.h });
        const next = applyDragConstraints(el, raw.x, raw.y, { w: f.w, h: f.h }, anchor);
        const dx = next.x - f.x;
        const dy = next.y - f.y;
        applyFrame(el, { x: next.x, y: next.y, w: f.w, h: f.h });
        followMove(el, dx, dy);
        // NW-6 吸附三态：tile = 现有九分区预览；edges = 只停驻屏边不预览；none = 完全关闭
        if (conf.snap === "tile") {
            const zone = snapZoneAt(ev.clientX, ev.clientY);
            if (zone) showPreview(zone.frame, parseInt(el.style.zIndex, 10) || 2050);
            else hidePreview();
            rec.snap = zone;
        } else {
            rec.snap = null;
            if (conf.snap === "edges") {
                const vf = visibleFrame();
                const ex = Math.max(vf.left, Math.min(next.x, vf.left + vf.width - f.w));
                const ey = Math.max(vf.top, Math.min(next.y, vf.top + vf.height - f.h));
                if (ex !== next.x || ey !== next.y) {
                    applyFrame(el, { x: ex, y: ey, w: f.w, h: f.h });
                    followMove(el, ex - next.x, ey - next.y);
                }
            }
        }
    };
    function finish() {
        if (topDwell) { clearTimeout(topDwell); topDwell = null; }
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (rec.mode !== DRAG) return;
        hidePreview();
        const snapped = !!rec.snap;
        const changed = rec.moved || snapped;
        if (rec.snap) {
            if (rec.snap.region === "zoom") { if (ops.setZoom) ops.setZoom(el, { on: true }); }
            else if (ops.tile) ops.tile(el, rec.snap.region);
        } else if (rec.moved) {
            rec.normal = frameOf(el);
            emitWindowEvent("move", el);
        }
        rec.pending = null;
        rec.moved = false;
        endInteraction(rec);
        if (changed) refreshGenieAfterGeometry(el, snapped ? WM_ANIM_MS : 0, snapped);
    }
    // 监听挂在 document：拖动途中指针会跑到遮罩上、别的窗口上、甚至浏览器外面，
    // 挂在窗口自己身上会漏事件（旧实现的 mousemove 就是这么断线的）。
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    // 在浏览器窗口外松开鼠标收不到 pointerup，不兜底就会留一只永远跟手的窗口
    window.addEventListener("blur", finish);
}

/**
 * 沿某条边 / 角缩放：对侧边为锚点（macOS 行为），⌥ 或声明的 aspectRatio 锁宽高比，
 * 尺寸边界取窗口自己的 min / max（含 data-window 声明与插件 CSS）。
 * NW-3：resizeAxis 为单轴时，角带与老式 .resizer 的 "se" 归一到对应单边。
 */
function startResize(rec, edge, e) {
    const el = rec.el;
    // 全屏窗口没有可缩的边框 —— 与 startDrag 同一道守卫。分屏同理（尺寸归分隔条）。
    if (rec.fullscreen || rec.split) return;
    const { axis, aspect } = resizeConf(el);
    if (axis === "none") return;
    let effectiveEdge = edge;
    if (axis === "x" && !/[ew]/.test(edge)) effectiveEdge = "e";
    else if (axis === "y" && !/[ns]/.test(edge)) effectiveEdge = "s";
    focusWindow(el);
    // 手动缩放即接管框架：缩放态 / 平铺态直接结束，当前框成为新的用户框
    if (rec.zoomed || rec.tiled) {
        rec.zoomed = false;
        rec.tiled = null;
        syncState(el, rec);
    }
    const base = frameOf(el);
    const limits = limitsOf(el);
    const vf = visibleFrame();
    // 抓取偏移：按下点通常落在边带中间（离真边框 2~3px），不记这个偏移的话，
    // 一按下边缘就会瞬移到指针处，窗口会「跳」掉那两三像素。
    const anchorPoint = {
        x: effectiveEdge.includes("w") ? base.x : effectiveEdge.includes("e") ? base.x + base.w : e.clientX,
        y: effectiveEdge.includes("n") ? base.y : effectiveEdge.includes("s") ? base.y + base.h : e.clientY,
    };
    const off = { x: e.clientX - anchorPoint.x, y: e.clientY - anchorPoint.y };
    rec.mode = RESIZE;
    beginInteraction(RESIZE, EDGE_CURSOR[effectiveEdge]);
    e.preventDefault();
    e.stopPropagation();

    let changed = false;
    const move = (ev) => {
        if (rec.mode !== RESIZE || !el.isConnected) return finish();
        changed = true;
        const to = { x: ev.clientX - off.x, y: ev.clientY - off.y };
        const next = resizeFrame(base, effectiveEdge, to, limits, { keepAspect: ev.altKey || !!aspect, aspect });
        // 左右下三边允许越出可视区（macOS 允许），但顶边不许钻进菜单栏底下，
        // 并且始终留 40px 在屏内，否则窗口再也点不到。
        next.x = Math.max(-next.w + RESIZE_KEEP_GRABBABLE, Math.min(next.x, window.innerWidth - RESIZE_KEEP_GRABBABLE));
        next.y = Math.max(vf.top, Math.min(next.y, window.innerHeight - RESIZE_KEEP_TITLE));
        next.w = Math.min(next.w, window.innerWidth + RESIZE_MAX_OVERFLOW);
        next.h = Math.min(next.h, window.innerHeight - next.y);
        applyFrame(el, next);
    };
    function finish() {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (rec.mode !== RESIZE) return;
        rec.normal = frameOf(el);
        endInteraction(rec);
        if (changed) {
            emitWindowEvent("resize", el);
            refreshGenieAfterGeometry(el, 0, true);
        }
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
}
