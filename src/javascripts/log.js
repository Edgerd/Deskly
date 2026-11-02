/**
 * log.js — 全局日志系统（按重要性 + 按程序双维度分类）
 *
 * 现状问题：仓库里有 300 处裸 console.*，只进浏览器控制台、刷新即丢，用户与插件
 * 作者都无从查看「刚才那次打开为什么 404」。本模块把日志收成一份可查、可留存、
 * 可导出的运行记录，并把已有的 console.* 自动接住 —— 现有代码不必改造就能进日志。
 *
 * 分类：
 * - **按重要性**：debug < info < warn < error，`debug.logLevel` 决定记录门槛。
 * - **按程序**：来源统一带类别前缀 —— 内核为 `kernel/<模块>`（如 `kernel/dock`），
 *   插件为 `plugin/<id>`（如 `plugin/siri`）。传裸名也能用：判据是内核模块名白名单
 *   `KERNEL_MODULES`（封闭集合），命中归 `kernel/`，**未命中一律归 `plugin/`** ——
 *   插件 id 是开放集合，拿开放集合做白名单会随新插件漂移。新增内核模块要同步补表，
 *   否则它的日志会被错标成插件来源。
 *
 * 环形缓冲在**内核模块作用域**里，插件入口脚本每次打开都重新执行（`?v=Date.now()`），
 * 所以日志缓冲绝不能放在插件侧；插件通过 window.__log 写入即可跨窗口、跨次累积。
 * 尾部若干条按 `debug.persist` 落 localStorage，刷新后仍能看到「上一次会话的报错」。
 *
 * 对外 API 与调用示例见 dev/devdoc/os-api.md「日志」一节。
 */

import { settings } from "./settings.js";

/** 级别门槛表：数值越大越严重。 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = Object.keys(LEVELS);

/** 落盘槽：日志缓冲是数据不是设置，直写存储以免与 settings 互相触发。 */
const BUFFER_SLOT = "deskly-log-buffer";
const PERSIST_MAX_BYTES = 240000;
const DATA_MAX_CHARS = 500;
const MSG_MAX_CHARS = 400;
const PERSIST_DEBOUNCE = 900;

/** 内存环形缓冲（按时间正序）与统计。 */
let entries = [];
let seq = 0;
let dropped = 0;
const subscribers = new Set();
let persistTimer = null;
let knownPluginIds = new Set();
let consolePatched = false;

/** 已知内核模块名（`src/javascripts/` 下的文件名 + 少数伪来源）。
 *  裸来源名不在此表内的一律归到 `plugin/`：插件 id 是开放集合，内核模块名是封闭集合，
 *  用封闭集合做白名单才不会随新插件而漂移。新增内核模块时同步补这里。 */
const KERNEL_MODULES = new Set([
    // app-store 已下架：商店界面整个搬进 mods/app-store/，宿主侧只剩 store-api 数据层，
    // 留在内核白名单里会把插件的日志错分成内核日志。
    "app-registry", "appearance", "audio", "bootstrap", "client", "contextMenuSettings",
    "controlcenter", "cursor", "datetime_popover", "debug", "desktop", "dock", "finderbar", "i18n",
    "lock", "main", "paths", "permissions", "plugin-manager", "session", "settings", "settings-definitions",
    "sound", "spotlight", "store-api", "trashIcon", "version", "vfs", "wallpaper", "window", "zindex",
    "alert", "contextMenu", "desktopItems", "menu", "menuCommands", "notification", "trafficLights",
    // 0.2.85 起的新内核模块：osfs/surface 是先前补文件时漏登记的，
    // 漏了会让它们的日志被归成 plugin/osfs（按程序分类这一维就废了）。
    "api-grants", "os-api", "default-apps", "osfs", "surface",
    "log", "console", "global", "loader", "perf", "system",
]);
/** 生效中的日志配置（由 debug.* 设置驱动）。 */
const config = {
    level: "info",
    captureConsole: true,
    captureErrors: true,
    bufferSize: 800,
    persist: true,
    persistCount: 150,
};

/** 注册日志自身的设置项；apply 只改内存配置，落盘由 settings 完成。 */
function defineSettings() {
    settings.defineMany([
        {
            key: "debug.logLevel", type: "string", default: "info", values: LEVEL_NAMES,
            label: "记录门槛", control: "dropdown",
            owner: "system", pane: "debug", group: "调试", order: 10,
            apply: (value) => { config.level = value; },
        },
        {
            key: "debug.captureConsole", type: "boolean", default: true,
            label: "接管 console 输出", control: "switch",
            owner: "system", pane: "debug", group: "调试", order: 20,
            apply: (value) => { config.captureConsole = value; },
        },
        {
            key: "debug.captureErrors", type: "boolean", default: true,
            label: "捕获未处理异常", control: "switch",
            owner: "system", pane: "debug", group: "调试", order: 30,
            apply: (value) => { config.captureErrors = value; },
        },
        {
            key: "debug.bufferSize", type: "number", default: 800, min: 100, max: 5000, step: 100,
            label: "内存缓冲条数", control: "slider", units: "条",
            owner: "system", pane: "debug", group: "调试", order: 40,
            apply: (value) => { config.bufferSize = value; trim(); },
        },
        {
            key: "debug.persist", type: "boolean", default: true,
            label: "跨刷新留存", control: "switch",
            owner: "system", pane: "debug", group: "调试", order: 50,
            apply: (value) => { config.persist = value; if (!value) clearStorage(); else schedulePersist(); },
        },
        {
            key: "debug.persistCount", type: "number", default: 150, min: 0, max: 500, step: 10,
            label: "留存条数", control: "slider", units: "条",
            owner: "system", pane: "debug", group: "调试", order: 60,
            apply: (value) => { config.persistCount = value; schedulePersist(); },
        },
    ]);
    // 定义注册后立刻按存储值对齐内存配置（不依赖 apply 被调用）
    config.level = settings.get("debug.logLevel") || "info";
    config.captureConsole = settings.get("debug.captureConsole");
    config.captureErrors = settings.get("debug.captureErrors");
    config.bufferSize = settings.get("debug.bufferSize");
    config.persist = settings.get("debug.persist");
    config.persistCount = settings.get("debug.persistCount");
}

/**
 * 维护插件 id 名单，用于把裸来源名归类到 plugin/ 前缀。
 * 不 import app-registry：日志参与模块环会让「插件已注册」与「日志已就绪」互相等待，
 * 事件流里已经带着清单，直接取用即可。
 */
function trackPlugins() {
    const collect = (manifests) => {
        (manifests || []).forEach((m) => { if (m && m.id) knownPluginIds.add(String(m.id)); });
    };
    document.addEventListener("plugins-ready", (e) => {
        collect(e.detail && e.detail.plugins);
        logEntry("info", "kernel/log", `插件清单就绪，当前 ${knownPluginIds.size} 个插件在册`);
    });
    document.addEventListener("plugin-registered", (e) => {
        const id = e.detail && e.detail.id;
        if (id) knownPluginIds.add(String(id));
    });
}

/**
 * 归一化来源：带斜杠的直接采用；裸名查内核白名单，命中归 kernel/，未命中归 plugin/。
 * @param {string} source 调用方给出的来源
 * @returns {string} 带类别前缀的来源
 */
function normalizeSource(source) {
    const text = String(source || "kernel/system").trim();
    if (!text) return "kernel/system";
    if (text.includes("/")) return text;
    return KERNEL_MODULES.has(text) ? `kernel/${text}` : `plugin/${text}`;
}

/** 任意 data 转成简短字符串；Error 保留 message，异常对象不丢。 */
function serializeData(data) {
    if (data === undefined || data === null) return "";
    if (data instanceof Error) return `${data.name}: ${data.message}`.slice(0, DATA_MAX_CHARS);
    if (typeof data === "string") return data.slice(0, DATA_MAX_CHARS);
    try {
        return JSON.stringify(data).slice(0, DATA_MAX_CHARS);
    } catch {
        return String(data).slice(0, DATA_MAX_CHARS);
    }
}

/** 从 "[tag] 文本" 形态的 console 参数里取出既有约定的模块标签作为来源。 */
function sourceFromArgs(args) {
    const first = args && args[0];
    if (typeof first !== "string") return "console";
    const match = first.match(/^\[([^\]]{1,40})\]/);
    return match ? match[1] : "console";
}

function trim() {
    const over = entries.length - config.bufferSize;
    if (over > 0) {
        entries.splice(0, over);
        dropped += over;
    }
}

/** 唯一写入点：门槛判定 -> 入缓冲 -> 通知订阅者 -> 计划落盘。 */
function logEntry(level, source, message, data, via = "api") {
    const rank = LEVELS[level] || LEVELS.info;
    if (rank < (LEVELS[config.level] || LEVELS.info)) return null;
    const entry = {
        id: ++seq,
        time: Date.now(),
        level,
        source: normalizeSource(source),
        msg: String(message ?? "").slice(0, MSG_MAX_CHARS),
        data: serializeData(data),
        via,
    };
    entries.push(entry);
    trim();
    subscribers.forEach((fn) => {
        try { fn(entry); } catch (err) { originalWarn("[log] 订阅者执行失败:", err); }
    });
    if (config.persist) schedulePersist();
    return entry;
}

/** 时间戳格式化（本地时区，毫秒精度）。 */
function stamp(ts) {
    const d = new Date(ts);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 单条记录的一行文本形态，用于导出与剪贴板。 */
function lineOf(entry) {
    const tag = entry.level.toUpperCase().padEnd(5);
    return `${stamp(entry.time)} [${tag}] ${entry.source} :: ${entry.msg}${entry.data ? ` | ${entry.data}` : ""}`;
}

// ---- 落盘 ----

function schedulePersist() {
    if (!config.persist || config.persistCount <= 0 || persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; writeStorage(); }, PERSIST_DEBOUNCE);
}

function writeStorage() {
    try {
        const tail = entries.slice(-config.persistCount);
        let text = JSON.stringify(tail);
        while (text.length > PERSIST_MAX_BYTES && tail.length > 5) {
            tail.splice(0, Math.ceil(tail.length / 4));
            text = JSON.stringify(tail);
        }
        localStorage.setItem(BUFFER_SLOT, text);
    } catch (err) {
        // 配额被壁纸 data-URL 之类的键占满是本项目已知情形：留存失败只关掉本功能，不连带影响设置写入
        config.persist = false;
        logEntry("error", "kernel/log", "运行记录留存失败，本次会话不再尝试落盘", err);
    }
}

function readStorage() {
    try {
        const raw = localStorage.getItem(BUFFER_SLOT);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((e) => e && e.time && e.level) : [];
    } catch {
        return [];
    }
}

function clearStorage() {
    try { localStorage.removeItem(BUFFER_SLOT); } catch { /* 忽略 */ }
}

/** 把上一次会话留下的记录读回缓冲，并在其后补一条分界说明。 */
function restorePersisted() {
    const saved = readStorage();
    if (!saved.length) return;
    entries = saved.map((e) => ({ ...e, restored: true }));
    seq = entries.reduce((max, e) => Math.max(max, e.id || 0), 0);
    logEntry("info", "kernel/log", `已载入上一次会话的运行记录 ${entries.length} 条`);
}

// ---- 接管既有 console 与全局异常 ----

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

/**
 * 包装一层 console 方法：先归档，再原样输出，保持既有 `[tag]` 控制台可读性。
 * @param {string} methodName console 方法名
 * @param {Function} native 原始实现
 * @param {string} level 归档级别
 */
function patchConsole(methodName, native, level) {
    console[methodName] = (...args) => {
        if (config.captureConsole) {
            logEntry(level, sourceFromArgs(args), consoleText(args), args.find(isLikelyError), "console");
        }
        native(...args);
    };
}

/** console 参数转一行文本（对象保留可打印摘要，不做递归展开）。 */
function consoleText(args) {
    return args.map((a) => (typeof a === "string" ? a : isLikelyError(a) ? `${a.name}: ${a.message}` : safeStringify(a))).join(" ").slice(0, MSG_MAX_CHARS);
}

function isLikelyError(value) {
    return value instanceof Error;
}

function safeStringify(value) {
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function installConsoleCapture() {
    if (consolePatched) return;
    consolePatched = true;
    patchConsole("log", originalLog, "info");
    patchConsole("info", console.info.bind(console), "info");
    patchConsole("debug", console.debug.bind(console), "debug");
    patchConsole("warn", originalWarn, "warn");
    patchConsole("error", originalError, "error");
}

/**
 * 挂全局异常捕获。
 * 监听器一旦挂上就不再摘（摘除会漏掉「先关后开」窗口期里的报错），
 * 所以每次回调都必须重新读 `config.captureErrors` —— 否则关掉开关后
 * 异常照旧入档，那个设置项就成了假的。
 */
function installErrorCapture() {
    if (installErrorCapture.bound) return;
    installErrorCapture.bound = true;
    window.addEventListener("error", (event) => {
        if (!config.captureErrors) return;
        const target = event.target;
        if (target && target !== window && target.tagName) {
            const url = target.src || target.href || "";
            logEntry("error", "kernel/loader", `资源加载失败：<${target.tagName.toLowerCase()}> ${String(url).slice(0, 160)}`, { via: "error-event" }, "resource");
            return;
        }
        logEntry("error", "kernel/global", `未捕获异常：${event.message}`, { file: event.filename, line: event.lineno, col: event.colno, error: event.error }, "error");
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
        if (!config.captureErrors) return;
        const reason = event.reason;
        logEntry("error", "kernel/global", `未处理的 Promise 拒绝：${(reason && reason.message) || safeStringify(reason)}`, reason, "rejection");
    });
}

/** 开关打开时确保监听在位；关闭由回调里的复查生效，不需要摘监听器。 */
settings.on("debug.captureErrors", (value) => { if (value) installErrorCapture(); });

// ---- 查询 ----

/** 按条件筛选缓冲记录。 */
function filter(opts = {}) {
    const levels = opts.levels || (opts.level ? String(opts.level).split(",") : null);
    const floor = opts.minLevel ? LEVELS[opts.minLevel] : null;
    const source = opts.source ? String(opts.source).toLowerCase() : null;
    const contains = opts.contains ? String(opts.contains).toLowerCase() : null;
    return entries.filter((e) => {
        if (levels && !levels.includes(e.level)) return false;
        if (floor && LEVELS[e.level] < floor) return false;
        if (source && !e.source.toLowerCase().includes(source)) return false;
        if (contains && !`${e.msg} ${e.data}`.toLowerCase().includes(contains)) return false;
        if (opts.since && e.time < opts.since) return false;
        if (opts.until && e.time > opts.until) return false;
        return true;
    });
}

const log = {
    /** 级别名列表。 */
    levels: () => [...LEVEL_NAMES],

    /**
     * 写一条日志。
     * @param {string} level debug/info/warn/error
     * @param {string} source 来源（kernel/dock 或插件 id）
     * @param {string} message 文本
     * @param {*} [data] 附加上下文
     * @returns {object|null} 记录对象，被门槛过滤时为 null
     */
    entry(level, source, message, data) {
        return logEntry(LEVELS[level] ? level : "info", source, message, data);
    },

    debug: (source, message, data) => logEntry("debug", source, message, data),
    info: (source, message, data) => logEntry("info", source, message, data),
    warn: (source, message, data) => logEntry("warn", source, message, data),
    error: (source, message, data) => logEntry("error", source, message, data),

    /**
     * 生成绑定了来源的子日志器，插件在自己的模块顶部建一个即可。
     * @param {string} source 来源名（插件里直接写插件 id）
     * @returns {{source:string, debug:Function, info:Function, warn:Function, error:Function, entry:Function, timer:Function}} 子日志器
     */
    for(source) {
        const fixed = normalizeSource(source);
        return {
            source: fixed,
            debug: (m, d) => logEntry("debug", fixed, m, d),
            info: (m, d) => logEntry("info", fixed, m, d),
            warn: (m, d) => logEntry("warn", fixed, m, d),
            error: (m, d) => logEntry("error", fixed, m, d),
            entry: (level, m, d) => logEntry(LEVELS[level] ? level : "info", fixed, m, d),
            timer: (label) => log.timer(`${fixed} ${label || "耗时"}`),
        };
    },

    /**
     * 简易耗时统计：调用 stop 时以 info 记录毫秒差。
     * @param {string} label 标签
     * @returns {{stop:Function}} 计时句柄
     */
    timer(label) {
        const started = performance.now();
        const name = label || "计时";
        return {
            stop: (suffix) => {
                const ms = Math.round((performance.now() - started) * 10) / 10;
                logEntry("info", "kernel/perf", `${name}${suffix ? ` ${suffix}` : ""}耗时 ${ms}ms`);
                return ms;
            },
        };
    },

    /**
     * 条件断言：不成立时记一条错误并返回 false。
     * @param {boolean} condition 判定条件
     * @param {string} source 来源
     * @param {string} message 说明
     * @returns {boolean} 条件结果
     */
    assert(condition, source, message) {
        if (condition) return true;
        logEntry("error", source, `断言失败：${message}`);
        return false;
    },

    /**
     * 查询记录。
     * @param {object} [opts] {level|levels, minLevel, source, contains, since, until, limit, offset, desc}
     * @returns {Array<object>} 记录副本数组（默认时间正序）
     */
    query(opts = {}) {
        let list = filter(opts);
        if (opts.desc) list = list.slice().reverse();
        const from = opts.offset || 0;
        const slice = opts.limit ? list.slice(from, from + opts.limit) : list.slice(from);
        return slice.map((e) => ({ ...e }));
    },

    /** 最近 n 条（时间正序）。 */
    recent(n = 100) {
        return entries.slice(-n).map((e) => ({ ...e }));
    },

    /** 当前缓冲条数。 */
    count() {
        return entries.length;
    },

    /** 已注册插件 id 名单（调试菜单的「重载插件」列表用）。 */
    plugins: () => [...knownPluginIds].sort(),

    /**
     * 分类统计，供设置面板与调试菜单显示。
     * @returns {{total:number, byLevel:object, bySource:object, sources:Array, dropped:number, capacity:number, restored:number, persisting:boolean}} 统计
     */
    stats() {
        const byLevel = {};
        const bySource = {};
        let restored = 0;
        LEVEL_NAMES.forEach((name) => { byLevel[name] = 0; });
        entries.forEach((e) => {
            byLevel[e.level] = (byLevel[e.level] || 0) + 1;
            bySource[e.source] = (bySource[e.source] || 0) + 1;
            if (e.restored) restored += 1;
        });
        const sources = Object.entries(bySource)
            .map(([source, count]) => ({ source, count }))
            .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
        return { total: entries.length, byLevel, bySource, sources, dropped, capacity: config.bufferSize, restored, persisting: config.persist };
    },

    /**
     * 订阅新记录（日志窗口实时刷新用）。
     * @param {Function} fn fn(entry)
     * @returns {Function} 退订函数
     */
    subscribe(fn) {
        if (typeof fn !== "function") return () => { };
        subscribers.add(fn);
        return () => subscribers.delete(fn);
    },

    /** 清空内存与留存。 */
    clear() {
        entries = [];
        dropped = 0;
        clearStorage();
        logEntry("info", "kernel/log", "运行记录已清空");
    },

    /** 导出为纯文本（每行一条）。 */
    exportText(opts = {}) {
        const header = `# Deskly 运行日志 · 导出时间 ${stamp(Date.now())} · 门槛 ${config.level} · 共 ${filter(opts).length} 条`;
        return [header, ...filter(opts).map(lineOf)].join("\n");
    },

    /** 导出为 JSON 文本。 */
    exportJSON(opts = {}) {
        return JSON.stringify({ exportedAt: Date.now(), level: config.level, entries: filter(opts) }, null, 2);
    },

    /**
     * 触发浏览器下载 .log 文件。
     * @param {string} [filename] 文件名
     * @param {object} [opts] 同 query 的筛选条件
     * @returns {boolean} 是否已发起下载
     */
    download(filename = `deskly-log-${Date.now()}.log`, opts = {}) {
        try {
            const blob = new Blob([log.exportText(opts)], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            logEntry("info", "kernel/log", `已导出日志文件 ${filename}`);
            return true;
        } catch (err) {
            logEntry("error", "kernel/log", "日志导出失败", err);
            return false;
        }
    },

    /**
     * 复制全部（筛选后）文本到剪贴板；无剪贴板权限时回退选中法。
     * @param {object} [opts] 同 query 的筛选条件
     * @returns {Promise<boolean>} 是否成功
     */
    async copy(opts = {}) {
        const text = log.exportText(opts);
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                logEntry("info", "kernel/log", `已复制 ${filter(opts).length} 条日志到剪贴板`);
                return true;
            }
        } catch (err) {
            logEntry("warn", "kernel/log", "剪贴板 API 被拒绝，改用选中文本方式", err);
        }
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.cssText = "position:fixed;left:-9999px;top:0;";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch {
            return false;
        }
    },

    /** 当前门槛级别。 */
    getLevel: () => config.level,

    /**
     * 设置门槛级别（等价于 settings.set("debug.logLevel", level)）。
     * @param {string} level debug/info/warn/error
     * @returns {boolean} 是否生效
     */
    setLevel(level) {
        if (!LEVELS[level]) return false;
        return settings.set("debug.logLevel", level, { source: "log" }).ok;
    },

    /** 生效中的日志配置副本。 */
    config: () => ({ ...config }),

    /**
     * 强制立即落盘（调试菜单「保存运行记录」在关窗前用）。
     * @returns {void}
     */
    flush() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        if (config.persist) writeStorage();
    },
};

// ---- 启动 ----

defineSettings();
installConsoleCapture();
installErrorCapture();
restorePersisted();
trackPlugins();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") log.flush(); });
window.addEventListener("pagehide", () => log.flush());
logEntry("info", "kernel/log", `日志系统就绪（门槛 ${config.level}，接管 console 与全局异常）`);

export { log, LEVELS };

// 全局挂载：插件与核心层都可直接调用，风格同 window.__dialog / __notify。
globalThis.__log = log;
