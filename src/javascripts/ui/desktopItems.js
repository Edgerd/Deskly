/**
 * desktopItems.js — 桌面图标共用逻辑（放置策略 + 拖拽）
 *
 * 此前有两份实现：desktop.js 用「最后一个 container」并且新 container 只 push 进数组
 * 而不插入 DOM；ui/contextMenu.js 的 createDesktopFile 用「第一个 container」并自带
 * 一套 per-item 的 document 级 mousemove/mouseup 监听。结果是：
 *   - 拖入的第 7 个之后的文件被放进游离节点，永远看不见且不可回收；
 *   - 右键新建的文件夹与拖入的文件落在不同列；
 *   - 每个新建图标永久挂着 2 个 document 监听器。
 * 这里作为唯一实现，两个调用方都走它。
 */

import { Z } from "../zindex.js";

const MAX_ITEMS_PER_CONTAINER = 6;
/**
 * 把图标放入桌面上合适的列：最后一列未满则追加，满了才新建列并插入文档。
 * 列的可用性直接以 DOM 为准（不依赖调用方自己维护的数组），避免双方状态不同步。
 * @param {HTMLElement} item 桌面图标元素
 * @returns {HTMLElement|null} 所属列容器
 */
export function appendDesktopItem(item) {
    const desktop = document.querySelector(".desktop");
    if (!desktop) {
        console.warn("[desktopItems] 桌面尚未就绪，忽略图标放置");
        return null;
    }
    const containers = Array.from(desktop.querySelectorAll(":scope > .container"));
    let target = containers[containers.length - 1];
    if (!target || target.querySelectorAll(":scope > .item").length >= MAX_ITEMS_PER_CONTAINER) {
        target = document.createElement("div");
        target.className = "container";
        desktop.appendChild(target);
    }
    target.appendChild(item);
    return target;
}

// 全局唯一的拖拽状态 + mousemove / mouseup 各一份监听：
// 图标自身只需绑 mousedown，删除图标不会残留监听器。
let dragState = null;

document.addEventListener("mousemove", (e) => {
    if (!dragState) return;
    dragState.item.style.left = `${e.clientX - dragState.offsetX}px`;
    dragState.item.style.top = `${e.clientY - dragState.offsetY}px`;
});

document.addEventListener("mouseup", () => {
    if (!dragState) return;
    const { item } = dragState;
    item.style.zIndex = "0";
    item.style.cursor = "";
    dragState = null;
});

/**
 * 让一个桌面图标可以被拖动。
 * @param {HTMLElement} item 图标元素
 */
export function makeDraggable(item) {
    item.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        // 正在编辑名称时不启动拖拽，否则点击文字会打断输入
        if (e.target.closest("[contenteditable=\"true\"]")) return;

        document.querySelectorAll(".item.selected").forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");

        const rect = item.getBoundingClientRect();
        dragState = { item, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };

        item.style.position = "fixed";
        item.style.margin = "0";
        item.style.left = `${rect.left}px`;
        item.style.top = `${rect.top}px`;
        item.style.zIndex = String(Z.WINDOW_MIN - 10);
        item.style.cursor = "grabbing";
        e.preventDefault();
        e.stopPropagation();
    });
}
