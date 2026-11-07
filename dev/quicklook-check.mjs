/**
 * dev/quicklook-check.mjs — 第 3 期探针：Quick Look provider 注册表（评分、隔离、卸载）、
 * 内建 provider 的 match 覆盖面、系统应用可见性声明。DOM 部分（面板/渲染）走真机抽查。
 * 用法：`node dev/quicklook-check.mjs`（有问题退出码 1 并逐条列出）
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
globalThis.Blob = class Blob { constructor(p = [], o = {}) { this.parts = p; this.type = o.type || ""; } };
globalThis.File = class File extends Blob { constructor(p, n) { super(p); this.name = n; } };

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

const { QuickLook } = await import("../src/javascripts/core/quicklook.js");
const { getAppVisibility } = await import("../src/javascripts/app-registry.js");

/* ══ 一 系统应用可见性（Q5：启动台不可见、设置可见、不可卸载） ══ */

const vis = getAppVisibility("quicklook");
await eq("启动台不可见", vis.launchpad, false);
await eq("系统设置可见", vis.settings, true);
await eq("访达应用列表不可见", vis.finder, false);
await eq("系统应用标记", vis.system, true);
await eq("不可卸载", vis.uninstallable, false);

/* ══ 二 provider 注册与评分 ══ */

const stat = (name, type = "file") => ({ path: `/x/${name}`, name, type, size: 1, modified: 1, ext: (name.match(/\.([^.]+)$/) || [])[1] || "" });

await eq("图片命中内建图片 provider", QuickLook._pickProvider(stat("a.png")).id, "builtin.image");
await eq("文本命中内建文本 provider", QuickLook._pickProvider(stat("a.md")).id, "builtin.text");
await eq("PDF 命中内建 provider", QuickLook._pickProvider(stat("a.pdf")).id, "builtin.pdf");
await eq("音频命中内建 provider", QuickLook._pickProvider(stat("a.mp3")).id, "builtin.audio");
await eq("视频命中内建 provider", QuickLook._pickProvider(stat("a.mp4")).id, "builtin.video");
await eq("文件夹命中文件夹 provider", QuickLook._pickProvider(stat("dir", "folder")).id, "builtin.folder");
await eq("未知类型无 provider（回退通用预览）", QuickLook._pickProvider(stat("a.xyz")), null);

// 高分覆盖内建
const off1 = QuickLook.registerProvider({ id: "test.doc", match: (s) => (s.ext === "docx" ? 20 : 0), render: () => {} });
await eq("插件 provider 高分胜出", QuickLook._pickProvider(stat("a.docx")).id, "test.doc");
// match 抛错被隔离
QuickLook.registerProvider({ id: "test.bad", match: () => { throw new Error("boom"); }, render: () => {} });
await eq("抛错的 match 不连累选择", QuickLook._pickProvider(stat("a.png")).id, "builtin.image");
// 卸载回退
off1();
await eq("卸载后未知类型回退", QuickLook._pickProvider(stat("a.docx")), null);

// 参数校验
let threw = 0;
try { QuickLook.registerProvider({ match: () => 1, render: () => {} }); } catch { threw++; }
try { QuickLook.registerProvider({ id: "x", match: () => 1 }); } catch { threw++; }
await eq("缺 id / 缺 render 被拒", threw, 2);

console.log(`${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
