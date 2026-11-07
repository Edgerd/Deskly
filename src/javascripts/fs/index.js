/**
 * fs/index.js — 文件系统门面：统一 Backend 接口之上的公开层。
 *
 * 职责（与本目录其他模块的分工）：
 * - errors.js  错误码体系（FSError.code，见该文件头注释）
 * - backend.js Backend 接口契约与只读包装
 * - 本文件     调 osfs.js 引擎、把错误归一成 FSError、广播 fs-changed、
 *              提供 watch / rename / copy / 隐藏名判定这些引擎之上的一阶能力。
 *
 * 越界与路径归一不重新发明：一律复用 osfs.js 做过安全加固的
 * normalizePath / boundaryKey / isOtherAppData（BUG-20 那套大小写/尾点归一）。
 */

import { OSFS } from "../osfs.js";
import { CODES, FSError, toFSError } from "./errors.js";
import { asReadOnly } from "./backend.js";

/* ── 事件：fs-changed ──
 * 引擎之外的写操作（各插件直连 OSFS 的那些）不会触发本事件——收口期逐一切换。
 * detail: { op: 'write'|'mkdir'|'remove'|'move'|'rename'|'copy', paths: string[] }
 */
const localBus = new EventTarget();   // Node 探针没有 document，也要能订阅

function emit(op, paths) {
    const detail = { op, paths, at: Date.now() };
    // 事件投递失败（订阅方抛错、宿主环境怪异）绝不能让写操作本身失败
    try {
        localBus.dispatchEvent(new CustomEvent("fs-changed", { detail }));
    } catch (err) { console.warn("[fs] fs-changed 本地投递失败：", err); }
    if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
        try {
            document.dispatchEvent(new CustomEvent("fs-changed", { detail, bubbles: true }));
        } catch (err) { console.warn("[fs] fs-changed 文档投递失败：", err); }
    }
}

/**
 * 订阅文件变化。`path` 限定子树（含自身）；回调收到落在子树内的 detail。
 * 返回退订函数。
 */
function watch(path, cb) {
    const scope = OSFS.normalizePath(path || "/");
    const handler = (e) => {
        const hit = (e.detail.paths || []).filter((p) => OSFS.inside(p, scope) || OSFS.inside(OSFS.parentOf(p), scope));
        if (hit.length) cb({ ...e.detail, paths: hit });
    };
    const target = typeof document !== "undefined" ? document : localBus;
    target.addEventListener("fs-changed", handler);
    return () => target.removeEventListener("fs-changed", handler);
}

/* ── 隐藏名判定 ──
 * `.DS_Store`（桌面坐标 sidecar，Q1 决策）与原子写暂存件：对所有视图不可见。
 * 判定按名不按内容，大小写不敏感（与 boundaryKey 的 Windows/APFS 口径一致）。
 */
function isHiddenName(name) {
    const n = String(name || "");
    return n.toLowerCase() === ".ds_store" || OSFS.isTempName(n);
}

/* ── 读路径 ── */

async function list(dir, opts = {}) {
    try {
        const entries = await OSFS.list(dir);
        return opts.includeHidden ? entries : entries.filter((e) => !isHiddenName(e.name));
    } catch (err) { throw toFSError(err, OSFS.normalizePath(dir)); }
}

async function read(path, opts = {}) {
    const norm = OSFS.normalizePath(path);
    if (!opts.includeHidden && isHiddenName(OSFS.baseName(norm))) return null;
    try { return await OSFS.read(norm); }
    catch (err) { throw toFSError(err, norm); }
}

async function stat(path, opts = {}) {
    const norm = OSFS.normalizePath(path);
    if (!opts.includeHidden && isHiddenName(OSFS.baseName(norm))) return null;
    try { return await OSFS.stat(norm); }
    catch (err) { throw toFSError(err, norm); }
}

async function exists(path, opts = {}) {
    const norm = OSFS.normalizePath(path);
    if (!opts.includeHidden && isHiddenName(OSFS.baseName(norm))) return false;
    try { return await OSFS.exists(norm); }
    catch (err) { throw toFSError(err, norm); }
}

async function walk(maxDepth = 3, dir = "/") {
    try {
        const out = await OSFS.walk(maxDepth, dir);
        return out.filter((e) => !isHiddenName(e.name));
    } catch (err) { throw toFSError(err, OSFS.normalizePath(dir)); }
}

/* ── 写路径（每次成功都广播 fs-changed） ── */

async function write(path, data) {
    const norm = OSFS.normalizePath(path);
    try {
        const written = await OSFS.write(norm, data);
        emit("write", [written]);
        return written;
    } catch (err) { throw toFSError(err, norm); }
}

async function mkdir(path) {
    const norm = OSFS.normalizePath(path);
    try {
        const made = await OSFS.mkdir(norm);
        emit("mkdir", [made]);
        return made;
    } catch (err) { throw toFSError(err, norm); }
}

async function remove(path, opts = {}) {
    const norm = OSFS.normalizePath(path);
    try {
        const gone = await OSFS.remove(norm, opts);
        if (gone) emit("remove", [norm]);
        return gone;
    } catch (err) { throw toFSError(err, norm); }
}

async function move(from, to) {
    const src = OSFS.normalizePath(from);
    const dst = OSFS.normalizePath(to);
    try {
        const moved = await OSFS.move(src, dst);
        if (moved) emit("move", [src, dst]);
        return moved;
    } catch (err) { throw toFSError(err, src); }
}

/** 重命名 = 同目录移动；名字过一遍消毒，与访达「新建文件夹」同一口径。 */
async function rename(path, newName) {
    const norm = OSFS.normalizePath(path);
    const name = OSFS.sanitizeName(newName);
    if (!name || name === OSFS.baseName(norm)) return norm;
    const renamed = await move(norm, OSFS.joinPath(OSFS.parentOf(norm), name));
    if (!renamed) throw new FSError(CODES.ENOENT, `源不存在：${norm}`, norm);
    return renamed;
}

/**
 * 复制到目标路径（含文件名）。目录整棵递归；目标已存在抛 EEXIST（默认不覆盖）。
 * 逐条走 write，天然继承原子写；中途失败时已写出的部分保留并报 EIO 带路径，
 * 调用方（菜单「复制」）收到错就知道哪些没复制完。
 */
async function copy(src, dst) {
    const from = OSFS.normalizePath(src);
    const to = OSFS.normalizePath(dst);
    const st = await stat(from);
    if (!st) throw new FSError(CODES.ENOENT, `源不存在：${from}`, from);
    if (await exists(to)) throw new FSError(CODES.EEXIST, `目标已存在：${to}`, to);
    if (st.type === "folder") {
        if (to === from || to.startsWith(`${from}/`)) {
            throw new FSError(CODES.EPERM, "不能把目录复制进它自己", from);
        }
        await mkdir(to);
        for (const child of await list(from)) {
            await copy(child.path, OSFS.joinPath(to, child.name));
        }
    } else {
        const file = await read(from);
        await write(to, file);
    }
    emit("copy", [from, to]);
    return to;
}

/* ── 只读视图 ── */

/** 整个门面包一层只读壳：外部挂载（如照片的外部图片夹）的默认形态。 */
function readOnly(reason) {
    return asReadOnly({ list, read, stat, exists, walk, write, mkdir, remove, move, rename, copy, watch }, reason);
}

const FS = Object.freeze({
    CODES,
    FSError,
    toFSError,
    watch,
    isHiddenName,
    list,
    read,
    stat,
    exists,
    walk,
    write,
    mkdir,
    remove,
    move,
    rename,
    copy,
    readOnly,
    // 路径与越界：直接透传 osfs 安全加固过的实现，不另造一套
    normalizePath: OSFS.normalizePath,
    boundaryKey: OSFS.boundaryKey,
    isOtherAppData: OSFS.isOtherAppData,
    joinPath: OSFS.joinPath,
    baseName: OSFS.baseName,
    parentOf: OSFS.parentOf,
    sanitizeName: OSFS.sanitizeName,
    TOP: OSFS.TOP,
});

globalThis.__fs = FS;

export { FS };
