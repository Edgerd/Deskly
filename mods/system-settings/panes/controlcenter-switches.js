/**
 * panes/controlcenter-switches.js — 「控制中心 › 开关」子页
 */

import { buildSwitches, messages } from "./controlcenter.js";

export const paneId = "controlcenter-switches";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildSwitches();
}
