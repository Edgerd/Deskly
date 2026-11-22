/**
 * widgets/registry.js —— 小组件类型注册表（F-18）
 *
 * 原版依据：docs/iMac-2024-macOS15-知识库/images/S0056_DesktopNotificationCenter.png
 * macOS 小组件有尺寸（小/中/大）、可加入通知中心与桌面；本表登记「有哪些类型」，
 * 容器与布局（widgets/host.js）负责「放哪里」。
 *
 * 内置类型在本模块底部统一注册（避免 builtins ↔ registry 的加载环）：
 * - calendar / clock：真实数据（本地时间与月历）；
 * - weather：本地占位 —— 实时天气需要外部数据源，仅保留版式并明确标注（G9），
 *   待接入真实数据后在此替换 render。
 *
 * 插件经 os-api `Deskly.widgets.create()` 注册的类型以 `<插件id>:<type>` 命名落进本表，
 * 宿主按声明尺寸渲染其 entry iframe（G1：iframe 仅是插件实现细节）。
 */

/** 尺寸规范（与 macOS 对齐的三档） */
export const WIDGET_SIZES = ["small", "medium", "large"];

import { i18n } from "../i18n.js";

/** 尺寸显示名（静态表，供 host/center 使用） */
export const SIZE_LABEL = {
    small: ["widgets.sizeSmall", "小"],
    medium: ["widgets.sizeMedium", "中"],
    large: ["widgets.sizeLarge", "大"],
};

/** @type {Map<string, object>} type id → def */
const types = new Map();

export const REGISTRY_EVENT = "widgets-registry-change";

function notify() {
    document.dispatchEvent(new CustomEvent(REGISTRY_EVENT, { detail: { count: types.size } }));
}

/** 校验并补全类型定义；失败返回 null */
function normalize(def) {
    if (!def || typeof def !== "object") return null;
    const id = typeof def.id === "string" ? def.id.trim() : "";
    if (!id || types.has(id)) return null;
    const sizes = Array.isArray(def.sizes)
        ? def.sizes.filter((s) => WIDGET_SIZES.includes(s))
        : ["medium"];
    if (!sizes.length) sizes.push("medium");
    if (typeof def.render !== "function") return null;
    return {
        id,
        sizes,
        render: def.render,
        // destroy：有定时器/监听的类型必须提供，实例销毁时调用
        destroy: typeof def.destroy === "function" ? def.destroy : null,
        // 插件来源标记（"" = 内置）；用于 os-api update/remove 的归属校验
        owner: typeof def.owner === "string" ? def.owner : "",
        // 插件 widget 内容页（相对插件根的路径）；内置类型为 ""
        entry: typeof def.entry === "string" ? def.entry : "",
    };
}

/** 注册类型；重复 id / render 非函数返回 null */
export function registerType(def) {
    const norm = normalize(def);
    if (!norm) return null;
    types.set(norm.id, norm);
    notify();
    return norm;
}

/** 注销类型（同时通知宿主摘除已挂实例，host 监听 REGISTRY_EVENT） */
export function unregisterType(id) {
    if (!types.has(id)) return false;
    types.delete(id);
    notify();
    return true;
}

export function getType(id) {
    return types.get(id) || null;
}

export function hasType(id) {
    return types.has(id);
}

/** 全部类型（注册顺序） */
export function listTypes() {
    return [...types.values()];
}

/** 类型显示名：静态键位表（G3），禁止运行时拼接键名 */
export function typeLabel(id) {
    const LABELS = {
        calendar: ["widgets.calendar", "日历"],
        clock: ["widgets.clock", "时钟"],
        weather: ["widgets.weather", "天气"],
    };
    const t = types.get(id);
    if (!t) return id;
    if (LABELS[id]) return i18n.t(LABELS[id][0], LABELS[id][1]);
    return t.owner ? `${t.owner}:${id}` : id;
}

/* ── 内置类型注册（单点注册，避免加载环） ── */
import { calendarWidget } from "./builtins/calendar.js";
import { clockWidget } from "./builtins/clock.js";
import { weatherWidget } from "./builtins/weather.js";

calendarWidget.forEach((w) => registerType(w));
clockWidget.forEach((w) => registerType(w));
weatherWidget.forEach((w) => registerType(w));
