/**
 * dev/spotlight-probe.mjs — 聚焦重构探针（Node，无浏览器）
 *
 * 覆盖：
 *   1. 快捷键判定：⌥Space（含 macOS nbsp）、⌃⇧Space、⌃⌘Space、⌘Space、⌃Space、off，
 *      修饰键严格相等、repeat 拒绝、Spacebar/code 兜底、错修饰键拒绝；
 *   2. Provider 引擎：注册/注销/列表、错误隔离（一家抛错不空白）、AbortSignal 取消、
 *      emit 流式、分组排序（calculation 在 app 前）；
 *   3. 计算器 provider（真模块）：算术、函数、换算、货币（含汇率快照标注）、防误吞；
 *   4. 日期 provider：中英自然表达；
 *   5. 惰性索引：未查询不构建、TTL 失效、手动失效；
 *   6. 可见性 API：getAppVisibility 默认/覆盖/system 强制、isUninstallable、
 *      setPluginEnabled 系统应用拒绝禁用；
 *   7. 集成：initSpotlight 幂等 + 插件 manifest 发现计算器 provider 后 searchAll 出结果。
 *
 * 用法：node dev/spotlight-probe.mjs（失败退出码 1）
 */

import { readFileSync } from "node:fs";

const results = [];
const check = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

// ---- 最小 DOM / 环境桩（必须先于一切模块 import） ----

const docListeners = new Map();
const winListeners = new Map();
const addTo = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
};

function makeElement() {
    const el = {
        children: [],
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        appendChild(...nodes) { el.children.push(...nodes); return nodes[0]; },
        append(...nodes) { el.children.push(...nodes); },
        remove() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        focus() {},
        scrollIntoView() {},
    };
    return el;
}

const documentStub = {
    addEventListener: addTo(docListeners),
    removeEventListener() {},
    dispatchEvent(event) {
        (docListeners.get(event.type) || []).forEach((fn) => fn(event));
        return true;
    },
    createElement: () => makeElement(),
    createTextNode: (text) => ({ text }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: makeElement(),
    body: makeElement(),
    documentElement: { dataset: {} },
};

const storage = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = addTo(winListeners);
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = (event) => {
    (winListeners.get(event.type) || []).forEach((fn) => fn(event));
    return true;
};
globalThis.document = documentStub;
globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.__log = { warn() {}, info() {}, error() {}, debug() {} };

// ---- 动态 import（桩就位后） ----

const engine = await import("../mods/spotlight/engine.js");
const { createIndex } = await import("../mods/spotlight/index.js");
const script = await import("../mods/spotlight/script.js");
const calcProvider = (await import("../mods/calculator/spotlight-provider.js")).provider;
const { parseNaturalDate } = await import("../mods/spotlight/providers/datetime.js");
const registry = await import("../src/javascripts/app-registry.js");

// ── 1 快捷键判定 ──────────────────────────────────────────────
{
    const m = script.hotkeyMatches;
    const ev = (init) => ({ key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...init });
    check("⌥Space 命中（alt）", m("alt+space", ev({ altKey: true })));
    check("⌥Space 拒绝多余修饰（alt+ctrl）", !m("alt+space", ev({ altKey: true, ctrlKey: true })));
    check("⌥Space 兼容 macOS nbsp（U+00A0）", m("alt+space", ev({ key: " ", altKey: true })));
    check("⌥Space 兼容 Spacebar 旧键名", m("alt+space", ev({ key: "Spacebar", code: "", altKey: true })));
    check("⌥Space 兼容 code=Space（key 缺失）", m("alt+space", ev({ key: "Unidentified", altKey: true })));
    check("⌥Space 拒绝普通空格（无修饰）", !m("alt+space", ev({})));
    check("⌃⇧Space 命中（ctrl+shift）", m("ctrl+shift+space", ev({ ctrlKey: true, shiftKey: true })));
    check("⌃⇧Space 拒绝缺 shift", !m("ctrl+shift+space", ev({ ctrlKey: true })));
    check("⌃⌘Space 命中（ctrl+meta）", m("ctrl+meta+space", ev({ ctrlKey: true, metaKey: true })));
    check("⌃⌘Space 拒绝只有 meta", !m("ctrl+meta+space", ev({ metaKey: true })));
    check("⌘Space 命中（meta）", m("cmd+space", ev({ metaKey: true })));
    check("⌃Space 命中（ctrl）", m("ctrl+space", ev({ ctrlKey: true })));
    check("off 永不命中", !m("off", ev({ altKey: true })));
    check("repeat 拒绝", !m("alt+space", ev({ altKey: true, repeat: true })));
    check("未知 spec 拒绝", !m("win+space", ev({ metaKey: true })));
}

// ── 2 Provider 引擎 ──────────────────────────────────────────
{
    const good = { id: "t-good", group: "app", weight: 50, types: ["app"], search: () => [{ type: "app", label: "Alpha", score: 1 }] };
    const bad = { id: "t-bad", group: "app", types: ["app"], search: () => { throw new Error("boom"); } };
    const calc = { id: "t-calc", group: "calculation", types: ["calculation"], search: () => [{ type: "calculation", label: "1+1=2", score: 0 }] };

    const un1 = engine.registerSpotlightProvider(good);
    engine.registerSpotlightProvider(bad);
    engine.registerSpotlightProvider(calc);

    const list = engine.listSpotlightProviders();
    check("注册后列表含三家", ["t-good", "t-bad", "t-calc"].every((id) => list.some((p) => p.id === id)));

    const outcome = await engine.runSpotlightQuery("a");
    check("错误隔离：坏 provider 不拖垮搜索", outcome.results.some((r) => r.label === "Alpha"));
    check("错误隔离：failures 记下坏 provider", outcome.failures.some((f) => f.id === "t-bad"));
    check("分组排序：calculation 排在 app 前", outcome.results[0].group === "calculation");

    // 取消：慢 provider + 立即 abort → 结果为空且标记 aborted
    const slow = { id: "t-slow", group: "app", types: ["app"], search: () => new Promise((resolve) => setTimeout(() => resolve([{ type: "app", label: "Slow" }]), 120)) };
    const un2 = engine.registerSpotlightProvider(slow);
    const controller = new AbortController();
    const pending = engine.runSpotlightQuery("a", { signal: controller.signal, only: new Set(["t-slow"]) });
    controller.abort();
    const aborted = await pending;
    check("AbortSignal 取消：迟到结果被丢弃", aborted.aborted === true && aborted.results.length === 0);

    // 流式：emit 的部分结果走 onPartial
    const streaming = {
        id: "t-stream", group: "app", types: ["app"],
        search: (ctx) => { ctx.emit([{ type: "app", label: "Partial" }]); return [{ type: "app", label: "Final" }]; },
    };
    const un3 = engine.registerSpotlightProvider(streaming);
    const partials = [];
    const streamed = await engine.runSpotlightQuery("a", { only: new Set(["t-stream"]), onPartial: (items) => partials.push(items.map((i) => i.label).join()) });
    check("emit 流式：onPartial 收到部分结果", partials.some((labels) => labels.includes("Partial")));
    check("流式最终结果含 Final", streamed.results.some((r) => r.label === "Final"));

    un1(); un2(); un3();
    check("注销函数生效", !engine.listSpotlightProviders().some((p) => p.id === "t-good"));
    engine.unregisterSpotlightProvider("t-bad");
    engine.unregisterSpotlightProvider("t-calc");
    engine.unregisterSpotlightProvider("t-stream");
}

// ── 3 计算器 provider（真模块） ──────────────────────────────
{
    const run = (q) => calcProvider.search({ query: q, lower: q.toLowerCase(), limit: 6 });
    const find = (items, type) => (items || []).find((item) => item.type === type);

    const r1 = find(run("12*37"), "calculation");
    check("算术：12*37 = 444", r1 && /444/.test(r1.label) && r1.copyText === "444");
    const r2 = find(run("(1+2)/3"), "calculation");
    check("算术：(1+2)/3 = 1", r2 && /= 1$/.test(r2.label));
    const r3 = find(run("2^10"), "calculation");
    check("算术：2^10 = 1024", r3 && /1,?024/.test(r3.label));
    const r4 = find(run("sqrt(2)"), "calculation");
    check("函数：sqrt(2) ≈ 1.414", r4 && /1\.41/.test(r4.label));
    const r5 = find(run("sin(30)"), "calculation");
    check("函数：sin(30) = 0.5（角度制）", r5 && /0\.5/.test(r5.label));
    check("防误吞：纯单词不出计算", !find(run("calculator"), "calculation"));
    check("防误吞：纯数字不出计算", !find(run("2024"), "calculation"));
    check("防误吞：残缺算式不出结果", !find(run("1+"), "calculation"));

    const c1 = find(run("5 km to mile"), "conversion");
    check("换算：5 km → mile ≈ 3.107", c1 && /3\.10?7?/.test(c1.label), c1 ? c1.label : "无结果");
    const c2 = find(run("100 usd to cny"), "currency");
    check("货币：100 USD → CNY = 710", c2 && /710/.test(c2.label));
    check("货币：结果标注汇率快照日期", c2 && c2.sub.includes("2026-10"), c2 ? c2.sub : "");
    const c3 = find(run("36.5 c to f"), "conversion");
    check("温度：36.5°C → °F = 97.7", c3 && /97\.7/.test(c3.label), c3 ? c3.label : "无结果");
    check("跨类别：5 kg to m 不出结果", !find(run("5 kg to m"), "conversion"));
}

// ── 4 日期 provider ──────────────────────────────────────────
{
    const day = 86_400_000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    check("日期：明天", sameDay(parseNaturalDate("明天"), new Date(today.getTime() + day)));
    check("日期：3 天后", sameDay(parseNaturalDate("3天后"), new Date(today.getTime() + 3 * day)));
    check("日期：yesterday", sameDay(parseNaturalDate("yesterday"), new Date(today.getTime() - day)));
    check("日期：in 5 days", sameDay(parseNaturalDate("in 5 days"), new Date(today.getTime() + 5 * day)));
    const nextWed = parseNaturalDate("下周三");
    check("日期：下周三是周三", nextWed && nextWed.getDay() === 3 && nextWed > today);
    check("日期：乱码不猜", parseNaturalDate("随便什么") === null);
}

// ── 5 惰性索引 ──────────────────────────────────────────────
{
    let builds = 0;
    const idx = createIndex({ name: "t", ttl: 40, build: () => { builds += 1; return [{ v: builds }]; } });
    check("索引：未查询不构建", builds === 0 && !idx.isBuilt());
    await idx.get();
    check("索引：首次查询才构建", builds === 1 && idx.isBuilt());
    await idx.get();
    check("索引：TTL 内读缓存不重建", builds === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await idx.get();
    check("索引：TTL 到期自动重建", builds === 2);
    idx.invalidate();
    await idx.get();
    check("索引：手动失效后重建", builds === 3);
}

// ── 6 可见性 API ─────────────────────────────────────────────
{
    const spotlightManifest = JSON.parse(readFileSync(new URL("../mods/spotlight/manifest.json", import.meta.url), "utf8"));
    registry.registerPlugin(spotlightManifest);
    registry.registerPlugin({ id: "thirdparty", name: "第三方", version: "1.0.0", type: "app", entry: "window", _installed: true });

    const vis = registry.getAppVisibility("spotlight");
    check("可见性：聚焦不进启动台/设置/访达", !vis.launchpad && !vis.settings && !vis.finder);
    check("可见性：聚焦是系统应用", vis.system === true);
    check("可见性：聚焦不可卸载", registry.isUninstallable("spotlight") === false);
    check("可见性：system 强制不可卸载", registry.getAppVisibility("spotlight").uninstallable === false);

    const third = registry.getAppVisibility("thirdparty");
    check("可见性：第三方默认全可见", third.launchpad && third.settings && third.finder);
    check("可见性：已安装第三方默认可卸载", registry.isUninstallable("thirdparty") === true);

    check("禁用保护：系统应用不可禁用", registry.setPluginEnabled("spotlight", false) === true
        && registry.isPluginEnabled("spotlight") === true);
    check("禁用保护：第三方可禁用", registry.setPluginEnabled("thirdparty", false) === false);
    registry.setPluginEnabled("thirdparty", true);
}

// ── 7 系统动作注册表 ─────────────────────────────────────────
{
    const sa = await import("../src/javascripts/system-actions.js");
    // 内置 12 条已随 commands provider 注册（script.js 求值链；全量视图不看可用性）
    const builtin = sa.listSystemActions({ includeUnavailable: true }).map((a) => a.id);
    check("动作表：内置动作已注册（12 条）",
        ["lockScreen", "sleep", "shutdown", "restart", "forceQuit", "logOut", "emptyTrash", "hideActiveApp", "showAll", "aboutThisMac", "reloadActivePlugin", "toggleDarkMode"].every((id) => builtin.includes(id)),
        builtin.join(","));

    const un1 = sa.registerSystemAction({ id: "t-action", label: "测试动作", run: () => true });
    check("动作表：注册后可列出", sa.listSystemActions().some((a) => a.id === "t-action"));
    sa.registerSystemAction({ id: "t-action", label: "测试动作v2", run: () => true });
    check("动作表：同 id 覆盖（替换）", sa.listSystemActions().find((a) => a.id === "t-action")?.label === "测试动作v2");

    let offCount = 0;
    sa.registerSystemAction({ id: "t-off", label: "不可用动作", available: () => { offCount += 1; return false; }, run: () => true });
    check("动作表：available=false 不出现", !sa.listSystemActions().some((a) => a.id === "t-off") && offCount > 0);
    sa.registerSystemAction({ id: "t-throws", label: "抛错判定", available: () => { throw new Error("boom"); }, run: () => true });
    check("动作表：available 抛错按不可用处理", !sa.listSystemActions().some((a) => a.id === "t-throws"));

    sa.registerSystemAction({ id: "t-fail", label: "执行抛错", run: () => { throw new Error("exec boom"); } });
    check("动作表：执行抛错被隔离（返回 false 不抛出）", (await sa.runSystemAction("t-fail")) === false);
    check("动作表：不存在 id 返回 false", (await sa.runSystemAction("no-such-action")) === false);

    un1();
    check("动作表：注销函数生效", !sa.listSystemActions().some((a) => a.id === "t-action"));
    sa.unregisterSystemAction("t-off");
    sa.unregisterSystemAction("t-throws");
    sa.unregisterSystemAction("t-fail");

    // 经 commands provider 检索注册的动作（新动作零改动可搜）
    sa.registerSystemAction({ id: "t-findme", label: "找我测试", aliases: ["findme"], run: () => true });
    const { commandsProvider } = await import("../mods/spotlight/providers/commands.js");
    const hits = commandsProvider.search({ query: "findme", lower: "findme", limit: 6 });
    check("动作表：provider 检索到新注册动作", hits.some((h) => h.label === "找我测试"));
    sa.unregisterSystemAction("t-findme");
}

// ── 8 集成：initSpotlight 幂等 + manifest 发现计算器 provider ──
{
    const calcManifest = JSON.parse(readFileSync(new URL("../mods/calculator/manifest.json", import.meta.url), "utf8"));
    registry.registerPlugin(calcManifest);
    registry.markReady();

    check("initSpotlight 首次完成", script.initSpotlight() === true);
    check("initSpotlight 幂等", script.initSpotlight() === true);

    const hits = await script.searchAll("12*37");
    check("集成：searchAll 发现计算器 provider 并出 444",
        hits.some((item) => item.type === "calculation" && /444/.test(item.label)),
        hits.map((h) => h.label).join(" | "));
    const words = await script.searchAll("随便一个词");
    check("集成：无本地结果时回退网页搜索", words.length === 1 && words[0].type === "websearch");
}

// ---- 汇总 ----
let failed = 0;
results.forEach(({ name, ok, detail }) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
});
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
