/**
 * capture.js — 读取站点标题、图标与描述。
 *
 * 跨域读取需要站点级 host 权限：清单里声明了 optional_host_permissions，
 * 这里只在用户点击「读取站点信息」时按 origin 申请一次，拒绝就退回域名，
 * 不把「读取失败」伪装成成功。图标拉不下来时同样由 icon.js 画字母图兜底。
 */

import { iconFromBlob } from "./icon.js";
import { hostOf, normalizeUrl, titleFromUrl } from "./spec.js";

const FETCH_TIMEOUT = 8000;
const ICON_TIMEOUT = 5000;
const MAX_HTML = 500 * 1024;
const MAX_ICON = 512 * 1024;
const MAX_ICON_TRIES = 8;
// 单个候选 5s、最多 8 个，串行最坏 40s 太久；总预算到点就带着已试结果收手。
const ICON_BUDGET = 12000;

function permissionsApi() {
    const api = globalThis.chrome;
    return api && api.permissions ? api.permissions : null;
}

function originPattern(url) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
}

/** 该 origin 是否已经拿到权限；没有 chrome.permissions 时返回 false。 */
export async function hasSiteAccess(url) {
    const api = permissionsApi();
    if (!api) return false;
    try {
        return await api.contains({ origins: [originPattern(url)] });
    } catch (_) {
        return false;
    }
}

/**
 * 申请站点权限。必须由点击事件同步触发；返回 'granted' | 'denied' | 'unsupported'。
 */
export async function requestSiteAccess(url) {
    const api = permissionsApi();
    if (!api) return "unsupported";
    // 直接 request：先 await contains() 会丢掉点击手势，部分浏览器随后拒绝弹权限框。
    // 已授权时 request 会立即返回 true，重复调用没有副作用。
    try {
        const granted = await api.request({ origins: [originPattern(url)] });
        return granted ? "granted" : "denied";
    } catch (_) {
        return "denied";
    }
}

function absoluteIcon(href, base) {
    try {
        return new URL(href, base).toString();
    } catch (_) {
        return "";
    }
}

/** 前 24 字节的图片魔数；部分站点 favicon 的 content-type 不可信（octet-stream / text/plain）。 */
function isImageMagic(bytes) {
    const at = (i) => bytes[i] || 0;
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return true; // PNG
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return true; // JPEG
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return true; // GIF
    if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x01 && at(3) === 0x00) return true; // ICO
    if (at(0) === 0x42 && at(1) === 0x4d) return true; // BMP
    if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
        && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return true; // WEBP
    return false;
}

/** 判断响应是不是图片：先看声明，再看魔数，最后按 SVG 文本兜底。 */
async function looksLikeImage(blob) {
    if (/^image\//i.test(blob.type || "")) return true;
    const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    if (isImageMagic(head)) return true;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(await blob.slice(0, 512).arrayBuffer());
    return /<svg[\s>]/i.test(text);
}

/**
 * 候选图标打分：优先大尺寸与 apple-touch-icon，避开 16px 小图和单色 mask-icon。
 * @param {Element} link
 * @param {string} href 已解析成绝对地址
 */
function scoreIcon(link, href) {
    const rel = (link.getAttribute("rel") || "").toLowerCase();
    const type = (link.getAttribute("type") || "").toLowerCase();
    const sizes = link.getAttribute("sizes") || "";
    let score = 20;
    if (rel.includes("apple-touch-icon")) score += 50;
    if (rel.includes("mask-icon")) score -= 40;
    const size = /(\d+)\s*x\s*(\d+)/i.exec(sizes);
    if (size) {
        const px = Math.max(Number(size[1]), Number(size[2]));
        if (px >= 180) score += 40;
        else if (px >= 64) score += 26;
        else if (px >= 32) score += 12;
        else if (px <= 16) score -= 6;
    }
    if (type.includes("svg") || /\.svg(?:$|[?#])/i.test(href)) score -= 8;
    if (type.includes("png") || /\.png(?:$|[?#])/i.test(href)) score += 8;
    return score;
}

async function fetchIcon(candidates) {
    const deadline = Date.now() + ICON_BUDGET;
    for (const url of candidates.slice(0, MAX_ICON_TRIES)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(ICON_TIMEOUT, left));
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                credentials: "omit",
                cache: "default",
                referrerPolicy: "no-referrer",
            });
            if (!res.ok) continue;
            const blob = await res.blob();
            if (!blob.size || blob.size > MAX_ICON) continue;
            if (!(await looksLikeImage(blob))) continue;
            const converted = await iconFromBlob(blob);
            if (converted && converted.data) return converted.data;
        } catch (_) {
            /* 换下一个候选 */
        } finally {
            clearTimeout(timer);
        }
    }
    return "";
}

/**
 * 读取站点元信息。调用方先申请权限，这里只负责抓取与解析。
 * @returns {Promise<{ok:boolean, title:string, iconData:string, description:string, reason:string}>}
 */
export async function captureSite(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return { ok: false, title: "", iconData: "", description: "", reason: "url" };
    const fallbackTitle = titleFromUrl(url);

    let request;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        request = await fetch(url, {
            signal: controller.signal,
            credentials: "omit",
            redirect: "follow",
            headers: { Accept: "text/html,application/xhtml+xml" },
        });
        clearTimeout(timer);
    } catch (_) {
        return { ok: false, title: fallbackTitle, iconData: "", description: "", reason: "fetch" };
    }

    if (!request.ok) {
        return { ok: false, title: fallbackTitle, iconData: "", description: "", reason: `http-${request.status}` };
    }
    const type = request.headers.get("content-type") || "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) {
        return { ok: false, title: fallbackTitle, iconData: "", description: "", reason: "not-html" };
    }

    let html = "";
    try {
        const buffer = await request.arrayBuffer();
        html = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, MAX_HTML));
    } catch (_) {
        return { ok: false, title: fallbackTitle, iconData: "", description: "", reason: "read" };
    }

    let doc;
    try {
        doc = new DOMParser().parseFromString(html, "text/html");
    } catch (_) {
        return { ok: false, title: fallbackTitle, iconData: "", description: "", reason: "parse" };
    }

    const finalUrl = request.url || url;
    const pick = (selector) => doc.querySelector(selector);
    const meta = (name) =>
        pick(`meta[property="${name}"]`)?.getAttribute("content") ||
        pick(`meta[name="${name}"]`)?.getAttribute("content") ||
        "";

    const title = String(
        meta("og:title") || pick("title")?.textContent || meta("twitter:title") || "",
    ).trim().slice(0, 80) || fallbackTitle;
    const description = String(
        meta("og:description") || meta("description") || "",
    ).trim().slice(0, 160);

    // 相对 href 以文档 <base href> 为基准（不少站点用 /static/ 之类的公共前缀），
    // 没有 <base> 时退回最终 URL，与浏览器解析规则保持一致。
    const baseHref = doc.querySelector("base[href]")?.getAttribute("href") || "";
    const iconBase = (baseHref && absoluteIcon(baseHref, finalUrl)) || finalUrl;

    const iconCandidates = [];
    const seenIcons = new Set();
    const pushIcon = (abs, score) => {
        if (!abs || seenIcons.has(abs)) return;
        seenIcons.add(abs);
        iconCandidates.push({ url: abs, score });
    };

    doc.querySelectorAll("link[rel]").forEach((link) => {
        const rel = (link.getAttribute("rel") || "").toLowerCase();
        if (!rel.includes("icon")) return;
        const href = link.getAttribute("href");
        if (!href) return;
        const abs = absoluteIcon(href, iconBase);
        pushIcon(abs, scoreIcon(link, abs));
    });

    // 声明缺失或全部失效时的常见落点。分数低于任何显式声明，
    // 但高于 16px 小图标，保证「有声明就先信声明」。
    [
        ["/apple-touch-icon.png", 16],
        ["/apple-touch-icon-precomposed.png", 16],
        ["/favicon.png", 14],
        ["/favicon.ico", 10],
    ].forEach(([path, score]) => pushIcon(absoluteIcon(path, finalUrl), score));

    iconCandidates.sort((a, b) => b.score - a.score);
    const iconData = iconCandidates.length
        ? await fetchIcon(iconCandidates.map((item) => item.url))
        : "";
    return {
        ok: true,
        title,
        iconData,
        description,
        reason: iconData ? "" : "no-icon",
        host: hostOf(finalUrl),
    };
}
