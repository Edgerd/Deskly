/**
 * panes/appearance-desktop.js — 「外观 › 桌面与滚动」子页
 */

import { buildDesktop, messages } from "./appearance.js";

export const paneId = "appearance-desktop";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildDesktop();
}
