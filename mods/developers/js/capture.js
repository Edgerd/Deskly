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
const MAX_HTML = 500 * 1024;
const MAX_ICON = 512 * 1024;

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

async function fetchIcon(candidates) {
    for (const url of candidates.slice(0, 4)) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
            const res = await fetch(url, { signal: controller.signal, credentials: "omit", cache: "force-cache" });
            clearTimeout(timer);
            if (!res.ok) continue;
            const blob = await res.blob();
            if (!blob.size || blob.size > MAX_ICON) continue;
            if (!/^image\//i.test(blob.type || "")) continue;
            const converted = await iconFromBlob(blob);
            return converted.data;
        } catch (_) {
            /* 换下一个候选 */
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

    const iconCandidates = [];
    doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="shortcut icon"]').forEach((link) => {
        const href = link.getAttribute("href");
        if (href) {
            const abs = absoluteIcon(href, finalUrl);
            if (abs) iconCandidates.push(abs);
        }
    });
    const fallbackIcon = absoluteIcon("/favicon.ico", finalUrl);
    if (fallbackIcon) iconCandidates.push(fallbackIcon);

    const iconData = iconCandidates.length ? await fetchIcon(iconCandidates) : "";
    return {
        ok: true,
        title,
        iconData,
        description,
        reason: iconData ? "" : "no-icon",
        host: hostOf(finalUrl),
    };
}
