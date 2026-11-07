/**
 * session.js — Apple 菜单的会话命令
 *
 * 职责：
 * 1. 遮罩类命令（睡眠 / 关机）用全屏层，重新启动用 location.reload()，
 *    强制退出关闭全部应用窗口。
 * 2. 「锁定屏幕」与「睡眠」唤醒后都委托 lock.js（真正的锁屏 owner：口令、空闲计时、
 *    时钟界面都在那边），本模块只在锁屏模块不可用时兜底显示纯遮罩。
 */

import { i18n } from "./i18n.js";
import { VERSION, APP_NAME } from "./version.js";
import { Z } from "./zindex.js";

// 会话遮罩层级取自统一层级表：盖过 Dock、启动台、弹窗与亮度压暗层
const SESSION_Z = Z.SESSION;
const OVERLAY_ID = "os-session-overlay";

/**
 * 应用窗口：只认 body 直接子级里的 .window。
 * 判据与 window-manager.js 的 isWindowElement 等价（排除 .finderbar/.menu 等处的
 * 伪 .window —— 顶栏「窗口」菜单历史上就有 <p class="window">）；这里原来只排了
 * .finderbar 一层，伪窗口会被强制退出与 runningAppNames 当成真应用。
 * 不直接 import isWindowElement 是避免 session → window.js → window-manager →
 * finderbar 循环依赖；改动时两处一起改。
 */
function appWindows() {
    return Array.from(document.querySelectorAll("body > .window"));
}

function runningAppNames() {
    const names = appWindows().map((win) => win.id || win.getAttribute("app") || "");
    return Array.from(new Set(names.filter(Boolean)));
}

/** 活动应用：未最小化窗口中 z-index 最高的那个 */
function activeAppName() {
    let top = null;
    let topZ = -1;
    appWindows().forEach((win) => {
        if (win.classList.contains("minimized") || win.style.display === "none") return;
        const z = parseInt(window.getComputedStyle(win).zIndex, 10);
        if (isNaN(z)) return;
        if (z > topZ) {
            topZ = z;
            top = win;
        }
    });
    return top ? top.id || top.getAttribute("app") || "" : "";
}

function syncDockIndicators() {
    const dock = window.__dock;
    if (dock && typeof dock.syncRunningApps === "function") dock.syncRunningApps();
}

/**
 * 最小化 / 恢复一个窗口的可见性。
 * 走窗口管理器接管时挂在元素上的 winctl（含吸入程序坞的动画与运行灯联动），
 * 没有 winctl 的窗口（未经接管的历史/异类元素）退化为直接切换 .minimized，
 * 保证任何来源的窗口都能被会话命令处理。
 *
 * 这里刻意不 import window-manager：finderbar 静态 import 本模块取 SESSION_ACTIONS，
 * 而 window-manager 静态 import finderbar，加一条边就成了循环求值。
 */
function setVisible(win, visible) {
    const isMinimized = win.classList.contains("minimized") || win.style.display === "none";
    if (isMinimized === !visible) return;
    if (win.winctl) {
        if (visible) win.winctl.restore();
        else win.winctl.minimize();
        return;
    }
    win.classList.toggle("minimized", !visible);
    if (visible) win.style.display = "";
}

/**
 * 全屏会话遮罩：任意按键 / 点击后交给 onDismiss 决定如何收尾。
 * @param {string} label 遮罩文案
 * @param {(finish: () => void) => void} onDismiss 收到用户输入时的处理
 */
/** 当前遮罩的清理句柄：第二次 show 必须先走 finish 摘监听，
 * 只摘 DOM 会把旧 onDismiss 留在 window 键盘监听上（BUG-44）。 */
let activeFinish = null;

function showSessionOverlay(label, onDismiss) {
    if (activeFinish) { try { activeFinish(); } catch { /* 清理失败不阻塞新遮罩 */ } activeFinish = null; }
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "session-overlay";
    overlay.style.cssText = `position:fixed;inset:0;z-index:${SESSION_Z};background:#000;` +
        "display:flex;align-items:center;justify-content:center;color:#fff;" +
        "font-size:20px;letter-spacing:.04em;cursor:default;";
    overlay.textContent = label;
    document.body.appendChild(overlay);

    const finish = () => {
        if (activeFinish === finish) activeFinish = null;
        window.removeEventListener("keydown", onInput, true);
        overlay.removeEventListener("click", onInput, true);
        overlay.remove();
    };
    const onInput = () => onDismiss(finish);

    window.addEventListener("keydown", onInput, true);
    overlay.addEventListener("click", onInput, true);
    activeFinish = finish;
    return finish;
}

/**
 * 委托锁屏模块上锁（lock.js 才是遮罩与口令的 owner）。
 * 动态导入而不是顶部 import：lock.js 反向经 ui/notification.js 依赖核心层，
 * 静态说明符会把 session <-> lock 拉成循环，取到 undefined 导出。
 * 导入失败（模块未就绪）时退回本模块的会话遮罩，命令不至于点了没反应。
 * @param {string} reason 触发来源，透传给 lock.lockNow
 * @returns {Promise<void>}
 */
async function delegateToLock(reason) {
    try {
        const { lock } = await import("./lock.js");
        if (lock?.lockNow) {
            // 先撤掉可能已在显示的会话遮罩（睡眠 -> 唤醒链路会先显示「睡眠中」），
            // 再把界面交给锁屏遮罩，避免两层同 Z.SESSION 的遮罩叠在一起。
            // 必须走 finish 摘监听：只 remove 元素会把旧 onDismiss 留在键盘监听上（BUG-44）。
            if (activeFinish) { try { activeFinish(); } catch { /* 忽略 */ } activeFinish = null; }
            else document.getElementById(OVERLAY_ID)?.remove();
            lock.lockNow(reason);
            if (lock.isLocked()) return;
        }
    } catch (err) {
        console.warn("[session] 锁屏模块不可用，退回会话遮罩：", err);
    }
    showSessionOverlay(i18n.t("session.locked", "屏幕已锁定"), (finish) => finish());
}

export function lockScreen() {
    delegateToLock("menu");
}

/**
 * 睡眠：黑屏遮罩，任意输入后唤醒并上锁（与 macOS「唤醒后需要口令」同一语义）。
 * 锁屏模块没就绪时退化为纯遮罩 dismiss，行为与改造前一致。
 */
export function sleep() {
    showSessionOverlay(i18n.t("session.sleeping", "睡眠中"), (finish) => {
        finish();
        delegateToLock("sleep");
    });
}
export function restart() {
    window.location.reload();
}

export function shutdown() {
    showSessionOverlay(i18n.t("session.shutdown", "已关机，点击继续"), () => window.location.reload());
}

export function forceQuit() {
    const names = runningAppNames();
    if (!names.length) {
        window.__dialog?.alert(
            i18n.t("session.forceQuit", "强制退出"),
            i18n.t("session.noRunningApps", "没有正在运行的应用。")
        );
        return;
    }
    const confirmed = window.__dialog?.confirm(
        i18n.t("session.forceQuit", "强制退出"),
        `${i18n.t("session.forceQuitPrompt", "以下应用将被退出，未保存的内容会丢失。")}\n${names.join("\n")}`,
        { danger: true }
    );
    Promise.resolve(confirmed).then((ok) => {
        if (!ok) return;
        // 动态导入避免与 plugin-manager 形成静态循环依赖
        import("./plugin-manager.js")
            .then(({ unload }) => {
                appWindows().forEach((win) => {
                    const pluginId = win.dataset.pluginId;
                    if (pluginId) unload(pluginId);
                    else win.remove();
                });
                syncDockIndicators();
            })
            .catch((err) => console.error("[session] 强制退出失败:", err));
    });
}

/** 退出登录：关闭所有应用后锁定屏幕 */
export function logOut() {
    forceQuit();
    lockScreen();
}

export function hideActiveApp() {
    const active = activeAppName();
    if (!active) return;
    appWindows().forEach((win) => {
        if ((win.id || win.getAttribute("app")) === active) setVisible(win, false);
    });
    syncDockIndicators();
}

export function hideOthers() {
    const active = activeAppName();
    if (!active) return;
    appWindows().forEach((win) => {
        if ((win.id || win.getAttribute("app")) !== active) setVisible(win, false);
    });
    syncDockIndicators();
}

export function showAll() {
    appWindows().forEach((win) => setVisible(win, true));
    syncDockIndicators();
}

export function aboutActiveApp() {
    const app = activeAppName() || APP_NAME;
    window.__dialog?.alert(
        i18n.t("session.aboutTitle", "关于本机"),
        `${app}\n${APP_NAME} ${VERSION}`
    );
}

/** Apple 菜单「关于本机」 */
export function aboutThisMac() {
    window.__dialog?.alert(
      `${APP_NAME} ${VERSION}`,
        i18n.t("session.aboutBody", "基于 macOS 风格的浏览器桌面环境。")
    );
}

/** 会话命令注册表：并入 finderbar 的 window.__menuActions，供 menuCommands 分发 */
export const SESSION_ACTIONS = {
    lockScreen,
    sleep,
    restart,
    shutdown,
    forceQuit,
    logOut,
    hideActiveApp,
    hideOthers,
    showAll,
    aboutActiveApp,
    aboutThisMac,
};
