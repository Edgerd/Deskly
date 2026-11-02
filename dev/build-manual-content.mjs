/**
 * dev/build-manual-content.mjs — 由知识库生成「Mac 使用手册」插件内容
 *
 * 输入：docs/iMac-2024-macOS15-知识库/ 的 8 章 Markdown（含 209 张图的引用）
 * 输出：mods/manual/content/*.md + index.json
 *
 * 图片：知识库原图共 43MB，而商店 ZIP 上限是 10MB，所以插件里放的是压缩后的
 * WebP 副本 mods/manual/images/*.webp（约 6MB）。正文保留图片引用并改指 WebP，
 * 渲染端直接出 <img>；构建期缺图会直接报错，不会把破图带进包里。
 * 重新生成 WebP：python dev/optimize-manual-images.py
 *
 * 用法：node dev/build-manual-content.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.url.replace(/^file:\/\/\/?/, ""), "..", "..");
const SRC = join(ROOT, "docs/iMac-2024-macOS15-知识库");
const OUT = join(ROOT, "mods/manual/content");
const IMG_OUT = join(ROOT, "mods/manual/images");

mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter((f) => /^0[1-8]-.*\.md$/.test(f)).sort();

const chapters = [];
const search = [];
const missingImages = new Set();
const usedImages = new Set();
// 搜索正文只保留可读文字：图片取 alt、链接取锚文本，别把 Markdown 路径塞进索引。
const plain = (s) => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const escapeAlt = (s) => String(s || "").replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();

for (const file of files) {
    const id = file.slice(0, 2);
    // 源文件是 CRLF：不归一化时行尾锚点匹配不到，H1/H2 会全部漏掉
    let text = readFileSync(join(SRC, file), "utf8").replace(/\r\n?/g, "\n");

    // 1. 去掉抓取时写入的两行来源引用（App 里由「关于」统一说明来源）
    text = text.replace(/^> 来源：.*\n?/m, "").replace(/^> 章节：.*\n?/m, "").trim();

    // 2. 图片 + 紧随其后的图注 → 保留图片引用，改指插件里的 WebP 副本；
    //    图注并入 alt（渲染端同时用作 figcaption）。
    const toWebp = (base) => {
        const file = `${base}.webp`;
        usedImages.add(file);
        if (!existsSync(join(IMG_OUT, file))) missingImages.add(file);
        return file;
    };
    text = text.replace(/!\[([^\]]*)\]\(images\/([^)]+)\.(?:png|jpe?g)\)\s*\n+\*图：([^\n]*)\*\s*\n?/g, (m, alt, base, caption) => {
        const label = escapeAlt(caption || alt);
        return `![${label}](images/${toWebp(base)})\n\n`;
    });
    // 兼容没有图注行的图片
    text = text.replace(/!\[([^\]]*)\]\(images\/([^)]+)\.(?:png|jpe?g)\)\s*\n?/g, (m, alt, base) => {
        const label = escapeAlt(alt);
        return `![${label}](images/${toWebp(base)})\n\n`;
    });

    // 3. 压缩多余空行
    text = text.replace(/\n{3,}/g, "\n\n").trim() + "\n";

    const fname = `${id}.md`;
    writeFileSync(join(OUT, fname), text);

    // 4. 解析标题：H1 为章名，H2 为小节。标题序号按「文档里第几个标题」计，
    //    渲染端同样按顺序给每个标题打 data-h，跳转才不会落到段落中间。
    const lines = text.split("\n");
    let title = "";
    let headingSeq = 0;
    let current = null;
    const sections = [];

    for (const line of lines) {
        const h1 = /^#\s+(.+)$/.exec(line);
        const h2 = /^##\s+(.+)$/.exec(line);
        if (h1) {
            title = plain(h1[1]);
            headingSeq += 1;
            continue;
        }
        if (h2) {
            if (current) {
                current.body = current.body.trim();
                current.preview = current.body.slice(0, 160);
            }
            current = { title: plain(h2[1]), h: headingSeq, preview: "", body: "" };
            sections.push(current);
            headingSeq += 1;
        } else if (current) {
            current.body += " " + plain(line);
        }
    }
    if (current) {
        current.body = current.body.trim();
        current.preview = current.body.slice(0, 160);
    }

    chapters.push({
        id,
        title,
        file: fname,
        sections: sections.map((s) => ({ title: s.title, h: s.h, preview: s.preview })),
    });
    sections.forEach((s) => search.push({
        chapter: id,
        chapterTitle: title,
        section: s.title,
        h: s.h,
        text: `${s.title} ${s.body}`,
    }));
}

if (missingImages.size) {
    console.error(`缺少 ${missingImages.size} 张 WebP 插图，先运行 python dev/optimize-manual-images.py：`);
    [...missingImages].sort().forEach((file) => console.error(` - ${file}`));
    process.exit(1);
}

const index = {
    generated: new Date().toISOString().slice(0, 10),
    source: "《iMac 入门指南》2024 年款 · macOS Sequoia 15（本地知识库镜像）",
    chapters,
    search,
};

writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 0) + "\n");
const total = chapters.reduce((n, c) => n + c.sections.length, 0);
console.log(`生成完成：${chapters.length} 章 / ${total} 节 / ${usedImages.size} 张插图 / 搜索条目 ${search.length}`);
