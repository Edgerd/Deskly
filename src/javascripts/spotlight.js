/**
 * spotlight.js — 聚焦的内核适配层（薄壳，无实现）
 *
 * 聚焦已收成一个独立系统应用（mods/spotlight/，entry=background，可见性 API 声明
 * 启动台/设置/访达不显示、不可卸载）。本文件存在的唯一理由：
 *   1. bootstrap.js 的可选内核模块链仍按 `./spotlight.js` 点亮它（init / initSpotlight 约定）；
 *   2. mods/system-settings/panes/spotlight.js 等既有调用方从这里 import
 *      openSpotlight / clearHistory（面板冻结期内签名不得变）。
 * 实现本体在 mods/spotlight/script.js；这里只做转发，不新增任何逻辑。
 */

export {
    openSpotlight, closeSpotlight, toggleSpotlight, searchAll, initSpotlight,
    readHistory, recordHistory, clearHistory, HOTKEYS,
} from "../../mods/spotlight/script.js";
