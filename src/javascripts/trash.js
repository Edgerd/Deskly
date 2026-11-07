/**
 * trash.js — 废纸篓闭环内核（手册对照 P0-4）
 *
 * /废纸篓 是 OSFS.TOP.trash 预建的顶层夹，本模块是它唯一的读写入口：
 *   - moveToTrash(path)  OSFS.move 到 /废纸篓/<唯一名>，并写一份溯源伴生文件
 *                        <名>.deskly-origin（JSON：{originalPath}），供「放回原处」；
 *   - putBack(path)      读伴生文件还原原路径（原目录没了就落 /文档），成功后删伴生；
 *   - dropFileToTrash(file) 程序坞拖入分支：把浏览器原生 File 直接写进 /废纸篓
 *                        （没有原路径可回溯，不写伴生，「放回原处」对该项保持禁用）；
 *   - emptyTrash()       逐条递归移除 /废纸篓 内容（OSFS.remove 的唯一 UI 消费收口在这里）；
 *   - isNotEmpty()       判定图标满/空态（伴生文件不算内容）。
 *
 * 事件：每次增删成功后派发 document CustomEvent "trash-changed"（detail {empty}），
 * 消费方：trashIcon（满/空变体自动切换）、访达（列表刷新自管）。
 *
 * 分层：只 import osfs.js（叶子内核）；文案全由调用方提供（i18n 键），本模块零文案。
 * 伴生文件后缀常量导出，访达渲染 /废纸篓 列表时据此过滤，界面上永远看不见它。
 */

import { OSFS } from "./osfs.js";

const TRASH_ROOT = OSFS.TOP.trash.path;
const DOCS_ROOT = OSFS.TOP.documents.path;

/** 溯源伴生文件后缀（访达据此在 /废纸篓 视图里隐藏这些条目）。 */
export const TRASH_ORIGIN_SUFFIX = ".deskly-origin";

function dispatchChanged(empty) {
    document.dispatchEvent(new CustomEvent("trash-changed", { detail: { empty: Boolean(empty) }, bubbles: true }));
}

/** /废纸篓 下的条目列表（读取失败按空目录处理，图标态宁空勿假）。 */
async function trashEntries() {
    try {
        const entries = await OSFS.list(TRASH_ROOT);
        return Array.isArray(entries) ? entries : [];
    } catch (err) {
        // 权限没批这类错误不吞：空态会误导「废纸篓是空的」
        if (err && err.name === "NeedsReauthError") throw err;
        return [];
    }
}

/** 目标目录里的唯一名：a.txt → a (1).txt 顺延（move 默认不覆盖，这里先算好避免 ConflictError）。 */
async function uniqueNameIn(dir, base) {
    let entries = [];
    try { entries = await OSFS.list(dir); } catch { entries = []; }
    const taken = new Set((entries || []).map((e) => e.name));
    if (!taken.has(base)) return base;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let i = 1;
    while (taken.has(stem + " (" + i + ")" + ext)) i++;
    return stem + " (" + i + ")" + ext;
}

/**
 * 把一个条目移进废纸篓。
 * @param {string} srcPath 绝对 OSFS 路径
 * @returns {Promise<{ok: boolean, path?: string, reason?: string}>}
 *          ok=false 时 reason: "notfound"（源不存在）/ "error"（其它异常）
 */
export async function moveToTrash(srcPath) {
    const src = OSFS.normalizePath(srcPath);
    const base = OSFS.baseName(src);
    if (!base || src === TRASH_ROOT || src.startsWith(TRASH_ROOT + "/")) return { ok: false, reason: "notfound" };
    try {
        await OSFS.mkdir(TRASH_ROOT); // 幂等：骨架缺了（磁盘后端用户手删顶层）时补回
        const name = await uniqueNameIn(TRASH_ROOT, base);
        const dest = TRASH_ROOT + "/" + name;
        const moved = await OSFS.move(src, dest);
        if (!moved) return { ok: false, reason: "notfound" };
        // 溯源伴生：写失败不阻塞移动本身（「放回原处」对该项禁用即可，不谎报成功）
        try {
            await OSFS.write(dest + TRASH_ORIGIN_SUFFIX, JSON.stringify({ originalPath: src, movedAt: Date.now() }));
        } catch (err) {
            console.warn("[trash] 溯源伴生写入失败（放回原处将不可用）：", dest, err);
        }
        dispatchChanged(false);
        return { ok: true, path: dest };
    } catch (err) {
        if (err && err.name === "NeedsReauthError") throw err;
        console.warn("[trash] 移入废纸篓失败：", src, err);
        return { ok: false, reason: "error" };
    }
}

/**
 * 把一个 /废纸篓 条目放回原处。没有溯源伴生（如程序坞直接拖入的原生文件）时返回
 * ok=false reason="noorigin"，调用方据此保持「放回原处」禁用 —— 不编造原路径。
 * @param {string} trashPath /废纸篓/<条目> 的绝对路径
 * @returns {Promise<{ok: boolean, path?: string, reason?: string}>}
 */
export async function putBack(trashPath) {
    const p = OSFS.normalizePath(trashPath);
    if (p !== TRASH_ROOT && !p.startsWith(TRASH_ROOT + "/")) return { ok: false, reason: "notfound" };
    const sidecar = p + TRASH_ORIGIN_SUFFIX;
    let originalPath = null;
    try {
        const file = await OSFS.read(sidecar);
        if (file) originalPath = JSON.parse(await file.text()).originalPath || null;
    } catch { /* 无伴生 = 无原路径 */ }
    if (!originalPath) return { ok: false, reason: "noorigin" };
    try {
        // 原目录还在就回原处；原目录没了（比如被清倒过）落 /文档，绝不回不到家
        let home = OSFS.normalizePath(originalPath);
        if (!(await OSFS.exists(OSFS.parentOf(home)))) {
            const docs = await OSFS.list(DOCS_ROOT).then(() => true).catch(() => false);
            if (docs) home = DOCS_ROOT + "/" + OSFS.baseName(p);
        }
        const name = await uniqueNameIn(OSFS.parentOf(home), OSFS.baseName(home));
        const dest = OSFS.joinPath(OSFS.parentOf(home), name);
        const moved = await OSFS.move(p, dest);
        if (!moved) return { ok: false, reason: "notfound" };
        await OSFS.remove(sidecar).catch(() => { /* 条目已回家，伴生随条目失效 */ });
        dispatchChanged(await isTrashNotEmpty());
        return { ok: true, path: dest };
    } catch (err) {
        if (err && err.name === "NeedsReauthError") throw err;
        console.warn("[trash] 放回原处失败：", p, err);
        return { ok: false, reason: "error" };
    }
}

/**
 * 程序坞「拖文件进废纸篓」分支：原生 File 直接写进 /废纸篓（无溯源，放回原处禁用）。
 * @param {File} file
 * @returns {Promise<{ok: boolean, path?: string}>}
 */
export async function dropFileToTrash(file) {
    const name = (file && file.name) || "未命名";
    try {
        await OSFS.mkdir(TRASH_ROOT);
        const dest = TRASH_ROOT + "/" + (await uniqueNameIn(TRASH_ROOT, name));
        await OSFS.write(dest, file);
        dispatchChanged(false);
        return { ok: true, path: dest };
    } catch (err) {
        if (err && err.name === "NeedsReauthError") throw err;
        console.warn("[trash] 拖入废纸篓失败：", name, err);
        return { ok: false };
    }
}

/** 真正清倒：逐条移除（目录递归）。OSFS.remove 全仓 UI 侧只应经这里调用。 */
export async function emptyTrash() {
    const entries = await trashEntries();
    let removed = 0;
    for (const e of entries) {
        if (e.name.endsWith(TRASH_ORIGIN_SUFFIX)) {
            // 失败不能计入 removed：事件与返回值都不能谎报「已清空」（BUG-07）
            const ok = await OSFS.remove(e.path).then(() => true).catch(() => false);
            if (ok) removed++;
            continue;
        }
        const okMain = await OSFS.remove(e.path, { recursive: true }).then(() => true).catch(() => false);
        await OSFS.remove(e.path + TRASH_ORIGIN_SUFFIX).catch(() => { });
        if (okMain) removed++;
    }
    // detail.empty 必须反映真实剩余：恒 false 会让 trash-changed 的消费方误判非空（BUG-07）
    dispatchChanged(await isTrashNotEmpty());
    return { ok: true, removed };
}

/** 满/空态判定：只认真实体，伴生文件不算内容。 */
export async function isTrashNotEmpty() {
    const entries = await trashEntries();
    return entries.some((e) => !e.name.endsWith(TRASH_ORIGIN_SUFFIX));
}

/** 桌面 / 拖入的文件是否已有 OSFS 记录（/桌面 同名文件）。 */
export function desktopPathFor(name) {
    return OSFS.joinPath(OSFS.TOP.desktop.path, String(name || ""));
}

// 开发者入口：与 window.Deskly / __osfs 同一风格，插件无 import 也能调用。
globalThis.__trash = {
    moveToTrash,
    putBack,
    dropFileToTrash,
    emptyTrash,
    isTrashNotEmpty,
    TRASH_ORIGIN_SUFFIX,
};
