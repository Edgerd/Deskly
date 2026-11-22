/**
 * panes/storage.js — 「储存」子面板
 *
 * 实现在 sections/storage.js：这里只做注册表入口（`panes/<module>.js`）的转发，
 * 让「通用 › 储存」这一子项与其它面板用同一套资源加载方式，不复制任何逻辑。
 */

export { paneId, messages, build } from "../sections/storage.js";
