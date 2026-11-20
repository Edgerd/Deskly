/**
 * templates.js — 把一条记录编译成系统插件：清单、窗口壳、页面壳与包内文件。
 *
 * 两类插件都套同一层系统窗口：红绿灯、标题栏、圆角与阴影来自 .window，
 * 尺寸/拖动/缩放只写在根元素的 data-window 上（内核文档里唯一的声明处），
 * 窗口颜色因为系统窗口 API 没有该字段，落到自有 CSS 变量 --devp-accent。
 */

import { hostOf } from "./spec.js";

const TRAFFIC = `<deskly-traffic-lights class="wintools"></deskly-traffic-lights>`;
/** 生成脚本里 import 的 i18n 说明符。由占位符注入而不是写成字面量：
 *  这里是模板文本，dev/static-check.mjs 会把模板里的 import 当成真实语句解析，
 *  按本文件所在目录（mods/developers/js/）解析必然失败。占位符里的 `$` 会跳过该检查。 */
const I18N_SPEC = "../../src/javascripts/i18n.js";
const ICON_RELOAD = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.1 6.2A5.4 5.4 0 1 0 13.3 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.4 2.6v3.8H9.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_OPEN = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9.2 3.1h3.7v3.7M12.7 3.3 7.6 8.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.6 9.4v2.5a1.2 1.2 0 0 1-1.2 1.2H4.1a1.2 1.2 0 0 1-1.2-1.2V5.6a1.2 1.2 0 0 1 1.2-1.2h2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

function esc(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function jsonFor(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** data-window：尺寸、最小尺寸、拖动、缩放、标题栏都交给系统解析。 */
export function windowAttr(record) {
    const w = record.window;
    const parts = [`size:${w.width}x${w.height}`, `min:${w.minWidth}x${w.minHeight}`, "centered"];
    if (w.resizable) parts.push("resizable");
    if (w.draggable) parts.push("draggable");
    if (!w.titlebar) parts.push("titlebar:hidden");
    return parts.join(" ");
}

function accentBlock(record) {
    const accent = record.window.accent;
    if (!/^#[0-9a-f]{6}$/i.test(accent || "")) {
        return `:root { --devp-accent: transparent; }\n`;
    }
    return `:root { --devp-accent: ${accent}; }\n`;
}

function shellCss(record) {
    return `/* 由「开发者」生成：窗口外壳。accent 只作用于标题栏，几何属性全部来自 data-window。 */
${accentBlock(record)}
.devp {
    --devp-bar: #f2f2f4;
    --devp-line: rgba(0, 0, 0, 0.1);
    --devp-text: #1d1d1f;
    --devp-text-2: rgba(29, 29, 31, 0.58);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 100%;
    background: #fff;
    color: var(--devp-text);
    font-family: "SFPro-Regular", "PingFangSC-Regular", -apple-system, sans-serif;
    font-size: 12.5px;
    overflow: hidden;
}
html[data-theme="dark"] .devp {
    --devp-bar: #2c2c2e;
    --devp-line: rgba(255, 255, 255, 0.12);
    --devp-text: #f2f2f4;
    --devp-text-2: rgba(242, 242, 244, 0.6);
    background: #1e1e1e;
}
.devp-bar {
    flex: 0 0 auto;
    height: 42px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px 0 var(--traffic-inset, 20px);
    background: var(--devp-bar);
    border-bottom: 1px solid var(--devp-line);
    position: relative;
    -webkit-user-select: none;
    user-select: none;
}
.devp-bar::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: var(--devp-accent);
    opacity: 0.75;
}
.devp-id {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-left: 4px;
}
.devp-id img {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    flex: 0 0 auto;
}
.devp-id__text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
}
.devp-id__name {
    font-family: "SFPro-Medium", "PingFangSC-Medium", sans-serif;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.devp-id__host {
    font-size: 10px;
    color: var(--devp-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.devp-tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
}
.devp-tools button {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: var(--devp-text-2);
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
}
.devp-tools button:hover {
    background: rgba(0, 0, 0, 0.06);
    color: var(--devp-text);
}
html[data-theme="dark"] .devp-tools button:hover { background: rgba(255, 255, 255, 0.1); }
.devp-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background: #fff;
}
.devp-status {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11.5px;
    color: var(--devp-text-2);
    background: inherit;
}
.devp-frame {
    position: relative;
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
}
.devp-page {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}
`;
}

const WINDOW_MESSAGES = {
    reload: {
        "zh-CN": "重新载入",
        en: "Reload",
        "ja-JP": "再読み込み",
        cat: "Torna a carregar",
    },
    openBrowser: {
        "zh-CN": "在浏览器打开",
        en: "Open in browser",
        "ja-JP": "ブラウザで開く",
        cat: "Obre al navegador",
    },
    loading: {
        "zh-CN": "正在载入",
        en: "Loading",
        "ja-JP": "読み込み中",
        cat: "S'està carregant",
    },
};

function messagesObject() {
    const out = {};
    for (const lang of ["zh-CN", "en", "ja-JP", "cat"]) {
        out[lang] = {
            devplugin: {
                reload: WINDOW_MESSAGES.reload[lang],
                openBrowser: WINDOW_MESSAGES.openBrowser[lang],
                loading: WINDOW_MESSAGES.loading[lang],
            },
        };
    }
    return out;
}

function windowHtml(record) {
    return `<!-- 由「开发者」生成：${esc(record.name)} -->
<div class="devp window" data-window="${esc(windowAttr(record))}">
    <header class="devp-bar" data-titlebar>
        ${TRAFFIC}
        <div class="devp-id">
            <img src="icon.webp" alt="" width="18" height="18" draggable="false">
            <div class="devp-id__text">
                <span class="devp-id__name">${esc(record.name)}</span>
                <span class="devp-id__host">${esc(hostOf(record.url))}</span>
            </div>
        </div>
        <div class="devp-tools">
            <button type="button" data-devp="reload" title="Reload" aria-label="Reload">${ICON_RELOAD}</button>
            <button type="button" data-devp="open" title="Open in browser" aria-label="Open in browser">${ICON_OPEN}</button>
        </div>
    </header>
    <div class="devp-body">
        <div class="devp-status" data-devp="loading"></div>
        <iframe class="devp-frame" src="${esc(record.url)}" title="${esc(record.name)}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals" referrerpolicy="no-referrer"></iframe>
    </div>
</div>
`;
}

function windowScript(record) {
    return `/* 由「开发者」生成：${record.name} 的窗口外壳交互。 */
import { i18n } from "${I18N_SPEC}";

try {
    i18n.registerMessagesAll(${jsonFor(messagesObject())});
} catch (err) {
    console.warn("[dev-plugin] register messages failed", err);
}

const t = (key, fallback) => i18n.t(key, fallback);
const URL_VALUE = ${jsonFor(record.url)};
const root = document.querySelector(".devp");
const frame = root ? root.querySelector(".devp-frame") : null;
const status = root ? root.querySelector('[data-devp="loading"]') : null;

if (status) status.textContent = t("devplugin.loading", "Loading");

if (root) {
    const reload = root.querySelector('[data-devp="reload"]');
    const open = root.querySelector('[data-devp="open"]');
    if (reload) {
        reload.title = t("devplugin.reload", "Reload");
        reload.setAttribute("aria-label", reload.title);
        reload.addEventListener("click", () => {
            if (!frame) return;
            if (status) {
                status.hidden = false;
                status.textContent = t("devplugin.loading", "Loading");
            }
            frame.src = frame.src;
        });
    }
    if (open) {
        open.title = t("devplugin.openBrowser", "Open in browser");
        open.setAttribute("aria-label", open.title);
        open.addEventListener("click", () => window.open(URL_VALUE, "_blank", "noopener,noreferrer"));
    }
}

if (frame && status) {
    frame.addEventListener("load", () => { status.hidden = true; });
}
`;
}

function pageHtml(record) {
    return `<!-- 由「开发者」生成：${esc(record.name)} -->
<div class="devp devp--page window" data-window="${esc(windowAttr(record))}">
    <header class="devp-bar" data-titlebar>
        ${TRAFFIC}
        <div class="devp-id">
            <img src="icon.webp" alt="" width="18" height="18" draggable="false">
            <div class="devp-id__text">
                <span class="devp-id__name">${esc(record.name)}</span>
                <span class="devp-id__host">${esc(record.description || "page")}</span>
            </div>
        </div>
    </header>
    <main class="devp-page">${record.page.html}</main>
</div>
`;
}

function pageCss(record) {
    return `${shellCss(record)}
/* 页面作者样式：直接追加，选择器不受限制；需要限定作用域时以 .devp-page 开头。 */
.devp-page {
    padding: 24px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--devp-text);
    background: #fff;
}
html[data-theme="dark"] .devp-page { background: #1e1e1e; }

${record.page.css}
`;
}

function pageScript(record) {
    const userCode = record.page.js || "";
    return `/* 由「开发者」生成：${record.name} 的页面脚本。 */
${userCode}
`;
}

/** 生成系统插件清单；id/name 是身份，其余都是展示与窗口声明。 */
export function buildManifest(record) {
    const updated = new Date().toISOString().slice(0, 10);
    const summary = record.description || "";
    return {
        id: record.id,
        name: record.name,
        version: "1.0.0",
        type: "app",
        entry: "window",
        author: "开发者",
        description: summary || `${record.name}`,
        permissions: [],
        main: "index.html",
        style: "style.css",
        script: "script.js",
        icon: "icon.webp",
        visibility: { launchpad: true, settings: true, finder: true, uninstallable: true },
        store: {
            category: "开发者",
            tagline: summary || `${record.name}`,
            summary: summary || `${record.name}`,
            updated,
            author: "开发者",
            screenshots: [],
        },
    };
}

/**
 * 编译成包内文件表（文件名 → Blob），交给 store-api.installZip 统一安装、校验、回滚。
 * @param {object} record 已归一化的记录
 * @param {Blob} iconBlob 由 icon.js 产出的 WebP
 */
export function buildFiles(record, iconBlob) {
    const isPage = record.kind === "page";
    const indexHtml = isPage ? pageHtml(record) : windowHtml(record);
    const styleCss = isPage ? pageCss(record) : shellCss(record);
    const scriptJs = isPage ? pageScript(record) : windowScript(record);
    const manifest = buildManifest(record);
    return {
        "manifest.json": new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
        "index.html": new Blob([indexHtml], { type: "text/html" }),
        "style.css": new Blob([styleCss], { type: "text/css" }),
        "script.js": new Blob([scriptJs], { type: "text/javascript" }),
        "icon.webp": iconBlob,
    };
}

/** 编辑器的静态预览：只渲染 HTML/CSS，脚本不跑（CSP 也不允许内联脚本）。 */
export function buildPreviewDocument(record) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html, body { margin: 0; padding: 0; background: #fff; color: #1d1d1f; font-family: -apple-system, "SF Pro Text", "PingFang SC", sans-serif; }
body { padding: 18px; font-size: 14px; line-height: 1.6; }
${record.page.css}
</style>
</head>
<body>
${record.page.html}
</body>
</html>`;
}

/** 新建时的空白模板，避免编辑器一打开就是空的。 */
export const PAGE_TEMPLATES = {
    blank: {
        html: `<section class="card">
  <h1>新页面</h1>
  <p>在左侧切换 HTML、CSS、JavaScript，把这里换成你想要的内容。</p>
</section>`,
        css: `.card {
  max-width: 560px;
  padding: 28px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 10px;
}

h1 { margin: 0 0 8px; font-size: 22px; }
p { margin: 0; color: rgba(0, 0, 0, 0.6); }`,
        js: "",
    },
    card: {
        html: `<a class="linkcard" href="https://example.com" target="_blank" rel="noopener">
  <span class="linkcard__mark">D</span>
  <span class="linkcard__text">
    <strong>示例链接</strong>
    <small>把 href 换成你的地址</small>
  </span>
</a>`,
        css: `.linkcard {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 420px;
  padding: 16px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 10px;
  text-decoration: none;
  color: inherit;
}
.linkcard:hover { border-color: #2078da; }
.linkcard__mark {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: #2078da;
  color: #fff;
  font-weight: 600;
}
.linkcard__text { display: flex; flex-direction: column; gap: 2px; }
.linkcard__text strong { font-size: 14px; font-weight: 600; }
.linkcard__text small { font-size: 12px; color: rgba(0, 0, 0, 0.55); }`,
        js: "",
    },
    board: {
        html: `<section class="board">
  <h2>今天要做的事</h2>
  <ul>
    <li>写下第一条</li>
    <li>写下第二条</li>
  </ul>
  <p class="board__foot">静态模板，可以直接改。</p>
</section>`,
        css: `.board {
  max-width: 520px;
  padding: 24px 26px;
  border-radius: 10px;
  background: #f5f5f7;
}
.board h2 { margin: 0 0 12px; font-size: 17px; }
.board ul { margin: 0; padding-left: 20px; }
.board li { margin: 6px 0; }
.board__foot { margin: 14px 0 0; font-size: 12px; color: rgba(0, 0, 0, 0.5); }`,
        js: "",
    },
};
