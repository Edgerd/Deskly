/**
 * dev/lock-gate-probe.mjs — BUG-37 锁屏键盘闸门探针（Node，无浏览器）。
 *
 * 覆盖场景：
 *   1. 未锁定：⌘, 等 native 快捷键正常分发（基线）；
 *   2. 口令闸门锁定：全局快捷键（⌘, / ⌘⌥Esc / ⌘H / ⌃↓）全部吞掉，
 *      preventDefault + stopImmediatePropagation 生效，后注册的 window 监听也收不到；
 *   3. 闸门锁定下密码框内的字符 / 退格 / 回车 / Tab 放行，⌘V 与遮罩外字符不放行；
 *   4. 无闸门锁定：任意按键触发 __lock.unlock("input")，事件吞掉、零分发；
 *   5. 解锁后下一按键立即恢复分发（事件驱动、无刷新）；
 *   6. 冷却期（锁定未解除）全局快捷键仍吞掉；
 *   7. 锁屏模块缺失：按未锁定放行，告警只发一次。
 *
 * 用法：node dev/lock-gate-probe.mjs（失败退出码 1）
 */

import { initKeyboard } from "../src/javascripts/keyboard.js";

const results = [];
const check = (name, cond, detail = "") => {
    results.push({ name, ok: Boolean(cond), detail });
};

// ---- 最小 DOM / 环境桩 ----

const winListeners = [];
const docListeners = [];

globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => { if (type === "keydown") winListeners.push(fn); };
globalThis.removeEventListener = () => {};
globalThis.document = {
    addEventListener: (type, fn) => { if (type === "keydown") docListeners.push(fn); },
};

const logCalls = { warn: 0 };
globalThis.__log = {
    warn: () => { logCalls.warn += 1; },
    info: () => {},
    error: () => {},
    debug: () => {},
};

const dispatched = [];
globalThis.__menuActions = new Proxy({}, {
    get: (target, name) => (arg) => dispatched.push(`${String(name)}${arg === undefined ? "" : `(${arg})`}`),
});

/** 可控的锁屏模块桩。 */
const lockState = { locked: false, gated: false, unlockCalls: [] };
globalThis.__lock = {
    isLocked: () => lockState.locked,
    isGated: () => lockState.gated,
    unlock: (reason) => { lockState.unlockCalls.push(reason); return true; },
};

/** 模拟一次 keydown：window 捕获 → document 捕获，尊重 stopImmediatePropagation。 */
function fire(init) {
    const event = {
        key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
        repeat: false, isComposing: false, target: null,
        defaultPrevented: false, stopped: false, immediateStopped: false,
        ...init,
    };
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    event.stopImmediatePropagation = () => { event.immediateStopped = true; event.stopped = true; };
    for (const fn of winListeners) {
        if (event.immediateStopped) break;
        fn(event);
    }
    if (!event.stopped) {
        for (const fn of docListeners) {
            if (event.immediateStopped) break;
            fn(event);
        }
    }
    return event;
}

const overlayTarget = { closest: (sel) => (sel === "#deskly-lock-screen" ? {} : null) };
const bodyTarget = { closest: () => null };

initKeyboard();

// 后于闸门注册的 window 级监听（模拟 spotlight/alert 一类模块）：闸门吞掉的键它必须收不到。
let lateWindowSaw = 0;
winListeners.push(() => { lateWindowSaw += 1; });

// ── 1 未锁定基线 ──────────────────────────────────────────────────────
{
    const before = dispatched.length;
    const e = fire({ key: ",", metaKey: true, target: bodyTarget });
    check("未锁定：⌘, 正常分发", dispatched.length === before + 1 && dispatched.at(-1).startsWith("openAppByName"));
    check("未锁定：⌘, preventDefault 且不被闸门吞", e.defaultPrevented && !e.immediateStopped);
    const sawBefore = lateWindowSaw;
    fire({ key: "h", metaKey: true, target: bodyTarget });
    check("未锁定：⌘H 分发给 hideActiveApp", dispatched.at(-1) === "hideActiveApp");
    check("未锁定：事件到达后注册的 window 监听", lateWindowSaw > sawBefore);
}

// ── 2 口令闸门锁定：全局快捷键全吞 ────────────────────────────────────
lockState.locked = true;
lockState.gated = true;
{
    const combos = [
        { key: ",", metaKey: true, name: "⌘," },
        { key: "Escape", metaKey: true, altKey: true, name: "⌘⌥Esc" },
        { key: "h", metaKey: true, name: "⌘H" },
        { key: " ", metaKey: true, name: "⌘Space" },
        { key: "ArrowDown", ctrlKey: true, name: "⌃↓" },
        { key: "q", ctrlKey: true, metaKey: true, name: "⌃⌘Q" },
    ];
    for (const c of combos) {
        const before = dispatched.length;
        const sawBefore = lateWindowSaw;
        const e = fire({ ...c, target: bodyTarget });
        check(`闸门锁定：${c.name} 被吞（无分发 + preventDefault + stopImmediate）`,
            dispatched.length === before && e.defaultPrevented && e.immediateStopped);
        check(`闸门锁定：${c.name} 不到达后注册 window 监听`, lateWindowSaw === sawBefore);
    }
    check("闸门锁定：unlock 未被误触", lockState.unlockCalls.length === 0);
}

// ── 3 闸门锁定：密码框输入键放行 ──────────────────────────────────────
{
    for (const key of ["a", "1", "Backspace", "Enter", "Tab"]) {
        const e = fire({ key, target: overlayTarget });
        check(`闸门锁定：密码框内 ${key} 放行`, !e.defaultPrevented && !e.immediateStopped);
    }
    const paste = fire({ key: "v", metaKey: true, target: overlayTarget });
    check("闸门锁定：密码框内 ⌘V 被吞", paste.defaultPrevented && paste.immediateStopped);
    const outside = fire({ key: "a", target: bodyTarget });
    check("闸门锁定：遮罩外字符被吞", outside.defaultPrevented && outside.immediateStopped);
}

// ── 6 冷却期：锁定未解除，快捷键仍吞（闸门只读 isLocked，冷却不改变锁定态） ──
{
    // 冷却期 = gated 锁定中 input 被禁用的子状态；isLocked/isGated 读到的仍是 true。
    const before = dispatched.length;
    const e = fire({ key: "Escape", metaKey: true, altKey: true, target: overlayTarget });
    check("冷却期：⌘⌥Esc 仍被吞", dispatched.length === before && e.immediateStopped);
    const enter = fire({ key: "Enter", target: overlayTarget });
    check("冷却期：密码框内 Enter 仍放行（禁用输入框自身忽略）", !enter.immediateStopped);
}

// ── 4 无闸门锁定：任意键即解锁输入，事件吞掉 ──────────────────────────
lockState.gated = false;
{
    const before = dispatched.length;
    const e1 = fire({ key: "a", target: bodyTarget });
    check("无闸门锁定：普通字符触发 unlock('input')",
        lockState.unlockCalls.at(-1) === "input" && e1.immediateStopped && dispatched.length === before);
    const e2 = fire({ key: " ", metaKey: true, target: bodyTarget });
    check("无闸门锁定：⌘Space 也只解锁不分发",
        lockState.unlockCalls.at(-1) === "input" && e2.immediateStopped && dispatched.length === before);
}

// ── 5 解锁后立即恢复（事件驱动，逐按键现读状态） ──────────────────────
lockState.locked = false;
{
    const before = dispatched.length;
    fire({ key: ",", metaKey: true, target: bodyTarget });
    check("解锁后：下一按键立即恢复分发", dispatched.length === before + 1 && dispatched.at(-1).startsWith("openAppByName"));
}

// ── 7 锁屏模块缺失：按未锁定放行 + 告警一次 ───────────────────────────
{
    const saved = globalThis.__lock;
    delete globalThis.__lock;
    const warnsBefore = logCalls.warn;
    const before = dispatched.length;
    fire({ key: ",", metaKey: true, target: bodyTarget });
    fire({ key: "h", metaKey: true, target: bodyTarget });
    check("模块缺失：快捷键照常分发（不死锁）", dispatched.length === before + 2);
    check("模块缺失：告警只发一次", logCalls.warn === warnsBefore + 1);
    globalThis.__lock = saved;
}

// ---- 汇总 ----
let failed = 0;
results.forEach(({ name, ok, detail }) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
});
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
