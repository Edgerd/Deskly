/**
 * panes/controlcenter-menubar.js — 「控制中心 › 菜单栏状态项」子页
 */

import { buildMenubar, messages } from "./controlcenter.js";

export const paneId = "controlcenter-menubar";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildMenubar();
}
