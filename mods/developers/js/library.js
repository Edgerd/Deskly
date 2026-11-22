/**
 * library.js — 创建的插件源码库。
 *
 * 位置：本插件自己的 IndexedDB（库名 deskly-developers，键 current / backup）。
 * 为什么不再用 Deskly.fs：文件存储（files:write）是敏感能力，第一次保存会额外弹一次
 * 「文件存储」确认，与卸载确认叠成两次弹窗。源码库只是本应用的数据，放自己的
 * IndexedDB 里刷新与重启都在，也不再需要写权限；files:read 只用于一次性迁移旧数据。
 * 为什么还要备份：写坏一次就够丢掉全部源码，写前把上一版挪到 backup。
 */

const FILE = "library.json";
const BACKUP = "library.bak.json";
const SCHEMA_VERSION = 1;
const DB_NAME = "deskly-developers";
const DB_VERSION = 1;
const STORE = "kv";

const KIND_VALUES = new Set(["shortcut", "window", "page"]);
// 与 icon.js 的三种图标样式保持一致；这里单独列一份，避免把画布逻辑带进 Node 校验。
const ICON_STYLES = new Set(["brand", "letter", "brand-letter"]);

let dbPromise = null;

/** 打开（或复用）本插件的 IndexedDB。 */
function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("打开源码库失败"));
    });
    return dbPromise;
}

/** 读一个键；失败返回 null，不阻塞界面。 */
async function idbGet(key) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result == null ? null : req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn("[developers] 读取源码库失败", key, err);
        return null;
    }
}

/** 写一个键；失败抛出，由界面提示。 */
async function idbSet(key, value) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** 旧版存在 AppData 里的 JSON（只读一次，用于迁移）。无权限时静默返回 null。 */
async function readLegacyJson(name) {
    try {
        const res = await Deskly.fs.read(name);
        if (!res || !res.ok || !res.value) return null;
        const text = await res.value.text();
        if (!text || !text.trim()) return null;
        return JSON.parse(text);
    } catch (err) {
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
    const style = ICON_STYLES.has(src.style) ? src.style : "";
    return { data, letter, color, style };
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

/** 首次读库；读不到退回备份；再读不到给空库。旧版文件只迁移一次。 */
export async function loadLibrary({ force = false } = {}) {
    if (cache && !force) return cache;
    let raw = null;
    const current = await idbGet("current");
    if (current) {
        try { raw = JSON.parse(current); } catch (_) { raw = null; }
    }
    if (!raw) {
        const backup = await idbGet("backup");
        if (backup) {
            try { raw = JSON.parse(backup); } catch (_) { raw = null; }
        }
    }
    if (!raw) raw = await readLegacyJson(FILE);
    if (!raw) raw = await readLegacyJson(BACKUP);
    cache = normalizeLibrary(raw);
    if (raw) {
        // 迁移/修复后立刻落一份，下次不再读旧文件
        try { await idbSet("current", JSON.stringify(cache)); } catch (_) { /* 下次再写 */ }
    }
    return cache;
}

/**
 * 保存整份库。先写备份（上一版），再写主记录；
 * 任何一步失败都把错误抛给调用方，界面据此提示而不是假装成功。
 */
export async function saveLibrary(library) {
    const normalized = normalizeLibrary(library);
    normalized.updatedAt = new Date().toISOString();

    const previous = await idbGet("current");
    if (previous) {
        await idbSet("backup", previous);
    }
    await idbSet("current", JSON.stringify(normalized));
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
