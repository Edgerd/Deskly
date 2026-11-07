/**
 * dev/spotlight-bench.mjs — 聚焦搜索性能基准（Node，无浏览器）
 *
 * 对照「改造前 · 每键全量扫描」与「改造后 · 惰性索引 + 缓存匹配」：
 *   - 数据源用与真实规模相当的合成数据（应用 26、设置 300、文件 4×500 + 最近 80、
 *     手册 300、书签 200）；
 *   - 模拟逐键输入 "12*37 calc" 的 9 次查询，记录每键耗时；
 *   - 旧路径：每个按键都把 5 个数据源重新扫一遍（含目录列举的 I/O 等价成本）；
 *   - 新路径：引擎（engine.js）+ 惰性索引（index.js），首查建索引、后续读缓存行；
 *   - 汇报：索引构建耗时、每键平均/P95、堆内存增量、渲染行数（虚拟列表对照）。
 *
 * 用法：node dev/spotlight-bench.mjs
 */

import { createIndex } from "../mods/spotlight/index.js";
import { registerSpotlightProvider, unregisterSpotlightProvider, runSpotlightQuery } from "../mods/spotlight/engine.js";

/* ── 合成数据（规模对齐真实桌面） ── */

const APPS = Array.from({ length: 26 }, (_, i) => ({ name: `应用${i}`, windowName: `应用${i}`, displayName: `App${i}`, appId: `app${i}` }));
const SETTINGS = Array.from({ length: 300 }, (_, i) => ({ label: `设置项${i}`, key: `group${i % 20}.item${i}`, hint: `提示${i}`, group: `组${i % 20}`, pane: "general" }));
const FOLDER_FILES = Array.from({ length: 4 }, (_, d) =>
    Array.from({ length: 500 }, (_, i) => ({ name: `文档${d}-${i}.txt`, path: `/文档${d}/${i}.txt`, type: "file", modified: Date.now() - i * 1000 })));
const RECENT_FILES = Array.from({ length: 80 }, (_, i) => ({ name: `最近${i}.png`, path: `/图片/${i}.png`, type: "file", modified: Date.now() - i * 500 }));
const MANUAL = Array.from({ length: 300 }, (_, i) => ({ section: `第${i}节`, text: `手册内容${i}`, chapterTitle: `第${i / 10 | 0}章` }));
const BOOKMARKS = Array.from({ length: 200 }, (_, i) => ({ title: `书签${i}`, url: `https://example.com/${i}` }));

function rankOf(lower, ...fields) {
    let best = 3;
    for (const field of fields) {
        const text = String(field || "").toLowerCase();
        if (!text) continue;
        let rank = 3;
        if (text === lower) rank = 0;
        else if (text.startsWith(lower)) rank = 1;
        else if (text.includes(lower)) rank = 2;
        if (rank < best) best = rank;
    }
    return best;
}

/** 旧路径：每个按键重新扫全部来源（目录列举成本用生成等长数组模拟一次 I/O）。 */
function legacySearch(query) {
    const found = [];
    APPS.forEach((rec) => { const s = rankOf(query, rec.name, rec.windowName, rec.displayName, rec.appId); if (s < 3) found.push({ s }); });
    SETTINGS.forEach((def) => { const s = rankOf(query, def.label, def.key, def.hint, def.group); if (s < 3) found.push({ s }); });
    for (const folder of FOLDER_FILES) {
        const entries = folder.map((entry) => ({ ...entry })); // 模拟每次按键一次 VFS.list
        entries.forEach((entry) => { const s = rankOf(query, entry.name, entry.path); if (s < 3) found.push({ s }); });
    }
    RECENT_FILES.forEach((entry) => { const s = rankOf(query, entry.name, entry.path); if (s < 3) found.push({ s }); });
    MANUAL.forEach((entry) => { const s = rankOf(query, entry.section, entry.text, entry.chapterTitle); if (s < 3) found.push({ s }); });
    return found.length;
}

/** 新路径：惰性索引（文件目录读一次缓存 30s）+ 引擎取消/隔离开销。 */
const fileIndex = createIndex({
    name: "files",
    build: () => FOLDER_FILES.flat().concat(RECENT_FILES),
});
const provider = {
    id: "bench",
    group: "file",
    types: ["file"],
    async search(ctx) {
        const rows = await fileIndex.get();
        return rows.filter((entry) => rankOf(ctx.lower, entry.name, entry.path) < 3).slice(0, 6);
    },
};
registerSpotlightProvider(provider);
const appsIdx = createIndex({ name: "apps", build: () => APPS });
registerSpotlightProvider({
    id: "bench-apps", group: "app", types: ["app"],
    async search(ctx) {
        const rows = await appsIdx.get();
        return rows.filter((rec) => rankOf(ctx.lower, rec.name, rec.windowName, rec.displayName, rec.appId) < 3).slice(0, 6);
    },
});
const settingsIdx = createIndex({ name: "settings", build: () => SETTINGS });
registerSpotlightProvider({
    id: "bench-settings", group: "setting", types: ["setting"],
    async search(ctx) {
        const rows = await settingsIdx.get();
        return rows.filter((def) => rankOf(ctx.lower, def.label, def.key, def.hint, def.group) < 3).slice(0, 6);
    },
});
const manualIdx = createIndex({ name: "manual", build: () => MANUAL });
registerSpotlightProvider({
    id: "bench-manual", group: "manual", types: ["manual"],
    async search(ctx) {
        const rows = await manualIdx.get();
        return rows.filter((entry) => rankOf(ctx.lower, entry.section, entry.text, entry.chapterTitle) < 3).slice(0, 6);
    },
});
const bookmarkIdx = createIndex({ name: "bookmarks", build: () => BOOKMARKS });
registerSpotlightProvider({
    id: "bench-bookmarks", group: "bookmark", types: ["bookmark"],
    async search(ctx) {
        const rows = await bookmarkIdx.get();
        return rows.filter((row) => rankOf(ctx.lower, row.title, row.url) < 3).slice(0, 6);
    },
});

/* ── 计时 ── */

const KEYS = ["1", "12", "12*", "12*3", "12*37", "12*37 ", "12*37 c", "12*37 ca", "12*37 cal"];
const ROUNDS = 20;

async function benchAsync(fn) {
    const perKey = [];
    for (const key of KEYS) {
        const start = performance.now();
        await fn(key);
        perKey.push(performance.now() - start);
    }
    return perKey;
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { avg, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] };
}

// 预热 JIT
for (let i = 0; i < 50; i += 1) legacySearch("warm");

const heapBefore = process.memoryUsage().heapUsed;

// 旧路径：5 轮逐键全量扫描
const legacyKeys = [];
for (let round = 0; round < ROUNDS; round += 1) {
    legacyKeys.push(...await benchAsync(async (key) => legacySearch(key.toLowerCase())));
}
const legacy = stats(legacyKeys);

// 新路径：首轮含索引构建，之后 19 轮纯缓存
const firstRun = await benchAsync(async (key) => { await runSpotlightQuery(key, { limit: 6 }); });
const cachedKeys = [];
for (let round = 0; round < ROUNDS - 1; round += 1) {
    cachedKeys.push(...await benchAsync(async (key) => { await runSpotlightQuery(key, { limit: 6 }); }));
}
const cached = stats(cachedKeys);
const heapAfter = process.memoryUsage().heapUsed;

// 索引构建耗时（各类型独立计时）
const builds = {};
for (const [name, idx] of Object.entries({ apps: appsIdx, settings: settingsIdx, files: fileIndex, manual: manualIdx, bookmarks: bookmarkIdx })) {
    idx.invalidate();
    const start = performance.now();
    await idx.get();
    builds[name] = performance.now() - start;
}

// 渲染行数对照（30 条结果：旧=全量 30 行/键；新=首块 14 行）
const RENDER_CHUNK = 14;
const oldRows = 30;
const newRows = Math.min(RENDER_CHUNK, 30);

unregisterSpotlightProvider("bench");
unregisterSpotlightProvider("bench-apps");
unregisterSpotlightProvider("bench-settings");
unregisterSpotlightProvider("bench-manual");
unregisterSpotlightProvider("bench-bookmarks");

console.log("── 聚焦性能基准（Node，合成数据 26 应用 / 300 设置 / 2080 文件 / 300 手册 / 200 书签） ──");
console.log(`索引构建耗时（一次性）：${Object.entries(builds).map(([n, t]) => `${n} ${t.toFixed(2)}ms`).join("，")}`);
console.log(`每键响应 · 旧（每键全量扫 5 源）：avg ${legacy.avg.toFixed(2)}ms，p50 ${legacy.p50.toFixed(2)}ms，p95 ${legacy.p95.toFixed(2)}ms`);
console.log(`每键响应 · 新（缓存匹配 + 引擎开销）：avg ${cached.avg.toFixed(2)}ms，p50 ${cached.p50.toFixed(2)}ms，p95 ${cached.p95.toFixed(2)}ms`);
console.log(`首键（含全部索引构建）：${firstRun[0].toFixed(2)}ms`);
console.log(`提速比（avg）：${(legacy.avg / cached.avg).toFixed(1)}×`);
console.log(`堆内存增量（全部索引驻留）：${((heapAfter - heapBefore) / 1024).toFixed(0)}KB`);
console.log(`渲染行数（30 条结果）：旧 ${oldRows} 行/键 → 新首块 ${newRows} 行，滚动按需追加`);
process.exit(0);
