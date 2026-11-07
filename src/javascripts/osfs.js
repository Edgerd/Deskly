/**
 * osfs.js — 存储内核：一个根目录、两种后端、按插件分仓
 *
 * 取代旧的「下载/文档/图片三个文件夹各自授权」模型（见 vfs.js 的历史说明）。
 * 根目录只有一个，`/文档`、`/AppData/<id>/temp` 这些路径永远相对它：
 *
 * - **virtual 后端**（默认，零授权）：整棵树存在 IndexedDB 的 `virtualfiles` 里。
 *   扩展形态（chrome-extension:// 没有目录选择器）与用户不选文件夹时走这条，
 *   所以「不指定根目录」是可用的常态，不是降级残废态。
 * - **disk 后端**（用户挂载了真实文件夹）：路径逐段映射到 FileSystemDirectoryHandle。
 *
 * 为什么不做「disk 权限过期就自动回落到 virtual」：那会让同一批路径有两个互相覆盖的
 * 真相，下一次挂载时较旧的虚拟副本会盖掉磁盘上的新内容。挂载存在但权限没批时，
 * 一律抛 NeedsReauth，让界面明确说「需要重新授权」，不假装写成功。
 *
 * 本模块不 import 任何项目内模块，避免与 vfs.js / log.js 形成循环依赖。
 */

const DB_NAME = "webstartos-vfs";
const DB_VERSION = 1;
const STORE_TREE = "virtualfiles";   // keyPath: path —— 虚拟树（目录也是行）
const STORE_MOUNT = "handles";       // keyPath: key  —— 挂载句柄（只用 key "root"）
const MOUNT_KEY = "root";
const DECLINE_KEY = "webstartos_vfs_mount_declined";

/** 根下的顶层目录：路径字面量的唯一来源，别处不要再拼 "/文档" 这种串。 */
const TOP = {
    documents: { path: "/文档", icon: "folder/Documents.png" },
    downloads: { path: "/下载", icon: "folder/Download.png" },
    pictures: { path: "/图片", icon: "folder/Pictures.png" },
    desktop: { path: "/桌面", icon: "folder/Desktop.png" },
    appdata: { path: "/AppData", icon: "folder/Folder.png", internal: true },
    trash: { path: "/废纸篓", icon: "trash/trash_light.png", internal: true },
};
/**
 * 顶层夹与根的守卫不能做严格字符串比较：Windows / APFS 大小写不敏感，`/appdata` 与
 * `/AppData` 是同一个目录，尾点尾空格同理 —— 严格比较会被这些写法绕过，而绕过的后果是
 * 把整个插件数据区删掉。归一只用于比较，实际路径仍按原样处理。
 */
function topKey(path) {
    return normalizePath(path).toLowerCase().replace(/[. ]+$/, "");
}
const TOP_KEYS = new Set(Object.values(TOP).map((t) => topKey(t.path)));
const isProtectedPath = (path) => {
    const key = topKey(path);
    return key === "/" || TOP_KEYS.has(key);
};

/** AppData/<插件> 下固定预建的三个子目录（插件在其下可任意自建，内核不约束结构）。 */
const SUB = { temp: "temp", config: "config", data: "data" };

/** 挂载句柄；null 表示未挂载（走虚拟树）。 */
let mountHandle = null;

/** 用户是否明确选过「不挂载」，用来避免每次启动都弹窗。 */
let mountDeclined = false;

/** 句柄存在但权限没批：需要一次用户手势重新授权。 */
let needsReauth = false;

let dbPromise = null;
let ready = null;

/** 权限没批时抛这个，调用方按 name 判别，不要靠 message 猜。 */
class NeedsReauthError extends Error {
    constructor(path) {
        super("根目录权限需要重新授权");
        this.name = "NeedsReauthError";
        this.path = path;
    }
}

/** 目标位置已有同名条目时抛这个（重命名/移动的默认语义是不覆盖）。 */
class ConflictError extends Error {
    constructor(path) {
        super(`目标位置已存在：${path}`);
        this.name = "ConflictError";
        this.path = path;
    }
}

/* ── IndexedDB ── */

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_TREE)) {
                db.createObjectStore(STORE_TREE, { keyPath: "path" });
            }
            if (!db.objectStoreNames.contains(STORE_MOUNT)) {
                db.createObjectStore(STORE_MOUNT, { keyPath: "key" });
            }
        };
        req.onblocked = () => {
            // 别的连接占着旧版本时，open 既不 success 也不 error：不 reject 的话 dbPromise
            // 会被永久缓存，整棵树的所有读写挂在上面且再无重试机会。
            dbPromise = null;
            reject(new Error("IndexedDB 升级被其它连接阻塞"));
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

function tx(store, mode, op) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = op(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    }));
}

function treePut(row) { return tx(STORE_TREE, "readwrite", (os) => os.put(row)); }
function treeGet(path) { return tx(STORE_TREE, "readonly", (os) => os.get(path)); }
function treeDelete(path) { return tx(STORE_TREE, "readwrite", (os) => os.delete(path)); }
function treeAll() { return tx(STORE_TREE, "readonly", (os) => os.getAll()); }

function mountPut(handle) { return tx(STORE_MOUNT, "readwrite", (os) => os.put({ key: MOUNT_KEY, handle })); }
function mountGet() { return tx(STORE_MOUNT, "readonly", (os) => os.get(MOUNT_KEY)); }
function mountDelete() { return tx(STORE_MOUNT, "readwrite", (os) => os.delete(MOUNT_KEY)); }

/** 旧模型遗留的三个分文件夹句柄：新后端不认识它们，读到就清掉，避免反复弹窗。 */
function pruneLegacyMounts() {
    return tx(STORE_MOUNT, "readwrite", (os) => {
        ["download", "docs", "pictures"].forEach((key) => os.delete(key));
    });
}

/* ── 路径工具 ── */

/**
 * 规范化：解析 `.` 与 `..`，折叠重复斜杠，保证以 `/` 开头且不以 `/` 结尾（根除外）。
 * `..` 越界一律在规范化时丢弃，所以调用方传什么脏路径都不会逃出根目录。
 */
function normalizePath(path) {
    const raw = String(path || "");
    if (!raw || raw === "/") return "/";
    const out = [];
    for (const seg of raw.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") { out.pop(); continue; }
        out.push(seg);
    }
    return out.length ? `/${out.join("/")}` : "/";
}

function segments(path) {
    const norm = normalizePath(path);
    return norm === "/" ? [] : norm.slice(1).split("/");
}

function parentOf(path) {
    const norm = normalizePath(path);
    const ix = norm.lastIndexOf("/");
    return ix <= 0 ? "/" : norm.slice(0, ix);
}

function baseName(path) {
    const norm = normalizePath(path);
    return norm === "/" ? "" : norm.slice(norm.lastIndexOf("/") + 1);
}

function joinPath(parent, name) {
    return `${normalizePath(parent) === "/" ? "" : normalizePath(parent)}/${String(name).replace(/^\/+|\/+$/g, "")}`;
}

/** 目录名消毒：访达「新建文件夹」与插件传的段都要过一遍，否则造出进不去的层级。 */
function sanitizeName(raw, fallback = "未命名") {
    const cleaned = String(raw ?? "")
        .replace(/[\\/]/g, "")
        .replace(/\.+/g, ".")
        .replace(/[\u0000-\u001f]/g, "")
        .trim()
        .replace(/^\.+/, "")
        .trim();
    if (!cleaned || cleaned === ".") return fallback;
    return cleaned.slice(0, 60);
}

/**
 * 判断 `path` 是否落在 `scope` 之内（含 scope 自身）。
 * 必须先 normalize 再比前缀，并补一个 `/`，否则 `/AppData/notepad` 会被当成
 * `/AppData/notepad-evil` 的内部。
 */
function inside(path, scope) {
    const p = normalizePath(path);
    const s = normalizePath(scope);
    if (s === "/") return true;
    return p === s || p.startsWith(`${s}/`);
}

/**
 * 边界比较用的完全归一：反斜杠先折成斜杠，normalizePath 收敛 `.`/`..`/重复斜杠/尾随斜杠，
 * 再逐段做 Unicode NFC + 去尾点尾空格 + 小写 —— 与 topKey 同一套理由：
 * 磁盘后端（Windows/APFS）下 `/appdata`、`/AppData.`、`/AppData /` 指向同一个真实目录，
 * 按原样比较会被拼写变体绕过（BUG-20）。归一只用于比较，真实路径仍按原样读写。
 */
function boundaryKey(path) {
    return normalizePath(String(path ?? "").replace(/\\/g, "/"))
        .split("/")
        .map((seg) => seg.normalize("NFC").replace(/[. ]+$/, "").toLowerCase())
        .join("/");
}

/**
 * 越界判定：`path` 是否指向他人 AppData（或 AppData 根本身）。
 * 根也判越界：列出 `/AppData` 等于拿到全部插件的 scope 名清单。
 * @param {string} path 绝对路径（是否预先 normalize 都可，这里会再归一）
 * @param {string} selfId 调用方插件 id（scope 名按 scopePath 同款规则取得）
 * @returns {boolean} true = 越界，必须拒绝
 */
function isOtherAppData(path, selfId) {
    const root = boundaryKey(TOP.appdata.path);
    const key = boundaryKey(path);
    if (!key.startsWith(root)) return false;
    if (key === root) return true;
    if (!key.startsWith(`${root}/`)) return false;   // 形如 /AppData2，与 AppData 无关
    const hit = key.slice(root.length + 1).split("/")[0];
    const own = boundaryKey(scopePath(String(selfId || "kernel"))).split("/").pop();
    return hit !== own;
}

/* ── 插件作用域 ── */

const scopePath = (id) => `${TOP.appdata.path}/${sanitizeName(id, "plugin")}`;
const tempPath = (id, ...rest) => [scopePath(id), SUB.temp, ...rest].filter(Boolean).join("/");
const configPath = (id, ...rest) => [scopePath(id), SUB.config, ...rest].filter(Boolean).join("/");
const dataPath = (id, ...rest) => [scopePath(id), SUB.data, ...rest].filter(Boolean).join("/");

/* ── 虚拟树后端 ── */

/** 历史行只有 `{name, content}`，正文统一从 data|content 取，双读不迁移。 */
function rowContent(row) {
    return row && row.data !== undefined ? row.data : row ? row.content : undefined;
}

/**
 * 原子写的暂存名判定（`.desklytmp-` / `.desklybak-` 后缀）。这些行是写入提交/回滚的
 * 中间态：对用户与列表永远不可见，init 时兜底清扫。按名字判而不是按内容判，
 * 磁盘后端的同名文件也走同一个谓词，两处口径一致。
 */
function isTempName(name) {
    return /\.deskly(tmp|bak)-/.test(String(name || ""));
}

/** 生成单次写入的暂存名：同目录、同前缀，崩溃残留一眼可辨。 */
function tempNameFor(path, kind = "tmp") {
    return `${normalizePath(path)}.deskly${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── 元数据索引 ──
 * 读路径的唯一缓存：path → {path,key,name,kind,size,modified}，**不含正文**。
 * 没有它的时候每次列举/遍历都要把整仓库连正文一起 getAll 一遍 —— 实测 300 个文件的库，
 * 打开一层目录读 312 行 / 反序列化 600 KB，一次「最近使用」是 13 次全表扫描 / 7.8 MB。
 * 建好之后读路径 0 次查询；本地写入就地打补丁，同一标签页内永远新鲜。
 * 跨标签页（同一 origin 可以开多个新标签页共享这个库）只能靠 TTL 兜住：别人写的行最长
 * 一个 TTL 周期内看不见。1 秒足够覆盖一次按键/渲染的突发复用，又把陈旧窗口压到人手无感 ——
 * 所以**写路径一律不查索引、只查库**：读可以旧一秒，写错会毁数据。
 */
const INDEX_TTL = 1000;
let index = null;
let indexAt = 0;

function measureSize(data) {
    if (data == null) return null;
    if (typeof data === "string") return data.length;
    if (data instanceof Blob) return data.size;                 // File 是 Blob 的子类，一并覆盖
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    return null;
}

function toMeta(row) {
    const path = normalizePath(row.path);
    const isDir = !rowIsFile(row);
    return {
        path,
        key: row.path,                       // 删除要按库里的原始主键，规范化值可能不同
        name: baseName(path),
        kind: isDir ? "dir" : "file",
        modified: isDir ? null : (row.modified ?? null),
        size: isDir ? null : (typeof row.size === "number" ? row.size : measureSize(rowContent(row))),
    };
}

async function metaIndex() {
    if (index && Date.now() - indexAt < INDEX_TTL) return index;
    const rows = (await treeAll()) || [];
    index = new Map();
    for (const row of rows) {
        if (isTempName(row.path)) continue;    // 暂存行不进索引：列表/搜索/stat 都看不见它
        index.set(normalizePath(row.path), toMeta(row));
    }
    indexAt = Date.now();
    return index;
}

/** 本地写入后同步索引；索引还没建过就什么都不做（下次自然全量重建）。 */
function indexPatch(row) { if (index) index.set(normalizePath(row.path), toMeta(row)); }
function indexDrop(path) { if (index) index.delete(normalizePath(path)); }
function indexReset() { index = null; indexAt = 0; }

async function virtualList(dir) {
    const target = normalizePath(dir);
    const prefix = target === "/" ? "/" : `${target}/`;
    const meta = await metaIndex();
    const entries = [];
    for (const row of meta.values()) {
        if (!row.path.startsWith(prefix) || row.path === target) continue;
        if (row.path.slice(prefix.length).includes("/")) continue;   // 孙代不属于本层
        entries.push({
            name: row.name,
            type: row.kind === "dir" ? "folder" : "file",
            path: row.path,
            modified: row.modified,
            size: row.size,
            virtual: true,
        });
    }
    return sortEntries(entries);
}

async function virtualGet(path) {
    return treeGet(normalizePath(path));
}

async function virtualWrite(path, data) {
    const norm = normalizePath(path);
    // 目标已经是目录：扁平键树上「文件 /foo」和「目录 /foo」只能活一个，
    // 直接 put 会把目录行盖掉，子孙行就此变成进不去的孤儿——必须如实拒绝。
    // 这里刻意回库确认而不是读索引：写路径要的是当下事实，不是 3 秒内的旧影。
    const existing = await treeGet(norm);
    // 判据必须是 rowIsFile 而不是 `kind === "dir"`：kind 字段是后加的，旧行只有
    // {path, name, content}。用 kind 判会让旧目录行被当成"不存在"，put 下去就把目录行
    // 顶成文件行，子孙全部变成进不去的孤儿。rowIsFile 才是全文件对"是不是文件"的唯一定义。
    if (existing && !rowIsFile(existing)) throw new Error(`目标是目录，不能当文件写：${norm}`);
    await ensureVirtualDirs(parentOf(norm));
    // 原子写：正文先进暂存键，提交时一个事务里「删旧 + 落新 + 清暂存」。
    // 中途崩溃只留下一个隐藏的暂存行（init 清扫），目标位置要么是旧文件、要么是新文件，
    // 永远不会是写了一半的正文。
    const tmp = tempNameFor(norm);
    const row = { path: norm, name: baseName(norm), kind: "file", data, modified: Date.now(), size: measureSize(data) };
    try {
        await treePut({ ...row, path: tmp, name: baseName(tmp) });
        await tx(STORE_TREE, "readwrite", (os) => {
            os.delete(norm);
            os.put(row);
            os.delete(tmp);
            return undefined;
        });
    } catch (err) {
        // 回滚：暂存键清掉，目标位置保持原样（提交事务整体 abort 时旧行还在）
        await treeDelete(tmp).catch(() => {});
        throw err;
    }
    indexPatch(row);
}

/** 既有的行是不是文件：kind 缺失的旧行按正文判断，没正文的空行仍按目录处理。 */
function rowIsFile(row) {
    if (!row) return false;
    if (row.kind) return row.kind === "file";
    return rowContent(row) !== undefined;
}

async function virtualMkdir(path) {
    const norm = normalizePath(path);
    const parts = segments(norm);
    const meta = await metaIndex();
    let acc = "";
    for (const seg of parts) {
        acc += `/${seg}`;
        // 索引里已经是目录就跳过回库确认：写一个文件要补整条父链，
        // 每层一次 get 的话插件写 20 个缓存文件就是 90 多次事务（实测）。
        if (meta.get(acc)?.kind === "dir") continue;
        const existing = await treeGet(acc);
        // 同 virtualWrite：这一层已经是文件，再落成目录行就等于删掉用户的正文。
        if (rowIsFile(existing)) throw new Error(`同路径上已有文件：${acc}`);
        if (!existing) {
            const row = { path: acc, name: seg, kind: "dir", modified: null };
            await treePut(row);
            indexPatch(row);
        } else {
            indexPatch(existing);
        }
    }
}

async function ensureVirtualDirs(path) {
    if (normalizePath(path) === "/") return;
    await virtualMkdir(path);
}

async function virtualRemove(path, { recursive = false } = {}) {
    const norm = normalizePath(path);
    const row = await treeGet(norm);
    if (!row) return false;
    if (!rowIsFile(row)) {
        const children = await virtualChildrenOf(norm);
        if (children.length && !recursive) throw new Error(`目录非空：${norm}`);
        // 子孙在同一个事务里一次性删掉。旧写法对每个后代再调一次 virtualRemove，
        // 而每次都做一次全表 getAll——200 个文件就是 200 次全表扫描，直接卡死界面。
        if (children.length) {
            await tx(STORE_TREE, "readwrite", (os) => {
                // 一律按主键删：virtualChildrenOf 下面写明「key 是库里的原始主键」，
                // 早先这里传的是 child.path（规范化值），带尾斜杠的旧行删不掉又不出错。
                children.forEach((child) => os.delete(child.key));
                return undefined;
            });
            children.forEach((child) => indexDrop(child.path));
        }
    }
    await treeDelete(row.path);
    indexDrop(norm);
    return true;
}

async function virtualChildrenOf(dir) {
    const target = normalizePath(dir);
    const prefix = target === "/" ? "/" : `${target}/`;
    const rows = (await treeAll()) || [];
    return rows
        .filter((r) => normalizePath(r.path).startsWith(prefix))
        // key 是库里的原始主键，path 是规范化后的展示值：删除必须按主键，
        // 旧行若带尾斜杠之类，按 path 删会删不掉又不出错。
        .map((r) => ({ path: normalizePath(r.path), key: r.path }));
}

/**
 * 一个复用的 collator。旧写法在比较函数里 `name.localeCompare(x, "zh-CN")`，
 * 每次比较都要重新构造排序规则，大目录里是纯浪费；顺带用 numeric 让
 * 「文件夹 2」排在「文件夹 10」前面（访达重名顺延就是这套命名）。
 */
const COLLATOR = new Intl.Collator("zh-CN", { numeric: true });

function sortEntries(entries) {
    return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return COLLATOR.compare(String(a.name), String(b.name));
    });
}

/* ── 磁盘后端 ── */

async function checkPermission(handle, request) {
    const opts = { mode: "readwrite" };
    try {
        const state = await handle.queryPermission(opts);
        if (state === "granted") return true;
        // requestPermission 必须在用户手势里；非手势上下文 Chrome 直接拒。
        if (request) {
            const asked = await handle.requestPermission(opts);
            if (asked === "granted") return true;
        }
    } catch (err) {
        console.warn("[osfs] 权限查询失败：", err);
    }
    return false;
}

/** 逐段解析目录句柄；`create` 时按需建目录（挂载点内的一切由本应用命名）。 */
async function resolveDir(segs, create) {
    let handle = mountHandle;
    for (const seg of segs) {
        handle = await handle.getDirectoryHandle(seg, create ? { create: true } : undefined);
    }
    return handle;
}

async function diskList(dir) {
    const segs = segments(dir);
    let handle;
    try { handle = await resolveDir(segs, false); } catch (err) { return []; }
    const entries = [];
    for await (const [name, child] of handle.entries()) {
        if (isTempName(name)) continue;    // 原子写/替换的中间态文件永不上列表
        const isDir = child.kind === "directory";
        const path = joinPath(dir, name);
        let size = null;
        let modified = null;
        if (!isDir) {
            try {
                const file = await child.getFile();
                size = file.size;
                modified = file.lastModified;
            } catch (err) { /* 单个文件读不到不影响整份列表 */ }
        }
        entries.push({ name, type: isDir ? "folder" : "file", path, modified, size, handle: child });
    }
    return sortEntries(entries);
}

async function diskRead(path) {
    const dir = await resolveDir(segments(parentOf(path)), false);
    const fileHandle = await dir.getFileHandle(baseName(path));
    return fileHandle.getFile();
}

/**
 * 目录内改名/换名：优先用句柄原生 move（Chrome 122+），不支持的浏览器退化为
 * 「复制正文 + 删源」。退化路径只用于同一目录内的改名，失败时源与目标都在，
 * 不会出现「新的没写成、旧的被删了」。
 */
async function diskRename(dirHandle, fromName, toName) {
    const srcHandle = await dirHandle.getFileHandle(fromName);
    if (typeof srcHandle.move === "function") {
        await srcHandle.move(toName);
        return;
    }
    const file = await srcHandle.getFile();
    const dstHandle = await dirHandle.getFileHandle(toName, { create: true });
    const writable = await dstHandle.createWritable();
    await writable.write(file);
    await writable.close();
    await dirHandle.removeEntry(fromName);
}

/**
 * 原子写：正文先完整写进同目录的暂存文件，再「泊车 → 换名 → 清场」三步提交：
 * 目标已存在时先把旧文件改名成备份名，暂存文件换到正式名，最后删备份。
 * 任一步失败都把备份换回去——目标位置要么是旧文件、要么是新文件，永远不是半截正文。
 */
async function diskWrite(path, data) {
    const dir = await resolveDir(segments(parentOf(path)), true);
    const name = baseName(path);
    const tmpName = baseName(tempNameFor(path));
    try {
        const tmpHandle = await dir.getFileHandle(tmpName, { create: true });
        const tmpWritable = await tmpHandle.createWritable();
        await tmpWritable.write(data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data) || typeof data === "string"
            ? data : String(data));
        await tmpWritable.close();
    } catch (err) {
        // 暂存件自己就没写成：清掉它，目标位置根本没被碰过
        await dir.removeEntry(tmpName).catch(() => {});
        throw err;
    }
    const existing = await diskKind(dir, name);
    if (existing === "directory") {
        await dir.removeEntry(tmpName).catch(() => {});
        throw new Error(`目标是目录，不能当文件写：${normalizePath(path)}`);
    }
    const bakName = existing === "file" ? baseName(tempNameFor(path, "bak")) : null;
    try {
        if (bakName) await diskRename(dir, name, bakName);
        await diskRename(dir, tmpName, name);
    } catch (err) {
        // 回滚：备份还在就换回去，暂存件清掉，目标位置恢复原状
        if (bakName) await diskRename(dir, bakName, name).catch(() => {});
        await dir.removeEntry(tmpName).catch(() => {});
        throw err;
    }
    if (bakName) await dir.removeEntry(bakName).catch(() => {});
}

async function diskMkdir(path) {
    await resolveDir(segments(path), true);
}

/* ── 后端分派 ── */

const usingDisk = () => Boolean(mountHandle);

async function guard(path) {
    if (!usingDisk()) return;
    const ok = await checkPermission(mountHandle, false);
    if (!ok) {
        needsReauth = true;
        throw new NeedsReauthError(path);
    }
}

async function list(dir) {
    const norm = normalizePath(dir);
    if (usingDisk()) {
        await guard(norm);
        return diskList(norm);
    }
    return virtualList(norm);
}

async function read(path) {
    const norm = normalizePath(path);
    if (usingDisk()) {
        await guard(norm);
        try { return await diskRead(norm); } catch (err) { return null; }
    }
    const row = await virtualGet(norm);
    // 同 virtualWrite：kind 缺失的旧行要靠 rowIsFile 判，否则旧目录行会被读成一个空文件。
    if (!row || !rowIsFile(row)) return null;
    const data = rowContent(row);
    if (data instanceof File) return data;
    if (data instanceof Blob) return new File([data], baseName(norm));
    if (data == null) return new File([], baseName(norm));
    return new File([data], baseName(norm));
}

/**
 * 写一个文件。`data` 可以是字符串、Blob、ArrayBuffer、TypedArray。
 * 目录会自动补齐，所以插件不需要先 mkdir 再 write。
 */
async function write(path, data) {
    const norm = normalizePath(path);
    if (usingDisk()) {
        await guard(norm);
        await diskWrite(norm, data);
        return norm;
    }
    await virtualWrite(norm, data);
    return norm;
}

async function mkdir(path) {
    const norm = normalizePath(path);
    if (usingDisk()) {
        await guard(norm);
        await diskMkdir(norm);
        return norm;
    }
    await virtualMkdir(norm);
    return norm;
}

/**
 * remove 的磁盘实现：父目录 removeEntry，递归时把子项一起带走。
 * 只有「本来就不存在」返回 false；「删不掉」（非空、权限）一律抛出，
 * 与虚拟后端保持同一种说法 —— 两个后端对同一件事给不同信号，调用方必然漏一支。
 */
async function diskRemoveEntry(path, recursive) {
    const parent = await resolveDir(segments(parentOf(path)), false);
    const name = baseName(path);
    let kind = "file";
    try {
        await parent.getFileHandle(name);
    } catch (err) {
        kind = "directory";
    }
    await parent.removeEntry(name, kind === "directory" && recursive ? { recursive: true } : undefined);
}

async function remove(path, opts = {}) {
    const norm = normalizePath(path);
    if (isProtectedPath(norm)) {
        throw new Error(`不允许删除顶层目录：${norm}`);
    }
    if (usingDisk()) {
        await guard(norm);
        try {
            await diskRemoveEntry(norm, Boolean(opts.recursive));
            return true;
        } catch (err) {
            if (err && err.name === "NotFoundError") return false;
            throw err;
        }
    }
    return virtualRemove(norm, opts);
}

/** 存在性判定与读写共用同一套权限说法：权限没批就抛，不装作「不存在」。 */
async function exists(path) {
    const norm = normalizePath(path);
    if (norm === "/") return true;
    if (usingDisk()) {
        await guard(norm);
        try {
            const parent = await resolveDir(segments(parentOf(norm)), false);
            return Boolean(await diskKind(parent, baseName(norm)));
        } catch (err) {
            return false;       // 父目录本身不存在
        }
    }
    const meta = await metaIndex();
    if (meta.has(norm)) return true;
    return Boolean(await virtualGet(norm));    // 索引可能是一个 TTL 前的旧影，判定以库为准
}

/** stat：虚拟后端直接查索引，磁盘后端按父句柄探一项 —— 都不必列整个父目录。 */
async function stat(path) {
    const norm = normalizePath(path);
    if (norm === "/") return { name: "", type: "folder", path: "/", modified: null, size: null };
    if (usingDisk()) {
        await guard(norm);
        const name = baseName(norm);
        let parent = null;
        try { parent = await resolveDir(segments(parentOf(norm)), false); } catch (err) { return null; }
        const kind = await diskKind(parent, name);
        if (!kind) return null;
        if (kind === "file") {
            const entry = { name, type: "file", path: norm, modified: null, size: null, handle: null };
            try {
                const file = await (await parent.getFileHandle(name)).getFile();
                entry.size = file.size;
                entry.modified = file.lastModified;
            } catch (err) { /* 读不到元信息不影响「它在这儿」这个结论 */ }
            return entry;
        }
        return { name, type: "folder", path: norm, modified: null, size: null };
    }
    const meta = await metaIndex();
    let row = meta.get(norm);
    if (!row) {
        // 索引可能是一个 TTL 前的旧影：判「没有」之前回库确认一次，别把存在的文件说成不存在
        const fresh = await virtualGet(norm);
        if (!fresh) return null;
        row = toMeta(fresh);
        indexPatch(fresh);
    }
    return {
        name: row.name, type: row.kind === "dir" ? "folder" : "file",
        path: row.path, modified: row.modified, size: row.size, virtual: true,
    };
}

/* ── 移动 / 重命名 ── */

/**
 * 虚拟后端：改键。目录必须连子孙一起改，否则子孙留在旧前缀上成了永远进不去的孤儿。
 * 删旧键与写新键放在同一个事务里：中途失败不会出现「旧的没了、新的也没写成」。
 */
async function virtualMove(from, to) {
    const rows = await treeAll();
    const byPath = new Map(rows.map((r) => [normalizePath(r.path), r]));
    const srcRow = byPath.get(from);
    if (!srcRow) return false;
    if (byPath.has(to)) throw new ConflictError(to);
    const plan = [];
    // `(srcRow.kind || "file") === "dir"` 会把无 kind 的旧目录行当成文件：只改它自己的键，
    // 子孙留在旧前缀上成为孤儿。目录判定只能走 rowIsFile。
    if (!rowIsFile(srcRow)) {
        for (const [path, row] of byPath) {
            if (path === from) plan.push({ row, next: to });
            else if (path.startsWith(`${from}/`)) plan.push({ row, next: to + path.slice(from.length) });
        }
    } else {
        plan.push({ row: srcRow, next: to });
    }
    await ensureVirtualDirs(parentOf(to));
    await tx(STORE_TREE, "readwrite", (os) => {
        for (const { row, next } of plan) {
            os.delete(row.path);
            os.put({ ...row, path: next, name: baseName(next) });
        }
    });
    indexReset();     // 整条子链的键都换了，逐条打补丁不如直接作废重建
    return true;
}

/** 探测句柄名是文件、目录，还是不存在（磁盘侧 move 与冲突判定都要它）。 */
async function diskKind(parentHandle, name) {
    try { await parentHandle.getFileHandle(name); return "file"; } catch (err) { /* 不是文件 */ }
    try { await parentHandle.getDirectoryHandle(name); return "directory"; } catch (err) { return null; }
}

/** 递归把 from 目录的内容铺到 to 目录下（调用方保证 to 尚不存在）。 */
async function diskCopyTree(from, to) {
    for (const child of await diskList(from)) {
        const next = joinPath(to, child.name);
        if (child.type === "folder") await diskCopyTree(child.path, next);
        else await diskWrite(next, await child.handle.getFile());
    }
}

/**
 * 磁盘后端的移动：优先用句柄原生 move（一句调用，文件/目录都一样，没有中间态）。
 * 不支持的浏览器退化到「复制再删源」：复制**全部成功**才删源；复制中途失败时把
 * 目标位置的半成品整棵清掉再抛错——目标开工前确认过不存在，清掉它等于回到开工前。
 */
async function diskMove(from, to) {
    const srcParent = await resolveDir(segments(parentOf(from)), false);
    const srcName = baseName(from);
    const kind = await diskKind(srcParent, srcName);
    if (!kind) return false;
    const dstParent = await resolveDir(segments(parentOf(to)), true);
    const dstName = baseName(to);
    if (await diskKind(dstParent, dstName)) throw new ConflictError(to);
    const srcHandle = kind === "file"
        ? await srcParent.getFileHandle(srcName)
        : await srcParent.getDirectoryHandle(srcName);
    if (typeof srcHandle.move === "function") {
        await srcHandle.move(dstParent, dstName);
        return true;
    }
    try {
        if (kind === "file") {
            const file = await srcHandle.getFile();
            await diskWrite(to, file);
        } else {
            await diskMkdir(to);
            await diskCopyTree(from, to);
        }
    } catch (err) {
        // 回滚：半成品目标整棵清掉，源留在原地不动
        await dstParent.removeEntry(dstName, { recursive: true }).catch(() => {});
        throw err;
    }
    await srcParent.removeEntry(srcName, kind === "directory" ? { recursive: true } : undefined);
    return true;
}

/**
 * 移动或重命名一个条目，成功返回目标路径，源不存在返回 false。
 * 默认**不覆盖**：目标已有同名条目抛 ConflictError，由调用方决定顺延还是问用户。
 * 顶层目录本身不参与移动（那等于把整套目录约定拆掉）。
 */
async function move(from, to) {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    if (src === dst) return dst;
    if (src === "/" || dst === "/") throw new Error("根目录不能移动");
    if (isProtectedPath(src)) throw new Error(`不允许移动顶层目录：${src}`);
    // 目标也要守：顶层夹被用户手删后，move(f,"/文档") 会造出一个「名为文档的文件」
    // 占住顶层名，此后每次 init 铺骨架都撞在它身上抛错，整棵树起不来。
    if (isProtectedPath(dst)) throw new Error(`目标位置是顶层目录：${dst}`);
    if (dst === src || dst.startsWith(`${src}/`)) throw new Error("不能把目录移进它自己");
    if (usingDisk()) {
        await guard(src);
        return (await diskMove(src, dst)) ? dst : false;
    }
    return (await virtualMove(src, dst)) ? dst : false;
}

/* ── 挂载与状态 ── */

function isSupported() {
    return typeof window.showDirectoryPicker === "function";
}

/** 挂载后把虚拟树里已有的内容铺进真实文件夹，避免「一挂载界面就空了」。 */
async function materialize() {
    const rows = (await treeAll()) || [];
    const written = [];
    for (const row of rows) {
        const norm = normalizePath(row.path);
        if (norm === "/") continue;
        // 暂存行是原子写的中间态，不是用户内容：铺到磁盘上就成了真实垃圾文件
        if (isTempName(norm)) continue;
        try {
            // 取消挂载后又在应用内建了同名文件，再重新挂载时会撞上磁盘上那一份：
            // 磁盘优先，绝不用旧的虚拟副本盖掉用户后来写的那份。副本留着，删除只删铺成功的那些。
            if (await diskHas(norm)) continue;
            // 这里读的是原始行（不是索引里的 meta），kind 可能缺失 —— 用 rowIsFile 判。
            if (!rowIsFile(row)) {
                await diskMkdir(norm);
            } else {
                const data = rowContent(row);
                if (data !== undefined) await diskWrite(norm, data);
            }
            written.push(norm);
        } catch (err) {
            // 一条铺失败就留着它的虚拟副本：宁可同一文件两处都有，也不能铺丢用户的正文
            console.warn("[osfs] 铺写到真实目录失败，保留虚拟副本：", norm, err);
        }
    }
    for (const path of written) await treeDelete(path);
    indexReset();       // 虚拟行被搬走了，索引留着就是幽灵条目
}

/** 磁盘后端某个路径上是否已有同名条目（文件与目录都算）。 */
async function diskHas(path) {
    const name = baseName(path);
    if (!name) return true;
    try {
        const parent = await resolveDir(segments(parentOf(path)), false);
        return Boolean(await diskKind(parent, name));
    } catch (err) {
        return false;   // 父目录都不存在，肯定没有同名
    }
}

/**
 * 弹系统目录选择器挂载根目录（readwrite）。
 * 用户取消时抛 AbortError，由界面按「取消」处理，不是故障。
 */
async function mount() {
    if (!isSupported()) throw new Error("当前浏览器不支持 File System Access API，文件将保存在本机应用目录（虚拟根）中。");
    const handle = await window.showDirectoryPicker({ id: "deskly-root", mode: "readwrite" });
    const granted = await checkPermission(handle, false);
    if (!granted) {
        const asked = await handle.requestPermission({ mode: "readwrite" });
        if (asked !== "granted") throw new Error("未获得读写权限，根目录没有改变。");
    }
    mountHandle = handle;
    try {
        // 先铺骨架再搬内容：反过来的话 materialize 撞上磁盘同名文件会抛，而句柄已经落库，
        // 于是留下「挂载显示成功、顶层夹却残缺」的半挂载态。任一步失败就把句柄收回去。
        await ensureSkeleton();
        await mountPut(handle);
        await pruneLegacyMounts();
        await mountDeclineSet(false);
        needsReauth = false;
        await materialize();
    } catch (err) {
        mountHandle = null;
        needsReauth = false;
        await mountDelete().catch(() => {});
        throw err;
    }
    announce("mount");
    return status();
}

/**
 * 忘掉挂载：只删句柄、清内存索引，**不碰磁盘上的任何文件**。
 * 挂载期间写在磁盘上的内容不会「回到应用内根目录」—— 它留在那个文件夹里，
 * 重新挂载才看得见。界面文案必须按这个事实写，别承诺做不到的事。
 */
async function unmount() {
    await mountDelete();
    mountHandle = null;
    needsReauth = false;
    indexReset();
    await ensureSkeleton();
    announce("unmount");
    return status();
}

async function mountDeclineSet(value) {
    try {
        if (value) localStorage.setItem(DECLINE_KEY, "1");
        else localStorage.removeItem(DECLINE_KEY);
    } catch (err) { /* 配额/隐私模式：状态留在内存里即可 */ }
}

async function decline() {
    // 先解除挂载、成功了才记「不再询问」：反过来写时 unmount 一抛错就是
    // 「已拒绝却仍然挂载着」的矛盾态，界面会照着假状态画下去。
    if (mountHandle) await unmount();
    mountDeclined = true;
    await mountDeclineSet(true);
    return status();
}

/** 用户手势里补权限（权限过期后由界面按钮调用）。 */
async function reauthorize() {
    if (!mountHandle) return status();
    const ok = await checkPermission(mountHandle, true);
    needsReauth = !ok;
    return status();
}

function status() {
    return {
        backend: usingDisk() ? "disk" : "virtual",
        mounted: Boolean(mountHandle),
        mountName: mountHandle ? mountHandle.name : null,
        needsReauth,
        declined: mountDeclined,
        supported: isSupported(),
        root: "/",
        top: { ...TOP },
    };
}

/** 根目录下的固定骨架；虚拟树里落成目录行，磁盘上 getDirectoryHandle(create)。 */
async function ensureSkeleton() {
    if (usingDisk()) {
        if (!(await checkPermission(mountHandle, false))) { needsReauth = true; return; }
        for (const def of Object.values(TOP)) await diskMkdir(def.path);
        return;
    }
    for (const def of Object.values(TOP)) await virtualMkdir(def.path);
}

/** 预建某个插件的 temp/config/data，让「打开插件目录」时看得见结构。 */
async function ensurePluginScope(id) {
    await mkdir(scopePath(id));
    await mkdir(tempPath(id));
    await mkdir(configPath(id));
    await mkdir(dataPath(id));
    return scopePath(id);
}

/** 清空某插件的缓存目录（temp 可整棵删；config/data 由插件自己负责）。 */
async function clearTemp(id) {
    const dir = tempPath(id);
    const removed = await remove(dir, { recursive: true });
    await mkdir(dir);
    return removed;
}

/**
 * 生成只允许在本插件作用域内活动的存储句柄，交给插件用。
 * 内核把 path 一律相对 scope 解析，插件写不出 AppData/<自己> 之外。
 */
function scope(id) {
    const base = scopePath(id);
    const absolutize = (rel) => {
        const raw = String(rel ?? "");
        // 绝对路径原样收下（只要还在自己作用域里）：早先无条件再拼一次 base，
        // 把 scope.temp("x") 的返回值喂回 scope.write 就会得到
        // /AppData/notepad/AppData/notepad/temp/x —— 写错地方还不报错。
        const abs = normalizePath(raw.startsWith("/") ? raw : joinPath(base, raw));
        if (!inside(abs, base)) throw new Error(`越出插件目录：${rel}`);
        return abs;
    };
    /**
     * 子目录路径：不传参数得到目录本身，传了就拼子路径。
     * null/undefined/空段一律丢掉 —— 早先 `me.temp(undefined)` 会拼出 `temp/undefined`，
     * 而 os-api 把插件入参直通到这里，等于让一个漏传参数静默造出错误目录。
     */
    const subPath = (which, segs) => {
        const rest = (segs || []).filter((s) => s !== undefined && s !== null && s !== "");
        if (!rest.length) return baseJoin(base, which);
        return absolutize(`${which}/${rest.join("/")}`);
    };
    return {
        id,
        path: base,
        temp: (...segs) => subPath(SUB.temp, segs),
        config: (...segs) => subPath(SUB.config, segs),
        data: (...segs) => subPath(SUB.data, segs),
        resolve: absolutize,
        list: (rel = "") => list(absolutize(rel)),
        read: (rel) => read(absolutize(rel)),
        write: (rel, data) => write(absolutize(rel), data),
        mkdir: (rel) => mkdir(absolutize(rel)),
        remove: (rel, opts) => remove(absolutize(rel), opts),
        move: (rel, toRel) => move(absolutize(rel), absolutize(toRel)),
        exists: (rel) => exists(absolutize(rel)),
        clearTemp: () => clearTemp(id),
        ensure: () => ensurePluginScope(id),
    };
}

function baseJoin(parent, name) {
    return `${normalizePath(parent)}/${name}`;
}

/**
 * 跨标签页同步。同一 origin 能开多个新标签页，每个都是一份完整 Deskly，共享同一个 IndexedDB：
 * A 页挂载/取消挂载后如果不通知 B 页，B 会继续往虚拟树写、A 往磁盘写 —— 同一批路径两个真相。
 * 只广播「变了」这一个事实，各页自己去库里读回句柄（FileSystemHandle 存 IDB 是跨上下文可用的）。
 */
let channel = null;

function ensureChannel() {
    if (channel || typeof BroadcastChannel !== "function") return;
    channel = new BroadcastChannel("deskly-osfs");
    channel.onmessage = async (event) => {
        const type = event && event.data && event.data.type;
        if (type !== "mount" && type !== "unmount") return;
        indexReset();
        const row = await mountGet().catch(() => null);
        mountHandle = row && row.handle ? row.handle : null;
        needsReauth = Boolean(mountHandle) && !(await checkPermission(mountHandle, false));
    };
}

function announce(kind) {
    ensureChannel();
    if (!channel) return;
    try { channel.postMessage({ type: kind }); } catch (err) {
        console.warn("[osfs] 跨标签页通知失败，其它标签页最多一个 TTL 后自行纠正：", err);
    }
}

/**
 * 初始化：读回挂载句柄、复核权限、铺骨架。幂等。
 * 不在这里申请权限：那必须在用户手势里做，否则 Chrome 直接拒并留下无谓的告警。
 */
function init() {
    if (ready) return ready;
    ready = (async () => {
        ensureChannel();
        try { mountDeclined = localStorage.getItem(DECLINE_KEY) === "1"; } catch (err) { mountDeclined = false; }
        const row = await mountGet().catch(() => null);
        if (row && row.handle) {
            mountHandle = row.handle;
            const ok = await checkPermission(mountHandle, false);
            needsReauth = !ok;
            if (ok) await pruneLegacyMounts();
        }
        await sweepTempRows();
        await ensureSkeleton();
        return status();
    })().catch((err) => {
        ready = null;
        console.warn("[osfs] 初始化失败，文件读写退到内存之外不可用：", err);
        return status();
    });
    return ready;
}

/** 清扫上次崩溃留下的原子写暂存行：它们对列表不可见，但不能永远占着空间。 */
async function sweepTempRows() {
    const rows = (await treeAll().catch(() => [])) || [];
    const strays = rows.filter((r) => isTempName(r.path));
    if (!strays.length) return;
    await tx(STORE_TREE, "readwrite", (os) => {
        strays.forEach((r) => os.delete(r.path));
        return undefined;
    }).catch((err) => console.warn("[osfs] 暂存行清扫失败（不影响使用）：", err));
}

/**
 * 递归收集文件条目（最近使用、导出、统计用）。
 * 虚拟后端直接从元数据索引算，整棵树只可能在索引过期时扫一次；
 * 旧写法对每个目录再调一次 list()，实测一次「最近使用」= 13 次全表 getAll / 7.8 MB 反序列化。
 * 深度语义与旧版一致：maxDepth 指的是「起始目录往下几层」，文件本身占一层。
 */
async function walk(maxDepth = 3, dir = "/") {
    const target = normalizePath(dir);
    if (usingDisk()) return diskWalk(maxDepth, target, 0, []);
    const prefix = target === "/" ? "/" : `${target}/`;
    const meta = await metaIndex();
    const out = [];
    for (const row of meta.values()) {
        if (row.kind !== "file") continue;
        if (target !== "/" && !row.path.startsWith(prefix)) continue;
        if (row.path.slice(prefix.length).split("/").length > maxDepth + 1) continue;
        out.push({
            name: row.name, type: "file", path: row.path,
            modified: row.modified, size: row.size, virtual: true,
        });
    }
    return sortEntries(out);
}

/** 磁盘后端没有索引可用，只能逐层问句柄；深度规则与 walk() 保持一致。 */
async function diskWalk(maxDepth, dir, depth, out) {
    if (depth > maxDepth) return out;
    let entries = [];
    try { entries = await list(dir); }
    catch (err) {
        // 权限待补不能当成「这里没有文件」—— 那会让「最近使用」平静地显示空，
        // 用户以为数据没了。单个目录读不了这类零散失败才继续吞掉。
        if (err && err.name === "NeedsReauthError") throw err;
        return out;
    }
    for (const entry of entries) {
        if (entry.type === "folder") {
            if (depth < maxDepth) await diskWalk(maxDepth, entry.path, depth + 1, out);
        } else {
            out.push(entry);
        }
    }
    return out;
}

const OSFS = {
    TOP,
    SUB,
    NeedsReauthError,
    ConflictError,
    init,
    isSupported,
    status,
    mount,
    unmount,
    decline,
    reauthorize,
    ensureSkeleton,
    ensurePluginScope,
    scope,
    scopePath,
    tempPath,
    configPath,
    dataPath,
    list,
    read,
    write,
    mkdir,
    remove,
    move,
    exists,
    stat,
    walk,
    clearTemp,
    normalizePath,
    sanitizeName,
    inside,
    boundaryKey,
    isOtherAppData,
    isTempName,
    joinPath,
    baseName,
    parentOf,
    segments,
};

globalThis.__osfs = OSFS;

export { OSFS };
