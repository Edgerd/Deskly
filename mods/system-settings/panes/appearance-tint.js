/**
 * panes/appearance-tint.js — 「外观 › 窗口与菜单栏」子页
 */

import { buildTint, messages } from "./appearance.js";

export const paneId = "appearance-tint";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildTint();
}
