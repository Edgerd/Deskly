/**
 * vfs.js — 虚拟文件系统（"此电脑"）核心模块
 *
 * 职责：
 * 1. 定义虚拟根目录 "/" 下的五个顶层文件夹：收藏夹、下载、文档、图片、桌面。
 * 2. 通过 File System Access API 授权并映射真实文件夹（下载/文档/图片），
 *    将 FileSystemDirectoryHandle 持久化到 IndexedDB。
 * 3. 对不支持 File System Access API 的环境提供降级方案（虚拟文件夹）。
 * 4. 提供统一的路径解析与目录列举 API，供访达等界面层调用。
 * 5. 提供收藏夹读取（chrome.bookmarks API，其他浏览器降级为虚拟书签）与
 *    桌面虚拟文件夹（IndexedDB 存储）。
 *
 * 注意：
 * - File System Access API 仅 Chromium 系（Chrome/Edge 86+）支持，需 HTTPS 或 localhost。
 * - 文件系统句柄权限不是永久的，每次启动需通过 queryPermission/requestPermission 复核。
 */

// IndexedDB 数据库名与对象仓库
const DB_NAME = "webstartos-vfs";
const DB_VERSION = 1;
const STORE_HANDLES = "handles";       // 真实文件夹句柄（keyPath: key）
const STORE_VIRTUAL = "virtualfiles";  // 桌面虚拟文件夹文件（keyPath: path）

// 授权状态存储键（localStorage）
const AUTH_KEY = "webstartos_vfs_auth";
// 降级虚拟书签存储键（localStorage）
const BOOKMARKS_KEY = "webstartos_vfs_bookmarks";

// 需授权的真实文件夹定义
const REAL_FOLDERS = {
    download: { key: "download", label: "下载", path: "/下载", icon: "folder/Download.png" },
    docs:     { key: "docs",     label: "文档", path: "/文档", icon: "folder/Documents.png" },
    pictures: { key: "pictures", label: "图片", path: "/图片", icon: "folder/Pictures.png" },
};

// 虚拟文件夹定义（无需授权）
const VIRTUAL_FOLDERS = {
    favorites: { key: "favorites", label: "收藏夹", path: "/收藏夹", icon: "folder/Mac OS.png" },
    desktop:   { key: "desktop",   label: "桌面",   path: "/桌面",   icon: "folder/Desktop.png" },
};

// 已加载的真实文件夹句柄：key -> FileSystemDirectoryHandle
let handles = {};

// 授权状态：pending / granted / declined
let authStatus = "pending";

// 是否已初始化
let initialized = false;

/**
 * 打开 VFS 数据库（懒加载）。
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_HANDLES)) {
                db.createObjectStore(STORE_HANDLES, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(STORE_VIRTUAL)) {
                db.createObjectStore(STORE_VIRTUAL, { keyPath: "path" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// 在指定对象仓库上执行一次事务；op 接收 objectStore 并可返回请求，
// 事务完成时 resolve 为请求结果（无请求则为 undefined），失败时 reject(tx.error)。
function _tx(db, store, mode, op) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = op(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
    });
}

// 从 localStorage 读取并解析 JSON，解析失败或缺失时回退 fallback。
function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
        return fallback;
    }
}

/**
 * 从 IndexedDB 读取全部真实文件夹句柄。
 * @returns {Promise<Record<string, FileSystemDirectoryHandle>>}
 */
async function loadHandles() {
    try {
        const db = await openDb();
        const result = (await _tx(db, STORE_HANDLES, "readonly", (os) => os.getAll())) || [];
        const map = {};
        result.forEach((row) => { map[row.key] = row.handle; });
        return map;
    } catch (err) {
        console.warn("[vfs] 读取句柄失败：", err);
        return {};
    }
}

/**
 * 将真实文件夹句柄写入 IndexedDB。
 * @param {string} key 文件夹键（download/docs/pictures）
 * @param {FileSystemDirectoryHandle} handle 目录句柄
 * @returns {Promise<void>}
 */
async function saveHandle(key, handle) {
    const db = await openDb();
    await _tx(db, STORE_HANDLES, "readwrite", (os) => os.put({ key, handle }));
}

/**
 * 读取授权状态（localStorage）。
 * @returns {string} pending / granted / declined
 */
function readAuthStatus() {
    const data = readJSON(AUTH_KEY, null);
    return data && data.status ? data.status : "pending";
}

/**
 * 写入授权状态（localStorage）。
 * @param {string} status pending / granted / declined
 */
function writeAuthStatus(status) {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ status, time: Date.now() }));
}

/**
 * 判断浏览器是否支持 File System Access API。
 * @returns {boolean}
 */
function isSupported() {
    return typeof window.showDirectoryPicker === "function";
}

/**
 * 规范化路径：确保以 "/" 开头，不以 "/" 结尾（根目录除外）。
 * @param {string} path 原始路径
 * @returns {string} 规范化路径
 */
function normalizePath(path) {
    if (!path || path === "/") return "/";
    let p = "/" + String(path).replace(/^\/+/, "").replace(/\/+$/, "");
    return p === "" ? "/" : p;
}

/**
 * 将路径拆分为片段数组。
 * @param {string} path 规范化路径
 * @returns {string[]} 路径片段
 */
function splitPath(path) {
    if (!path || path === "/") return [];
    return path.split("/").filter(Boolean);
}

/**
 * 根据顶层片段获取对应文件夹定义。
 * @param {string} top 顶层文件夹名（如 "下载"）
 * @returns {object|undefined} 文件夹定义
 */
function resolveTop(top) {
    for (const f of Object.values(REAL_FOLDERS)) {
        if (f.label === top) return { ...f, kind: "real" };
    }
    for (const f of Object.values(VIRTUAL_FOLDERS)) {
        if (f.label === top) return { ...f, kind: "virtual" };
    }
    return undefined;
}

/**
 * 校验某个真实文件夹句柄的读取权限是否已授予。
 * @param {FileSystemDirectoryHandle} handle 目录句柄
 * @returns {Promise<boolean>} 是否已授予读取权限
 */
async function ensureReadPermission(handle) {
    try {
        const opts = { mode: "read" };
        const state = await handle.queryPermission(opts);
        if (state === "granted") return true;
        const req = await handle.requestPermission(opts);
        return req === "granted";
    } catch (err) {
        console.warn("[vfs] 权限校验失败：", err);
        return false;
    }
}

/**
 * 初始化 VFS：加载句柄与授权状态。
 * @returns {Promise<void>}
 */
async function init() {
    if (initialized) return;
    handles = await loadHandles();
    authStatus = readAuthStatus();
    initialized = true;
}

/**
 * 获取当前授权状态。
 * @returns {object} { status, supported, folders }
 */
function getAuthStatus() {
    return {
        status: authStatus,
        supported: isSupported(),
        folders: {
            download: !!handles.download,
            docs: !!handles.docs,
            pictures: !!handles.pictures,
        },
    };
}

/**
 * 授权流程：依次弹出三个系统文件夹选择器，将句柄持久化。
 * 用户取消某个选择器时，该文件夹保持未授权。
 * @returns {Promise<object>} 授权后状态
 */
async function authorize() {
    if (!isSupported()) {
        throw new Error("当前浏览器不支持 File System Access API，请使用 Chrome/Edge 并确保在 HTTPS 或 localhost 环境运行。");
    }
    const pickers = [
        { key: "download", label: "下载" },
        { key: "docs", label: "文档" },
        { key: "pictures", label: "图片" },
    ];
    for (const it of pickers) {
        try {
            const handle = await window.showDirectoryPicker({ id: `webstartos-${it.key}`, mode: "read" });
            if (handle) {
                handles[it.key] = handle;
                await saveHandle(it.key, handle);
            }
        } catch (err) {
            // 用户取消或选择器关闭：跳过该文件夹，不视为失败
            console.info(`[vfs] 用户未授权「${it.label}」文件夹：`, err.name || err);
        }
    }
    authStatus = "granted";
    writeAuthStatus("granted");
    return getAuthStatus();
}

/**
 * 对单个真实文件夹重新授权（用于设置中修改映射路径）。
 * @param {string} key 文件夹键（download/docs/pictures）
 * @returns {Promise<object>} 授权后状态
 */
async function authorizeOne(key) {
    if (!isSupported()) {
        throw new Error("当前浏览器不支持 File System Access API，请使用 Chrome/Edge 并确保在 HTTPS 或 localhost 环境运行。");
    }
    const def = REAL_FOLDERS[key];
    if (!def) {
        throw new Error("未知文件夹：" + key);
    }
    const handle = await window.showDirectoryPicker({ id: `webstartos-${key}`, mode: "read" });
    if (handle) {
        handles[key] = handle;
        await saveHandle(key, handle);
        authStatus = "granted";
        writeAuthStatus("granted");
    }
    return getAuthStatus();
}

/**
 * 拒绝授权：仅保留虚拟文件夹。
 * @returns {object} 授权后状态
 */
function decline() {
    authStatus = "declined";
    writeAuthStatus("declined");
    return getAuthStatus();
}

/**
 * 重新申请已授权句柄的读取权限（启动时调用）。
 * @returns {Promise<boolean>} 是否全部仍有权限
 */
async function requestPermissions() {
    if (authStatus !== "granted") return false;
    // 需要用户手势，仅当句柄仍存在时尝试
    let allGranted = true;
    for (const key of Object.keys(handles)) {
        const ok = await ensureReadPermission(handles[key]);
        if (!ok) allGranted = false;
    }
    return allGranted;
}

/**
 * 沿路径解析真实文件夹句柄。
 * @param {string} path 规范化路径
 * @returns {Promise<FileSystemDirectoryHandle|null>} 目录句柄，失败返回 null
 */
async function resolveRealHandle(path) {
    const segs = splitPath(path);
    if (segs.length === 0) return null;
    const top = resolveTop(segs[0]);
    if (!top || top.kind !== "real") return null;
    let handle = handles[top.key];
    if (!handle) return null;
    for (let i = 1; i < segs.length; i++) {
        try {
            handle = await handle.getDirectoryHandle(segs[i]);
        } catch (err) {
            return null;
        }
    }
    return handle;
}

/**
 * 读取真实目录下全部条目。
 * @param {FileSystemDirectoryHandle} dirHandle 目录句柄
 * @param {string} parentPath 父级路径（用于拼接条目路径）
 * @returns {Promise<Array<object>>} 条目数组
 */
async function listRealDirectory(dirHandle, parentPath) {
    const entries = [];
    for await (const [name, child] of dirHandle.entries()) {
        const isDir = child.kind === "directory";
        const entry = {
            name,
            type: isDir ? "folder" : "file",
            path: `${parentPath === "/" ? "" : parentPath}/${name}`,
            modified: isDir ? null : null,
            size: isDir ? null : null,
            handle: child,
        };
        if (isDir) {
            entry.size = null;
        } else {
            try {
                const file = await child.getFile();
                entry.size = file.size;
                entry.modified = file.lastModified;
            } catch (err) {
                entry.size = null;
                entry.modified = null;
            }
        }
        entries.push(entry);
    }
    // 目录优先，再按名称排序
    entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
    });
    return entries;
}

/**
 * 获取最近使用文件列表（跨所有已授权真实文件夹扫描）。
 * @param {number} [count=50] 返回条目数上限
 * @returns {Promise<Array<object>>} 按修改时间降序排列的条目数组
 */
async function getRecentFiles(count = 50) {
    const results = [];
    const scanTasks = Object.entries(handles).map(async ([key, handle]) => {
        try {
            const ok = await ensureReadPermission(handle);
            if (!ok) return;
            const def = REAL_FOLDERS[key];
            const parentPath = def ? def.path : '/';
            await scanDirectoryForRecent(handle, parentPath, results, 0, 2); // 深度 2
        } catch (err) {
            // 忽略单个文件夹扫描失败
        }
    });
    await Promise.all(scanTasks);
    // 按修改时间降序排列
    results.sort((a, b) => (b.modified || 0) - (a.modified || 0));
    return results.slice(0, count);
}

/**
 * 递归扫描目录收集最近文件。
 * @param {FileSystemDirectoryHandle} dirHandle 目录句柄
 * @param {string} parentPath 父路径
 * @param {Array<object>} results 结果收集数组
 * @param {number} depth 当前深度
 * @param {number} maxDepth 最大深度
 */
async function scanDirectoryForRecent(dirHandle, parentPath, results, depth, maxDepth) {
    if (depth > maxDepth) return;
    for await (const [name, child] of dirHandle.entries()) {
        const entryPath = `${parentPath === '/' ? '' : parentPath}/${name}`;
        if (child.kind === 'directory') {
            if (depth < maxDepth) {
                try {
                    await scanDirectoryForRecent(child, entryPath, results, depth + 1, maxDepth);
                } catch (err) {
                    // 跳过无权限子目录
                }
            }
        } else {
            try {
                const file = await child.getFile();
                results.push({
                    name,
                    type: 'file',
                    path: entryPath,
                    modified: file.lastModified,
                    size: file.size,
                    handle: child,
                });
            } catch (err) {
                // 跳过无法读取的文件
            }
        }
    }
}

/**
 * 跨所有已授权文件夹搜索文件。
 * @param {string} query 搜索关键词
 * @param {number} [maxResults=100] 结果上限
 * @returns {Promise<Array<object>>} 匹配条目数组
 */
async function searchFiles(query, maxResults = 100) {
    if (!query || !query.trim()) return [];
    const q = query.toLowerCase().trim();
    const results = [];
    const scanTasks = Object.entries(handles).map(async ([key, handle]) => {
        try {
            const ok = await ensureReadPermission(handle);
            if (!ok) return;
            const def = REAL_FOLDERS[key];
            const parentPath = def ? def.path : '/';
            await scanDirectoryForSearch(handle, parentPath, q, results, 0, 3, maxResults);
        } catch (err) {
            // 忽略
        }
    });
    await Promise.all(scanTasks);
    return results.slice(0, maxResults);
}

/**
 * 递归扫描目录搜索匹配文件名的文件。
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} parentPath
 * @param {string} query 小写关键词
 * @param {Array<object>} results
 * @param {number} depth
 * @param {number} maxDepth
 * @param {number} maxResults
 */
async function scanDirectoryForSearch(dirHandle, parentPath, query, results, depth, maxDepth, maxResults) {
    if (depth > maxDepth || results.length >= maxResults) return;
    for await (const [name, child] of dirHandle.entries()) {
        if (results.length >= maxResults) break;
        if (name.toLowerCase().includes(query)) {
            const entryPath = `${parentPath === '/' ? '' : parentPath}/${name}`;
            if (child.kind === 'directory') {
                results.push({
                    name,
                    type: 'folder',
                    path: entryPath,
                    modified: null,
                    size: null,
                    handle: child,
                });
            } else {
                try {
                    const file = await child.getFile();
                    results.push({
                        name,
                        type: 'file',
                        path: entryPath,
                        modified: file.lastModified,
                        size: file.size,
                        handle: child,
                    });
                } catch (err) {
                    results.push({
                        name,
                        type: 'file',
                        path: entryPath,
                        modified: null,
                        size: null,
                        handle: child,
                    });
                }
            }
        }
        if (child.kind === 'directory' && depth < maxDepth) {
            try {
                await scanDirectoryForSearch(child, entryPath, query, results, depth + 1, maxDepth, maxResults);
            } catch (err) {
                // 跳过
            }
        }
    }
}

/**
 * 读取收藏夹书签根节点。
 * 优先使用 chrome.bookmarks API，否则使用降级虚拟书签。
 * @returns {Promise<Array<object>>} 书签条目数组
 */
async function getBookmarkRoot() {
    if (typeof chrome !== "undefined" && chrome.bookmarks && chrome.bookmarks.getTree) {
        try {
            const tree = await chrome.bookmarks.getTree();
            const root = tree[0];
            const children = root && root.children ? root.children : [];
            return children.map((node) => toBookmarkEntry(node, "/收藏夹"));
        } catch (err) {
            console.warn("[vfs] chrome.bookmarks 读取失败，使用虚拟书签：", err);
        }
    }
    return loadFallbackBookmarks("/收藏夹");
}

/**
 * 将 chrome.bookmarks 节点转换为通用条目。
 * @param {object} node 书签节点
 * @param {string} parentPath 父级路径
 * @returns {object} 条目
 */
function toBookmarkEntry(node, parentPath) {
    const isFolder = !node.url;
    const path = `${parentPath === "/收藏夹" ? "/收藏夹" : parentPath}/${node.title}`;
    return {
        name: node.title,
        type: isFolder ? "folder" : "bookmark",
        bookmark: true,
        url: node.url || null,
        path,
        modified: null,
        size: null,
        bookmarkId: node.id,
    };
}

/**
 * 读取收藏夹指定书签文件夹下的子节点。
 * @param {string} path 书签文件夹路径
 * @returns {Promise<Array<object>>} 书签条目数组
 */
async function getBookmarkChildren(path) {
    const segs = splitPath(path);
    // 收藏夹根：返回顶层书签
    if (segs.length <= 1) return getBookmarkRoot();

    if (typeof chrome !== "undefined" && chrome.bookmarks) {
        try {
            // 通过递归查找 chrome.bookmarks 树中匹配路径的节点
            const tree = await chrome.bookmarks.getTree();
            const target = findBookmarkByPath(tree[0], segs.slice(1));
            if (target && target.children) {
                return target.children.map((node) => toBookmarkEntry(node, path));
            }
            return [];
        } catch (err) {
            console.warn("[vfs] 书签子节点读取失败：", err);
        }
    }
    return loadFallbackBookmarkChildren(path);
}

/**
 * 在书签树中按标题路径查找节点。
 * @param {object} node 当前节点
 * @param {string[]} segs 标题片段
 * @returns {object|undefined} 匹配节点
 */
function findBookmarkByPath(node, segs) {
    if (!node || !node.children) return undefined;
    for (const child of node.children) {
        if (child.title === segs[0]) {
            if (segs.length === 1) return child;
            return findBookmarkByPath(child, segs.slice(1));
        }
    }
    return undefined;
}

/**
 * 读取降级虚拟书签（localStorage）。
 * @param {string} path 收藏夹路径
 * @returns {Array<object>} 书签节点数组
 */
function loadFallbackBookmarks(path) {
    return readJSON(BOOKMARKS_KEY, []).map((node) => toBookmarkEntry(node, path));
}

/**
 * 读取降级虚拟书签的指定文件夹子节点。
 * @param {string} path 收藏夹路径
 * @returns {Array<object>} 书签节点数组
 */
function loadFallbackBookmarkChildren(path) {
    const segs = splitPath(path).slice(1); // 去掉"收藏夹"
    const cursor = readJSON(BOOKMARKS_KEY, []);
    for (const seg of segs) {
        const hit = cursor.find((n) => n.title === seg && !n.url);
        if (!hit || !hit.children) return [];
        cursor = hit.children;
    }
    return cursor.map((node) => toBookmarkEntry(node, path));
}

/**
 * 在降级虚拟书签根下新增一个书签。
 * @param {string} title 标题
 * @param {string} url 网址
 */
function addFallbackBookmark(title, url) {
    const nodes = readJSON(BOOKMARKS_KEY, []);
    nodes.push({ id: "vb_" + Date.now(), title, url });
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(nodes));
}

/**
 * 归一化书签节点为纯对象树（不包含系统句柄）。
 * @param {Array<object>} nodes 书签节点数组
 * @returns {Array<object>} 规整后的树节点
 */
function normalizeTree(nodes) {
    return (nodes || []).map((n) => ({
        id: n.id,
        title: n.title,
        url: n.url || null,
        children: n.children ? normalizeTree(n.children) : [],
    }));
}

/**
 * 读取降级虚拟书签原始节点。
 * @returns {Array<object>} 书签节点数组
 */
function loadFallbackNodes() {
    return readJSON(BOOKMARKS_KEY, []);
}

/**
 * 获取收藏夹完整树（用于侧边栏树形展示）。
 * @returns {Promise<Array<object>>} 书签树节点数组
 */
async function getBookmarkTree() {
    if (typeof chrome !== "undefined" && chrome.bookmarks && chrome.bookmarks.getTree) {
        try {
            const tree = await chrome.bookmarks.getTree();
            const root = tree[0];
            return normalizeTree(root.children || []);
        } catch (err) {
            console.warn("[vfs] 书签树读取失败，使用虚拟书签：", err);
        }
    }
    return normalizeTree(loadFallbackNodes());
}

/**
 * 读取桌面虚拟文件夹全部文件。
 * @returns {Promise<Array<object>>} 文件条目数组
 */
async function listVirtualFiles() {
    try {
        const db = await openDb();
        const result = (await _tx(db, STORE_VIRTUAL, "readonly", (os) => os.getAll())) || [];
        return result.map((row) => ({
            name: row.name,
            type: "file",
            path: `/桌面/${row.name}`,
            modified: row.modified,
            size: row.content ? row.content.length : null,
            storePath: row.path,
        }));
    } catch (err) {
        console.warn("[vfs] 读取桌面虚拟文件失败：", err);
        return [];
    }
}

/**
 * 向桌面虚拟文件夹写入一个文件。
 * @param {string} name 文件名
 * @param {string} content 文件内容
 * @returns {Promise<void>}
 */
async function addVirtualFile(name, content) {
    const db = await openDb();
    const path = `/桌面/${name}`;
    await _tx(db, STORE_VIRTUAL, "readwrite", (os) => os.put({ path, name, content, modified: Date.now() }));
}

/**
 * 读取桌面虚拟文件内容。
 * @param {string} storePath 存储路径
 * @returns {Promise<string|null>} 文件内容
 */
async function readVirtualFile(storePath) {
    try {
        const db = await openDb();
        const row = await _tx(db, STORE_VIRTUAL, "readonly", (os) => os.get(storePath));
        return row ? row.content : null;
    } catch (err) {
        return null;
    }
}

/**
 * 列举指定路径下的条目。
 * @param {string} path 规范化路径
 * @returns {Promise<Array<object>>} 条目数组
 */
async function list(path) {
    const norm = normalizePath(path);
    const segs = splitPath(norm);

    // 根目录：显示五个顶层文件夹
    if (segs.length === 0) {
        const items = [];
        // 拒绝授权或浏览器不支持时，仅显示虚拟文件夹（收藏夹/桌面）
        if (authStatus !== "declined") {
            for (const f of Object.values(REAL_FOLDERS)) {
                items.push({
                    name: f.label,
                    type: "folder",
                    path: f.path,
                    modified: null,
                    size: null,
                    icon: f.icon,
                    top: true,
                    authorized: !!handles[f.key],
                });
            }
        }
        for (const f of Object.values(VIRTUAL_FOLDERS)) {
            items.push({
                name: f.label,
                type: "folder",
                path: f.path,
                modified: null,
                size: null,
                icon: f.icon,
                top: true,
            });
        }
        return items;
    }

    // 最近使用路径
    if (segs[0] === "最近使用") {
        return getRecentFiles(50);
    }

    const top = resolveTop(segs[0]);
    if (top && top.kind === "real") {
        // 未授权或未授予权限时返回空
        if (!handles[top.key]) return [];
        const ok = await ensureReadPermission(handles[top.key]);
        if (!ok) return [];
        const handle = await resolveRealHandle(norm);
        if (!handle) return [];
        return listRealDirectory(handle, norm);
    }

    if (top && top.kind === "virtual") {
        if (top.label === "收藏夹") {
            return getBookmarkChildren(norm);
        }
        if (top.label === "桌面") {
            return listVirtualFiles();
        }
    }

    return [];
}

/**
 * 读取单个文件的 File 对象（用于预览/打开）。
 * @param {string} path 文件路径
 * @returns {Promise<File|null>} 文件对象
 */
async function readFile(path) {
    const norm = normalizePath(path);
    const segs = splitPath(norm);
    if (segs.length < 2) return null;
    const top = resolveTop(segs[0]);
    if (top && top.kind === "real") {
        try {
            const handle = await resolveRealHandle(norm.substring(0, norm.lastIndexOf("/")));
            if (!handle) return null;
            const fileHandle = await handle.getFileHandle(segs[segs.length - 1]);
            return fileHandle.getFile();
        } catch (err) {
            return null;
        }
    }
    if (top && top.kind === "virtual" && top.label === "桌面") {
        const content = await readVirtualFile(norm);
        if (content === null) return null;
        return new File([content], segs[segs.length - 1], { type: "text/plain" });
    }
    return null;
}

/**
 * 根据路径判断条目类型是否可读文件。
 * @param {string} path 文件路径
 * @returns {Promise<boolean>}
 */
async function isFile(path) {
    const norm = normalizePath(path);
    const segs = splitPath(norm);
    if (segs.length < 2) return false;
    const top = resolveTop(segs[0]);
    if (top && top.kind === "real") {
        const handle = await resolveRealHandle(norm.substring(0, norm.lastIndexOf("/")));
        if (!handle) return false;
        try {
            await handle.getFileHandle(segs[segs.length - 1]);
            return true;
        } catch (err) {
            return false;
        }
    }
    if (top && top.kind === "virtual" && top.label === "桌面") {
        const list = await listVirtualFiles();
        return list.some((f) => f.path === norm);
    }
    return false;
}

/**
 * 计算可读文件大小格式化。
 * @param {number} bytes 字节数
 * @returns {string} 格式化字符串
 */
function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

/**
 * 格式化修改时间时间戳。
 * @param {number} ts 时间戳（毫秒）
 * @returns {string} 格式化字符串
 */
function formatDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 虚拟文件系统模块对象 */
const VFS = {
    init,
    isSupported,
    getAuthStatus,
    authorize,
    authorizeOne,
    decline,
    requestPermissions,
    list,
    readFile,
    isFile,
    addVirtualFile,
    addFallbackBookmark,
    getBookmarkTree,
    getRecentFiles,
    searchFiles,
    formatSize,
    formatDate,
    normalizePath,
    REAL_FOLDERS,
    VIRTUAL_FOLDERS,
};

export { VFS };