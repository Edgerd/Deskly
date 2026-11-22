/**
 * icon.js — 插件图标。
 *
 * 图标最终要写进插件包的 icon.webp，因此这里统一产出 WebP：
 * · 图标是一块圆角底板，底板按系统图标相同的留白内缩，圆角比例与其他应用一致；
 * · 底板内容三选一：纯品牌标 / 纯字母（字母可自定义）/ 品牌标在上、字母在下；
 * · 用户上传图片或抓取到 favicon 时，整块居中，不叠加文字；
 * · 同一 id 的结果缓存起来，列表重绘不反复画布。
 */

/** 图标样式：纯品牌标 / 纯字母 / 品牌标 + 字母。 */
export const ICON_STYLES = ["brand", "letter", "brand-letter"];

const ICON_SIZE = 512;
/** 与系统应用图标一致的可见区域留白：底板占画布 83.3%（启动台按 70/84 归一化）。 */
const ART_PAD = 0.0835;
/** 底板圆角占底板边长的比例，与系统图标同款。 */
const ART_RADIUS = 0.22;

const cache = new Map();

function readAccent() {
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
    } catch (_) { /* 主题未就绪时用默认值 */ }
    return "#2078DA";
}

/** 从 record 决定底色：图标自定义色优先，其次窗口强调色，最后系统强调色。 */
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

/** 底色明暗决定文字颜色：浅底用深字，深底用白字。 */
function inkFor(hex) {
    const value = String(hex || "").replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(value)) return "#ffffff";
    const n = parseInt(value, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    // 相对亮度（sRGB 近似），0.62 是深浅图标的分界经验值
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luma > 0.62 ? "#1d1d1f" : "#ffffff";
}

/* ── 常用网站的品牌标记（16 或 24 坐标系，绘制时等比缩放到图标上半部） ── */
const BRANDS = {
    github: {
        color: "#24292F",
        viewBox: 16,
        path: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z",
    },
    vercel: { color: "#000000", viewBox: 24, path: "M12 2 22.6 20.5H1.4Z" },
    unsplash: { color: "#111111", viewBox: 24, path: "M7.5 6.75V0h9v6.75h-9zm9 3.75H24V24H0V10.5h7.5v6.75h9V10.5z" },
    mdn: { color: "#1B1B1B", text: "MDN" },
    notion: { color: "#111111", text: "N", serif: true },
    linear: { color: "#5E6AD2", lines: true },
    figma: { color: "#A259FF", figma: true },
    dribbble: { color: "#EA4C89", rings: true },
};

/** 品牌图标：名称匹配 BRANDS 时按品牌标记绘制，否则用首字。 */
export function brandOf(name) {
    const key = String(name || "").toLowerCase().replace(/[^a-z]/g, "");
    return BRANDS[key] || null;
}

/**
 * 记录的图标样式：显式设置优先；没设置过时按品牌自动推断
 * （有品牌用纯品牌标，没有就用纯字母）。
 */
export function iconStyle(record) {
    const value = record && record.icon && record.icon.style;
    if (ICON_STYLES.includes(value)) return value;
    return brandOf(record && record.name) ? "brand" : "letter";
}

function drawPlate(ctx, color) {
    const pad = ICON_SIZE * ART_PAD;
    const side = ICON_SIZE - pad * 2;
    const path = new Path2D();
    path.roundRect(pad, pad, side, side, side * ART_RADIUS);
    ctx.fillStyle = color;
    ctx.fill(path);

    const gradient = ctx.createLinearGradient(0, pad, 0, pad + side);
    gradient.addColorStop(0, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(0,0,0,0.08)");
    ctx.fillStyle = gradient;
    ctx.fill(path);
    return { pad, side };
}

function fitFont(ctx, text, maxWidth, size) {
    let px = size;
    ctx.font = `600 ${Math.round(px)}px "SF Pro Display", "PingFang SC", "Helvetica Neue", Arial, sans-serif`;
    while (px > 12 && ctx.measureText(text).width > maxWidth) {
        px -= 2;
        ctx.font = `600 ${Math.round(px)}px "SF Pro Display", "PingFang SC", "Helvetica Neue", Arial, sans-serif`;
    }
    return px;
}

/** 画品牌标记：返回是否已绘制。 */
function drawBrand(ctx, brand, color, box, centerX, centerY) {
    const ink = inkFor(color);
    if (brand.path) {
        const path = new Path2D(brand.path);
        const scale = box / brand.viewBox;
        ctx.save();
        ctx.translate(centerX - box / 2, centerY - box / 2);
        ctx.scale(scale, scale);
        ctx.fillStyle = ink;
        ctx.fill(path);
        ctx.restore();
        return true;
    }
    if (brand.text) {
        ctx.fillStyle = ink;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const family = brand.serif
            ? '"New York", "Times New Roman", serif'
            : '"SF Pro Display", "Helvetica Neue", Arial, sans-serif';
        ctx.font = `700 ${Math.round(box * (brand.text.length > 1 ? 0.42 : 0.78))}px ${family}`;
        ctx.fillText(brand.text, centerX, centerY + box * 0.02);
        return true;
    }
    if (brand.rings) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = Math.max(6, box * 0.075);
        const r = box * 0.38;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.save();
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.lineWidth = Math.max(5, box * 0.06);
        for (let i = 0; i < 3; i += 1) {
            ctx.beginPath();
            ctx.ellipse(centerX + r * (i - 1) * 0.9, centerY, r * 0.7, r * 1.4, 0.5, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
        return true;
    }
    if (brand.figma) {
        // Figma 官方五色标记：按上中下三行排布，尺寸随底板缩放
        const unit = box / 4;
        const cell = (x, y, fill, roundLeft, roundRight) => {
            const p = new Path2D();
            const left = roundLeft ? unit : 0;
            const right = roundRight ? unit : 0;
            p.roundRect(centerX - unit + x, centerY - unit * 1.5 + y, unit * 2, unit, [left, right, right, left]);
            ctx.fillStyle = fill;
            ctx.fill(p);
        };
        cell(0, 0, "#F24E1E", true, false);
        cell(unit, 0, "#FF7262", false, true);
        cell(0, unit, "#A259FF", true, false);
        cell(unit, unit, "#1ABCFE", false, false);
        cell(0, unit * 2, "#0ACF83", true, false);
        return true;
    }
    if (brand.lines) {
        // Linear 的斜切块：一个圆里切掉一条对角带
        ctx.save();
        ctx.beginPath();
        ctx.arc(centerX, centerY, box * 0.42, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = ink;
        ctx.fillRect(centerX - box / 2, centerY - box / 2, box, box);
        ctx.globalCompositeOperation = "destination-out";
        ctx.translate(centerX, centerY);
        ctx.rotate(-Math.PI / 4);
        ctx.fillRect(-box, -box * 0.1, box * 2, box * 0.2);
        ctx.restore();
        return true;
    }
    return false;
}

/** 画字母：按可用宽度收缩字号后居中。 */
function drawLetter(ctx, text, ink, size, maxWidth, centerX, centerY) {
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fitFont(ctx, text, maxWidth, size);
    ctx.fillText(text, centerX, centerY + size * 0.02);
}

/**
 * 合成图标底图（同步，返回 data URL）：圆角底板 + 品牌标 / 字母。
 * @param {object} spec {letter, name, color, brand, image, style}
 *   style: "brand" 纯品牌标 | "letter" 纯字母 | "brand-letter" 品牌标 + 字母
 *   name 只在字母缺省时取首字，不再画进图标。
 * @returns {string}
 */
export function composeIcon({ letter, name, color, brand, image, style } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    const bg = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color || "") ? color : readAccent();
    const { pad, side } = drawPlate(ctx, bg);
    const ink = inkFor(bg);
    const cx = ICON_SIZE / 2;

    // 自定义图片：整块居中，不叠加任何文字
    if (image && image.naturalWidth) {
        const box = side * 0.66;
        const ratio = Math.min(box / image.naturalWidth, box / image.naturalHeight);
        const w = image.naturalWidth * ratio;
        const h = image.naturalHeight * ratio;
        ctx.drawImage(image, cx - w / 2, pad + side / 2 - h / 2, w, h);
        return canvas.toDataURL("image/webp", 0.92);
    }

    const mode = ICON_STYLES.includes(style) ? style : (brand ? "brand" : "letter");
    const text = String(letter || name || "?").trim().slice(0, 2).toUpperCase() || "?";

    if (mode === "brand-letter" && brand) {
        drawBrand(ctx, brand, bg, side * 0.46, cx, pad + side * 0.36);
        drawLetter(ctx, text, ink, side * 0.24, side * 0.5, cx, pad + side * 0.78);
    } else if (mode === "brand" && brand) {
        drawBrand(ctx, brand, bg, side * 0.62, cx, pad + side / 2);
    } else {
        drawLetter(ctx, text, ink, side * 0.6, side * 0.66, cx, pad + side / 2);
    }
    return canvas.toDataURL("image/webp", 0.92);
}

/** 品牌图标 data URL（同步；供推荐列表与新建记录直接用）：纯品牌标，没有品牌则纯字母。 */
export function brandIcon(name, label) {
    const brand = brandOf(name);
    const color = brand ? brand.color : readAccent();
    return composeIcon({
        letter: label || name,
        color,
        brand,
        style: brand ? "brand" : "letter",
    });
}

/** 居中裁切到正方形，按底板同样的留白与圆角裁形，缩放至 512 转 WebP。 */
async function squareIcon(blob) {
    const img = await blobToImage(blob);
    const side = Math.min(img.naturalWidth, img.naturalHeight) || 1;
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // 图片和品牌底板共用同一套几何：内缩 ART_PAD、圆角 ART_RADIUS。
    // 少了这一步，favicon 会顶满画布、四角发方，看起来比系统图标大一圈。
    const pad = ICON_SIZE * ART_PAD;
    const artSide = ICON_SIZE - pad * 2;
    const path = new Path2D();
    path.roundRect(pad, pad, artSide, artSide, artSide * ART_RADIUS);
    ctx.save();
    ctx.clip(path);
    ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        pad,
        pad,
        artSide,
        artSide,
    );
    ctx.restore();
    const out = await canvasToBlob(canvas);
    return { blob: out, data: await blobToDataUrl(out) };
}

/** 画默认的纯字母图标；返回 WebP blob 与 data URL。 */
export async function makeMonogram(letter, color, name) {
    const data = composeIcon({ letter, name, color, style: "letter" });
    const blob = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = ICON_SIZE;
            canvas.height = ICON_SIZE;
            canvas.getContext("2d").drawImage(img, 0, 0);
            canvas.toBlob((out) => resolve(out), "image/webp", 0.92);
        };
        img.src = data;
    });
    return { blob, data };
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

/** 图标 data URL：有自定义图就用，否则按图标样式绘制；按 id 缓存。 */
export async function iconDataUrl(record) {
    if (record.icon && record.icon.data) return record.icon.data;
    const style = iconStyle(record);
    const color = iconColor(record);
    const key = `${record.id}:${record.icon?.letter || ""}:${color}:${record.name || ""}:${style}`;
    if (cache.has(key)) return cache.get(key);
    const data = composeIcon({
        letter: record.icon?.letter || record.name,
        name: record.name,
        color,
        brand: brandOf(record.name),
        style,
    });
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

/** 上传后的 record.icon 更新：保留字母、颜色与样式，只替换图片。 */
export function applyIconData(record, dataUrl) {
    record.icon = {
        data: dataUrl,
        letter: record.icon?.letter || record.name.slice(0, 2).toUpperCase(),
        color: iconColor(record),
        style: record.icon?.style || "",
    };
    return record;
}

/** 去掉图片，回到自动绘制的图标；样式与字母仍沿用。 */
export function clearIconData(record) {
    record.icon = {
        data: "",
        letter: record.icon?.letter || (record.name ? record.name.slice(0, 2).toUpperCase() : "?"),
        color: iconColor(record),
        style: record.icon?.style || "",
    };
    return record;
}
