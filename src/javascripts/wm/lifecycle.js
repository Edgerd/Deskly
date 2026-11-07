/**
 * wm/lifecycle.js — 窗口生命周期：接管 / 释放 / 打开入场 / 关闭 / 最小化还原
 *
 * 从 window-manager.js 抽出，职责：
 * - manage / release：把一个元素纳入（或移出）窗口体系；
 * - prepareOpen / revealOpen / cancelOpenAnimation：打开入场（先隐藏到几何稳定再显示）；
 * - close：幂等关闭 + NW-9 可取消通道 + NW-1 母子级联 + 模态拦截；
 * - setMinimized / restore / toggleMinimize：genie 吸入 Dock，含母子级联。
 *
 * 元素侧 API（el.winctl.* 与 _closeWindow 等历史私有钩子）也在这里安装 ——
 * 已发布的 ZIP 插件按这些名字调过窗口，删掉就是静默失效。
 * winctl 里的状态操作（setZoom / tile / center / configure …）由 facade 注入（bindOps），
 * 与 interactions 同一个解耦手法：模块间只剩「facade → 各内核层」一个方向。
 */

import {
    records, stack, pushStack, commitStack, isWindowElement, isMinimized,
    focusWindow, updateActiveAppMenu, syncState, detachStates, stateOf, notifySpaces,
} from "./stack.js";
import { frameOf, applyFrame, limitsOf, clampFrame } from "./frame.js";
import { emitWindowEvent } from "./events.js";
import { childrenOf, modalChildOf, unlink, attach } from "./relations.js";
import { ensureEdgeBands, bindInteractions } from "./interactions.js";

/** facade 注入的状态操作（求值期一次性绑定）。 */
let ops = {};
export function bindOps(injected) {
    ops = { ...ops, ...injected };
}

/** 关闭动画兜底：动画事件没来（禁用动画 / 元素已 detach）也要收尾。 */
const CLOSE_FALLBACK_MS = 300;

/**
 * 开窗入场：先隐藏到几何稳定，再显示并从下方 6px 处上浮。
 * 只动 top 与 opacity，绝不使用 transform / filter —— 带 backdrop-filter 的窗口
 * 一旦被提升为 3D 合成层，亚克力会退化成色块（见 ui.css / windowframe.css 的禁忌）。
 *
 * 兜底显示时长只负责「装载链抛错时窗口不能永久不可见」，绝不能充当正常显示时机：
 * 冷加载要经过样式表往返 + 插件入口脚本求值与 init()，这段时间若短于兜底，
 * 窗口就会先以「骨架」露面（用户看到的「一帧没亚克力、元素位置乱堆」），
 * 脚本跑完后再自己变正常。宁可整体晚出现，也不要半成品，所以给足 1.2s。
 */
const OPEN_REVEAL_FALLBACK_MS = 1200;
const OPEN_ANIM_MS = 160;
const OPEN_RISE = 6;
/** 显示前要求连续这么多帧几何不变；最多等 12 帧（约 200ms）避免插件迟迟不收敛。 */
const OPEN_SETTLE_FRAMES = 2;
const OPEN_SETTLE_MAX_FRAMES = 12;

// ── 最小化 / 还原 ──

/**
 * 最小化到程序坞（ genie 语义：吸入该应用的 Dock 图标）。
 * NW-1：母窗最小化时子窗跟随（记 rec.followedMinimize，还原时只带起这批）；
 * 母窗有存活模态子窗时最小化被拦到模态关闭后。
 * @param {HTMLElement} el
 * @param {boolean} [minimize=true] false 即还原
 */
export function setMinimized(el, minimize = true) {
    if (!el) return;
    // 能力位真拦截（WAPI-02）：minimizable:false 的窗口拒绝最小化，而不是只熄黄灯
    if (minimize && el._wmConfig && el._wmConfig.minimizable === false) return;
    const rec = manage(el);
    const name = (rec && rec.name) || el.id;
    const dock = window.__dock;
    if (minimize) {
        const blocker = rec ? modalChildOf(el) : null;
        if (blocker) { focusWindow(blocker); return; }
        // 子窗跟随（先于自己：genie 快照拍的是当前完整画面）
        childrenOf(el).forEach((child) => {
            if (isMinimized(child)) return;
            const cr = records.get(child);
            if (cr) cr.followedMinimize = true;
            setMinimized(child, true);
        });
        el._minimized = true;
        import("./genie-capture.js")
            .then((m) => m.cancelWarmWindow(el))
            .catch(() => {});
        if (dock && dock.minimizeToDock) dock.minimizeToDock(el, name);
        else el.classList.add("minimized");
        const i = stack.indexOf(el);
        if (i >= 0) stack.splice(i, 1);
        commitStack();
        updateActiveAppMenu();
        notifySpaces();
        emitWindowEvent("minimize", el);
    } else {
        restore(el);
    }
}

/** 还原（从程序坞吐出）。跟随最小化的子窗一并带回。 */
export function restore(el) {
    // setMinimized 有这道判空，还原路径此前没有：传 null 时下面直接读 el.id 就抛。
    if (!el) return;
    const rec = records.get(el);
    const name = (rec && rec.name) || el.id;
    const dock = window.__dock;
    clearTimeout(el._hideTimer);
    el._hideTimer = null;
    el._minimized = false;
    el.style.display = "";
    el.classList.remove("minimized");
    if (dock && dock.restoreFromDock) dock.restoreFromDock(el, name);
    else focusWindow(el, name);
    if (!stack.includes(el)) pushStack(el);
    commitStack();
    updateActiveAppMenu();
    notifySpaces();
    emitWindowEvent("restore", el);
    childrenOf(el).forEach((child) => {
        const cr = records.get(child);
        if (cr && cr.followedMinimize) {
            cr.followedMinimize = false;
            restore(child);
        }
    });
}

/** 兼容旧名。 */
export function toggleMinimize(el) {
    setMinimized(el, !isMinimized(el));
}

// ── 关闭 ──

/**
 * 关闭窗口：可取消（NW-9）→ 模态拦截（NW-1）→ 级联子窗 → 淡出 → 摘 DOM 释放资源。
 * 幂等：红灯 / 强制退出 / 菜单命令可能叠着调用，第二次直接忽略。
 *
 * NW-9 取消通道（两个钩子按序询问，任一不放行即中止）：
 * 1. window.specialCloses[name]（旧钩子，WAPI-14 保留）返回 false 即拦；
 * 2. Deskly.windows.onClose 登记的 handler：返回 false 或 event.preventDefault() 即拦，
 *    handler 抛错视为放行并记 warn —— 绝不让异常把窗口卡成关不掉。
 * @param {HTMLElement} el
 */
export function close(el) {
    if (!el || !el.isConnected) return;
    // 没被接管过的窗口（插件自己注入、或注入后还没走到 resetWindowListeners）
    // 先接管再关：否则这里会静默 return，用户看到的就是「点了红灯没反应」。
    const rec = manage(el);
    if (!rec || rec.closing) return;

    // 模态拦截：母窗有存活模态子窗时，关闭被拦到模态关闭后（NW-1）
    const blocker = modalChildOf(el);
    if (blocker) { focusWindow(blocker); return; }

    const name = rec.name || el.id;
    // 旧钩子优先：specialCloses 返回 false 即中止（它的存在先于 NW-9，语义不变）
    const legacy = typeof window !== "undefined" && window.specialCloses ? window.specialCloses[name] : null;
    if (typeof legacy === "function") {
        let pass = true;
        try { pass = legacy(el) !== false; } catch (err) { console.warn(`[wm] specialCloses[${name}] 抛错，视为放行:`, err); }
        if (!pass) return;
    }
    // NW-9：可取消的关闭
    if (typeof rec.onClose === "function") {
        let canceled = false;
        try {
            const r = rec.onClose({ target: el, preventDefault: () => { canceled = true; } });
            if (r === false) canceled = true;
        } catch (err) {
            console.warn(`[wm] onClose 抛错，视为放行（${name}）:`, err);
        }
        if (canceled) return;
    }

    // 级联：子窗随母窗关闭（NW-1）。子窗自己仍走完整取消通道。
    childrenOf(el).slice().forEach((child) => close(child));

    rec.closing = true;
    // 关闭优先于入场：提前按停上浮并摘掉隐藏态，淡出动画才能正常跑。
    cancelOpenAnimation(el);
    import("./genie-capture.js")
        .then((m) => m.cancelWarmWindow(el))
        .catch(() => {});
    if (el._wmRevealAnim) {
        el._wmRevealAnim.cancel();
        el._wmRevealAnim = null;
    }
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener("animationend", onAnimEnd);
        clearTimeout(fallback);
        release(el);
        el.remove();
        commitStack();
        releaseResources(el, name, rec);
        updateActiveAppMenu();
        notifySpaces();
        emitWindowEvent("close", el);
        if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
            window.__dock.syncRunningApps();
        }
    };
    const onAnimEnd = (e) => { if (e.target === el) finish(); };
    el.classList.add("closing");
    el.addEventListener("animationend", onAnimEnd);
    const fallback = setTimeout(finish, CLOSE_FALLBACK_MS);
}

/**
 * 关闭后的资源释放：插件走 plugin-manager.unloadApp（按存活窗口引用计数），
 * 旧式 App 移除其脚本与样式表。
 */
function releaseResources(el, name, rec) {
    const pid = el.dataset.pluginId;
    if (pid) {
        const appId = el.dataset.appId || pid;
        import("../plugin-manager.js").then(({ unloadApp }) => {
            try { unloadApp(pid, appId); } catch (err) { console.warn("[wm] 卸载插件失败:", pid, err); }
        }).catch((err) => console.warn("[wm] 插件管理器不可用:", err));
    } else {
        const s = document.querySelector(`script[app="${name}"]`);
        if (s) s.remove();
        const link = document.querySelector(`link[app-css="${name}"]`);
        if (link) link.remove();
    }
    if (rec.light) rec.light.classList.remove("on");
    if (window.appStatus && name) window.appStatus[name] = false;
}

// ── 开窗入场 ──

/**
 * 在窗口刚插入 DOM、尚未完成尺寸/居中时先藏起来。
 *
 * 调用点必须是「insertAdjacentHTML 之后、任何 await 之前」：浏览器在任务结束后
 * 就有一次绘制机会，默认 .window 的 680×570 与未居中位置会先被画出来，
 * 等 window-manager 算完真实几何再跳过去，就是用户看到的打开瞬间错位。
 * 这里加的类由 ui.css 定义为 visibility:hidden + animation:none，不改变布局。
 * @param {HTMLElement|null} el 新窗口根元素
 */
export function prepareOpen(el) {
    if (!el || !el.classList || el.classList.contains("closing")) return;
    el._wmOpenPending = true;
    el.classList.add("wm-preparing");
    // 兜底：后面的装载步骤若抛错，窗口不能永久不可见。
    clearTimeout(el._wmOpenFallback);
    el._wmOpenFallback = setTimeout(() => revealOpen(el), OPEN_REVEAL_FALLBACK_MS);
}

/** 取消入场（用户提前操作 / 窗口被关闭时调用），立即恢复可见并停掉位移动画。 */
export function cancelOpenAnimation(el) {
    if (!el) return;
    el._wmOpenPending = false;
    el._wmOpenRevealing = false;
    clearTimeout(el._wmOpenFallback);
    el._wmOpenFallback = null;
    if (el.classList) el.classList.remove("wm-preparing");
    if (el._wmOpenAnim) {
        el._wmOpenAnim.cancel();
        el._wmOpenAnim = null;
    }
}

/**
 * 显示新窗口并播放入场。
 *
 * 不能只等固定两帧：插件脚本求值期间主线程会被占住，`center()` 的二次校准
 * 与插件的 `Deskly.windows.configure` 都可能晚于脚本 load 才落到 DOM 上。
 * 这里逐帧读几何，连续 2 帧不变（最多等 12 帧）才显示；于是计算器这类
 * 「init 时按模式复述高度」的应用不会先以基础尺寸出现再跳一次。
 * 超时仍显示，保证任何情况下窗口都不会被永久藏住。
 * @param {HTMLElement|null} el 新窗口根元素
 */
export function revealOpen(el) {
    if (!el || !el._wmOpenPending || el._wmOpenRevealing) return;
    el._wmOpenRevealing = true;
    let last = "";
    let stable = 0;
    let frames = 0;
    const step = () => {
        if (!el._wmOpenPending || !el.isConnected) {
            el._wmOpenRevealing = false;
            return;
        }
        const f = frameOf(el);
        const sig = `${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.w)},${Math.round(f.h)}`;
        stable = sig === last ? stable + 1 : 0;
        last = sig;
        frames += 1;
        if (stable < OPEN_SETTLE_FRAMES && frames < OPEN_SETTLE_MAX_FRAMES) {
            requestAnimationFrame(step);
            return;
        }
        el._wmOpenPending = false;
        el._wmOpenRevealing = false;
        clearTimeout(el._wmOpenFallback);
        el._wmOpenFallback = null;
        el.classList.remove("wm-preparing");
        playOpenMotion(el);
        // 通知程序坞：窗口这一刻才真正可见，加载弹跳到这里停（见 dock.syncRunningApps）。
        if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
            window.__dock.syncRunningApps();
        }
        emitWindowEvent("open", el);
        import("./genie-capture.js")
            .then((m) => m.warmWindow(el))
            .catch(() => {});
    };
    requestAnimationFrame(step);
}

/** 实际的位移：读完最终框架后从下方 6px（OPEN_RISE）起笔，结束时落回内联样式里的最终值。 */
function playOpenMotion(el) {
    // 减少动态效果：站内开关与系统偏好任一开启都不加位移，只保留 CSS 的淡入
    if (document.documentElement.dataset.reduceMotion === "on") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof el.animate !== "function") return;
    const f = frameOf(el);
    const anim = el.animate(
        [{ top: `${f.y + OPEN_RISE}px` }, { top: `${f.y}px` }],
        { duration: OPEN_ANIM_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    el._wmOpenAnim = anim;
    anim.addEventListener("finish", () => {
        if (el._wmOpenAnim === anim) el._wmOpenAnim = null;
    }, { once: true });
}

// ── 接管与释放 ──

/**
 * 接管一个窗口（幂等）。plugin-manager 注入界面后调用，等价于旧名 resetWindowListeners。
 * @param {HTMLElement} el 窗口根元素
 * @param {{name?: string, light?: HTMLElement|null, kernel?: object}} [opts]
 * @returns {object|null} 窗口记录
 */
export function manage(el, opts = {}) {
    if (!isWindowElement(el)) return null;
    let rec = records.get(el);
    if (rec) {
        // 名字永远以窗口自己的 id 为准（本项目约定：窗口 id 就是应用显示名）。
        // 旧实现允许调用方把 name 覆写进来，多窗口场景下会把别人的窗口写成
        // 本次装载的应用名，顶栏菜单随之串台。
        if (el.id) rec.name = el.id;
        if (opts.light) rec.light = opts.light;
        return rec;
    }
    rec = {
        el,
        name: el.id || opts.name || "",
        light: opts.light || null,
        normal: null,
        zoomed: false,
        fullscreen: false,
        tiled: null,
        mode: null,
        grab: null,
        snap: null,
        closing: false,
        hoverTimer: null,
        menu: null,
        // NW-1 关系字段：默认普通顶层窗
        role: "normal",
        parent: null,
        modal: false,
        modalChild: null,
        level: "normal",
        // NW-5 / NW-9 回调
        actions: null,
        onClose: null,
    };
    records.set(el, rec);
    if (opts.kernel) el._wmKernelConf = opts.kernel;
    else if (el._wmKernelConf) opts.kernel = el._wmKernelConf;

    const conf = ops.applyConfig ? ops.applyConfig(el, opts.kernel || {}) : (el._wmConfig || {});
    ensureEdgeBands(el);
    bindInteractions(rec);
    if (ops.bindTitleBarControls) ops.bindTitleBarControls(rec);
    installElementApi(el, rec);
    // 按下兜底要用的入场取消通道（interactions 不反向依赖本模块）
    el._wmCancelOpen = () => cancelOpenAnimation(el);

    // NW-1 / NW-4 声明落地：role/parent/modal 走关系层，level 走分带
    if (conf.level && conf.level !== "normal" && ops.setLevel) ops.setLevel(el, conf.level);
    if ((conf.role === "child" || conf.role === "sheet" || conf.modal === true) && conf.parent) {
        const parent = document.getElementById(conf.parent);
        if (parent && parent !== el) attach(el, { parent, modal: conf.modal === true, role: conf.role });
    }

    if (!stack.includes(el)) pushStack(el);
    commitStack();
    syncState(el, rec);
    if (typeof el.dataset.appName !== "string" && rec.name) el.dataset.appName = rec.name;
    return rec;
}

/**
 * 释放一个窗口的托管：出栈、收掉悬停菜单、清理母子关系、重算全屏态外壳类。
 * 调用方（关闭流程 / DOM 摘除观察器）之后自己再 commitStack，这里不动层级。
 */
export function release(el) {
    const i = stack.indexOf(el);
    if (i >= 0) stack.splice(i, 1);
    const rec = records.get(el);
    if (rec) {
        clearTimeout(rec.hoverTimer);
        rec.hoverTimer = null;
        if (rec.menu && rec.menu.isConnected) rec.menu.remove();
        rec.menu = null;
    }
    unlink(el);
    // 全屏外壳类由 spaces.syncSpaces 统一算，这里只触发一次重算
    notifySpaces();
}

/**
 * 元素侧 API：`el.winctl.close()`。
 * 同时保留历史私有钩子（`el._closeWindow` 等）为同一批函数的别名 ——
 * 已发布的 ZIP 插件按这些名字调过窗口，删掉就是静默失效，留着也只是六行引用。
 * 状态操作经 ops 转调 facade，本模块不出第二份实现。
 */
function installElementApi(el, rec) {
    const ctl = {
        get state() { return stateOf(el); },
        close: () => close(el),
        minimize: () => setMinimized(el, true),
        restore: () => restore(el),
        toggleMinimize: () => setMinimized(el, !isMinimized(el)),
        zoom: (on) => ops.setZoom(el, { on }),
        toggleZoom: () => ops.setZoom(el),
        fullscreen: (on) => ops.setFullscreen(el, { on }),
        toggleFullscreen: () => ops.setFullscreen(el),
        tile: (region) => ops.tile(el, region),
        untile: () => ops.untile(el),
        center: (o) => ops.center(el, o),
        focus: () => focusWindow(el),
        configure: (conf) => ops.configure(el, conf),
        resize: (on) => ops.setResizable(el, on !== false),
        get frame() { return frameOf(el); },
        set frame(f) {
            rec.normal = { ...f };
            detachStates(rec, true);
            applyFrame(el, clampFrame(f, limitsOf(el)), { animate: true });
        },
    };
    Object.defineProperty(el, "winctl", { value: Object.freeze(ctl), configurable: true, enumerable: false });
    el._closeWindow = ctl.close;
    el._toggleMinimizeWindow = ctl.toggleMinimize;
    el._toggleStretchWindow = ctl.toggleZoom;
    el._toggleFullscreenWindow = ctl.toggleFullscreen;
    el._tileWindow = ctl.tile;
    el._untileWindow = ctl.untile;
    el._showArrangeMenu = (x, y) => { if (ops.showArrangeMenu) ops.showArrangeMenu(rec, x, y); };
}
