/**
 * panes/dock-main.js — 「桌面与程序坞 › 程序坞」子页
 */

import { buildDock, messages } from "./dock.js";

export const paneId = "dock-main";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildDock();
}
