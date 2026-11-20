/**
 * menu.js — 菜单项点击的视觉反馈与命令分发
 *
 * MV3 扩展页面 CSP 禁止内联事件处理器，index.html 的静态菜单项一律由
 * bootstrap.js 以 addEventListener 绑定到这里；命令解析见 ui/menuCommands.js。
 */
import { closeAllMenus } from "../finderbar.js";
import { dispatchMenuCommand } from "./menuCommands.js";
import { pressMenuItem } from "./menuFeedback.js";

/**
 * 点击菜单项：先填强调色停留一小段，再收起菜单并执行命令。
 * 旧实现先 closeAllMenus() 再给已脱离文档的项加 .clicked，高亮没有机会被绘制；
 * 这里把高亮提前到关闭之前，时序由 ui/menuFeedback.js 统一负责。
 */
export function clickMenuItem(item) {
    if (!item || item.hasAttribute("disabled")) return;

    pressMenuItem(item, () => {
        closeAllMenus();

        const cmd = item.getAttribute("cmd");
        if (cmd) dispatchMenuCommand(cmd);
    });
}
