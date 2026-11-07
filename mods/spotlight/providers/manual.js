/**
 * providers/manual.js — 使用手册结果（章节深链）
 *
 * 注册表条目：分组 manual、权重 50、匹配策略 rankOf(小节/摘要/章节名)、
 * 索引方式 惰性 fetch 一次（约 70KB，失败记住结果不再重复请求）、异步 是、
 * 失败降级 索引不可用时返回 []。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { glyph, modFile } from "../../../src/javascripts/paths.js";
import { rankOf } from "../engine.js";
import { createIndex } from "../index.js";

/** 手册索引：dev/build-manual-content.mjs 生成的检索表。 */
const index = createIndex({
    name: "manual",
    build: () => fetch(modFile("manual", "content/index.json"))
        .then((res) => (res.ok ? res.json() : { search: [] }))
        .then((data) => (data && Array.isArray(data.search) ? data.search : []))
        .catch(() => []),
});

/** 打开手册并跳到该节（等外壳中栏出现后再派发，慢机器不丢跳转）。 */
async function openManualAt(entry) {
    const { openApp } = await import("../../../src/javascripts/plugin-manager.js");
    await openApp("Mac 使用手册");
    const jump = () => document.dispatchEvent(new CustomEvent("manual-open", {
        detail: { chapter: entry.chapter, h: entry.h }, bubbles: true,
    }));
    let tries = 0;
    const tick = () => {
        if (document.querySelector(".manual__chapters .manual__row")) { setTimeout(jump, 60); return; }
        if (tries++ < 50) setTimeout(tick, 100);
    };
    tick();
}

export const manualProvider = {
    id: "manual",
    group: "manual",
    weight: 50,
    async: true,
    types: ["manual"],
    invalidate: () => index.invalidate(),
    async search(ctx) {
        const rows = await index.get();
        return rows
            .map((entry) => ({ entry, score: rankOf(ctx.lower, entry.section, entry.text, entry.chapterTitle) }))
            .filter((hit) => hit.score < 3)
            .sort((a, b) => a.score - b.score)
            .slice(0, ctx.limit)
            .map(({ entry, score }) => ({
                type: "manual",
                score,
                label: entry.section,
                sub: `${entry.chapterTitle} · ${i18n.t("spotlight.manualHint", "手册")}`,
                icon: glyph("document.blue"),
                action: () => openManualAt(entry),
            }));
    },
};
