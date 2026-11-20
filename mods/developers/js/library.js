/**
 * library.js — 创建的插件源码库。
 *
 * 位置：本插件 AppData 下的 library.json / library.bak.json。
 * 为什么不用 localStorage：容量小、和工作区数据分开存、清站点数据时容易只剩半份；
 * OSFS 由内核统一管理（默认 IndexedDB 后端，挂了文件夹就落到磁盘），刷新与重启都在。
 * 为什么还要备份：写坏一次就够丢掉全部源码，写前把上一版挪到 .bak.json。
 */

const FILE = "library.json";
const BACKUP = "library.bak.json";
const SCHEMA_VERSION = 1;

const KIND_VALUES = new Set(["shortcut", "window", "page"]);

/** 读出信封里的 File；缺失、被拒、解析失败都返回 null。 */
async function readJson(name) {
    try {
        const res = await Deskly.fs.read(name);
        if (!res || !res.ok || !res.value) return null;
        const text = await res.value.text();
        if (!text || !text.trim()) return null;
        return JSON.parse(text);
    } catch (err) {
        console.warn("[developers] 读取", name, "失败", err);
        return null;
    }
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeWindow(input) {
    const w = input && typeof input === "object" ? input : {};
    const width = clampNumber(w.width, 320, 2400, 1024);
    const height = clampNumber(w.height, 240, 1600, 680);
    return {
        width,
        height,
        minWidth: clampNumber(w.minWidth, 280, width, Math.min(480, width)),
        minHeight: clampNumber(w.minHeight, 200, height, Math.min(360, height)),
        resizable: w.resizable !== false,
        draggable: w.draggable !== false,
        titlebar: w.titlebar !== false,
        accent: typeof w.accent === "string" ? w.accent : "",
    };
}

export function normalizeIcon(input, fallbackLetter) {
    const src = input && typeof input === "object" ? input : {};
    const data = typeof src.data === "string" && /^data:image\//.test(src.data) ? src.data : "";
    const letter = String(src.letter || fallbackLetter || "?").slice(0, 2).toUpperCase();
    const color = /^#[0-9a-f]{6}$/i.test(src.color || "") ? src.color : "";
    return { data, letter, color };
}

/** 单条记录归一化；坏记录返回 null（调用方过滤掉）。 */
export function normalizeRecord(input) {
    if (!input || typeof input !== "object") return null;
    const id = typeof input.id === "string" && /^dev-[a-z0-9][a-z0-9-]{1,60}$/.test(input.id) ? input.id : "";
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
    if (!id || !name) return null;
    const kind = KIND_VALUES.has(input.kind) ? input.kind : "shortcut";
    const url = typeof input.url === "string" ? input.url.slice(0, 2048) : "";
    const page = input.page && typeof input.page === "object" ? input.page : {};
    const now = new Date().toISOString();
    return {
        id,
        name,
        kind,
        url,
        description: typeof input.description === "string" ? input.description.slice(0, 280) : "",
        window: normalizeWindow(input.window),
        page: {
            html: typeof page.html === "string" ? page.html.slice(0, 262144) : "",
            css: typeof page.css === "string" ? page.css.slice(0, 262144) : "",
            js: typeof page.js === "string" ? page.js.slice(0, 262144) : "",
        },
        icon: normalizeIcon(input.icon, name.slice(0, 2)),
        createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
        updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
    };
}

/** 归一化整份库；不接受任何未知字段。 */
export function normalizeLibrary(raw) {
    const plugins = [];
    const seen = new Set();
    const list = raw && Array.isArray(raw.plugins) ? raw.plugins : [];
    for (const item of list) {
        const rec = normalizeRecord(item);
        if (!rec || seen.has(rec.id)) continue;
        seen.add(rec.id);
        plugins.push(rec);
    }
    return { version: SCHEMA_VERSION, updatedAt: new Date().toISOString(), plugins };
}

let cache = null;

/** 首次读库；读不到退回备份；再读不到给空库。 */
export async function loadLibrary({ force = false } = {}) {
    if (cache && !force) return cache;
    let raw = await readJson(FILE);
    if (!raw) raw = await readJson(BACKUP);
    cache = normalizeLibrary(raw);
    return cache;
}

/**
 * 保存整份库。先写备份（上一版），再写主文件；
 * 任何一步失败都把错误抛给调用方，界面据此提示而不是假装成功。
 */
export async function saveLibrary(library) {
    const normalized = normalizeLibrary(library);
    normalized.updatedAt = new Date().toISOString();

    let previous = "";
    try {
        const current = await Deskly.fs.read(FILE);
        if (current && current.ok && current.value) previous = await current.value.text();
    } catch (_) {
        previous = "";
    }
    if (previous) {
        const bak = await Deskly.fs.write(BACKUP, previous);
        if (!bak || !bak.ok) throw new Error(bak?.reason || "备份写入失败");
    }

    const res = await Deskly.fs.write(FILE, JSON.stringify(normalized));
    if (!res || !res.ok) throw new Error(res?.reason || "写入失败");
    cache = normalized;
    return normalized;
}

export function getRecord(library, id) {
    return library.plugins.find((item) => item.id === id) || null;
}

export function upsertRecord(library, record) {
    const next = normalizeRecord(record);
    if (!next) throw new Error("记录格式不对");
    const index = library.plugins.findIndex((item) => item.id === next.id);
    if (index >= 0) library.plugins[index] = next;
    else library.plugins.unshift(next);
    library.updatedAt = new Date().toISOString();
    return next;
}

export function removeRecord(library, id) {
    const before = library.plugins.length;
    library.plugins = library.plugins.filter((item) => item.id !== id);
    library.updatedAt = new Date().toISOString();
    return library.plugins.length !== before;
}

/** 估算源码占用（UTF-8 字节），用于设置页显示，不把二进制图标算进去。 */
export function estimateBytes(library) {
    try {
        return new TextEncoder().encode(JSON.stringify(library)).length;
    } catch (_) {
        return 0;
    }
}

/** 生成稳定、可读、不会撞系统应用的 id：dev-<slug>-<hash4>。 */
export function makeId(name, seed) {
    const ascii = String(name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    const hash = hashString(String(seed || name || Date.now())).toString(36).slice(0, 4);
    const base = ascii || "plugin";
    return `dev-${base}-${hash}`;
}

export function hashString(input) {
    let hash = 2166136261;
    const text = String(input);
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function touch(record) {
    record.updatedAt = new Date().toISOString();
    return record;
}
