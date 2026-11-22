/**
 * spec.js — 插件规格：URL 规整、AI 规格校验、分享包与插件清单。
 *
 * 一份记录（record）既是编辑器里的源码，也是分享包的载荷；安装时再由
 * recordToManifest / recordToFiles 转成系统插件。校验只在这里做，导入、粘贴、
 * 表单提交都走同一条 normalizeSpec，避免三套规则互相放水。
 */

import { makeId, normalizeRecord } from "./library.js";

export const SPEC_SCHEMA = "deskly.developer-plugin-spec/1";
export const PACKAGE_FORMAT = "deskly.developer-plugin";
export const PACKAGE_VERSION = 1;
export const CODE_PREFIX = "devp1:";

const MAX_TEXT = 262144;
const KIND_VALUES = new Set(["shortcut", "window", "page"]);

/** 规格文本，界面里要展示给外部 AI，和校验逻辑保持一致。 */
export const SPEC_EXAMPLE = {
    schema: SPEC_SCHEMA,
    id: "dev-example-9f2c",
    name: "示例",
    kind: "window",
    url: "https://example.com",
    description: "一句话说明这个插件做什么",
    window: {
        width: 1024,
        height: 680,
        minWidth: 480,
        minHeight: 360,
        resizable: true,
        draggable: true,
        titlebar: true,
        accent: "#2078DA",
    },
    page: { html: "", css: "", js: "" },
    icon: { letter: "示", color: "#2078DA", data: "" },
};

/**
 * 给外部 AI 的 JSON Schema（draft-07）。字段与 normalizeSpec 一一对应，
 * 粘贴回来的内容仍会走同一套校验，不因为「AI 生成」就放宽。
 */
export const SPEC_SCHEMA_DOC = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Deskly developer plugin spec",
    description: "A plugin definition accepted by the Developers app.",
    type: "object",
    required: ["schema", "name", "kind"],
    additionalProperties: false,
    properties: {
        schema: { const: SPEC_SCHEMA },
        id: { type: "string", pattern: "^dev-[a-z0-9][a-z0-9-]{1,60}$" },
        name: { type: "string", maxLength: 80 },
        kind: {
            type: "string",
            enum: ["shortcut", "window", "page"],
            description: "shortcut opens in the host browser; window wraps the URL in a system window; page runs user HTML/CSS/JS.",
        },
        url: { type: "string", description: "Required for shortcut and window. http or https." },
        description: { type: "string", maxLength: 280 },
        window: {
            type: "object",
            additionalProperties: false,
            properties: {
                width: { type: "integer", minimum: 320, maximum: 2400, default: 1024 },
                height: { type: "integer", minimum: 240, maximum: 1600, default: 680 },
                minWidth: { type: "integer", minimum: 280, maximum: 2400, default: 480 },
                minHeight: { type: "integer", minimum: 200, maximum: 1600, default: 360 },
                resizable: { type: "boolean", default: true },
                draggable: { type: "boolean", default: true },
                titlebar: { type: "boolean", default: true },
                accent: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            },
        },
        page: {
            type: "object",
            additionalProperties: false,
            properties: {
                html: { type: "string", maxLength: MAX_TEXT },
                css: { type: "string", maxLength: MAX_TEXT },
                js: { type: "string", maxLength: MAX_TEXT },
            },
            description: "Required for kind=page. Scripts run inside the installed plugin window.",
        },
        icon: {
            type: "object",
            additionalProperties: false,
            properties: {
                letter: { type: "string", maxLength: 2 },
                color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
                style: {
                    type: "string",
                    enum: ["brand", "letter", "brand-letter"],
                    description: "brand: logo only; letter: letters only; brand-letter: logo above letters.",
                },
                data: { type: "string", description: "Optional data:image/... URL. Omit to use the letter icon." },
            },
        },
    },
};

/** 把用户输入补成 URL；只放行 http/https。失败返回 null。 */
export function normalizeUrl(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (!url.hostname || url.hostname === "localhost") {
            if (!url.hostname) return null;
        }
        return url.toString();
    } catch (_) {
        return null;
    }
}

export function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch (_) {
        return "";
    }
}

export function titleFromUrl(url) {
    const host = hostOf(url);
    if (!host) return "";
    const first = host.split(".")[0] || host;
    return first.charAt(0).toUpperCase() + first.slice(1);
}

function clip(value, max = 280) {
    return String(value == null ? "" : value).slice(0, max);
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 校验并归一化一条规格。
 * @returns {{ok:true, record:object} | {ok:false, error:{code:string, detail?:string}}}
 */
export function normalizeSpec(raw, { id } = {}) {
    if (!raw || typeof raw !== "object") return { ok: false, error: { code: "FORMAT" } };
    const kind = KIND_VALUES.has(raw.kind) ? raw.kind : "shortcut";
    const url = normalizeUrl(raw.url);
    const name = clip(raw.name || titleFromUrl(url), 80).trim();
    if (!name) return { ok: false, error: { code: "NAME" } };
    if (kind !== "page" && !url) return { ok: false, error: { code: "URL" } };

    const page = raw.page && typeof raw.page === "object" ? raw.page : {};
    const html = typeof page.html === "string" ? page.html.slice(0, MAX_TEXT) : "";
    const css = typeof page.css === "string" ? page.css.slice(0, MAX_TEXT) : "";
    const js = typeof page.js === "string" ? page.js.slice(0, MAX_TEXT) : "";
    if (kind === "page" && !html.trim() && !css.trim() && !js.trim()) {
        return { ok: false, error: { code: "PAGE" } };
    }

    const win = raw.window && typeof raw.window === "object" ? raw.window : {};
    const width = clamp(win.width, 320, 2400, 1024);
    const height = clamp(win.height, 240, 1600, 680);
    const record = normalizeRecord({
        id: id || (typeof raw.id === "string" && raw.id ? raw.id : makeId(name, url || name)),
        name,
        kind,
        url: url || "",
        description: clip(raw.description, 280),
        window: {
            width,
            height,
            minWidth: clamp(win.minWidth, 280, width, Math.min(480, width)),
            minHeight: clamp(win.minHeight, 200, height, Math.min(360, height)),
            resizable: win.resizable !== false,
            draggable: win.draggable !== false,
            titlebar: win.titlebar !== false,
            accent: /^#[0-9a-f]{6}$/i.test(win.accent || "") ? win.accent : "",
        },
        page: { html, css, js },
        icon: raw.icon || { letter: name.slice(0, 2), color: win.accent || "" },
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    });
    if (!record) return { ok: false, error: { code: "FORMAT" } };
    return { ok: true, record };
}

/** 分享包载荷。图标内联成 data URL，单文件就能带走。 */
export function buildPackage(record) {
    return {
        format: PACKAGE_FORMAT,
        formatVersion: PACKAGE_VERSION,
        exportedAt: new Date().toISOString(),
        plugin: {
            id: record.id,
            name: record.name,
            kind: record.kind,
            url: record.url,
            description: record.description,
            window: record.window,
            page: record.page,
            icon: record.icon,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        },
    };
}

function decodeCode(text) {
    const body = text.slice(CODE_PREFIX.length).replace(/\s+/g, "");
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

/**
 * 解析导入文本：分享包 JSON、裸规格 JSON、或 devp1:base64。
 * @returns {{ok:true, specs:object[]} | {ok:false, error:{code:string, detail?:string}}}
 */
export function parseImportText(text) {
    const source = String(text || "").trim();
    if (!source) return { ok: false, error: { code: "FORMAT" } };
    let payload;
    try {
        const json = source.startsWith(CODE_PREFIX) ? decodeCode(source) : source;
        payload = JSON.parse(json);
    } catch (err) {
        return { ok: false, error: { code: "FORMAT", detail: err.message } };
    }
    if (payload && payload.format === PACKAGE_FORMAT) {
        const list = Array.isArray(payload.plugins) ? payload.plugins : [payload.plugin];
        return { ok: true, specs: list.filter(Boolean) };
    }
    if (payload && Array.isArray(payload.plugins)) return { ok: true, specs: payload.plugins };
    return { ok: true, specs: [payload] };
}

/** 导出成临时下载文件。文件名只保留 ASCII，避免不同系统解压出乱码。 */
export function exportFilename(record) {
    const ascii = String(record.name || "plugin")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "plugin";
    return `${ascii}.devplugin.json`;
}

/** 下载任意文本为文件。 */
export function downloadText(filename, text, mime = "application/json") {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}
