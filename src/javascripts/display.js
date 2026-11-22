/**
 * display.js — 显示器 owner：亮度
 *
 * 压暗层 `#deskly-brightness-overlay` 由控制中心（controlcenter.js）持有，
 * 本模块只负责把 `display.brightness` 注册进设置中枢、校验取值，并和控制中心
 * 共用 `webstartos_controlcenter` 这个 JSON 槽的 `displayBrightness` 字段。
 *
 * 生效函数派发 window 事件 `display-brightness-change`（detail 为亮度比），
 * 控制中心据此驱动它自己的那层；设置中枢同时广播 document 的 `settings-changed`，
 * 所以任何入口拖动亮度结果都一致。
 *
 * Night Shift 与设置里的亮度控件已移除；这里仅保留控制中心亮度滑块所需的数据层。
 */
import { settings } from "./settings.js";

/** 默认亮度，与控制中心 DEFAULT_STATE.displayBrightness 对齐。 */
const DEFAULT_BRIGHTNESS = 0.85;

/** 收成 0..1 的合法比例。 */
function ratio(value, fallback) {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(1, Math.max(0, num));
}

/** 注册亮度设置。 */
function defineSchema() {
    settings.defineMany([
        {
            key: "display.brightness", slot: "webstartos_controlcenter", jsonPath: "displayBrightness",
            type: "number", default: DEFAULT_BRIGHTNESS, min: 0, max: 1, step: 0.01,
            format: "percent", control: "slider", pane: "controlcenter", group: "显示器", order: 10,
            label: "亮度",
            apply: (value) => {
                window.dispatchEvent(new CustomEvent("display-brightness-change", { detail: ratio(value, DEFAULT_BRIGHTNESS) }));
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

/** 显示器模块对外 API（挂到 window.__display）。 */
const display = {
    getBrightness,
    setBrightness,
};

let initialized = false;

/**
 * 初始化显示器模块（重复调用幂等）。
 * @returns {boolean} 是否完成初始化
 */
function initDisplay() {
    if (initialized) return true;
    initialized = true;
    window.__log?.info("kernel/display", `显示器就绪：亮度 ${Math.round(getBrightness() * 100)}%`);
    return true;
}

defineSchema();

globalThis.__display = display;

export { display, initDisplay, getBrightness, setBrightness };
