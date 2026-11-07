/**
 * vfs.js — 面向访达/聚焦/Dock 的文件树门面
 *
 * 存储本体在 osfs.js（单一根目录 + 可换后端 + 插件作用域）。本模块只做三件事：
 *   1. 把 osfs 的条目翻成界面需要的形状（顶层节点、图标、书签节点）；
 *   2. 收藏夹（chrome.bookmarks，不支持时 localStorage 虚拟书签）；
 *   3. 最近使用、大小/时间格式化这类展示计算。
 *
 * 历史包袱已清掉：旧版这里同时管着「下载/文档/图片三个文件夹各自授权」「桌面虚拟文件」
 * 「句柄持久化」「权限复核」，路径语义散在两处。现在路径的唯一来源是 osfs.TOP，
 * 读写只有一条通道 osfs.write/read/list，句柄与权限也不在这里出现。
 */

import { OSFS } from "./osfs.js";
import { FS } from "./fs/index.js";

/** 旧版「桌面」虚拟文件的行（`{path, name, content}`）由 osfs 的 rowContent 双读兼容，
 *  路径也仍在同一棵树上（/桌面 至今是根目录下的顶层夹），所以这里不需要迁移步骤。 */

/* ── 展示常量 ── */

const BOOKMARKS_PATH = "/收藏夹";
const RECENT_PATH = "/最近使用";
const BOOKMARKS_KEY = "webstartos_vfs_bookmarks";

/** 根目录下的可见顶层夹（路径来自 osfs.TOP，这里只补图标与显示属性）。 */
const TOP_FOLDERS = Object.entries(OSFS.TOP).reduce((acc, [key, def]) => {
    acc[key] = { key, label: def.path.slice(1), path: def.path, icon: def.icon, internal: Boolean(def.internal) };
    return acc;
}, {});

/** 旧授权态字面量：界面用它决定要不要提「挂载本地文件夹」。 */
const AUTH = { PENDING: "pending", GRANTED: "granted", DECLINED: "declined" };

/* ── 书签（虚拟文件夹，不落盘） ── */

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
        return fallback;
    }
}

/**
 * 标题 → 路径段。
 * Chrome 允许书签标题里带 `/`（「GitHub/PR」「a/b 笔记」），直接拼进路径会被
 * OSFS.segments / 后面的按段查找拆成两段，该节点整棵子树从此不可达。
 * 编码后 `%2F` 不会再被当作分隔符。
 */
function bookmarkSeg(title) {
    return encodeURIComponent(String(title ?? ""));
}

/** 路径段 → 标题。历史数据里存的是未编码的原始段，解不开就原样返回。 */
function bookmarkTitle(seg) {
    try { return decodeURIComponent(seg); } catch (err) { return seg; }
}

function toBookmarkEntry(node, parentPath) {
    const isFolder = !node.url;
    return {
        name: node.title,
        type: isFolder ? "folder" : "bookmark",
        bookmark: true,
        url: node.url || null,
        path: `${parentPath}/${bookmarkSeg(node.title)}`,
        modified: null,
        size: null,
        bookmarkId: node.id,
    };
}

function hasChromeBookmarks() {
    return typeof chrome !== "undefined" && chrome.bookmarks && chrome.bookmarks.getTree;
}

function loadFallbackNodes() {
    return readJSON(BOOKMARKS_KEY, []);
}

function loadFallbackBookmarks(path) {
    return loadFallbackNodes().map((node) => toBookmarkEntry(node, path));
}

async function getBookmarkRoot() {
    if (hasChromeBookmarks()) {
        try {
            const tree = await chrome.bookmarks.getTree();
            const children = (tree[0] && tree[0].children) || [];
            return children.map((node) => toBookmarkEntry(node, BOOKMARKS_PATH));
        } catch (err) {
            console.warn("[vfs] chrome.bookmarks 读取失败，使用虚拟书签：", err);
        }
    }
    return loadFallbackBookmarks(BOOKMARKS_PATH);
}

function findBookmarkByPath(node, segs) {
    if (!node || !node.children) return undefined;
    // 路径段是编码过的标题，比对前先还原；不还原时任何含 `/` 的标题都查不到。
    const want = bookmarkTitle(segs[0]);
    for (const child of node.children) {
        if (child.title === want) {
            if (segs.length === 1) return child;
            return findBookmarkByPath(child, segs.slice(1));
        }
    }
    return undefined;
}

function loadFallbackBookmarkChildren(path) {
    const segs = OSFS.segments(path);
    let cursor = loadFallbackNodes();
    for (const seg of segs.slice(1)) {
        const want = bookmarkTitle(seg);
        const hit = cursor.find((n) => n.title === want && !n.url);
        if (!hit || !hit.children) return [];
        cursor = hit.children;
    }
    return cursor.map((node) => toBookmarkEntry(node, path));
}

async function getBookmarkChildren(path) {
    const segs = OSFS.segments(path);
    if (segs.length <= 1) return getBookmarkRoot();
    if (hasChromeBookmarks()) {
        try {
            const tree = await chrome.bookmarks.getTree();
            const target = findBookmarkByPath(tree[0], segs.slice(1));
            if (target && target.children) return target.children.map((node) => toBookmarkEntry(node, path));
            return [];
        } catch (err) {
            console.warn("[vfs] 书签子节点读取失败：", err);
        }
    }
    return loadFallbackBookmarkChildren(path);
}

function normalizeTree(nodes) {
    return (nodes || []).map((n) => ({
        id: n.id,
        title: n.title,
        url: n.url || null,
        children: n.children ? normalizeTree(n.children) : [],
    }));
}

async function getBookmarkTree() {
    if (hasChromeBookmarks()) {
        try {
            const tree = await chrome.bookmarks.getTree();
            return normalizeTree((tree[0] && tree[0].children) || []);
        } catch (err) {
            console.warn("[vfs] 书签树读取失败，使用虚拟书签：", err);
        }
    }
    return normalizeTree(loadFallbackNodes());
}

/* ── 顶层与目录列表 ── */

/**
 * 根目录：固定的顶层夹 + 收藏夹 + 最近使用。
 * 顶层夹直接取自 TOP_FOLDERS（不依赖后端），所以刚挂载、权限待补这些状态下
 * 根目录也不会是空的；真实扫到的额外目录再并入，用户放在根里的东西不藏起来。
 */
async function listRoot() {
    const items = Object.values(TOP_FOLDERS).map((def) => ({
        name: def.label, type: "folder", path: def.path, modified: null, size: null,
        icon: def.icon, top: true, internal: def.internal,
    }));
    // known 必须先把两个虚拟节点也占住：它们不在 TOP_FOLDERS 里，早先只放顶层夹，
    // 于是树上一旦出现同名行（例如在「最近使用」下建过文件夹）就会和后面补的节点重成一个。
    const known = new Set(items.map((e) => e.path).concat([BOOKMARKS_PATH, RECENT_PATH]));
    let scanned = [];
    try {
        scanned = await OSFS.list("/");
    } catch (err) {
        if (!err || err.name !== "NeedsReauthError") throw err;
        scanned = [];   // 权限待补：固定顶层夹照常显示，内容等用户点「重新授权」
    }
    for (const entry of scanned) {
        if (known.has(entry.path)) {
            const hit = items.find((e) => e.path === entry.path);
            if (hit) Object.assign(hit, { modified: entry.modified, size: entry.size });
            continue;   // 收藏夹/最近使用是虚拟节点，树里的同名行不并进界面
        }
        items.push({ ...entry, icon: null, top: true, internal: false });
        known.add(entry.path);
    }
    items.push({
        name: BOOKMARKS_PATH.slice(1), type: "folder", path: BOOKMARKS_PATH,
        modified: null, size: null, icon: "folder/Mac OS.png", top: true, internal: false, bookmarkRoot: true,
    });
    items.push({
        name: RECENT_PATH.slice(1), type: "folder", path: RECENT_PATH,
        modified: null, size: null, icon: null, top: true, internal: false, recent: true,
    });
    return items;
}

async function list(path) {
    const norm = OSFS.normalizePath(path);
    if (norm === "/") return listRoot();
    if (norm === RECENT_PATH) return getRecentFiles(50);
    if (norm === BOOKMARKS_PATH || norm.startsWith(`${BOOKMARKS_PATH}/`)) return getBookmarkChildren(norm);
    // 隐藏名统一在门面过滤：.DS_Store（桌面坐标 sidecar）与原子写暂存件
    // 对访达/桌面/搜索永远不可见（Q1 决策），判定口径唯一来自 FS.isHiddenName。
    return (await OSFS.list(norm)).filter((e) => !FS.isHiddenName(e.name));
}

async function readFile(path) {
    const norm = OSFS.normalizePath(path);
    if (norm === BOOKMARKS_PATH || norm.startsWith(`${BOOKMARKS_PATH}/`) || norm === RECENT_PATH) return null;
    return OSFS.read(norm);
}

async function isFile(path) {
    const entry = await OSFS.stat(path);
    return Boolean(entry) && entry.type === "file";
}

/* ── 最近使用 ── */

async function getRecentFiles(count = 50) {
    let entries = [];
    try {
        entries = await OSFS.walk(2);
    } catch (err) {
        if (err && err.name === "NeedsReauthError") return [];
        throw err;
    }
    const internal = `${OSFS.TOP.appdata.path}/`;
    return entries
        .filter((e) => e.path !== BOOKMARKS_PATH
            && !e.path.startsWith(internal)          // 插件缓存不是「最近的文档」
            && Number.isFinite(e.modified))
        .sort((a, b) => b.modified - a.modified)
        .slice(0, count);
}

/* ── 状态与授权入口 ── */

function statusOf() {
    const s = OSFS.status();
    let status = AUTH.PENDING;
    if (s.mounted && !s.needsReauth) status = AUTH.GRANTED;
    else if (s.mounted && s.needsReauth) status = AUTH.PENDING;
    else if (s.declined) status = AUTH.DECLINED;
    return { ...s, status };
}

/**
 * 挂载一个真实文件夹作为根目录（readwrite）。
 * 不挂载也完全可用：根目录此时在应用自己的存储里。
 */
async function authorize() {
    await OSFS.mount();
    return statusOf();
}

async function reauthorize() {
    await OSFS.reauthorize();
    return statusOf();
}

async function unmount() {
    await OSFS.unmount();
    return statusOf();
}

function decline() {
    return OSFS.decline().then(statusOf);
}

function needsReauthorization() {
    return OSFS.status().needsReauth;
}

function getAuthStatus() {
    return statusOf();
}

/* ── 展示格式化 ── */

function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 根目录就绪：初始化 osfs（读回挂载句柄、复核权限、铺顶层骨架）。幂等。 */
function init() {
    return OSFS.init().then(statusOf);
}

const VFS = {
    init,
    isSupported: () => OSFS.isSupported(),
    getAuthStatus,
    needsReauthorization,
    authorize,
    reauthorize,
    unmount,
    decline,
    list,
    readFile,
    isFile,
    getBookmarkTree,
    getRecentFiles,
    formatSize,
    formatDate,
    normalizePath: OSFS.normalizePath,
    TOP: OSFS.TOP,
    TOP_FOLDERS,
    BOOKMARKS_PATH,
    RECENT_PATH,
    AUTH,
    /**
     * 现在把文件存在哪。
     * 只返回**结构化状态**，不返回成品文案：本模块是数据层，硬编码中文会漏出 i18n 红线。
     * 调用方按 kind 自己取键（`finder.auth.whereDisk` / `ss.storage.whereDisk`）。
     * @returns {{kind:"disk"|"virtual", name:string}}
     */
    whereStored() {
        const s = statusOf();
        return s.mounted
            ? { kind: "disk", name: String(s.mountName || "") }
            : { kind: "virtual", name: "" };
    },
};

export { VFS };
