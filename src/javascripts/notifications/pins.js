/**
 * notifications/pins.js —— 「把动态（通知）固定到程序坞」的数据层
 *
 * 职责：
 * - 判定一条通知是否可被拖入程序坞（类型白名单 + 必要字段）；
 * - 维护固定列表（去重、容量上限、快照持久化）；
 * - 通过 PIN_CHANGE_EVENT 通知程序坞重绘，自身不碰 DOM。
 *
 * 设计取舍：
 * - 存的是拖拽那一刻的快照（标题 / 图标 / 归属应用），所以通知被 store 剪枝（50 条 / 7 天）
 *   之后程序坞入口仍在；点开时若通知已不在历史里，由调用方给出友好提示。
 * - 容量上限是「程序坞已满」的可判定来源：程序坞宽度有限，固定条目无限增长会把
 *   其它图标压到最小尺寸，所以给出明确上限并在超限时拒绝。
 */

/** 固定列表变化事件（detail: { action, id }） */
export const PIN_CHANGE_EVENT = "notify-pins-change";

/** 拖拽时写入 dataTransfer 的私有 MIME，程序坞只认这一种载荷 */
export const NOTIF_MIME = "application/x-deskly-notification";

/** 固定条目上限（超出时提示「程序坞已满」） */
export const MAX_PINS = 6;

/** 可固定的通知类型；未声明类型的旧记录按 "app" 处理 */
const PINNABLE_TYPES = ["app", "system"];

const STORAGE_KEY = "webstartos_dock_notifs";

/** 内存缓存：首次读取后与存储保持同步，避免每次渲染都解析 JSON */
let cache = null;

/** 统一日志出口：日志模块未就绪时退回 console（站内 console 最终也进运行记录） */
function logPins(message, data) {
    if (window.__log) window.__log.warn("kernel/dock", message, data);
    else console.warn(`[dock/pins] ${message}`, data);
}

function emit(action, id) {
    document.dispatchEvent(new CustomEvent(PIN_CHANGE_EVENT, { detail: { action, id } }));
}

/** 把任意输入收敛成合法的固定条目；字段不全时返回 null。 */
function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!id || !title) return null;
    return {
        id,
        title,
        text: typeof raw.text === "string" ? raw.text : "",
        appId: typeof raw.appId === "string" ? raw.appId : "",
        appName: typeof raw.appName === "string" ? raw.appName : "",
        icon: typeof raw.icon === "string" ? raw.icon : "",
        ts: Number.isFinite(raw.ts) ? raw.ts : 0,
        type: typeof raw.type === "string" && raw.type ? raw.type : "app",
        pinnedAt: Number.isFinite(raw.pinnedAt) ? raw.pinnedAt : Date.now(),
    };
}

/** 读存储：损坏 / 非数组时回退空表，并只记一次告警，避免刷新时刷屏。 */
function readStorage() {
    let raw;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
        logPins("读取固定动态失败（隐私模式或权限）：", err);
        return [];
    }
    if (!raw) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logPins("固定动态缓存已损坏，按空表处理：", err);
        return [];
    }
    if (!Array.isArray(parsed)) {
        logPins("固定动态缓存不是数组，按空表处理");
        return [];
    }
    const out = [];
    const seen = new Set();
    parsed.forEach((entry) => {
        const item = normalizeItem(entry);
        if (!item || seen.has(item.id)) return;
        seen.add(item.id);
        out.push(item);
    });
    return out.slice(0, MAX_PINS);
}

function data() {
    if (!cache) cache = readStorage();
    return cache;
}

/** @returns {boolean} 是否写入成功 */
function persist(next) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        cache = next;
        return true;
    } catch (err) {
        logPins("写入固定动态失败（配额或权限）：", err);
        return false;
    }
}

/**
 * 这条通知能否固定到程序坞。
 * 缺少 id / 标题，或类型不在白名单内时一律不支持（拖拽源据此显示禁用态）。
 * @param {object} rec 通知记录
 * @returns {boolean}
 */
export function canPin(rec) {
    if (!rec || typeof rec !== "object") return false;
    if (typeof rec.id !== "string" || !rec.id.trim()) return false;
    if (typeof rec.title !== "string" || !rec.title.trim()) return false;
    const type = typeof rec.type === "string" && rec.type ? rec.type : "app";
    return PINNABLE_TYPES.includes(type);
}

/** 当前固定列表（副本，外部修改不会污染缓存） */
export function list() {
    return data().map((item) => ({ ...item }));
}

/** 是否已固定该通知 */
export function has(id) {
    return data().some((item) => item.id === id);
}

/**
 * 固定一条通知。
 * @param {object} rec 通知记录 / 拖拽载荷
 * @returns {{ok: boolean, reason?: "invalid"|"unsupported"|"duplicate"|"full"|"storage", item?: object}}
 */
export function add(rec) {
    const item = normalizeItem(rec);
    if (!item) return { ok: false, reason: "invalid" };
    if (!PINNABLE_TYPES.includes(item.type)) return { ok: false, reason: "unsupported" };
    const current = data();
    if (current.some((entry) => entry.id === item.id)) return { ok: false, reason: "duplicate" };
    if (current.length >= MAX_PINS) return { ok: false, reason: "full" };
    const next = [...current, { ...item, pinnedAt: Date.now() }];
    if (!persist(next)) return { ok: false, reason: "storage" };
    emit("add", item.id);
    if (window.__log) window.__log.info("kernel/dock", `固定动态到程序坞：${item.title}`, { id: item.id, count: next.length });
    return { ok: true, item: next[next.length - 1] };
}

/**
 * 取消固定。
 * @returns {boolean} 是否真的移除了条目
 */
export function remove(id) {
    const current = data();
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) return false;
    if (!persist(next)) return false;
    emit("remove", id);
    if (window.__log) window.__log.info("kernel/dock", "从程序坞移除固定动态", { id });
    return true;
}

/** 订阅固定列表变化，返回退订函数 */
export function subscribe(fn) {
    const handler = (e) => fn(e?.detail ?? {}, e);
    document.addEventListener(PIN_CHANGE_EVENT, handler);
    return () => document.removeEventListener(PIN_CHANGE_EVENT, handler);
}
