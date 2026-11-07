/**
 * default-apps.js — 文件类型 / 协议 → 默认应用注册表
 *
 * 回答两个问题：「这个扩展名归谁打开」「用户把它改成过谁」。
 * 维度只有两条（设计决策 5）：扩展名带点（`.md`）、协议带冒号（`http:`）。
 *
 * 存储用设置中枢的一个 json 键（`defaultapps.bindings`），不新建 IndexedDB 库。三个理由：
 * 1. 访达双击文件是在点击处理器里同步问路的（mods/finder/script.js 打开文件那条链路），
 *    IndexedDB 的 Promise 会把这条路径改成异步，得连带改访达的整套打开逻辑；
 * 2. 内容量是最多几十条短字符串，配额风险为零，而设置中枢本来就把写满降级成
 *    `persisted:false` 而不是抛错（settings.js writeSlot），坏情况已有兜底；
 * 3. 存这里才**自动进备份**：通用面板的导出/恢复走 `settings.snapshot()/restore()`，
 *    新开一个 IDB 库等于把用户改绑的默认应用漏在备份之外。
 *
 * 不用 jsonPath：`writePath` 按 `.` 切分路径（settings.js:117-132），
 * 键名 `.md` 会把整个 blob 切坏。整张映射表就装在一个 json 值里。
 *
 * 协议不设系统锁（设计决策 7）：第三方插件可以把 `http:` 抢过去，
 * 系统只在恢复默认时退回 safari。
 */

import { settings } from "./settings.js";
import { broadcast, getApp, listApps, setExtensionResolver, resolveAppRecord, addLifecycleHook, isPluginEnabled } from "./app-registry.js";

// 键名全小写：设置中枢的 KEY_PATTERN 规定首段只允许 [a-z][a-z0-9]*，
// 写成 defaultApps.bindings 会被 define() 判非法并静默返回 null（界面上一行都不出现）。
const SETTINGS_KEY = "defaultapps.bindings";

/**
 * 系统内置默认。顺序即回退链第二级，第一级是用户改绑（见 resolveAppIdFor）。
 * 值必须是真实存在的 appId，dev/static-check.mjs 会逐条校验。
 */
const SYSTEM_DEFAULTS = {
    "http:": "safari",
    "https:": "safari",
    ".md": "notepad",
    ".txt": "notepad",
    ".log": "notepad",
    ".docx": "office.word",
    ".xlsx": "office.excel",
    ".pptx": "office.ppt",
    ".csv": "office.excel",
    ".png": "photos",
    ".jpg": "photos",
    ".jpeg": "photos",
    ".gif": "photos",
    ".webp": "photos",
    ".svg": "photos",
    ".heic": "photos",
    ".bmp": "photos",
    ".avif": "photos",
    ".mp4": "photos",
    ".webm": "photos",
    ".mov": "photos",
    ".m4v": "photos",
    ".ogv": "photos",
};

/** 界面上给几个常见类型配一句人话，其余原样显示键名。 */
const FRIENDLY = {
    "http:": "网页（超链接）",
    "https:": "网页（安全超链接）",
    ".md": "Markdown 文档",
    ".txt": "纯文本",
    ".docx": "Word 文档",
    ".xlsx": "Excel 表格",
    ".pptx": "PowerPoint 演示",
    ".csv": "CSV 表格",
    ".png": "图片",
    ".jpg": "图片",
    ".gif": "动图",
    ".svg": "矢量图",
    ".mp4": "视频",
    ".mov": "视频",
    ".webm": "视频",
};

/** 在求值期就登记定义：与 sound/spotlight 等能力模块同一套做法。 */
function defineSchema() {
    settings.define({
        key: SETTINGS_KEY,
        type: "json",
        default: {},
        slot: "webstartos_default_apps",
        owner: "default-apps",
        hidden: true,
        label: "默认应用绑定",
    });
    return true;
}

defineSchema();

/** 不带冒号也认成协议的写法（设计决策 5 的键是 `http:`，但插件常写 `http`）。 */
const SCHEMES = new Set(["http", "https", "mailto", "tel", "ftp", "file", "data"]);

/**
 * 键归一化：`.md` / `md` / `MD` 都落到 `.md`；`http:` / `http` 都落到 `http:`。
 * 两种写法都收是刻意的 —— 只认带点/带冒号写法时，插件传 `set("md", …)` 或
 * `set("http", …)` 会静默存成一条永远匹配不上的记录，用户看到的症状是「改了没反应」。
 * 裸词只有落在 SCHEMES 里才当协议，否则当扩展名（`md` 不会被判成协议）。
 * @param {string} key 扩展名或协议
 * @returns {string|null} 规范化键；既不像扩展名也不像协议时返回 null
 */
function normalizeKey(key) {
    const raw = String(key ?? "").trim().toLowerCase();
    if (!raw) return null;
    if (raw.endsWith(":")) return /^[a-z][a-z0-9+.-]*:$/.test(raw) ? raw : null;
    if (raw.includes(":")) return null;
    if (!raw.includes(".") && SCHEMES.has(raw)) return `${raw}:`;
    const ext = raw.startsWith(".") ? raw : `.${raw}`;
    return /^\.[a-z0-9][a-z0-9]{0,15}$/.test(ext) ? ext : null;
}

/** 整张用户绑定表（同步读，永远返回普通对象）。 */
function bindings() {
    const value = settings.get(SETTINGS_KEY, {});
    return value && typeof value === "object" ? value : {};
}

function writeBindings(map) {
    const clean = {};
    for (const [key, appId] of Object.entries(map)) {
        if (key && appId) clean[key] = appId;
    }
    const result = settings.set(SETTINGS_KEY, clean, { source: "default-apps" });
    return { persisted: !result || result.persisted !== false };
}

/**
 * 当前该由哪个应用打开，并说明这个答案从哪一级来。
 * 回退链（顺序即优先级，改动要看这里）：
 *   1 用户改绑（系统设置页或 Deskly.apps.default.set 写的）
 *   2 SYSTEM_DEFAULTS 内置默认
 *   3 插件在 apps[].formats / 根级 formats 里的自我声明
 * @param {string} key 扩展名（`.md` 或 `md`）或协议（`http:`）
 * @returns {{appId:(string|undefined), source:(string|undefined), key:(string|null)}}
 */
/** 命中记录是否可用：插件被禁用时绑定要落到下一级，而不是显示一个打不开的应用（BUG-25）。 */
function usable(appId) {
    const rec = appId ? getApp(appId) : null;
    return !!(rec && isPluginEnabled(rec.id));
}

function resolve(key) {
    const norm = normalizeKey(key);
    if (!norm) return { key: null, appId: undefined, source: undefined };
    const user = bindings()[norm];
    if (user && usable(user)) return { key: norm, appId: user, source: "user" };
    const system = SYSTEM_DEFAULTS[norm];
    if (system && usable(system)) return { key: norm, appId: system, source: "system" };
    const rec = manifestDeclared(norm);
    if (rec) return { key: norm, appId: rec.appId, source: "manifest" };
    return { key: norm, appId: undefined, source: undefined };
}

/** 第三级：扫注册表里插件自己声明能打开该类型的记录（已禁用的跳过，与 getAppByExtension 同判据）。 */
function manifestDeclared(normExt) {
    const bare = normExt.replace(/^\./, "");
    for (const rec of listApps()) {
        if (!isPluginEnabled(rec.id)) continue;
        const formats = (rec.app && rec.app.formats) || (!rec.app && rec.manifest && rec.manifest.formats);
        if (!Array.isArray(formats)) continue;
        if (formats.some((f) => String(f || "").trim().toLowerCase().replace(/^\./, "") === bare)) return rec;
    }
    return undefined;
}

/**
 * 绑定一个扩展名/协议到某个应用。
 * @param {string} key 扩展名或协议
 * @param {string} nameOrAppId 应用（appId、插件 id 或显示名都可）
 * @returns {object} {key, appId, persisted}
 */
function set(key, nameOrAppId) {
    const norm = normalizeKey(key);
    if (!norm) throw new Error(`键名不合法：${key}（扩展名要写成 .md，协议要写成 http:）`);
    // 解析直接借注册表的 resolveAppRecord：它已经处理了 appId / 插件 id / 插件显示名 /
    // 子应用显示名四形态，自己再写一套只会与它漂移。
    const rec = resolveAppRecord(nameOrAppId);
    if (!rec) throw new Error(`找不到应用：${nameOrAppId}`);
    // 套件级（如 `office` / 「办公」）不能当绑定目标：listApps() 里多应用插件只有子应用
    // 记录，存 `office` 会让 getApp() 查不到、resolve() 直接跳到下一级 —— 改了绑却毫无反应。
    if (!rec.app && Array.isArray(rec.manifest.apps) && rec.manifest.apps.length) {
        const choices = rec.manifest.apps.map((a) => `${rec.id}.${a.id}`).join(" / ");
        throw new Error(`「${nameOrAppId}」是套件，请指定子应用：${choices}`);
    }
    const appId = rec.appId;
    const map = { ...bindings(), [norm]: appId };
    const { persisted } = writeBindings(map);
    broadcast("default-apps-changed", { key: norm, appId, action: "set", persisted });
    return { key: norm, appId, persisted };
}

/** 查询绑定，返回 appId（无绑定且无默认可解析时 undefined）。 */
function get(key) {
    return resolve(key).appId;
}

/** 只读用户自己的改绑记录。 */
function getAll() {
    return { ...bindings() };
}

/**
 * 界面与诊断用的完整视图：每个可注册类型 + 当前生效应用 + 生效来源。
 * 系统设置「默认应用」面板直接吃这个结构。
 * @returns {Array<{key:string, friendly:string, appId:(string|undefined), source:string, overridable:boolean}>}
 */
function listTypes() {
    const keys = new Set([
        ...Object.keys(SYSTEM_DEFAULTS),
        ...Object.keys(bindings()),
        ...declaredFormatKeys(),
    ]);
    return Array.from(keys).sort().map((key) => {
        const hit = resolve(key);
        return {
            key,
            friendly: FRIENDLY[key] || key,
            appId: hit.appId,
            source: hit.source || "none",
            overridable: true,
        };
    });
}

/** 插件们声明过的扩展名键（带点形态），让面板能列出「装了 office 才有的一排」。 */
function declaredFormatKeys() {
    const out = [];
    for (const rec of listApps()) {
        const formats = (rec.app && rec.app.formats) || (!rec.app && rec.manifest && rec.manifest.formats);
        if (!Array.isArray(formats)) continue;
        for (const f of formats) {
            const norm = normalizeKey(f);
            if (norm) out.push(norm);
        }
    }
    return out;
}

/** 恢复某个键的系统默认（删掉用户记录）。 */
function reset(key) {
    const norm = normalizeKey(key);
    if (!norm) throw new Error(`键名不合法：${key}`);
    const map = { ...bindings() };
    const existed = Object.prototype.hasOwnProperty.call(map, norm);
    delete map[norm];
    const { persisted } = writeBindings(map);
    broadcast("default-apps-changed", { key: norm, appId: undefined, action: "reset", existed, persisted });
    return { key: norm, removed: existed, persisted };
}

function resetAll() {
    const count = Object.keys(bindings()).length;
    const { persisted } = writeBindings({});
    broadcast("default-apps-changed", { key: null, appId: undefined, action: "reset-all", count, persisted });
    return { count, persisted };
}

/**
 * 卸载插件时清掉指向它的绑定：按插件 id 命中的记录整条删掉，
 * 否则面板会一直显示一个已经不存在的 appId，双击文件直接落空。
 * @param {string} pluginId 插件 id
 * @returns {number} 清掉的条数
 */
function removeApp(pluginId) {
    const id = String(pluginId || "");
    if (!id) return 0;
    const map = bindings();
    const kept = { ...map };
    let removed = 0;
    for (const [key, appId] of Object.entries(map)) {
        if (appId === id || appId.startsWith(`${id}.`)) {
            delete kept[key];
            removed += 1;
        }
    }
    if (removed) {
        writeBindings(kept);
        broadcast("default-apps-changed", { key: null, appId: id, action: "plugin-removed", count: removed });
    }
    return removed;
}

/**
 * 交给 app-registry 的解析钩子：用户绑定优先于清单声明。
 * 只认扩展名（协议不参与「按扩展名找应用」）。
 * @param {string} bareExt 已去掉前导点的扩展名
 * @returns {object|undefined} 应用记录
 */
function resolveExtRecord(bareExt) {
    const norm = normalizeKey(bareExt);
    if (!norm || norm.endsWith(":")) return undefined;
    const appId = bindings()[norm];
    if (!appId) return undefined;
    return getApp(appId) || undefined;
}

/**
 * 初始化：把钩子接进注册表（赋值式，不 import 回来，避免成环），
 * 并接上插件卸载清理。可重复调用 —— 钩子只挂一次。
 * 卸载清理走注册表生命周期钩子而不是 document 的 plugin-unregistered 事件：
 * 那是开放总线，伪造一个事件就能清掉他人全部默认应用绑定（BUG-17）。
 * @returns {boolean}
 */
let wired = false;
function initDefaultApps() {
    defineSchema();
    setExtensionResolver(resolveExtRecord);
    if (wired) return true;
    wired = true;
    addLifecycleHook({
        onUnregistered: (id) => { if (id) removeApp(id); },
    });
    return true;
}

// 全局只挂**只读**诊断面：set/reset/resetAll/removeApp 一旦全局可达，任何插件都能绕过
// 敏感权限 default-apps:write 的运行时确认直接改绑（BUG-19）。写入口只保留模块导出。
globalThis.__defaultApps = Object.freeze({
    SYSTEM_DEFAULTS, SETTINGS_KEY,
    resolve, get, getAll, listTypes, normalizeKey,
});

export {
    SYSTEM_DEFAULTS, SETTINGS_KEY,
    initDefaultApps, resolve, get, set, getAll, listTypes, reset, resetAll, removeApp, normalizeKey,
    resolveExtRecord,
};
