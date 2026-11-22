/**
 * panes/appearance-colors.js — 「外观 › 颜色与主题」子页
 *
 * 具体控件与语言包都在 appearance.js；这里只做外壳需要的模块入口。
 */

import { buildColors, messages } from "./appearance.js";

export const paneId = "appearance-colors";

export { messages };

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    return buildColors();
}
