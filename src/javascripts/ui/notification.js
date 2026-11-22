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
 * - `notify.enabled` 关 → 直接 return null，连落库都不做；
 * - 按应用开关（notify.apps）关 → 该应用的通知整条丢弃；
 * - 专注模式（notifications/focus.js 的 evaluate）不放行 → 不弹横幅不响铃，
 *   但落库为 muted 记录 —— 系统设置专注面板的「拦截了 N 条」与通知中心回看共用它；
 * - `notify.bannerStyle` → 横幅样式（横幅=按时长收起 / 提醒=常驻 / 无=不弹）；
 * - `notify.duration` → 自动收起的默认时长；
 * - `notify.sound` → 是否播放提示音。
 *
 * 每一次投递（含被拦下的）都进运行记录：source `kernel/notification`，message 为标题。
 *
 * F-17/F-19 之后的数据流：所有通知（含被专注模式静音的）统一落 notifications/store.js
 * 持久化（50 条 / 7 天），通知中心面板与横幅共用同一份 store；「专注模式拦截计数」
 * 改为 store 里 muted 记录的实时统计，不再单独维护数字。
 *
 * 层级取自全局层级表 zindex.js：Z.MODAL（9610），高于 Dock(9500) 与启动台(9600)，
 * 低于右键菜单(9620) —— 通知不应盖住用户正在操作的菜单。
 */
import { Z } from "../zindex.js";
import { settings } from "../settings.js";
import { sound } from "../sound.js";
import { GENERIC_APP_ICON } from "../paths.js";
import { store } from "../notifications/store.js";

const DEFAULT_DURATION = 5500;   // 设置缺失时的兜底自动收起时长
const CLOSE_ANIMATION = 400;     // 与下方 transition 时长保持一致
const TOP_OFFSET = 34;           // 首条通知距视口顶部（让开 30px 菜单栏）
const ITEM_HEIGHT = 84;          // 76px 高度 + 8px 堆叠间距

/** 应用显示名（异步预热，落库时用得上；拿不到就退回 appId 本身）。 */
let appRegistry = null;
import("../app-registry.js").then((m) => { appRegistry = m; }).catch(() => {});

/**
 * 记下一条被专注模式拦截的通知。
 * 旧实现只累加计数；F-17 起拦截的通知与普通通知共用同一份 store（带 muted 标记），
 * 因此这里只兼容旧导出：真正的落库发生在 showNotification 内部。
 * @returns {number} 当前静音条数
 */
export function noteSuppressed() {
    return store.mutedCount();
}

/**
 * 当前被专注模式静音的通知条数（系统设置「拦截统计」数据源）。
 * @returns {number} 计数
 */
export function pendingCount() {
    return store.mutedCount();
}

/**
 * 清零拦截统计（进入系统设置查看后调用）：静音记录转正为普通可回看通知。
 * @returns {void}
 */
export function resetPendingCount() {
    store.clearMutedFlags();
}

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

/** 读拦截计数。 */
function readCount() {
    return store.mutedCount();
}

function writeCount(n) {
    if (n > 0) return; // 新数据流下计数由 store 派生，旧写路径不再使用
    store.clearMutedFlags();
    document.dispatchEvent(new CustomEvent("notify-suppressed-change", { detail: { count: 0 }, bubbles: true }));
}

/**
 * 弹出一条系统通知。
 * @param {object} opts 通知参数
 * @param {string} [opts.icon] 图标路径（如 ./assets/icons/Finder.webp）
 * @param {string} [opts.title] 标题
 * @param {string} [opts.text] 正文
 * @param {string} [opts.appId] 归属应用（插件 id）；专注模式白名单与按应用开关都按它判定，
 *                              缺省按「无法归属」处理（激活专注模式时会被静音）
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

    const appId = typeof opts.appId === "string" ? opts.appId : "";

    // 拦下的原因先判出来，日志一次写全：被关掉、被按应用开关关掉、被专注模式静音、只有落库、还是真的弹了出去
    if (!flag("notify.enabled", true)) {
        globalThis.__log?.info("kernel/notification", String(title || text), { outcome: "disabled", text });
        return null;
    }
    const appCfg = appId ? store.appConfig(appId) : { enabled: true, inCenter: true };
    if (!appCfg.enabled) {
        globalThis.__log?.info("kernel/notification", String(title || text), { outcome: "app-disabled", appId, text });
        return null;
    }

    // 落库：横幅与通知中心共用同一份 store
    if (appCfg.inCenter) {
        store.add({
            appId,
            appName: appId ? (appRegistry?.displayNameFor?.(appId) || appId) : "",
            icon, title, text, muted: false,
        });
    }

    const bannerStyle = settings.get("notify.bannerStyle", "banner");
    if (bannerStyle === "none") {
        globalThis.__log?.info("kernel/notification", String(title || text), { outcome: "banner-none", appId, text });
        return null;
    }
    // 「提醒」（alert）样式常驻直到用户点掉；「横幅」（banner）按时长自动收起
    const effDuration = bannerStyle === "alert" ? 0 : duration;
    globalThis.__log?.info("kernel/notification", String(title || text), { outcome: "shown", appId, text });

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
    if (effDuration > 0) timer = setTimeout(close, effDuration);
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
    /** 弹出一条通知（参数见 showNotification；opts.appId 标注归属应用） */
    show: showNotification,
    /** 收起全部通知 */
    dismissAll: dismissAllNotifications,
    /** 专注模式已静音条数（= store 中 muted 记录数） */
    pendingCount,
    /** 清零拦截统计（静音记录转正） */
    resetPendingCount,
    /** 通知 store：list()/remove(id)/clearAll()/subscribe(fn)，批次 7（Siri/聚焦）经此读取 */
    store,
};
window.__notifyStore = store;

// 预热通知中心面板（点时间/日期即开，首次点击不再等待模块加载）
import("./notification-center.js").catch((err) => {
    console.warn("[notification] 通知中心模块预热失败:", err);
});
