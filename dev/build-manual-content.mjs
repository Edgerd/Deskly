/**
 * dev/build-manual-content.mjs — 由知识库生成「Mac 使用手册」插件内容
 *
 * 输入：docs/iMac-2024-macOS15-知识库/ 的 8 章 Markdown（含 209 张图的引用）
 * 输出：mods/manual/content/*.md + index.json
 *
 * 为什么不直接引用 docs/：docs/ 里图片共 43MB，扩展包与商店 ZIP 都装不下；
 * 这里把图片引用降级成「图：说明」引用块，正文保留，体积只剩约 260KB。
 * 图片本身仍留在知识库目录，需要看原图时按图注去 docs/ 里查。
 *
 * 用法：node dev/build-manual-content.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.url.replace(/^file:\/\/\/?/, ""), "..", "..");
const SRC = join(ROOT, "docs/iMac-2024-macOS15-知识库");
const OUT = join(ROOT, "mods/manual/content");

mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter((f) => /^0[1-8]-.*\.md$/.test(f)).sort();

const chapters = [];
const search = [];
const plain = (s) => s.replace(/[*`>#|]/g, "").replace(/\s+/g, " ").trim();

for (const file of files) {
    const id = file.slice(0, 2);
    // 源文件是 CRLF：不归一化时行尾锚点匹配不到，H1/H2 会全部漏掉
    let text = readFileSync(join(SRC, file), "utf8").replace(/\r\n?/g, "\n");

    // 1. 去掉抓取时写入的两行来源引用（App 里由「关于」统一说明来源）
    text = text.replace(/^> 来源：.*\n?/m, "").replace(/^> 章节：.*\n?/m, "").trim();

    // 2. 图片 + 紧随其后的图注 → 一条引用块（只保留文字，避免 404 与包体膨胀）
    text = text.replace(/!\[([^\]]*)\]\(images\/[^)]+\)\s*\n+\*图：([^\n]*)\*\s*\n?/g, (m, alt, caption) => {
        const label = (caption || alt || "").trim();
        return label ? `> 图：${label}\n\n` : "";
    });
    // 兼容没有图注行的图片
    text = text.replace(/!\[([^\]]*)\]\(images\/[^)]+\)\s*\n?/g, (m, alt) => (alt ? `> 图：${alt}\n\n` : ""));

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

const index = {
    generated: new Date().toISOString().slice(0, 10),
    source: "《iMac 入门指南》2024 年款 · macOS Sequoia 15（本地知识库镜像）",
    chapters,
    search,
};

writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 0) + "\n");
const total = chapters.reduce((n, c) => n + c.sections.length, 0);
console.log(`生成完成：${chapters.length} 章 / ${total} 节 / 搜索条目 ${search.length}`);
