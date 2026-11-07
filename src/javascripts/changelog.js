/**
 * changelog.js — 更新日志数据层：读取系统与插件的 changelog.json、按版本分组、算相对时间。
 *
 * 为什么单独成模块：「新功能」同时出现在系统设置与 App Store 两处，
 * 数据读取、版本分组与相对时间的算法只有一份，界面各自渲染。
 *
 * 数据约定（全项目统一，由 dev/changelog-check.mjs 校验）：
 * - 系统日志在 ./docs/changelog.json；每个插件的日志在 mods/<id>/changelog.json
 *   （ZIP 安装的第三方插件若随包带了同名文件，也按同一结构读取）。
 * - 结构：{ id, name, version, entries: [{ version, date, type, items[] }] }，
 *   version 按发布倒序；type ∈ added / improved / fixed；version 为 "未发布" 表示尚未发版的条目。
 * - 条目只写「新增了什么 / 优化了什么 / 修复了什么」，不写文件名与实现细节。
 *
 * 界面文案（标题、类型名、相对时间）由本模块自带的四语词条提供，注册进 i18n；
 * 条目正文以日志文件里撰写的中文为准，不逐条翻译。
 */

import { i18n } from "./i18n.js";
import { modFile } from "./paths.js";

/** 条目类型（顺序即展示顺序）。 */
export const CHANGELOG_TYPES = ["added", "improved", "fixed"];

/** 未发版条目的版本号写法。 */
export const UNRELEASED = "未发布";

/** 系统日志的地址（相对站点根，解析基准是 index.html）。 */
export const SYSTEM_CHANGELOG_URL = "./docs/changelog.json";

/** 四语词条：标题、类型名、相对时间单位。 */
const MESSAGES = {
    "zh-CN": {
        cl: {
            title: "新功能",
            viewFull: "查看完整更新日志",
            version: "版本",
            unreleased: "未发布",
            empty: "暂无更新记录",
            loadFailed: "更新日志暂时无法读取",
            type: { added: "新增", improved: "优化", fixed: "修复" },
            time: {
                today: "今天", yesterday: "昨天",
                daysAgo: "{n} 天前", weeksAgo: "{n} 周前",
                monthsAgo: "{n} 个月前", yearsAgo: "{n} 年前",
            },
        },
    },
    en: {
        cl: {
            title: "What's New",
            viewFull: "View Full Changelog",
            version: "Version",
            unreleased: "Unreleased",
            empty: "No release notes yet",
            loadFailed: "Release notes are unavailable right now",
            type: { added: "New", improved: "Improved", fixed: "Fixed" },
            time: {
                today: "Today", yesterday: "Yesterday",
                daysAgo: "{n} days ago", weeksAgo: "{n} weeks ago",
                monthsAgo: "{n} months ago", yearsAgo: "{n} years ago",
            },
        },
    },
    "ja-JP": {
        cl: {
            title: "新機能",
            viewFull: "すべての更新履歴を見る",
            version: "バージョン",
            unreleased: "未公開",
            empty: "更新履歴はまだありません",
            loadFailed: "更新履歴を読み込めませんでした",
            type: { added: "追加", improved: "改善", fixed: "修正" },
            time: {
                today: "今日", yesterday: "昨日",
                daysAgo: "{n}日前", weeksAgo: "{n}週間前",
                monthsAgo: "{n}か月前", yearsAgo: "{n}年前",
            },
        },
    },
    cat: {
        cl: {
            title: "新功能喵",
            viewFull: "看完整的更新日志喵~",
            version: "版本",
            unreleased: "还没发布喵",
            empty: "还没有更新记录喵~",
            loadFailed: "更新日志读不出来喵~",
            type: { added: "新增喵", improved: "优化喵", fixed: "修复喵" },
            time: {
                today: "今天喵", yesterday: "昨天喵",
                daysAgo: "{n} 天前喵", weeksAgo: "{n} 个星期前喵",
                monthsAgo: "{n} 个月前喵", yearsAgo: "{n} 年前喵",
            },
        },
    },
};

// 模块一被引用就注册词条；老内核没有 registerMessagesAll 时静默退回中文回退。
try {
    if (typeof i18n.registerMessagesAll === "function") i18n.registerMessagesAll(MESSAGES);
} catch (err) {
    console.warn("[changelog] 注册文案失败", err);
}

/** 取词条（本模块内部统一入口，始终带中文回退）。 */
function t(key, fallback) {
    return i18n.t(key, fallback);
}

/** 把词条里的 {n} 换成数字。 */
function tn(key, fallback, n) {
    return t(key, fallback).split("{n}").join(String(n));
}

/**
 * 校验并清洗一份 changelog.json 的原始内容。
 * 非法条目整条丢弃（不让一条坏数据掀翻整份日志）；文件整体不合法时返回 null。
 * @param {object} data 原始 JSON
 * @returns {{id:string, name:string, version:string, entries:Array}|null}
 */
function normalize(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (typeof data.id !== "string" || !data.id) return null;
    if (typeof data.name !== "string" || !data.name) return null;
    const raw = Array.isArray(data.entries) ? data.entries : [];
    const entries = [];
    raw.forEach((e) => {
        if (!e || typeof e !== "object") return;
        const version = String(e.version || "").trim();
        const date = String(e.date || "").trim();
        const type = CHANGELOG_TYPES.includes(e.type) ? e.type : "";
        const items = Array.isArray(e.items)
            ? e.items.map((s) => String(s == null ? "" : s).trim()).filter(Boolean)
            : [];
        if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !type || !items.length) return;
        entries.push({ version, date, type, items });
    });
    return { id: data.id, name: data.name, version: String(data.version || ""), entries };
}

/** 拉一份 JSON；失败、404、非 JSON 一律按 null 处理（界面据此隐藏区块而不是报错）。 */
async function fetchJson(url) {
    try {
        const res = await fetch(url);
        if (!res || !res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

let systemCache = null;
const pluginCache = new Map();

/**
 * 读取系统更新日志（docs/changelog.json），同一会话只拉一次。
 * @returns {Promise<object|null>} 清洗后的日志
 */
export function getSystemChangelog() {
    if (!systemCache) systemCache = fetchJson(SYSTEM_CHANGELOG_URL).then(normalize);
    return systemCache;
}

/**
 * 读取某个插件的更新日志（mods/<id>/changelog.json）。
 * 内置插件走磁盘文件，ZIP 安装的插件由 Service Worker 从本地库回源，同一条 fetch 路径。
 * 插件没带日志（404）时返回 null —— 与「日志为空」区分：没文件就不渲染对应区块。
 * @param {string} id 插件 id
 * @returns {Promise<object|null>} 清洗后的日志
 */
export function getPluginChangelog(id) {
    if (!pluginCache.has(id)) {
        pluginCache.set(id, fetchJson(modFile(id, "changelog.json")).then(normalize));
    }
    return pluginCache.get(id);
}

/**
 * 把条目按版本分组合并（保持文件里的倒序），同版本内类型按 新增 → 优化 → 修复 排。
 * @param {object|null} log 清洗后的日志
 * @returns {Array<{version:string, date:string, unreleased:boolean, types:Array<{type:string, items:string[]}>}>}
 */
export function versionGroups(log) {
    const groups = [];
    const byVersion = new Map();
    ((log && log.entries) || []).forEach((e) => {
        let g = byVersion.get(e.version);
        if (!g) {
            g = { version: e.version, date: e.date, unreleased: e.version === UNRELEASED, types: [] };
            byVersion.set(e.version, g);
            groups.push(g);
        }
        if (e.date > g.date) g.date = e.date;
        let bucket = g.types.find((x) => x.type === e.type);
        if (!bucket) {
            bucket = { type: e.type, items: [] };
            g.types.push(bucket);
        }
        bucket.items.push(...e.items);
    });
    groups.forEach((g) => g.types.sort((a, b) => CHANGELOG_TYPES.indexOf(a.type) - CHANGELOG_TYPES.indexOf(b.type)));
    return groups;
}

/**
 * 最新一个版本组（日志按倒序撰写，第一组即最新）。
 * @param {object|null} log 清洗后的日志
 * @returns {object|null} 版本组
 */
export function latestGroup(log) {
    return versionGroups(log)[0] || null;
}

/**
 * 一个版本组的摘要行：优先取「新增」的第一条，其次「优化」，最后「修复」。
 * @param {object|null} group 版本组
 * @returns {string} 摘要文本（无内容时为空串）
 */
export function summaryOf(group) {
    if (!group || !group.types.length) return "";
    return group.types[0].items[0] || "";
}

/**
 * 相对时间（"2 天前"）：按本地日期的整天差计算，不算小时。
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} [now] 当前时刻（测试可注入）
 * @returns {string} 本地化文本；日期非法时原样返回
 */
export function relativeTime(dateStr, now = Date.now()) {
    const target = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(target.getTime())) return String(dateStr || "");
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.round((today.getTime() - target.getTime()) / 86400000));
    if (days <= 0) return t("cl.time.today", "今天");
    if (days === 1) return t("cl.time.yesterday", "昨天");
    if (days < 7) return tn("cl.time.daysAgo", "{n} 天前", days);
    if (days < 30) return tn("cl.time.weeksAgo", "{n} 周前", Math.floor(days / 7));
    if (days < 365) return tn("cl.time.monthsAgo", "{n} 个月前", Math.floor(days / 30));
    return tn("cl.time.yearsAgo", "{n} 年前", Math.floor(days / 365));
}

/**
 * 版本号的展示写法：未发布显示本地化标签，其余显示数字版本。
 * @param {string} version 日志里的版本号
 * @returns {string} 展示文本
 */
export function versionLabel(version) {
    return version === UNRELEASED ? t("cl.unreleased", "未发布") : version;
}

/** 词条表导出给校验脚本做四语一致性比对（界面代码不需要直接用）。 */
export const CHANGELOG_MESSAGES = MESSAGES;
