/**
 * settings.js — 设置中枢：全系统唯一的设置读写入口
 *
 * 为什么需要它：历史上每个 owner 模块各写各的 localStorage（34 个键、三套命名、
 * 三种错误处理），系统设置插件还得自己复制 dock-* 键名再补发事件；写错一个字符
 * 就是「设置项静默失效」。本模块把「校验 / 落盘 / 生效 / 广播 / 日志」收成一条链路。
 *
 * 五条设计约定：
 * 1. **键名即存储槽**：`dock.size` 默认落到 localStorage 槽 `dock-size`（点号转连字符），
 *    与既有键完全重合，接入本接口不需要数据迁移；槽名对不上时（`webstartos_language`
 *    这类带前缀的旧键）由定义里的 `slot` 显式覆盖。
 * 2. **单一写入方**：任何地方改设置都调 `settings.set()`；owner 模块只提供 `apply`
 *    生效函数，不再自己 `setItem`。
 * 3. **写入前校验**：`type` / `values` / `min` / `max` 不合法的值直接拒绝，数值超界先钳制。
 *    修掉「往 dock-size-change 塞 detail=500 就得到 500px 程序坞」这类问题。
 * 4. **事件双轨**：定义里的 `event` 仍按旧格式在 window 上派发（detail 为序列化字符串），
 *    保证 dock.js 等既有监听者零改动；同时新增 document 上的 `settings-changed`
 *    （detail 为对象，冒泡），供设置面板做双向同步与新代码订阅。
 * 5. **零内核 import**：日志经 `window.__log` 可选引用，避免与 log.js 互相依赖成环。
 *    唯一的例外是 `caller-context.js` —— 它不 import 任何东西、不碰 DOM、不写全局，
 *    是叶子模块；订阅回调的归属必须有一个插件改不掉的通道，不能退回读全局变量。
 *
 * 定义里还可以带 `owner` / `label` / `control` 等界面元数据，系统设置据此自动渲染
 * 「插件」面板 —— 第三方插件不必自绘设置界面，只要 `define` 一个键就能获得设置项。
 *
 * 对外 API 与元数据字段说明见 dev/devdoc/os-api.md「设置」一节。
 */

import { callerFromStack, withCaller } from "./caller-context.js";

/** 支持的取值类型。 */
const TYPES = new Set(["boolean", "number", "string", "json"]);

/** 键名规则：至少两段，首段为命名空间（小写开头），后续段允许 camelCase。 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-zA-Z][A-Za-z0-9]*)+$/;

/** 已注册的定义表。 */
const defs = new Map();

/** 订阅者集合。 */
const subscribers = new Set();

/** localStorage 不可用（隐私模式 / 单测环境）时的内存替身。 */
const memory = new Map();
let storageBroken = false;

/**
 * 取存储后端；不可用时返回 null，由调用方走内存替身。
 * @returns {Storage|null} localStorage 或 null
 */
function backend() {
    if (storageBroken) return null;
    try {
        const probe = globalThis.localStorage;
        if (!probe || typeof probe.getItem !== "function") throw new Error("localStorage 不可用");
        return probe;
    } catch (err) {
        storageBroken = true;
        console.warn("[settings] localStorage 不可用，本次会话的设置仅存内存：", err);
        return null;
    }
}

/** 可选日志入口：log.js 尚未加载时静默跳过，不影响设置本身。 */
function logger() {
    return globalThis.__log || null;
}

/** 由键名推导存储槽：点号转连字符（`dock.zoom.amount` -> `dock-zoom-amount`）。 */
function slotOf(key, def) {
    return (def && def.slot) || key.split(".").join("-");
}

function readSlot(slot) {
    const store = backend();
    if (!store) return memory.has(slot) ? memory.get(slot) : null;
    try {
        return store.getItem(slot);
    } catch (err) {
        console.warn(`[settings] 读取 ${slot} 失败：`, err);
        return null;
    }
}

/** 写原始字符串；配额超限等异常时返回 false，让调用方知道「没落盘」。 */
function writeSlot(slot, text) {
    const store = backend();
    if (!store) {
        memory.set(slot, text);
        return true;
    }
    try {
        store.setItem(slot, text);
        return true;
    } catch (err) {
        console.warn(`[settings] 写入 ${slot} 失败（配额或权限）：`, err);
        return false;
    }
}

function removeSlot(slot) {
    const store = backend();
    if (!store) { memory.delete(slot); return true; }
    try {
        store.removeItem(slot);
        return true;
    } catch (err) {
        console.warn(`[settings] 删除 ${slot} 失败：`, err);
        return false;
    }
}

/** 宽容的布尔解析：认 on/true/1 与 off/false/0，其余视为无效。 */
function parseBoolean(raw) {
    if (raw === "on" || raw === "true" || raw === "1") return true;
    if (raw === "off" || raw === "false" || raw === "0") return false;
    return undefined;
}

/** 读 jsonPath 指向的子字段。 */
function readPath(obj, path) {
    return path.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), obj);
}

/** 写 jsonPath 指向的子字段，途中的非对象节点替换成新对象。 */
function writePath(obj, path, value) {
    const parts = path.split(".");
    let node = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
        node = node[part];
    }
    node[parts[parts.length - 1]] = value;
    return obj;
}

/** 对象默认值做浅合并，让新版本新增字段自动带上默认值（不丢用户已存的键）。 */
function mergeJson(defaults, parsed) {
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)
        && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
    }
    return parsed;
}

/** 未注册键的存储形态启发式：只看首字符判断是否 JSON。 */
function guessType(raw) {
    const head = String(raw).trim().charAt(0);
    return head === "{" || head === "[" ? "json" : "string";
}

/** 无效存储值：能恢复就回退默认，同时留一条日志说明为什么不是默认值。 */
function warnBadValue(key, raw, why) {
    const text = `[settings] ${key} 的存储值无效（${why}）：${String(raw).slice(0, 80)}`;
    const log = logger();
    if (log) log.warn("kernel/settings", text);
    else console.warn(text);
}

/** 数值钳制：min/max/step 缺省即不限制。 */
function clamp(value, def) {
    if (!def) return value;
    let out = value;
    if (typeof def.min === "number") out = Math.max(def.min, out);
    if (typeof def.max === "number") out = Math.min(def.max, out);
    if (def.step) out = Math.round(out / def.step) * def.step;
    return Number(out.toFixed(6));
}

/** 按类型把存储字符串解析成设置值；无法解析时回退默认值。 */
function decode(key, def, raw) {
    const fallback = def && "default" in def ? def.default : undefined;
    if (raw === null || raw === undefined || raw === "") return fallback;
    const type = def ? def.type : guessType(raw);
    if (type === "boolean") {
        const parsed = parseBoolean(raw);
        if (parsed === undefined) { warnBadValue(key, raw, "不是 on/off"); return fallback; }
        return parsed;
    }
    if (type === "number") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) { warnBadValue(key, raw, "不是有限数值"); return fallback; }
        return clamp(parsed, def);
    }
    if (type === "json") {
        try {
            return mergeJson(fallback, JSON.parse(raw));
        } catch {
            warnBadValue(key, raw, "JSON 解析失败");
            return fallback;
        }
    }
    if (def && Array.isArray(def.values) && !def.values.includes(raw)) {
        warnBadValue(key, raw, "不在候选值内");
        return fallback;
    }
    return raw;
}

/**
 * 按类型序列化成存储字符串。
 * @param {string} type 类型
 * @param {*} value 值
 * @param {boolean} [typed=true] 是否属于已注册定义：已注册布尔用 on/off 沿用站内既有
 *                               写法（dock/cursor 等 owner 直接读串），未注册的裸键写
 *                               "true"/"false" 以便读回时还原成布尔
 * @returns {string} 存储文本
 */
function encode(type, value, typed = true) {
    if (type === "boolean") return typed ? (value ? "on" : "off") : String(value);
    if (type === "json") return JSON.stringify(value);
    return String(value);
}

/**
 * 未注册键的宽松解析：尽量把存储文本还原成写入时的类型。
 * @param {string} raw 存储文本
 * @returns {*} 布尔 / 数字 / 对象 / 字符串
 */
function parseLoose(raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    const head = raw.trim().charAt(0);
    if (head === "{" || head === "[") {
        try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
}

/** 从任意值推断类型（未注册键写入时使用）。 */
function typeOf(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (value && typeof value === "object") return "json";
    return "string";
}

/** 日志里值的安全摘要，避免整段壁纸 data-URL 进日志。 */
function short(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 60 ? `${text.slice(0, 60)}…(${text.length})` : text;
}

/** 读未注册键的原始值：先按推导槽找，再按原名找。 */
function readRawForUndefined(key) {
    return readSlot(key.split(".").join("-")) ?? readSlot(key);
}

/** 读已注册键的原始值；jsonPath 时把子字段还原成可 decode 的字符串形态。 */
function readStored(key, def) {
    const raw = readSlot(slotOf(key, def));
    if (!def.jsonPath || !raw) return raw;
    try {
        const found = readPath(JSON.parse(raw), def.jsonPath);
        if (found === undefined || found === null) return null;
        return (typeof found === "object") ? JSON.stringify(found) : String(found);
    } catch {
        return null;
    }
}

/** 定义副本（含界面元数据），未注册时返回 null。 */
function defOf(key) {
    return defs.get(key) || null;
}

/** 广播：旧式单键事件（window）+ 统一变更事件（document，冒泡）+ 订阅者。 */
function emit(def, key, value, previous, persisted) {
    const type = def ? def.type : typeOf(value);
    if (def && def.event) {
        const detail = type === "json" ? value : encode(type, value);
        window.dispatchEvent(new CustomEvent(def.event, { detail }));
    }
    const detail = { key, value, previous, persisted, type };
    document.dispatchEvent(new CustomEvent("settings-changed", { detail, bubbles: true }));
    subscribers.forEach((fn) => {
        try { fn(detail); } catch (err) { console.warn("[settings] 订阅者执行失败：", err); }
    });
}

/** 深拷贝默认值，避免 reset 时把共享对象写回存储。 */
function cloneDefault(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === "function") return structuredClone(value);
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

const settings = {
    /**
     * 注册或更新一个设置项定义（同名定义做字段合并，可分次补充界面元数据）。
     * @param {object} def 定义：key / type / default / values / min / max / step / slot /
     *                     jsonPath / event / apply；界面元数据 owner / label / hint /
     *                     control / valuesLabel / pane / order / group
     * @returns {object|null} 归一化后的定义副本；键名或类型非法返回 null
     */
    define(def) {
        if (!def || typeof def.key !== "string" || !KEY_PATTERN.test(def.key)) {
            console.warn(`[settings] 非法设置键名，已忽略：${def && def.key}`);
            return null;
        }
        const type = def.type || (typeof def.default === "boolean" ? "boolean"
            : typeof def.default === "number" ? "number"
                : (def.default && typeof def.default === "object") ? "json" : "string");
        if (!TYPES.has(type)) {
            console.warn(`[settings] ${def.key} 的类型不支持：${type}`);
            return null;
        }
        const merged = { ...(defs.get(def.key) || {}), ...def, type };
        if (!("default" in merged)) {
            merged.default = type === "boolean" ? false : type === "number" ? 0 : type === "json" ? null : "";
        }
        defs.set(merged.key, merged);
        return { ...merged };
    },

    /**
     * 批量注册定义。
     * @param {Array<object>} list 定义数组
     * @returns {number} 成功注册的数量
     */
    defineMany(list) {
        return (list || []).reduce((n, def) => n + (settings.define(def) ? 1 : 0), 0);
    },

    /**
     * 读取设置值；存储缺失或非法时回退默认值。
     * @param {string} key 设置键
     * @param {*} [fallback] 未注册键且无存储值时的回退
     * @returns {*} 归一化后的值
     */
    get(key, fallback) {
        const def = defOf(key);
        if (!def) {
            const raw = readRawForUndefined(key);
            return raw === null || raw === undefined ? fallback : parseLoose(raw);
        }
        return decode(key, def, readStored(key, def));
    },

    /**
     * 写入设置值：校验 -> 落盘 -> 生效 -> 广播 -> 记日志。
     * @param {string} key 设置键
     * @param {*} value 新值
     * @param {object} [opts] 选项
     * @param {boolean} [opts.silent] 不广播、不通知订阅者（批量恢复时使用）
     * @param {string} [opts.source] 变更来源标识，写入日志（如 "system-settings"）
     * @returns {{ok:boolean, key:string, value:*, persisted:boolean, changed:boolean, reason?:string}} 结果
     */
    set(key, value, opts = {}) {
        const def = defOf(key);
        const checked = (() => {
            const type = def ? def.type : typeOf(value);
            if (type === "boolean") return { ok: true, value: Boolean(value) };
            if (type === "number") {
                const num = typeof value === "number" ? value : Number(value);
                if (!Number.isFinite(num)) return { ok: false, reason: `需要数字，收到 ${JSON.stringify(value)}` };
                return { ok: true, value: clamp(num, def) };
            }
            if (type === "json") {
                if (typeof value === "string") {
                    try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false, reason: "JSON 文本无法解析" }; }
                }
                if (value === null || typeof value !== "object") return { ok: false, reason: "需要对象或数组" };
                return { ok: true, value };
            }
            const text = String(value);
            if (def && Array.isArray(def.values) && !def.values.includes(text)) {
                return { ok: false, reason: `取值 ${text} 不在候选值 ${def.values.join(" / ")} 内` };
            }
            return { ok: true, value: text };
        })();

        if (!checked.ok) {
            const text = `[settings] 拒绝写入 ${key}：${checked.reason}`;
            const log = logger();
            if (log) log.error("kernel/settings", text, { key, value });
            else console.warn(text);
            return { ok: false, key, value: settings.get(key), persisted: false, changed: false, reason: checked.reason };
        }

        const previous = settings.get(key);
        const next = checked.value;
        const type = def ? def.type : typeOf(next);
        const slot = slotOf(key, def);
        const typed = Boolean(def);
        const unchanged = JSON.stringify(encode(type, previous, typed)) === JSON.stringify(encode(type, next, typed));

        let persisted;
        if (def && def.jsonPath) {
            let container = {};
            const raw = readSlot(slot);
            try { container = raw ? JSON.parse(raw) : {}; } catch { container = {}; }
            persisted = writeSlot(slot, encode("json", writePath({ ...container }, def.jsonPath, next)));
        } else {
            persisted = writeSlot(slot, encode(type, next, typed));
        }

        if (def && typeof def.apply === "function") {
            try {
                def.apply(next, { previous, persisted, source: opts.source || "api" });
            } catch (err) {
                const text = `[settings] ${key} 生效函数抛错：${err && err.message}`;
                const log = logger();
                if (log) log.error("kernel/settings", text, { key, error: String(err) });
                else console.warn(text);
            }
        }

        if (!opts.silent && !unchanged) {
            emit(def, key, next, previous, persisted);
            const log = logger();
            if (log) log.info("kernel/settings", `${key} = ${short(next)}`, { previous: short(previous), persisted, source: opts.source || "api" });
        }
        return { ok: true, key, value: next, persisted, changed: !unchanged };
    },

    /**
     * 批量写入，逐条校验与广播。
     * @param {Record<string, *>|Array<[string, *]>} pairs 键值集合
     * @param {object} [opts] 透传给 set 的选项
     * @returns {Array<object>} 每项的 set 结果
     */
    setMany(pairs, opts = {}) {
        const list = Array.isArray(pairs) ? pairs : Object.entries(pairs || {});
        return list.map(([key, value]) => settings.set(key, value, opts));
    },

    /**
     * 恢复某项默认值：删除存储槽，让 owner 模块回落到内置默认。
     * @param {string} key 设置键
     * @param {object} [opts] 透传给广播的选项
     * @returns {object} set 形态的结果
     */
    reset(key, opts = {}) {
        const def = defOf(key);
        if (!def) {
            return { ok: false, key, value: settings.get(key), persisted: false, changed: false, reason: "未注册的定义，无法恢复默认" };
        }
        if (def.jsonPath) return settings.set(key, cloneDefault(def.default), { ...opts, source: opts.source || "reset" });
        removeSlot(slotOf(key, def));
        const previous = settings.get(key);
        if (typeof def.apply === "function") {
            try { def.apply(cloneDefault(def.default), { previous, persisted: true, source: "reset" }); }
            catch (err) { console.warn(`[settings] ${key} 恢复默认时生效函数抛错：`, err); }
        }
        emit(def, key, def.default, previous, true);
        const log = logger();
        if (log) log.info("kernel/settings", `${key} 已恢复默认 = ${short(def.default)}`);
        return { ok: true, key, value: def.default, persisted: true, changed: true };
    },

    /**
     * 按命名空间或 owner 批量恢复默认。
     * @param {object} [scope] {prefix, owner, pane}
     * @returns {number} 恢复的项数
     */
    resetAll(scope = {}) {
        const targets = settings.list(scope);
        targets.forEach((def) => settings.reset(def.key, { source: "reset-all" }));
        return targets.length;
    },

    /**
     * 该键当前是否等于默认值。
     * @param {string} key 设置键
     * @returns {boolean} 是否默认
     */
    isDefault(key) {
        const def = defOf(key);
        if (!def) return false;
        return JSON.stringify(settings.get(key)) === JSON.stringify(cloneDefault(def.default));
    },

    /**
     * 是否注册过该定义（不代表存储里有值）。
     * @param {string} key 设置键
     * @returns {boolean} 是否已注册
     */
    has(key) {
        return defs.has(key);
    },

    /**
     * 取定义副本（含界面元数据），供设置面板渲染控件。
     * @param {string} key 设置键
     * @returns {object|null} 定义副本
     */
    info(key) {
        const def = defOf(key);
        return def ? { ...def } : null;
    },

    /**
     * 列出定义，可按前缀 / owner / 面板过滤。
     * @param {object} [scope] {prefix, owner, pane}
     * @returns {Array<object>} 定义副本，按 order 再按 key 排序
     */
    list(scope = {}) {
        const { prefix, owner, pane } = scope;
        const out = [];
        defs.forEach((def) => {
            if (prefix && !def.key.startsWith(prefix)) return;
            if (owner && def.owner !== owner) return;
            if (pane && def.pane !== pane) return;
            out.push({ ...def, value: settings.get(def.key) });
        });
        return out.sort((a, b) => (a.order || 0) - (b.order || 0) || a.key.localeCompare(b.key));
    },

    /**
     * 取一组键的当前值。
     * @param {object} [scope] 同 list 的过滤条件
     * @returns {Record<string, *>} 键值表
     */
    all(scope = {}) {
        const out = {};
        settings.list(scope).forEach((def) => { out[def.key] = def.value; });
        return out;
    },

    /**
     * 订阅全部设置变更（含未注册的裸键）。
     * @param {Function} fn fn(detail)，detail = {key, value, previous, persisted, type}
     * @returns {Function} 退订函数
     */
    subscribe(fn) {
        if (typeof fn !== "function") return () => { };
        // 归属在**订阅时**认一次并随回调传下去：设置变更由内核派发，派发期的调用栈
        // 不一定还认得出是谁注册的回调，而 guard() 认不出时现在会拒绝（旧版是放行）。
        // 订阅这一刻插件帧一定在栈上，是唯一可靠的取证时机。
        const owner = callerFromStack();
        const wrapped = (detail) => withCaller(owner, () => fn(detail));
        subscribers.add(wrapped);
        return () => subscribers.delete(wrapped);
    },

    /**
     * 订阅单个键的变更。
     * @param {string} key 设置键
     * @param {Function} fn fn(value, detail)
     * @returns {Function} 退订函数
     */
    on(key, fn) {
        if (typeof fn !== "function") return () => { };
        return settings.subscribe((detail) => { if (detail.key === key) fn(detail.value, detail); });
    },

    /**
     * 导出全部**已注册**设置的原始存储值，用于备份与诊断。
     * @param {object} [scope] 同 list 的过滤条件
     * @returns {Record<string, string>} 槽名 -> 原始字符串
     */
    snapshot(scope = {}) {
        const out = {};
        settings.list(scope).forEach((def) => {
            const slot = slotOf(def.key, def);
            const raw = readSlot(slot);
            if (raw !== null) out[slot] = raw;
        });
        return out;
    },

    /**
     * 从备份恢复：按槽名匹配已注册定义后逐条写入，未识别的槽跳过。
     * @param {Record<string, string>} data snapshot() 的产物
     * @returns {{restored:number, skipped:string[]}} 恢复统计
     */
    restore(data) {
        let restored = 0;
        const skipped = [];
        Object.entries(data || {}).forEach(([slot, raw]) => {
            let hit = null;
            defs.forEach((def) => { if (slotOf(def.key, def) === slot) hit = def; });
            if (!hit) { skipped.push(slot); return; }
            const decoded = decode(hit.key, hit, raw);
            if (settings.set(hit.key, decoded, { source: "restore" }).ok) restored += 1;
        });
        return { restored, skipped };
    },

    /**
     * 存储占用概览，供设置面板与调试菜单显示。
     * @returns {{keys:number, bytes:number, degraded:boolean}} 统计
     */
    storage() {
        const slots = [...defs.values()].map((def) => slotOf(def.key, def));
        let bytes = 0;
        slots.forEach((slot) => {
            const raw = readSlot(slot);
            if (raw) bytes += slot.length + raw.length;
        });
        return { keys: slots.length, bytes, degraded: storageBroken };
    },

    /**
     * 存储槽名（供诊断与测试断言键名一致性）。
     * @param {string} key 设置键
     * @returns {string} 槽名：已注册定义取 `slot` 或点号转连字符，未注册键同样按推导返回
     */
    slot(key) {
        return slotOf(key, defOf(key));
    },
};

export { settings, KEY_PATTERN };

// 全局挂载：与 window.__dialog / __notify / __dock 同一风格，插件无需 import 即可调用。
globalThis.__settings = settings;
