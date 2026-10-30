/**
 * menuCommands.js — 菜单命令分发
 *
 * MV3 扩展页面的 CSP 固定为 script-src 'self'（不含 unsafe-eval），
 * 因此菜单命令字符串不能再交给 new Function 求值 —— 旧实现会让所有菜单命令
 * 在打包环境里静默失败。这里改为：命令 = 注册表键名 + 可选的单个字符串实参。
 *
 * 支持的写法：
 *   "forceQuit"                 → 注册表 forceQuit()
 *   "openAppByName('系统设置')"  → 注册表 openAppByName("系统设置")
 *   () => {...}                 → 直接调用（子菜单定义里允许内联函数）
 */

// name 或 name('arg') / name("arg")，不接受其它任何形式（避免任何形式的代码求值）
const COMMAND_PATTERN = /^([A-Za-z_$][\w$]*)(?:\(\s*(?:'([^']*)'|"([^"]*)")?\s*\))?$/;

/**
 * 执行一条菜单命令。
 * @param {string|Function} cmd 命令
 * @returns {boolean} 是否成功分发到已注册的命令
 */
export function dispatchMenuCommand(cmd) {
    if (typeof cmd === "function") {
        try {
            cmd();
            return true;
        } catch (err) {
            console.error("[menu] 内联命令执行失败:", err);
            return false;
        }
    }
    if (typeof cmd !== "string" || !cmd) return false;

    const match = COMMAND_PATTERN.exec(cmd);
    if (!match) {
        console.error("[menu] 无法解析命令（仅支持 name 或 name('arg')）:", cmd);
        return false;
    }

    const [, name, singleQuoteArg, doubleQuoteArg] = match;
    const action = (window.__menuActions || {})[name];
    if (typeof action !== "function") {
        console.error("[menu] 命令未注册:", name);
        return false;
    }

    const arg = singleQuoteArg !== undefined ? singleQuoteArg : doubleQuoteArg;
    try {
        arg === undefined ? action() : action(arg);
        return true;
    } catch (err) {
        console.error("[menu] 命令执行失败:", cmd, err);
        return false;
    }
}
