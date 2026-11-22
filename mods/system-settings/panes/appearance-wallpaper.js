/**
 * panes/appearance-wallpaper.js — 「外观 › 墙纸」子页
 */

import { buildWallpaperPage, messages } from "./appearance.js";

export const paneId = "appearance-wallpaper";

export { messages };

/**
 * 构建面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    return buildWallpaperPage(ctx);
}
