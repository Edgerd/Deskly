/**
 * package-plugin.mjs — 把 mods/<id>/ 导出成可安装的插件 ZIP
 *
 * 用法：
 *   node dev/package-plugin.mjs office        # 产物 dist/office-<version>.zip
 *   node dev/package-plugin.mjs               # 导出全部内置插件
 *
 * 内置插件的**唯一真源就是 `mods/<id>/`**（扩展加载时整目录一起打进去），
 * 这个脚本只是把同一个目录再导出成一份 ZIP，供他人安装或跨机分发用 ——
 * 不存在第二份源码，也就不会出现「改了 mods/ 却拿旧 ZIP 去装」的分裂。
 *
 * 为什么自带打包脚本而不用 Compress-Archive：PowerShell 打出的条目分隔符历史上是 `\`，
 * 而安装器与 `sw.js` 都按 `mods/<id>/<file>` 的 `/` 路径命中，包内条目名必须是 POSIX 斜杠。
 * JSZip 与运行时用的是同一份库（assets/vendor/jszip.min.js），一致性最好。
 *
 * 体积红线：App Store 安装器有 10MB 解包上限（src/javascripts/app-store.js:MAX_TOTAL_BYTES），
 * 超限直接拒绝安装，所以打包后立刻按同一条规则校验并打印。
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const JSZip = require("../assets/vendor/jszip.min.js");

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_ROOT = join(REPO_ROOT, "mods");
const DIST_DIR = join(REPO_ROOT, "dist");
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** 递归收集目录内的文件（跳过隐藏文件与 node_modules） */
function walk(dir, base = "") {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const full = join(dir, name);
        const rel = posix.join(base, name.split("\\").join("/"));
        if (statSync(full).isDirectory()) out.push(...walk(full, rel));
        else out.push({ full, rel });
    }
    return out;
}

/**
 * 打包前的完整性校验：清单声明的文件与代码里的相对依赖必须都在包里/仓库里。
 *
 * 这一关存在的理由：插件运行时只拿到 ZIP 里那些文件，少打一个 CSS 或一个
 * `import("./codecs/x.js")` 目标，表现为「窗口开出来了但空白/无样式」，
 * 装完还不一定看得出错在哪，所以在构建期就断掉。
 *
 * 两类引用分别校验：
 * - `./x.js` 与 `useStyle(import.meta.url, "x.css")`、CSS `@import` → 必须落在插件目录内；
 * - `../../src/javascripts/x.js`（宿主模块）→ 按运行时 `mods/<id>/` 深度解析后必须在仓库里存在。
 *
 * @param {string} id 插件 id
 * @param {Array<{full: string, rel: string}>} files 已收集的文件
 * @param {object} manifest 清单
 * @returns {string[]} 问题列表（空数组即通过）
 */
function verifyPlugin(id, files, manifest) {
    const present = new Set(files.map((f) => f.rel));
    const problems = [];
    const miss = (what, where) => problems.push(`${what} 缺失（${where}）`);

    const declared = [["style", manifest.style || "style.css"], ["script", manifest.script || "script.js"], ["icon", manifest.icon]];
    if (!Array.isArray(manifest.apps) || !manifest.apps.length) declared.push(["main", manifest.main || "index.html"]);
    (manifest.apps || []).forEach((a) => {
        declared.push([`apps[${a.id}].main`, a.main || `${a.id}.html`]);
        if (a.icon) declared.push([`apps[${a.id}].icon`, a.icon]);
    });
    // 详情图在安装时缺了只算提醒，但导出前必须齐 —— 打进去就是缺一块界面
    ((manifest.store || {}).screenshots || []).forEach((s) => declared.push(["store.screenshots", s]));
    for (const [field, value] of declared) {
        if (!value) continue;
        const rel = String(value).replace(/^\.\//, "");
        if (!present.has(rel)) miss(`清单字段 ${field} 指向的 ${rel}`, "manifest.json");
    }

    const FROM_SPEC = /(?:\bfrom|\bimport)\s*["'](\.[^"']+)["']/g;
    const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    const USE_STYLE = /\buseStyle\(\s*import\.meta\.url\s*,\s*["']([^"']+)["']/g;
    const CSS_IMPORT = /@import\s+(?:url\()?\s*["']([^"']+)["']/g;
    for (const f of files) {
        const isJs = /\.(js|mjs)$/.test(f.rel);
        const isCss = /\.css$/.test(f.rel);
        if (!isJs && !isCss) continue;
        const text = readFileSync(f.full, "utf8");
        const ownDir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
        const specs = new Set();
        for (const re of isJs ? [FROM_SPEC, DYNAMIC_IMPORT, USE_STYLE] : [CSS_IMPORT]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text))) specs.add(m[1]);
        }
        for (const spec of specs) {
            if (spec.startsWith("../../")) {
                // 宿主依赖：按运行时位置 mods/<id>/ 解析（与源码位置同深度），越过站根即非法
                const resolved = posix.normalize(posix.join("mods", id, spec));
                if (resolved.startsWith("..")) { miss(`宿主依赖 ${spec} 越过站点根之外`, f.rel); continue; }
                if (!existsSync(join(REPO_ROOT, resolved))) miss(`宿主依赖 ${spec}`, f.rel);
                continue;
            }
            if (!spec.startsWith("./")) continue;
            const rel = posix.normalize(posix.join(ownDir, spec));
            if (!present.has(rel)) miss(`代码引用的 ${rel}`, f.rel);
        }
    }
    return problems;
}

/**
 * 导出一个插件目录。
 * @param {string} id 插件目录名
 * @returns {{zipName: string, target: string, files: object[], total: number, zip: object}} 打包任务
 */
function pack(id) {
    const dir = join(SRC_ROOT, id);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (manifest.id !== id) throw new Error(`${id}: manifest.id(${manifest.id}) 与目录名不一致，安装会落到另一个 id`);
    const files = walk(dir);
    if (!files.some((f) => f.rel === "manifest.json")) throw new Error(`${id}: manifest.json 不在包根`);

    const problems = verifyPlugin(id, files, manifest);
    if (problems.length) throw new Error(`${id}: 完整性校验未通过\n    - ${problems.join("\n    - ")}`);

    const zip = new JSZip();
    let total = 0;
    for (const f of files) {
        const buf = readFileSync(f.full);
        total += buf.length;
        zip.file(f.rel, buf);
    }
    return {
        zipName: `${id}-${manifest.version || "0.0.0"}.zip`,
        target: join(DIST_DIR, `${id}-${manifest.version || "0.0.0"}.zip`),
        files, total, zip,
    };
}

const wanted = process.argv[2];
const ids = readdirSync(SRC_ROOT).filter((name) => {
    if (!statSync(join(SRC_ROOT, name)).isDirectory()) return false;
    if (!existsSync(join(SRC_ROOT, name, "manifest.json"))) return false;
    return !wanted || name === wanted;
});

if (!ids.length) {
    console.error(wanted ? `未找到内置插件 mods/${wanted}/（或缺 manifest.json）` : "mods/ 下没有可导出的插件");
    process.exit(1);
}
if (wanted && !ids.length) process.exit(1);

if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true });

for (const id of ids) {
    const job = pack(id);
    const bytes = await job.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
    writeFileSync(job.target, bytes);
    const flag = job.total > MAX_TOTAL_BYTES ? "  ✗ 解包后超过 10MB，安装器会拒绝" : "";
    console.log(`${job.zipName}  ${job.files.length} 个文件  解包 ${(job.total / 1024 / 1024).toFixed(2)}MB → zip ${(bytes.length / 1024 / 1024).toFixed(2)}MB${flag}`);
}
