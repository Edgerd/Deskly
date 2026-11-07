/**
 * providers/files.js — 文件与文件夹结果（走文件系统层，带缓存与失效策略）
 *
 * 注册表条目：分组 file、权重 50、匹配策略 rankOf(文件名/路径) + kind:/ext: 过滤、
 * 索引方式 每个顶层目录一把惰性 TTL 索引（30s）+ 最近使用一把（30s），
 * 异步 是、失败降级 单个目录读失败只少一个来源（权限待补/未挂载），绝不拖垮搜索。
 *
 * 失效策略：TTL 到期自动重建；面板每次打开由 shell 调 invalidate() 强制刷新；
 * 「别每键扫盘」由索引缓存保证 —— 连续输入只在 TTL 内读内存行。
 * AppData 属插件内部目录，不参与搜索。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { VFS } from "../../../src/javascripts/vfs.js";
import { FOLDER_ICON, GENERIC_DOC_ICON } from "../../../src/javascripts/paths.js";
import { rankOf } from "../engine.js";
import { createIndex } from "../index.js";

/** 目录与最近使用的 TTL：30 秒内的连续输入不重复触盘。 */
const TTL = 30_000;

/** 每个非内部顶层目录一把惰性索引（文档/下载/图片/桌面；挂载外部目录时同树生效）。 */
const folderIndexes = new Map();
function folderIndex(def) {
    if (!folderIndexes.has(def.path)) {
        folderIndexes.set(def.path, createIndex({
            name: `files:${def.path}`,
            ttl: TTL,
            build: async () => {
                const entries = await VFS.list(def.path);
                return (entries || []).map((entry) => ({ entry, where: def.label }));
            },
        }));
    }
    return folderIndexes.get(def.path);
}

/** 最近使用文件索引（与目录同 TTL）。 */
const recentIndex = createIndex({
    name: "files:recent",
    ttl: TTL,
    build: async () => ((await VFS.getRecentFiles(80)) || []).map((entry) => ({ entry, where: "最近使用" })),
});

/** 查询词拆出过滤词：kind:file|folder、ext:png（大小写不敏感），其余是模糊匹配词。 */
function parseQuery(lower) {
    let kind = null;
    let ext = null;
    const words = lower.split(/\s+/).filter((word) => {
        if (/^kind:(file|folder)$/.test(word)) { kind = word.slice(5); return false; }
        if (/^ext:[a-z0-9]+$/.test(word)) { ext = word.slice(4); return false; }
        return true;
    });
    return { kind, ext, text: words.join(" ") };
}

/** 在访达里定位条目：打开访达后派 navigate（文件落父目录，文件夹进自身）。 */
async function revealInFinder(entry) {
    const { openApp } = await import("../../../src/javascripts/plugin-manager.js");
    await openApp("访达");
    const path = entry.type === "folder" ? entry.path : entry.path.replace(/\/[^/]*$/, "") || "/";
    const win = document.getElementById("访达");
    if (win) {
        win.dispatchEvent(new CustomEvent("finder-command", { detail: { command: "navigate", args: { path } }, bubbles: true }));
        return;
    }
    const navigate = (globalThis.__menuActions || {}).finderNavigate;
    if (typeof navigate === "function") navigate(path);
}

export const filesProvider = {
    id: "files",
    group: "file",
    weight: 50,
    async: true,
    types: ["file", "folder"],
    invalidate() {
        folderIndexes.forEach((idx) => idx.invalidate());
        recentIndex.invalidate();
    },
    async search(ctx) {
        try {
            await VFS.init(); // 幂等：访达没打开过时补齐根目录装载
        } catch {
            return []; // 文件系统整体不可用：降级为空，其它类型照常
        }
        const { kind, ext, text } = parseQuery(ctx.lower);
        const found = [];
        const push = ({ entry, where }) => {
            if (kind && entry.type !== kind) return;
            if (ext && !String(entry.name).toLowerCase().endsWith(`.${ext}`)) return;
            if (!text) return;
            const score = rankOf(text, entry.name, entry.path);
            if (score === 3) return;
            found.push({ entry, where, score });
        };
        const sources = [recentIndex.get()];
        for (const def of Object.values(VFS.TOP_FOLDERS)) {
            if (def.internal) continue;
            sources.push(folderIndex(def).get());
        }
        // 逐来源隔离：一个目录挂了（权限待补）只少它的结果
        const settled = await Promise.allSettled(sources);
        for (const outcome of settled) {
            if (outcome.status === "fulfilled") outcome.value.forEach(push);
        }
        const seen = new Set();
        return found
            .sort((a, b) => a.score - b.score)
            .filter(({ entry }) => {
                if (seen.has(entry.path)) return false;
                seen.add(entry.path);
                return true;
            })
            .slice(0, ctx.limit)
            .map(({ entry, where, score }) => ({
                type: entry.type === "folder" ? "folder" : "file",
                score,
                label: String(entry.name),
                sub: `${where} · ${entry.path}`,
                hint: VFS.formatDate ? VFS.formatDate(entry.modified) : i18n.t("spotlight.revealHint", "回车在访达中打开"),
                icon: entry.type === "folder" ? FOLDER_ICON : GENERIC_DOC_ICON,
                action: () => revealInFinder(entry),
            }));
    },
};
