/**
 * permissions.js — 权限 owner：真实的权限状态与获取，不做假开关
 *
 * 隐私面板此前是一排「看起来能点、点了什么也不发生」的自制开关：浏览器根本没有
 * 一套「把权限拨回未询问」的 API，那些开关写进 localStorage 的布尔值跟真实授权
 * 状态毫无关系。本模块把这一层换成真东西：
 *
 * - **状态**来自浏览器本身：`navigator.permissions.query({name})`，通知走
 *   `Notification.permission`（Safari/Firefox 不支持该 name 查询）。每一项都包在
 *   try/catch 里，不支持 / 抛错时给出 `{state:"unsupported"}` 而不是让面板崩掉。
 * - **获取**走真正的授权调用：`Notification.requestPermission()`、
 *   `navigator.geolocation.getCurrentPosition`、`getUserMedia({video|audio})`（拿到
 *   流立刻 stop，绝不留着录音录像）、剪贴板写探针、`navigator.storage.persist()`。
 * - **重置**只清 Deskly 自己的数据：扩展页源下只有 Deskly 一家，因此清空
 *   localStorage 全部键（含口令槽与设置槽）+ 删掉四个 IndexedDB 库，再 reload。
 *   删 `webstartos-vfs` 会连带清掉**应用内根目录**里的文件，并忘掉挂载的本地文件夹——
 *   只是忘掉句柄，磁盘上一个文件都不会被动。不要给这里加「顺便清空根目录」的逻辑，
 *   那会直接删到用户自己的文件夹。
 *   必须显式传 `{confirm:true}` 才执行，且执行前先落一条 error 日志（这是不可逆动作，
 *   运行记录里要留得下来）。
 *
 * 本模块**不注册任何设置项**：权限状态是浏览器的只读事实，不是用户偏好，
 * 存进设置中枢只会造出「设置说已授权、浏览器说没有」的第二个真相。
 */

/**
 * 权限行定义：name 与 Permissions API 的名字一致，label 供面板直接显示。
 * 刻意**没有 hint**：以前那几条写的是「谁在用这个权限」（Safari、Chrome、某类插件），
 * 既随实现漂移，又把浏览器机制摊到隐私页面上给用户读；权限名本身已经说清这是什么了。
 */
const ROWS = [
    { name: "notifications", label: "通知" },
    { name: "geolocation", label: "位置" },
    { name: "camera", label: "摄像头" },
    { name: "microphone", label: "麦克风" },
    { name: "clipboard-read", label: "剪贴板读取" },
    { name: "clipboard-write", label: "剪贴板写入" },
    { name: "persistent-storage", label: "持久存储" },
];

/** name -> 行定义。 */
const ROW_BY_NAME = new Map(ROWS.map((row) => [row.name, row]));

/** 本扩展使用的 IndexedDB 库（vfs / 已安装插件 / 照片 / API 授权账本）。 */
const DATABASES = ["webstartos-vfs", "webstartos-plugins", "webstartos-photos", "webstartos-grants"];

/** 单个权限名最多等多久（定位与 getUserMedia 可能挂在系统弹窗上）。 */
const ACQUIRE_TIMEOUT = 20000;

/** 把 Promise 包一层超时，避免用户不理会系统弹窗时按钮永远转圈。 */
function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 请求超时`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/** 走 Permissions API 查一次状态；不支持该 name 时返回 null。 */
async function queryViaApi(name) {
    if (!navigator.permissions?.query) return null;
    try {
        const status = await navigator.permissions.query({ name });
        return status?.state || null;
    } catch {
        // 未知权限名与「用户拒绝查询」都抛 TypeError，这里统一当作不支持
        return null;
    }
}

/** 通知权限：Permissions API 与 Notification.permission 双路，后者是权威。 */
async function probeNotifications() {
    if (typeof Notification === "undefined") return { state: "unsupported" };
    return { state: String(Notification.permission || "default") };
}

/**
 * 探测一项权限当前状态（不触发任何系统弹窗）。
 * @param {string} name 权限名（见 permissions.rows()）
 * @returns {Promise<{name:string,label:string,hint:string,state:string,supported:boolean,detail?:string}>} 状态行
 */
async function query(name) {
    const row = ROW_BY_NAME.get(name);
    if (!row) {
        // 不给 hint：本模块的权限行刻意没有 hint（见文件头），未知名也保持一致，
        // 否则返回形状会出现两套说法，面板的渲染分支也跟着分叉。
        return { name: String(name), label: String(name), state: "unsupported", supported: false };
    }
    if (row.name === "notifications") {
        const probed = await probeNotifications();
        return { ...row, state: probed.state, supported: probed.state !== "unsupported" };
    }
    if (row.name === "persistent-storage" && navigator.storage?.persisted) {
        const apiState = await queryViaApi(name);
        if (apiState) return { ...row, state: apiState, supported: true };
        try {
            const persisted = await navigator.storage.persisted();
            return { ...row, state: persisted ? "granted" : "prompt", supported: true };
        } catch {
            return { ...row, state: "unsupported", supported: false };
        }
    }
    const state = await queryViaApi(name);
    if (state) return { ...row, state, supported: true };
    // 媒体与剪贴板在没有 Permissions API 支持时无法「只查不弹」：报 unknown 而不是猜
    return { ...row, state: "unknown", supported: Boolean(navigator.permissions?.query) };
}

/** 真实的媒体授权：拿到流立刻停掉所有轨道。 */
async function acquireMedia(kind) {
    if (!navigator.mediaDevices?.getUserMedia) return { state: "unsupported", detail: "此上下文没有 getUserMedia" };
    const constraints = kind === "video" ? { video: true } : { audio: true };
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia(constraints), ACQUIRE_TIMEOUT, kind);
    const labels = stream.getTracks().map((track) => `${track.kind}:${track.label || "未命名"}`);
    stream.getTracks().forEach((track) => track.stop());
    return { state: "granted", detail: `已授权并立即释放（${labels.join("、") || "无轨道"}）` };
}

/** 真实定位授权。 */
async function acquireGeolocation() {
    if (!navigator.geolocation) return { state: "unsupported", detail: "此浏览器没有 Geolocation API" };
    const position = await withTimeout(
        new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: ACQUIRE_TIMEOUT, maximumAge: 60000 })),
        ACQUIRE_TIMEOUT + 1000,
        "定位",
    );
    const { latitude, longitude, accuracy } = position.coords;
    return { state: "granted", detail: `纬度 ${latitude.toFixed(4)}，经度 ${longitude.toFixed(4)}，精度约 ${Math.round(accuracy || 0)} 米` };
}

/** 剪贴板读取探针（需文档焦点，且用户此前给过授权）。 */
async function acquireClipboardRead() {
    if (!navigator.clipboard?.readText) return { state: "unsupported", detail: "此上下文没有剪贴板读取能力" };
    const text = await withTimeout(navigator.clipboard.readText(), 5000, "剪贴板读取");
    return { state: "granted", detail: `可读，当前内容 ${String(text || "").length} 字` };
}

/**
 * 剪贴板写入探针：先问 Permissions API（Chrome 免弹窗即可判定），
 * 问不到时才真写一次，并尽量把原内容写回去，别把用户复制的东西弄丢。
 */
async function acquireClipboardWrite() {
    const apiState = await queryViaApi("clipboard-write");
    if (apiState) return { state: apiState, detail: "由 Permissions API 判定，未改动剪贴板内容" };
    if (!navigator.clipboard?.writeText) return { state: "unsupported", detail: "此上下文没有剪贴板写入能力" };
    let keep = null;
    try { keep = await navigator.clipboard.readText(); } catch { keep = null; }
    await withTimeout(navigator.clipboard.writeText(keep === null ? " " : keep), 5000, "剪贴板写入");
    return { state: "granted", detail: keep === null ? "写入成功（原内容不可读，已写入占位空格）" : "写入成功，原内容已还原" };
}

/** 持久存储请求。 */
async function acquirePersistentStorage() {
    if (!navigator.storage?.persist) return { state: "unsupported", detail: "此浏览器没有 StorageManager.persist" };
    const ok = await navigator.storage.persist();
    return { state: ok ? "granted" : "denied", detail: ok ? "已请求持久存储配额" : "浏览器未授予持久存储（可能已被拒绝过）" };
}

/** name -> 真实获取动作。 */
const ACQUIRE = {
    "notifications": async () => {
        if (typeof Notification === "undefined") return { state: "unsupported", detail: "此上下文没有 Notification API" };
        const permission = await Notification.requestPermission();
        return { state: String(permission || "denied"), detail: `Notification.requestPermission() -> ${permission}` };
    },
    "geolocation": acquireGeolocation,
    "camera": () => acquireMedia("video"),
    "microphone": () => acquireMedia("audio"),
    "clipboard-read": acquireClipboardRead,
    "clipboard-write": acquireClipboardWrite,
    "persistent-storage": acquirePersistentStorage,
};

/**
 * 请求一项权限（会真的弹系统授权框）。
 * @param {string} name 权限名
 * @returns {Promise<object>} 结果行：{name, label, state, detail, ok, error?}
 */
async function request(name) {
    const row = ROW_BY_NAME.get(name);
    if (!row) {
        return { name: String(name), label: String(name), state: "unsupported", ok: false, error: "未知的权限名" };
    }
    const action = ACQUIRE[row.name];
    try {
        const result = await action();
        const ok = result.state === "granted";
        window.__log?.[ok ? "info" : "warn"]("kernel/permissions", `${row.label}：${result.state}`, { name, detail: result.detail });
        return { ...row, state: result.state, detail: result.detail || "", ok };
    } catch (err) {
        const state = err && err.name === "NotAllowedError" ? "denied" : "prompt";
        window.__log?.warn("kernel/permissions", `${row.label} 获取失败：${(err && err.message) || err}`, { name });
        return { ...row, state, ok: false, error: String((err && err.message) || err), detail: "用户取消或浏览器拒绝" };
    }
}

/**
 * 全部权限行的当前状态（面板一次取齐）。
 * @returns {Promise<Array<object>>} 状态行数组，顺序与 rows() 一致
 */
async function list() {
    const rows = await Promise.all(ROWS.map((row) => query(row.name).catch((err) => ({
        ...row, state: "unsupported", supported: false, detail: String((err && err.message) || err),
    }))));
    return rows;
}

/**
 * 存储用量与持久化状态。
 * @returns {Promise<{supported:boolean, usage:number, quota:number, percent:number, persisted:boolean}>} 估算结果
 */
async function storageEstimate() {
    const out = { supported: false, usage: 0, quota: 0, percent: 0, persisted: false };
    if (!navigator.storage?.estimate) return out;
    try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        out.supported = true;
        out.usage = usage;
        out.quota = quota;
        out.percent = quota > 0 ? Number(((usage / quota) * 100).toFixed(2)) : 0;
        if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted().catch(() => false);
        return out;
    } catch (err) {
        window.__log?.warn("kernel/permissions", "存储用量查询失败", err);
        return out;
    }
}

/**
 * 删除一个 IndexedDB 库（被占用时会 blocked，一律按失败记下）。
 * @param {string} name 库名
 * @returns {Promise<{name:string, deleted:boolean}>} 结果
 */
function deleteDatabase(name) {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve({ name, deleted: true });
            req.onerror = () => resolve({ name, deleted: false });
            req.onblocked = () => resolve({ name, deleted: false });
        } catch {
            resolve({ name, deleted: false });
        }
    });
}

/**
 * 清空 Deskly 自己的全部本地数据并重新加载页面。
 *
 * 不可逆：必须显式传 `{confirm:true}`，否则本函数什么都不做直接返回。
 * 清除范围 = 扩展页源下的所有 localStorage 键（设置槽、口令摘要与盐、日志留存、
 * 最近使用等全都在内）+ DATABASES 三个 IndexedDB 库。
 * @param {object} [opts] 选项
 * @param {boolean} [opts.confirm] 唯一的执行闸门
 * @param {boolean} [opts.reload] 清除后是否 reload（默认 true；测试时传 false）
 * @returns {Promise<{ok:boolean, removedKeys:number, keptKeys:string[], databases:Array, reason?:string}>} 结果
 */
async function resetAll(opts = {}) {
    const result = { ok: false, removedKeys: 0, keptKeys: [], databases: [], reason: undefined };
    if (opts.confirm !== true) {
        result.reason = "未确认：resetAll 需要显式传 {confirm:true}";
        window.__log?.warn("kernel/permissions", "重置本地数据被拒绝：缺少 confirm 参数");
        return result;
    }
    // 不可逆动作先留一条 error 级记录：reload 之后 info 可能被门槛挡掉，error 一定在
    window.__log?.error("kernel/permissions", "正在清空 Deskly 的全部本地数据（localStorage + IndexedDB）并重新加载页面", {
        databases: DATABASES,
        reload: opts.reload !== false,
    });
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key) keys.push(key);
        }
        keys.forEach((key) => {
            try {
                localStorage.removeItem(key);
                result.removedKeys += 1;
            } catch {
                result.keptKeys.push(key);
            }
        });
    } catch (err) {
        result.reason = `localStorage 不可访问：${String((err && err.message) || err)}`;
    }
    const deletes = await Promise.race([
        Promise.all(DATABASES.map((name) => deleteDatabase(name))),
        new Promise((resolve) => setTimeout(() => resolve(DATABASES.map((name) => ({ name, deleted: false }))), ACQUIRE_TIMEOUT)),
    ]);
    result.databases = deletes;
    result.ok = result.keptKeys.length === 0;
    if (opts.reload !== false) {
        setTimeout(() => {
            try { window.location.reload(); } catch { /* 单测环境没有 location */ }
        }, 60);
    }
    return result;
}

/** 权限模块对外 API（隐私面板走 ESM import，不经全局）。 */
const permissions = {
    list,
    query,
    request,
    storageEstimate,
    resetAll,
    /** 面板可用的权限行定义（name/label/hint）。 */
    rows: () => ROWS.map((row) => ({ ...row })),
    /** 会被 resetAll 删掉的 IndexedDB 库名。 */
    databases: () => [...DATABASES],
    /** 本浏览器是否支持 Permissions API。 */
    isSupported: () => Boolean(navigator.permissions?.query),
};

/**
 * 全局只暴露**只读**面（诊断菜单与调试用）。
 *
 * resetAll 是不可逆动作，而它的闸门 `{confirm:true}` 只是**函数参数**：同 realm 的任何
 * 脚本（含插件）都能一行调用它，清掉扩展页源下全部 localStorage 键 + 四个 IndexedDB
 * （用户的应用内文件、已装 ZIP 插件、照片、授权账本一起消失）。真正的确认在隐私面板的
 * __dialog.confirm 里，那一层与 owner 之间没有强制关系 —— 所以这里的闸门必须是
 * 「够不着」，不是「记得传参」。
 *
 * 隐私面板 import 的是上面的 `permissions`（panes/privacy.js:16），收窄全局不影响它。
 */
globalThis.__permissions = {
    list,
    query,
    request,
    storageEstimate,
    rows: () => ROWS.map((row) => ({ ...row })),
    databases: () => [...DATABASES],
    isSupported: () => Boolean(navigator.permissions?.query),
};

let initialized = false;

/**
 * 初始化权限模块：只做一次状态探测并留档，不弹任何授权框。
 * @returns {boolean} 是否完成初始化（重复调用幂等）
 */
function initPermissions() {
    if (initialized) return true;
    initialized = true;
    list().then((rows) => {
        const granted = rows.filter((row) => row.state === "granted").length;
        const unsupported = rows.filter((row) => row.state === "unsupported").length;
        window.__log?.info("kernel/permissions",
            `权限就绪：${rows.length} 项在册，${granted} 项已授权，${unsupported} 项本浏览器不支持`);
    }).catch((err) => {
        window.__log?.warn("kernel/permissions", "权限状态探测失败", err);
    });
    return true;
}

export { permissions, initPermissions, list, query, request, storageEstimate, resetAll };
