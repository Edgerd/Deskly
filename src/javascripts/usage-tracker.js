/**
 * usage-tracker.js — 屏幕使用时间 owner：前台应用时长账本与停用时间引擎
 *
 * 两件事，都只做真实可验证的：
 *
 * 1. **时长账本**：每 5 秒轮询一次菜单栏当前前台应用（finderbar 的 p.appname，
 *    这正是 session.js / 通知聚焦判定用的同一处事实源），页面可见时把 5 秒记到
 *    「当天 × 应用」的桶里；账本按自然日分桶、最多留 30 天，localStorage 单槽
 *    持久化（deskly-usage）。节流写盘：内存累计、每 30 秒与页面转后台时落盘，
 *    不给主存储槽添堵。
 *
 * 2. **停用时间引擎**：读取设置中枢的 screenTime.downtime（{enabled,start,end,days}），
 *    每分钟判定一次当前是否处于停用时间；进/出停用时间各发一条真实通知横幅
 *    （globalThis.__notify.show，与系统通知同一条链路）。处于停用时间时弹出
 *    全屏闸门：可一键前往「始终允许」的应用；「忽略限制 15 分钟」在已设置
 *    锁定屏幕口令时必须输口令（复用 lock.js 的 checkPassword），未设口令时
 *    给出去「锁定屏幕」设口令的引导（与 macOS 一致：没有口令就只能提醒）。
 *
 * Node 环境（settings-fulltest / dev 探针）import 本模块只拿纯函数，
 * initUsageTracker 检测不到 document 时直接短路，不挂任何定时器。
 */

import { settings } from "./settings.js";
import { hasPassword, checkPassword } from "./lock.js";

/** 账本存储槽（localStorage，JSON）。 */
const USAGE_SLOT = "deskly-usage";

/** 账本最多保留的自然日数，超出从最旧的一天开始裁剪。 */
const MAX_DAYS = 30;

/** 轮询间隔（毫秒）：与通知聚焦判定、锁屏空闲看门狗同量级，不增加可感开销。 */
const POLL_MS = 5000;

/** 账本落盘节流间隔（毫秒）。 */
const FLUSH_MS = 30000;

/** 忽略限制的时长（毫秒）。 */
const IGNORE_MS = 15 * 60 * 1000;

/** 运行期状态：内存桶、定时器句柄与上一分钟的停用判定。 */
const state = {
    started: false,
    days: {},            // { "2026-11-21": { "访达": 秒 } }
    dirty: false,
    pollTimer: null,
    flushTimer: null,
    minuteTimer: null,
    lastDowntime: null,  // 上一分钟的停用判定（null = 尚未判定）
    ignoreUntil: 0,
    gate: null,          // 闸门 DOM 引用
};

/** 比较键统一取当日（本地时区）。 */
function todayKey(date = new Date()) {
    const d = (date instanceof Date) ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 读账本槽；损坏或不可用时回退内存态，绝不抛错打断 boot。 */
function readStore() {
    try {
        const raw = localStorage.getItem(USAGE_SLOT);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (data && typeof data === "object" && data.days && typeof data.days === "object") return data;
    } catch { /* 损坏数据当无账本处理 */ }
    return null;
}

/** 写账本槽；存储被禁用（隐私模式）时账本只活在内存里，不弹窗打扰。 */
function writeStore() {
    try {
        localStorage.setItem(USAGE_SLOT, JSON.stringify({ days: state.days }));
        state.dirty = false;
        return true;
    } catch {
        return false;
    }
}

/** 启动时把持久账本装回内存，并裁掉超出保留期的旧日。 */
function loadStore() {
    const data = readStore();
    state.days = (data && data.days) || {};
    pruneDays();
}

/** 按键排序裁剪：只保留最近 MAX_DAYS 个自然日。 */
function pruneDays() {
    const keys = Object.keys(state.days).sort();
    while (keys.length > MAX_DAYS) {
        const oldest = keys.shift();
        delete state.days[oldest];
        state.dirty = true;
    }
}

/**
 * 当前前台应用名：与通知聚焦判定同一事实源 —— finderbar 的 p.appname 文本。
 * 读不到（菜单栏尚未渲染 / 结构变化）返回空串，该轮询周期不记账。
 * @returns {string} 前台应用显示名
 */
function activeAppName() {
    try {
        const node = document.querySelector("#finderbar p.appname");
        const text = node ? String(node.textContent || "").trim() : "";
        return text;
    } catch {
        return "";
    }
}

/**
 * 记一个轮询周期：页面可见 + 有前台应用名才入账。
 * @param {number} [seconds=5] 本周期秒数（探针可传别的值）
 * @returns {boolean} 是否入账
 */
function recordTick(seconds = POLL_MS / 1000) {
    if (typeof document === "undefined") return false;
    if (settings.get("screenTime.enabled") === false) return false; // 总开关关闭时不记账
    if (document.visibilityState !== "visible") return false;
    const app = activeAppName();
    if (!app) return false;
    const day = todayKey();
    if (!day) return false;
    if (!state.days[day] || typeof state.days[day] !== "object") state.days[day] = {};
    state.days[day][app] = (Number(state.days[day][app]) || 0) + seconds;
    state.dirty = true;
    return true;
}

// ---- 停用时间 ----

/**
 * 把 "HH:MM" 解析成当天分钟数；非法输入返回 -1（调用方跳过该字段）。
 * @param {string} value 时间文本
 * @returns {number} 分钟数或 -1
 */
function parseHHMM(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!match) return -1;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
    return h * 60 + m;
}

/**
 * 归一化停用时间设置（类型修补 + 非法字段丢弃）。
 * @param {*} raw 设置中枢读到的原始值
 * @returns {{enabled:boolean,start:number,end:number,days:number[]}} 归一化结果
 */
function normalizeDowntime(raw) {
    const def = (raw && typeof raw === "object") ? raw : {};
    const start = parseHHMM(def.start);
    const end = parseHHMM(def.end);
    const days = Array.isArray(def.days)
        ? [...new Set(def.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
        : [];
    return {
        enabled: Boolean(def.enabled) && start >= 0 && end >= 0,
        start,
        end,
        days,
    };
}

/**
 * 判定某个时刻是否处于停用时间（纯函数，探针直接测）。
 * 跨午夜区间（如 23:00-07:00）按「>=start 或 <end」判定；days 缺省视为每天。
 * @param {*} raw 停用时间设置原始值
 * @param {Date} [at] 判定时刻，缺省当前
 * @returns {boolean} 是否处于停用时间
 */
function isDowntimeAt(raw, at = new Date()) {
    const def = normalizeDowntime(raw);
    if (!def.enabled) return false;
    if (def.days.length && !def.days.includes(at.getDay())) return false;
    const minutes = at.getHours() * 60 + at.getMinutes();
    if (def.start <= def.end) return minutes >= def.start && minutes < def.end;
    return minutes >= def.start || minutes < def.end; // 跨午夜
}

/** 读当前停用时间设置（设置中枢是唯一数据源）。 */
function downtimeDef() {
    return settings.get("screenTime.downtime");
}

/** 当前是否处于停用时间。 */
function isDowntimeNow() {
    return isDowntimeAt(downtimeDef());
}

/** 始终允许的应用列表（[{id,name}]）。 */
function allowedApps() {
    const raw = settings.get("screenTime.allowAlways");
    return (Array.isArray(raw) ? raw : [])
        .filter((item) => item && typeof item === "object" && item.name)
        .map((item) => ({ id: String(item.id || item.name), name: String(item.name) }));
}

/** 当前前台应用是否在「始终允许」名单里。 */
function isActiveAppAllowed() {
    const app = activeAppName();
    if (!app) return false;
    return allowedApps().some((item) => item.name === app);
}

// ---- 通知横幅（真实链路：globalThis.__notify.show） ----

/**
 * 发一条停用时间提醒横幅；通知模块不可用时静默降级（引擎不因缺通知而中断）。
 * @param {string} title 标题
 * @param {string} text 正文
 * @returns {boolean} 是否已发出
 */
function notifyBanner(title, text) {
    const notify = globalThis.__notify;
    if (notify && typeof notify.show === "function") {
        notify.show({ title, text, duration: 8000 });
        return true;
    }
    globalThis.__log?.warn?.("kernel/screen-time", `通知模块不可用，横幅未发出：${title}`);
    return false;
}

// ---- 停用时间闸门 ----

/**
 * 构建停用时间闸门 DOM（只构建不挂载）：深色满屏遮罩 + 居中卡片。
 * @returns {{overlay: HTMLElement, body: HTMLElement, hint: HTMLElement}}
 */
function buildGate() {
    const overlay = document.createElement("div");
    overlay.className = "screen-time-gate";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "屏幕使用时间");
    Object.assign(overlay.style, {
        position: "fixed", inset: "0", zIndex: "2147483000",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(12, 12, 14, 0.9)", backdropFilter: "blur(var(--surface-blur-3))",
        WebkitBackdropFilter: "blur(var(--surface-blur-3))", color: "#f5f5f7",
        font: "13px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
        userSelect: "none",
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
        width: "min(420px, 86vw)", padding: "28px 30px", borderRadius: "18px",
        background: "rgba(38, 38, 42, 0.86)", boxShadow: "0 24px 80px rgba(0,0,0,.5)",
        display: "flex", flexDirection: "column", gap: "14px", textAlign: "center",
    });

    const title = document.createElement("div");
    title.textContent = "屏幕使用时间";
    Object.assign(title.style, { fontSize: "17px", fontWeight: "700" });

    const body = document.createElement("div");
    body.textContent = "当前处于停用时间";
    Object.assign(body.style, { color: "rgba(245,245,247,.75)" });

    const allowed = document.createElement("div");
    allowed.style.display = "flex";
    allowed.style.flexWrap = "wrap";
    allowed.style.gap = "8px";
    allowed.style.justifyContent = "center";

    const hint = document.createElement("div");
    Object.assign(hint.style, { fontSize: "12px", color: "rgba(245,245,247,.55)", minHeight: "1em" });

    const passWrap = document.createElement("div");
    passWrap.style.display = "none";
    passWrap.style.flexDirection = "column";
    passWrap.style.gap = "8px";
    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.placeholder = "输入锁定屏幕口令";
    Object.assign(passInput.style, {
        padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(255,255,255,.25)",
        background: "rgba(255,255,255,.12)", color: "#f5f5f7", outline: "none", textAlign: "center",
    });
    const passButton = document.createElement("button");
    passButton.type = "button";
    passButton.textContent = "解锁";
    Object.assign(passButton.style, {
        padding: "7px 12px", borderRadius: "8px", border: "0", cursor: "pointer",
        background: "rgba(10,132,255,.9)", color: "#fff", fontWeight: "600",
    });
    passWrap.append(passInput, passButton);

    const ignoreButton = document.createElement("button");
    ignoreButton.type = "button";
    ignoreButton.textContent = "忽略限制（15 分钟）";
    Object.assign(ignoreButton.style, {
        padding: "9px 14px", borderRadius: "10px", border: "0", cursor: "pointer",
        background: "rgba(255,255,255,.16)", color: "#f5f5f7", fontWeight: "600",
    });

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.textContent = "打开屏幕使用时间设置";
    Object.assign(settingsButton.style, {
        padding: "9px 14px", borderRadius: "10px", border: "0", cursor: "pointer",
        background: "transparent", color: "rgba(245,245,247,.7)", textDecoration: "underline",
    });

    card.append(title, body, allowed, passWrap, ignoreButton, settingsButton, hint);
    overlay.appendChild(card);
    return { overlay, card, body, allowed, passWrap, passInput, passButton, ignoreButton, settingsButton, hint };
}

/** 关闭并销毁闸门。 */
function closeGate() {
    if (state.gate) {
        state.gate.overlay.remove();
        state.gate = null;
    }
}

/**
 * 弹出（或刷新）停用时间闸门。锁定屏幕在场时不抢镜（锁屏先挡住一切）。
 * @returns {boolean} 是否弹出了闸门
 */
function showGate() {
    if (globalThis.__lock?.isLocked?.()) return false;
    closeGate();
    const gate = buildGate();
    state.gate = gate;

    const allowed = allowedApps();
    if (allowed.length) {
        allowed.forEach((item) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.textContent = item.name;
            Object.assign(chip.style, {
                padding: "6px 12px", borderRadius: "999px", border: "1px solid rgba(255,255,255,.3)",
                background: "rgba(255,255,255,.1)", color: "#f5f5f7", cursor: "pointer",
            });
            // 「始终允许」的应用此刻可用：让闸门让位 15 分钟，与 macOS 行为一致。
            chip.addEventListener("click", () => {
                state.ignoreUntil = Date.now() + IGNORE_MS;
                closeGate();
                globalThis.__log?.info?.("kernel/screen-time", `停用时间中改用允许的应用：${item.name}`);
            });
            gate.allowed.appendChild(chip);
        });
    } else {
        const note = document.createElement("span");
        note.textContent = "未配置「始终允许」的应用";
        Object.assign(note.style, { fontSize: "12px", color: "rgba(245,245,247,.45)" });
        gate.allowed.appendChild(note);
    }

    const askIgnore = () => {
        if (hasPassword()) {
            gate.passWrap.style.display = "flex";
            gate.hint.textContent = "";
            gate.passInput.focus();
        } else {
            gate.hint.textContent = "未设置锁定屏幕口令：如需口令确认，请先到「锁定屏幕」设置口令。";
        }
    };
    gate.ignoreButton.addEventListener("click", askIgnore);

    const confirmPass = () => {
        const value = gate.passInput.value;
        checkPassword(value).then((ok) => {
            if (ok) {
                state.ignoreUntil = Date.now() + IGNORE_MS;
                closeGate();
                globalThis.__log?.info?.("kernel/screen-time", "口令通过：忽略停用时间 15 分钟");
            } else {
                gate.hint.textContent = "口令不正确。";
                gate.passInput.select();
            }
        });
    };
    gate.passButton.addEventListener("click", confirmPass);
    gate.passInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") confirmPass();
    });

    gate.settingsButton.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("system-settings-open-pane", { detail: { pane: "screenTime" }, bubbles: true }));
    });

    document.body.appendChild(gate.overlay);
    return true;
}

/** 每分钟一次：停用时间判定 + 横幅 + 闸门状态机。 */
function minuteTick() {
    const def = downtimeDef();
    const now = Date.now();
    const inDowntime = isDowntimeAt(def) && now >= state.ignoreUntil;

    if (state.lastDowntime !== inDowntime) {
        if (inDowntime) {
            notifyBanner("屏幕使用时间", "已进入停用时间，到点前应用将收到限制。");
            globalThis.__log?.info?.("kernel/screen-time", "进入停用时间");
        } else if (state.lastDowntime === true) {
            notifyBanner("屏幕使用时间", "停用时间已结束。");
            globalThis.__log?.info?.("kernel/screen-time", "停用时间结束");
        }
        state.lastDowntime = inDowntime;
    }

    if (inDowntime) {
        if (!state.gate) showGate();
    } else {
        closeGate();
    }
    state.ignoreUntil = Math.max(0, state.ignoreUntil); // 归一化，无副作用
    if (now >= state.ignoreUntil) state.ignoreUntil = 0;
}

// ---- 对外 API ----

/**
 * 某一天的「应用 -> 秒」桶（无数据返回空对象）。
 * @param {string} [date] 自然日 YYYY-MM-DD，缺省今天
 * @returns {Record<string, number>} 应用时长桶
 */
function getDayTotals(date) {
    const key = date || todayKey();
    const bucket = state.days[key];
    return (bucket && typeof bucket === "object") ? { ...bucket } : {};
}

/**
 * 某一天的总使用秒数。
 * @param {string} [date] 自然日，缺省今天
 * @returns {number} 总秒数
 */
function getDayTotal(date) {
    const bucket = getDayTotals(date);
    return Object.values(bucket).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * 最近 n 天的账本（旧 -> 新）。
 * @param {number} [n=7] 天数（含今天）
 * @returns {Array<{date: string, total: number, apps: Record<string, number>}>} 每日账本
 */
function getRecentDays(n = 7) {
    const days = Math.max(1, Math.min(30, Number(n) || 7));
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = todayKey(d);
        const apps = getDayTotals(key);
        out.push({ date: key, total: Object.values(apps).reduce((s, v) => s + (Number(v) || 0), 0), apps });
    }
    return out;
}

/** 屏幕使用时间模块对外 API（挂到 window.__screenTime）。 */
const screenTime = {
    /** 某天「应用 -> 秒」桶。 */
    getDayTotals,
    /** 某天总秒数。 */
    getDayTotal,
    /** 最近 n 天账本。 */
    getRecentDays,
    /** 当前是否处于停用时间。 */
    isDowntimeNow,
    /** 归一化后的停用时间设置。 */
    getDowntime: () => normalizeDowntime(downtimeDef()),
    /** 始终允许的应用列表。 */
    allowedApps,
    /** 忽略限制 15 分钟（供设置面板「延长」类操作复用）。 */
    ignoreFor15Minutes: () => { state.ignoreUntil = Date.now() + IGNORE_MS; closeGate(); minuteTick(); },
};

/**
 * 初始化账本与停用时间引擎（幂等；重复调用直接返回）。
 * settings-definitions.js 在注册完 screenTime.* 定义后调用本函数。
 * @returns {boolean} 是否完成初始化
 */
function initUsageTracker() {
    if (state.started) return true;
    // Node 环境（settings-fulltest / 探针）：只提供纯函数，不挂定时器、不碰 DOM。
    if (typeof document === "undefined") return false;
    state.started = true;
    loadStore();

    state.pollTimer = setInterval(() => recordTick(), POLL_MS);
    state.flushTimer = setInterval(() => {
        if (state.dirty) writeStore();
    }, FLUSH_MS);
    // 分钟判定先对齐到整分：避免启动即连发两次判定
    state.minuteTimer = setInterval(minuteTick, 60000);
    minuteTick();

    // 转后台立即落盘，避免最后一段时长丢失
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" && state.dirty) writeStore();
    });
    window.addEventListener("pagehide", () => {
        if (state.dirty) writeStore();
    });

    // 设置面板改了 screenTime.*（含停用时间计划 / 允许名单）时，下一分钟判定提前到立刻
    document.addEventListener("settings-changed", (event) => {
        const key = String(event.detail?.key || "");
        if (key.startsWith("screenTime.")) {
            state.lastDowntime = null; // 强制重发进出判定
            minuteTick();
        }
    });

    globalThis.__screenTime = screenTime;
    globalThis.__log?.info?.("kernel/screen-time",
        `屏幕使用时间就绪：记录${settings.get("screenTime.enabled") === false ? "已关闭" : "开启"}`
        + `，停用时间${screenTime.getDowntime().enabled ? "已排程" : "未启用"}`);
    return true;
}

/** 测试探针专用：纯函数与受控写入的最小面。生产代码不应引用。 */
export const __usageInternals = {
    todayKey, parseHHMM, normalizeDowntime, isDowntimeAt, pruneDays, recordTick, writeStore,
    USAGE_SLOT, MAX_DAYS,
};

export { initUsageTracker, screenTime, getDayTotals, getDayTotal, getRecentDays, isDowntimeNow, allowedApps };
