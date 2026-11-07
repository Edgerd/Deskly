/**
 * core/quicklook.js — Quick Look 全局单例（第 3 期，Q5 决策）。
 *
 * - 全局只有一个预览窗，后开者接管（open 直接换内容，不开第二个）；
 * - 作为独立系统应用注册：启动台不可见、系统设置可见（app-registry 可见性 API）；
 * - 预览能力由 provider 提供：内建图片/文本/PDF/音频/视频/文件夹，
 *   其余类型（docx/xlsx/pptx 等）由插件经 registerProvider 注册；
 *   未知类型回退「图标 + 元数据」（等同 macOS 的无可用预览）。
 *
 * 键盘（对齐 macOS）：空格/Esc 关闭，←/→ 上/下一项，⌘/Ctrl + 加号/减号 缩放。
 * ⌘Return 索引表在第 5 期接上（toggleIndexSheet 已留位）。
 *
 * provider 契约（将来写进 devdocs/api/quicklook.html）：
 *   registerProvider({
 *     id: 'office',
 *     match: (stat) => 20,          // 0=不适用；数值大者胜出（内建 10，文件夹 5）
 *     render: async (container, stat, ctx) => cleanupFn|void,
 *   }) → unregister()
 *   stat: { path, name, type, size, modified, ext }
 *   ctx:  { readFile(): Promise<File>, signal: AbortSignal,
 *           zoom: { factor, set(f), reset() } }
 *   render 抛错或超 5 秒 → 自动回退通用预览并在角落标注来源。
 */

import { FS } from "../fs/index.js";
import { registerPlugin } from "../app-registry.js";
import { i18n } from "../i18n.js";
import { FOLDER_ICON, GENERIC_DOC_ICON } from "../paths.js";

/* 系统应用登记：只做可见性声明，没有窗口入口（openApp 到它会安全落空）。 */
registerPlugin({
    id: "quicklook",
    name: "快速查看",
    visibility: { launchpad: false, settings: true, finder: false, system: true, uninstallable: false },
});

const t = (key, fallback) => i18n.t(key, fallback);
const PROVIDER_TIMEOUT = 5000;

/* ── provider 注册表 ── */

const providers = new Map();

function registerProvider(provider) {
    if (!provider || !provider.id) throw new Error("provider 必须有 id");
    if (typeof provider.match !== "function" || typeof provider.render !== "function") {
        throw new Error("provider 必须有 match 与 render 函数");
    }
    providers.set(provider.id, provider);
    return () => providers.delete(provider.id);
}

function pickProvider(stat) {
    let best = null;
    let bestScore = 0;
    for (const p of providers.values()) {
        let score = 0;
        try { score = Number(p.match(stat)) || 0; }
        catch (err) { console.warn(`[quicklook] ${p.id}.match 抛错，按不适用计：`, err); continue; }
        if (score > bestScore) { best = p; bestScore = score; }
    }
    return best;
}

/* ── 内建 provider ── */

const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const TEXT_EXTS = new Set(["txt", "md", "json", "js", "mjs", "css", "html", "htm", "csv", "tsv", "log", "xml", "yml", "yaml", "ini", "conf", "sh", "py", "java", "c", "cpp", "h", "rs", "ts"]);

function extOf(name) { return (String(name).match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || ""; }
const isImg = (stat) => stat.type !== "folder" && IMG_EXTS.has(stat.ext);
const isText = (stat) => stat.type !== "folder" && TEXT_EXTS.has(stat.ext);

async function renderImage(container, stat, ctx) {
    const file = await ctx.readFile();
    const url = URL.createObjectURL(file);
    const img = document.createElement("img");
    img.className = "ql-media";
    img.alt = stat.name;
    img.src = url;
    container.appendChild(img);
    return () => URL.revokeObjectURL(url);
}

async function renderText(container, stat, ctx) {
    const file = await ctx.readFile();
    const text = await file.text();
    const pre = document.createElement("pre");
    pre.className = "ql-text";
    // 超长截断：预览不是编辑器，200KB 之后的部分提示省略
    pre.textContent = text.length > 200 * 1024 ? `${text.slice(0, 200 * 1024)}\n…` : text;
    container.appendChild(pre);
}

async function renderPdf(container, stat, ctx) {
    const file = await ctx.readFile();
    const url = URL.createObjectURL(file);
    const frame = document.createElement("iframe");
    frame.className = "ql-frame";
    frame.src = url;
    container.appendChild(frame);
    return () => URL.revokeObjectURL(url);
}

function renderMedia(tag) {
    return async (container, stat, ctx) => {
        const file = await ctx.readFile();
        const url = URL.createObjectURL(file);
        const media = document.createElement(tag);
        media.className = tag === "video" ? "ql-media" : "ql-audio";
        media.controls = true;
        media.src = url;
        container.appendChild(media);
        return () => { media.pause(); URL.revokeObjectURL(url); };
    };
}

async function renderFolder(container, stat) {
    const wrap = document.createElement("div");
    wrap.className = "ql-folder";
    const icon = document.createElement("img");
    icon.src = FOLDER_ICON;
    const name = document.createElement("p");
    name.className = "ql-folder-name";
    name.textContent = stat.name;
    const meta = document.createElement("p");
    meta.className = "ql-folder-meta";
    let count = 0;
    let bytes = 0;
    try {
        const files = await FS.walk(3, stat.path);
        count = files.length;
        bytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    } catch (err) { /* 计数失败就只显示名称 */ }
    meta.textContent = count
        ? t("quicklook.folderMeta", `${count} 个项目，${formatSize(bytes)}`)
        : t("quicklook.folderEmpty", "空文件夹");
    wrap.append(icon, name, meta);
    container.appendChild(wrap);
}

function kindLabel(stat) {
    if (stat.type === "folder") return t("quicklook.kindFolder", "文件夹");
    const ext = stat.ext.toUpperCase();
    return ext ? `${ext} ${t("quicklook.kindFile", "文件")}` : t("quicklook.kindFile", "文件");
}

function formatSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderFallback(container, stat) {
    const wrap = document.createElement("div");
    wrap.className = "ql-fallback";
    const icon = document.createElement("img");
    icon.src = stat.type === "folder" ? FOLDER_ICON : GENERIC_DOC_ICON;
    const name = document.createElement("p");
    name.className = "ql-folder-name";
    name.textContent = stat.name;
    const meta = document.createElement("p");
    meta.className = "ql-folder-meta";
    const parts = [kindLabel(stat)];
    if (stat.size != null) parts.push(formatSize(stat.size));
    if (stat.modified) parts.push(new Date(stat.modified).toLocaleString());
    meta.textContent = parts.join(" · ");
    wrap.append(icon, name, meta);
    container.appendChild(wrap);
}

/* ── 单例状态 ── */

let paths = [];
let index = 0;
let panel = null;
let contentEl = null;
let titleEl = null;
let counterEl = null;
let zoomEl = null;
let zoomFactor = 1;
let currentAbort = null;
let currentCleanup = null;
let dragState = null;

function isOpen() { return Boolean(panel && document.contains(panel) && !panel.hidden); }

function buildPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "quicklook-panel";
    panel.hidden = true;

    const bar = document.createElement("div");
    bar.className = "ql-bar";
    const closeBtn = document.createElement("button");
    closeBtn.className = "ql-close";
    closeBtn.setAttribute("aria-label", t("quicklook.close", "关闭"));
    closeBtn.addEventListener("click", () => close());
    titleEl = document.createElement("span");
    titleEl.className = "ql-title";
    counterEl = document.createElement("span");
    counterEl.className = "ql-counter";
    const nav = document.createElement("div");
    nav.className = "ql-nav";
    const gridBtn = document.createElement("button");
    gridBtn.textContent = "▦";
    gridBtn.setAttribute("aria-label", t("quicklook.indexSheet", "索引表"));
    gridBtn.addEventListener("click", () => toggleIndexSheet());
    const prev = document.createElement("button");
    prev.textContent = "‹";
    prev.setAttribute("aria-label", t("quicklook.prev", "上一项"));
    prev.addEventListener("click", () => show(index - 1));
    const next = document.createElement("button");
    next.textContent = "›";
    next.setAttribute("aria-label", t("quicklook.next", "下一项"));
    next.addEventListener("click", () => show(index + 1));
    nav.append(gridBtn, prev, next);
    bar.append(closeBtn, titleEl, counterEl, nav);

    zoomEl = document.createElement("div");
    zoomEl.className = "ql-zoom";
    contentEl = document.createElement("div");
    contentEl.className = "ql-content";
    zoomEl.appendChild(contentEl);

    panel.append(bar, zoomEl);
    document.body.appendChild(panel);

    // 标题栏拖动（预览窗跟随鼠标，不引入窗口系统依赖）
    bar.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        const rect = panel.getBoundingClientRect();
        dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragState) return;
        panel.style.left = `${e.clientX - dragState.dx}px`;
        panel.style.top = `${e.clientY - dragState.dy}px`;
        panel.style.transform = "none";
    });
    document.addEventListener("mouseup", () => { dragState = null; });

    document.addEventListener("keydown", onKeydown, true);
}

function isTyping(e) {
    const tag = e.target && e.target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);
}

function onKeydown(e) {
    if (!isOpen() || isTyping(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); toggleIndexSheet(); return; }
    if (e.key === " " || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // Esc 先收索引表，再关预览窗（macOS 同样的分层退出）
        if (e.key === "Escape" && sheetEl && !sheetEl.hidden) { sheetEl.hidden = true; return; }
        close();
        return;
    }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoom.set(zoomFactor + 0.25); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoom.set(Math.max(0.25, zoomFactor - 0.25)); return; }
}

/* ── 索引表（⌘Return，多项目网格速览） ── */

let sheetEl = null;

function toggleIndexSheet() {
    if (!isOpen() || paths.length < 2) return;
    if (!sheetEl) buildIndexSheet();
    sheetEl.hidden = !sheetEl.hidden;
    if (!sheetEl.hidden) fillIndexSheet();
}

function buildIndexSheet() {
    sheetEl = document.createElement("div");
    sheetEl.className = "ql-sheet";
    sheetEl.hidden = true;
    panel.appendChild(sheetEl);
}

async function fillIndexSheet() {
    sheetEl.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "ql-sheet-grid";
    paths.forEach((path, i) => {
        const cell = document.createElement("button");
        cell.className = "ql-sheet-cell";
        if (i === index) cell.classList.add("active");
        const thumb = document.createElement("img");
        const ext = extOf(path);
        thumb.src = IMG_EXTS.has(ext) ? GENERIC_DOC_ICON : (ext === "" ? FOLDER_ICON : GENERIC_DOC_ICON);
        thumb.alt = "";
        if (IMG_EXTS.has(ext)) {
            // 图片给真缩略；读不到就停在通用图标
            FS.read(path).then((file) => {
                if (!file || !cell.isConnected) return;
                const url = URL.createObjectURL(file);
                thumb.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
                thumb.src = url;
            }).catch(() => {});
        }
        const name = document.createElement("span");
        name.textContent = FS.baseName(path);
        cell.append(thumb, name);
        cell.addEventListener("click", () => {
            sheetEl.hidden = true;
            show(i);
        });
        grid.appendChild(cell);
    });
    sheetEl.appendChild(grid);
}

const zoom = {
    get factor() { return zoomFactor; },
    set(f) {
        zoomFactor = Math.round(Math.min(8, Math.max(0.25, f)) * 100) / 100;
        if (zoomEl) zoomEl.style.transform = `scale(${zoomFactor})`;
    },
    reset() { zoom.set(1); },
};

function makeCtx(stat) {
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();
    return {
        readFile: async () => {
            const file = await FS.read(stat.path);
            if (!file) throw new Error(`读不到文件：${stat.path}`);
            return file;
        },
        signal: currentAbort.signal,
        zoom,
    };
}

let showSeq = 0;

async function show(nextIndex) {
    if (!paths.length) return;
    index = ((nextIndex % paths.length) + paths.length) % paths.length;
    const seq = ++showSeq;
    buildPanel();
    const path = paths[index];
    const statRaw = await FS.stat(path).catch(() => null);
    const stat = statRaw
        ? { ...statRaw, ext: extOf(statRaw.name) }
        : { path, name: FS.baseName(path), type: "file", size: null, modified: null, ext: extOf(path) };
    titleEl.textContent = stat.name;
    counterEl.textContent = paths.length > 1 ? `${index + 1} / ${paths.length}` : "";
    zoom.reset();

    if (currentCleanup) { try { currentCleanup(); } catch (err) { /* provider 清理失败不阻塞 */ } currentCleanup = null; }
    contentEl.innerHTML = "";

    const provider = pickProvider(stat);
    if (!provider) { renderFallback(contentEl, stat); }
    else {
        const ctx = makeCtx(stat);
        try {
            const cleanup = await Promise.race([
                provider.render(contentEl, stat, ctx),
                new Promise((_, reject) => setTimeout(() => reject(new Error("provider 超时")), PROVIDER_TIMEOUT)),
            ]);
            if (seq !== showSeq) { if (typeof cleanup === "function") cleanup(); return; }   // 期间已翻页/关闭
            if (typeof cleanup === "function") currentCleanup = cleanup;
        } catch (err) {
            console.warn(`[quicklook] provider ${provider.id} 渲染失败，回退通用预览：`, err);
            if (seq !== showSeq) return;
            contentEl.innerHTML = "";
            renderFallback(contentEl, stat);
        }
    }
}

/**
 * 打开（或接管）预览窗。
 * @param {string[]|Array<{path:string}>} items 路径或含 path 的条目
 * @param {number} [startIndex=0]
 */
async function open(items, startIndex = 0) {
    const next = (items || []).map((it) => (typeof it === "string" ? it : it.path)).filter(Boolean);
    if (!next.length) return;
    paths = next;
    buildPanel();
    panel.hidden = false;
    panel.classList.remove("ql-closing");
    await show(startIndex);
}

/** 跟随外部选择变化（访达选中移动时同步），窗口未打开时无操作。 */
async function sync(items, startIndex = 0) {
    if (!isOpen()) return;
    await open(items, startIndex);
}

function close() {
    if (!panel) return;
    panel.hidden = true;
    if (sheetEl) sheetEl.hidden = true;
    if (currentAbort) { currentAbort.abort(); currentAbort = null; }
    if (currentCleanup) { try { currentCleanup(); } catch (err) { /* 忽略 */ } currentCleanup = null; }
}

const QuickLook = Object.freeze({
    registerProvider,
    open,
    sync,
    close,
    isOpen,
    // 内建 provider 注册（供探针/收口期复用同一批渲染器）
    _builtin: { renderImage, renderText, renderPdf, renderFolder, renderFallback },
    // 探针钩子：provider 选择的纯逻辑（评分/隔离）不开浏览器也能验
    _pickProvider: pickProvider,
});
globalThis.__quicklook = QuickLook;

/* 内建 provider：分数 10（文件格式）与 5（文件夹兜底） */
registerProvider({ id: "builtin.image", match: (s) => (isImg(s) ? 10 : 0), render: renderImage });
registerProvider({ id: "builtin.text", match: (s) => (isText(s) ? 10 : 0), render: renderText });
registerProvider({ id: "builtin.pdf", match: (s) => (s.type !== "folder" && s.ext === "pdf" ? 10 : 0), render: renderPdf });
registerProvider({ id: "builtin.audio", match: (s) => (s.type !== "folder" && ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(s.ext) ? 10 : 0), render: renderMedia("audio") });
registerProvider({ id: "builtin.video", match: (s) => (s.type !== "folder" && ["mp4", "webm", "mov", "mkv"].includes(s.ext) ? 10 : 0), render: renderMedia("video") });
registerProvider({ id: "builtin.folder", match: (s) => (s.type === "folder" ? 5 : 0), render: renderFolder });

export { QuickLook };
