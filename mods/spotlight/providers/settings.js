/**
 * providers/settings.js — 设置项结果（深链到具体面板与具体开关）
 *
 * 注册表条目：分组 setting、权重 50、匹配策略 rankOf(label/key/hint/group)、
 * 索引方式 惰性快照（settings.list，settings-changed 与语言切换失效）、异步 否、
 * 失败降级 返回 []。
 *
 * 深链：打开系统设置后派发 system-settings-open-pane，detail 带 { pane, key }。
 * key 是给面板层预留的「定位到具体开关」契约 —— 面板 UI 落地后即可滚动高亮，
 * 本模块不依赖它生效（面板现在只认 pane，多带字段向后兼容）。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { i18n } from "../../../src/javascripts/i18n.js";
import { glyph, assetIcon, FOLDER_ICON } from "../../../src/javascripts/paths.js";
import { rankOf } from "../engine.js";
import { createIndex } from "../index.js";

/**
 * 面板 id → 中文名与图标（沿用内核原表：刻意不 import 系统设置插件，
 * 面板清单是该插件私有物，静态表换来零耦合；名字以 i18n 注册表为准，这里只兜底）。
 */
const PANE_META = {
    general: { label: "通用", icon: glyph("gear") },
    storage: { label: "本地存储", icon: FOLDER_ICON },
    spotlight: { label: "聚焦", icon: glyph("magnifyingglass") },
    controlcenter: { label: "控制中心", icon: glyph("switch.2") },
    focus: { label: "专注模式", icon: glyph("moon.fill") },
    wallpaper: { label: "墙纸", icon: glyph("photo.circle") },
    appearance: { label: "外观", icon: glyph("moonphase.last.quarter.inverse") },
    display: { label: "显示器", icon: glyph("sun.max.fill") },
    dock: { label: "桌面与程序坞", icon: glyph("menubar.dock.rectangle") },
    siri: { label: "Siri", icon: assetIcon("Siri") },
    Siri: { label: "Siri", icon: assetIcon("Siri") },
    notifications: { label: "通知", icon: glyph("bell.badge.fill") },
    sound: { label: "声音", icon: glyph("speaker.wave.3.fill") },
    lockScreen: { label: "锁定屏幕", icon: glyph("lock.fill") },
    password: { label: "登录密码", icon: glyph("at") },
    privacy: { label: "隐私与安全性", icon: glyph("hand.raised.fill") },
    keyboard: { label: "键盘", icon: glyph("keyboard.fill") },
    mouse: { label: "鼠标", icon: glyph("magicmouse.fill") },
    plugins: { label: "App", icon: assetIcon("Automator") },
    debug: { label: "调试", icon: assetIcon("Console") },
    gear: { label: "通用", icon: glyph("gear") },
    magnifyingglass: { label: "聚焦", icon: glyph("magnifyingglass") },
    "switch.2": { label: "控制中心", icon: glyph("switch.2") },
    "bell.badge.fill": { label: "通知", icon: glyph("bell.badge.fill") },
    "photo.circle": { label: "墙纸", icon: glyph("photo.circle") },
    "magicmouse.fill": { label: "鼠标", icon: glyph("magicmouse.fill") },
    "keyboard.fill": { label: "键盘", icon: glyph("keyboard.fill") },
    "menubar.dock.rectangle": { label: "桌面与程序坞", icon: glyph("menubar.dock.rectangle") },
};

/** 面板名与图标：名字以系统设置注册进 i18n 的 ss.pane.<id> 为唯一来源。 */
function paneMeta(pane) {
    const meta = PANE_META[pane] || { label: pane || "设置", icon: glyph("gear") };
    return { icon: meta.icon, label: i18n.t(`ss.pane.${pane}`, meta.label) };
}

/** 打开系统设置的某个面板（先确保插件加载，再派深链事件）。 */
async function openPane(pane, key) {
    if (!pane) return;
    const ready = typeof globalThis.__pluginManagerReady === "function" ? globalThis.__pluginManagerReady() : Promise.resolve();
    await ready;
    const { openApp } = await import("../../../src/javascripts/plugin-manager.js");
    await openApp("系统设置");
    document.dispatchEvent(new CustomEvent("system-settings-open-pane", { detail: { pane, key }, bubbles: true }));
}

/** 设置索引：settings.list() 的惰性快照（隐藏项不进索引）。 */
const index = createIndex({
    name: "settings",
    build: () => settings.list().filter((def) => !def.hidden),
});

export const settingsProvider = {
    id: "settings",
    group: "setting",
    weight: 50,
    async: false,
    types: ["setting", "pane"],
    invalidate: () => index.invalidate(),
    async search(ctx) {
        const rows = await index.get();
        const hits = rows
            .map((def) => ({ def, score: rankOf(ctx.lower, def.label, def.key, def.hint, def.group) }))
            .filter((hit) => hit.score < 3)
            .slice(0, ctx.limit);
        const items = hits.map(({ def, score }) => ({
            type: "setting",
            score,
            label: String(def.label || def.key),
            sub: `${i18n.t("spotlight.settingsKind", "设置")} · ${paneMeta(def.pane).label}`,
            hint: def.hint ? String(def.hint) : i18n.t("spotlight.openPaneHint", "回车打开面板"),
            icon: paneMeta(def.pane).icon,
            action: () => openPane(def.pane, def.key),
        }));
        // 命中项按面板归并出「设置面板」条目（与原行为一致，最多 3 个）
        const panes = [...new Set(hits.map(({ def }) => def.pane).filter(Boolean))];
        panes.slice(0, 3).forEach((pane) => {
            const meta = paneMeta(pane);
            items.push({
                type: "pane",
                score: 2,
                label: `${meta.label}${i18n.t("spotlight.paneSuffix", "面板")}`,
                sub: i18n.t("spotlight.paneKind", "设置面板"),
                hint: i18n.t("spotlight.gotoHint", "回车前往"),
                icon: meta.icon,
                action: () => openPane(pane),
            });
        });
        return items;
    },
};
