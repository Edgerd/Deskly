/**
 * sortable.js — 通用拖拽排序模块
 *
 * 为容器内的子元素提供基于 HTML5 Drag & Drop 的拖拽排序能力，
 * 支持水平（Dock 栏）与垂直（列表）两种布局方向，排序完成后
 * 通过 onOrderChange 回调对外暴露新的顺序，供上层持久化到缓存。
 *
 * 用法：
 *   import { enableSortable } from "./sortable.js";
 *   enableSortable(containerEl, {
 *       getKey: (item) => item.dataset.key,   // 可选：取元素标识
 *       onOrderChange: (keys) => saveToCache(keys), // 必填：排序后回调
 *   });
 */

let uid = 0;

/**
 * 获取容器内所有子元素的标识集合。
 * @param {HTMLElement} containerEl 容器元素
 * @param {Function} [getKey] 取元素标识的函数，缺省时返回元素 dataset.key
 * @returns {Array} 按当前 DOM 顺序排列的标识数组
 */
function collectKeys(containerEl, getKey) {
    const keyFn = getKey || ((item) => item.dataset.key || item.id || "");
    return Array.from(containerEl.children).map(keyFn);
}

/**
 * 为容器启用拖拽排序。
 * @param {HTMLElement} containerEl 容器元素（其直接子元素将被排序）
 * @param {Object} handlers 处理函数
 * @param {Function} [handlers.getKey] 取元素标识，用于回传顺序
 * @param {Function} [handlers.onOrderChange] 排序完成后的回调，参数为新的标识数组
 * @param {Object} [options] 可选配置
 * @param {boolean} [options.vertical] 是否垂直方向（缺省时每次拖拽开始按容器宽高自动判断）
 */
export function enableSortable(containerEl, handlers = {}, options = {}) {
    if (!containerEl) return;

    const getKey = handlers.getKey || ((item) => item.dataset.key || item.id || "");
    const onOrderChange = handlers.onOrderChange || (() => {});
    // 布局轴在每次 dragstart 时实时判定，而不是 bind 时一次定死：
    // Dock 可在运行中被移到左/右侧（applyDockPosition 只改 CSS class），
    // bind 期取到的轴向不会随之更新，拖拽中点判断会用错轴导致图标跳错槽位。
    const autoVertical = () => containerEl.clientHeight > containerEl.clientWidth;
    let vertical = options.vertical ?? autoVertical();

    let dragging = null;

    // —— rAF 节流的排序写入 ——
    // dragover 事件在鼠标移动时高频触发（可远超 60Hz）。原实现每个事件都
    // getBoundingClientRect()（读取）+ 可能 insertBefore()（写入），构成
    // "读-写-读"的强制同步布局（FSL）循环。现改为：dragover 只记录悬停目标
    // 与指针坐标，布局读取与 DOM 写入统一在下一帧回调执行（每帧至多一次 FSL）。
    let hoverItem = null;
    let hoverX = 0;
    let hoverY = 0;
    let sortRafId = null;

    const flushSort = () => {
        sortRafId = null;
        if (!dragging || !hoverItem || dragging === hoverItem) return;
        const rect = hoverItem.getBoundingClientRect(); // 读取布局（每帧至多一次）
        const after = (vertical ? hoverY : hoverX) >
            (vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2);
        const ref = after ? hoverItem.nextSibling : hoverItem;
        if (ref !== dragging) containerEl.insertBefore(dragging, ref); // 写入（每帧至多一次）
    };

    const scheduleSort = (item, x, y) => {
        hoverItem = item;
        hoverX = x;
        hoverY = y;
        if (sortRafId) return; // 已有一帧待执行，仅更新最新坐标
        sortRafId = requestAnimationFrame(flushSort);
    };

    const cancelSortFrame = () => {
        if (sortRafId) { cancelAnimationFrame(sortRafId); sortRafId = null; }
    };

    const bindItem = (item) => {
        if (item.dataset.sortableBound) return;
        item.dataset.sortableBound = "true";
        item.draggable = true;

        item.addEventListener("dragstart", (e) => {
            cancelSortFrame();
            // 每次拖拽开始时重新判定轴向，跟随 Dock 的 bottom/left/right 实时切换
            vertical = options.vertical ?? autoVertical();
            dragging = item;
            item.classList.add("sortable-dragging");
            e.dataTransfer.effectAllowed = "move";
            try {
                e.dataTransfer.setData("text/plain", getKey(item) || String(uid++));
            } catch (_) { /* 某些环境不接受空数据 */ }
        });

        item.addEventListener("dragover", (e) => {
            if (!dragging || dragging === item) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            scheduleSort(item, e.clientX, e.clientY); // 只记录，布局读写交给帧回调
        });

        item.addEventListener("dragend", () => {
            cancelSortFrame();
            item.classList.remove("sortable-dragging");
            dragging = null;
            onOrderChange(collectKeys(containerEl, getKey));
        });

        item.addEventListener("drop", (e) => {
            e.preventDefault();
        });
    };

    // 初始绑定已有子元素
    Array.from(containerEl.children).forEach(bindItem);

    // 监听容器新增的子元素（如 addToDock 动态添加），自动绑定拖拽
    const observer = new MutationObserver(() => {
        Array.from(containerEl.children).forEach(bindItem);
    });
    observer.observe(containerEl, { childList: true });

    return {
        destroy() {
            observer.disconnect();
            cancelSortFrame();
            dragging = null;
            hoverItem = null;
        },
    };
}