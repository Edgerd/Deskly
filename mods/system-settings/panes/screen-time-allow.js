/**
 * panes/screen-time-allow.js — 「屏幕使用时间 › 始终允许」子页
 */

import { buildAllow, messages } from "./screen-time.js";

export const paneId = "screen-time-allow";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildAllow();
}
