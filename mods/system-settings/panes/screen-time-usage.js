/**
 * panes/screen-time-usage.js — 「屏幕使用时间 › 使用情况」子页
 */

import { buildUsage, messages } from "./screen-time.js";

export const paneId = "screen-time-usage";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildUsage();
}
