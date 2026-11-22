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
 * 分层：只 import osfs.js / settings.js（叶子内核）；文案全由调用方提供（i18n 键），本模块零文案。
 * 伴生文件后缀常量导出，访达渲染 /废纸篓 列表时据此过滤，界面上永远看不见它。
 */

import { OSFS } from "./osfs.js";
import { settings } from "./settings.js";

const TRASH_ROOT = OSFS.TOP.trash.path;
const DOCS_ROOT = OSFS.TOP.documents.path;

/** 自动清倒的保留天数：设置项与存储面板共用这一个口径。 */
const AUTO_EMPTY_DAYS = 30;
/** 每日维护记账槽：只记「上次清理的日期」，开关状态以设置中枢为唯一权威。 */
const AUTO_EMPTY_STAMP = "trash-autoEmpty-last-run";

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

/** 当日日期串（本地时区，YYYY-MM-DD），用于每日一次的自动清倒记账。 */
function todayStamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 清倒 /废纸篓 里超过保留天数的条目（伴生文件随条目一起删）。
 * 条目没有时间戳时跳过：时间未知不等于「很旧」，不能把刚扔进来的东西抹掉。
 * @param {number} [days] 保留天数
 * @returns {Promise<{ok: boolean, removed: number}>}
 */
export async function pruneOldTrash(days = AUTO_EMPTY_DAYS) {
    const keep = Number(days);
    const span = (Number.isFinite(keep) && keep >= 0 ? keep : AUTO_EMPTY_DAYS) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - span;
    let entries = [];
    try {
        entries = await trashEntries();
    } catch (err) {
        if (err && err.name === "NeedsReauthError") throw err;
        return { ok: false, removed: 0 };
    }
    let removed = 0;
    for (const entry of entries) {
        if (entry.name.endsWith(TRASH_ORIGIN_SUFFIX)) continue;
        const modified = Number(entry.modified) || 0;
        if (!modified || modified > cutoff) continue;
        const ok = await OSFS.remove(entry.path, { recursive: true }).then(() => true).catch(() => false);
        if (!ok) continue;
        await OSFS.remove(entry.path + TRASH_ORIGIN_SUFFIX).catch(() => { /* 伴生随条目失效 */ });
        removed += 1;
    }
    if (removed) dispatchChanged(await isTrashNotEmpty());
    return { ok: true, removed };
}

/**
 * 设置开启时每天清倒一次：记账用本地日期，跨天只清一次；开关本身以设置中枢为唯一权威。
 * 失败不记日期，下次打开页面还会再试；不改变开关状态。
 */
async function runDailyMaintenance() {
    if (!settings.get("trash.autoEmpty")) return;
    let stamp = null;
    try { stamp = localStorage.getItem(AUTO_EMPTY_STAMP); } catch (err) { stamp = null; }
    if (stamp === todayStamp()) return;
    try {
        await OSFS.init();
        const result = await pruneOldTrash(AUTO_EMPTY_DAYS);
        if (result.ok) {
            try { localStorage.setItem(AUTO_EMPTY_STAMP, todayStamp()); } catch (err) { /* 存不下就下次再来 */ }
        }
    } catch (err) {
        if (err && err.name === "NeedsReauthError") return;
        console.warn("[trash] 自动清倒过期项目失败：", err);
    }
}

// 只在真实页面里启动维护：Node 侧求值（静态检查）不派发定时器。
const CAN_MAINTAIN = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
if (CAN_MAINTAIN) {
    // 刚打开开关时立刻生效一次，之后每天最多一次。
    settings.on("trash.autoEmpty", (value) => { if (value) runDailyMaintenance(); });
    // 定义表由 bootstrap 稍后登记，这里短轮询等它就位再跑当天的一次。
    let tries = 0;
    const kick = () => {
        if (settings.has("trash.autoEmpty")) runDailyMaintenance();
        else if (tries++ < 10) setTimeout(kick, 500);
    };
    kick();
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
    pruneOldTrash,
    isTrashNotEmpty,
    TRASH_ORIGIN_SUFFIX,
};
