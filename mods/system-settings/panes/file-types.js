/**
 * panes/file-types.js — 「App › 文件类型」二级页
 *
 * 默认应用的界面在 sections/default-apps.js 里；这里只是把它按「文件类型」这一截
 * 装成独立面板，好让 App 页的跳转行（.ss-linkrow）能进入它。
 */

import { build as buildDefaultApps, messages as defaultAppsMessages } from "../sections/default-apps.js";

export const paneId = "file-types";

export const messages = defaultAppsMessages;

/**
 * 构建面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    return buildDefaultApps(ctx, "files");
}
