/** 纯函数工具：URL、站点图标、时间、地址解析。无 DOM 状态。 */

import { HOME, SEARCH_URL } from "./constants.js";

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
));

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const icon = (name) => `<svg class="safari-icon" aria-hidden="true"><use href="#safari-i-${name}"></use></svg>`;

export function isHttpUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

export function originOf(url) {
    try {
        const parsed = new URL(url);
        return isHttpUrl(parsed.href) ? parsed.origin : "";
    } catch {
        return "";
    }
}

export function hostOf(url) {
    if (!url || url === HOME) return "起始页";
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./i, "") || parsed.href;
    } catch {
        return String(url);
    }
}

export function compactUrl(url) {
    if (url === HOME) return "起始页";
    return hostOf(url) || url;
}

export function firstLetter(title) {
    const text = String(title || "").trim();
    if (!text) return "?";
    return Array.from(text)[0].toUpperCase();
}

export function faviconUrl(url) {
    const origin = originOf(url);
    return origin ? `${origin}/favicon.ico` : "";
}

export function searchQueryOfUrl(url) {
    try {
        const parsed = new URL(url);
        if (/(^|\.)bing\.com$/i.test(parsed.hostname) && parsed.pathname === "/search") {
            return parsed.searchParams.get("q") || "";
        }
    } catch { /* 非 URL */ }
    return "";
}

export function hueFor(seed) {
    let hash = 0;
    const text = String(seed || "");
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
}

export function gradientFor(url) {
    const hue = hueFor(hostOf(url));
    return `linear-gradient(140deg, hsl(${hue} 42% 48%), hsl(${(hue + 34) % 360} 46% 30%))`;
}

export function dayLabel(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const diff = Math.round((startOf(now) - startOf(date)) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function timeLabel(timestamp) {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 站点图标：有 /favicon.ico 就显示图片，失败或没有时退到首字母 / 地球。
 * 图片错误统一由 window 捕获阶段监听处理（MV3 CSP 禁止内联 onerror）。
 */
export function faviconMarkup(url, title, containerClass, { globe = false } = {}) {
    const src = faviconUrl(url);
    const fallback = globe
        ? `<span class="safari-icon-fallback" hidden>${icon("globe")}</span>`
        : `<span class="safari-fav-letter" ${src ? "hidden" : ""}>${escapeHtml(firstLetter(title || hostOf(url)))}</span>`;
    return `<span class="${containerClass}">` +
        `<img ${src ? `src="${escapeHtml(src)}"` : "hidden"} alt="" loading="lazy" referrerpolicy="no-referrer">` +
        fallback +
        "</span>";
}

export function resolveInput(raw) {
    const input = String(raw || "").trim();
    if (!input) return null;
    if (input === HOME) return { url: HOME, kind: "home" };
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
        if (!/^https?:/i.test(input)) return { error: "不支持此协议" };
        try {
            const parsed = new URL(input);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "不支持此协议" };
            return { url: parsed.href, kind: "url" };
        } catch {
            return { error: "网址格式不正确" };
        }
    }
    if (looksLikeHost(input)) {
        const lower = input.toLowerCase();
        const scheme = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(lower) ? "http://" : "https://";
        try {
            const parsed = new URL(scheme + input);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "不支持此协议" };
            return { url: parsed.href, kind: "url" };
        } catch {
            return { error: "网址格式不正确" };
        }
    }
    return { url: SEARCH_URL + encodeURIComponent(input), kind: "search", query: input };
}

function looksLikeHost(input) {
    if (/\s/.test(input)) return false;
    if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/.*)?$/i.test(input)) return true;
    const authority = input.split("[/?#]")[0];
    const host = authority.split(":")[0];
    return host.includes(".") &&
        /^[a-z0-9.-]+$/i.test(host) &&
        !host.startsWith(".") &&
        !host.endsWith(".") &&
        !host.includes("..");
}
