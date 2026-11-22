/**
 * panes/dock-windows.js — 「桌面与程序坞 › 窗口与启动台」子页
 */

import { buildWindows, messages } from "./dock.js";

export const paneId = "dock-windows";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildWindows();
}
