/**
 * providers/apps.js — 应用类结果（含系统应用与最近使用提升）
 *
 * 注册表条目：分组 app、权重 50、匹配策略 rankOf(名称/窗口名/显示名/id/appId)、
 * 索引方式 惰性快照（listApps，事件失效）、异步 是（打开时取图标）、
 * 失败降级 返回 []（注册表未就绪时搜索其它类型不受影响）。
 *
 * 可见性语义：启动台/设置里隐藏的系统应用**可搜到**（macOS 行为），
 * 但 entry 非 window/fullscreen 的「背景型」应用没有可打开的窗口，不出结果。
 * 最近打开过的应用（程序坞最近区同源数据）在组内提升权重。
 */

import { listApps, isPluginEnabled, displayNameFor } from "../../../src/javascripts/app-registry.js";
import { i18n } from "../../../src/javascripts/i18n.js";
import { GENERIC_APP_ICON } from "../../../src/javascripts/paths.js";
import { rankOf } from "../engine.js";
import { createIndex } from "../index.js";

/** 程序坞「最近使用的应用」存储键（dock.js 同源，只读不写）。 */
const DOCK_RECENTS_KEY = "webstartos_dock_recents";

/** plugin-manager 动态导入：与内核侧同一理由，避免静态说明符成环。 */
let pmModule = null;
function pluginManager() {
    if (!pmModule) pmModule = import("../../../src/javascripts/plugin-manager.js");
    return pmModule;
}

/** 应用索引：第一次搜索才建，插件装卸/启停与语言切换由 shell 广播失效。 */
const index = createIndex({
    name: "apps",
    build: () => listApps()
        .filter((rec) => {
            if (!isPluginEnabled(rec.id)) return false; // 禁用的搜到也打不开，不如不出
            const entry = (rec.app && rec.app.entry) || rec.manifest.entry;
            return entry === "window" || entry === "fullscreen";
        })
        .map((rec) => ({
            appId: rec.appId,
            id: rec.id,
            windowName: rec.windowName,
            name: rec.name,
            displayName: rec.displayName || displayNameFor(rec.appId),
            subApp: Boolean(rec.app),
        })),
});

/** 最近使用的应用名（程序坞最近区），读失败按空表。 */
function recentNames() {
    try {
        const parsed = JSON.parse(localStorage.getItem(DOCK_RECENTS_KEY) || "[]");
        return Array.isArray(parsed) ? new Set(parsed) : new Set();
    } catch {
        return new Set();
    }
}

/** 打开应用（经 plugin-manager 统一入口；身份名跨语言不变）。 */
async function openApp(rec) {
    const { openApp } = await pluginManager();
    return openApp(rec.windowName || rec.name);
}

export const appsProvider = {
    id: "apps",
    group: "app",
    weight: 50,
    async: true,
    types: ["app"],
    invalidate: () => index.invalidate(),
    async search(ctx) {
        const rows = await index.get();
        const recents = recentNames();
        const hits = rows
            .map((rec) => ({ rec, score: rankOf(ctx.lower, rec.name, rec.windowName, rec.displayName, rec.id, rec.appId) }))
            .filter((hit) => hit.score < 3)
            .slice(0, ctx.limit);
        if (!hits.length) return [];
        const { getIconForName } = await pluginManager().catch(() => ({}));
        return hits.map(({ rec, score }) => {
            const isRecent = recents.has(rec.windowName) || recents.has(rec.name);
            return {
                type: "app",
                score,
                weight: isRecent ? 10 : 50, // 最近使用在组内靠前（macOS「最近使用」手感）
                label: rec.displayName || rec.name || rec.appId,
                sub: rec.subApp
                    ? `${displayNameFor(rec.id)} · ${i18n.t("spotlight.subApp", "子应用")}`
                    : (isRecent ? i18n.t("spotlight.recentApp", "最近使用") : i18n.t("spotlight.appKind", "应用程序")),
                hint: i18n.t("spotlight.openHint", "回车打开"),
                icon: (typeof getIconForName === "function" && getIconForName(rec.appId)) || GENERIC_APP_ICON,
                action: () => openApp(rec),
            };
        });
    },
};
