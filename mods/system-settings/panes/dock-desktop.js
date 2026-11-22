/**
 * panes/dock-desktop.js — 「桌面与程序坞 › 桌面」子页
 */

import { buildDesktop, messages } from "./dock.js";

export const paneId = "dock-desktop";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildDesktop();
}
