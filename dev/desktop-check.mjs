/**
 * dev/desktop-check.mjs — 第 2 期探针：.DS_Store 坐标（含容错/外来保护/随目录移动）、
 * ZIP(store) 打包完整性、右键菜单 provider 装配与隔离。不开浏览器。
 * 用法：`node dev/desktop-check.mjs`（有问题退出码 1 并逐条列出）
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
        __table: (name, store) => dbs.get(name)?.get(store),
    };
}

globalThis.indexedDB = makeFakeIdb();
globalThis.window = {};
// ui/contextMenu.js → desktopItems.js 在模块顶层挂 document 监听：探针只测装配逻辑，
// 给个最小替身让 import 链站起来即可。
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
globalThis.Blob = class Blob {
    constructor(parts = [], opts = {}) { this.parts = Array.isArray(parts) ? parts : [parts]; this.type = opts.type || ""; this.size = typeof this.parts[0] === "string" ? this.parts[0].length : (this.parts[0]?.byteLength ?? 0); }
};
globalThis.File = class File extends Blob {
    constructor(parts, name, opts = {}) { super(parts, opts); this.name = name; this.lastModified = 1700000000000; }
    async text() { let p = this.parts[0]; if (p && typeof p.text === "function") p = await p.text(); if (p instanceof Uint8Array) return new TextDecoder().decode(p); return String(p ?? ""); }
    async arrayBuffer() { return this.parts[0] instanceof Uint8Array ? this.parts[0].buffer : new TextEncoder().encode(String(this.parts[0] ?? "")).buffer; }
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

const { FS } = await import("../src/javascripts/fs/index.js");
const { DSStore } = await import("../src/javascripts/fs/dsstore.js");
const { zipStore, unzipList } = await import("../src/javascripts/fs/zip.js");
const { MenuProviders } = await import("../src/javascripts/core/menuProviders.js");
const { OSFS } = await import("../src/javascripts/osfs.js");

/* ══ 一 .DS_Store ══ */

await OSFS.init();
await eq("空目录坐标为空表", await DSStore.read("/桌面"), { positions: {}, foreign: false });

await ok("写坐标成功", await DSStore.write("/桌面", { "a.txt": { x: 100, y: 200 } }));
await eq("读回坐标", (await DSStore.read("/桌面")).positions["a.txt"], { x: 100, y: 200 });

await ok("setPosition 四舍五入", await DSStore.setPosition("/桌面", "b.txt", { x: 10.6, y: 20.4 }));
await eq("坐标已取整", (await DSStore.read("/桌面")).positions["b.txt"], { x: 11, y: 20 });

// 损坏 JSON：回退空表且标记外来，写入被拒绝、原文件内容不动
await FS.write("/文档/.DS_Store", "这不是 JSON{{{", );
const bad = await DSStore.read("/文档");
await eq("损坏内容回退空表", bad.positions, {});
await eq("损坏内容标记外来", bad.foreign, true);
await eq("外来文件拒绝覆盖", await DSStore.write("/文档", { "x": { x: 1, y: 1 } }), false);
await eq("外来文件内容未被改动", await (await FS.read("/文档/.DS_Store", { includeHidden: true })).text(), "这不是 JSON{{{");

// 结构不符（version 不对）同样按外来处理
await FS.write("/下载/.DS_Store", JSON.stringify({ version: 99, positions: {} }));
await eq("版本不符标记外来", (await DSStore.read("/下载")).foreign, true);

// 单条坐标损坏只丢那一条
await FS.write("/图片/.DS_Store", JSON.stringify({ version: 1, positions: { good: { x: 1, y: 2 }, bad: { x: "NaNish" } } }));
const partial = await DSStore.read("/图片");
await eq("损坏单条被丢弃", Object.keys(partial.positions), ["good"]);
await eq("损坏单条不连累外来标记", partial.foreign, false);

// 随目录移动：sidecar 是普通子行，目录 move 自然带走
await FS.mkdir("/桌面/mvdir");
await DSStore.write("/桌面/mvdir", { "inner.txt": { x: 7, y: 8 } });
await FS.move("/桌面/mvdir", "/图片/mvdir");
const moved = await DSStore.read("/图片/mvdir");
await eq("sidecar 随目录移动", moved.positions["inner.txt"], { x: 7, y: 8 });
await ok("移动后不是外来标记", !moved.foreign);
await eq("原位置的 sidecar 已随目录走", (await DSStore.read("/桌面/mvdir")).positions, {});

// prune / clear
await DSStore.write("/桌面", { "a.txt": { x: 1, y: 1 }, "dead.txt": { x: 2, y: 2 } });
await DSStore.prune("/桌面", ["a.txt"]);
await eq("prune 清掉死坐标", Object.keys((await DSStore.read("/桌面")).positions), ["a.txt"]);
await DSStore.clear("/桌面");
await eq("clear 清空", (await DSStore.read("/桌面")).positions, {});

/* ══ 二 ZIP(store) ══ */

const packed = zipStore([
    { name: "目录/", data: new Uint8Array(0) },
    { name: "目录/你好.txt", data: new TextEncoder().encode("你好，世界") },
    { name: "plain.bin", data: new Uint8Array([0, 1, 2, 3, 255]) },
]);
const parsed = unzipList(packed);
await eq("ZIP 条目数", parsed.length, 3);
await eq("ZIP 中文名不解码成乱码", parsed[1].name, "目录/你好.txt");
await eq("ZIP 正文一致", new TextDecoder().decode(parsed[1].data), "你好，世界");
await eq("ZIP 二进制一致", [...parsed[2].data], [0, 1, 2, 3, 255]);
await eq("ZIP 目录条目为空", parsed[0].data.length, 0);

/* ══ 三 菜单 provider 装配 ══ */

const sel1 = { location: "desktop", items: [{ path: "/桌面/a.txt", name: "a.txt", type: "file" }], isBackground: false };
const builtin = [{ id: "open", label: "打开" }, { type: "separator" }, { id: "trash", label: "移到废纸篓" }];

await eq("无 provider 时只出内建", MenuProviders.assemble(sel1, builtin), builtin);

// 参数校验
let threw = 0;
try { MenuProviders.registerProvider({ items: () => [] }); } catch { threw++; }
try { MenuProviders.registerProvider({ id: "x", match: () => true }); } catch { threw++; }
await eq("缺 id / 缺函数被拒", threw, 2);

const offA = MenuProviders.registerProvider({ id: "a", order: 50, match: () => true, items: () => [{ id: "a1", label: "A" }] });
MenuProviders.registerProvider({ id: "b", order: 10, match: () => true, items: () => [{ id: "b1", label: "B" }] });
let assembled = MenuProviders.assemble(sel1, builtin);
await eq("插件条目追加在内建之后且按 order 排", assembled.map((i) => i.id), ["open", undefined, "trash", undefined, "b1", "a1"]);

// match 判定：类型/数量/位置都传进 sel，provider 自行决定
MenuProviders.registerProvider({ id: "img-only", match: (s) => s.items.every((i) => i.type === "file"), items: () => [{ id: "img", label: "图" }] });
await ok("文件 sel 命中", MenuProviders.assemble(sel1, builtin).some((i) => i.id === "img"));
await ok("文件夹 sel 不命中", !MenuProviders.assemble({ ...sel1, items: [{ path: "/桌面/d", name: "d", type: "folder" }] }, builtin).some((i) => i.id === "img"));

// 隔离：match / items 抛错不连累整份菜单
MenuProviders.registerProvider({ id: "bad-match", match: () => { throw new Error("boom"); }, items: () => [{ id: "x" }] });
MenuProviders.registerProvider({ id: "bad-items", match: () => true, items: () => { throw new Error("boom"); } });
assembled = MenuProviders.assemble(sel1, builtin);
await ok("抛错的 provider 被跳过", assembled.some((i) => i.id === "b1") && !assembled.some((i) => i.id === "x"));
await ok("首尾/连续分隔线收敛由渲染层处理，装配层只加一条", assembled.filter((i) => i.type === "separator").length, 2);

// 退订生效
offA();
await ok("退订后不再出现", !MenuProviders.assemble(sel1, builtin).some((i) => i.id === "a1"));
await ok("清单可读", MenuProviders.listProviders().length >= 3);

console.log(`${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
