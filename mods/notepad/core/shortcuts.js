/**
 * shortcuts.js — 快捷键统一登记（规划 §2.1 工具栏表 + §7-P3 全覆盖）
 *
 * 匹配规则：按「修饰键集合 + 键名」精确比对。
 * 声明了 shift 的绑定不会被裸 ⌘ 命中（修掉 ⇧⌘S 与 ⌘S 走同一条分支的问题），
 * 未声明 alt 的绑定在 ⌥ 参与时一律放行（修掉 ⌘⌥B 被吞的问题）。
 */

function keyName(e) {
    if (e.key === ' ' || e.code === 'Space') return 'space';
    // 按 shift 时 e.key 可能变成 '!'/'@'，数字用 e.code 兜住
    const digit = e.code && e.code.match(/^Digit(\d)$/);
    if (digit) return digit[1];
    return (e.key || '').toLowerCase();
}

/** 事件签名：'mod+shift+1'、'mod+f' … （ctrl 与 command 归一为 mod） */
function signature(e) {
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('mod');
    if (e.shiftKey) mods.push('shift');
    if (e.altKey) mods.push('alt');
    const key = keyName(e);
    if (!key) return '';
    if (mods.length === 0) return key;
    return [...mods, key].join('+');
}

/**
 * @param {HTMLElement} root 窗口根元素（监听挂在窗口上，避免抢走其他应用的按键）
 * @param {Record<string, {run: Function, when?: Function}>} bindings 签名 → 动作
 * @returns {{dispose: Function}}
 */
export function registerShortcuts(root, bindings) {
    const onKeyDown = (e) => {
        const sig = signature(e);
        if (!sig) return;
        const binding = bindings[sig];
        if (!binding) return;
        if (binding.when && !binding.when(e)) return;
        e.preventDefault();
        try {
            binding.run(e);
        } catch (err) {
            console.warn('[notepad] 快捷键执行失败：', sig, err);
        }
    };

    root.addEventListener('keydown', onKeyDown);
    return { dispose: () => root.removeEventListener('keydown', onKeyDown) };
}
