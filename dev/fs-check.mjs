/**
 * dev/fs-check.mjs — 第 1 期文件系统层探针：原子写提交/回滚、错误码归一、
 * 只读视图、fs-changed 事件、隐藏名过滤、暂存行清扫。复用 osfs-check 的替身口径。
 * 用法：`node dev/fs-check.mjs`（有问题退出码 1 并逐条列出）
 */

const KEY_PATHS = { virtualfiles: "path", handles: "key" };

/* ── 替身：IndexedDB（带故障注入） ── */

function makeFakeIdb() {
    const dbs = new Map();
    return {
        /** 置位后下一个事务的 put 抛错（模拟配额满/硬件故障）。 */
        __failNextPut: false,
        open(name) {
            if (!dbs.has(name)) dbs.set(name, new Map());
            const tables = dbs.get(name);
            if (!tables.has("virtualfiles")) tables.set("virtualfiles", new Map());
            if (!tables.has("handles")) tables.set("handles", new Map());
            const idb = this;
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
                            put: (row) => {
                                if (idb.__failNextPut) { idb.__failNextPut = false; throw new DOMException("配额满", "QuotaExceededError"); }
                                map.set(row[keyPath], row); return { result: undefined };
                            },
                            get: (k) => { const r = { result: map.get(k) }; queueMicrotask(() => r.onsuccess?.()); return r; },
                            getAll: () => { const r = { result: [...map.values()] }; queueMicrotask(() => r.onsuccess?.()); return r; },
                            delete: (k) => { map.delete(k); return { result: undefined }; },
                            clear: () => { map.clear(); return { result: undefined }; },
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

const sizeOf = (d) => (typeof d === "string" ? d.length
    : d instanceof Uint8Array ? d.byteLength
        : d && typeof d.size === "number" ? d.size : 0);

globalThis.indexedDB = makeFakeIdb();
globalThis.window = {};
const LS = new Map();
globalThis.localStorage = {
    getItem: (k) => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, v),
    removeItem: (k) => LS.delete(k),
};
globalThis.Blob = class Blob {
    constructor(parts = [], opts = {}) {
        this.parts = Array.isArray(parts) ? parts : [parts];
        this.type = opts.type || "";
        this.size = sizeOf(this.parts[0]);
    }
};
globalThis.File = class File extends Blob {
    constructor(parts, name, opts = {}) {
        super(parts, opts);
        this.name = name;
        this.lastModified = 1700000000000;
    }
    async text() {
        let part = this.parts[0];
        if (part && typeof part.text === "function") part = await part.text();
        return String(part ?? "");
    }
    arrayBuffer() { return Promise.resolve(new Uint8Array([1]).buffer); }
};

class HandleError extends Error {
    constructor(name, message) { super(message); this.name = name; }
}

class FakeFileHandle {
    constructor(name) { this.kind = "file"; this.name = name; this.body = ""; }
    getFile() { return Promise.resolve(new File([this.body], this.name)); }
    createWritable() {
        const fail = this.failClose;
        return Promise.resolve({
            write: (d) => { this.body = d; return Promise.resolve(); },
            close: () => fail ? Promise.reject(new HandleError("NoModificationAllowedError", "close 失败")) : Promise.resolve(),
        });
    }
}

class FakeDirHandle {
    constructor(name, perms) {
        this.kind = "directory"; this.name = name;
        this.files = new Map(); this.subs = new Map();
        this.perms = perms || { readwrite: "granted" };
    }
    queryPermission() { return Promise.resolve(this.perms.readwrite); }
    requestPermission() { return Promise.resolve(this.perms.readwrite); }
    getDirectoryHandle(n, o = {}) {
        if (!this.subs.has(n)) {
            if (!o.create) return Promise.reject(new HandleError("NotFoundError", n));
            this.subs.set(n, new FakeDirHandle(n, this.perms));
        }
        return Promise.resolve(this.subs.get(n));
    }
    getFileHandle(n, o = {}) {
        if (!this.files.has(n)) {
            if (!o.create) return Promise.reject(new HandleError("NotFoundError", n));
            this.files.set(n, new FakeFileHandle(n));
        }
        return Promise.resolve(this.files.get(n));
    }
    removeEntry(n, o = {}) {
        if (this.subs.has(n)) {
            const d = this.subs.get(n);
            if (!o.recursive && (d.subs.size || d.files.size)) {
                return Promise.reject(new HandleError("InvalidStateError", n));
            }
            this.subs.delete(n);
        } else if (this.files.has(n)) this.files.delete(n);
        else return Promise.reject(new HandleError("NotFoundError", n));
        return Promise.resolve();
    }
    async *entries() {
        for (const [k, v] of this.subs) yield [k, v];
        for (const [k, v] of this.files) yield [k, v];
    }
}

/* ── 断言器 ── */

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
            console.log(`FAIL ${label}: err.code=${err.code} (${err.name}: ${err.message}) 期望 ${code}`);
        }
    }
};

const { OSFS } = await import("../src/javascripts/osfs.js");
const { FS } = await import("../src/javascripts/fs/index.js");

/* ══ 一 虚拟后端原子写 ══ */

await OSFS.init();

await FS.write("/文档/a.md", "v1");
await eq("虚拟：写入可读", await (await FS.read("/文档/a.md")).text(), "v1");
await FS.write("/文档/a.md", "v2");
await eq("虚拟：覆盖后是新内容", await (await FS.read("/文档/a.md")).text(), "v2");
await eq("虚拟：列表无暂存残留",
    (await FS.list("/文档")).filter((e) => /\.deskly(tmp|bak)-/.test(e.name)).length, 0);
await eq("虚拟：库里也无暂存残留",
    [...globalThis.indexedDB.__table("webstartos-vfs", "virtualfiles").keys()]
        .filter((k) => /\.deskly(tmp|bak)-/.test(k)).length, 0);

// 提交事务失败：旧内容不变、暂存行被回滚清掉
globalThis.indexedDB.__failNextPut = true;   // 先失败的是暂存写入
await throwsCode("虚拟：暂存写失败抛 EQUOTA", () => FS.write("/文档/a.md", "v3"), "EQUOTA");
await eq("虚拟：失败后旧内容不变", await (await FS.read("/文档/a.md")).text(), "v2");
await eq("虚拟：失败无暂存残留",
    [...globalThis.indexedDB.__table("webstartos-vfs", "virtualfiles").keys()]
        .filter((k) => /\.deskly(tmp|bak)-/.test(k)).length, 0);

// 崩溃残留的暂存行：手工塞一行，重启 init 应被清扫
globalThis.indexedDB.__table("webstartos-vfs", "virtualfiles")
    .set("/文档/crash.md.desklytmp-1", { path: "/文档/crash.md.desklytmp-1", name: "crash.md.desklytmp-1", kind: "file", data: "half" });
await eq("暂存行对列表不可见（索引过滤）", (await FS.list("/文档")).map((e) => e.name), ["a.md"]);
await ok("暂存行 stat 不可见", !(await FS.stat("/文档/crash.md.desklytmp-1")));
// init 幂等但不能在本进程重跑（ready 缓存），清扫逻辑直接断言过滤即可，
// 进程级清扫由下一次冷启动完成——这里验证谓词本身：
await ok("isHiddenName 认出暂存名", FS.isHiddenName("x.md.desklytmp-123") && FS.isHiddenName("x.md.desklybak-1"));
await ok("isHiddenName 认出 .DS_Store", FS.isHiddenName(".DS_Store") && FS.isHiddenName(".ds_store"));
await ok("isHiddenName 放过正常文件", !FS.isHiddenName("a.md"));

// .DS_Store 隐藏：手工塞一行，等索引 TTL 过期重建后，列表/walk 都看不见
globalThis.indexedDB.__table("webstartos-vfs", "virtualfiles")
    .set("/桌面/.DS_Store", { path: "/桌面/.DS_Store", name: ".DS_Store", kind: "file", data: "{}", modified: 1, size: 2 });
await new Promise((r) => setTimeout(r, 1100));   // 等 INDEX_TTL 过期，让重建的索引含这行
await eq(".DS_Store 不进列表", (await FS.list("/桌面")).map((e) => e.name), []);
await ok(".DS_Store 不进 walk", !(await FS.walk(2, "/桌面")).some((e) => e.name === ".DS_Store"));
await ok(".DS_Store stat 默认不可见", !(await FS.stat("/桌面/.DS_Store")));
await ok(".DS_Store read 默认读不到", !(await FS.read("/桌面/.DS_Store")));
await ok(".DS_Store stat 内核可见（includeHidden）", !!(await FS.stat("/桌面/.DS_Store", { includeHidden: true })));
await eq("includeHidden 时可见（内核自用）", (await FS.list("/桌面", { includeHidden: true })).map((e) => e.name), [".DS_Store"]);

/* ══ 一·补 撤销「新建」：项目真被删除 + 坐标回收 ══ */
// 注意：/桌面/.DS_Store 已被上一条断言行成「外来格式」，这里换目录验证坐标链路本身

const { DSStore } = await import("../src/javascripts/fs/dsstore.js");
await FS.mkdir("/下载/坐标测试");
await FS.mkdir("/下载/坐标测试/新建文件夹");
await DSStore.setPosition("/下载/坐标测试", "新建文件夹", { x: 40, y: 60 });
await eq("新建：文件夹真的建出来了", (await FS.list("/下载/坐标测试")).map((e) => e.name), ["新建文件夹"]);
await eq("新建：坐标已落盘", (await DSStore.read("/下载/坐标测试")).positions["新建文件夹"], { x: 40, y: 60 });
await FS.remove("/下载/坐标测试/新建文件夹", { recursive: false });
await ok("撤销新建：文件夹被真删除", !(await FS.exists("/下载/坐标测试/新建文件夹")));
await DSStore.prune("/下载/坐标测试", (await FS.list("/下载/坐标测试")).map((e) => e.name));
await ok("撤销新建：坐标已回收", !("新建文件夹" in (await DSStore.read("/下载/坐标测试")).positions));

// 非空文件夹拒绝删除（撤销失败时如实提示，不为了撤销去毁用户后来放进来的内容）
await FS.mkdir("/下载/坐标测试/已有内容");
await FS.write("/下载/坐标测试/已有内容/inside.txt", "x");
await throwsCode("撤销新建：非空文件夹拒绝删除", () => FS.remove("/下载/坐标测试/已有内容", { recursive: false }), "EPERM");
await ok("撤销新建：非空文件夹内容仍在", await FS.exists("/下载/坐标测试/已有内容/inside.txt"));
await FS.remove("/下载/坐标测试", { recursive: true });

/* ══ 二 错误码归一（虚拟后端） ══ */

await FS.write("/文档/clash.md", "x");
await throwsCode("move 重名 → EEXIST", () => FS.move("/文档/clash.md", "/文档/a.md"), "EEXIST");
await throwsCode("删顶层夹 → EPERM", () => FS.remove("/文档"), "EPERM");
await throwsCode("写目录路径 → EISDIR", () => FS.write("/文档", "x"), "EISDIR");
await throwsCode("rename 不存在 → ENOENT", () => FS.rename("/文档/ghost.md", "g2.md"), "ENOENT");
await eq("rename 正常路径", await FS.rename("/文档/clash.md", "renamed.md"), "/文档/renamed.md");
await eq("rename 正文跟随", await (await FS.read("/文档/renamed.md")).text(), "x");
await eq("copy 文件", await FS.copy("/文档/renamed.md", "/文档/copy.md"), "/文档/copy.md");
await eq("copy 正文一致", await (await FS.read("/文档/copy.md")).text(), "x");
await throwsCode("copy 目标已存在 → EEXIST", () => FS.copy("/文档/renamed.md", "/文档/a.md"), "EEXIST");
await throwsCode("copy 源不存在 → ENOENT", () => FS.copy("/文档/ghost.md", "/文档/g.md"), "ENOENT");
await eq("copy 目录递归", await FS.copy("/文档", "/下载/文档备份"), "/下载/文档备份");
await ok("copy 目录内容齐全", (await FS.list("/下载/文档备份")).some((e) => e.name === "a.md"));
await throwsCode("copy 进自己 → EPERM", () => FS.copy("/下载/文档备份", "/下载/文档备份/in"), "EPERM");

/* ══ 三 fs-changed / watch ══ */

const seen = [];
const offDoc = FS.watch("/文档", (d) => seen.push(d));
await FS.write("/文档/watched.md", "w");
await FS.write("/下载/elsewhere.md", "x");
await ok("watch 收到子树事件", seen.length === 1 && seen[0].op === "write" && seen[0].paths.includes("/文档/watched.md"));
offDoc();
await FS.write("/文档/watched2.md", "w");
await eq("退订后不再收", seen.length, 1);

/* ══ 四 只读视图 ══ */

const ro = FS.readOnly("外部图片夹为只读挂载");
await eq("只读：list 可用", (await ro.list("/文档")).length > 0, true);
await throwsCode("只读：write 被拒", () => ro.write("/文档/x.md", "x"), "EREADONLY");
await throwsCode("只读：remove 被拒", () => ro.remove("/文档/a.md"), "EREADONLY");
await throwsCode("只读：move 被拒", () => ro.move("/文档/a.md", "/文档/b.md"), "EREADONLY");
await throwsCode("只读：copy 被拒", () => ro.copy("/文档/a.md", "/文档/b.md"), "EREADONLY");
await throwsCode("只读：rename 被拒", () => ro.rename("/文档/a.md", "b.md"), "EREADONLY");

/* ══ 五 磁盘后端：原子写与移动 ══ */

const fakeRoot = new FakeDirHandle("DesklyRoot");
globalThis.window = { showDirectoryPicker: async () => fakeRoot };
await FS.write("/文档/pre-mount.md", "before");
await OSFS.mount();

await FS.write("/文档/d.md", "d1");
const docsDir = fakeRoot.subs.get("文档");
await eq("磁盘：写入落句柄", docsDir.files.has("d.md"), true);
await eq("磁盘：无暂存残留", [...docsDir.files.keys()].filter((k) => /\.deskly(tmp|bak)-/.test(k)).length, 0);
await eq("磁盘：铺写文件仍在", docsDir.files.has("pre-mount.md"), true);

await FS.write("/文档/d.md", "d2");
await eq("磁盘：覆盖后是新内容", await (await FS.read("/文档/d.md")).text(), "d2");
await eq("磁盘：覆盖无暂存/备份残留",
    [...docsDir.files.keys()].filter((k) => /\.deskly(tmp|bak)-/.test(k)).length, 0);

// 暂存件 close 失败：目标不变、暂存清掉
docsDir.files.set("victim.md", (() => { const f = new FakeFileHandle("victim.md"); f.body = "old"; return f; })());
const origCreate = FakeFileHandle.prototype.createWritable;
FakeFileHandle.prototype.createWritable = function () {
    if (this.name.includes(".desklytmp-")) { this.failClose = true; }
    return origCreate.call(this);
};
await throwsCode("磁盘：暂存写失败抛错", () => FS.write("/文档/victim.md", "new"), "EIO");
FakeFileHandle.prototype.createWritable = origCreate;
await eq("磁盘：失败目标内容不变", await (await FS.read("/文档/victim.md")).text(), "old");
await eq("磁盘：失败后无暂存残留",
    [...docsDir.files.keys()].filter((k) => /\.deskly(tmp|bak)-/.test(k)).length, 0);

// 移动：无原生 move 的退化路径 + 中途失败回滚
await FS.write("/文档/mv-src.md", "body");
await eq("磁盘：移动成功", await FS.move("/文档/mv-src.md", "/文档/mv-dst.md"), "/文档/mv-dst.md");
await eq("磁盘：移动后源消失", docsDir.files.has("mv-src.md"), false);
await eq("磁盘：移动后目标在", docsDir.files.has("mv-dst.md"), true);

// 移动中途失败（先备好源，再让目标暂存写失败）→ 半成品清掉、源保留
await FS.write("/文档/keep.md", "keep");
FakeFileHandle.prototype.createWritable = function () {
    if (this.name.includes(".desklytmp-")) { this.failClose = true; }
    return origCreate.call(this);
};
await throwsCode("磁盘：移动中途失败抛错", () => FS.move("/文档/keep.md", "/文档/keep-moved.md"), "EIO");
FakeFileHandle.prototype.createWritable = origCreate;
await ok("磁盘：移动失败源还在", await FS.exists("/文档/keep.md"));
await ok("磁盘：移动失败无半成品", !(await FS.exists("/文档/keep-moved.md")));

// 权限过期 → EREAUTH
fakeRoot.perms.readwrite = "prompt";
await throwsCode("磁盘：权限过期 list → EREAUTH", () => FS.list("/文档"), "EREAUTH");
await throwsCode("磁盘：权限过期 write → EREAUTH", () => FS.write("/文档/x.md", "x"), "EREAUTH");
fakeRoot.perms.readwrite = "granted";
await OSFS.reauthorize();

/* ══ 六 越界与 boundaryKey 复用 ══ */

await ok("boundaryKey 是 osfs 同一个函数", FS.boundaryKey === OSFS.boundaryKey);
await ok("越界判定复用：他人 AppData", FS.isOtherAppData("/AppData/office/x", "notepad"));
await ok("越界判定复用：大小写变体", FS.isOtherAppData("/appdata/office/x", "notepad"));
await ok("越界判定复用：自己不越界", !FS.isOtherAppData("/AppData/notepad/x", "notepad"));

console.log(`${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
