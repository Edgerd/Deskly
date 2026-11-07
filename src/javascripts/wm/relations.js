/**
 * wm/relations.js — 窗口关系：母窗 / 子窗 / sheet / 模态（NW-1 / WAPI-04）
 *
 * 此前所有 .window 皆顶层，辅助窗/面板必然污染 Dock 运行区与「窗口」菜单。
 * 这里补关系图，全部信息落在 rec 新增字段上（role / parent / modal / modalChild），
 * manage() 签名不动，存量窗口默认 role:"normal" 零变化。
 *
 * 行为语义（与 03 报告 NW-1 一致）：
 * - 子窗跟随母窗移动（保持相对偏移）、随母窗关闭 / 最小化 / 恢复；
 *   置前母窗时子窗紧随其后（由 stack.js 的分配序保证：子恒在母上一层、栈内相邻）。
 * - modal:true：母窗 inert（inert 属性，指针与焦点都进不去），模态子窗恒置顶于母窗、
 *   自动获得 modal 层级（NW-4，不开放直接声明）；母窗的关闭 / 最小化被拦到模态关闭后。
 * - role:"sheet"：模态子窗的几何变体 —— 顶边贴母窗标题栏下缘、水平居中于母窗、
 *   宽不超过母窗宽。
 * - 子窗 / sheet 不进 Dock 运行区与「窗口」菜单：el.dataset.wmRole 落标记，
 *   dock.syncRunningApps 按它过滤（getVisibleWindows 保持原样，子窗仍可见可聚焦）。
 */

import { records, recOf, commitStack, assignLevel, stateOf } from "./stack.js";
import { frameOf, applyFrame, clampDrag, TITLEBAR_SAFE_H } from "./frame.js";

/** 合法角色。 */
const ROLES = new Set(["normal", "child", "sheet"]);

/**
 * 沿母窗链检查成环：el 的祖先链里再出现 el 即成环。
 * @param {HTMLElement} el
 * @param {HTMLElement} parent
 * @returns {boolean}
 */
function wouldCycle(el, parent) {
    let p = parent;
    while (p) {
        if (p === el) return true;
        const pr = records.get(p);
        p = pr ? pr.parent : null;
    }
    return false;
}

/**
 * 建立母子 / 模态 / sheet 关系。
 * @param {HTMLElement} el 子窗（必须已托管）
 * @param {{parent?: HTMLElement|null, modal?: boolean, role?: string}} [opts]
 * @returns {object|null} stateOf 快照；失败（成环 / 未托管 / 角色非法）返回 null
 */
export function attach(el, opts = {}) {
    const rec = records.get(el);
    if (!rec) return null;
    const parent = opts.parent || null;
    const role = ROLES.has(opts.role) ? opts.role : (opts.modal ? "child" : "child");
    if (!parent || !records.has(parent)) return null;
    if (parent === el || wouldCycle(el, parent)) return null;
    if (rec.parent) detach(el);

    const modal = !!opts.modal || role === "sheet";
    rec.role = role;
    rec.parent = parent;
    rec.modal = modal;
    el.dataset.wmRole = role;
    if (modal) {
        const parentRec = records.get(parent);
        if (parentRec.modalChild && parentRec.modalChild !== el) detach(parentRec.modalChild);
        parentRec.modalChild = el;
        parent.inert = true;
        assignLevel(el, "modal");
    }
    if (role === "sheet") positionSheet(el);
    commitStack();
    return stateOf(el);
}

/**
 * 解除关系，退回普通窗。
 * @param {HTMLElement} el
 * @returns {boolean}
 */
export function detach(el) {
    const rec = records.get(el);
    if (!rec || !rec.parent) return false;
    const parent = rec.parent;
    const parentRec = records.get(parent);
    if (parentRec && parentRec.modalChild === el) {
        parentRec.modalChild = null;
        parent.inert = false;
    }
    if (rec.modal) assignLevel(el, "normal");
    rec.role = "normal";
    rec.parent = null;
    rec.modal = false;
    el.dataset.wmRole = "normal";
    commitStack();
    return true;
}

/** 母窗（无则 null）。 */
export function parentOf(target) {
    const el = typeof target === "string" ? document.getElementById(target) : target;
    const rec = el ? records.get(el) : null;
    return rec && rec.parent ? rec.parent : null;
}

/**
 * 全部直接子窗。
 * 以 DOM 为准扫描而不是焦点栈：最小化的窗口会被摘出栈（setMinimized），
 * 而级联恢复 / 级联关闭恰恰要在那个状态下找到它们。
 */
export function childrenOf(target) {
    const el = typeof target === "string" ? document.getElementById(target) : target;
    if (!el) return [];
    return Array.from(document.querySelectorAll("body > .window")).filter((w) => {
        const r = records.get(w);
        return r && r.parent === el;
    });
}

/**
 * sheet 几何：顶边贴母窗标题栏下缘、水平居中于母窗、宽不超过母窗宽。
 * @param {HTMLElement} el sheet 子窗
 */
export function positionSheet(el) {
    const rec = records.get(el);
    if (!rec || !rec.parent) return;
    const pf = frameOf(rec.parent);
    const f = frameOf(el);
    const w = Math.min(f.w, pf.w);
    const x = pf.x + (pf.w - w) / 2;
    // 母窗标题栏下缘 ≈ 母窗顶 + 安全带高（38px 项目既定标题栏高度）
    const y = pf.y + Math.min(TITLEBAR_SAFE_H, pf.h);
    applyFrame(el, { x, y, w, h: f.h });
}

/**
 * 跟随移动：母窗位移 (dx, dy) 时全部子孙窗同步位移（递归）。
 * 只动位置、不动尺寸；越界时用与拖动同一套 clampDrag 钳回。
 * @param {HTMLElement} parent
 * @param {number} dx
 * @param {number} dy
 */
export function followMove(parent, dx, dy) {
    if (!dx && !dy) return;
    childrenOf(parent).forEach((child) => {
        if (!child.isConnected) return;
        const f = frameOf(child);
        const next = clampDrag(f.x + dx, f.y + dy, { w: f.w, h: f.h });
        applyFrame(child, { x: next.x, y: next.y, w: f.w, h: f.h });
        const rec = records.get(child);
        if (rec && rec.normal && !rec.zoomed && !rec.tiled && !rec.fullscreen) {
            rec.normal = { ...rec.normal, x: next.x, y: next.y };
        }
        followMove(child, dx, dy);
    });
}

/**
 * 模态拦截：母窗当前有存活模态子窗时返回它（调用方应聚焦它并中止原操作）。
 * @param {HTMLElement} el
 * @returns {HTMLElement|null}
 */
export function modalChildOf(el) {
    const rec = records.get(el);
    const child = rec ? rec.modalChild : null;
    return child && child.isConnected ? child : null;
}

/**
 * 窗口脱离托管 / 摘除前的关系清理：把自己从母窗账上划掉，并解除自己的模态锁。
 * 幂等，release 与 close 收尾都会走这里。
 * @param {HTMLElement} el
 */
export function unlink(el) {
    const rec = recOf(el);
    if (!rec) return;
    if (rec.parent) detach(el);
    if (rec.modalChild) detach(rec.modalChild);
}
