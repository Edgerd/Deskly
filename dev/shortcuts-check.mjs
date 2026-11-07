/**
 * dev/shortcuts-check.mjs — 第 5 期探针：桌面快捷方式（创建/唯一名/解析/损坏回退/
 * 查重/移除进废纸篓）。不开浏览器。
 * 用法：`node dev/shortcuts-check.mjs`（有问题退出码 1 并逐条列出）
 */

const KEY_PATHS = { virtualfiles: "path", handles: "key" };

function makeFakeIdb() {
    const dbs = new Map();
    return {
        open(name) {
            if (!dbs.has(name)) dbs.set(name, new Map());
            const tables = dbs.get(name);
            if (!tables.has("virtualfiles")) tables.set("virtualfiles", new Map());
            if (!tables.has("handles")) tables.set("handles", new Map());
            const db = {
                objectStoreNames: { contains: (s) => tables.has(s) },
                createObjectStore: (s) => { tables.set(s, new Map()); return {}; },
                close() {},
                transaction(store) {
                    const map = tables.get(store);
                    const keyPath = KEY_PATHS[store];
                    const tx = {
                        error: null,
                        objectStore: () => ({
                            put: (row) => { map.set(row[keyPath], row); return { result: undefined }; },
                            get: (k) => { const r = { result: map.get(k) }; queueMicrotask(() => r.onsuccess?.()); return r; },
                            getAll: () => { const r = { result: [...map.values()] }; queueMicrotask(() => r.onsuccess?.()); return r; },
                            delete: (k) => { map.delete(k); return { result: undefined }; },
                        }),
                    };
                    queueMicrotask(() => tx.oncomplete?.());
                    return tx;
                },
            };
            const req = { result: db };
            queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
            return req;
        },
    };
}

globalThis.indexedDB = makeFakeIdb();
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {} }),
    querySelector: () => null, querySelectorAll: () => [],
};
const LS = new Map();
globalThis.localStorage = {
    getItem: (k) => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, v),
    removeItem: (k) => LS.delete(k),
};
globalThis.Blob = class Blob { constructor(p = [], o = {}) { this.parts = Array.isArray(p) ? p : [p]; this.type = o.type || ""; } };
globalThis.File = class File extends Blob {
    constructor(p, n) { super(p); this.name = n; }
    async text() { return String(this.parts[0] ?? ""); }
};

let fails = 0;
let count = 0;
const eq = async (label, got, want) => {
    count++;
    let a, b;
    try { a = JSON.stringify(await got); b = JSON.stringify(want); }
    catch (err) { a = `<序列化失败 ${err.message}>`; b = ""; }
    if (a !== b) { fails++; console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`); }
};
const ok = async (label, cond) => {
    count++;
    if (!(await cond)) { fails++; console.log(`FAIL ${label}`); }
};

const { OSFS } = await import("../src/javascripts/osfs.js");
const { FS } = await import("../src/javascripts/fs/index.js");
const { registerPlugin } = await import("../src/javascripts/app-registry.js");
const { Shortcuts } = await import("../src/javascripts/core/shortcuts.js");

await OSFS.init();
registerPlugin({ id: "demo-app", name: "演示应用" });
registerPlugin({ id: "office", name: "办公", apps: [{ id: "word", name: "文稿" }] });

/* ══ 创建与解析 ══ */

const p1 = await Shortcuts.add("demo-app");
await eq("落点在 /桌面", FS.parentOf(p1), "/桌面");
await eq("文件名带后缀", FS.baseName(p1), "演示应用.webloc.json");
await eq("读回内容", (await Shortcuts.read(p1)).appId, "demo-app");

// 多应用套件：按子应用名添加
const p2 = await Shortcuts.add("文稿");
await eq("子应用 appId 正确", (await Shortcuts.read(p2)).appId, "office.word");

// 同名顺延
const p3 = await Shortcuts.add("demo-app");
await eq("同名顺延 (1)", FS.baseName(p3), "演示应用 (1).webloc.json");

// 查重
await eq("findExisting 命中首个", await Shortcuts.findExisting("demo-app"), p1);
await eq("未添加的查不到", await Shortcuts.findExisting("office.word"), p2);   // 上面已加过文稿
await eq("完全没加过的返回 null", await Shortcuts.findExisting("不存在应用"), null);

// 损坏内容回退 null（按普通文件对待，不假装是快捷方式）
await FS.write("/桌面/fake.webloc.json", "不是 JSON");
await eq("损坏内容回退 null", await Shortcuts.read("/桌面/fake.webloc.json"), null);
await FS.write("/桌面/other.webloc.json", JSON.stringify({ kind: "别的东西" }));
await eq("kind 不符回退 null", await Shortcuts.read("/桌面/other.webloc.json"), null);

// 找不到的应用拒绝创建
let threw = 0;
try { await Shortcuts.add("ghost-app"); } catch { threw++; }
await eq("未知应用拒绝创建", threw, 1);

/* ══ 移除进废纸篓 ══ */

await Shortcuts.remove(p3);
await eq("移除后原位置消失", await FS.exists(p3), false);
await ok("进了废纸篓", (await FS.list("/废纸篓")).some((f) => f.name === "演示应用 (1).webloc.json"));

console.log(`${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
