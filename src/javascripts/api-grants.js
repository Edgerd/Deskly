/**
 * api-grants.js — 插件 API 的授权账本与运行时激活
 *
 * 两层机制，缺一不可：
 * 1. 安装时（内置插件在注册表建好时、ZIP 在落库前）读 manifest.permissions 展示清单，
 *    用户确认后 grantAll 记一条 granted 账；
 * 2. 运行时第一次调用某条 API 时，敏感权限再弹一次「拒绝 / 仅此一次 / 始终允许」激活，
 *    选「始终允许」后落盘，之后无感通行。
 *
 * 命名注意：本文件**不是** permissions.js。`permissions.js` 是浏览器 Permissions API
 * （通知/定位/摄像头/剪贴板）的只读状态查询方，与本模块毫无关系；
 * os-api.md 里已经专门警告过别把 `window.__permissions` 当成 API 授权。
 *
 * 边界，必须先说明白：插件与内核跑在同一个 document 里（见 devdoc/architecture.md
 * 「运行模型」），插件可以绕过本模块直接 `import { OSFS } from "../osfs.js"`、
 * 直接读写 localStorage 与 IndexedDB。所以这套账本是**同意与记账机制**，
 * 不是安全沙箱；真正的硬边界只有 MV3 的 `script-src 'self'`。
 *
 * 模块顶层保持纯净（不碰 indexedDB、不碰 DOM、不注册监听）：
 * dev/static-check.mjs 要在 Node 里 import 本文件校验权限名表，
 * 与 app-registry.js 同一条契约。所有副作用都在 initGrants() 里发生。
 */

import { callerFromStack, currentCaller } from "./caller-context.js";

const DB_NAME = "webstartos-grants";
const DB_VERSION = 1;
const STORE = "grants";

/** 全量权限名，与 底层API改造分段提示词.md §二 一一对应，弹窗与帮助文档同源。 */
const PERMISSION_NAMES = [
    "apps:launch",
    "default-apps:read",
    "default-apps:write",
    "widgets",
    "dynamic-icons",
    "window-style:self",
    "window-style:others",
    "theme:apply",
    "files:read",
    "files:write",
    "system-patch:dock",
    "system-patch:finderbar",
    "system-patch:desktop",
    "system-patch:wallpaper",
    "system-patch:menu",
    "window:read-others",
    "window:manage-others",
    "window:chrome",
    "window:level",
    "quicklook:register",
    "menus:register",
    "shortcuts:write",
];

/**
 * 权限名 -> 人类可读名称与说明。弹窗正文、安装清单、帮助文档、日志四处共用这一张表。
 * 说明统一写成「要拿什么 + 拿去干什么」，不缩写成口号；内部代号一律不进中文文案。
 */
const PERMISSION_LABELS = {
    "apps:launch": ["启动应用", "打开本机其他插件提供的应用"],
    "default-apps:read": ["读取默认应用", "查询某个扩展名或协议目前由哪个应用打开"],
    "default-apps:write": ["修改默认应用", "把扩展名或协议改绑到其他应用，包括网页链接的接管"],
    "widgets": ["桌面小组件", "在桌面创建、更新或移除小组件，并接收与发送事件"],
    "dynamic-icons": ["动态图标", "替换应用图标，并让程序坞、启动台、应用商店与访达同步刷新"],
    "window-style:self": ["自身窗口样式", "修改自己窗口的标题栏颜色、圆角、毛玻璃与深浅色"],
    "window-style:others": ["跨应用窗口样式", "修改其他应用的窗口样式。确认一次后，本次会话内不再逐次询问"],
    "theme:apply": ["应用主题", "整套替换窗口与界面的配色"],
    "files:read": ["读取文件", "读取本应用数据目录中的文件"],
    "files:write": ["文件存储", "在本应用的数据目录中保存、修改或删除文件。写入其他位置时会再次询问"],
    "system-patch:dock": ["程序坞补丁", "在程序坞中插入或替换内容"],
    "system-patch:finderbar": ["顶栏补丁", "在顶部菜单栏中插入或替换内容"],
    "system-patch:desktop": ["桌面补丁", "在桌面层插入或替换内容"],
    "system-patch:wallpaper": ["墙纸补丁", "在墙纸层插入或替换内容"],
    "system-patch:menu": ["菜单补丁", "在顶栏菜单中插入或替换条目"],
    "window:read-others": ["读取其他窗口", "读取或订阅其他应用窗口的状态与事件"],
    "window:manage-others": ["管理其他窗口", "改动、关闭或置顶其他应用的窗口"],
    "window:chrome": ["隐藏窗口控件", "隐藏整组窗口控制按钮或关闭按钮"],
    "window:level": ["窗口层级", "把自己的窗口提升到浮动层或面板层"],
    "quicklook:register": ["注册快速查看预览", "为自己支持的文件格式提供快速查看预览"],
    "menus:register": ["注册文件右键菜单", "在桌面与访达的文件右键菜单中增加条目"],
    "shortcuts:write": ["管理桌面快捷方式", "在桌面创建或移除应用的快捷方式"],
};

/**
 * 敏感权限：运行时首次调用要真弹确认框。
 * 判据是「会不会影响别人」或「会不会丢数据」——跨应用样式、系统组件补丁、
 * 默认应用改写、文件存储。读文件、启动应用、小组件、动态图标、自身样式这些
 * 装了就该能用的，安装时一次性授权后静默激活，不再打扰。
 * 不这么做的话开机 14 个内置插件会各自弹一轮，用户只会一路点拒绝。
 */
const SENSITIVE = new Set([
    "default-apps:write",
    "window-style:others",
    "theme:apply",
    "files:write",
    "window:manage-others",
    "window:chrome",
]);

/** 带通配的敏感前缀：system-patch:* 全部敏感。 */
const SENSITIVE_PREFIXES = ["system-patch:"];

/** 账本内存镜像：pluginId -> { pluginId, grants: [{permission, granted, activated}] } */
const ledger = new Map();

/** 本次会话内「仅此一次」的选择：`${pluginId}|${permission}` -> true */
const sessionOnce = new Set();

let dbPromise = null;
let promptTail = Promise.resolve();

/* ── IndexedDB：形状照 osfs.js 的 openDb/tx，全仓唯一 version-change 安全的写法 ── */

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "pluginId" });
            }
        };
        req.onblocked = () => {
            // 与 osfs.js / sw.js 两处 openDb 的 onblocked 同一写法：被别的连接挡住时 open 既不
            // success 也不 error，不清缓存就会把这个永久 pending 的 Promise 一直用下去 ——
            // initGrants() 永不 resolve，bootstrap 的 await 卡死，整个桌面起不来。
            dbPromise = null;
            reject(new Error("账本升级被其它连接阻塞"));
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

function runTx(mode, op) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = op(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    }));
}

const putRow = (row) => runTx("readwrite", (os) => os.put(row));
const getAllRows = () => runTx("readonly", (os) => os.getAll());
const deleteRow = (pluginId) => runTx("readwrite", (os) => os.delete(pluginId));

function log(level, message, data) {
    const api = window.__log;
    if (api && typeof api[level] === "function") api[level]("api-grants", message, data);
}

/* ── 权限名判定 ── */

function isKnownPermission(permission) {
    return PERMISSION_NAMES.includes(permission);
}

/** 是否敏感（需要运行时确认）。 */
function isSensitive(permission) {
    if (SENSITIVE.has(permission)) return true;
    return SENSITIVE_PREFIXES.some((prefix) => String(permission).startsWith(prefix));
}

/**
 * 权限名匹配：账本里记的是具体名，调用方可能传 `system-patch:dock` 这种具体值，
 * 也可能有插件只声明了粗粒度意图。这里只做精确匹配，不做前缀放行 ——
 * 前缀放行等于声明 `files:read` 就能写文件，读写分离（设计决策 2）当场作废。
 */
function matches(granted, required) {
    return granted === required;
}

/** 权限中文名 + 描述，缺表时退回原始英文名，保证弹窗不会出现 undefined。 */
function describe(permission) {
    const entry = PERMISSION_LABELS[permission];
    return entry ? { label: entry[0], hint: entry[1] } : { label: permission, hint: "" };
}

/* ── 调用者识别 ── */

/**
 * 从调用栈里认出「是哪个插件在调」。实现在 caller-context.js，供 settings.js
 * 与本模块共用（订阅时也要认一次归属），避免两份正则各自漂移。
 *
 * @returns {string|null} 插件 id；null = 栈里没有插件帧
 */
function getCallerPluginId() {
    return callerFromStack();
}

/**
 * 取调用者 id。
 *
 * 顺序：**内核显式声明的归属** → 栈解析 → null。
 *
 * 早先的第三个来源是 `window.__currentPluginId`（plugin-manager 注入时写的提示）：
 * 只要 `ledger.has(hint)` 就采信。这条必须去掉 —— 那是个普通全局，插件自己就能写，
 * 写成一个有权限的插件 id 就完成了身份冒用；而 `ledger.has()` 只能证明「账本里有这个
 * 插件」，证明不了「这次调用是它发的」。参数保留是为了不破坏调用点签名，但不再使用。
 *
 * @returns {string|null} 插件 id；null = 认不出
 */
function resolveCaller() {
    const declared = currentCaller();
    if (declared) return declared;
    return getCallerPluginId();
}

/* ── 账本核心 ── */

function rowOf(pluginId) {
    let row = ledger.get(pluginId);
    if (!row) {
        row = { pluginId, grants: [] };
        ledger.set(pluginId, row);
    }
    return row;
}

function entryOf(pluginId, permission) {
    return rowOf(pluginId).grants.find((g) => matches(g.permission, permission));
}

/** 已授权（安装时确认过清单）。 */
function isGranted(pluginId, permission) {
    const e = entryOf(pluginId, permission);
    return Boolean(e && e.granted);
}

/** 已激活（可以直接调用）。同步读内存镜像，权限检查不引入异步等待。 */
function isActivated(pluginId, permission) {
    if (!isSensitive(permission)) {
        const e = entryOf(pluginId, permission);
        return Boolean(e && e.granted);
    }
    if (sessionOnce.has(`${pluginId}|${permission}`)) return true;
    const e = entryOf(pluginId, permission);
    return Boolean(e && e.granted && e.activated);
}

/**
 * 账本行签名：permission + granted + activated 的排序串，用于判断一次 grantAll
 * 到底有没有改动。启动期 13 个内置插件注册都会走 grantAll，绝大多数重复声明
 * 只是「把已经是 true 的字段再写一遍」，为它们各开一次 readwrite 事务纯属浪费。
 * 排序是必须的：grants 的追加顺序不稳定，不排序会把「集合相同」误判成变化。
 * @param {{grants: Array<object>}} row 账本行
 * @returns {string} 授权状态签名
 */
function signatureOf(row) {
    return row.grants
        .map((g) => `${g.permission}|${Boolean(g.granted)}|${Boolean(g.activated)}`)
        .sort()
        .join(",");
}

/**
 * 安装时全量授权：并集合并，**绝不撤销**已有条目。
 * ZIP 覆盖安装会用新的 manifest 再走一次这里，若改成覆盖，
 * 用户上次「始终允许」的记录会静默消失，下次调用又弹一遍。
 * 非敏感权限直接 activated=true（装时就完成激活），敏感权限留给运行时弹窗。
 * @param {string} pluginId 插件 id
 * @param {Array<string>} permissions manifest.permissions 声明的权限名
 * @returns {Promise<boolean>} 是否落盘成功（内存镜像总是先更新）
 */
async function grantAll(pluginId, permissions) {
    const names = Array.isArray(permissions) ? permissions : [];
    const row = rowOf(pluginId);
    // 改动前的签名：内存在循环里就地改，事后只有拿它才能判断是否真的变了。
    const before = signatureOf(row);
    for (const permission of names) {
        if (!isKnownPermission(permission)) {
            log("warn", `插件 ${pluginId} 声明了未知权限：${permission}`);
            continue;
        }
        const existing = entryOf(pluginId, permission);
        if (existing) {
            existing.granted = true;
            if (!isSensitive(permission)) existing.activated = true;
        } else {
            row.grants.push({
                permission,
                granted: true,
                activated: !isSensitive(permission),
                grantedAt: Date.now(),
            });
        }
    }
    // 没有任何权限位发生变化就不落盘：重复注册（同一插件被覆盖安装、内置插件
    // 清单没改）不该产生写事务。返回 true 与成功落盘一致——内存镜像已经是对的。
    if (signatureOf(row) === before) return true;
    try {
        await putRow({ ...row, grants: row.grants.map((g) => ({ ...g })) });
        return true;
    } catch (err) {
        log("error", `插件 ${pluginId} 授权写入失败，本次会话内仍生效：`, err);
        return false;
    }
}

/**
 * 激活一条权限。
 * @param {string} pluginId 插件 id
 * @param {string} permission 权限名
 * @param {("once"|"always")} mode once 只进会话，always 落盘
 */
async function activate(pluginId, permission, mode = "always") {
    if (mode === "once") {
        sessionOnce.add(`${pluginId}|${permission}`);
        return true;
    }
    // 只允许激活已授权（granted）的条目。ensurePermission 本来就先查过这一层，
    // 但 activate 是导出的，内核里任何一处误用都不该把「没声明的能力」写成已授权。
    if (!isGranted(pluginId, permission)) {
        log("warn", `拒绝激活未声明的能力：${pluginId} ${permission}`);
        return false;
    }
    const row = rowOf(pluginId);
    const existing = entryOf(pluginId, permission);
    if (existing) {
        existing.activated = true;
        existing.granted = true;
        existing.activatedAt = Date.now();
    } else {
        row.grants.push({
            permission, granted: true, activated: true,
            grantedAt: Date.now(), activatedAt: Date.now(),
        });
    }
    try {
        await putRow({ ...row, grants: row.grants.map((g) => ({ ...g })) });
    } catch (err) {
        log("error", `权限激活落盘失败（本次会话可用，刷新后要重弹）：${pluginId} ${permission}`, err);
    }
    return true;
}

/** 记一次拒绝：activated 归 false，下一次调用仍会询问（计划要求「拒绝」不封顶）。 */
async function deny(pluginId, permission) {
    const existing = entryOf(pluginId, permission);
    if (existing) existing.activated = false;
    log("info", `插件 ${pluginId} 拒绝使用「${describe(permission).label}」`);
    return false;
}

/**
 * 取一次权限：已激活直接放行，否则串行弹窗。
 *
 * 串行是必须的：ui/alert.js 的 pendingSettle 会强制结算上一个弹窗（同一时刻只允许
 * 一个系统对话框），两个插件同时申请时后一个会把前一个的 Promise 吞成 dismissValue。
 * @param {string|null} pluginId null = 内核自身调用，放行
 * @param {string} permission 权限名
 * @returns {Promise<boolean>}
 */
async function ensurePermission(pluginId, permission) {
    if (!pluginId) return true;
    if (isActivated(pluginId, permission)) return true;
    if (!isGranted(pluginId, permission)) {
        log("warn", `插件 ${pluginId} 调用了未在 manifest 声明的能力：${permission}`);
        return false;
    }
    if (!isSensitive(permission)) return activate(pluginId, permission, "always");

    const ask = async () => {
        const [{ dialog }, { getPlugin }, { getIcon }, { i18n }] = await Promise.all([
            import("./ui/dialog.js"),
            import("./app-registry.js"),
            import("./plugin-manager.js"),
            import("./i18n.js"),
        ]);
        const manifest = getPlugin(pluginId);
        const base = describe(permission);
        const label = i18n.t(`perms.${permission}.label`, base.label); // i18n-dynamic-ok：键按权限 id 收敛在 perms 表内
        const description = i18n.t(`perms.${permission}.hint`, base.hint); // i18n-dynamic-ok：同上
        // 只有内核能走到这里；dialog.permission 还会再校验一次调用栈，
        // 插件自己 import 那个函数会被按「拒绝」返回。
        const value = await dialog.permission({
            appId: pluginId,
            appName: manifest && manifest.name ? manifest.name : pluginId,
            permission,
            label,
            description,
            // 授权框顶部显示申请方应用图标；manifest 未声明时 getIcon 给目录 icon.png，
            // 再失败由 dialog 的 shadow <img> error 兜到 GENERIC_APP_ICON（不再裂图）。
            icon: getIcon(pluginId),
        });
        if (value === "always") return activate(pluginId, permission, "always");
        if (value === "once") return activate(pluginId, permission, "once");
        return deny(pluginId, permission);
    };
    const next = promptTail.then(ask, ask);
    // 队列尾巴只关心「别并发弹窗」，不让某一次的失败传染给后续申请
    promptTail = next.then(() => undefined, () => undefined);
    return next;
}

/** 卸载/删除插件时清账。 */
async function clearGrants(pluginId) {
    ledger.delete(pluginId);
    for (const key of Array.from(sessionOnce)) {
        if (key.startsWith(`${pluginId}|`)) sessionOnce.delete(key);
    }
    try {
        await deleteRow(pluginId);
    } catch (err) {
        log("error", `清除 ${pluginId} 授权记录失败：`, err);
    }
}

/** 诊断用：某插件的授权条目副本。 */
function listGrants(pluginId) {
    const row = ledger.get(pluginId);
    return row ? row.grants.map((g) => ({ ...g })) : [];
}

/** 诊断用：账本里的插件 id。 */
function grantIds() {
    return Array.from(ledger.keys());
}

/**
 * 安装时的权限清单面板（ZIP 安装流程调用）。
 * @param {object} manifest 待安装插件清单
 * @returns {Promise<boolean>} 用户是否确认「安装并授权」
 */
/**
 * 能力尚未开放的权限（与 os-api.js 的 UNIMPLEMENTED_PERMISSIONS 同源）：
 * 声明了也调不出东西（pending 占位），安装清单必须明说，否则用户为不存在的能力点「允许」（API-03）。
 * 常量写在本文件而不是 import：os-api 反向依赖本模块，顶层互拉会成环。
 */
const UNIMPLEMENTED_PERMISSIONS = new Set([
    "widgets", "dynamic-icons", "window-style:others", "theme:apply",
    "system-patch:dock", "system-patch:finderbar", "system-patch:desktop", "system-patch:wallpaper", "system-patch:menu",
]);

async function showPermissionChecklist(manifest) {
    const [{ dialog }, { i18n }] = await Promise.all([
        import("./ui/dialog.js"),
        import("./i18n.js"),
    ]);
    const names = Array.isArray(manifest.permissions) ? manifest.permissions.filter(isKnownPermission) : [];
    const rows = names.length
        ? names.map((p) => {
            const base = describe(p);
            const label = i18n.t(`perms.${p}.label`, base.label); // i18n-dynamic-ok：键按权限 id 收敛在 perms 表内
            const hint = i18n.t(`perms.${p}.hint`, base.hint); // i18n-dynamic-ok：同上
            const closed = UNIMPLEMENTED_PERMISSIONS.has(p)
                ? `<span class="ag-hint">${escapeHtml(i18n.t("dialog.permission.unavailable", "此能力尚未开放"))}</span>`
                : "";
            return `<li><b>${escapeHtml(label)}</b>${closed}<span class="ag-hint">${escapeHtml(hint)}</span></li>`;
        }).join("")
        : `<li>${escapeHtml(i18n.t("dialog.permission.none", "不需要任何额外能力"))}</li>`;
    const name = escapeHtml(manifest.name || manifest.id);
    const version = escapeHtml(String(manifest.version || "?"));
    const html = `<p>${name} ${escapeHtml(i18n.t("dialog.permission.version", "版本"))} ${version}</p>`
        + `<ul class="ag-list">${rows}</ul>`
        + `<p class="ag-note">${escapeHtml(i18n.t("dialog.permission.checklistNote", "其中需要单独确认的能力，会在第一次使用时询问。"))}</p>`;
    const value = await dialog.choose({
        title: i18n.t("dialog.permission.installTitle", "安装此插件"),
        message: html,
        html: true,
        buttons: [
            { label: i18n.t("common.cancel", "取消"), value: "cancel", style: "secondary" },
            { label: i18n.t("dialog.permission.install", "安装并授权"), value: "ok", style: "primary" },
        ],
        dismissValue: "cancel",
    });
    return value === "ok";
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

/**
 * 把 IndexedDB 读回的一行并进内存镜像。**并集**语义，不能直接 set 覆盖。
 *
 * 读账本是异步的，期间内置插件可能已经注册并走了 grantAll：那些条目只存在于
 * 内存里、还没来得及落盘。直接 `ledger.set(id, DB行)` 会把它们连同刚写进去的
 * granted 一起抹掉，下次敏感调用又会重弹。
 *
 * 合并规则：granted / activated 取逻辑或（DB 有或内存有都算有，绝不撤销）；
 * grantedAt / activatedAt 取较小值——时间戳越早越接近「用户第一次同意」，
 * 两个来源都缺时保留 undefined，不编造时间。
 * @param {object} row IndexedDB 里的账本行
 */
function mergeRowFromDb(row) {
    const grants = Array.isArray(row.grants) ? row.grants : [];
    const current = ledger.get(row.pluginId);
    if (!current) {
        ledger.set(row.pluginId, {
            pluginId: row.pluginId,
            grants: grants.map((g) => ({ ...g })),
        });
        return;
    }
    for (const dbEntry of grants) {
        if (!dbEntry || !dbEntry.permission) continue;
        const inMemory = current.grants.find((g) => matches(g.permission, dbEntry.permission));
        if (!inMemory) {
            current.grants.push({ ...dbEntry });
            continue;
        }
        inMemory.granted = Boolean(inMemory.granted || dbEntry.granted);
        inMemory.activated = Boolean(inMemory.activated || dbEntry.activated);
        if (dbEntry.grantedAt !== undefined) {
            inMemory.grantedAt = inMemory.grantedAt === undefined
                ? dbEntry.grantedAt
                : Math.min(inMemory.grantedAt, dbEntry.grantedAt);
        }
        if (dbEntry.activatedAt !== undefined) {
            inMemory.activatedAt = inMemory.activatedAt === undefined
                ? dbEntry.activatedAt
                : Math.min(inMemory.activatedAt, dbEntry.activatedAt);
        }
    }
}

/**
 * 启动时接上注册表生命周期钩子，并读回历史账本。
 *
 * 授权记账走 app-registry 的**直接钩子调用**（addLifecycleHook），不挂在 document 的
 * plugin-registered/unregistered 事件上 —— 那是开放总线，任何插件都能 dispatchEvent
 * 伪造：伪造 registered 可自我授予未声明的非敏感权限（非敏感权限 grantAll 时直接
 * activated，连弹窗都没有），伪造 unregistered 可清掉他人账本（BUG-17）。
 * 注册与注销最终都走 app-registry 的 registerPlugin / unregisterPlugin 这一个调用点
 * （内置插件经 plugin-manager，ZIP 插件经 store-api），钩子与它们天然同漏斗。
 *
 * 动态 import 保持本模块顶层纯净：dev/static-check.mjs 在 Node 里 import 本文件校验
 * 权限名表，不能在顶层把 app-registry（连同它的 settings/i18n 链）拉进来。
 * 挂载后按 getPlugins() 对账一遍：万一钩子上挂前已有注册（未来改动引入的时序差），
 * 靠 grantAll 的并集语义补记，重复调用无副作用。
 * @returns {Promise<boolean>} 账本是否成功读回（失败时内存为空表，不阻塞启动）
 */
async function initGrants() {
    const { addLifecycleHook, getPlugins } = await import("./app-registry.js");
    addLifecycleHook({
        onRegistered: (manifest) => {
            if (!manifest || !manifest.id) return;
            grantAll(manifest.id, Array.isArray(manifest.permissions) ? manifest.permissions : []);
        },
        onUnregistered: (id) => { if (id) clearGrants(id); },
    });
    for (const manifest of getPlugins()) {
        if (manifest && manifest.id) grantAll(manifest.id, Array.isArray(manifest.permissions) ? manifest.permissions : []);
    }

    try {
        const rows = await getAllRows();
        for (const row of Array.isArray(rows) ? rows : []) {
            if (!row || !row.pluginId) continue;
            mergeRowFromDb(row);
        }
    } catch (err) {
        log("error", "授权账本读取失败，本次会话所有敏感能力会重新询问：", err);
    }

    return true;
}

// 全局只放**只读**诊断面。grantAll / activate / ensurePermission / clearGrants 一旦全局可达，
// 任何插件都能 `__grants.grantAll(自己, ["files:write", "system-patch:dock"])` 自我提权，
// 或 `__grants.clearGrants(别人)` 把别人的授权打回弹窗 —— 账本作为「同意机制」就只剩自愿遵守。
// 写入口只保留 module 导出，由内核调用点显式 import（bootstrap / 商店安装链）。
globalThis.__grants = {
    PERMISSION_NAMES, PERMISSION_LABELS, SENSITIVE,
    isGranted, isActivated, isSensitive, isKnownPermission, describe,
    listGrants, grantIds, getCallerPluginId, resolveCaller,
};

export {
    PERMISSION_NAMES,
    PERMISSION_LABELS,
    SENSITIVE,
    initGrants,
    grantAll,
    activate,
    deny,
    ensurePermission,
    isGranted,
    isActivated,
    isSensitive,
    isKnownPermission,
    describe,
    listGrants,
    grantIds,
    clearGrants,
    showPermissionChecklist,
    getCallerPluginId,
    resolveCaller,
};
