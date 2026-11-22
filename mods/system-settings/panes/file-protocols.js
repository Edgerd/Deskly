/**
 * panes/file-protocols.js — 「App › 协议与网页」二级页
 *
 * 同 file-types.js：复用 sections/default-apps.js 的渲染，只取协议那一截。
 */

import { build as buildDefaultApps, messages as defaultAppsMessages } from "../sections/default-apps.js";

export const paneId = "file-protocols";

export const messages = defaultAppsMessages;

/**
 * 构建面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    return buildDefaultApps(ctx, "protocols");
}
