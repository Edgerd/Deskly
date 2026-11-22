/**
 * notifications/store.js —— 通知 store（F-17 底座）
 *
 * 原版依据：docs/iMac-2024-macOS15-知识库/pages/21-Mac_上的“通知中心”.md
 * macOS 通知中心的所有通知（含被专注模式静音的）都落在同一份可回看的列表里；
 * 旧实现「横幅期间才存、勿扰只留计数」与之相悖。
 *
 * 职责：
 * - 通知记录统一落库（含 muted 标记），横幅与通知中心面板共用同一份 store；
 * - 保留最近 50 条 / 7 天（写入时剪枝）；
 * - 按应用开关（允许通知 / 是否在通知中心显示）由 ui/notification.js 读取执行，
 *   本模块只负责登记配置项（G7：所有配置走 settings.defineMany）。
 *
 * 持久化：复用 settings 的 localStorage 槽（G7 登记，同 controlcenter.defineOwnSettings）。
 */

import { settings } from "../settings.js";

/** 最多保留条数（原版通知中心回看范围，取 50 条） */
export const MAX_RECORDS = 50;
/** 保留天数 */
export const MAX_AGE_DAYS = 7;

const RECORD_EVENT = "notify-store-change";

/* ── G7 登记 ──
 * notify.history / notify.apps 是数据记录，不进设置界面（hidden）；
 * notify.bannerStyle 是真实可配置项（横幅样式：横幅/提醒/无，对应 macOS 三态）。 */
settings.defineMany([
    { key: "notify.history", type: "json", slot: "notify-history", default: [], hidden: true, label: "通知历史", owner: "system" },
    { key: "notify.apps", type: "json", slot: "notify-apps", default: {}, hidden: true, label: "应用通知", owner: "system" },
    {
        key: "notify.bannerStyle", type: "string", values: ["banner", "alert", "none"],
        valuesLabel: ["横幅", "提醒", "无"], default: "banner",
        label: "横幅样式", owner: "system", pane: "notifications", group: "横幅", order: 22, control: "dropdown",
    },
]);

/** 读全部记录（已按 ts 降序，仅保留合法对象） */
function readAll() {
    const raw = settings.get("notify.history", []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((r) => r && typeof r === "object" && typeof r.ts === "number");
}

/** 写入 + 剪枝（50 条 / 7 天）：按 ts 降序取最新 50 条，保证新记录不被旧记录挤掉 */
function writeAll(list) {
    const now = Date.now();
    const live = list
        .filter((r) => r && typeof r.ts === "number")
        .filter((r) => now - r.ts <= MAX_AGE_DAYS * 86400000)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_RECORDS);
    settings.set("notify.history", live, { source: "notify-store" });
    return live;
}

function emitChange(action, id) {
    document.dispatchEvent(new CustomEvent(RECORD_EVENT, { detail: { action, id } }));
}

function newId() {
    return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const store = {
    /** 事件名（供外部订阅等价 API） */
    CHANGE_EVENT: RECORD_EVENT,

    /**
     * 落一条通知记录。
     * @param {{appId?:string, appName?:string, icon?:string, title:string, text?:string, muted?:boolean, type?:string}} rec
     * @returns {object} 写入后的记录（含 id/ts）
     */
    add(rec) {
        const record = {
            id: newId(),
            ts: Date.now(),
            appId: typeof rec?.appId === "string" ? rec.appId : "",
            appName: typeof rec?.appName === "string" ? rec.appName : "",
            icon: typeof rec?.icon === "string" ? rec.icon : "",
            title: String(rec?.title ?? ""),
            text: String(rec?.text ?? ""),
            muted: Boolean(rec?.muted),
            // 动态类型：程序坞固定入口按白名单判定是否可拖入（见 notifications/pins.js）。
            // 旧记录没有该字段，读取方按 "app" 处理。
            type: typeof rec?.type === "string" && rec.type ? rec.type : "app",
        };
        writeAll([...readAll(), record]);
        emitChange("add", record.id);
        return record;
    },

    /** 全量列表（ts 降序 = 最新在前） */
    list() {
        return readAll().sort((a, b) => b.ts - a.ts);
    },

    /** 删除单条 */
    remove(id) {
        const rest = readAll().filter((r) => r.id !== id);
        writeAll(rest);
        emitChange("remove", id);
    },

    /** 清空全部（通知中心「全部清除」） */
    clearAll() {
        writeAll([]);
        emitChange("clear", null);
    },

    /** 当前被专注模式静音的条数（供系统设置「拦截统计」展示） */
    mutedCount() {
        return readAll().filter((r) => r.muted).length;
    },

    /** 静音条目转正（用户查看过拦截统计后，这些记录按普通通知回看） */
    clearMutedFlags() {
        const rest = readAll().map((r) => (r.muted ? { ...r, muted: false } : r));
        writeAll(rest);
        emitChange("unmute", null);
    },

    /** 订阅变更（返回退订函数）；等价于 document 上的 RECORD_EVENT */
    subscribe(fn) {
        const handler = (e) => fn(e?.detail ?? {}, e);
        document.addEventListener(RECORD_EVENT, handler);
        return () => document.removeEventListener(RECORD_EVENT, handler);
    },

    /** 按应用配置：{ appId: { enabled, inCenter } }（缺省 = 允许 + 显示） */
    appConfig(appId) {
        const map = settings.get("notify.apps", {});
        const cfg = (appId && map && typeof map === "object" ? map[appId] : null) || {};
        return {
            enabled: cfg.enabled !== false,
            inCenter: cfg.inCenter !== false,
        };
    },

    /** 写按应用配置（系统设置「应用通知」用） */
    setAppConfig(appId, patch) {
        if (!appId) return;
        const map = { ...(settings.get("notify.apps", {}) || {}) };
        const cur = { enabled: true, inCenter: true, ...(map[appId] || {}) };
        map[appId] = { ...cur, ...patch };
        settings.set("notify.apps", map, { source: "notify-store" });
    },
};
