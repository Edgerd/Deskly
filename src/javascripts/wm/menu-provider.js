/**
 * wm/menu-provider.js — 顶栏「窗口」菜单的平铺分区数据源（F-13）
 *
 * 顶栏「窗口」菜单目前只硬编码了左/右两半（finderbar.js 的 DEFAULT_SUB_MENU，
 * 归菜单栏批次所有）。本模块把 TILE_REGIONS 全量映射为菜单条目数据，
 * 挂到 window.__wmApi.windowTileMenuItems 上（window-manager.js 求值期装配），
 * finderbar 侧只需在生成「窗口」菜单时消费这一个 provider 就能对齐原版九分区。
 *
 * cmd 形如 `tileActiveWindow('left')`，与现有菜单动作分发器的登记名一致；
 * tileActiveWindow 的实现在 finderbar.js（runOnTopWindow -> wm.tile(top, region)），
 * 任意 region 都能分发，缺的只是菜单条目。
 */

import { TILE_REGIONS } from "./frame.js";
import { i18n } from "../i18n.js";

/** 每个分区的菜单文案键 / 兜底文案 / 图标名（图标由消费方映射，provider 只给键名）。 */
const TILE_ITEM_DEFS = {
  left: { key: "window.tileLeft", fallback: "平铺到左侧" },
  right: { key: "window.tileRight", fallback: "平铺到右侧" },
  top: { key: "window.tileTop", fallback: "平铺到上方" },
  bottom: { key: "window.tileBottom", fallback: "平铺到下方" },
  leftTop: { key: "window.tileLeftTop", fallback: "左上角" },
  rightTop: { key: "window.tileRightTop", fallback: "右上角" },
  leftBottom: { key: "window.tileLeftBottom", fallback: "左下角" },
  rightBottom: { key: "window.tileRightBottom", fallback: "右下角" },
  center: { key: "window.center", fallback: "居中" },
};

/**
 * 生成顶栏「窗口」菜单的平铺条目（按 TILE_REGIONS 顺序，全量九分区）。
 * @returns {{label: string, cmd: string, region: string}[]}
 */
export function windowTileMenuItems() {
  return TILE_REGIONS.map((region) => {
    const def = TILE_ITEM_DEFS[region] || { key: `window.tile${region}`, fallback: region };
    return {
      region,
      label: i18n.t(def.key, def.fallback),
      cmd: `tileActiveWindow('${region}')`,
    };
  });
}
