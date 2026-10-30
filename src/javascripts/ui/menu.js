/**
 * menu.js — 菜单项点击的视觉反馈与命令分发
 *
 * MV3 扩展页面 CSP 禁止内联事件处理器，index.html 的静态菜单项一律由
 * bootstrap.js 以 addEventListener 绑定到这里；命令解析见 ui/menuCommands.js。
 */
import { closeAllMenus } from "../finderbar.js";
import { dispatchMenuCommand } from "./menuCommands.js";

/**
 * 点击菜单项：立即执行命令，同时播放一次短暂高亮作为反馈。
 * 旧实现把命令放在 6 次 60ms 闪烁之后执行，命令凭空延迟 360ms，
 * 且 `.menu p.clicked` 从来没有对应样式，闪烁根本看不见。
 */
export function clickMenuItem(item) {
    if (item.hasAttribute("disabled")) return;

    closeAllMenus();

    const cmd = item.getAttribute("cmd");
    if (cmd) dispatchMenuCommand(cmd);

    item.classList.add("clicked");
    setTimeout(() => item.classList.remove("clicked"), 150);
}
