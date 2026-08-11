import { closeAllMenus } from "../finderbar.js";

export function clickMenuItem(item) {
    if (item.hasAttribute("disabled")) return;

    const cmd = item.getAttribute("cmd");

    let flashCount = 0;
    const maxFlashes = 3;
    const flashInterval = 60;

    const flash = () => {
        if (flashCount < maxFlashes * 2) {
            item.classList.toggle("clicked", flashCount % 2 === 0);
            flashCount++;
            setTimeout(flash, flashInterval);
        } else {
            closeAllMenus();
            if (cmd) executeCommand(cmd);
        }
    };

    flash();
}

/**
 * 执行菜单命令字符串。
 *
 * 命令分两类：
 *  1. 全局对象调用（如 "moduleItems.create('./assets/apps/关于本机.html')"），
 *     依赖挂在 window 上的全局对象，直接以 new Function 在全局作用域执行；
 *  2. 注册表命令（如 "openAppByName('访达')"、"finderNewFolder"、"emptyTrash()"），
 *     函数定义于 finderbar.js 模块作用域，仅暴露到 window.__menuActions，
 *     并非全局变量。若直接用 new Function(cmd)() 会因找不到标识符而抛 ReferenceError。
 *     故将 window.__menuActions 中的函数作为与命令同名的参数注入函数体，
 *     使命令字符串可直接引用，同时保留全局对象命令的执行能力。
 *
 * 任何命令执行失败都会被捕获并输出日志，不会静默中断菜单交互。
 *
 * @param {string} cmd 命令字符串
 */
function executeCommand(cmd) {
    const actions = window.__menuActions || {};
    try {
        new Function(...Object.keys(actions), `return (${cmd});`)(...Object.values(actions));
    } catch (err) {
        console.error("[menu] 执行命令失败:", cmd, err);
    }
}