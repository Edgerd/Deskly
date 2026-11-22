/**
 * panes/dock-stage.js — 「桌面与程序坞 › 台前调度」子页
 */

import { buildStage, messages } from "./dock.js";

export const paneId = "dock-stage";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildStage();
}
