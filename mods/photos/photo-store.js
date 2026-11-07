/**
 * photo-store.js — 照片库资源仓库（第 4 期 Q2 + 第 6 期收口）
 *
 * /Picture/ 是唯一照片库；本模块是照片应用对存储的唯一入口，只走 window.Deskly
 * 公开 API（Q6：插件不直接 import 内核模块）：
 * - 媒体原文件 = /Picture/ 下的真实文件，项目 id 即其路径；
 * - 删除一律 Deskly.fs.trash.moveToTrash（进 /废纸篓、可放回原处）；
 * - 缩略图放自己的 AppData 数据目录（Deskly.fs 沙箱作用域）；
 * - 外部图片文件夹经用户授权挂载为只读来源，越界（写入/删除）抛 StoreError(EREADONLY)。
 */

/** 存储层错误：带可编程 code（EREADONLY/EREAUTH/EIO…），界面分支判断不碰文案。 */
class StoreError extends Error {
    constructor(code, message, path) {
        super(message);
        this.name = "StoreError";
        this.code = code;
        if (path !== undefined) this.path = path;
    }
}

/** Deskly 信封 → 值/异常。ok:false 一律抛 StoreError，不静默降级（Q6）。 */
function unwrap(env, path) {
    if (!env || !env.ok) {
        const code = (env && env.code) || "EIO";
        throw new StoreError(code === "DENIED" ? "EPERM" : code, (env && env.reason) || "Deskly 调用失败", path);
    }
    return env.value;
}

const Deskly = () => {
    const api = window.Deskly;
    if (!api) throw new StoreError("EIO", "Deskly 尚未就绪");
    return api;
};

const PICTURE_ROOT = "/Picture";
const EXTERNAL_PREFIX = "ext://";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "bmp", "avif", "tif", "tiff"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);

/* id -> { url, refs }：原媒体对象 URL（引用计数） */
const urlCache = new Map();
const pendingUrls = new Map();
/* id -> string|null：缩略图对象 URL */
const thumbCache = new Map();

let initPromise = null;

/** 库目录与缩略图目录的就绪（幂等）。 */
export function initStore() {
    if (!initPromise) {
        initPromise = (async () => {
            await unwrap(await Deskly().fs.mkdirAt(PICTURE_ROOT));
            // 沙箱预建由内核 ensurePluginScope 负责；写缩略图时父级自动补齐，无需显式建
        })().catch((err) => {
            initPromise = null;
            throw err;
        });
    }
    return initPromise;
}

const thumbRel = (id) => `data/thumbs/${encodeURIComponent(id)}.thumb`;

const extOf = (name) => (String(name).match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "";
export const mediaKindOf = (name) => {
    const ext = extOf(name);
    if (IMAGE_EXTS.has(ext)) return "image";
    if (VIDEO_EXTS.has(ext)) return "video";
    return null;
};

/* ── 库扫描 ── */

/**
 * 扫描 /Picture/（含子目录，最深 6 层），返回媒体条目。
 * @returns {Promise<Array<{path:string,name:string,type:string,size:number|null,modified:number|null}>>}
 */
export async function scanLibrary() {
    await initStore();
    const files = unwrap(await Deskly().fs.walkAt(PICTURE_ROOT, 6)) || [];
    return files
        .map((f) => ({ ...f, type: mediaKindOf(f.name) }))
        .filter((f) => f.type);
}

/* ── 外部图片文件夹（授权挂载，越界一律拒绝） ── */

/** mountId -> { id, name, handle, mode: 'read'|'readwrite' }。会话内有效。 */
const externalMounts = new Map();
let externalSeq = 0;

/**
 * 挂载一个外部图片文件夹（句柄来自 showDirectoryPicker，调用方负责在用户手势里拿到）。
 * @param {FileSystemDirectoryHandle} handle
 * @param {{name?: string, mode?: string}} opts
 * @returns {Promise<{id:string, name:string, mode:string}>}
 */
export async function addExternalMount(handle, opts = {}) {
    if (!handle || handle.kind !== "directory") throw new StoreError("EPERM", "不是目录句柄");
    const id = `m${++externalSeq}`;
    const mount = { id, name: opts.name || handle.name || id, handle, mode: opts.mode === "readwrite" ? "readwrite" : "read" };
    externalMounts.set(id, mount);
    return { id, name: mount.name, mode: mount.mode };
}

export function listExternalMounts() {
    return [...externalMounts.values()].map(({ id, name, mode }) => ({ id, name, mode }));
}

export function removeExternalMount(id) {
    return externalMounts.delete(id);
}

/** 递归扫外部挂载（最深 4 层），返回 ext:// 形式的媒体条目。 */
export async function scanExternalMount(mountId) {
    const mount = externalMounts.get(mountId);
    if (!mount) return [];
    const out = [];
    const walk = async (dirHandle, prefix, depth) => {
        if (depth > 4) return;
        for await (const [name, child] of dirHandle.entries()) {
            const rel = prefix ? `${prefix}/${name}` : name;
            if (child.kind === "directory") { await walk(child, rel, depth + 1); continue; }
            const type = mediaKindOf(name);
            if (!type) continue;
            let size = null;
            let modified = null;
            try {
                const file = await child.getFile();
                size = file.size;
                modified = file.lastModified;
            } catch (err) { /* 单条读不到不影响整批 */ }
            out.push({ id: `${EXTERNAL_PREFIX}${mountId}/${rel}`, name, type, size, modified });
        }
    };
    await walk(mount.handle, "", 1);
    return out;
}

/** ext://id/rel → { mount, rel }；不是外部 id 返回 null。 */
function parseExternal(id) {
    if (!String(id).startsWith(EXTERNAL_PREFIX)) return null;
    const rest = String(id).slice(EXTERNAL_PREFIX.length);
    const slash = rest.indexOf("/");
    const mountId = slash < 0 ? rest : rest.slice(0, slash);
    const rel = slash < 0 ? "" : rest.slice(slash + 1);
    const mount = externalMounts.get(mountId);
    return mount ? { mount, rel } : null;
}

async function readExternal(mount, rel) {
    let dir = mount.handle;
    const segs = rel.split("/").filter(Boolean);
    for (const seg of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    const fileHandle = await dir.getFileHandle(segs[segs.length - 1]);
    return fileHandle.getFile();
}

/* ── 媒体读写 ── */

/**
 * 写入媒体（导入）：id 必须是 /Picture/ 下的路径；外部挂载一律拒绝（越界不静默）。
 * @param {string} id 项目 id（/Picture/... 路径）
 * @param {Blob} blob 媒体二进制
 */
export async function putMedia(id, blob) {
    if (parseExternal(id)) throw new StoreError("EREADONLY", "外部图片文件夹为只读，不能写入", id);
    await initStore();
    unwrap(await Deskly().fs.writeAt(id, blob), id);
}

/**
 * 读取媒体 Blob（库内走 Deskly，外部走挂载句柄）。
 * @returns {Promise<Blob|null>}
 */
export async function getMedia(id) {
    const ext = parseExternal(id);
    if (ext) {
        try { return await readExternal(ext.mount, ext.rel); }
        catch (err) { return null; }
    }
    try {
        const hit = unwrap(await Deskly().fs.at(id), id);
        return hit instanceof Blob ? hit : null;
    } catch (err) {
        return null;
    }
}

/**
 * 取得可直接赋给 img/video src 的原媒体对象 URL（引用计数 +1，配对 releaseMediaURL）。
 * @param {string} id 项目 id
 * @returns {Promise<string>} 媒体缺失时 reject
 */
export async function getMediaURL(id) {
    const cached = urlCache.get(id);
    if (cached) {
        cached.refs += 1;
        return cached.url;
    }
    if (pendingUrls.has(id)) {
        const entry = await pendingUrls.get(id);
        entry.refs += 1;
        return entry.url;
    }
    const task = getMedia(id).then((blob) => {
        if (!blob) throw new Error("媒体数据缺失");
        const entry = { url: URL.createObjectURL(blob), refs: 1 };
        urlCache.set(id, entry);
        return entry;
    });
    pendingUrls.set(id, task);
    task.catch(() => {}).finally(() => pendingUrls.delete(id));
    const entry = await task;
    return entry.url;
}

/** 释放一次原媒体 URL 引用；引用归零时 revoke。 */
export function releaseMediaURL(id) {
    const entry = urlCache.get(id);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    URL.revokeObjectURL(entry.url);
    urlCache.delete(id);
}

/** 无视引用计数地回收某个 id 的对象 URL（删除项目时使用）。 */
export function dropMediaURL(id) {
    const entry = urlCache.get(id);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    urlCache.delete(id);
}

/* ── 缩略图（自己 AppData 沙箱，不进照片库） ── */

export async function putThumb(id, blob) {
    if (!blob) { await deleteThumb(id); return; }
    await initStore();
    unwrap(await Deskly().fs.write(thumbRel(id), blob), id);
    const old = thumbCache.get(id);
    if (typeof old === "string") URL.revokeObjectURL(old);
    thumbCache.set(id, URL.createObjectURL(blob));
}

export async function deleteThumb(id) {
    const old = thumbCache.get(id);
    if (typeof old === "string") URL.revokeObjectURL(old);
    thumbCache.delete(id);
    try { unwrap(await Deskly().fs.remove(thumbRel(id)), id); } catch (err) { /* 本就没有 */ }
}

export async function getThumbURL(id) {
    if (thumbCache.has(id)) return thumbCache.get(id);
    let file = null;
    try {
        const hit = unwrap(await Deskly().fs.read(thumbRel(id)), id);
        file = hit instanceof Blob ? hit : null;
    } catch (err) {
        file = null;
    }
    if (!file) {
        thumbCache.set(id, null);
        return null;
    }
    const url = URL.createObjectURL(file);
    thumbCache.set(id, url);
    return url;
}

/** 回收单个缩略图对象 URL（记录保留，下次 getThumbURL 会重建）。 */
export function releaseThumbURL(id) {
    const url = thumbCache.get(id);
    if (typeof url === "string") URL.revokeObjectURL(url);
    thumbCache.delete(id);
}

/* ── 删除 ── */

/**
 * 删除媒体：库内项目进 /废纸篓（可放回原处）；外部项目一律拒绝（EREADONLY）。
 * @param {string[]} ids 项目 id 列表
 */
export async function deleteMedia(ids) {
    const list = Array.from(ids || []);
    for (const id of list) {
        if (parseExternal(id)) throw new StoreError("EREADONLY", "外部图片文件夹为只读，不能删除", id);
        dropMediaURL(id);
        const thumb = thumbCache.get(id);
        if (typeof thumb === "string") URL.revokeObjectURL(thumb);
        thumbCache.delete(id);
        await deleteThumb(id).catch(() => {});
        unwrap(await Deskly().fs.trash.moveToTrash(id), id);
    }
}

/* ── 会话收尾 ── */

export function releaseAllMediaURLs() {
    urlCache.forEach((entry) => URL.revokeObjectURL(entry.url));
    urlCache.clear();
    pendingUrls.clear();
}

export function releaseAllThumbURLs() {
    thumbCache.forEach((url) => {
        if (typeof url === "string") URL.revokeObjectURL(url);
    });
    thumbCache.clear();
}

export const PHOTOS_ROOT = PICTURE_ROOT;
export const EXTERNAL_ID_PREFIX = EXTERNAL_PREFIX;
