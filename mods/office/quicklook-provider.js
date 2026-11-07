/**
 * quicklook-provider.js — Office 三件套的 Quick Look 预览 provider（第 3 期 Q5 + 第 6 期收口）。
 *
 * 预览只读：用编解码器把 OOXML 解成模型后直接走 *ToText 系列拍平，
 * 不挂载任何编辑器视图（view-*.js 与撤销栈都不进预览路径）。
 * 编解码器保持首次预览时才 dynamic import（0.9MB 不进外壳启动路径）。
 * Q6 收口：注册走 Deskly.quicklook 公开 API，不直接 import 内核模块。
 */

const Deskly = () => window.Deskly;

const MATCH_SCORE = 20;   // 高于内建图片/文本（10），低于宿主自定义

function extOf(name) { return (String(name).match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || ""; }

function textBlock(text) {
    const pre = document.createElement("pre");
    pre.className = "ql-text";
    pre.textContent = text;
    return pre;
}

async function renderDocx(container, stat, ctx) {
    const [{ parseDocx, docxToText }] = await Promise.all([import("./codecs/docx.js")]);
    const file = await ctx.readFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blocks = await parseDocx(bytes);
    container.appendChild(textBlock(docxToText(blocks)));
}

async function renderXlsx(container, stat, ctx) {
    const [{ parseXlsx, sheetToTsv }] = await Promise.all([import("./codecs/xlsx.js")]);
    const file = await ctx.readFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sheets = await parseXlsx(bytes);
    const wrap = document.createElement("div");
    wrap.className = "ql-text";
    const head = document.createElement("p");
    head.textContent = sheets.map((s) => s.name).join(" · ");
    const pre = document.createElement("pre");
    pre.textContent = sheets.length ? sheetToTsv(sheets[0]) : "";
    wrap.append(head, pre);
    container.appendChild(wrap);
}

async function renderPptx(container, stat, ctx) {
    const [{ parsePptx, pptxToText }] = await Promise.all([import("./codecs/pptx.js")]);
    const file = await ctx.readFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const slides = await parsePptx(bytes);
    container.appendChild(textBlock(pptxToText(slides)));
}

async function register(id, match, render) {
    // guard 包装的方法是异步信封：ok:false 只说明未授权，不构成崩溃
    const env = await Deskly().quicklook.registerProvider({ id, match, render });
    if (env && env.ok === false) console.warn(`[office] Quick Look provider 注册被拒（${id}）：`, env.reason);
    return env;
}

await register("docx", (stat) => (stat.type !== "folder" && extOf(stat.name) === "docx" ? MATCH_SCORE : 0), renderDocx);
await register("xlsx", (stat) => (stat.type !== "folder" && extOf(stat.name) === "xlsx" ? MATCH_SCORE : 0), renderXlsx);
await register("pptx", (stat) => (stat.type !== "folder" && extOf(stat.name) === "pptx" ? MATCH_SCORE : 0), renderPptx);
