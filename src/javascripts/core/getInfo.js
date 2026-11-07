/**
 * core/getInfo.js — 「显示简介」面板（⌘I），桌面与访达共用。
 *
 * 为什么放在内核：这不是某个插件的界面，而是文件系统的通用视图——
 * 打开源可以来自桌面、访达、快速查看或插件（经 Deskly().ui.showGetInfo）。
 * 面板是全局单例：再次调用直接换内容，不开第二个窗口（与 Quick Look 同口径）。
 *
 * 信息只读：名称、种类、大小、所在位置、修改日期；文件夹额外给项目数。
 * 多选时聚合（N 个项目 / 合计大小 / 共同父目录），与 macOS 一致。
 *
 * 数据来源只走 FS.stat（统一错误码），读不到就如实显示「—」，不编造。
 */

import { FS } from "../fs/index.js";
import { i18n } from "../i18n.js";
import { FOLDER_ICON, GENERIC_DOC_ICON } from "../paths.js";

const t = (key, fallback) => i18n.t(key, fallback);

/* ── 纯函数（探针直接断言这几个，不用起 DOM） ── */

/** 人类可读大小：与访达同口径（1000 进制，保留一位小数）。 */
export function formatSize(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
    if (bytes < 1000) return `${bytes} 字节`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = -1;
    do { value /= 1000; unit++; } while (value >= 1000 && unit < units.length - 1);
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** 修改日期：本地时区完整时间；缺元信息给「—」。 */
export function formatDate(ms) {
    if (!ms || !Number.isFinite(ms)) return "—";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "—";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 种类描述：文件夹 / 常见文档给中文名，其余按扩展名。 */
export function describeKind(stat) {
    if (!stat) return t("info.kind.unknown", "未知");
    if (stat.type === "folder") return t("info.kind.folder", "文件夹");
    const ext = String((stat.name || "").match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    const map = {
        txt: t("info.kind.text", "纯文本文件"),
        md: t("info.kind.markdown", "Markdown 文稿"),
        png: t("info.kind.png", "PNG 图像"),
        jpg: t("info.kind.jpeg", "JPEG 图像"),
        jpeg: t("info.kind.jpeg", "JPEG 图像"),
        gif: t("info.kind.gif", "GIF 图像"),
        webp: t("info.kind.webp", "WebP 图像"),
        svg: t("info.kind.svg", "SVG 图像"),
        pdf: t("info.kind.pdf", "PDF 文稿"),
        docx: t("info.kind.docx", "Word 文稿"),
        xlsx: t("info.kind.xlsx", "Excel 表格"),
        pptx: t("info.kind.pptx", "PowerPoint 演示文稿"),
        zip: t("info.kind.zip", "压缩文件"),
        json: t("info.kind.json", "JSON 文件"),
        js: t("info.kind.js", "JavaScript 文件"),
        css: t("info.kind.css", "CSS 文件"),
        html: t("info.kind.html", "HTML 文件"),
    };
    return map[ext] || (ext ? `${ext.toUpperCase()} ${t("info.kind.file", "文件")}` : t("info.kind.file", "文件"));
}

/** 汇总多选：名称、类型、总大小、父目录。 */
export function summarize(stats) {
    const list = stats.filter(Boolean);
    if (!list.length) return null;
    if (list.length === 1) {
        const s = list[0];
        return { title: s.name, kind: describeKind(s), size: formatSize(s.size), where: FS.parentOf(s.path), mod: formatDate(s.modified) };
    }
    const allFolders = list.every((s) => s.type === "folder");
    const total = list.reduce((n, s) => n + (Number.isFinite(s.size) ? s.size : 0), 0);
    const parents = new Set(list.map((s) => FS.parentOf(s.path)));
    return {
        title: `${list.length} ${t("info.items", "个项目")}`,
        kind: allFolders ? t("info.kind.folder", "文件夹") : t("info.kind.mixed", "混合"),
        size: allFolders ? `—` : formatSize(total),
        where: parents.size === 1 ? [...parents][0] : t("info.multipleLocations", "多个位置"),
        mod: "—",
    };
}

/* ── 面板 ── */

let panel = null;   // { root, els }
let openToken = 0;  // 连续 ⌘I 时只让最后一次填充，防止旧结果覆盖新选择

function buildPanel() {
    const root = document.createElement("div");
    root.className = "getinfo-panel";
    root.hidden = true;
    root.innerHTML = `
        <div class="gi-bar">
            <button class="gi-close" type="button" aria-label="关闭"></button>
            <span class="gi-bar-title">${t("info.title", "简介")}</span>
        </div>
        <div class="gi-body">
            <div class="gi-head"><img class="gi-icon" alt="" /><span class="gi-name"></span></div>
            <dl class="gi-rows">
                <dt>${t("info.kind", "种类")}</dt><dd data-field="kind">—</dd>
                <dt>${t("info.size", "大小")}</dt><dd data-field="size">—</dd>
                <dt>${t("info.where", "所在位置")}</dt><dd data-field="where">—</dd>
                <dt>${t("info.modified", "修改日期")}</dt><dd data-field="mod">—</dd>
                <dt class="gi-count-row">${t("info.count", "项目数")}</dt><dd class="gi-count-row" data-field="count">—</dd>
            </dl>
        </div>`;
    document.body.appendChild(root);
    root.querySelector(".gi-close").addEventListener("click", close);
    makeDraggable(root, root.querySelector(".gi-bar"));
    return { root, els: { icon: root.querySelector(".gi-icon"), name: root.querySelector(".gi-name"), rows: root.querySelector(".gi-rows") } };
}

function makeDraggable(root, handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
        if (e.target.closest(".gi-close")) return;
        dragging = true;
        const rect = root.getBoundingClientRect();
        dx = e.clientX - rect.left;
        dy = e.clientY - rect.top;
        // 拖动后改成 left/top 绝对定位，避免 transform 与居中互相打架
        root.style.left = `${rect.left}px`;
        root.style.top = `${rect.top}px`;
        root.style.transform = "none";
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        root.style.left = `${e.clientX - dx}px`;
        root.style.top = `${e.clientY - dy}px`;
    });
    document.addEventListener("mouseup", () => { dragging = false; });
}

function setField(els, field, value) {
    const el = els.rows.querySelector(`[data-field="${field}"]`);
    if (el) el.textContent = value;
}

function onKeydown(e) {
    if (!panel || panel.root.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
}

function close() {
    if (!panel) return;
    panel.root.hidden = true;
    openToken++;
}

function isOpen() {
    return !!(panel && !panel.root.hidden);
}

/**
 * 打开（或接管）简介面板。
 * @param {Array<{path:string,name:string,type:string}>} items 条目（来自桌面/访达/插件）
 */
async function open(items) {
    const list = Array.isArray(items) ? items.filter((i) => i && i.path) : [];
    if (!list.length) return;
    if (!panel) {
        panel = buildPanel();
        document.addEventListener("keydown", onKeydown, true);
    }
    const token = ++openToken;
    panel.root.hidden = false;

    // 先用已知字段占位，避免面板空白等 IO（stat 是异步的）
    const first = list[0];
    panel.els.name.textContent = list.length > 1 ? `${list.length} ${t("info.items", "个项目")}` : first.name;
    panel.els.icon.src = first.type === "folder" ? FOLDER_ICON : GENERIC_DOC_ICON;
    setField(panel.els, "kind", describeKind(first));
    setField(panel.els, "size", "—");
    setField(panel.els, "where", FS.parentOf(first.path));
    setField(panel.els, "mod", "—");
    setField(panel.els, "count", "—");

    const stats = await Promise.all(list.map((item) => FS.stat(item.path).catch(() => null)));
    if (token !== openToken) return;   // 已被更新的调用接管
    const info = summarize(stats);
    if (!info) { close(); return; }

    panel.els.name.textContent = info.title;
    setField(panel.els, "kind", info.kind);
    setField(panel.els, "size", info.size);
    setField(panel.els, "where", info.where);
    setField(panel.els, "mod", info.mod);

    // 文件夹：项目数（读不到就留「—」，不把面板拖死）
    const folderStat = list.length === 1 && stats[0] && stats[0].type === "folder" ? stats[0] : null;
    if (folderStat) {
        const children = await FS.list(folderStat.path).catch(() => null);
        if (token !== openToken) return;
        setField(panel.els, "count", children ? `${children.length} ${t("info.items", "个项目")}` : "—");
    } else {
        const row = panel.els.rows.querySelectorAll(".gi-count-row");
        row.forEach((el) => { el.hidden = true; });
    }
    if (folderStat) panel.els.rows.querySelectorAll(".gi-count-row").forEach((el) => { el.hidden = false; });

    // 图片类给缩略图（读不到就保留通用图标）
    if (list.length === 1 && first.type !== "folder" && /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(first.name)) {
        try {
            const file = await FS.read(first.path);
            if (file && token === openToken) {
                const url = URL.createObjectURL(file);
                panel.els.icon.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
                panel.els.icon.src = url;
            }
        } catch (err) { /* 缩略图失败不影响简介 */ }
    }
}

export const GetInfo = { open, close, isOpen, formatSize, formatDate, describeKind, summarize };
