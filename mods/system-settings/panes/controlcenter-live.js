/**
 * panes/controlcenter-live.js — 「控制中心 › 实时状态」子页
 */

import { buildLive, messages } from "./controlcenter.js";

export const paneId = "controlcenter-live";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildLive();
}
