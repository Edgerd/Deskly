/**
 * dev/settings-harness.mjs — 设置中枢与日志系统的 Node 校验脚本
 *
 * 为什么不用浏览器跑：本项目以 MV3 扩展页形态交付，`chrome-extension://` 下的
 * localStorage / 视口 / Service Worker 行为与 http 页面不一致，且模块 URL 带
 * `?v=Date.now()`，浏览器里很难断言「刷新后是否真的持久化」。
 * settings.js 与 log.js 是纯逻辑模块（只碰 localStorage / addEventListener / CustomEvent），
 * 用最小替身就能在 Node 里做真断言，CI 与本地都零依赖。
 *
 * 用法：`node dev/settings-harness.mjs`（全绿退出码 0，任何失败退出码 1）
 */

// ── 浏览器替身 ────────────────────────────────────────────────────────────
const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
    clear: () => storage.clear(),
};

const listeners = new Map();
function targetStub() {
    return {
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
}
globalThis.window = Object.assign(targetStub(), { matchMedia: () => ({ matches: false, addEventListener() { } }) });
globalThis.document = Object.assign(targetStub(), {
    documentElement: { dataset: {}, style: { setProperty() { } }, setAttribute() { } },
    addEventListener: globalThis.window.addEventListener,
});
globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; this.bubbles = !!opts.bubbles; }
};

// ── 断言工具 ──────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function check(name, condition, extra) {
    if (condition) { passed += 1; return; }
    failures.push(`${name}${extra === undefined ? "" : ` — 实得 ${JSON.stringify(extra)}`}`);
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

const { settings } = await import("../src/javascripts/settings.js");
const { log } = await import("../src/javascripts/log.js");

/** 捕获指定事件的最近一次 detail，用于断言旧事件兼容。 */
const lastEvent = {};
window.addEventListener("dock-size-change", (e) => { lastEvent["dock-size-change"] = e.detail; });
window.addEventListener("dock-autohide-change", (e) => { lastEvent["dock-autohide-change"] = e.detail; });
let changed = null;
document.addEventListener("settings-changed", (e) => { changed = e.detail; });

// ── 1. 键名 -> 存储槽 约定 ────────────────────────────────────────────────
settings.define({ key: "dock.size", type: "number", default: 50, min: 32, max: 128, step: 2, event: "dock-size-change" });
settings.define({ key: "dock.zoom", type: "boolean", default: true, event: "dock-zoom-change" });
settings.define({ key: "dock.zoom.amount", type: "number", default: 1.8, min: 1.1, max: 3, step: 0.1 });
eq("槽名：点号转连字符", settings.slot("dock.zoom.amount"), "dock-zoom-amount");
eq("槽名：显式 slot 覆盖", settings.define({ key: "general.language", slot: "webstartos_language", type: "string", default: "zh-CN" }).slot, "webstartos_language");
check("非法键名被拒绝", settings.define({ key: "badkey", default: 1 }) === null);

// ── 2. 默认值与历史「默认开启」语义 ───────────────────────────────────────
eq("无存储值时取默认", settings.get("dock.size"), 50);
eq("默认开启项（dock.zoom 缺值 = true）", settings.get("dock.zoom"), true);
storage.set("dock-zoom", "off");
eq("历史键显式 off 被识别（dock.js 的 !== 'off' 语义）", settings.get("dock.zoom"), false);
storage.set("dock-zoom", "nonsense");
eq("无效存储值回退默认并留日志", settings.get("dock.zoom"), true);
check("无效值确实进了日志", log.query({ contains: "无效" }).length > 0);

// ── 3. 写入：类型校验 / 钳制 / 拒绝 ───────────────────────────────────────
check("写入合法数值", settings.set("dock.size", 64, { source: "test" }).ok);
eq("写入后落盘形态", storage.get("dock-size"), "64");
eq("旧事件按字符串 detail 补发", lastEvent["dock-size-change"], "64");
check("统一变更事件已派发", changed && changed.key === "dock.size" && changed.value === 64);
const clamped = settings.set("dock.size", 500, { source: "test" });
eq("超界数值被钳制到上限", clamped.value, 128);
eq("钳制后写入存储", storage.get("dock-size"), "128");
check("非数字被拒绝", settings.set("dock.size", "abc", { source: "test" }).ok === false);
settings.define({ key: "appearance.theme", type: "string", default: "light", values: ["light", "dark", "auto"] });
const rejected = settings.set("appearance.theme", "neon", { source: "test" });
check("候选值外的写入被拒绝", rejected.ok === false && rejected.reason.includes("不在候选值"));
check("拒绝值被日志记为 error", log.query({ level: "error", contains: "appearance.theme" }).length > 0);
eq("拒绝后保持原值", settings.get("appearance.theme"), "light");

// ── 4. 布尔序列化与 owner 兼容 ────────────────────────────────────────────
settings.define({ key: "dock.autohide", type: "boolean", default: false, event: "dock-autohide-change" });
settings.set("dock.autohide", true, { source: "test" });
check("布尔写入存储为 on/off", storage.get("dock-autohide") === "on");
eq("布尔旧事件 detail 为字符串", lastEvent["dock-autohide-change"], "on");
settings.set("dock.autohide", false, { source: "test" });
eq("布尔关闭写 off（owner 的 === 'on' 读法兼容）", lastEvent["dock-autohide-change"], "off");

// ── 5. jsonPath：多个设置共用一个 JSON 槽 ─────────────────────────────────
storage.set("webstartos_controlcenter", JSON.stringify({ volume: 0.65, nowPlaying: { song: "A", playing: true } }));
settings.define({ key: "controlcenter.volume", slot: "webstartos_controlcenter", jsonPath: "volume", type: "number", default: 0.65, min: 0, max: 1 });
settings.define({ key: "controlcenter.nowPlaying.song", slot: "webstartos_controlcenter", jsonPath: "nowPlaying.song", type: "string", default: "" });
eq("嵌套字段读取", settings.get("controlcenter.nowPlaying.song"), "A");
settings.set("controlcenter.volume", 0.3, { source: "test" });
settings.set("controlcenter.nowPlaying.song", "B", { source: "test" });
const blob = JSON.parse(storage.get("webstartos_controlcenter"));
eq("嵌套字段写回同一槽", blob.nowPlaying.song, "B");
eq("同槽另一字段未被覆盖", blob.volume, 0.3);
eq("同槽既有字段保留", blob.nowPlaying.playing, true);

// ── 6. reset / isDefault / list / snapshot ────────────────────────────────
check("isDefault 判定", settings.isDefault("dock.zoom") === true);
storage.set("dock-zoom", "off");
check("改动后 isDefault 为 false", settings.isDefault("dock.zoom") === false);
settings.reset("dock.zoom", { source: "test" });
check("reset 删除存储槽", !storage.has("dock-zoom"));
eq("reset 回到默认", settings.get("dock.zoom"), true);
const snap = settings.snapshot();
check("snapshot 收集到已注册槽", snap["dock-size"] === "128");
const restored = settings.restore({ "dock-size": "70", "unknown-slot": "x" });
eq("restore 命中项数", restored.restored, 1);
eq("restore 跳过未识别槽", restored.skipped, ["unknown-slot"]);
eq("restore 后取值", settings.get("dock.size"), 70);
check("list 返回带值与元数据", settings.list({ prefix: "dock." }).every((d) => "value" in d));

// ── 7. 未注册裸键（插件未 define 也能读写） ───────────────────────────────
settings.set("office.showRuler", true, { source: "test" });
eq("裸键按推导槽落盘", storage.get("office-showRuler"), "true");
eq("裸键读回", settings.get("office.showRuler"), true);
eq("裸键缺失时回退入参", settings.get("office.nope", "fallback"), "fallback");

// ── 8. 订阅 / 单键订阅 / 退订 ─────────────────────────────────────────────
let hits = 0;
const off = settings.on("dock.size", () => { hits += 1; });
settings.set("dock.size", 80, { source: "test" });
settings.set("dock.size", 80, { source: "test" });
eq("同值写入不重复广播（changed=false 分支）", hits, 1);
off();
settings.set("dock.size", 90, { source: "test" });
eq("退订后不再回调", hits, 1);

// ── 9. 存储降级：localStorage 抛错时不阻塞生效 ────────────────────────────
const realSetItem = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
const degraded = settings.set("dock.size", 100, { source: "test" });
eq("配额异常仍返回 ok", degraded.ok, true);
eq("配额异常标记未落盘", degraded.persisted, false);
globalThis.localStorage.setItem = realSetItem;

// ── 10. 日志系统 ──────────────────────────────────────────────────────────
log.clear();
log.info("dock", "来自裸名的 info");
log.error("plugin/siri", "来自显式分类的 error");
console.warn("[notepad] 既有 console 调用被自动归档");
console.error("[vfs] 配额不足", new Error("boom"));
check("裸内核模块名归类到 kernel/", log.stats().bySource["kernel/dock"] === 1);
check("已注册插件裸名归类到 plugin/", log.stats().bySource["plugin/notepad"] === 1);
check("console.error 的参数对象被序列化", log.query({ level: "error", contains: "配额不足" })[0].data.includes("boom"));
log.debug("dock", "低于门槛不记录");
check("门槛过滤 debug", log.query({ level: "debug" }).length === 0);
log.setLevel("debug");
log.debug("dock", "门槛放开后记录");
check("门槛放开后 debug 入档", log.query({ level: "debug" }).length === 1);
log.setLevel("warn");
log.debug("dock", "又被过滤");
check("改回 warn 后 debug 不入档", log.query({ level: "debug" }).length === 1);
check("门槛设置持久化到 debug-logLevel 槽", storage.get("debug-logLevel") === "warn");
log.setLevel("info");
const child = log.for("safari");
child.warn("子日志器绑定来源");
check("log.for 绑定来源", log.stats().bySource["plugin/safari"] === 1 && child.source === "plugin/safari");
check("query 支持按来源 + 级别过滤", log.query({ level: "warn", source: "plugin/safari" }).length === 1);
const exported = log.exportText({ level: "error" });
check("导出文本含级别与来源标记", /\[ERROR\] plugin\/siri/.test(log.exportText({ level: "error", source: "siri" })) && exported.includes("Deskly 运行日志"));
let live = 0;
const unsub = log.subscribe(() => { live += 1; });
log.info("dock", "订阅推送");
unsub();
log.info("dock", "退订后不再推送");
eq("订阅推送与退订", live, 1);
log.flush();
check("日志缓冲已落盘", (storage.get("deskly-log-buffer") || "").startsWith("["));
const persistedCount = JSON.parse(storage.get("deskly-log-buffer")).length;
check("落盘条数受 persistCount 限制", persistedCount <= settings.get("debug.persistCount"));
check("stats 报告容量与丢弃计数", log.stats().capacity > 0 && "dropped" in log.stats());
const timed = log.timer("测试计时");
check("timer 返回耗时数字", typeof timed.stop("阶段") === "number");

// ── 11. 环形缓冲上限 ──────────────────────────────────────────────────────
settings.set("debug.bufferSize", 100, { source: "test" });
for (let i = 0; i < 250; i += 1) log.info("stress", `压力条目 ${i}`);
check("缓冲不越过容量", log.count() <= 100);
check("超出部分计入 dropped", log.stats().dropped > 0);
log.clear();
eq("clear 清空缓冲", log.count() <= 1, true);

// ── 收尾 ─────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项断言。`);
if (failures.length) {
    console.log(`\n失败 ${failures.length} 项：`);
    failures.forEach((f) => console.log("  ✗ " + f));
    process.exit(1);
}
console.log("全部断言通过 ✓");
