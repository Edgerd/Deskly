/**
 * sw.js — Web Start OS 插件资源 Service Worker
 *
 * 职责：让「ZIP 安装」的插件（资源存于 IndexedDB，而非磁盘 ./mods/ 目录）
 * 像磁盘插件一样被加载，从而支持：
 *   1. 刷新/重开后仍可从 IndexedDB 取回资源（持久化）；
 *   2. 插件脚本中的相对 import（./sibling.js、../../src/...）按真实
 *      ./mods/<id>/ 路径解析，由本 SW 一并命中返回。
 *
 * 磁盘插件（BUILTIN_IDS）的请求不在已安装清单中，直接透传网络，无副作用。
 */

const DB_NAME = "webstartos-plugins";
const STORE = "installed";

// 安装后立即激活，并在 activate 时接管已打开的页面（clients.claim）
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // 只认根下的 /mods/<id>/<file>。早先用 parts.indexOf("mods") 会把路径中段带 mods 段的
    // 同源请求也截下来，白做一次库查询；判据要与 api-grants.js 的 MODS_FRAME 同一语义。
    if (url.origin !== self.location.origin) return;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "mods") return;
    const id = parts[1];
    if (!id) return;
    const fileName = parts.slice(2).join("/");
    if (!fileName) return;

    // URL 路径是百分号编码的，而 IndexedDB 里的键是 ZIP 内的原始名（含空格/非 ASCII 时
    // 两者不等：`Microsoft%20Word.png` 查不到 `Microsoft Word.png`，直接漏到网络变 404）。
    event.respondWith(serveFromDb(event.request, id, decodeName(fileName)));
});

/**
 * 已安装插件 id 集合（内存缓存）。
 *
 * 为什么需要：磁盘内置插件（./mods/）的每个 html/css/js/图标请求也会走到 fetch 里，
 * 旧写法对每一个都做一次 IndexedDB get —— 打开一个应用就是几十次事务，全落在启动最
 * 敏感的时段。内置 id 永远不在这个库里，所以先用一次 getAllKeys 建集合，没命中就直连网络。
 *
 * 失效时机：页面在安装 / 卸载后 postMessage `{type:"installed-changed"}`（见
 * plugin-manager 的 registerInstalledPlugin / unregisterInstalledPlugin）；库连接被版本
 * 变更或关闭时也清空。不清的话，刚装好的插件会被当成磁盘插件漏到网络，装完打不开。
 */
let installedIds = null;
let idsPromise = null;

function resetInstalledIds() {
    installedIds = null;
    idsPromise = null;
}

/** 读一次全部已安装 id；失败时清缓存，让下一次请求重试。 */
function getAllIds() {
    if (installedIds) return Promise.resolve(installedIds);
    if (idsPromise) return idsPromise;
    idsPromise = openDb()
        .then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const req = tx.objectStore(STORE).getAllKeys();
            req.onsuccess = () => resolve(new Set(req.result || []));
            req.onerror = () => reject(req.error);
            tx.onerror = () => reject(tx.error);
        }))
        .then((set) => { installedIds = set; return set; })
        .catch((err) => { resetInstalledIds(); throw err; });
    return idsPromise;
}

// 顶层同步注册（MV3 service worker 的要求：不能等异步再 addListener）。
// 页面侧会带一个 MessageChannel 等 ack：安装校验紧跟在写库之后，只发不等会撞上
// 「缓存还没失效就回读资源」的竞态。
self.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "installed-changed") return;
    resetInstalledIds();
    if (event.ports && event.ports[0]) event.ports[0].postMessage("ok");
});

/**
 * 解码请求路径里的文件名；遇到畸形的 `%` 序列时退回原文，不让一个坏 URL 拖垮整个请求。
 * @param {string} raw 来自 location.pathname 的编码名
 * @returns {string} 可与 IndexedDB 键对齐的名字
 */
function decodeName(raw) {
    try {
        return decodeURIComponent(raw);
    } catch (err) {
        return raw;
    }
}

/**
 * 从 IndexedDB 读取已安装插件的某文件；未命中则透传网络（磁盘插件）。
 */
async function serveFromDb(request, id, fileName) {
    try {
        // 先问内存集合：磁盘内置插件不在这里，直接透传，一次库都不碰。
        const ids = await getAllIds();
        if (!ids.has(id)) return fetch(request);
        const rec = await getRecord(id);
        if (rec && rec.files) {
            const blob =
                rec.files[fileName] ||
                matchBySuffix(rec.files, fileName);
            if (blob) {
                // 标记头：安装器逐条回读声明的资源时，靠「有没有这个头」判断请求确实
                // 由本 SW 从 IndexedDB 返回。注册成功 ≠ 页面被接管，没有头就必须当成失败，
                // 否则装完是个打不开的插件。
                return new Response(blob, {
                    headers: {
                        "Content-Type": contentType(fileName),
                        "X-Deskly-Plugin": id,
                        "Cache-Control": "no-store",
                    },
                });
            }
        }
    } catch (err) {
        console.warn("[sw] 读取已安装插件资源失败，回退网络：", err);
    }
    return fetch(request);
}

/**
 * 按后缀兜底匹配：ZIP 内文件可能带公共根目录前缀（如 myplugin/index.html），
 * 而请求路径为 ./mods/<id>/index.html，需在 files 中做后缀匹配。
 */
function matchBySuffix(files, fileName) {
    const hit = Object.keys(files).find(
        (k) => k === fileName || k.endsWith("/" + fileName)
    );
    return hit ? files[hit] : null;
}

/**
 * 根据文件名后缀返回合适的 Content-Type（模块脚本必须是 JS MIME 才能执行）。
 */
function contentType(name) {
    const ext = name.split(".").pop().toLowerCase();
    const map = {
        js: "text/javascript",
        mjs: "text/javascript",
        css: "text/css",
        html: "text/html",
        htm: "text/html",
        json: "application/json",
        map: "application/json",
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        ico: "image/x-icon",
        woff: "font/woff",
        woff2: "font/woff2",
        ttf: "font/ttf",
        otf: "font/otf",
        txt: "text/plain",
        md: "text/plain",
    };
    return map[ext] || "application/octet-stream";
}

/**
 * 读取已安装插件记录（连接复用，形状照 api-grants.js / osfs.js 的 openDb）。
 *
 * 旧写法是**每个被拦截的请求都 indexedDB.open 一次、而且从不 close**：
 * 开一个 ZIP 插件就是几十个资源请求 = 几十个常驻数据库连接，SW 被回收前一路挂着，
 * 多标签并发时还容易撞上版本变更阻塞。全仓另外两处 IndexedDB（osfs.js:84、
 * api-grants.js:93）都已经是「缓存 dbPromise + onversionchange/onclose 里 close
 * 并清空缓存」的写法，这里是第三个实例，之前漏改。
 */
let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "id" });
            }
        };
        // 别的连接占着旧版本时 open 既不 success 也不 error：不 reject 的话
        // dbPromise 会被永久缓存，之后所有资源请求都挂在上面再无重试机会。
        req.onblocked = () => {
            dbPromise = null;
            reject(new Error("IndexedDB 升级被其它连接阻塞"));
        };
        req.onsuccess = () => {
            const db = req.result;
            // 连接换了就是库换了一批内容：id 集合必须一起作废，否则新装的插件照旧查不到。
            db.onversionchange = () => { db.close(); dbPromise = null; resetInstalledIds(); };
            db.onclose = () => { dbPromise = null; resetInstalledIds(); };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

function getRecord(id) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const getReq = tx.objectStore(STORE).get(id);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => reject(getReq.error);
        tx.onerror = () => reject(tx.error);
        // 只读事务结束后这条连接对本请求就没用了；连接本身由 openDb 长期复用，
        // 不在这里 close，否则缓存就失去意义。
    }));
}
