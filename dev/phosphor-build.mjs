/**
 * phosphor-build.mjs — 由 assets/ui/phosphor/*.svg 生成 src/javascripts/ui/phosphor-icons-data.js
 *
 * 为什么要生成：界面取图标要同步（侧栏一渲染就得有图标，等 fetch 会闪一下），
 * 又必须支持 currentColor（图标要跟着悬停 / 选中态变颜色），所以运行时用内联 <svg>。
 * 内联就得把路径数据放进 JS，而路径数据的唯一来源是 assets/ui/phosphor/ 下的原版 SVG，
 * 本脚本负责把二者对齐，避免「拷了图标文件却没进 JS」或「手改 JS 后与文件不一致」。
 *
 * 用法：
 *   node dev/phosphor-build.mjs            写回 data 模块
 *   node dev/phosphor-build.mjs --check    只校验是否漂移，不写
 *
 * 新增图标：把 Phosphor 官方的 regular 版 SVG 原样拷进 assets/ui/phosphor/，
 * 文件名保持官方 kebab-case 名，然后跑一次本脚本。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = join(root, "assets/ui/phosphor");
const outFile = join(root, "src/javascripts/ui/phosphor-icons-data.js");
const check = process.argv.includes("--check");

const files = readdirSync(iconDir).filter((f) => f.toLowerCase().endsWith(".svg")).sort();
const problems = [];
const rows = [];

for (const file of files) {
    const name = file.replace(/\.svg$/i, "");
    const raw = readFileSync(join(iconDir, file), "utf8").trim();
    // 只收 Phosphor 的原版资产：256 网格 + currentColor，混进别的来源会带偏尺寸与描边约定
    const open = raw.match(/^<svg\b([^>]*)>/i);
    const close = raw.lastIndexOf("</svg>");
    if (!open || close < 0) { problems.push(`${file}：不是完整 SVG`); continue; }
    const attrs = open[1];
    if (!/viewBox="0 0 256 256"/.test(attrs)) problems.push(`${file}：viewBox 不是 0 0 256 256`);
    if (!/fill="currentColor"/.test(attrs)) problems.push(`${file}：根节点缺少 fill="currentColor"`);
    const body = raw.slice(open[0].length, close).trim();
    if (!body) { problems.push(`${file}：没有内容`); continue; }
    rows.push(`    ${JSON.stringify(name)}: ${JSON.stringify(body)},`);
}

if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join("\n"));
    console.log(`Phosphor 图标校验失败：${problems.length} 处`);
    process.exit(1);
}

const content = `/**
 * phosphor-icons-data.js — Phosphor Icons（regular 字重）的路径数据表（生成文件，勿手改）。
 *
 * 生成器：\`node dev/phosphor-build.mjs\`
 * 来源：assets/ui/phosphor/*.svg（原版资产，MIT，见同目录 LICENSE）
 * 键名：Phosphor 官方 kebab-case 名称，不带 .svg 后缀。
 * 取用请走 src/javascripts/ui/phosphor-icons.js，不要直接引用本文件。
 */

export const PHOSPHOR_ICONS = {
${rows.join("\n")}
};
`;

if (check) {
    let current = "";
    try {
        current = readFileSync(outFile, "utf8");
    } catch {
        console.log("  ✗ 缺少 src/javascripts/phosphor-icons-data.js，请跑 node dev/phosphor-build.mjs");
        process.exit(1);
    }
    if (current !== content) {
        console.log("  ✗ phosphor-icons-data.js 与 assets/ui/phosphor/ 不一致，请跑 node dev/phosphor-build.mjs");
        process.exit(1);
    }
    console.log(`Phosphor 图标一致 ✓（${files.length} 个）`);
    process.exit(0);
}

writeFileSync(outFile, content, "utf8");
console.log(`Phosphor 图标已生成 ✓（${files.length} 个 → src/javascripts/ui/phosphor-icons-data.js）`);
