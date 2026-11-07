/**
 * dev/gen-empty-templates.mjs — 用 office 自家编解码器生成空白 OOXML 模板，
 * 落盘 assets/templates/empty.docx|xlsx|pptx。桌面「新建文稿/表格/演示」复制这些资产，
 * 运行时不需要内核反向依赖 office 编解码器。
 * 用法：`node dev/gen-empty-templates.mjs`
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (rel) => pathToFileURL(join(root, rel)).href;

globalThis.JSZip = (await import(mod("assets/vendor/jszip.min.js"))).default;

const { emptyDocx, buildDocx, parseDocx } = await import(mod("mods/office/codecs/docx.js"));
const { emptySheet, buildXlsx, parseXlsx } = await import(mod("mods/office/codecs/xlsx.js"));
const { emptySlide, buildPptx, parsePptx } = await import(mod("mods/office/codecs/pptx.js"));

const outDir = join(root, "assets/templates");
mkdirSync(outDir, { recursive: true });

const docx = await buildDocx(emptyDocx().blocks);
const xlsx = await buildXlsx([emptySheet()]);
const pptx = await buildPptx([emptySlide()]);

writeFileSync(join(outDir, "empty.docx"), docx);
writeFileSync(join(outDir, "empty.xlsx"), xlsx);
writeFileSync(join(outDir, "empty.pptx"), pptx);

// 自检：用同一批编解码器读回来，确认生成的包可解析
await parseDocx(docx);
await parseXlsx(xlsx);
await parsePptx(pptx);

console.log(`empty.docx ${docx.length}B / empty.xlsx ${xlsx.length}B / empty.pptx ${pptx.length}B — 生成并回读通过`);
