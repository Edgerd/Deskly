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

    // 仅处理同源、且路径命中 /mods/<id>/<file> 的请求
    if (url.origin !== self.location.origin) return;
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("mods");
    if (idx === -1) return;
    const id = parts[idx + 1];
    if (!id) return;
    const fileName = parts.slice(idx + 2).join("/");
    if (!fileName) return;

    event.respondWith(serveFromDb(event.request, id, fileName));
});

/**
 * 从 IndexedDB 读取已安装插件的某文件；未命中则透传网络（磁盘插件）。
 */
async function serveFromDb(request, id, fileName) {
    try {
        const rec = await getRecord(id);
        if (rec && rec.files) {
            const blob =
                rec.files[fileName] ||
                matchBySuffix(rec.files, fileName);
            if (blob) {
                return new Response(blob, {
                    headers: { "Content-Type": contentType(fileName) },
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
 * 读取已安装插件记录（懒打开 IndexedDB，版本与 plugin-manager 保持一致）。
 */
function getRecord(id) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "id" });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(STORE, "readonly");
            const getReq = tx.objectStore(STORE).get(id);
            getReq.onsuccess = () => resolve(getReq.result || null);
            getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
    });
}
