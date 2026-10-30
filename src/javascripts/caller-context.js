/**
 * caller-context.js — 调用者归属的传递通道
 *
 * 为什么需要独立一个模块：`guard()` 认插件靠解析调用栈，而栈解析**会失败**
 * （回调由内核派发时，内层帧不一定还带 `mods/` 前缀）。失败时旧实现返回 null，
 * 而 null 的语义是「内核自己调用 → 放行」——于是「认不出」等于「给全部权限」。
 *
 * 正确做法是把归属**在能认出来的那一刻**记下来，随调用一起传下去：
 *   - `settings.subscribe` / `bus.on` 在**订阅时**认一次（此刻插件帧一定在栈上）；
 *   - 派发时用 `withCaller(owner, fn)` 把归属放进模块内变量；
 *   - `guard()` 先读它，读不到才回落到栈解析。
 *
 * 本模块是叶子：不 import 任何东西、不碰 DOM、不写全局。任何模块都能安全引用
 * （包括最早求值的 settings.js），不会引入循环依赖，也不会被插件从 window 上改写。
 */

/** 插件脚本的 URL 形态：…/mods/<pluginId>/… （内置与 ZIP 安装后都是这个前缀） */
const MODS_FRAME = /(?:^|[\/\\])mods[\/\\]([^\/\\?#]+)[\/\\]/;

/** 内核帧判据：内核模块都在 src/javascripts/ 下，出现在栈里要跳过，别把自己的路径当成插件 id。 */
const KERNEL_FRAME = /src[\/\\]javascripts[\/\\]/;

/** 当前正在执行的归属（null = 不在任何插件回调里）。 */
let ambient = null;

/**
 * 从调用栈里认出「是哪个插件在调」。
 *
 * 入口脚本是 `<script type="module" src>` 注入的，模块内 `document.currentScript` 恒为 null，
 * 所以只能解析栈帧 —— 回调的最内层帧带着它**定义处**的 URL，模块异步求值、事件回调、
 * Promise then、setTimeout 都覆盖。
 *
 * @returns {string|null} 插件 id；null = 栈里没有插件帧
 */
export function callerFromStack() {
    const raw = new Error().stack || "";
    const lines = raw.split("\n").slice(1);
    for (const line of lines) {
        if (KERNEL_FRAME.test(line)) continue;
        const m = MODS_FRAME.exec(line);
        if (m) {
            try { return decodeURIComponent(m[1]); } catch (err) { return m[1]; }
        }
    }
    return null;
}

/** 当前通过 withCaller 声明的归属；null 表示没有。 */
export function currentCaller() {
    return ambient;
}

/**
 * 在指定归属下同步执行 fn；嵌套调用恢复上一层。
 *
 * 只对**同步**区间生效：fn 若返回 Promise，await 之后的续体不再处于这个归属里。
 * 这正是我们要的语义 —— 归属只在「内核代插件发起」的这一小段里成立，
 * 插件自己的异步续体会带上自己的 mods/ 帧，能正常认出。
 *
 * @template T
 * @param {string|null} pluginId 归属插件 id
 * @param {() => T} fn 要执行的函数
 * @returns {T} fn 的返回值
 */
export function withCaller(pluginId, fn) {
    const prev = ambient;
    ambient = pluginId || null;
    try {
        return fn();
    } finally {
        ambient = prev;
    }
}
