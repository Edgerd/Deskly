/**
 * zindex.js — 通用浮层层级管理
 *
 * 这里是全项目层级的唯一定义处：CSS 与 JS 都从这张表取值，
 * 避免出现「文档说 9500 是 Dock、代码里却写着 2147483646」这种互相覆盖的情况。
 *
 *   2050 - 9000  窗口（window.js 递增分配，到顶重排回收）
 *   ≤ 9499       普通浮层（顶栏下拉 .menu，CSS 默认 7000，点击时在此封顶内提升）
 *   9500         Dock
 *   9510         Dock 文件夹堆栈（从 Dock 弹出，需盖过窗口与 Dock）
 *   9600         启动台
 *   9610         系统弹窗 / 通知
 *   9620         右键菜单（须盖过窗口与普通浮层，也要盖过它所属的弹窗）
 *   9630         控制中心 / 日期弹层（从顶栏垂下，可与右键菜单同级共存）
 *   9640         浮出层（下拉菜单 portal，须盖过窗口与 Dock，但仍低于聚焦搜索）
 *   9700         聚焦搜索面板（系统级检索浮层，盖过弹层与窗口，但仍在菜单栏之下）
 *   9999         菜单栏
 *   10000        显示亮度压暗层（盖过一切界面内容）
 *   10001        Night Shift 暖色层（= 压暗层 + 1，与压暗层叠加相乘）
 *   10010        会话遮罩（锁屏 / 睡眠 / 关机，盖过压暗层与暖色层）
 */

export const Z = {
    WINDOW_MIN: 2050,
    WINDOW_MAX: 9000,
    MENU_FLOAT_MAX: 9499,
    DOCK: 9500,
    DOCK_STACK: 9510,
    LAUNCHPAD: 9600,
    MODAL: 9610,
    CONTEXT: 9620,
    PANEL: 9630,
    POPOVER: 9640,
    SPOTLIGHT: 9700,
    MENU_BAR: 9999,
    BRIGHTNESS: 10000,
    // Night Shift 暖色层紧压压暗层之上（= BRIGHTNESS + 1）：两层都是 multiply，
    // 先压暗再染暖，顺序反过来暖色会被黑层吃掉。
    NIGHT_SHIFT: 10001,
    SESSION: 10010,
};

// 菜单浮层封顶：不得盖住 Dock 及以上的系统固定层
const MENU_Z_MAX = Z.MENU_FLOAT_MAX;

// 固定层级元素（Dock / 启动台 / 右键菜单 / 弹层 / 遮罩）不参与动态提升：
// 它们的位置由上表决定，提升它们只会破坏层级关系（历史 bug：把右键菜单从
// INT_MAX 一路降到 9499，结果被 Dock 和菜单栏盖住）。
// .os-popover-layer 是下拉菜单的 portal 层（ui/popover.js），同理不参与提升。
const FIXED_LAYER_SELECTOR = ".contextmenu, .dock, .dock-stack, .launchpad, .finderbar, .controlcenter, .session-overlay, .os-overlay, .os-popover-layer";

/**
 * 将普通浮层提升到当前所有普通浮层之上。
 * - 传入 .window 元素或其内部节点：层级由 window.js 的 bringToFront 管理，本函数不越权；
 * - 传入 .menu 或其内部节点：提升其所在菜单的 z-index 到当前最高 + 1（封顶 9499）；
 * - 固定层元素：不处理；
 * - 其他元素：直接提升自身（同样封顶）。
 *
 * @param {Element} element 被点击的元素
 */
export function bringToFront(element) {
    if (!element || element.nodeType !== 1) return;
    // 窗口层级由 window.js 管理，避免双体系递增冲突
    if (element.classList && element.classList.contains("window")) return;
    // 定位浮层本体：菜单内部点击时提升其所在 .menu
    const layer = element.closest ? element.closest(".menu") : null;
    const target = layer || element;
    if (target.matches(FIXED_LAYER_SELECTOR)) return;

    // 计算当前窗口/普通浮层的最高层级（量级小：窗口数个、菜单个位数，可全量扫描）
    let top = 0;
    document.querySelectorAll(".window, .menu:not(.contextmenu)").forEach((el) => {
        const value = parseInt(window.getComputedStyle(el).zIndex, 10);
        if (!isNaN(value) && value > top) top = value;
    });
    const current = parseInt(window.getComputedStyle(target).zIndex, 10) || 0;
    const next = Math.max(current + 1, top + 1);
    target.style.zIndex = String(Math.min(next, MENU_Z_MAX));
}
