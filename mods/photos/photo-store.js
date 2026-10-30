/**
 * photo-store.js — 照片二进制资源仓库（IndexedDB + 对象 URL 缓存）
 *
 * 为什么二进制不进 localStorage：base64 会比原文件大约 33%，而单个源的配额只有 ~5MB，
 * 一个 3.8MB 的照片就能写满，表现为「导入后界面有项目、刷新后全部消失」。
 * 这里 Blob 原样存 IndexedDB（配额按磁盘可用空间算，量大几个数量级），
 * localStorage 只留元数据（见 script.js 的 saveLibrary）。
 *
 * 两条独立缓存：
 * - media：原图/原视频。网格与胶片条不再直接使用它，只有预览与导入分析按需取用，
 *   并且用引用计数（getMediaURL / releaseMediaURL）配对回收 —— 否则一次浏览几百张
 *   原图会把 Blob 全部钉在内存里。
 * - thumbs：导入时生成的缩略图（最长边 640）。网格、列表、详情与胶片条共用，
 *   常驻到窗口卸载或项目删除，体积约为原图的几十分之一。
 */

const DB_NAME = "webstartos-photos";
const DB_VERSION = 2;
const MEDIA_STORE = "media";
const THUMB_STORE = "thumbs";

// 数据库句柄（模块级复用，避免每次读写都 open 一次）
let dbPromise = null;
// id -> { url, refs }：原媒体对象 URL（引用计数）
const urlCache = new Map();
// id -> Promise<entry>：同一 id 的并发读取合并成一次，避免创建两个对象 URL
const pendingUrls = new Map();
// id -> string|null：缩略图对象 URL；null 表示「查过，确实没有」
const thumbCache = new Map();

/**
 * 懒打开照片数据库（连接复用：整个模块生命周期只 open 一次）。
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
                if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE, { keyPath: "id" });
            };
            req.onsuccess = () => {
                const db = req.result;
                // 别的标签页（或未来的版本升级）请求升级时，旧连接会一直卡住对方的
                // upgradeneeded，必须主动让位；同时复位句柄，下次读写重新打开。
                db.onversionchange = () => closeDb();
                db.onclose = () => { if (dbPromise === p) dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error || new Error("无法打开照片数据库"));
        });
        const p = dbPromise;
        // 打开失败时重置句柄，下次调用可重试（否则永久缓存一个 rejected Promise）
        p.catch(() => { if (dbPromise === p) dbPromise = null; });
    }
    return dbPromise;
}

/**
 * 关闭当前连接并复位句柄（versionchange 让位 / 异常收尾时调用）。
 * 在途事务会随连接关闭被中止并 reject，由各自的 catch 处理。
 * @returns {void}
 */
function closeDb() {
    const p = dbPromise;
    dbPromise = null;
    if (!p) return;
    p.then((db) => { try { db.close(); } catch (e) { /* 已关闭 */ } }).catch(() => {});
}

/**
 * 在单个仓库上执行一次事务。
 * @param {string} storeName 仓库名
 * @param {IDBTransactionMode} mode 事务模式
 * @param {(store: IDBObjectStore) => (IDBRequest|undefined)|void} action 事务操作
 * @returns {Promise<any>} 请求结果（action 无请求时 resolve 为 undefined）
 */
function runTx(storeName, mode, action) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = action(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error || (req && req.error) || new Error("照片数据库写入失败"));
        tx.onabort = () => reject(tx.error || new Error("照片数据库事务被中止"));
    }));
}

/**
 * 在媒体与缩略图两个仓库上执行一次事务（删除项目时保证两边一起成功）。
 * @param {IDBTransactionMode} mode 事务模式
 * @param {(stores: {media: IDBObjectStore, thumbs: IDBObjectStore}) => void} action 事务操作
 * @returns {Promise<void>}
 */
function runBothTx(mode, action) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction([MEDIA_STORE, THUMB_STORE], mode);
        action({ media: tx.objectStore(MEDIA_STORE), thumbs: tx.objectStore(THUMB_STORE) });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("照片数据库写入失败"));
        tx.onabort = () => reject(tx.error || new Error("照片数据库事务被中止"));
    }));
}

/**
 * 保存一个媒体 Blob（配额满或存储异常时抛出，由调用方回滚并提示）。
 * @param {string} id 项目 id
 * @param {Blob} blob 媒体二进制
 * @returns {Promise<void>}
 */
export function putMedia(id, blob) {
    return runTx(MEDIA_STORE, "readwrite", (store) => store.put({ id, blob, savedAt: Date.now() }));
}

/**
 * 读取媒体 Blob。
 * @param {string} id 项目 id
 * @returns {Promise<Blob|null>} 不存在时 resolve 为 null
 */
export async function getMedia(id) {
    const row = await runTx(MEDIA_STORE, "readonly", (store) => store.get(id));
    return row && row.blob ? row.blob : null;
}

/**
 * 取得可直接赋给 img/video src 的原媒体对象 URL（按需创建，引用计数 +1）。
 * 每个调用方用完后必须调用 releaseMediaURL(id) 配对释放。
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

/**
 * 释放一次原媒体 URL 引用；引用归零时 revoke。
 * @param {string} id 项目 id
 * @returns {void}
 */
export function releaseMediaURL(id) {
    const entry = urlCache.get(id);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    URL.revokeObjectURL(entry.url);
    urlCache.delete(id);
}

/**
 * 无视引用计数地回收某个 id 的对象 URL（删除项目时使用）。
 * @param {string} id 项目 id
 * @returns {void}
 */
export function dropMediaURL(id) {
    const entry = urlCache.get(id);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    urlCache.delete(id);
}

/**
 * 保存缩略图并让它立即可用（覆盖旧图时先回收旧对象 URL）。
 * @param {string} id 项目 id
 * @param {Blob|null} blob 缩略图；传 null 等同于删除
 * @returns {Promise<void>}
 */
export async function putThumb(id, blob) {
    if (!blob) {
        await deleteThumb(id);
        return;
    }
    await runTx(THUMB_STORE, "readwrite", (store) => store.put({ id, blob, savedAt: Date.now() }));
    const old = thumbCache.get(id);
    if (typeof old === "string") URL.revokeObjectURL(old);
    thumbCache.set(id, URL.createObjectURL(blob));
}

/**
 * 删除某个项目的缩略图记录与对象 URL。
 * @param {string} id 项目 id
 * @returns {Promise<void>}
 */
export async function deleteThumb(id) {
    const old = thumbCache.get(id);
    if (typeof old === "string") URL.revokeObjectURL(old);
    thumbCache.delete(id);
    await runTx(THUMB_STORE, "readwrite", (store) => store.delete(id));
}

/**
 * 取得缩略图对象 URL；没有缩略图时 resolve 为 null（并记住这个结果，避免反复查库）。
 * @param {string} id 项目 id
 * @returns {Promise<string|null>}
 */
export async function getThumbURL(id) {
    if (thumbCache.has(id)) return thumbCache.get(id);
    const row = await runTx(THUMB_STORE, "readonly", (store) => store.get(id));
    if (!row || !row.blob) {
        thumbCache.set(id, null);
        return null;
    }
    const url = URL.createObjectURL(row.blob);
    thumbCache.set(id, url);
    return url;
}

/**
 * 回收单个缩略图对象 URL（记录保留，下次 getThumbURL 会重建）。
 * @param {string} id 项目 id
 * @returns {void}
 */
export function releaseThumbURL(id) {
    const url = thumbCache.get(id);
    if (typeof url === "string") URL.revokeObjectURL(url);
    thumbCache.delete(id);
}

/**
 * 删除媒体与缩略图记录，并回收所有对象 URL。
 * @param {string[]} ids 项目 id 列表
 * @returns {Promise<void>}
 */
export function deleteMedia(ids) {
    const list = Array.from(ids || []);
    if (!list.length) return Promise.resolve();
    list.forEach((id) => {
        dropMediaURL(id);
        const thumb = thumbCache.get(id);
        if (typeof thumb === "string") URL.revokeObjectURL(thumb);
        thumbCache.delete(id);
    });
    return runBothTx("readwrite", ({ media, thumbs }) => {
        list.forEach((id) => {
            media.delete(id);
            thumbs.delete(id);
        });
    });
}

/**
 * 释放本会话缓存的全部原媒体对象 URL（插件卸载时调用）。
 * @returns {void}
 */
export function releaseAllMediaURLs() {
    urlCache.forEach((entry) => URL.revokeObjectURL(entry.url));
    urlCache.clear();
    pendingUrls.clear();
}

/**
 * 释放本会话缓存的全部缩略图对象 URL（插件卸载时调用，下次打开按需重建）。
 * @returns {void}
 */
export function releaseAllThumbURLs() {
    thumbCache.forEach((url) => {
        if (typeof url === "string") URL.revokeObjectURL(url);
    });
    thumbCache.clear();
}

/**
 * 把旧版存在 localStorage 里的 data URI 还原成 Blob（迁移用）。
 * @param {string} dataUrl base64 data URI
 * @returns {Blob} 对应 Blob
 */
export function dataURLToBlob(dataUrl) {
    const comma = String(dataUrl).indexOf(",");
    if (comma === -1) throw new Error("不是合法的 data URI");
    const meta = String(dataUrl).slice(0, comma);
    const mime = /^data:([^;,]+)/.exec(meta);
    const bin = atob(String(dataUrl).slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: (mime && mime[1]) || "application/octet-stream" });
}
