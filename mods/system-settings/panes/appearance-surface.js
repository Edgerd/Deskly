/**
 * panes/appearance-surface.js — 「外观 › 侧栏与模糊」子页
 */

import { buildSurface, messages } from "./appearance.js";

export const paneId = "appearance-surface";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildSurface();
}
