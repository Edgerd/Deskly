/**
 * dev/settings-fulltest.mjs — 全量设置项可用性与持久化回归
 *
 * 和 settings-harness.mjs 的分工：harness 测的是「设置中枢与日志本身的行为」，
 * 本脚本测的是「每一条具体设置项」—— 遍历 settings.list() 的每一项做六类断言：
 *   1 默认值合法（在 values 内 / 在 min..max 内）
 *   2 写入 -> 存储槽里的原始文本正确（这一条等价于「刷新后还在」，因为刷新读的就是这段文本）
 *   3 读回值 === 写入值
 *   4 非法值被拒绝或按声明钳制，不会静默写坏
 *   5 reset 后回到默认
 *   6 存储槽名与 owner 模块历史上直接读取的 localStorage 键逐字一致（无迁移即无回归）
 * 另加两项跨模块一致性检查：槽名不得被两个非 jsonPath 键共用；每个 pane 字段必须在
 * 插件的 registry.js 里存在对应面板（否则设置项做完了却没有任何界面能改它）。
 *
 * 之所以用迷你 DOM 替身而不是浏览器：本项目的设置 owner 模块（appearance/cursor/
 * wallpaper/controlcenter…）在 Node 下只需 createElement + addEventListener 就能求值，
 * 而浏览器里 `?v=Date.now()` 的模块缓存策略会让「刷新后是否真的持久化」难以断言。
 *
 * 用法：`node dev/settings-fulltest.mjs`（全绿退出码 0）
 */

// ── 迷你 DOM 替身 ─────────────────────────────────────────────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.dataset = {};
        this.attrs = {};
        this._text = "";
        this.style = ((props) => ({
            cssText: "",
            setProperty: (name, value) => props.set(name, String(value)),
            getPropertyValue: (name) => (props.has(name) ? props.get(name) : ""),
            removeProperty: (name) => props.delete(name),
        }))(new Map());
        this.classList = { add() { }, remove() { }, toggle() { }, contains() { return false; } };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    appendChild(n) { this.children.push(n); return n; }
    append(...ns) { this.children.push(...ns); }
    remove() { }
    addEventListener() { }
    removeEventListener() { }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
}

const listeners = new Map();
const eventTarget = {
    addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
        const list = listeners.get(type);
        if (list) list.splice(list.indexOf(fn), 1);
    },
    dispatchEvent: (event) => {
        (listeners.get(event.type) || []).slice().forEach((fn) => fn(event));
        return true;
    },
};

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => { storageMap.set(k, String(v)); },
    removeItem: (k) => { storageMap.delete(k); },
    clear: () => storageMap.clear(),
};

const createdStyles = [];
globalThis.document = Object.assign(eventTarget, {
    documentElement: new FakeNode("html"),
    head: new FakeNode("head"),
    body: new FakeNode("body"),
    createElement: (tag) => {
        const node = new FakeNode(tag);
        if (tag === "style") createdStyles.push(node);
        return node;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createDocumentFragment: () => new FakeNode("fragment"),
    visibilityState: "visible",
});
globalThis.window = Object.assign(eventTarget, {
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener() { }, addListener() { } }),
    getComputedStyle: computedStyle,
});
globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; this.bubbles = !!opts.bubbles; }
};
// appearance.js / surface.js 会裸调 getComputedStyle 回读自定义属性（浏览器里它是全局函数，
// 不只挂在 window 上）。替身必须真的回读元素 style：返回空串会让「令牌是否写上了」
// 这类断言变成假红 —— 测不出写没写，就等于没测。
function computedStyle(el) {
    return {
        getPropertyValue: (name) => (el && el.style ? el.style.getPropertyValue(name) : ""),
        zIndex: "0",
    };
}
globalThis.getComputedStyle = computedStyle;
// Node 24 起 navigator 是只读 getter，只能整体重定义
Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node", storage: undefined, permissions: undefined, serviceWorker: undefined },
    configurable: true,
    writable: true,
});
globalThis.self = globalThis;
// 语言包 fetch 在 Node 里无法解析相对 URL：给它一个空壳响应，
// 免得「general.language 的 apply 调 i18n.setLanguage」在终端留下与本次断言无关的报错噪音，
// 真出问题时那行才看得见。blob()/FileReader 同理：cursor.js 取光标源图走的是这条链路，
// 缺了它会在断言全部通过之后抛一个纯环境造成的异步 rejection。
globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({}),
    text: async () => "",
    blob: async () => new ArrayBuffer(8),
});
globalThis.FileReader = class FileReader {
    readAsDataURL() { setTimeout(() => this.onload && this.onload({ target: { result: "data:image/svg+xml," } }), 0); }
};

// ── 断言工具 ──────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const notes = [];
function check(name, condition, detail) {
    if (condition) { passed += 1; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
/** 让出一帧：surface.js 把令牌写入合到 rAF/setTimeout 里，同步读会拿到旧值。 */
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** 深比较断言：设置值有布尔/数字/对象三种形态，用 === 会把 0.2 和 "0.2" 混为一谈。 */
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

const { settings } = await import("../src/javascripts/settings.js");
await import("../src/javascripts/log.js");
const { initSettingsSchema } = await import("../src/javascripts/settings-definitions.js");
initSettingsSchema();

/**
 * 新能力模块各自在自己文件里 define 设置项（owner 才是取值范围的权威）。
 * 这里逐个尝试 import + 调用其 init，成功就把它们的键并入同一轮遍历；
 * 失败不中断（本脚本的门禁对象是「已注册的每一项设置」，模块没落地时覆盖面自动收窄）。
 */
const EXTRA_KERNEL_MODULES = [
    { file: "../src/javascripts/sound.js", starter: "initSound" },
    { file: "../src/javascripts/display.js", starter: "initDisplay" },
    { file: "../src/javascripts/surface.js", starter: "initSurface" },
    { file: "../src/javascripts/lock.js", starter: "initLock" },
    { file: "../src/javascripts/spotlight.js", starter: "initSpotlight" },
    { file: "../src/javascripts/permissions.js", starter: "initPermissions" },
    { file: "../src/javascripts/default-apps.js", starter: "initDefaultApps" },
    { file: "../src/javascripts/debug.js", starter: "initDebug" },
];
const unavailable = [];
for (const entry of EXTRA_KERNEL_MODULES) {
    try {
        // 先取基数再 import：多数模块是在求值期就 settings.define 自己的键（owner 即权威），
        // 基数算晚了会把它们的登记读成 0 项。
        const before = settings.list().length;
        const mod = await import(entry.file);
        if (typeof mod[entry.starter] === "function") await mod[entry.starter]();
        const added = settings.list().length - before;
        notes.push(`${entry.file.split("/").pop()}：自注册 ${added} 个设置项`);
    } catch (err) {
        unavailable.push(`${entry.file.split("/").pop()}（${err.message.split("\n")[0]}）`);
    }
}
if (unavailable.length) notes.push(`未能纳入本轮遍历的模块：${unavailable.join("、")}`);

/** owner 模块历史上直接读取的键名；这里必须逐字吻合，否则升级后用户设置集体回退。 */
const LEGACY_SLOTS = {
    "appearance.theme": "appearance-theme",
    "appearance.accent": "appearance-accent",
    "appearance.highlight": "appearance-highlight",
    "appearance.sidebar.size": "appearance-sidebar-size",
    "appearance.wallpaper.tint": "appearance-wallpaper-tint",
    "appearance.scrollbars": "appearance-scrollbars",
    "appearance.scroll.click": "appearance-scroll-click",
    "general.language": "webstartos_language",
    "general.nativeContextMenu": "native-context-menu",
    "dock.autohide": "dock-autohide",
    "dock.zoom": "dock-zoom",
    "dock.size": "dock-size",
    "dock.position": "dock-position",
    "dock.zoom.amount": "dock-zoom-amount",
    "dock.show.indicators": "dock-show-indicators",
    "dock.show.recent": "dock-show-recent",
    "dock.order": "webstartos_dock_order",
    "dock.recents": "webstartos_dock_recents",
    "trash.icon": "trash-icon",
    "wallpaper.config": "wallpaper-config",
    "cursor.size": "cursor-size",
    "cursor.shadow": "cursor-shadow",
    "siri.orb.size": "siri-orb-size",
};

/** owner 读法是 `!== "off"` 的键，默认值必须是 true，否则「没动过设置的用户」会被翻转。 */
const DEFAULT_ON = ["dock.zoom", "dock.show.indicators", "dock.show.recent", "cursor.shadow", "appearance.transparency", "notify.enabled", "notify.sound", "debug.captureConsole", "debug.captureErrors", "debug.persist", "spotlight.apps", "spotlight.settings", "spotlight.files", "spotlight.commands", "spotlight.keepHistory", "keyboard.menuShortcuts"];
/** owner 读法是 `=== "on"` 的键，默认值必须是 false。 */
const DEFAULT_OFF = ["dock.autohide", "general.nativeContextMenu", "appearance.wallpaper.tint", "appearance.reduceMotion", "lock.requirePassword", "wallpaper.autoBing", "sound.muted", "display.nightShift", "display.nightShiftAuto"];

/** 挑一个与默认值不同的合法样本值（挑不出就返回默认值，由调用方跳过变更类断言）。 */
function sampleValue(def) {
    if (def.type === "boolean") return !def.default;
    if (def.type === "number") {
        const min = typeof def.min === "number" ? def.min : 0;
        const max = typeof def.max === "number" ? def.max : Math.max(min + 10, 10);
        const step = def.step || 1;
        for (let v = min; v <= max + 1e-9; v += step) {
            const candidate = Number(v.toFixed(6));
            if (candidate !== def.default) return candidate;
        }
        return def.default;
    }
    if (def.type === "json") {
        if (Array.isArray(def.default)) return [...def.default, "__probe__"];
        return { ...def.default, __probe__: 1 };
    }
    const values = def.values || [];
    if (!values.length) return "probe-value";
    return values.find((v) => String(v) !== String(def.default)) ?? values[0];
}

/** 期望落在存储里的原始文本（jsonPath 时返回它在 blob 里的形态）。 */
function expectedRaw(def, value) {
    if (def.type === "boolean") return value ? "on" : "off";
    if (def.type === "json") return JSON.stringify(value);
    return String(value);
}

const defs = settings.list();
check("定义表非空", defs.length > 0, `实得 ${defs.length}`);
notes.push(`共遍历 ${defs.length} 个设置项`);

const slotOwners = new Map();

for (const def of defs) {
    const label = def.key;
    const slot = settings.slot(def.key);
    // 「无存储值」必须真的从空存储开始：处理上一项时可能连带写了同一只 blob
    // （例如 controlcenter.airplane 的飞行模式互锁会把 wifi/蓝牙 一起关掉），
    // 不清空就会把正确的联动结果误读成「默认值被翻转」。
    storageMap.clear();

    // 1 默认值合法
    if (Array.isArray(def.values)) {
        check(`${label} 默认值在候选值内`, def.values.some((v) => String(v) === String(def.default)), `default=${JSON.stringify(def.default)} values=${JSON.stringify(def.values)}`);
    }
    if (def.type === "number") {
        const lo = typeof def.min === "number" ? def.default >= def.min : true;
        const hi = typeof def.max === "number" ? def.default <= def.max : true;
        check(`${label} 默认值在区间内`, lo && hi, `default=${def.default} range=${def.min}..${def.max}`);
    }
    check(`${label} 无存储值时读到默认值`, JSON.stringify(settings.get(def.key)) === JSON.stringify(def.default), `实得 ${JSON.stringify(settings.get(def.key))}`);

    // 6 存储槽与历史键一致
    if (LEGACY_SLOTS[def.key]) {
        check(`${label} 存储槽与历史键一致`, slot === LEGACY_SLOTS[def.key], `期望 ${LEGACY_SLOTS[def.key]} 实得 ${slot}`);
    }

    // 2/3 写入 -> 落盘文本 -> 读回
    const sample = sampleValue(def);
    const result = settings.set(def.key, sample, { source: "fulltest" });
    check(`${label} 合法写入成功`, result.ok === true, result.reason);
    const raw = storageMap.get(slot);
    if (def.jsonPath) {
        let blob = null;
        try { blob = JSON.parse(raw); } catch { /* 断言里报告 */ }
        const found = String(def.jsonPath).split(".").reduce((a, p) => (a && typeof a === "object" ? a[p] : undefined), blob);
        check(`${label} 写入命中 blob 的 ${def.jsonPath}`, JSON.stringify(found) === JSON.stringify(sample), `实得 ${JSON.stringify(found)}`);
    } else {
        check(`${label} 落盘文本正确`, raw === expectedRaw(def, sample), `期望 ${expectedRaw(def, sample)} 实得 ${JSON.stringify(raw)}`);
    }
    check(`${label} 读回等于写入值`, JSON.stringify(settings.get(def.key)) === JSON.stringify(sample), `实得 ${JSON.stringify(settings.get(def.key))}`);
    if (JSON.stringify(sample) !== JSON.stringify(def.default)) {
        check(`${label} 变更后 isDefault 为 false`, settings.isDefault(def.key) === false);
    }

    // 4 非法值：数字非数字 / 枚举外 / JSON 坏文本 必须被拒绝；越界数字必须被钳制
    if (def.type === "number") {
        check(`${label} 拒绝非数字`, settings.set(def.key, "abc", { source: "fulltest" }).ok === false);
        if (typeof def.max === "number") {
            const over = settings.set(def.key, def.max + 100000, { source: "fulltest" });
            check(`${label} 越界钳制到上限`, over.ok && over.value === def.max, `实得 ${over.value}`);
            if (typeof def.min === "number") {
                const under = settings.set(def.key, def.min - 100000, { source: "fulltest" });
                check(`${label} 越界钳制到下限`, under.ok && under.value === def.min, `实得 ${under.value}`);
            }
        }
    } else if (def.type === "string" && Array.isArray(def.values)) {
        check(`${label} 拒绝候选值外的字符串`, settings.set(def.key, "__not-a-value__", { source: "fulltest" }).ok === false);
    } else if (def.type === "json") {
        check(`${label} 拒绝坏 JSON 文本`, settings.set(def.key, "{oops", { source: "fulltest" }).ok === false);
    }

    // 5 reset 回到默认
    settings.reset(def.key, { source: "fulltest" });
    check(`${label} reset 后回到默认`, JSON.stringify(settings.get(def.key)) === JSON.stringify(def.default), `实得 ${JSON.stringify(settings.get(def.key))}`);

    // 槽名唯一性（jsonPath 键按设计共享一个 blob 槽，排除在外）
    if (!def.jsonPath) {
        if (slotOwners.has(slot)) check(`槽名 ${slot} 未被两个键共用`, false, `${slotOwners.get(slot)} 与 ${def.key} 冲突`);
        else slotOwners.set(slot, def.key);
    }
}

// ── 默认方向与 owner 读法一致 ─────────────────────────────────────────────
DEFAULT_ON.forEach((key) => {
    const def = settings.info(key);
    if (def) check(`${key} 默认为 true（owner 读法是 !== "off"）`, def.default === true, `实得 ${JSON.stringify(def.default)}`);
    else notes.push(`${key} 未在定义表里（可能由其它模块自注册）`);
});
DEFAULT_OFF.forEach((key) => {
    const def = settings.info(key);
    if (def) check(`${key} 默认为 false（owner 读法是 === "on"）`, def.default === false, `实得 ${JSON.stringify(def.default)}`);
});

// ── 旧事件兼容：detail 必须是 owner 现读法能直接用的字符串形态 ────────────
const seenEvents = {};
["dock-size-change", "dock-autohide-change", "dock-position-change", "dock-zoom-amount-change", "siri-orb-size-change", "trash-icon-change"].forEach((name) => {
    window.addEventListener(name, (e) => { seenEvents[name] = e.detail; });
});
settings.set("dock.size", 96, { source: "fulltest" });
settings.set("dock.autohide", true, { source: "fulltest" });
settings.set("dock.position", "left", { source: "fulltest" });
settings.set("dock.zoom.amount", 2.4, { source: "fulltest" });
settings.set("siri.orb.size", 222, { source: "fulltest" });
settings.set("trash.icon", "dark_full", { source: "fulltest" });
check("dock-size-change detail 为字符串", seenEvents["dock-size-change"] === "96", `实得 ${JSON.stringify(seenEvents["dock-size-change"])} (${typeof seenEvents["dock-size-change"]})`);
check("dock-autohide-change detail 为 on/off", seenEvents["dock-autohide-change"] === "on", `实得 ${JSON.stringify(seenEvents["dock-autohide-change"])}`);
check("dock-position-change detail 为位置串", seenEvents["dock-position-change"] === "left");
check("dock-zoom-amount-change detail 可被 parseFloat", parseFloat(seenEvents["dock-zoom-amount-change"]) === 2.4, `实得 ${JSON.stringify(seenEvents["dock-zoom-amount-change"])}`);
check("siri-orb-size-change detail 是数字（siri 侧按数字读）", seenEvents["siri-orb-size-change"] === "222" || seenEvents["siri-orb-size-change"] === 222, `实得 ${JSON.stringify(seenEvents["siri-orb-size-change"])}`);
check("trash-icon-change detail 是变体键", seenEvents["trash-icon-change"] === "dark_full", `实得 ${JSON.stringify(seenEvents["trash-icon-change"])}`);

// ── 定义里的 apply 都能真的生效（调用不抛错，且 DOM/存储有变化） ──────────
const throwing = [];
defs.forEach((def) => {
    if (typeof def.apply !== "function") return;
    try { def.apply(def.default, { previous: def.default, persisted: true, source: "fulltest" }); }
    catch (err) { throwing.push(`${def.key}: ${err.message}`); }
});
check("所有 apply 生效函数可调用", throwing.length === 0, throwing.join(" / "));

// ── 界面元数据完整：pane 必须能在插件注册表里找到，控件名必须在组件层支持 ──
const { PANES } = await import("../mods/system-settings/registry.js");
const paneIds = new Set(PANES.filter((p) => p.implemented).map((p) => p.id));
const SUPPORTED_CONTROLS = new Set(["switch", "slider", "dropdown", "segmented", "radio", "cards", "swatches", "json", "text"]);
defs.forEach((def) => {
    if (def.hidden) return;
    if (def.pane) check(`${def.key} 的面板在注册表里已实现`, paneIds.has(def.pane), `pane=${def.pane} 不在已实现面板 ${[...paneIds].join(",")} 中`);
    if (def.control && def.control !== "json") {
        check(`${def.key} 的控件类型有对应组件`, SUPPORTED_CONTROLS.has(def.control), `control=${def.control}`);
    }
    if (!def.hidden && def.control && def.control !== "json") {
        check(`${def.key} 有中文标签`, typeof def.label === "string" && def.label.length > 0);
    }
});
// 只有「声明了界面控件」的定义才必须有面板归属；
// 像 store.disabled（type json，无 control / label）这类纯意图记录本来就不该出现在界面上。
const unrendered = defs.filter((d) => !d.hidden && d.control && d.control !== "json" && !d.pane);
check("带控件的设置项都归属某个面板", unrendered.length === 0, unrendered.map((d) => d.key).join(", "));

// ── 日志项与设置项共存：debug.* 必须齐全（调试面板依赖它们） ──────────────
["debug.logLevel", "debug.captureConsole", "debug.captureErrors", "debug.bufferSize", "debug.persist", "debug.persistCount"]
    .forEach((key) => check(`日志设置项 ${key} 已注册`, settings.has(key)));

// ── 老用户零迁移：用「重写前」的写法预置存储，新接口必须逐条读回 ──────────
// 这是本次改造最大的隐性风险：设置中枢换了键名或值形态，用户一升级就集体回退。
// 下面这份种子数据完全照旧代码的写法（裸键名 + on/off + 字符串数字 + CC 整块 JSON），
// 等价于「升级后第一次打开」时 localStorage 里真实存在的东西。
const LEGACY_SEED = {
    "appearance-theme": "dark",
    "appearance-accent": "green",
    "appearance-sidebar-size": "small",
    "appearance-scrollbars": "always",
    "cursor-size": "48",
    "cursor-shadow": "off",
    "dock-size": "64",
    "dock-autohide": "on",
    "dock-zoom": "off",
    "dock-position": "left",
    "dock-zoom-amount": "2.4",
    "dock-show-indicators": "off",
    "dock-show-recent": "off",
    "trash-icon": "dark_full",
    "native-context-menu": "on",
    "webstartos_language": "en",
    "siri-orb-size": "220",
    "wallpaper-config": '{"type":"network","url":"https://example.com/a.jpg"}',
    "webstartos_dock_order": '["访达","启动台","系统设置"]',
    "webstartos_controlcenter": '{"wifi":false,"bluetooth":true,"airdrop":false,"airplane":false,"focus":false,"focusMode":"personal","stage":true,"mirroring":false,"displayBrightness":0.4,"volume":0.2,"volumeMuted":true}',
};
storageMap.clear();
Object.entries(LEGACY_SEED).forEach(([slot, value]) => storageMap.set(slot, value));

const LEGACY_READS = {
    "appearance.theme": "dark",
    "appearance.accent": "green",
    "appearance.sidebar.size": "small",
    "appearance.scrollbars": "always",
    "cursor.size": 48,
    "cursor.shadow": false,
    "dock.size": 64,
    "dock.autohide": true,
    "dock.zoom": false,
    "dock.position": "left",
    "dock.zoom.amount": 2.4,
    "dock.show.indicators": false,
    "dock.show.recent": false,
    "trash.icon": "dark_full",
    "general.nativeContextMenu": true,
    "general.language": "en",
    "siri.orb.size": 220,
    "dock.order": ["访达", "启动台", "系统设置"],
    "controlcenter.wifi": false,
    "controlcenter.bluetooth": true,
    "controlcenter.focus": false,
    "controlcenter.focusMode": "personal",
    "controlcenter.stage": true,
    "sound.master": 0.2,
    "sound.muted": true,
    "display.brightness": 0.4,
};
Object.entries(LEGACY_READS).forEach(([key, expected]) => {
    if (!settings.info(key)) { notes.push(`老键 ${key} 尚未注册定义（模块未落地），本轮跳过`); return; }
    eq(`老用户零迁移：${key}`, settings.get(key), expected);
});
const legacyWallpaper = settings.get("wallpaper.config");
check("老用户零迁移：wallpaper.config 保留自定义地址", legacyWallpaper?.type === "network" && legacyWallpaper?.url === "https://example.com/a.jpg", JSON.stringify(legacyWallpaper));

// 从未写过的「默认开启」键，缺槽时必须仍是 true（owner 的 !== "off" 读法）
storageMap.clear();
["dock.zoom", "dock.show.indicators", "dock.show.recent", "cursor.shadow", "appearance.transparency", "notify.enabled"].forEach((key) => {
    if (settings.has(key)) check(`${key} 空存储时仍为 true（对应 owner 的 !=="off" 默认开启读法）`, settings.get(key) === true, `实得 ${JSON.stringify(settings.get(key))}`);
});
["dock.autohide", "general.nativeContextMenu", "appearance.wallpaper.tint", "lock.requirePassword", "sound.muted"].forEach((key) => {
    if (settings.has(key)) check(`${key} 空存储时仍为 false（对应 owner 的 ==="on" 默认关闭读法）`, settings.get(key) === false, `实得 ${JSON.stringify(settings.get(key))}`);
});
check("空存储时控制中心卡片字段回到默认", settings.get("controlcenter.wifi") === true && settings.get("display.brightness") === 0.85,
    `wifi=${settings.get("controlcenter.wifi")} brightness=${settings.get("display.brightness")}`);
storageMap.clear();

// ── 表面系统：模糊等级 + 强制黑白可读文字 ─────────────────────────────────
const surfaceMod = await import("../src/javascripts/surface.js");
const surface = surfaceMod.surface;

// 模糊等级：只允许 0–4，越界必须被钳制（等级直接乘进所有表面的采样成本）
check("appearance.blurLevel 已注册", settings.has("appearance.blurLevel"));
const levelDef = settings.info("appearance.blurLevel");
eq("模糊等级默认标准档", levelDef.default, 3);
eq("模糊等级越上界钳制", settings.set("appearance.blurLevel", 99, { source: "fulltest" }).value, 4);
eq("模糊等级越下界钳制", settings.set("appearance.blurLevel", -5, { source: "fulltest" }).value, 0);
settings.set("appearance.blurLevel", 3, { source: "fulltest" });
// 令牌写入是 rAF/setTimeout 合帧的（连点开关只算一次），断言前必须让出事件循环
settings.set("appearance.blurLevel", 0, { source: "fulltest" });
await tick();
eq("等级 0 时 data-blur 落地为 0", document.documentElement.dataset.blur, "0");
check("等级 0 时四档全部算成 0px", ["--surface-blur-1", "--surface-blur-4"].every((n) => document.documentElement.style.getPropertyValue(n) === "0px"),
    `实得 ${document.documentElement.style.getPropertyValue("--surface-blur-4")}`);
settings.set("appearance.blurLevel", 3, { source: "fulltest" });
await tick();
check("token() 只产出 1–5 档引用", surface.token(2) === "var(--surface-blur-2)" && surface.token(99) === "var(--surface-blur-5)" && surface.token(0) === "var(--surface-blur-1)" && surface.token() === "var(--surface-blur-3)");
eq("阶梯共五档", surface.stats().roles, 5);

// 色调子参数必须挂在着色开关下，否则界面会出现「拨了没反应」的假设置
["appearance.tintStrength", "appearance.tintHue"].forEach((key) => {
    const def = settings.info(key);
    check(`${key} 已注册`, Boolean(def));
    eq(`${key} 声明 requires 着色开关`, def && def.requires, "appearance.wallpaper.tint");
});

// 文字色：只允许黑或白，且必须取 WCAG 对比度赢家
const INK = new Set(["#000", "#fff"]);
[
    ["#000000", "#fff"], ["#0a0f1e", "#fff"], ["#1e1e1e", "#fff"], ["#2b2b31", "#fff"],
    ["#ffffff", "#000"], ["#f5f5f7", "#000"], ["#e8e8e8", "#000"], ["#6b7c93", "#000"],
    // #808080 上黑字对比 5.32、白字 3.95 —— 50% 灰按 WCAG 归黑，白字要到 #404040 才反超。
    ["#808080", "#000"], ["#404040", "#fff"], ["#9aa0a6", "#000"],
].forEach(([bg, expect]) => eq(`文字色 ${bg} → ${expect}`, surface.textColorFor(bg), expect));
["#000000", "#ffffff", "#808080", "#123456", "rgb(30,30,30)", [255, 170, 90]].forEach((bg) => {
    check(`textColorFor 只输出纯黑白（${JSON.stringify(bg)}）`, INK.has(surface.textColorFor(bg)), `实得 ${surface.textColorFor(bg)}`);
});

// 有效底色必须真的随壁纸着色/浓度/色相/主题/亮度变化 —— 「实时」不是口号
const baseOf = (mutate) => { mutate(); return surface.effectiveBase().rgb.join(","); };
const neutralLight = baseOf(() => { });
settings.set("appearance.theme", "dark", { source: "fulltest" });
document.documentElement.dataset.themeResolved = "dark";
const neutralDark = baseOf(() => { });
check("深色主题底色确实更暗", surface.effectiveBase().rgb.every((v) => v <= 60), neutralDark);
check("主题切换改变了有效底色", neutralDark !== neutralLight, `${neutralLight} vs ${neutralDark}`);
settings.set("appearance.theme", "light", { source: "fulltest" });
document.documentElement.dataset.themeResolved = "light";

const noTint = baseOf(() => { });
settings.set("appearance.wallpaper.tint", true, { source: "fulltest" });
document.documentElement.style.setProperty("--wallpaper-tint-rgb", "200, 60, 60");
const tinted = baseOf(() => { });
check("打开着色后有效底色随壁纸主色改变", tinted !== noTint, `${noTint} vs ${tinted}`);
settings.set("appearance.tintStrength", 0, { source: "fulltest" });
const zeroStrength = baseOf(() => { });
check("浓度归零等价于不着色", zeroStrength === noTint, `${noTint} vs ${zeroStrength}`);
settings.set("appearance.tintStrength", 1, { source: "fulltest" });
settings.set("appearance.tintHue", 45, { source: "fulltest" });
const hueShifted = baseOf(() => { });
check("色调偏移确实改变底色", hueShifted !== tinted, `${tinted} vs ${hueShifted}`);
settings.set("appearance.tintHue", 0, { source: "fulltest" });

// 文字色推导必须跟着底色走：暗壁纸（着色开）→ 白字；亮壁纸 → 黑字。
// 判定对象是 --surface-text-wallpaper（背后就是墙纸的那类表面）：--surface-text 走的是
// 主题面板色，浅色主题下菜单永远是浅底黑字，拿它断言「暗壁纸白字」必然假失败。
document.documentElement.style.setProperty("--wallpaper-tint-rgb", "20, 24, 30");
surface.refresh();
eq("暗壁纸着色下用白字", surface.currentTextColor("wallpaper"), "#fff");
// 这一条是回归锁：曾经全局 --surface-text 直接拿墙纸底色推导，于是「浅色主题 + 开着色 +
// 深色壁纸」给菜单/弹层推出白字压在浅面板上（实测 107 个文字节点里 95 个掉到 3:1 以下）。
// 菜单不吃墙纸色，所以全局档必须留在黑字，只有墙纸档翻白。
eq("暗壁纸 + 开着色时浅色主题的菜单仍浅底黑字", surface.currentTextColor("panel"), "#000");
check("墙纸档底色确实压得很暗", surface.stats().wallpaperBase.split(",").every((v) => Number(v.trim()) <= 40), surface.stats().wallpaperBase);
document.documentElement.style.setProperty("--wallpaper-tint-rgb", "235, 240, 245");
surface.refresh();
eq("亮壁纸着色下用黑字", surface.currentTextColor("wallpaper"), "#000");
eq("浅色主题的菜单表面仍是浅底黑字", surface.currentTextColor("panel"), "#000");

// <html> 上必须真的写了这些令牌（样式表全靠它们，缺一个就是静默无效果）
surface.refresh();
const rootStyle = document.documentElement.style;
["--surface-blur-unit", "--surface-blur-1", "--surface-blur-4", "--surface-text", "--tint-strength"]
    .forEach((name) => check(`令牌 ${name} 已写入 <html>`, String(rootStyle.getPropertyValue(name)).length > 0, `实得「${rootStyle.getPropertyValue(name)}」`));
check("stats() 报告对比度双值", surface.stats().contrastWhite > 0 && surface.stats().contrastBlack > 0, JSON.stringify(surface.stats()));
let notified = 0;
const offSub = surface.subscribe(() => { notified += 1; });
settings.set("appearance.blurLevel", 2, { source: "fulltest" });
await tick();
offSub();
settings.set("appearance.blurLevel", 3, { source: "fulltest" });
await tick();
check("subscribe 已接通（等级变化会回调）", notified >= 1, `实得 ${notified}`);

// ── 收尾 ─────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项断言。`);
notes.forEach((n) => console.log(`  · ${n}`));
if (failures.length) {
    console.log(`\n失败 ${failures.length} 项：`);
    [...new Set(failures)].forEach((f) => console.log("  ✗ " + f));
    process.exit(1);
}
console.log("全量设置项断言通过 ✓");
// 必须显式退出：display.js 的自动护眼定时器与 lock.js 的空闲锁屏计时器都是 setInterval，
// 在浏览器里正常，在 Node 里会让事件循环永不结束（脚本会「跑完但不停」。
process.exit(0);
