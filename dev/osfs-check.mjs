/**
 * dev/osfs-check.mjs — 存储内核 osfs.js 的磁盘级回归检查（IndexedDB 替身 + 假 FileSystemDirectoryHandle）。
 * 不开浏览器：权威校验一律走磁盘，且浏览器实测有 `?v=Date.now()` 假 404、扩展页视口 0×0 两个已知坑。
 * 覆盖：一 路径/作用域纯函数　二 virtual 后端　三 disk 后端（挂载、铺写、权限过期不静默回落、取消挂载不删磁盘）。
 * 用法：`node dev/osfs-check.mjs`（有问题退出码 1 并逐条列出）
 */

const KEY_PATHS = { virtualfiles: "path", handles: "key" };

/* ── 替身 ── */

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
globalThis.window = {};                       // 阶段三换成带 picker 的版本
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
// File 必须是 Blob 的子类：磁盘后端靠 `data instanceof Blob` 认二进制，替身不像真的话
// 「复制再删源」那条路径会退化成 String(data)，测出来的是替身的毛病而不是内核的。
globalThis.File = class File extends Blob {
    constructor(parts, name, opts = {}) {
        super(parts, opts);
        this.name = name;
        this.lastModified = 1700000000000;
    }
    async text() {
        let part = this.parts[0];
        if (part && typeof part.text === "function") part = await part.text();   // 套了层的复制结果
        return String(part ?? "");
    }
    arrayBuffer() { return Promise.resolve(new Uint8Array([1]).buffer); }
};

/** 真实句柄抛的是 DOMException（按 name 判别），替身必须照抄，否则错误分支测不到。 */
class HandleError extends Error {
    constructor(name, message) { super(message); this.name = name; }
}

/** 假目录句柄：只实现 osfs 用到的那几个方法，权限可切换。 */
class FakeFileHandle {
    constructor(name) { this.kind = "file"; this.name = name; this.body = ""; }
    getFile() {
        const self = this;
        return Promise.resolve(new File([self.body], self.name));
    }
    createWritable() {
        const self = this;
        return Promise.resolve({ write: (d) => { self.body = d; return Promise.resolve(); }, close: () => Promise.resolve() });
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
            this.subs.set(n, new FakeDirHandle(n, this.perms));   // 子句柄共享同一份权限表
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
const throws = async (label, fn, wantName) => {
    count++;
    try {
        await fn();
        fails++;
        console.log(`FAIL ${label}: 期望抛错但没有`);
    } catch (err) {
        if (wantName && err.name !== wantName) {
            fails++;
            console.log(`FAIL ${label}: err.name=${err.name} 期望 ${wantName}`);
        }
    }
};

const { OSFS } = await import("../src/javascripts/osfs.js");
const { VFS } = await import("../src/javascripts/vfs.js");

/* ══ 一 路径与作用域 ══ */
// 这一层的错误会直接变成写错地方或越界读到别的插件，所以逐条钉住。

await eq("规范化：根与空串", [OSFS.normalizePath("/"), OSFS.normalizePath("")], ["/", "/"]);
await eq("规范化：折叠斜杠", OSFS.normalizePath("//文档//x.md"), "/文档/x.md");
await eq("规范化：点段", OSFS.normalizePath("/文档/./x.md"), "/文档/x.md");
await eq("规范化：上级", OSFS.normalizePath("/文档/../图片"), "/图片");
await eq("规范化：越出根后被截断", OSFS.normalizePath("/下载/../.."), "/");
await eq("拆分", OSFS.segments("/AppData/notepad/temp/a.json"), ["AppData", "notepad", "temp", "a.json"]);
await eq("父级", OSFS.parentOf("/AppData/notepad/temp/a.json"), "/AppData/notepad/temp");
await eq("父级：一层就是根", OSFS.parentOf("/x.md"), "/");
await eq("拼接：根下", OSFS.joinPath("/", "文档"), "/文档");
await eq("拼接：多层", OSFS.joinPath("/文档", "a/b"), "/文档/a/b");
await eq("越界判定：自身算内部", OSFS.inside("/AppData/notepad", "/AppData/notepad"), true);
await eq("越界判定：前缀陷阱", OSFS.inside("/AppData/notepad-evil/x", "/AppData/notepad"), false);
await eq("越界判定：兄弟插件", OSFS.inside("/AppData/office/x", "/AppData/notepad"), false);
await eq("消毒：路径分隔符", OSFS.sanitizeName("a/b\\c"), "abc");
await eq("消毒：前导点", OSFS.sanitizeName("..secret"), "secret");
await eq("消毒：空名回退", OSFS.sanitizeName("   ", "未命名文件夹"), "未命名文件夹");
await eq("消毒：限长 60", OSFS.sanitizeName("x".repeat(90)).length, 60);
await eq("作用域：目录", OSFS.scope("notepad").path, "/AppData/notepad");
await eq("作用域：不带参数得子目录本身", OSFS.scope("notepad").temp(), "/AppData/notepad/temp");
await eq("作用域：带参数得子路径", OSFS.scope("notepad").config("layout.json"), "/AppData/notepad/config/layout.json");
await throws("作用域：`..` 逃不出去", () => OSFS.scope("notepad").write("../../文档/x.md", "x"));
await throws("作用域：写不进别的插件", () => OSFS.scope("notepad").write("../office/x", "x"));

/* ══ 二 virtual 后端 ══ */

await OSFS.init();
await eq("骨架：根下六个顶层夹", (await OSFS.list("/")).map((e) => e.name).sort(),
    ["AppData", "图片", "下载", "文档", "桌面", "废纸篓"].sort());
await eq("骨架：都是目录", (await OSFS.list("/")).every((e) => e.type === "folder"), true);
await eq("默认后端", OSFS.status().backend, "virtual");
await eq("默认无 picker 时 supported=false", OSFS.status().supported, false);

await OSFS.write("/文档/a/b/c.md", "hi");
await eq("列举只给直接子代", (await OSFS.list("/文档")).map((e) => e.name), ["a"]);
await eq("中间层列举", (await OSFS.list("/文档/a")).map((e) => e.name), ["b"]);
await eq("写目录自动补父级", (await OSFS.list("/文档/a/b")).map((e) => e.name), ["c.md"]);
await eq("文件条目字段", (await OSFS.list("/文档/a/b")).map((e) => [e.type, e.size, Number.isFinite(e.modified)])[0],
    ["file", 2, true]);
await eq("读正文", (await (await OSFS.read("/文档/a/b/c.md")).text()), "hi");
await eq("读目录返回 null", await OSFS.read("/文档/a"), null);
await eq("读缺失返回 null", await OSFS.read("/文档/a/nope.md"), null);
await eq("存在：文件", await OSFS.exists("/文档/a/b/c.md"), true);
await eq("存在：目录", await OSFS.exists("/文档/a"), true);
await eq("存在：缺失", await OSFS.exists("/文档/z.md"), false);

await OSFS.write("/文档/z.md", "z");
await OSFS.mkdir("/文档/mdir");
await eq("排序：目录在前", (await OSFS.list("/文档")).map((e) => e.type), ["folder", "folder", "file"]);

await throws("非空目录拒绝删除", () => OSFS.remove("/文档/a"));
await eq("递归删除", await OSFS.remove("/文档/a", { recursive: true }), true);
await eq("删干净了", (await OSFS.list("/文档")).map((e) => e.name), ["mdir", "z.md"]);
await throws("拒删顶层夹", () => OSFS.remove("/文档"));
await throws("拒删根", () => OSFS.remove("/"));
await eq("删文件", await OSFS.remove("/文档/z.md"), true);
await eq("删不存在的返回 false", await OSFS.remove("/文档/ghost.md"), false);

await OSFS.write("/下载/pkg.docx", new Uint8Array([1, 2, 3]));
await eq("二进制条目大小", (await OSFS.list("/下载"))[0].size, 3);

const notepad = OSFS.scope("notepad");
await notepad.ensure();
await eq("插件作用域预建三个子目录", (await OSFS.list(notepad.path)).map((e) => e.name).sort(), ["config", "data", "temp"]);
await notepad.write("temp/keep.json", "{}");
await eq("缓存落在自己的 temp 里", (await OSFS.list(notepad.temp())).map((e) => e.name), ["keep.json"]);
await notepad.clearTemp();
await eq("清空缓存后 temp 为空", (await OSFS.list(notepad.temp())).length, 0);
await eq("清空缓存后 temp 目录还在", await OSFS.exists(notepad.temp()), true);

await eq("walk 只收文件", (await OSFS.walk(3)).every((e) => e.type === "file"), true);
await notepad.write("temp/deep.json", "{}");
await eq("walk 深度 1 收不到孙代", (await OSFS.walk(1)).map((e) => e.path), ["/下载/pkg.docx"]);
await eq("walk 深度 3 能进插件目录", (await OSFS.walk(3)).map((e) => e.path).sort(),
    ["/AppData/notepad/temp/deep.json", "/下载/pkg.docx"].sort());

// 旧版 addVirtualFile 写的是 {path,name,content}（没有 kind），内核必须继续读得懂
globalThis.indexedDB.__table("webstartos-vfs", "virtualfiles")
    .set("/桌面/legacy.md", { path: "/桌面/legacy.md", name: "legacy.md", content: "old body", modified: 123 });
await eq("旧行正文仍可读", (await (await OSFS.read("/桌面/legacy.md")).text()), "old body");
await eq("stat 能认出索引之外的外来行", (await OSFS.stat("/桌面/legacy.md")).type, "file");
// 元数据索引最坏有一个 TTL（1 秒）的新鲜度损失：绕过内核直接写库（≈另一个标签页刚建的行）
// 要到索引重建时才可见。这个窗口不做成断言——它依赖 elapsed time，跑多快都可能在两边翻车；
// 钉住能确定的那一半：外来行最终一定会出现，且新写入立刻反映在列表里。
await eq("外来行会在索引重建后出现", (await OSFS.list("/桌面")).map((e) => e.name), ["legacy.md"]);
await OSFS.write("/桌面/fresh.md", "n");
await eq("本地写入立即生效（不等 TTL）", (await OSFS.list("/桌面")).map((e) => e.name), ["fresh.md", "legacy.md"]);
await eq("旧行大小取字符串长度", (await OSFS.list("/桌面")).find((e) => e.name === "legacy.md").size, 8);
await eq("stat 缺失", await OSFS.stat("/桌面/nope.md"), null);

/* 顶层夹守卫必须扛住大小写与尾点：Windows/APFS 上 /appdata 就是 /AppData，
   严格字符串比较会被绕过，后果是把整个插件数据区删掉。 */
await throws("拒删顶层夹（大小写变体）", () => OSFS.remove("/appdata", { recursive: true }));
await throws("拒删顶层夹（尾点变体）", () => OSFS.remove("/文档."));
await throws("拒删根（尾斜杠变体）", () => OSFS.remove("/"));

/* 作用域的两个 API 陷阱：绝对路径喂回去会双重前缀，漏传参数会拼出 temp/undefined。 */
const trap = OSFS.scope("trap");
await eq("temp(undefined) 得到目录本身", trap.temp(undefined), "/AppData/trap/temp");
await eq("绝对路径喂回去不双重前缀", trap.resolve(trap.temp("a.json")), "/AppData/trap/temp/a.json");
await trap.ensure();
await trap.write(trap.temp("a.json"), "{}");
await eq("写在自己 temp 里（绝对路径入参）", (await trap.list("temp")).map((e) => e.name), ["a.json"]);
await eq("没有双重前缀的幽灵目录", await trap.exists("/AppData/trap/AppData"), false);

/* 门面：界面依赖的几条约定 */
await eq("门面根目录=六个顶层夹+收藏夹+最近使用", (await VFS.list("/")).map((e) => e.path),
    ["/文档", "/下载", "/图片", "/桌面", "/AppData", "/废纸篓", "/收藏夹", "/最近使用"]);
await eq("收藏夹标为书签根", (await VFS.list("/")).find((e) => e.path === "/收藏夹").bookmarkRoot, true);
await eq("AppData 标为内部目录", (await VFS.list("/")).find((e) => e.path === "/AppData").internal, true);
await eq("最近使用是虚拟节点", (await VFS.list("/最近使用")).every((e) => e.type === "file"), true);
await eq("最近使用不混进插件缓存",
    (await VFS.getRecentFiles(20)).some((e) => e.path.startsWith("/AppData/")), false);
await eq("最近使用收得到真实文档", (await VFS.getRecentFiles(20)).some((e) => e.path === "/桌面/legacy.md"), true);
await eq("readFile 不读书签", await VFS.readFile("/收藏夹/某书签"), null);
await eq("门面未挂载时的授权态", VFS.getAuthStatus().status, "pending");
// 契约变更：whereStored 只返回结构化状态，成品文案由界面层按 kind 取 i18n 键 ——
// 数据层返回中文会漏出 i18n 红线（vfs.js whereStored 的注释写明了原因）。
await eq("whereStored 报虚拟后端", VFS.whereStored(), { kind: "virtual", name: "" });
await eq("顶层夹带显示名", VFS.TOP_FOLDERS.desktop.label, "桌面");
await eq("废纸篓也带显示名", VFS.TOP_FOLDERS.trash.label, "废纸篓");

/* move：重命名与移动在桌面/访达里是同一件事，两个后端语义必须一致 */
await OSFS.write("/文档/rename-me.md", "body");
await eq("移动文件返回目标路径", await OSFS.move("/文档/rename-me.md", "/文档/renamed.md"), "/文档/renamed.md");
await eq("源已不存在", await OSFS.exists("/文档/rename-me.md"), false);
await eq("正文跟到新路径", (await (await OSFS.read("/文档/renamed.md")).text()), "body");
await OSFS.write("/文档/clash.md", "x");
await throws("目标重名抛 ConflictError", () => OSFS.move("/文档/renamed.md", "/文档/clash.md"), "ConflictError");
await eq("冲突后原件仍在", await OSFS.exists("/文档/renamed.md"), true);
await OSFS.write("/文档/box/deep/inner.txt", "i");
await eq("移动目录连子孙", await OSFS.move("/文档/box", "/桌面/box"), "/桌面/box");
await eq("子孙跟到新前缀", (await OSFS.list("/桌面/box")).map((e) => e.name), ["deep"]);
await eq("子孙正文可读", (await (await OSFS.read("/桌面/box/deep/inner.txt")).text()), "i");
await eq("旧前缀整体消失", await OSFS.exists("/文档/box"), false);
await throws("不能把目录移进它自己", () => OSFS.move("/桌面/box", "/桌面/box/in"));
await throws("不能移动顶层夹", () => OSFS.move("/文档", "/文档2"));
await eq("源不存在返回 false", await OSFS.move("/文档/ghost.md", "/文档/x.md"), false);
await eq("废纸篓接收移入项", await OSFS.move("/文档/clash.md", "/废纸篓/clash.md"), "/废纸篓/clash.md");
await eq("清倒废纸篓=删子项", await OSFS.remove("/废纸篓/clash.md"), true);
await throws("废纸篓是顶层夹、本身删不掉", () => OSFS.remove("/废纸篓"));
await throws("作用域内移动也不许越界", () => notepad.move("temp/deep.json", "../../文档/out.json"));
await OSFS.remove("/文档/renamed.md");   // 收尾：别把残料留给后面的挂载铺写断言

/* ══ 三 disk 后端 ══ */

const fakeRoot = new FakeDirHandle("DesklyRoot");
globalThis.window = { showDirectoryPicker: async () => fakeRoot };
await OSFS.write("/文档/note.md", "hello");        // 挂载前先有内容，验证会被铺写

const mounted = await OSFS.mount();
await eq("挂载后后端切到 disk", mounted.backend, "disk");
await eq("挂载后记住目录名", mounted.mountName, "DesklyRoot");
await eq("挂载即建真实骨架", [...fakeRoot.subs.keys()].sort(), ["AppData", "图片", "下载", "文档", "桌面", "废纸篓"].sort());
await eq("挂载前虚拟内容被铺写", [...fakeRoot.subs.get("文档").files.keys()], ["note.md"]);
await eq("铺写成功才让位（读到的还是那份）", (await (await OSFS.read("/文档/note.md")).text()), "hello");

await OSFS.write("/文档/sub/deep.txt", "abc");
await eq("深层目录真实创建", [...fakeRoot.subs.get("文档").subs.get("sub").files.keys()], ["deep.txt"]);
await eq("真实目录列举", (await OSFS.list("/文档")).map((e) => `${e.name}/${e.type}`).sort(),
    ["mdir/folder", "note.md/file", "sub/folder"]);
await eq("列举只看直接子代", (await OSFS.list("/文档/sub")).map((e) => e.name), ["deep.txt"]);
await eq("二进制落真实目录", await OSFS.write("/下载/bin.docx", new Uint8Array([1, 2, 3, 4])), "/下载/bin.docx");
await eq("二进制确实写进了句柄", [...fakeRoot.subs.get("下载").files.keys()], ["pkg.docx", "bin.docx"]);

// 两个后端对同一件事必须给同一种信号，否则调用方必然漏一支
await throws("磁盘：非空目录拒绝删除", () => OSFS.remove("/文档/sub", { recursive: false }));
await eq("磁盘：递归删除", await OSFS.remove("/文档/sub", { recursive: true }), true);
await eq("磁盘：递归删掉了真实子文件", fakeRoot.subs.get("文档").subs.has("sub"), false);
await eq("磁盘：删不存在的返回 false", await OSFS.remove("/文档/ghost.md"), false);

const office = OSFS.scope("office");
await office.ensure();
await office.write("temp/render.bin", new Uint8Array([9]));
await eq("作用域在真实目录里建结构", [...fakeRoot.subs.get("AppData").subs.get("office").subs.keys()].sort(), ["config", "data", "temp"]);
await eq("缓存文件落在 temp", [...fakeRoot.subs.get("AppData").subs.get("office").subs.get("temp").files.keys()], ["render.bin"]);
await office.clearTemp();
await eq("清空缓存删掉真实文件", [...fakeRoot.subs.get("AppData").subs.get("office").subs.get("temp").files.keys()], []);

/* 磁盘后端的 move 只能「复制再删源」：语义必须与虚拟后端逐条对得上 */
await OSFS.write("/文档/mv-a.md", "aaa");
await eq("磁盘：移动文件", await OSFS.move("/文档/mv-a.md", "/文档/mv-b.md"), "/文档/mv-b.md");
await eq("磁盘：源真的删掉了", fakeRoot.subs.get("文档").files.has("mv-a.md"), false);
await eq("磁盘：目标落在句柄里", fakeRoot.subs.get("文档").files.has("mv-b.md"), true);
await eq("磁盘：正文跟过去", (await (await OSFS.read("/文档/mv-b.md")).text()), "aaa");
await OSFS.write("/文档/tree/leaf/x.txt", "leaf");
await eq("磁盘：移动目录", await OSFS.move("/文档/tree", "/桌面/tree"), "/桌面/tree");
await eq("磁盘：子孙复制到新位置", [...fakeRoot.subs.get("桌面").subs.get("tree").subs.get("leaf").files.keys()], ["x.txt"]);
await eq("磁盘：子孙内容也对", (await (await OSFS.read("/桌面/tree/leaf/x.txt")).text()), "leaf");
await eq("磁盘：旧目录整体带走", fakeRoot.subs.get("文档").subs.has("tree"), false);
await throws("磁盘：目标重名抛 ConflictError", () => OSFS.move("/文档/mv-b.md", "/文档/mdir"), "ConflictError");
await eq("磁盘：冲突后原件没被动过", (await (await OSFS.read("/文档/mv-b.md")).text()), "aaa");

// 权限过期：必须抛 NeedsReauthError，绝不静默回落到虚拟树（否则两真相互相覆盖）
fakeRoot.perms.readwrite = "prompt";
await throws("权限过期时列举被拒", () => OSFS.list("/文档"), "NeedsReauthError");
await throws("权限过期时写入被拒", () => OSFS.write("/文档/x.md", "boom"), "NeedsReauthError");
await eq("内核记住需要重新授权", OSFS.status().needsReauth, true);
await eq("挂载状态不因过期而丢失", OSFS.status().mounted, true);
await eq("门面仍给固定顶层夹", (await VFS.list("/")).length, 8);
await eq("门面转达 needsReauth", VFS.getAuthStatus().needsReauth, true);
await eq("被拒时最近使用为空", (await VFS.getRecentFiles(10)).length, 0);
await throws("被拒时子目录直接抛错（界面据此提示）", () => VFS.list(VFS.TOP_FOLDERS.downloads.path));
await eq("被拒时仍报目录名", VFS.whereStored(), { kind: "disk", name: "DesklyRoot" });

fakeRoot.perms.readwrite = "granted";
const reauthed = await OSFS.reauthorize();
await eq("用户手势补授权后恢复", [reauthed.needsReauth, reauthed.backend], [false, "disk"]);

// 取消挂载与「不再询问」都不许碰磁盘 —— 这是本设计唯一的破坏半径来源
const diskBefore = [...fakeRoot.subs.get("文档").files.keys()].sort();
const unmounted = await OSFS.unmount();
await eq("取消挂载后回虚拟树", unmounted.backend, "virtual");
await eq("取消挂载后 mounted=false", unmounted.mounted, false);
await eq("取消挂载没删磁盘文件", [...fakeRoot.subs.get("文档").files.keys()].sort(), diskBefore);
await eq("取消挂载没删插件目录", fakeRoot.subs.get("AppData").subs.has("office"), true);
await eq("取消挂载后骨架重新铺在虚拟树", (await OSFS.list("/")).map((e) => e.name).includes("文档"), true);

await OSFS.decline();
await eq("不再询问后状态", OSFS.status().declined, true);
await eq("不再询问记在本地标记上", LS.get("webstartos_vfs_mount_declined"), "1");
await eq("不再询问后仍是虚拟树", OSFS.status().backend, "virtual");
await eq("不再询问没动磁盘", [...fakeRoot.subs.get("文档").files.keys()].sort(), diskBefore);

console.log(`${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
