/**
 * panes/screen-time-downtime.js — 「屏幕使用时间 › 停用时间」子页
 */

import { buildDowntime, messages } from "./screen-time.js";

export const paneId = "screen-time-downtime";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildDowntime();
}
