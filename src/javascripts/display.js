/**
 * display.js — 显示器 owner：亮度与 Night Shift
 *
 * 两块能力的分工写在这里，免得后来者以为「亮度也归本模块画」：
 *
 * - **亮度**：压暗层 `#deskly-brightness-overlay`（旧 id 仍兼容读取） 由控制中心（controlcenter.js）持有，
 *   本模块只负责把 `display.brightness` 注册进设置中枢、校验取值、和控制中心共用
 *   `webstartos_controlcenter` 这同一个 JSON 槽的 `displayBrightness` 字段。
 *   生效函数按约定派发 window 事件 `display-brightness-change`（detail 为亮度比），
 *   控制中心据此驱动它自己的那层；设置中枢同时广播 document 的 `settings-changed`，
 *   所以从系统设置拖动滑块与从控制中心拖动滑块结果完全一致。
 * - **Night Shift**：这一层是本模块自己画的真实暖色压层 —— 固定 `<div>`，
 *   暖色以普通 alpha 合成（透明度由 `display.nightShiftIntensity` 缩放），
 *   层级 `Z.NIGHT_SHIFT`（= 压暗层之上、会话遮罩之下），与压暗层顺序叠加。
 *   历史写法是 `mix-blend-mode: multiply`：页面里一旦出现带 blend-mode 的元素，
 *   Chromium 会让 backdrop-filter 采样失效，系统设置侧栏的毛玻璃因此整块退化成
 *   平色（切到「显示器」面板必现）。为保住亚克力，这里改用普通合成，视觉上
 *   从「正片叠底染色」变为「暖色薄纱」，色值不变。
 *
 * 自动模式（`display.nightShiftAuto`）在 19:00–07:00 之间生效，每 60 秒重算一次，
 * 并在标签页重新可见时立刻重算 —— 后台标签页的 setInterval 会被浏览器节流到分钟级，
 * 只靠定时器会在切回来看见一屏冷白光。
 */
import { settings } from "./settings.js";
import { Z } from "./zindex.js";

/** 暖色压层的底色（macOS Night Shift 的橙黄调），multiply 模式下决定染暖的色相。 */
const WARM_COLOR = "rgb(255, 170, 90)";

/** 覆盖层元素 id。 */
const OVERLAY_ID = "deskly-nightshift";

/** 自动模式的夜间区间（本地时间，含跨零点）。 */
const NIGHT_START_HOUR = 19;
const NIGHT_END_HOUR = 7;

/** 定时重算间隔：60 秒。 */
const AUTO_RECHECK_MS = 60000;

/** 默认亮度与暖色强度，与控制中心 DEFAULT_STATE.displayBrightness 对齐。 */
const DEFAULT_BRIGHTNESS = 0.85;
const DEFAULT_INTENSITY = 0.25;

/** 定时器句柄（只挂一个，重复 init 不累积）。 */
let autoTimer = null;
let visibilityBound = false;

/** 收成 0..1 的合法比例。 */
function ratio(value, fallback) {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(1, Math.max(0, num));
}

/** 注册显示器相关的四项设置。 */
function defineSchema() {
    settings.defineMany([
        {
            key: "display.brightness", slot: "webstartos_controlcenter", jsonPath: "displayBrightness",
            type: "number", default: DEFAULT_BRIGHTNESS, min: 0, max: 1, step: 0.01,
            format: "percent", control: "slider", pane: "display", group: "显示器", order: 10,
            label: "亮度",
            apply: (value) => {
                window.dispatchEvent(new CustomEvent("display-brightness-change", { detail: ratio(value, DEFAULT_BRIGHTNESS) }));
            },
        },
        {
            key: "display.nightShift", type: "boolean", default: false,
            control: "switch", pane: "display", group: "显示器", order: 20,
            label: "Night Shift",
            apply: () => apply(),
        },
        {
            key: "display.nightShiftIntensity", type: "number", default: DEFAULT_INTENSITY,
            min: 0.05, max: 0.6, step: 0.01,
            format: "percent", control: "slider", pane: "display", group: "显示器", order: 30,
            label: "Night Shift 强度",
            apply: () => apply(),
        },
        {
            key: "display.nightShiftAuto", type: "boolean", default: false,
            control: "switch", pane: "display", group: "显示器", order: 40,
            label: "自动 Night Shift",
            apply: () => {
                apply();
                armAutoTimer();
            },
        },
    ]);
}

/** 当前亮度比（0..1）。 */
function getBrightness() {
    return ratio(settings.get("display.brightness"), DEFAULT_BRIGHTNESS);
}

/** 写入亮度（经设置中枢校验与落盘）。 */
function setBrightness(value) {
    return settings.set("display.brightness", ratio(value, getBrightness()), { source: "display" }).ok;
}

/** 是否处于自动模式的夜间区间。 */
function isNightHours(now = new Date()) {
    const hour = now.getHours();
    return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** Night Shift 当前是否生效：手动开关优先，自动模式命中也算开。 */
function isNightShiftActive() {
    if (settings.get("display.nightShift")) return true;
    return Boolean(settings.get("display.nightShiftAuto")) && isNightHours();
}

/** 暖色强度（0..1，越界回退默认）。 */
function intensity() {
    return ratio(settings.get("display.nightShiftIntensity"), DEFAULT_INTENSITY);
}

/** 取（或建）暖色压层元素。层级一次写定，之后只改透明度；刻意不带 blend-mode（见文件头）。 */
function ensureOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.className = "os-overlay";
    el.setAttribute("aria-hidden", "true");
    Object.assign(el.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        background: WARM_COLOR,
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity .6s ease",
        zIndex: String(Z.NIGHT_SHIFT),
    });
    document.body.appendChild(el);
    return el;
}

/**
 * 按当前设置重绘暖色压层。
 * @returns {boolean} Night Shift 是否生效
 */
function apply() {
    const el = ensureOverlay();
    const on = isNightShiftActive();
    el.style.opacity = on ? String(intensity()) : "0";
    return on;
}

/** 只在自动模式打开时保留定时器，关掉就摘掉，不留空转的 interval。 */
function armAutoTimer() {
    const wantTimer = Boolean(settings.get("display.nightShiftAuto"));
    if (wantTimer && !autoTimer) autoTimer = setInterval(apply, AUTO_RECHECK_MS);
    if (!wantTimer && autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
}

/** 标签页重新可见时立刻重算：后台节流会让定时器迟到。 */
function onVisibility() {
    if (document.visibilityState === "visible") apply();
}

/** 显示器模块对外 API（挂到 window.__display）。 */
const display = {
    apply,
    getBrightness,
    setBrightness,
    isNightShiftActive,
    isNightHours,
    /** 当前暖色强度。 */
    getIntensity: intensity,
    /** 夜间区间起止小时。 */
    schedule: { start: NIGHT_START_HOUR, end: NIGHT_END_HOUR },
};

let initialized = false;

/**
 * 初始化显示器模块：套用当前值并挂上自动模式的复算入口。
 * @returns {boolean} 是否完成初始化（重复调用幂等）
 */
function initDisplay() {
    if (initialized) return true;
    initialized = true;
    if (!visibilityBound) {
        visibilityBound = true;
        document.addEventListener("visibilitychange", onVisibility);
    }
    armAutoTimer();
    const on = apply();
    window.__log?.info("kernel/display",
        `显示器就绪：亮度 ${Math.round(getBrightness() * 100)}%，Night Shift ${on ? "已开启" : "关闭"}`
        + `（强度 ${Math.round(intensity() * 100)}%${settings.get("display.nightShiftAuto") ? "，按计划自动" : ""}）`);
    return true;
}

defineSchema();

globalThis.__display = display;

export { display, initDisplay, apply, getBrightness, setBrightness, isNightShiftActive };
