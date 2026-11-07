/**
 * dev/photos-check.mjs — 第 4 期探针：照片库 FS 后端（/Picture/ 扫描、导入落库、
 * 删除进废纸篓、缩略图进 AppData、外部挂载只读与越界拒绝）。不开浏览器。
 * 用法：`node dev/photos-check.mjs`（有问题退出码 1 并逐条列出）
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
    constructor(parts = [], opts = {}) { this.parts = Array.isArray(parts) ? parts : [parts]; this.type = opts.type || ""; this.size = typeof this.parts[0] === "string" ? this.parts[0].length : 1; }
};
globalThis.File = class File extends Blob {
    constructor(parts, name, opts = {}) { super(parts, opts); this.name = name; this.lastModified = 1700000000000; }
    async text() { return String(this.parts[0] ?? ""); }
};
let urlSeq = 0;
globalThis.URL.createObjectURL = () => `blob:fake-${++urlSeq}`;
globalThis.URL.revokeObjectURL = () => {};

class FakeFileHandle {
    constructor(name, body = "x") { this.kind = "file"; this.name = name; this.body = body; }
    getFile() { return Promise.resolve(new File([this.body], this.name)); }
}
class FakeDirHandle {
    constructor(name) { this.kind = "directory"; this.name = name; this.files = new Map(); this.subs = new Map(); }
    getDirectoryHandle(n) {
        if (!this.subs.has(n)) return Promise.reject(Object.assign(new Error(n), { name: "NotFoundError" }));
        return Promise.resolve(this.subs.get(n));
    }
    getFileHandle(n) {
        if (!this.files.has(n)) return Promise.reject(Object.assign(new Error(n), { name: "NotFoundError" }));
        return Promise.resolve(this.files.get(n));
    }
    async *entries() {
        for (const [k, v] of this.subs) yield [k, v];
        for (const [k, v] of this.files) yield [k, v];
    }
}

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
const throwsCode = async (label, fn, code) => {
    count++;
    try {
        await fn();
        fails++;
        console.log(`FAIL ${label}: 期望抛错但没有`);
    } catch (err) {
        if (err.code !== code) {
            fails++;
            console.log(`FAIL ${label}: err.code=${err.code} 期望 ${code}`);
        }
    }
};

const { FS } = await import("../src/javascripts/fs/index.js");
const { OSFS } = await import("../src/javascripts/osfs.js");
const { moveToTrash } = await import("../src/javascripts/trash.js");

/* Deskly 门面替身：与 os-api.js 的信封形状一致（ok/value/code/reason），
   scope 相对路径按 photos 沙箱解析——收口后的生产调用形态就是这样。 */
const okv = async (fn) => { try { return { ok: true, value: await fn() }; } catch (err) { return { ok: false, code: err.code || "EIO", reason: err.message }; } };
const scopeAbs = (rel) => `/AppData/photos/${String(rel).replace(/^\/+/, "")}`;
globalThis.window = {
    Deskly: {
        fs: {
            mkdirAt: (p) => okv(() => FS.mkdir(p)),
            writeAt: (p, d) => okv(() => FS.write(p, d)),
            walkAt: (p, d) => okv(() => FS.walk(d, p)),
            at: (p) => okv(async () => FS.read(p)),
            write: (rel, d) => okv(() => FS.write(scopeAbs(rel), d)),
            read: (rel) => okv(() => FS.read(scopeAbs(rel))),
            remove: (rel) => okv(() => FS.remove(scopeAbs(rel))),
            trash: { moveToTrash: (p) => okv(() => moveToTrash(p)) },
        },
    },
};

const store = await import("../mods/photos/photo-store.js");

/* ══ 一 建库与扫描 ══ */

await store.initStore();
await eq("建库：/Picture 就绪", await FS.exists("/Picture"), true);
// 缩略图目录惰性建（Deskly 沙箱写入自动补父级），在第三节随写入断言

await FS.write("/Picture/IMG_001.jpg", "jpeg-bytes");
await FS.write("/Picture/子相册/VID_002.mp4", "mp4-bytes");
await FS.write("/Picture/readme.txt", "不是媒体");
await FS.write("/文档/not-in-library.jpg", "out");

const scanned = await store.scanLibrary();
await eq("扫描只收媒体", scanned.map((f) => f.path).sort(), ["/Picture/IMG_001.jpg", "/Picture/子相册/VID_002.mp4"].sort());
await eq("扫描识别类型", scanned.find((f) => f.name === "VID_002.mp4").type, "video");
await eq("扫描不越出库根", scanned.some((f) => f.path.startsWith("/文档")), false);

/* ══ 二 导入与读取 ══ */

await store.putMedia("/Picture/imported.png", "png-bytes");
await eq("导入落 /Picture/", await (await FS.read("/Picture/imported.png")).text(), "png-bytes");
await eq("读媒体", await (await store.getMedia("/Picture/imported.png")).text(), "png-bytes");

// 对象 URL 引用计数
const u1 = await store.getMediaURL("/Picture/imported.png");
const u2 = await store.getMediaURL("/Picture/imported.png");
await eq("同 id 同 URL", u1, u2);
store.releaseMediaURL(u1 === u2 ? "/Picture/imported.png" : "");
store.releaseMediaURL("/Picture/imported.png");

/* ══ 三 缩略图（AppData，不污染库） ══ */

await store.putThumb("/Picture/imported.png", "thumb-bytes");
const t1 = await store.getThumbURL("/Picture/imported.png");
await ok("缩略图 URL 可用", typeof t1 === "string" && t1.startsWith("blob:"));
await ok("缩略图在 AppData", await FS.exists("/AppData/photos/data/thumbs/" + encodeURIComponent("/Picture/imported.png") + ".thumb"));
await eq("库目录没有缩略图旁文件", (await FS.list("/Picture")).filter((f) => f.name.endsWith(".thumb")).length, 0);

/* ══ 四 删除进废纸篓 ══ */

await store.deleteMedia(["/Picture/imported.png"]);
await eq("删除后库内消失", await FS.exists("/Picture/imported.png"), false);
await ok("删除后进 /废纸篓/", (await FS.list("/废纸篓")).some((f) => f.name === "imported.png"));
await ok("废纸篓有溯源伴生", (await FS.list("/废纸篓", { includeHidden: true })).some((f) => f.name.endsWith(".deskly-origin")));
await eq("缩略图随删除清理", await FS.exists("/AppData/photos/data/thumbs/" + encodeURIComponent("/Picture/imported.png") + ".thumb"), false);

/* ══ 五 外部挂载（只读 + 越界拒绝） ══ */

const extRoot = new FakeDirHandle("我的图片");
extRoot.files.set("DSC_01.jpg", new FakeFileHandle("DSC_01.jpg", "ext-jpg"));
const extSub = new FakeDirHandle("旅行");
extSub.files.set("VID_99.mov", new FakeFileHandle("VID_99.mov", "ext-mov"));
extSub.files.set("notes.txt", new FakeFileHandle("notes.txt", "txt"));
extRoot.subs.set("旅行", extSub);

const mount = await store.addExternalMount(extRoot, { mode: "read" });
await eq("挂载返回 id 与只读", [mount.name, mount.mode], ["我的图片", "read"]);

const extItems = await store.scanExternalMount(mount.id);
await eq("外部扫描只收媒体（含子目录）", extItems.map((f) => f.name).sort(), ["DSC_01.jpg", "VID_99.mov"]);
await ok("外部 id 带 ext:// 前缀", extItems.every((f) => f.id.startsWith("ext://")));

await eq("外部媒体可读", await (await store.getMedia(extItems.find((f) => f.name === "DSC_01.jpg").id)).text(), "ext-jpg");
await throwsCode("外部项目禁止写入", () => store.putMedia(extItems[0].id, "x"), "EREADONLY");
await throwsCode("外部项目禁止删除", () => store.deleteMedia([extItems[0].id]), "EREADONLY");
await throwsCode("伪造 ext id 同样被拒", () => store.putMedia("ext://m1/fake.jpg", "x"), "EREADONLY");

console.log(`${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
