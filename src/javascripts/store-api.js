/**
 * store-api.js — 应用商店的数据与动作层（完全不碰 DOM）
 *
 * 为什么要有这个文件：商店界面的历史问题是**分层倒置** —— 宿主
 * （`src/javascripts/app-store.js`）伸手进插件 mod 的 DOM 里画卡片，mod 反过来
 * 用 MutationObserver 往宿主画的卡片上补挂卸载按钮，还要按显示名回查 manifest。
 * 这里把边界摆正：宿主只提供「读数据 + 执行动作」，界面归 `mods/app-store/`。
 *
 * 三条硬约定：
 * 1. **安装要么完整成功、要么什么都没发生**。解包 → 落库 → 逐个回读清单声明的必需资源
 *    （入口 HTML / 样式 / 脚本 / 图标 / 各子应用入口）→ 任一回读失败就删掉刚写入的记录
 *    并回报缺哪个文件；详情图缺失只作为提醒返回。过去是「提示已安装、打开时白屏」。
 * 2. **不假设 Service Worker 一定接管页面**。ZIP 插件的资源靠 `sw.js` 从 IndexedDB 回源，
 *    而「注册成功」不等于「页面被接管」。所有回读都检查响应上的 `X-Deskly-Plugin` 标记头：
 *    没有标记说明请求根本没经过 SW（或命中的是磁盘文件），此时安装直接失败并说明原因，
 *    而不是留下一个永远打不开的插件。
 * 3. 状态持久化一律走设置中枢（`settings`），不再散落 localStorage 裸键。
 */

import { settings } from "./settings.js";
import {
    getPlugins,
    getPlugin,
    listApps,
    getIcon,
    registerInstalledPlugin,
    unregisterInstalledPlugin,
    disabledIds,
    isPluginEnabled,
    setPluginEnabled,
    BUILTIN_IDS,
} from "./plugin-manager.js";
import { showPermissionChecklist, describe, isKnownPermission, isSensitive } from "./api-grants.js";
import { displayNameFor, isSystemApp } from "./app-registry.js";
import { GENERIC_APP_ICON, modFile } from "./paths.js";
import { ensureJSZip } from "./vendor.js";
import { VERSION } from "./version.js";

/** 与安装器一致的 id 白名单：会拼进 ./mods/<id>/ 路径与 IndexedDB 键 */
const SAFE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 解包总字节上限（撑爆 IndexedDB 的护栏，沿用旧安装器的 10MB） */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** 安装历史保留条数 */
const HISTORY_LIMIT = 50;
/** SW 回源响应上的标记头（见 sw.js），用来证明「页面确实被 SW 接管」 */
const SW_MARKER = "x-deskly-plugin";

/* ── 持久化状态 ── */

// 「禁用哪些插件」属于注册表层的用户意图（启动台、程序坞、加载器都要读），
// 实现和 store.disabled 这项定义都在 app-registry.js，这里只转发，绝不再存第二份。
export { disabledIds, isPluginEnabled };

// 这两项只有商店读写：安装期摘要（体积/文件数/来源包名）与安装历史。
settings.define({ key: "store.meta", type: "json", default: {}, owner: "store" });
settings.define({ key: "store.history", type: "json", default: [], owner: "store" });

/**
 * 启用 / 禁用一个插件（内置插件也可禁用，只是不能卸载）。
 * 系统设置与 App Store 允许禁用（它们可从对方的 App 列表或苹果菜单重新启用）；
 * 只有 manifest 标记 visibility.system 的系统应用会被拒绝。
 * @param {string} id 插件 id
 * @param {boolean} on 是否启用
 * @returns {{ok: boolean, enabled?: boolean, reason?: string}} 结果
 */
export function setEnabled(id, on) {
    if (!on && isSystemApp(id)) {
        return { ok: false, reason: "系统应用不能禁用，请从「应用」列表中直接打开它" };
    }
    return { ok: true, enabled: setPluginEnabled(id, on) };
}

const readJson = (key, fallback) => {
    const value = settings.get(key, fallback);
    return value === undefined || value === null ? fallback : value;
};

function writeJson(key, value) {
    settings.set(key, value, { source: "store" });
}

/** 安装期写入的元数据（来源包名、字节数、文件数、时间） */
function metaOf(id) {
    const all = readJson("store.meta", {});
    return (all && typeof all === "object" && all[id]) || null;
}

function putMeta(id, patch) {
    const all = readJson("store.meta", {}) || {};
    all[id] = { ...(all[id] || {}), ...patch };
    writeJson("store.meta", all);
}

function dropMeta(id) {
    const all = readJson("store.meta", {}) || {};
    delete all[id];
    writeJson("store.meta", all);
}

/**
 * 安装历史（新在前）。
 * @returns {Array<object>} 记录
 */
export function history() {
    const list = readJson("store.history", []);
    return Array.isArray(list) ? list : [];
}

function pushHistory(entry) {
    const list = [entry, ...history()].slice(0, HISTORY_LIMIT);
    writeJson("store.history", list);
}

/* ── 读取与聚合 ── */

/**
 * 取清单里自声明的商店元数据（`store` 块），并做字段清洗。
 * 没写就不编内容：详情页对应区块直接不渲染。
 * @param {object} manifest 插件清单
 * @returns {object|null} 清洗后的元数据
 */
export function storeMeta(manifest) {
    const raw = manifest && manifest.store;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
    const list = (v, max) => (Array.isArray(v) ? v.map((x) => text(x, 120)).filter(Boolean).slice(0, max) : []);
    const shot = (v) => (Array.isArray(v)
        ? v.map((x) => text(x, 120)).filter((p) => /\.(png|jpg|jpeg|webp)$/i.test(p) && !p.includes("..")).slice(0, 6)
        : []);
    return {
        category: text(raw.category, 24),
        tagline: text(raw.tagline, 120),
        summary: text(raw.summary, 600),
        features: list(raw.features, 12),
        usage: text(raw.usage, 600),
        updated: text(raw.updated, 20),
        homepage: /^https?:\/\//.test(raw.homepage || "") ? raw.homepage : "",
        author: text(raw.author, 60),
        // 先剔掉非法项再截 6 张：先截后剔会让「声明了 7 张、其中 2 张写错」的包白少两张
        screenshots: shot(raw.screenshots),
    };
}

/**
 * 插件真正声明的能力（详情页「权限」区）。
 * 不读 `manifest.store`：商店文案里写「需要访问文件」而清单里没声明，是两回事，
 * 以清单为准才和授权账本（api-grants）对得上。
 * @param {object} manifest 插件清单
 * @returns {Array<{name: string, label: string, hint: string, sensitive: boolean}>} 权限说明
 */
export function permissionsOf(manifest) {
    const names = Array.isArray(manifest && manifest.permissions) ? manifest.permissions : [];
    return names
        .filter((p) => typeof p === "string" && isKnownPermission(p))
        .map((p) => {
            const { label, hint } = describe(p);
            return { name: p, label, hint, sensitive: isSensitive(p) };
        });
}

/**
 * 聚合商店列表：内置 + 已安装，附来源、启用态、图标与可单独打开的应用清单。
 * @returns {Array<object>} 条目
 */
export function listEntries() {
    return getPlugins().map((m) => {
        const meta = metaOf(m.id);
        const installedAt = meta ? meta.installedAt : 0;
        const system = isSystemApp(m.id);
        const apps = listApps().filter((r) => r.id === m.id && r.app)
            .map((r) => ({ appId: r.appId, name: r.displayName || r.name, icon: getIconForApp(r, installedAt) }));
        return {
            id: m.id,
            name: displayNameFor(m.id) || m.name || m.id,
            version: m.version || "",
            description: m.description || "",
            icon: stamp(getIcon(m.id), stampOf(m, installedAt)),
            source: m._installed ? "installed" : "builtin",
            enabled: isPluginEnabled(m.id),
            disableable: !system,
            disableReason: system ? "系统应用不可禁用" : "",
            apps,
            store: storeMeta(m),
            screenshots: ((storeMeta(m) || {}).screenshots || []).map((f) => screenshotUrl(m.id, f)),
            permissions: permissionsOf(m),
            installedAt,
            bytes: meta ? meta.bytes : 0,
            fileCount: meta ? meta.files : 0,
            from: meta ? meta.from : "",
        };
    });
}

/**
 * 取单个条目。
 * @param {string} id 插件 id
 * @returns {object|null} 条目
 */
export function getEntry(id) {
    return listEntries().find((e) => e.id === id) || null;
}

/**
 * 侧栏分类：固定三项 + 按 `store.category` 自动聚合。
 * @returns {Array<{key: string, label: string, count: number}>} 分类
 */
export function categories() {
    const entries = listEntries();
    const base = [
        { key: "all", label: "全部", count: entries.length },
        { key: "builtin", label: "已内置", count: entries.filter((e) => e.source === "builtin").length },
        { key: "installed", label: "已安装", count: entries.filter((e) => e.source === "installed").length },
        { key: "disabled", label: "已禁用", count: entries.filter((e) => !e.enabled).length },
    ];
    const byCat = new Map();
    entries.forEach((e) => {
        const cat = e.store && e.store.category;
        if (!cat) return;
        byCat.set(cat, (byCat.get(cat) || 0) + 1);
    });
    const extra = [...byCat.entries()]
        .filter(([cat]) => !base.some((b) => b.label === cat))
        .map(([cat, count]) => ({ key: `cat:${cat}`, label: cat, count }));
    return [...base, ...extra];
}

/**
 * 按分类与关键词筛选条目（搜索覆盖名称、id、tagline、描述、分类）。
 * @param {string} categoryKey 分类键
 * @param {string} keyword 关键词
 * @returns {Array<object>} 命中的条目
 */
export function filterEntries(categoryKey = "all", keyword = "") {
    const entries = listEntries();
    const kw = String(keyword || "").trim().toLowerCase();
    const inCategory = (e) => {
        if (!categoryKey || categoryKey === "all") return true;
        if (categoryKey === "builtin") return e.source === "builtin";
        if (categoryKey === "installed") return e.source === "installed";
        if (categoryKey === "disabled") return !e.enabled;
        if (categoryKey.startsWith("cat:")) return !!(e.store && e.store.category === categoryKey.slice(4));
        return true;
    };
    const hit = (e) => {
        if (!kw) return true;
        return [e.name, e.id, e.description, e.store && e.store.tagline, e.store && e.store.category]
            .some((v) => typeof v === "string" && v.toLowerCase().includes(kw));
    };
    return entries.filter((e) => inCategory(e) && hit(e));
}

/* ── SW 接管探测 ── */

/**
 * 页面是否真的被 SW 接管（注册成功 ≠ 会被接管，未接管时 ZIP 插件取不到资源）。
 * @returns {Promise<{controlled: boolean, registered: boolean}>} 探测结果
 */
export async function swStatus() {
    const nav = navigator;
    const registered = nav.serviceWorker
        ? (await nav.serviceWorker.getRegistrations().catch(() => [])).length > 0
        : false;
    return { controlled: !!(nav.serviceWorker && nav.serviceWorker.controller), registered };
}

/**
 * 回读一个插件资源，确认它确实由 SW 从 IndexedDB 返回。
 * @param {string} id 插件 id
 * @param {string} file 插件目录内相对路径
 * @returns {Promise<{ok: boolean, status: number, reason: string}>} 结果
 */
export async function probeResource(id, file) {
    const url = modFile(id, file);
    try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
        if (!res.headers.get(SW_MARKER)) return { ok: false, status: res.status, reason: "未经过插件资源代理（Service Worker 未接管）" };
        return { ok: true, status: res.status, reason: "" };
    } catch (err) {
        return { ok: false, status: 0, reason: (err && err.message) || String(err) };
    }
}

/** 清单声明了哪些**必须存在**的资源：样式、脚本、图标、入口 HTML 与各子应用入口 */
function declaredFiles(manifest) {
    const files = [];
    const push = (v) => { if (typeof v === "string" && v) files.push(v.replace(/^\.\//, "")); };
    push(manifest.style || "style.css");
    push(manifest.script || "script.js");
    push(manifest.icon);
    if (Array.isArray(manifest.apps) && manifest.apps.length) {
        manifest.apps.forEach((a) => {
            push(a.main || `${a.id}.html`);
            push(a.icon);
        });
    } else {
        push(manifest.main || "index.html");
    }
    return [...new Set(files)];
}

/**
 * 安装后校验：逐个回读清单声明的**必需**资源（入口 HTML、样式、脚本、图标、各子应用入口）。
 * 详情图也回读，但缺了只算提醒不拦安装 —— 少一张装饰性的截图不该让整个包装不上。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, problems: Array<{file: string, reason: string}>, optionalMissing: string[]}>} 结果
 */
export async function verifyInstall(id) {
    const manifest = getPlugin(id);
    if (!manifest) {
        return { ok: false, problems: [{ file: "manifest.json", reason: "注册表里没有该插件" }], optionalMissing: [] };
    }
    const required = declaredFiles(manifest);
    const optional = ((storeMeta(manifest) || {}).screenshots || []).filter((f) => !required.includes(f));
    const results = await Promise.all(
        [...required, ...optional].map(async (file) => ({ file, required: required.includes(file), ...(await probeResource(id, file)) })),
    );
    const problems = results.filter((r) => r.required && !r.ok).map((r) => ({ file: r.file, reason: r.reason }));
    const optionalMissing = results.filter((r) => !r.required && !r.ok).map((r) => r.file);
    return { ok: problems.length === 0, problems, optionalMissing };
}

/* ── 安装 / 卸载 ── */

/**
 * 计算包内公共顶层目录前缀（仅当**所有**条目都在同一目录下时）。
 * 只要包根有文件就没有公共根，否则 `codecs/` 这类真实子目录会被误当根剥掉。
 * @param {string[]} names 包内条目名
 * @returns {string} 前缀（含尾斜杠）或空串
 */
function commonRoot(names) {
    const clean = names.map((n) => n.replace(/^\.\//, ""));
    if (clean.some((n) => !n.includes("/"))) return "";
    const first = clean[0].split("/")[0];
    return clean.every((n) => n.startsWith(`${first}/`)) ? `${first}/` : "";
}

/**
 * 解包并安装一个 ZIP。任何一步失败都返回结构化原因，且不留半成品。
 * @param {File} file 用户选/拖入的 .zip
 * @param {{overwrite?: boolean, onProgress?: (stage: string, text: string) => void}} opts
 *        overwrite=是否允许覆盖同 id 的已安装插件；onProgress=阶段回调，供界面显示进度
 * @returns {Promise<{ok: boolean, id?: string, name?: string, reason?: string, detail?: object}>} 结果
 */
/** 同 id 安装的在途锁：并发两次 installZip 会互相覆盖落库、回滚时误删对方刚装好的记录（BUG-31）。 */
const installing = new Map();

/**
 * 宿主版本区间校验（manifest.host，可选）：支持 "0.3.6" 精确、"0.3.x"/"0.3.*" 前缀、">=0.3.6" 下界。
 * @param {string} range 声明的区间
 * @param {string} version 当前宿主版本
 * @returns {boolean}
 */
function hostSatisfies(range, version) {
    const r = String(range || "").trim();
    if (!r) return true;
    const num = (s) => s.split(".").map((n) => parseInt(n, 10) || 0);
    const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
    if (r.startsWith(">=")) return cmp(version, r.slice(2).trim()) >= 0;
    if (/[x*]$/.test(r)) { const prefix = r.slice(0, -1).replace(/\.$/, ""); return version === prefix || version.startsWith(prefix + "."); }
    return cmp(version, r) === 0;
}

export async function installZip(file, opts = {}) {
    const fail = (reason, detail) => ({ ok: false, reason, detail: detail || null });
    const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    if (!file) return fail("没有收到文件");
    if (!/\.zip$/i.test(file.name || "")) return fail("只接受 .zip 插件包");

    // jszip 已从 index.html 摘掉，改为按需加载（见 vendor.js）：只有真的走安装流程才付这份成本。
    let JSZip;
    try {
        JSZip = await ensureJSZip();
    } catch (err) {
        return fail("缺少 JSZip，无法解压", { message: (err && err.message) || String(err) });
    }

    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (err) {
        return fail("压缩包无法解析", { message: (err && err.message) || String(err) });
    }

    const entries = Object.entries(zip.files).filter(([, f]) => !f.dir).map(([name]) => name);
    if (!entries.length) return fail("压缩包是空的");
    const root = commonRoot(entries);
    const keyOf = (name) => name.replace(/^\.\//, "").slice(root ? root.length : 0);
    const manifestEntry = entries.find((n) => keyOf(n) === "manifest.json");
    if (!manifestEntry) return fail("包里找不到 manifest.json（必须位于包根，或整个包放在同一个顶层目录里）");

    let manifest;
    try {
        manifest = JSON.parse(await zip.file(manifestEntry).async("string"));
    } catch (err) {
        return fail("manifest.json 不是合法 JSON", { message: (err && err.message) || String(err) });
    }
    if (!manifest || typeof manifest.id !== "string") return fail("manifest.json 缺少 id 字段");
    const id = manifest.id;
    if (!SAFE_PLUGIN_ID.test(id)) return fail("插件 id 不合法（仅字母/数字/-/_，不得含路径或 ..）", { id });
    if (BUILTIN_IDS.includes(id)) return fail(`插件 id「${id}」与内置插件同名，无法安装`, { id });
    // 宿主版本协商（API-10）：manifest.host 不满足即拒装，杜绝 breaking change 后旧插件现场崩。
    if (manifest.host != null && !hostSatisfies(manifest.host, VERSION)) {
        return fail(`该插件需要 Deskly 宿主版本 ${manifest.host}，当前为 ${VERSION}`, { id, host: manifest.host });
    }
    if (installing.has(id)) return fail("同一插件正在安装中，请稍候", { id });

    const existed = !!getPlugin(id);
    if (existed && !opts.overwrite) {
        return fail("already-installed", { id, name: manifest.name || id, nextVersion: manifest.version || "" });
    }

    installing.set(id, true);
    try {
        const files = {};
        let total = 0;
        progress("unpack", "正在解包…");
        for (const name of entries) {
            const key = keyOf(name);
            if (!key || /(^|\/)\.\.($|\/)/.test(key)) continue;
            const blob = await zip.file(name).async("blob");
            total += blob.size;
            if (total > MAX_TOTAL_BYTES) return fail(`解包后 ${Math.round(total / 1024 / 1024)}MB 超过 10MB 上限`, { id });
            files[key] = blob;
        }
        if (!files["manifest.json"]) return fail("manifest.json 未能写入包内文件表", { id });

        // 权限清单必须在落库之前确认（设计决策：取消就整段终止）。半途注册会留下
        // 「注册表里有、授权账本里没有」的插件，之后它每次调用能力都对不上账。
        progress("grant", "等待确认权限…");
        if (!(await showPermissionChecklist(manifest))) return fail("cancelled", { id, name: manifest.name || id });

        progress("write", "正在写入本地插件库…");
        let registered = false;
        try {
            registered = await registerInstalledPlugin(manifest, files);
        } catch (err) {
            return fail("写入本地插件库失败", { message: (err && err.message) || String(err) });
        }
        if (!registered) return fail("注册失败：插件 id 不被注册表接受", { id });

        progress("verify", "正在校验包内资源…");
        const check = await verifyInstall(id);
        if (!check.ok) {
            // 回滚：装了就打不开的插件比装不上更糟
            await unregisterInstalledPlugin(id).catch(() => {});
            dropMeta(id);
            return fail("包内资源不完整，已回滚", { id, problems: check.problems });
        }

        putMeta(id, { installedAt: Date.now(), bytes: total, files: Object.keys(files).length, from: file.name || "", version: manifest.version || "" });
        pushHistory({ at: Date.now(), id, name: manifest.name || id, version: manifest.version || "", bytes: total, fileCount: Object.keys(files).length, from: file.name || "", replaced: existed });
        return {
            ok: true, id, name: manifest.name || id, version: manifest.version || "",
            bytes: total, fileCount: Object.keys(files).length, replaced: existed,
            warnings: check.optionalMissing,
        };
    } finally {
        installing.delete(id);
    }
}

/**
 * 覆盖安装前先给出版本差异，供界面做确认文案。
 * @param {string} id 插件 id
 * @param {string} nextVersion 新包版本
 * @returns {{current: string, next: string}} 差异
 */
export function versionDiff(id, nextVersion) {
    const current = (getPlugin(id) || {}).version || "";
    return { current, next: nextVersion || "" };
}

/**
 * 卸载一个已安装插件。内置插件不可卸载（只能禁用）。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, reason?: string, freed?: number, files?: number}>} 结果
 */
export async function uninstall(id) {
    if (BUILTIN_IDS.includes(id)) return { ok: false, reason: "内置插件不能卸载，可以在详情页里禁用它" };
    const meta = metaOf(id);
    // 显示名要在注销之前取：注册表一摘就只剩 id，安装记录里会出现「e2e-demo」这种难读的行
    const removed = getPlugin(id);
    const done = await unregisterInstalledPlugin(id);
    if (!done) return { ok: false, reason: "注册表里没有这个插件，可能已经卸载过了" };
    dropMeta(id);
    pushHistory({ at: Date.now(), id, name: (removed && removed.name) || id, action: "uninstall", bytes: meta ? meta.bytes : 0 });
    return { ok: true, freed: meta ? meta.bytes : 0, files: meta ? meta.files : 0 };
}

/**
 * 卸载前的说明文案数据（让确认框说清要删掉什么）。
 * @param {string} id 插件 id
 * @returns {{name: string, files: number, bytes: number}|null} 概要
 */
export function uninstallPreview(id) {
    const meta = metaOf(id);
    const entry = getEntry(id);
    if (!entry) return null;
    return { name: entry.name, files: meta ? meta.files : 0, bytes: meta ? meta.bytes : 0 };
}

/** 商店占位图（与全宿主同一来源，界面不要再写死路径） */
export const PLACEHOLDER_ICON = GENERIC_APP_ICON;

/**
 * 资源缓存戳：ZIP 安装的插件可被同 id 覆盖安装，按安装时刻失效；
 * 内置插件按发布版本号（旧实现每个图标都带 ?v=Date.now()，每次打开必然重新请求）。
 * @param {object} manifest 插件清单
 * @param {number} installedAt 安装时间（store.meta 里记的）
 * @returns {string|number} 戳值
 */
function stampOf(manifest, installedAt) {
    if (!manifest || !manifest._installed) return VERSION;
    return installedAt || Date.now();
}

/** 给资源路径加缓存戳（占位图是宿主 assets，不需要戳） */
function stamp(url, v) {
    if (!url || url === GENERIC_APP_ICON) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${v}`;
}

/** 应用图标（子应用优先用自己的，缺省回落插件级） */
function getIconForApp(rec, installedAt) {
    const raw = rec.app && rec.app.icon;
    const url = typeof raw === "string" && raw && !raw.includes("..")
        ? modFile(rec.id, raw.replace(/^\.\//, ""))
        : getIcon(rec.id);
    return stamp(url, stampOf(rec.manifest, installedAt));
}

/**
 * 详情页截图：清单里写的是插件目录内相对路径，由宿主拼成可请求的 URL。
 * 文件不存在时界面自己按 onerror 摘掉这一格（不编占位图）。
 * @param {string} id 插件 id
 * @param {string} file 相对路径
 * @returns {string} URL
 */
function screenshotUrl(id, file) {
    const manifest = getPlugin(id);
    if (!manifest || typeof file !== "string" || file.includes("..")) return GENERIC_APP_ICON;
    return stamp(modFile(id, file.replace(/^\.\//, "")), stampOf(manifest, (metaOf(id) || {}).installedAt));
}
