/** history.js — 历史记录存取（纯逻辑，不碰 DOM）：不走设置中枢、独占一个 localStorage 槽；读写全包 try/catch，隐私模式/单测环境下不可用时退到内存兜底。 */

const SLOT = "calculator-history";
const MAX_ENTRIES = 200;

/** 内存兜底：localStorage 不可用时仍然能在本次会话里翻看历史。 */
let memoryFallback = null;

function readRaw() {
    try {
        const raw = globalThis.localStorage.getItem(SLOT);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return Array.isArray(memoryFallback) ? memoryFallback : [];
    }
}

function writeRaw(list) {
    memoryFallback = list;
    try {
        globalThis.localStorage.setItem(SLOT, JSON.stringify(list));
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * 全部历史，新的在前。
 * @returns {Array<{id:string,at:number,expr:string,result:string,mode:string}>}
 */
export function listHistory() {
    return readRaw().filter((e) => e && typeof e.result === "string");
}

/**
 * 追加一条。表达式与结果都为空的记录不进历史（例如误按 =）。
 * @param {{expr:string, result:string, mode?:string}} entry
 * @returns {Array<object>} 追加后的列表
 */
export function addHistory(entry) {
    const expr = String((entry && entry.expr) || "").trim();
    const result = String((entry && entry.result) || "").trim();
    if (!result || result === "错误") return listHistory();
    const list = listHistory();
    list.unshift({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
        expr: expr || result,
        result,
        mode: (entry && entry.mode) || "basic",
    });
    const trimmed = list.slice(0, MAX_ENTRIES);
    writeRaw(trimmed);
    return trimmed;
}

/**
 * 删除一条。
 * @param {string} id
 * @returns {Array<object>} 剩余记录
 */
export function removeHistory(id) {
    const kept = listHistory().filter((e) => e.id !== id);
    writeRaw(kept);
    return kept;
}

export function clearHistory() {
    writeRaw([]);
    return [];
}

/**
 * 按天分组（纸带顶部的「今天 / 昨天 / 10 月 5 日」标题就是这么来的）。
 * 用本地日期而不是 UTC：用户看的是自己桌上的日历。
 * @param {Array<object>} [list]
 * @returns {Array<{label:string, day:string, items:Array<object>}>}
 */
export function groupByDay(list = listHistory()) {
    const groups = [];
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = startOfDay(new Date());
    list.forEach((entry) => {
        const at = Number(entry.at) || 0;
        const day = startOfDay(new Date(at));
        const diffDays = Math.round((today - day) / 86400000);
        const label = diffDays <= 0 ? "今天" : diffDays === 1 ? "昨天" : formatDate(day);
        const tail = groups[groups.length - 1];
        if (tail && tail.day === String(day)) tail.items.push(entry);
        else groups.push({ label, day: String(day), items: [entry] });
    });
    return groups;
}

function formatDate(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export const HISTORY_MAX = MAX_ENTRIES;
export const HISTORY_SLOT = SLOT;
