/**
 * icon.js — 插件图标。
 *
 * 图标最终要写进插件包的 icon.webp，因此这里统一产出 WebP：
 * · 默认按名称首字画一个圆角方块，颜色取窗口强调色或系统强调色；
 * · 用户上传图片或抓取到 favicon 时，居中裁切后转 512×512 WebP；
 * · 同一 id 的结果缓存起来，列表重绘不反复画布。
 */

const ICON_SIZE = 512;
const cache = new Map();

function readAccent() {
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
    } catch (_) { /* 主题未就绪时用默认值 */ }
    return "#2078DA";
}

/** 从 record 决定底色：窗口强调色优先，其次中文名散列到同色系。 */
export function iconColor(record) {
    if (record && record.icon && record.icon.color) return record.icon.color;
    if (record && record.window && record.window.accent) return record.window.accent;
    return readAccent();
}

function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/webp", 0.92));
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

async function blobToImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode();
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** 居中裁切到正方形，缩放至 512，转 WebP 的 data URL。 */
async function squareIcon(blob) {
    const img = await blobToImage(blob);
    const side = Math.min(img.naturalWidth, img.naturalHeight) || 1;
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        ICON_SIZE,
        ICON_SIZE,
    );
    const out = await canvasToBlob(canvas);
    return { blob: out, data: await blobToDataUrl(out) };
}

/** 画字母图标；返回 WebP blob 与 data URL。 */
export async function makeMonogram(letter, color) {
    const text = String(letter || "?").trim().slice(0, 2).toUpperCase() || "?";
    const bg = /^#[0-9a-f]{6}$/i.test(color || "") ? color : readAccent();
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    const radius = ICON_SIZE * 0.22;

    const path = new Path2D();
    path.roundRect(0, 0, ICON_SIZE, ICON_SIZE, radius);
    ctx.fillStyle = bg;
    ctx.fill(path);

    const gradient = ctx.createLinearGradient(0, 0, 0, ICON_SIZE);
    gradient.addColorStop(0, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(0,0,0,0.08)");
    ctx.fillStyle = gradient;
    ctx.fill(path);

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${text.length > 1 ? Math.round(ICON_SIZE * 0.34) : Math.round(ICON_SIZE * 0.46)}px "SF Pro Display", "PingFang SC", "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(text, ICON_SIZE / 2, ICON_SIZE * 0.52);

    const blob = await canvasToBlob(canvas);
    return { blob, data: await blobToDataUrl(blob) };
}

/**
 * 上传文件 → WebP 图标。超过 1 MB 直接拒绝，避免把插件库撑大。
 * 失败时抛错，由界面保留旧图标。
 */
export async function iconFromFile(file) {
    if (!file) throw new Error("没有选择文件");
    if (file.size > 1024 * 1024) {
        const err = new Error("图片过大");
        err.code = "TOO_LARGE";
        throw err;
    }
    const result = await squareIcon(file);
    return result;
}

/** 抓取到的 favicon 同走裁切，尺寸与上传一致。 */
export async function iconFromBlob(blob) {
    if (!blob) throw new Error("没有图标数据");
    if (blob.size > 1024 * 1024) throw new Error("图标过大");
    return squareIcon(blob);
}

/** 图标 data URL：有自定义图就用，否则画字母图；按 id 缓存。 */
export async function iconDataUrl(record) {
    if (record.icon && record.icon.data) return record.icon.data;
    const key = `${record.id}:${record.icon?.letter || ""}:${iconColor(record)}`;
    if (cache.has(key)) return cache.get(key);
    const { data } = await makeMonogram(record.icon?.letter || record.name, iconColor(record));
    cache.set(key, data);
    return data;
}

/** 把 data URL 还原成 Blob，写进插件包时用。 */
export function dataUrlToBlob(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(String(dataUrl || ""));
    if (!match) throw new Error("图片数据不对");
    const mime = match[1] || "image/webp";
    const isBase64 = !!match[2];
    const payload = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i += 1) bytes[i] = payload.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

/** 上传后的 record.icon 更新：只保留 data 与字母，颜色沿用底色。 */
export function applyIconData(record, dataUrl) {
    record.icon = {
        data: dataUrl,
        letter: record.icon?.letter || record.name.slice(0, 2).toUpperCase(),
        color: iconColor(record),
    };
    return record;
}

export function clearIconData(record) {
    record.icon = {
        data: "",
        letter: record.name ? record.name.slice(0, 2).toUpperCase() : "?",
        color: iconColor(record),
    };
    return record;
}
