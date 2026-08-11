/**
 * script.js — VS Code 嵌入式插件逻辑
 *
 * 职责：
 * 1. 嵌入 github1s.com 在线编辑器。
 * 2. 标题栏颜色跟随 iframe 内网页主色调（同源策略下的双通道方案）：
 *    - 同源页面：读 <meta name="theme-color"> 或 body 背景色，并监听变化实时跟随；
 *    - 跨域页面：抓取站点 favicon（需 CORS 允许，github1s 已放行）提取品牌主色；
 *    - 提取失败：保持 VSCode 默认深灰 #3c3c3c。
 *    背景偏亮时自动加 .light 类切换深色文字，保证可读性。
 * 3. 加载失败时在标题栏给出提示（errored 类）。
 *
 * 说明：窗口拖拽/缩放/关闭由 window.js 统一处理，本插件不重复实现。
 */
const frame = document.querySelector(".vscode-frame");
const titlebar = document.querySelector(".vscode .vscode-titlebar");
const DEFAULT_BG = "#3c3c3c";
const LIGHT_THRESHOLD = 0.45; // 背景相对亮度超过该值 → 浅色主题

/* ---------- 颜色工具 ---------- */

/** sRGB 相对亮度（0~1），用于决定文字取深色还是浅色 */
function luminance(r, g, b) {
    const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 解析 "rgb(r,g,b)" / "#rrggbb" → {r,g,b}；格式不符或全透明返回 null */
function parseColor(str) {
    if (!str) return null;
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/.exec(str);
    if (rgb) {
        if (rgb[4] !== undefined && +rgb[4] < 0.1) return null;
        return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(str.trim());
    if (hex) {
        const v = parseInt(hex[1], 16);
        return { r: v >> 16 & 255, g: v >> 8 & 255, b: v & 255 };
    }
    return null;
}

/** 把主题色写入标题栏；null → 恢复默认深灰 */
function applyTitleColor(color) {
    if (!color) {
        titlebar.style.background = DEFAULT_BG;
        titlebar.classList.remove("light");
        return;
    }
    const { r, g, b } = color;
    titlebar.style.background = `rgb(${r},${g},${b})`;
    titlebar.classList.toggle("light", luminance(r, g, b) > LIGHT_THRESHOLD);
}

/** 提取位图主色：滤掉透明/近白/近黑像素后取平均（favicon 常见白底黑图） */
function extractDominantColor(bitmap) {
    const SIZE = 48;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
        const R = data[i], G = data[i + 1], B = data[i + 2], A = data[i + 3];
        if (A < 128 || (R > 240 && G > 240 && B > 240) || (R < 24 && G < 24 && B < 24)) continue;
        r += R; g += G; b += B; n++;
    }
    if (!n) { // 全部被滤（纯黑白图标）→ 退回含黑白的整体平均
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
    }
    return n ? { r: r / n | 0, g: g / n | 0, b: b / n | 0 } : null;
}

/** Blob → 可绘制位图（优先 createImageBitmap，回退 Image） */
async function blobToBitmap(blob) {
    if (typeof createImageBitmap === "function") {
        try { return await createImageBitmap(blob); } catch { /* 回退 Image */ }
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("favicon decode failed")); };
        img.src = url;
    });
}

/* ---------- 颜色同步 ---------- */

/** 同源通道：读 meta theme-color / body 背景色（跨域访问抛错返回 null） */
function readSameOriginColor() {
    try {
        const doc = frame.contentDocument;
        if (!doc) return null;
        const meta = doc.querySelector('meta[name="theme-color"]');
        return parseColor(meta && meta.content) || parseColor(getComputedStyle(doc.body).backgroundColor);
    } catch {
        return null; // 跨域 iframe，读不到内部样式
    }
}

/** 跨域通道：抓站点 favicon（需 CORS 允许）提取品牌主色 */
async function fetchFaviconColor() {
    const origin = new URL(frame.src).origin;
    for (const path of ["/favicon.ico", "/favicon.png"]) {
        try {
            const res = await fetch(origin + path, { mode: "cors", cache: "force-cache" });
            if (!res.ok) continue;
            const color = extractDominantColor(await blobToBitmap(await res.blob()));
            if (color) return color;
        } catch { /* 尝试下一个源 */ }
    }
    return null;
}

/** 主入口：同源优先，跨域走 favicon，全部失败保持默认。
 * 带代际守卫：favicon fetch 是异步的，可能晚于后续 sync 完成，
 * 若没有守卫会把旧结果覆盖掉新结果（如 iframe load 读到的主题色被初次的
 * fetch 404 结果覆盖回默认色）。只应用最新一次调用的结果。 */
let syncSeq = 0;
async function syncTitlebarColor() {
    const seq = ++syncSeq;
    const color = readSameOriginColor() || await fetchFaviconColor();
    if (seq !== syncSeq) return; // 已有更新的同步请求，丢弃过期结果
    applyTitleColor(color);
}

/* ---------- 事件绑定 ---------- */

/** 同源页面：监听 theme-color meta 变化实时跟随（跨域读取抛错自动跳过）。
 * 必须在 iframe 加载完成后重建——初始文档是 about:blank，加载真实页面时
 * contentDocument 被整体替换，旧 observer 会失效。 */
let observer = null;
function watchSameOriginTheme() {
    if (observer) { observer.disconnect(); observer = null; }
    try {
        const doc = frame.contentDocument;
        if (!doc) return;
        observer = new MutationObserver(syncTitlebarColor);
        observer.observe(doc.head || doc, {
            childList: true, subtree: true, attributes: true, attributeFilter: ["content"],
        });
    } catch { /* 跨域不可读 */ }
}

if (frame) {
    // 加载成功：清除错误标记、重建同源监听并同步颜色（跨域导航同样会触发 load）
    frame.addEventListener("load", () => {
        titlebar.classList.remove("errored");
        watchSameOriginTheme();
        syncTitlebarColor();
    });
    frame.addEventListener("error", () => titlebar.classList.add("errored"));

    watchSameOriginTheme(); // iframe 可能已加载完成（如缓存/同步场景）
    syncTitlebarColor();     // 首次同步（favicon 抓取不依赖 iframe 加载完成）
}
