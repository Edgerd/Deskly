/**
 * visibleOrder.js — 可见列表与权威顺序之间的下标换算。
 *
 * 启动台会保留被禁用应用在布局里的位置（重新启用后才能回到原处），但渲染时跳过它们；
 * 程序坞收藏同理。拖拽落点来自可见 DOM（索引只会数可见格），写回时必须换回权威数组
 * 的下标，否则隐藏条目会把落点整体挤偏，表现为「拖到第 3 位、松手却跑到第 1 位」。
 */

/**
 * 可见序列的插入槽位 → 权威数组下标。
 * @param {Array<object|string>} items 权威顺序
 * @param {number} slot 可见条目之间的插入位置（0..可见条目数）
 * @param {(item: object|string) => boolean} isVisible 该条目是否在界面上占一格
 * @returns {number} 可直接交给 splice 的下标
 */
export function slotToIndex(items, slot, isVisible) {
    let seen = 0;
    for (let i = 0; i < items.length; i += 1) {
        if (!isVisible(items[i])) continue;
        if (seen === slot) return i;
        seen += 1;
    }
    return items.length;
}

/**
 * 按可见图标的新顺序重排一个含隐藏项的数组，隐藏项留在原来的槽位。
 * 用于程序坞收藏区拖拽排序：被禁用应用的图标不渲染，但收藏顺序不能被一次拖拽裁掉。
 * @param {string[]} previous 权威顺序（含隐藏项）
 * @param {string[]} visibleKeys 拖拽后可见图标的顺序
 * @param {(key: string) => boolean} isHidden 该键是否隐藏
 * @returns {string[]} 新顺序；可见项数量对不上时原样返回，避免误删
 */
export function reorderKeepingHidden(previous, visibleKeys, isHidden) {
    const visiblePrev = previous.filter((key) => !isHidden(key));
    const ordered = visibleKeys.filter((key) => key && !isHidden(key));
    if (ordered.length !== visiblePrev.length) return previous;
    let visibleIndex = 0;
    return previous.map((key) => (isHidden(key) ? key : ordered[visibleIndex++]));
}
