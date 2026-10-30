/**
 * dev/store-check.mjs — 商店数据层（store-api.js）的 Node 断言
 *
 * 为什么不在浏览器里跑这些：商店界面必须在浏览器里验，但「解包是否完整、失败有没有
 * 回滚、清单字段有没有被清洗」是纯逻辑，磁盘上就能判对错；而回滚路径在浏览器里
 * 要真的装一个坏包才能触发，成本太高。
 *
 * 做法：用 vm.SourceTextModule 把 `src/javascripts/store-api.js` 当真模块求值，
 * 只替掉它的加载器依赖（IndexedDB 落库、ZIP 解压、fetch、授权弹窗、设置中枢），
 * 注册表 `app-registry.js` 用**真的那份**——启用/禁用、id 校验与广播都要真的走到。
 *
 * 用法：`node --experimental-vm-modules dev/store-check.mjs`（全绿退出码 0）
 */

import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(import.meta.url.replace(/^file:\/+/, ""), "..", "..");
const SRC = join(ROOT, "src", "javascripts");

/* ───────────────────────── 浏览器替身 ───────────────────────── */

const listeners = new Map();
function eventTarget(extra = {}) {
    return Object.assign(extra, {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const list = listeners.get(type);
            if (list) list.splice(list.indexOf(fn), 1);
        },
        dispatchEvent(event) {
            (listeners.get(event.type) || []).slice().forEach((fn) => fn(event));
            return true;
        },
    });
}
globalThis.window = eventTarget();
globalThis.document = eventTarget({
    documentElement: { style: { setProperty() {} }, dataset: {} },
    body: {},
    querySelector: () => null,
});
globalThis.CustomEvent = class {
    constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; this.bubbles = !!opts.bubbles; }
};
// Node 24 的 globalThis.navigator 是只读 getter，只能覆盖描述符
Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { controller: {}, getRegistrations: async () => [{}] } },
});

/** 广播捕获：断言 plugin-enabled-change 真的发出去了 */
const broadcasts = [];
{
    const orig = globalThis.document.dispatchEvent;
    globalThis.document.dispatchEvent = (event) => {
        broadcasts.push(event);
        return orig(event);
    };
}

/* ───────────────────────── 状态替身 ───────────────────────── */

const settingsStore = new Map();
const settingsMock = {
    settings: {
        define: (d) => { if (!settingsStore.has(d.key)) settingsStore.set(d.key, structuredClone(d.default)); },
        get: (k, fallback) => (settingsStore.has(k) ? settingsStore.get(k) : fallback),
        set: (k, v) => settingsStore.set(k, v),
    },
};

/** IndexedDB 替身：id -> {manifest 字段, files} */
const idb = new Map();
let grantAnswer = true;
const fetchLog = [];
let fetchMode = "sw"; // sw=带标记头 | nomarker=没被 SW 接管 | missing=404
let missingFiles = new Set();

const BUILTIN_IDS = ["finder", "office", "app-store"];

/** 包内条目：{text} 表示文本内容，{size} 表示二进制体积（installZip 按 Blob 累加字节数） */
function fakeZip(entries) {
    const files = {};
    Object.keys(entries).forEach((name) => { files[name] = { dir: false }; });
    return {
        files,
        // JSZip 的真实签名是 zip.file(name).async("string" | "blob")，type 在 async 上
        file: (name) => {
            const body = entries[name];
            if (!body) return null;
            return {
                async: async (type) => (type === "string"
                    ? String(body.text ?? "")
                    : { size: body.size ?? String(body.text ?? "").length }),
            };
        },
    };
}
globalThis.JSZip = class JSZipFake {
    static loadAsync = async (file) => file.__zip;
};
/** 组一个「文件」：包内容挂在 __zip 上 */
const zipFile = (name, entries) => ({ name, __zip: fakeZip(entries) });

/* ───────────────────────── 模块求值 ───────────────────────── */

const moduleCache = new Map();
const mockCache = new Map();

/** 用给定导出名造一个替身模块（linker 必须返回 Module 实例，不能返回普通对象） */
function mockModule(id, names, exports) {
    const key = `${id}|${names.join(",")}`;
    if (mockCache.has(key)) return mockCache.get(key);
    const mod = new vm.SyntheticModule(names, function setExports() {
        names.forEach((n) => this.setExport(n, exports[n]));
    }, { identifier: `mock:${id}` });
    const ready = mod.evaluate().then(() => mod);
    mockCache.set(key, ready);
    return ready;
}

/**
 * 求值真实模块，说明符按文件所在目录解析；命中 mocks 的用替身。
 * 与 Node 的 ESM 一样，同一个绝对路径只求真值一次（模块缓存）。
 * @param {string} file 绝对路径
 * @param {Object<string, object>} mocks 绝对路径 -> 替身 Module
 * @returns {Promise<object>} 命名空间
 */
async function namespaceOf(file, mocks) {
    if (moduleCache.has(file)) return moduleCache.get(file).namespace;
    const mod = new vm.SourceTextModule(readFileSync(file, "utf8"), {
        identifier: file,
        importModuleDynamically: async (spec) => namespaceOf(resolve(dirname(file), spec), mocks),
    });
    moduleCache.set(file, mod);
    await mod.link(async (spec) => {
        const target = resolve(dirname(file), spec);
        return mocks[target] || (await loadInto(target, mocks));
    });
    await mod.evaluate();
    return mod.namespace;

    async function loadInto(target, m) {
        if (moduleCache.has(target)) return moduleCache.get(target);
        const inner = new vm.SourceTextModule(readFileSync(target, "utf8"), {
            identifier: target,
            importModuleDynamically: async (spec) => namespaceOf(resolve(dirname(target), spec), m),
        });
        moduleCache.set(target, inner);
        await inner.link(async (spec) => {
            const t2 = resolve(dirname(target), spec);
            return m[t2] || (await loadInto(t2, m));
        });
        await inner.evaluate();
        return inner;
    }
}

/* 先起真的注册表（只替 settings） */
const settingsMockMod = await mockModule("settings", ["settings"], settingsMock);
const registryMocks = { [join(SRC, "settings.js")]: settingsMockMod };
const registry = await namespaceOf(join(SRC, "app-registry.js"), registryMocks);

/* 加载器替身：真注册表 + 假落库 */
const pmMocks = {
    getPlugins: registry.getPlugins,
    getPlugin: registry.getPlugin,
    listApps: registry.listApps,
    getIcon: (id) => {
        const m = registry.getPlugin(id);
        return m ? `./mods/${id}/${m.icon || "icon.png"}` : "./assets/icons/dock/Launcher.png";
    },
    registerInstalledPlugin: async (manifest, files) => {
        idb.set(manifest.id, { ...manifest, files });
        manifest._installed = true;
        return registry.registerPlugin(manifest);
    },
    unregisterInstalledPlugin: async (id) => {
        const inDb = idb.delete(id);
        const inRegistry = registry.unregisterPlugin(id);
        return inDb || inRegistry;
    },
    BUILTIN_IDS,
    disabledIds: registry.disabledIds,
    isPluginEnabled: registry.isPluginEnabled,
    setPluginEnabled: registry.setPluginEnabled,
};
const PM_NAMES = Object.keys(pmMocks);

const mocks = {
    ...registryMocks,
    [join(SRC, "api-grants.js")]: await mockModule("api-grants",
        ["showPermissionChecklist", "describe", "isKnownPermission", "isSensitive"], {
            showPermissionChecklist: async () => grantAnswer,
            describe: (p) => ({ label: `标签:${p}`, hint: `说明:${p}` }),
            isKnownPermission: (p) => p === "files:read" || p === "files:write",
            isSensitive: (p) => p === "files:write",
        }),
    [join(SRC, "plugin-manager.js")]: await mockModule("plugin-manager", PM_NAMES, pmMocks),
};

const S = await namespaceOf(join(SRC, "store-api.js"), mocks);

/* ───────────────────────── 断言工具 ───────────────────────── */

let passed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed += 1; return; }
    failures.push(`${name}${extra === undefined ? "" : ` — 实得 ${JSON.stringify(extra)}`}`);
}
function eq(name, actual, expected) {
    check(`${name}（期望 ${JSON.stringify(expected)}）`, actual === expected, actual);
}

/* ───────────────────────── 用例 ───────────────────────── */

globalThis.fetch = async (url) => {
    fetchLog.push(String(url));
    const bare = String(url).split("?")[0];
    const m = bare.match(/^\.\/mods\/([^/]+)\/(.+)$/);
    const id = m ? m[1] : "";
    const file = m ? m[2] : bare;
    // 只有真的在替身库里的文件才返回 200 + 标记头，其他一律 404：
    // 这样「装一个少文件的包必须失败」才是被测事实，而不是替身太宽松。
    const rec = idb.get(id);
    const served = fetchMode !== "missing" && !missingFiles.has(file) && rec && rec.files && rec.files[file];
    if (!served) return { ok: false, status: 404, headers: { get: () => null } };
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "x-deskly-plugin" && fetchMode === "sw" ? id : null) },
    };
};

/** 每个用例前清干净：注册表、替身库、设置、fetch 状态 */
function reset(manifests = []) {
    registry.getPlugins().forEach((m) => registry.unregisterPlugin(m.id));
    manifests.forEach((m) => {
        registry.registerPlugin({ ...m });
        seedRecord(m);
    });
    idb.forEach((v, k) => { if (!registry.getPlugin(k)) idb.delete(k); });
    settingsStore.clear();
    S.listEntries(); // 触发 settings.define 幂等注册
    fetchLog.length = 0;
    fetchMode = "sw";
    missingFiles = new Set();
    grantAnswer = true;
    broadcasts.length = 0;
}

/**
 * 替身库里造一条「已安装」记录：清单声明的必需资源与详情图都在，
 * 这样 verifyInstall 测的是回读逻辑，而不是替身库里有没有文件。
 */
function seedRecord(m) {
    const files = {};
    const add = (f) => { if (typeof f === "string" && f) files[f.replace(/^\.\//, "")] = true; };
    add(m.style || "style.css");
    add(m.script || "script.js");
    add(m.icon);
    if (Array.isArray(m.apps) && m.apps.length) m.apps.forEach((a) => { add(a.main || `${a.id}.html`); add(a.icon); });
    else add(m.main || "index.html");
    ((m.store || {}).screenshots || []).forEach(add);
    idb.set(m.id, { ...m, files });
}

const GOOD = {
    id: "demo", name: "演示插件", version: "1.0.0", description: "demo", type: "app", entry: "window",
    icon: "icon.png", main: "index.html", style: "style.css", script: "script.js",
    permissions: ["files:read", "files:write", "made:up"],
    store: {
        category: " 工具 ", tagline: " 一句话 ", features: new Array(30).fill("F"),
        screenshots: ["shot.png", "../etc/passwd.png", "note.txt", "b.png", "c.png", "d.png", "e.png"],
    },
};
const GOOD_TEXT = JSON.stringify(GOOD);
const GOOD_ZIP = {
    "manifest.json": { text: GOOD_TEXT },
    "index.html": { size: 1 }, "style.css": { size: 1 }, "script.js": { size: 1 }, "icon.png": { size: 1 },
};

/* 1. storeMeta 清洗 */
reset([GOOD]);
const meta = S.getEntry("demo").store;
eq("store.category 去空格", meta.category, "工具");
eq("store.tagline 去空格", meta.tagline, "一句话");
eq("features 截到 12 条", meta.features.length, 12);
eq("screenshots 只留图片且拒绝 ..", meta.screenshots.join(","), "shot.png,b.png,c.png,d.png,e.png");
eq("清单没写 store 时返回 null", S.storeMeta({ id: "x" }), null);
eq("store 是数组时视为没写", S.storeMeta({ id: "x", store: [] }), null);
eq("homepage 非 http(s) 被丢弃", S.storeMeta({ id: "x", store: { homepage: "javascript:alert(1)" } }).homepage, "");
eq("homepage 合法才保留", S.storeMeta({ id: "x", store: { homepage: "https://a.test" } }).homepage, "https://a.test");
eq("长文本按上限截断", S.storeMeta({ id: "x", store: { summary: "字".repeat(900) } }).summary.length, 600);

/* 2. permissionsOf 读清单而不是文案 */
const perms = S.getEntry("demo").permissions;
eq("未知权限被丢掉", perms.length, 2);
eq("权限带人类可读说明", perms[0].label, "标签:files:read");
eq("敏感权限有标记", perms.find((p) => p.name === "files:write").sensitive, true);
eq("没声明权限时为空数组", S.permissionsOf({ id: "x" }).length, 0);

/* 3. 列表 / 分类 / 搜索 */
reset([
    { id: "a", name: "甲", version: "1", icon: "a.png", type: "app", entry: "window" },
    { id: "b", name: "乙", _installed: true, version: "2", description: "表格与公式", icon: "b.png", store: { category: "办公" } },
]);
const cats = S.categories();
eq("内置计数", cats.find((c) => c.key === "builtin").count, 1);
eq("已安装计数", cats.find((c) => c.key === "installed").count, 1);
eq("清单分类自动成组", cats.find((c) => c.key === "cat:办公").count, 1);
eq("搜索命中描述", S.filterEntries("all", "公式").map((e) => e.id).join(","), "b");
eq("搜索命中 id（大小写不敏感）", S.filterEntries("all", "A").map((e) => e.id).join(","), "a");
eq("分类筛选生效", S.filterEntries("cat:办公", "").map((e) => e.id).join(","), "b");
eq("已安装来源标记", S.getEntry("b").source, "installed");
check("图标带缓存戳", S.getEntry("a").icon.includes("?v="), S.getEntry("a").icon);
eq("占位图不加戳", S.getEntry("a").icon.startsWith("./mods/a/"), true);

/* 4. 启用 / 禁用（真注册表 + 广播） */
eq("默认可用", S.isPluginEnabled("a"), true);
eq("商店自身不可禁用", S.setEnabled("app-store", false).ok, false);
eq("禁用成功", S.setEnabled("a", false).enabled, false);
eq("禁用后列表反映状态", S.getEntry("a").enabled, false);
eq("禁用项计入「已禁用」分类", S.categories().find((c) => c.key === "disabled").count, 1);
eq("禁用广播已发出", broadcasts.some((e) => e.type === "plugin-enabled-change" && e.detail.id === "a" && e.detail.enabled === false), true);
S.setEnabled("a", true);
eq("重新启用", S.getEntry("a").enabled, true);

/* 5. SW 探测与安装校验 */
reset([GOOD]);
fetchMode = "sw";
eq("回读带标记头算通过", (await S.probeResource("demo", "index.html")).ok, true);
fetchMode = "nomarker";
const noMark = await S.probeResource("demo", "index.html");
eq("没有标记头视为未接管", noMark.ok, false);
check("未接管的理由可读", /Service Worker/.test(noMark.reason), noMark.reason);
fetchMode = "missing";
eq("404 报告状态码", (await S.probeResource("demo", "index.html")).reason, "HTTP 404");
fetchMode = "sw";
eq("声明资源齐全", (await S.verifyInstall("demo")).ok, true);
check("校验会逐个回读", fetchLog.length >= 5, fetchLog.length);
check("截图也参与校验", fetchLog.some((u) => u.includes("shot.png")), fetchLog.join(" "));

/* 6. 安装成功路径 */
reset([]);
const ok = await S.installZip(zipFile("demo.zip", { ...GOOD_ZIP, "codecs/docx.js": { size: 10 } }), { onProgress: () => {} });
eq("安装成功", ok.ok, true);
eq("记录文件数", ok.fileCount, 6);
eq("安装历史写入", (S.history()[0] || {}).id, "demo");
eq("安装元数据写入字节数", S.getEntry("demo").bytes, GOOD_TEXT.length + 4 + 10);
check("详情图缺失只算提醒", ok.warnings.length === 5, ok.warnings);
check("子目录键名不被拍平", idb.get("demo").files["codecs/docx.js"] !== undefined, Object.keys(idb.get("demo").files));
eq("安装后来源变为已安装", S.getEntry("demo").source, "installed");

/* 7. 公共顶层目录剥离 */
reset([]);
const nested = await S.installZip(zipFile("x.zip", Object.fromEntries(
    Object.entries(GOOD_ZIP).map(([k, v]) => [`demo/${k}`, v]),
)), {});
eq("整包放在同名目录下也能装", nested.ok, true);
check("公共根被剥掉", idb.get("demo").files["codecs/docx.js"] === undefined
    && idb.get("demo").files["index.html"] !== undefined, Object.keys(idb.get("demo").files));

/* 8. 失败路径：都不留半成品 */
reset([]);
eq("空文件拒绝", (await S.installZip(null, {})).reason, "没有收到文件");
eq("非 zip 拒绝", (await S.installZip({ name: "a.txt" }, {})).reason, "只接受 .zip 插件包");
eq("空包拒绝", (await S.installZip(zipFile("z.zip", {}), {})).reason, "压缩包是空的");
check("manifest 不在包根也不在同一个顶层目录时拒绝",
    (await S.installZip(zipFile("z.zip", { "a/manifest.json": { text: "{}" }, "b/x.txt": { size: 1 } }), {}))
        .reason.includes("包里找不到 manifest.json"));
eq("manifest 非法 JSON 拒绝", (await S.installZip(zipFile("z.zip", { "manifest.json": { text: "{oops" } }), {})).reason.startsWith("manifest.json 不是合法 JSON"), true);
eq("缺 id 拒绝", (await S.installZip(zipFile("z.zip", { "manifest.json": { text: "{}" } }), {})).reason, "manifest.json 缺少 id 字段");
check("非法 id 拒绝", (await S.installZip(zipFile("z.zip", { "manifest.json": { text: JSON.stringify({ id: "../evil" }) } }), {})).reason.includes("不合法"));
eq("撞内置 id 拒绝", (await S.installZip(zipFile("z.zip", { "manifest.json": { text: JSON.stringify({ id: "office" }) } }), {})).reason.includes("与内置插件同名"), true);
const big = await S.installZip(zipFile("z.zip", { "manifest.json": { text: JSON.stringify({ id: "big" }) }, "a.bin": { size: 11 * 1024 * 1024 } }), {});
check("超 10MB 上限拒绝", big.reason.includes("超过 10MB 上限"), big.reason);
eq("上限失败时没有落库", idb.has("big"), false);
grantAnswer = false;
const cancelled = await S.installZip(zipFile("z.zip", GOOD_ZIP), {});
eq("取消返回 cancelled", cancelled.reason, "cancelled");
eq("取消后没有落库", idb.has("demo"), false);
eq("取消后注册表也没有", S.getEntry("demo"), null);
grantAnswer = true;

/* 资源不齐 → 回滚 */
reset([]);
missingFiles = new Set(["script.js"]);
const rolled = await S.installZip(zipFile("z.zip", GOOD_ZIP), {});
eq("校验不过时报回滚", rolled.reason, "包内资源不完整，已回滚");
check("回滚列出缺哪个文件", rolled.detail.problems.some((p) => p.file === "script.js"), rolled.detail.problems);
eq("回滚后库里不再有", idb.has("demo"), false);
eq("回滚后注册表不再有", S.getEntry("demo"), null);
eq("回滚不留安装记录", S.history().length, 0);

/* SW 没接管 → 整段失败而不是留下打不开的插件 */
reset([]);
fetchMode = "nomarker";
const noSw = await S.installZip(zipFile("z.zip", GOOD_ZIP), {});
eq("未接管时安装失败", noSw.ok, false);
eq("未接管时已回滚", idb.has("demo"), false);

/* 9. 覆盖安装与版本差异 */
reset([{ id: "demo", name: "演示插件", version: "1.0.0", icon: "icon.png" }]);
const nextZip = zipFile("z.zip", { ...GOOD_ZIP, "manifest.json": { text: JSON.stringify({ ...GOOD, version: "1.1.0" }) } });
const dup = await S.installZip(nextZip, {});
eq("同 id 未授权覆盖时提示", dup.reason, "already-installed");
eq("提示里带新包版本", dup.detail.nextVersion, "1.1.0");
eq("提示里带插件名", dup.detail.name, "演示插件");
const over = await S.installZip(zipFile("z.zip", { ...GOOD_ZIP, "manifest.json": { text: JSON.stringify({ ...GOOD, version: "1.1.0" }) } }), { overwrite: true });
eq("覆盖安装成功", over.ok, true);
eq("覆盖记录 replaced", (S.history()[0] || {}).replaced, true);
eq("版本差异可比", S.versionDiff("demo", "2.0.0").current, "1.1.0");

/* 10. 卸载 */
reset([]);
await S.installZip(zipFile("z.zip", GOOD_ZIP), {});
const gone = await S.uninstall("demo");
eq("卸载成功", gone.ok, true);
eq("卸载后注册表清空", S.getEntry("demo"), null);
eq("卸载写入历史", (S.history()[0] || {}).action, "uninstall");
eq("内置插件不可卸载", (await S.uninstall("office")).reason.includes("内置插件不能卸载"), true);
check("没装过的卸载有理由", (await S.uninstall("nope")).ok === false);

/* 11. 记录上限与历史顺序 */
reset([]);
for (let i = 0; i < 60; i += 1) {
    await S.installZip(zipFile("z.zip", { ...GOOD_ZIP, "manifest.json": { text: JSON.stringify({ ...GOOD, id: `p${i}` }) } }), {});
    missingFiles = new Set();
}
eq("安装历史最多 50 条", S.history().length, 50);
eq("最新记录在最前", (S.history()[0] || {}).id, "p59");

/* 12. swStatus */
reset([]);
const sw = await S.swStatus();
eq("接管状态可读", sw.controlled, true);
eq("注册状态可读", sw.registered, true);

/* ───────────────────────── 结果 ───────────────────────── */

console.log(`  · 断言 ${passed + failures.length} 条`);
if (failures.length) {
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(`商店数据层断言失败 ${failures.length} 条`);
    process.exit(1);
}
console.log("商店数据层断言全部通过 ✓");
