/**
 * menubar-tint.js — 顶栏跟随壁纸取色
 *
 * 取色只读壁纸配置里已有的缩略图（`config.thumb`，48px JPEG），不重新读 IndexedDB
 * 里的原图：缩略图本来就为「首帧先铺一张同色图」而存在，顶部 16% 的平均色足够
 * 决定顶栏底色，成本是一张小图的解码。取不到缩略图时退回壁纸 URL，再不行用中性蓝灰。
 *
 * 结果按壁纸配置缓存：只有换壁纸才重新采样。同一张壁纸反复调不透明度、模糊、
 * 文字颜色，都只走缓存里的 Promise。
 *
 * 文字色自动模式用相对亮度算黑/白两种候选的对比度，取更高的一边；任何底色下
 * 黑白最高对比度都不低于 4.5，因此不需要再叠一层「对比不足就偏移」的补丁。
 *
 * 铁律：`backdrop-filter` 所在元素绝不能挂 `transform`。本模块只写 CSS 变量与
 * `<html>` 上的 data 属性，不碰顶栏的 transform。
 */

import { settings } from "./settings.js";
import { wallpaper } from "./wallpaper.js";

const FALLBACK_RGB = [107, 124, 147];

/** 采样画布：宽 32，高度按缩略图比例，只取顶部 16% 的行。 */
const SAMPLE_WIDTH = 32;
const TOP_RATIO = 0.16;

/** 配置 -> 采样 Promise。只增不减会泄漏，超过 24 条淘汰最早一条。 */
const tintCache = new Map();

/** 换壁纸时的序号：慢采样的旧结果不得覆盖新结果。 */
let tintSeq = 0;

/** 最近一次采样结果，供不涉及壁纸的界面调整直接复用。 */
let lastRgb = [...FALLBACK_RGB];

/** 已知的设置键；界面与自检都从这里取，避免两处写死。 */
export const MENUBAR_KEYS = [
    "menubar.textColor",
    "menubar.textColor.custom",
    "menubar.blur",
    "menubar.opacity",
    "menubar.backgroundColor",
];

function defineSettings() {
    settings.defineMany([
        {
            key: "menubar.textColor", type: "string", default: "auto",
            values: ["auto", "light", "dark", "custom"],
            label: "顶栏文字颜色", control: "segmented",
            pane: "appearance", group: "菜单栏", order: 200,
        },
        {
            key: "menubar.textColor.custom", type: "string", default: "#ffffff",
            label: "自定义文字颜色", control: "color",
            pane: "appearance", group: "菜单栏", order: 210,
        },
        {
            key: "menubar.blur", type: "number", default: 100, min: 0, max: 100, step: 5,
            label: "亚克力模糊", control: "slider", units: "%",
            pane: "appearance", group: "菜单栏", order: 220,
        },
        {
            // 默认 0 = 不加底色，与录制中的现状完全一致；不透明度往上拉才看得到取色效果。
            key: "menubar.opacity", type: "number", default: 0, min: 0, max: 100, step: 1,
            label: "不透明度", control: "slider", units: "%",
            pane: "appearance", group: "菜单栏", order: 230,
        },
        {
            key: "menubar.backgroundColor", type: "string", default: "#1c1c1e",
            label: "背景颜色", control: "color",
            pane: "appearance", group: "菜单栏", order: 240,
        },
    ]);
}

/**
 * 采样源：优先缩略图，其次可安全读取的壁纸 URL。
 * `idb:` 这类引用不是图片地址，直接跳过。
 * @param {object} config 壁纸配置
 * @returns {string|null}
 */
function sampleSource(config) {
    if (!config) return null;
    const thumb = typeof config.thumb === "string" ? config.thumb : "";
    if (thumb) return thumb;
    const url = typeof config.url === "string" ? config.url : "";
    if (!url || url.startsWith("idb:")) return null;
    return url;
}

/** 缓存键：类型 + 图片尾部特征。整条 data URL 太长，不直接当键。 */
function cacheKey(config, source) {
    const type = config?.type || "unknown";
    const tail = source ? `${source.length}:${source.slice(-40)}` : "none";
    return `${type}|${tail}`;
}

/**
 * 读一张图，画进小画布，只统计顶部若干行。
 * @param {string} source 图片地址
 * @returns {Promise<[number, number, number]>}
 */
function sampleTop(source) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        // 站内相对地址与 data URL 同源；只有 http(s) 才需要匿名凭据。
        if (/^https?:/i.test(source)) img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                const width = SAMPLE_WIDTH;
                const height = Math.max(
                    4,
                    Math.round(width * (img.naturalHeight || 1) / Math.max(1, img.naturalWidth || 1)),
                );
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 0, 0, width, height);
                const rows = Math.max(1, Math.round(height * TOP_RATIO));
                const data = ctx.getImageData(0, 0, width, rows).data;
                resolve(averageRgb(data));
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => reject(new Error("顶栏取色：图片加载失败"));
        img.src = source;
    });
}

/** 有效像素的平均色；透明像素跳过。 */
function averageRgb(data) {
    let count = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 32) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
    }
    if (!count) return [...FALLBACK_RGB];
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

/**
 * 当前壁纸顶部颜色。命中缓存时同步可用的 Promise，界面不会等。
 * @returns {Promise<[number, number, number]>}
 */
function currentTint() {
    const config = wallpaper.getWallpaperConfig?.() || null;
    const source = sampleSource(config);
    const key = cacheKey(config, source);
    if (tintCache.has(key)) return tintCache.get(key);
    const job = (source ? sampleTop(source) : Promise.resolve([...FALLBACK_RGB]))
        .catch(() => [...FALLBACK_RGB]);
    if (tintCache.size >= 24) tintCache.delete(tintCache.keys().next().value);
    tintCache.set(key, job);
    return job;
}

/** sRGB 相对亮度，0（黑）到 1（白）。 */
function luminance([r, g, b]) {
    const channel = (value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 黑字与白字里对比度更高的一边。 */
function autoInk(rgb) {
    const light = luminance(rgb);
    const againstBlack = (light + 0.05) / 0.05;
    const againstWhite = 1.05 / (light + 0.05);
    return againstBlack >= againstWhite ? "black" : "white";
}

/** `#rrggbb` -> `[r, g, b]`；非法值返回 null。 */
function parseHex(value) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value || "").trim());
    if (!match) return null;
    const hex = match[1];
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * 把当前设置写到 `<html>` 的令牌上。
 * @param {[number, number, number]} tint 壁纸顶部色
 */
function applyTokens(tint) {
    const root = document.documentElement;
    const mode = settings.get("menubar.textColor", "auto");
    const opacity = clamp(Number(settings.get("menubar.opacity", 0)), 0, 100);
    const blur = clamp(Number(settings.get("menubar.blur", 100)), 0, 100);
    const customText = settings.get("menubar.textColor.custom", "#ffffff");
    const customBg = parseHex(settings.get("menubar.backgroundColor", "#1c1c1e")) || [28, 28, 30];

    const opaque = opacity >= 100;
    // 全不透明时用户选的底色才是真实底色，文字对比度也按它算。
    const inkBase = opaque ? customBg : tint;
    // 自动：按底色算黑白里对比度更高的一边；浅色 = 白字，深色 = 深字；
    // 自定义：图标只有黑白两档，取与自定义文字明暗更接近的一边，别让白图标配深字。
    let ink;
    if (mode === "custom") ink = autoInk(parseHex(customText) || [255, 255, 255]);
    else if (mode === "auto") ink = autoInk(inkBase);
    else ink = mode === "light" ? "white" : "black";

    root.style.setProperty("--menubar-tint-rgb", tint.join(", "));
    root.style.setProperty("--menubar-solid-rgb", customBg.join(", "));
    root.style.setProperty("--menubar-opacity", (opacity / 100).toFixed(3));
    root.style.setProperty("--menubar-blur-scale", String(blur / 100));
    root.style.setProperty(
        "--menubar-text-color",
        mode === "custom" ? customText : (ink === "black" ? "#1d1d1f" : "#ffffff"),
    );
    root.dataset.menubarOpaque = opaque ? "true" : "false";
    root.dataset.menubarInk = ink;
}

/**
 * 重算一次：换壁纸或有界面调整都走这里。
 * @returns {Promise<void>}
 */
async function refresh() {
    const seq = ++tintSeq;
    const tint = await currentTint();
    if (seq !== tintSeq) return;
    lastRgb = tint;
    applyTokens(tint);
}

/** 定义设置项、写初始令牌、挂事件。可重复调用。 */
export function initMenubarTint() {
    defineSettings();
    // 先用上次的主题色兜一帧，紧接着按当前壁纸重算，避免首屏闪一下默认蓝灰。
    const cached = parseHex(getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-tint-color"));
    if (cached) lastRgb = cached;
    applyTokens(lastRgb);

    window.addEventListener("wallpaper-change", () => { refresh(); });
    window.addEventListener("wallpaper-tint-change", () => { refresh(); });

    settings.subscribe((detail) => {
        if (!detail || !String(detail.key || "").startsWith("menubar.")) return;
        applyTokens(lastRgb);
    });

    refresh();
    return true;
}
