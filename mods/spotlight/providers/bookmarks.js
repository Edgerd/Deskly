/**
 * providers/bookmarks.js — 浏览器书签结果（chrome.bookmarks，静默降级）
 *
 * 注册表条目：分组 bookmark、权重 50、匹配策略 rankOf(标题/URL)、
 * 索引方式 惰性全量快照（chrome.bookmarks.on* 事件失效）、异步 是、
 * 失败降级 API 不存在（非 Chromium/未授权）时 provider 自检返回 []，不留死入口。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { rankOf } from "../engine.js";
import { createIndex } from "../index.js";

/** chrome.bookmarks 可用性（MV3 声明了 bookmarks 权限的 Chromium 才有）。 */
function api() {
    return (typeof chrome !== "undefined" && chrome.bookmarks && chrome.bookmarks.getTree) ? chrome.bookmarks : null;
}

/** 书签树摊平成 [{title,url}]（只收有 URL 的叶子，文件夹不进结果）。 */
function flatten(nodes, out = []) {
    for (const node of nodes || []) {
        if (node.url) out.push({ title: node.title || node.url, url: node.url });
        if (node.children) flatten(node.children, out);
    }
    return out;
}

/** 书签索引：第一次搜索才拉整棵树；变更事件由下方监听置失效。 */
const index = createIndex({
    name: "bookmarks",
    build: () => new Promise((resolve) => {
        const bm = api();
        if (!bm) { resolve([]); return; }
        bm.getTree()
            .then((tree) => resolve(flatten(tree)))
            .catch(() => resolve([])); // 读失败按空索引，不留死入口
    }),
});

// 书签变更 → 索引失效（API 存在才挂监听，静默降级原则）
const bm = api();
if (bm && typeof bm.onChanged !== "undefined") {
    ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportEnded"].forEach((eventName) => {
        try { bm[eventName]?.addListener(() => index.invalidate()); } catch { /* 单项监听失败不影响其它 */ }
    });
}

/** 书签结果图标：Safari 彩色图标（站内资源，无外链 CSP/离线问题）。 */
import { assetIcon } from "../../../src/javascripts/paths.js";
const BOOKMARK_ICON = assetIcon("Safari");

export const bookmarksProvider = {
    id: "bookmarks",
    group: "bookmark",
    weight: 50,
    async: true,
    types: ["bookmark"],
    invalidate: () => index.invalidate(),
    async search(ctx) {
        if (!api()) return []; // 环境不支持：静默降级
        const rows = await index.get();
        return rows
            .map((row) => ({ row, score: rankOf(ctx.lower, row.title, row.url) }))
            .filter((hit) => hit.score < 3)
            .slice(0, ctx.limit)
            .map(({ row, score }) => ({
                type: "bookmark",
                score,
                label: row.title,
                sub: row.url,
                hint: i18n.t("spotlight.openBrowserHint", "回车在浏览器打开"),
                icon: BOOKMARK_ICON,
                action: () => window.open(row.url, "_blank", "noopener"),
            }));
    },
};
