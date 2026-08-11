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
 * @param {boolean} [options.vertical] 是否垂直方向（缺省按容器宽高自动判断）
 */
export function enableSortable(containerEl, handlers = {}, options = {}) {
    if (!containerEl) return;

    const getKey = handlers.getKey || ((item) => item.dataset.key || item.id || "");
    const onOrderChange = handlers.onOrderChange || (() => {});
    const vertical = options.vertical ?? (containerEl.clientHeight > containerEl.clientWidth);

    let dragging = null;

    const bindItem = (item) => {
        if (item.dataset.sortableBound) return;
        item.dataset.sortableBound = "true";
        item.draggable = true;

        item.addEventListener("dragstart", (e) => {
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
            const rect = item.getBoundingClientRect();
            const after = (vertical ? e.clientY : e.clientX)
                > (vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2);
            const ref = after ? item.nextSibling : item;
            if (ref !== dragging) containerEl.insertBefore(dragging, ref);
        });

        item.addEventListener("dragend", () => {
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
        },
    };
}