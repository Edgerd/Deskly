/**
 * script.js — 「Mac 使用手册」插件
 *
 * 内容来自构建脚本 dev/build-manual-content.mjs 生成的 content/*.md 与 index.json。
 * 插图随插件打包在 images/*.webp（知识库原图 43MB，构建期压缩到约 6MB），
 * 运行时按需懒加载；正文里的 `![说明](images/x.webp)` 渲染为 figure + img。
 *
 * 结构：章列表 → 小节列表 → 正文；顶部搜索在 index.search 上做子串匹配。
 * 外部入口：document 上的 `manual-open` 事件（detail: {chapter, section, h}），
 * 由帮助菜单与聚焦派发；本模块负责解析章节/小节并滚动到对应标题。
 *
 * 安全：正文用 DOM 构建（textContent / createElement），不把 Markdown 直接塞进 innerHTML；
 * 图片只允许插件 images/ 下的单层文件名，链接只允许 http(s)。
 */

import { i18n } from "../../src/javascripts/i18n.js";
import { attachTrafficLights } from "../../src/javascripts/ui/trafficLights.js";

const root = document.querySelector(".manual.window");

/** 阅读状态：索引、当前章、当前节标题序号、Markdown 缓存、搜索词。 */
const state = {
    index: null,
    chapter: "",
    heading: 0,
    // 打开序号：初始化时会先打开第 1 章，帮助菜单可能在它加载完成前又打开第 3 章。
    // 每次 open 领一个号，await 回来后发现不是最新就丢弃，避免旧章节覆盖新章节。
    token: 0,
    cache: new Map(),
    query: "",
    headingEls: [],
    releaseSurface: null,
};

const els = {};

async function init() {
    els.chapters = root.querySelector(".manual__chapters");
    els.sections = root.querySelector(".manual__sections");
    els.content = root.querySelector(".manual__content");
    els.search = root.querySelector(".manual__search");
    els.meta = root.querySelector(".manual__meta");
    els.source = root.querySelector(".manual__source");

    // 红绿灯统一走组件 API：锚到带 data-titlebar 的工具栏，位置由组件补到
    // --traffic-inset；磨砂面登记到表面系统，文字色随壁纸/主题自动取黑或白。
    attachTrafficLights(root, { anchor: root.querySelector("[data-titlebar]"), placement: "titlebar" });
    state.releaseSurface = globalThis.__surface?.apply?.(root, { role: 3 }) || null;

    localize();
    bind();
    try {
        const res = await fetch(new URL("./content/index.json", import.meta.url));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.index = await res.json();
    } catch (err) {
        console.error("[manual] 索引加载失败：", err);
        els.content.textContent = i18n.t("manual.loadFailed", "手册内容加载失败，请重新安装本 App。");
        return;
    }

    els.source.textContent = `${state.index.source} · ${state.index.generated}`;
    renderChapters();
    const first = state.index.chapters[0];
    await open(first.id, first.sections[0] ? first.sections[0].h : 0);

    window.addEventListener("plugin-unload", onUnload);
}

/** 静态文案与无障碍属性：与 about 插件同一套 data-i18n 约定。 */
function localize() {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = i18n.t(el.getAttribute("data-i18n"), el.getAttribute("data-i18n-fallback") || el.textContent);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        el.placeholder = i18n.t(el.getAttribute("data-i18n-placeholder"), el.getAttribute("data-i18n-placeholder-fallback") || el.placeholder);
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
        el.setAttribute("aria-label", i18n.t(el.getAttribute("data-i18n-aria-label"), el.getAttribute("data-i18n-aria-label-fallback") || ""));
    });
}

function bind() {
    els.search.addEventListener("input", () => {
        state.query = els.search.value.trim();
        if (!state.query) {
            renderSections();
            return;
        }
        renderSearch(state.query);
    });
    els.search.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            els.search.value = "";
            state.query = "";
            renderSections();
        }
    });
    document.addEventListener("manual-open", onManualOpen);
    document.addEventListener("languagechange", onLanguageChange);
    els.content.addEventListener("scroll", onContentScroll, { passive: true });
}

function onUnload() {
    document.removeEventListener("manual-open", onManualOpen);
    document.removeEventListener("languagechange", onLanguageChange);
    state.cache.clear();
    state.releaseSurface?.();
    state.releaseSurface = null;
}

function onLanguageChange() {
    localize();
    renderChapters();
    if (state.query) renderSearch(state.query);
    else renderSections();
}

/** 外部入口：帮助菜单 / 聚焦派发。 */
function onManualOpen(event) {
    const detail = (event && event.detail) || {};
    openByDetail(detail);
}

/**
 * 按 {chapter, section, h} 打开；section 用标题包含匹配，容忍索引重排。
 * @param {{chapter?:string, section?:string, h?:number}} detail 目标
 * @returns {Promise<void>}
 */
async function openByDetail(detail) {
    if (!state.index) return;
    const chapters = state.index.chapters;
    const chapter = chapters.find((c) => c.id === String(detail.chapter || "")) || chapters[0];
    if (!chapter) return;
    let heading = Number(detail.h);
    if (!Number.isFinite(heading) && detail.section) {
        const hit = chapter.sections.find((s) => s.title.includes(detail.section));
        if (hit) heading = hit.h;
    }
    if (!Number.isFinite(heading)) heading = chapter.sections[0] ? chapter.sections[0].h : 0;
    await open(chapter.id, heading);
}

function renderChapters() {
    if (!state.index) return;
    els.chapters.textContent = "";
    state.index.chapters.forEach((chapter) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "manual__row manual__row--chapter";
        btn.textContent = chapter.title;
        btn.setAttribute("aria-current", chapter.id === state.chapter ? "true" : "false");
        btn.addEventListener("click", () => {
            els.search.value = "";
            state.query = "";
            open(chapter.id, chapter.sections[0] ? chapter.sections[0].h : 0);
        });
        els.chapters.appendChild(btn);
    });
}

function renderSections() {
    if (!state.index) return;
    const chapter = state.index.chapters.find((c) => c.id === state.chapter);
    els.sections.textContent = "";
    if (!chapter) return;
    chapter.sections.forEach((section) => {
        els.sections.appendChild(sectionButton(section.title, section.h, section.h === state.heading));
    });
    els.meta.textContent = `${chapter.sections.length} ${i18n.t("manual.sectionUnit", "节")}`;
}

function sectionButton(title, h, active) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "manual__row manual__row--section";
    btn.textContent = title;
    btn.setAttribute("aria-current", active ? "true" : "false");
    btn.addEventListener("click", () => {
        els.search.value = "";
        state.query = "";
        scrollToHeading(h);
    });
    return btn;
}

/** 搜索结果：章节 + 小节 + 摘要，点按直达。 */
function renderSearch(query) {
    const needle = query.toLowerCase();
    const hits = state.index.search
        .filter((entry) => entry.text.toLowerCase().includes(needle))
        .slice(0, 60);
    els.sections.textContent = "";
    els.meta.textContent = `${hits.length} ${i18n.t("manual.resultUnit", "条结果")}`;
    if (!hits.length) {
        const empty = document.createElement("div");
        empty.className = "manual__empty";
        empty.textContent = i18n.t("manual.noResults", "没有匹配的内容");
        els.sections.appendChild(empty);
        return;
    }
    hits.forEach((hit) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "manual__row manual__row--result";
        const title = document.createElement("span");
        title.textContent = hit.section;
        const sub = document.createElement("span");
        sub.className = "manual__row-sub";
        sub.textContent = hit.chapterTitle;
        btn.append(title, sub);
        btn.addEventListener("click", () => open(hit.chapter, hit.h));
        els.sections.appendChild(btn);
    });
}

/**
 * 打开章节并滚到指定标题。
 * @param {string} chapterId 章 id（01…08）
 * @param {number} heading 标题序号（data-h）
 * @returns {Promise<void>}
 */
async function open(chapterId, heading) {
    const chapter = state.index.chapters.find((c) => c.id === chapterId);
    if (!chapter) return;
    const token = ++state.token;
    state.chapter = chapterId;
    renderChapters();
    renderSections();
    els.content.textContent = "";
    let md = state.cache.get(chapterId);
    if (md === undefined) {
        try {
            const res = await fetch(new URL(`./content/${chapter.file}`, import.meta.url));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            md = await res.text();
            state.cache.set(chapterId, md);
            if (token !== state.token) return;
        } catch (err) {
            console.error("[manual] 章节加载失败：", err);
            els.content.textContent = i18n.t("manual.loadFailed", "手册内容加载失败，请重新安装本 App。");
            return;
        }
    }
    renderMarkdown(md, els.content);
    state.headingEls = [...els.content.querySelectorAll("[data-h]")];
    if (!state.query) setActiveSection(heading);
    scrollToHeading(heading);
}

/** 只滚动，不重渲染（中栏点击用）。 */
function scrollToHeading(heading) {
    state.heading = heading;
    setActiveSection(heading);
    const target = els.content.querySelector(`[data-h="${heading}"]`);
    if (target) {
        els.content.scrollTop = Math.max(0, target.offsetTop - 12);
    } else {
        els.content.scrollTop = 0;
    }
}

/** 同步中栏高亮。 */
function setActiveSection(heading) {
    [...els.sections.querySelectorAll(".manual__row--section")].forEach((row) => {
        row.setAttribute("aria-current", "false");
    });
    // 中栏按钮没有 data-h，用章节数据反查与标题文本对应的序号
    const chapter = state.index.chapters.find((c) => c.id === state.chapter);
    if (!chapter) return;
    const index = chapter.sections.findIndex((s) => s.h === heading);
    const rows = els.sections.querySelectorAll(".manual__row--section");
    if (index >= 0 && rows[index]) rows[index].setAttribute("aria-current", "true");
}

/** 滚动时把当前小节同步到中栏（取最后一个越过顶部的标题）。 */
function onContentScroll() {
    if (state.query || !state.headingEls.length) return;
    const top = els.content.scrollTop + 24;
    let current = state.headingEls[0];
    for (const el of state.headingEls) {
        if (el.offsetTop <= top) current = el;
        else break;
    }
    const h = Number(current.dataset.h);
    if (h !== state.heading) {
        state.heading = h;
        setActiveSection(h);
    }
}

// ---------------- Markdown → DOM ----------------

/** 独占一行的图片；只接受构建脚本产出的 images/<file>.webp，杜绝路径穿越。 */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const IMAGE_FILE = /^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/;

/**
 * 渲染一张插图：图片本体走懒加载，说明文字放 figcaption（同时是 alt）。
 * 路径不合法或文件缺失时只保留图注，不把破图图标留在正文里。
 * @param {string} alt 说明文字
 * @param {string} src 相对插件目录的路径（images/x.webp）
 * @returns {HTMLElement}
 */
function createFigure(alt, src) {
    const figure = document.createElement("figure");
    figure.className = "manual__figure";
    const caption = (alt || "").trim();
    if (IMAGE_FILE.test(src)) {
        const img = new Image();
        img.src = new URL("./" + src, import.meta.url).href;
        img.alt = caption;
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("error", () => figure.classList.add("is-missing"), { once: true });
        figure.appendChild(img);
    } else {
        figure.classList.add("is-missing");
    }
    if (caption) {
        const note = document.createElement("figcaption");
        note.textContent = caption;
        figure.appendChild(note);
    }
    return figure;
}

/**
 * 渲染 Markdown 子集：H1–H3、段落、图片、有序/无序列表、引用块、表格、分隔线、行内强调。
 * 只处理本手册实际用到的语法；不引入第三方解析器。
 * @param {string} md Markdown 文本
 * @param {HTMLElement} container 输出容器
 */
function renderMarkdown(md, container) {
    container.textContent = "";
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    let headingSeq = 0;
    let list = null;

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i += 1;
            list = null;
            continue;
        }

        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            const node = document.createElement(`h${level}`);
            if (level <= 2) node.dataset.h = String(headingSeq++);
            appendInline(node, heading[2]);
            container.appendChild(node);
            list = null;
            i += 1;
            continue;
        }

        const image = IMAGE_LINE.exec(line.trim());
        if (image) {
            container.appendChild(createFigure(image[1], image[2]));
            list = null;
            i += 1;
            continue;
        }

        if (/^\s*---+\s*$/.test(line)) {
            container.appendChild(document.createElement("hr"));
            i += 1;
            continue;
        }

        if (isTableStart(lines, i)) {
            i = appendTable(lines, i, container);
            list = null;
            continue;
        }

        if (line.startsWith(">")) {
            const quote = [];
            while (i < lines.length && lines[i].startsWith(">")) {
                quote.push(lines[i].replace(/^>\s?/, ""));
                i += 1;
            }
            const block = document.createElement("blockquote");
            appendInline(block, quote.join(" "));
            container.appendChild(block);
            list = null;
            continue;
        }

        const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (item) {
            const ordered = /\d/.test(item[2]);
            if (!list || list.ordered !== ordered) {
                list = { el: document.createElement(ordered ? "ol" : "ul"), ordered };
                container.appendChild(list.el);
            }
            const li = document.createElement("li");
            appendInline(li, item[3]);
            list.el.appendChild(li);
            i += 1;
            continue;
        }

        // 段落：一直吃到空行或下一个块级标记
        const paragraph = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
            paragraph.push(lines[i]);
            i += 1;
        }
        const p = document.createElement("p");
        appendInline(p, paragraph.join(" "));
        container.appendChild(p);
    }
}

function isBlockStart(line) {
    return /^(#{1,3})\s+/.test(line)
        || /^\s*---+\s*$/.test(line)
        || line.startsWith(">")
        || IMAGE_LINE.test(line.trim())
        || /^(\s*)([-*]|\d+\.)\s+/.test(line)
        || line.trim().startsWith("|");
}

function isTableStart(lines, i) {
    return lines[i].trim().startsWith("|")
        && i + 1 < lines.length
        && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]);
}

/** 解析表格并返回下一行索引。 */
function appendTable(lines, start, container) {
    const rows = [];
    let i = start;
    while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].trim());
        i += 1;
    }
    if (rows.length < 2) return i;
    const cells = (row) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    cells(rows[0]).forEach((text) => {
        const th = document.createElement("th");
        appendInline(th, text);
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.slice(2).forEach((row) => {
        const tr = document.createElement("tr");
        cells(row).forEach((text) => {
            const td = document.createElement("td");
            appendInline(td, text);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
    return i;
}

/**
 * 行内语法：**粗体**、*斜体*、`代码`、[文字](链接)。
 * 用正则切片而不是 innerHTML：任何文本都走 textContent，链接只放行 http(s)。
 * @param {HTMLElement} parent 目标节点
 * @param {string} text 原始行内文本
 */
function appendInline(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
        if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
        const token = match[0];
        if (token.startsWith("**")) {
            const strong = document.createElement("strong");
            strong.textContent = token.slice(2, -2);
            parent.appendChild(strong);
        } else if (token.startsWith("`")) {
            const code = document.createElement("code");
            code.textContent = token.slice(1, -1);
            parent.appendChild(code);
        } else if (token.startsWith("[")) {
            const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
            if (link && /^https?:\/\//i.test(link[2])) {
                const a = document.createElement("a");
                a.textContent = link[1];
                a.href = link[2];
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                parent.appendChild(a);
            } else {
                parent.appendChild(document.createTextNode(token));
            }
        } else {
            const em = document.createElement("em");
            em.textContent = token.slice(1, -1);
            parent.appendChild(em);
        }
        last = match.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// 必须放在 state / els 初始化之后：init() 是 async 函数，但会在第一个 await 之前同步执行，
// 声明在文件末尾的 const 此时还在 TDZ 里（实测报 "Cannot access 'els' before initialization"）。
if (root) {
    init();
} else {
    console.warn("[manual] 未找到窗口根元素，跳过初始化");
}
