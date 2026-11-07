/**
 * ui/notification.js — 系统通知（右上角横幅）
 *
 * 接口：window.__notify.show({ icon, title, text, time, onAction, duration })
 *       与 window.__dialog（ui/alert.js）同一风格的全局入口，供核心层与 mods 插件调用。
 *
 * 三处与旧实现不同的地方，都是被证据逼出来的：
 * 1. 不在 import 时 new Audio(...)：提示音改由声音 owner（sound.js）统一负责，
 *    本模块只管「要不要响」，音量与静音归 `sound.master` / `sound.muted`。
 * 2. 不再使用 WebSwift 的 <swift-notification>：该元素的构造函数里同步执行
 *    `new Function(this.command)`（assets/vendor/webswift.js:48-49），而 MV3 扩展页的 CSP 固定为
 *    script-src 'self'（无 unsafe-eval），于是 document.createElement("swift-notification")
 *    本身就抛 EvalError —— 与 ui/menuCommands.js:4-6 修掉的「菜单命令静默失效」是同一类缺陷。
 *    这里改用普通 div 自绘，外观对齐原组件（右侧 346x76、圆角 16、毛玻璃）。
 * 3. 正文不再走 innerHTML：通知内容可能来自不可信插件，全部用 textContent 落节点，
 *    「转义后再拼 HTML」这一步整个省掉，没有漏转义的死角。
 *
 * 四条策略都来自设置中枢，读的是当次调用的即时值（不缓存，改了立刻生效）：
 * - `notify.enabled` 关 → 直接 return null，连横幅都不生成；
 * - `controlcenter.focus`（控制中心的专注模式大卡）开 → 不弹横幅，但**计数**：
 *   noteSuppressed() 把 deskly-dnd-count 加一，专注模式面板据此显示「拦截了 N 条」，
 *   否则用户永远不知道自己为什么没收到提醒；
 * - `notify.duration` → 自动收起的默认时长；
 * - `notify.sound` → 是否播放提示音。
 *
 * 每一次投递（含被拦下的）都进运行记录：source `kernel/notification`，message 为标题。
 *
 * 层级取自全局层级表 zindex.js：Z.MODAL（9610），高于 Dock(9500) 与启动台(9600)，
 * 低于右键菜单(9620) —— 通知不应盖住用户正在操作的菜单。
 */
import { Z } from "../zindex.js";
import { settings } from "../settings.js";
import { sound } from "../sound.js";
import { GENERIC_APP_ICON } from "../paths.js";

const DEFAULT_DURATION = 5500;   // 设置缺失时的兜底自动收起时长
const CLOSE_ANIMATION = 400;     // 与下方 transition 时长保持一致
const TOP_OFFSET = 34;           // 首条通知距视口顶部（让开 30px 菜单栏）
const ITEM_HEIGHT = 84;          // 76px 高度 + 8px 堆叠间距

/** 专注模式拦截计数槽：是统计而非设置，直写存储，不走设置中枢。 */
const DND_COUNT_SLOT = "deskly-dnd-count";

/** 当前在册的通知：用于计算堆叠位置与卸载后回收。 */
const visible = new Set();

/** 通知策略取值：布尔项缺失时按默认放行。 */
function flag(key, fallback) {
    const value = settings.get(key);
    return value === undefined || value === null ? fallback : Boolean(value);
}

/** 自动收起时长（notify.duration）。 */
function defaultDuration() {
    const value = Number(settings.get("notify.duration"));
    return Number.isFinite(value) ? value : DEFAULT_DURATION;
}

/** 专注模式（勿扰）是否开启。 */
function isDisturbing() {
    return flag("controlcenter.focus", false);
}

/** 读拦截计数。 */
function readCount() {
    try {
        const n = Number(localStorage.getItem(DND_COUNT_SLOT));
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
        return 0;
    }
}

function writeCount(n) {
    try {
        if (n > 0) localStorage.setItem(DND_COUNT_SLOT, String(n));
        else localStorage.removeItem(DND_COUNT_SLOT);
    } catch { /* 存储不可用时计数只活在本页 */ }
    document.dispatchEvent(new CustomEvent("notify-suppressed-change", { detail: { count: n }, bubbles: true }));
}

/**
 * 记下一条被专注模式拦截的通知（专注模式面板的「拦截了 N 条」据此显示）。
 * @returns {number} 累计拦截条数
 */
export function noteSuppressed() {
    const next = readCount() + 1;
    writeCount(next);
    return next;
}

/**
 * 当前累计被拦截的通知条数。
 * @returns {number} 计数
 */
export function pendingCount() {
    return readCount();
}

/**
 * 清零拦截计数（进入专注模式面板查看后调用）。
 * @returns {void}
 */
export function resetPendingCount() {
    writeCount(0);
}

/**
 * 弹出一条系统通知。
 * @param {object} opts 通知参数
 * @param {string} [opts.icon] 图标路径（如 ./assets/icons/Finder.png）
 * @param {string} [opts.title] 标题
 * @param {string} [opts.text] 正文
 * @param {string} [opts.time] 右侧时间文案，默认「刚刚」
 * @param {Function} [opts.onAction] 点击回调（通知随即收起）
 * @param {number} [opts.duration] 自动收起毫秒数，默认取 notify.duration；传 0 表示不自动收起
 * @returns {HTMLElement|null} 通知元素；参数全空或被设置拦下时返回 null
 */
export function showNotification(opts = {}) {
    const {
        icon = "", title = "", text = "", time = "刚刚", onAction,
        duration = defaultDuration(),
    } = opts;
    if (!title && !text) return null;

    // 拦下的原因先判出来，日志一次写全：被关掉、被勿扰、还是真的弹了出去
    const outcome = !flag("notify.enabled", true) ? "disabled"
        : (isDisturbing() ? "do-not-disturb" : "shown");
    globalThis.__log?.info("kernel/notification", String(title || text), { outcome, text });
    if (outcome === "disabled") return null;
    if (outcome === "do-not-disturb") {
        noteSuppressed();
        return null;
    }

    if (flag("notify.sound", true)) sound.playTone("alert");

    const el = document.createElement("div");
    el.className = "os-notification";
    el.setAttribute("role", "status");
    // 堆叠：新通知落在已有通知下方，视觉上形成一列
    // 模糊走系统令牌；本元素底色是写死的浅色（不随主题变），所以文字色必须按它自己的
    // 底色算 —— 下面 __surface.apply 会就地写局部 --surface-text，
    // 否则深色主题下全局令牌是白字，压在浅底上直接看不见。
    el.style.cssText = `position:fixed;right:10px;top:${TOP_OFFSET + visible.size * ITEM_HEIGHT}px;z-index:${Z.MODAL};`
        + `width:346px;min-height:76px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:10px 14px;`
        + `background:rgba(246,246,246,0.6);backdrop-filter:blur(var(--surface-blur-3));-webkit-backdrop-filter:blur(var(--surface-blur-3));`
        + `border-radius:16px;box-shadow:0 8px 40px 0 rgba(0,0,0,0.25),0 0 3px 0 rgba(0,0,0,0.55);`
        + `color:var(--surface-text);font-size:13px;cursor:default;user-select:none;-webkit-user-select:none;`
        + `opacity:1;transform:translateX(0);transition:transform .4s ease,opacity .4s ease;`;
    globalThis.__surface?.apply?.(el, { role: 3 });

    if (icon) {
        const img = document.createElement("img");
        img.src = icon;
        img.alt = "";
        img.style.cssText = "width:40px;height:40px;flex:0 0 40px;object-fit:contain;";
        // 图标路径失效（插件被卸载 / manifest 写错）时不把裂图摆在通知里：
        // 第一次 error 就换成通用应用占位，之后不再重试。
        let iconFailed = false;
        img.addEventListener("error", () => {
            if (iconFailed) return;
            iconFailed = true;
            img.src = GENERIC_APP_ICON;
        });
        el.appendChild(img);
    }

    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-width:0;";
    const titleEl = document.createElement("p");
    titleEl.style.cssText = "margin:0;font-weight:600;line-height:16px;";
    titleEl.textContent = String(title);
    const textEl = document.createElement("p");
    textEl.style.cssText = "margin:2px 0 0;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    textEl.textContent = String(text);
    body.append(titleEl, textEl);
    el.appendChild(body);

    const timeEl = document.createElement("span");
    timeEl.textContent = time;
    timeEl.style.cssText = "position:absolute;top:12px;right:14px;font-size:11px;opacity:.5;";
    el.appendChild(timeEl);

    // 释放：点击或到期都移除元素本身（隐藏会永久留在 body 里累积）
    let timer = null;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        el.style.transform = "translateX(400px)";
        el.style.opacity = "0";
        setTimeout(() => {
            el.remove();
            visible.delete(el);
            // 中间通知关闭后其余通知要回填位置：top 只在创建时按 visible.size 算过，
            // 不回填会让新通知与残留通知重叠（BUG-08）
            let i = 0;
            visible.forEach((n) => { n.style.top = `${TOP_OFFSET + i * ITEM_HEIGHT}px`; i += 1; });
        }, CLOSE_ANIMATION);
    };
    el.addEventListener("click", () => {
        try { onAction?.(); } catch (err) { console.warn("[notification] 点击回调执行失败:", err); }
        close();
    });

    document.body.appendChild(el);
    visible.add(el);
    if (duration > 0) timer = setTimeout(close, duration);
    return el;
}

/**
 * 收起当前所有通知（切换会话 / 锁屏时调用，避免残留到下一屏）。
 * @returns {void}
 */
export function dismissAllNotifications() {
    Array.from(visible).forEach((el) => {
        el.remove();
        visible.delete(el);
    });
}

// ---- 全局通知接口 ----
// 与 window.__dialog 同风格：核心层与插件不必 import 本模块即可调用。
// 挂载时机：本模块由引用方（核心模块或插件）import 后生效，与 alert.js 一致。
window.__notify = {
    /** 弹出一条通知（参数见 showNotification） */
    show: showNotification,
    /** 收起全部通知 */
    dismissAll: dismissAllNotifications,
    /** 专注模式已拦截条数 */
    pendingCount,
    /** 清零拦截计数 */
    resetPendingCount,
};
